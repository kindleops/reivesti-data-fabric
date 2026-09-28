/**
 * Random-access ZIP reader for archives too large to hold in memory.
 *
 * `zip.ts` reads a whole archive into a Buffer, which is right for a weekly eCRV
 * extract and wrong for a 760 MB statewide parcel archive whose largest entry
 * inflates to 1.6 GB. This module reads the central directory with positioned
 * reads and inflates one entry at a time as a stream, so memory is a read
 * buffer and an inflate window regardless of archive size.
 *
 * Same guarantees as `zip.ts`: entry order is the central directory's own order,
 * unsafe paths are refused, and every extracted entry is verified against its
 * CRC-32 and declared length. A corrupt artifact fails loudly rather than
 * yielding half a table. ZIP64 is supported because archives of this size are
 * exactly where it starts to appear.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createInflateRaw, crc32 as nativeCrc32 } from 'node:zlib';
import { fail } from './errors.ts';

export type ZipFileEntry = {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly isDirectory: boolean;
};

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Lists entries by reading only the tail of the file and the central directory. */
export async function listZipFile(path: string): Promise<readonly ZipFileEntry[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xffff + 20);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) fail('PARSE', `${path} is not a zip archive: no end-of-central-directory record`);

    let entryCount = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);

    // ZIP64: the classic record saturates and a locator sits immediately before it.
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR_SIGNATURE) {
        fail('PARSE', `${path}: saturated end-of-central-directory with no ZIP64 locator`);
      }
      const record64Offset = Number(tail.readBigUInt64LE(locator + 8));
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, record64Offset);
      if (record.readUInt32LE(0) !== EOCD64_SIGNATURE) fail('PARSE', `${path}: malformed ZIP64 end record`);
      entryCount = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries: ZipFileEntry[] = [];
    let offset = 0;
    for (let i = 0; i < entryCount; i++) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        fail('PARSE', `${path}: central directory entry ${i} is malformed`);
      }
      const method = directory.readUInt16LE(offset + 10);
      const crc = directory.readUInt32LE(offset + 16);
      let compressedSize = directory.readUInt32LE(offset + 20);
      let uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      let localHeaderOffset = directory.readUInt32LE(offset + 42);
      const name = directory.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (name.includes('..') || name.startsWith('/')) fail('PARSE', `zip entry "${name}" has an unsafe path`);

      // ZIP64 extended information: present fields appear in a fixed order,
      // and only for the values the classic header saturated.
      const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const length = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = Number(extra.readBigUInt64LE(p)); p += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(extra.readBigUInt64LE(p)); p += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(extra.readBigUInt64LE(p)); }
        }
        e += 4 + length;
      }

      entries.push({
        name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset,
        isDirectory: name.endsWith('/'),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Inflates one entry to a file, verifying CRC-32 and length as bytes pass.
 *
 * The destination is written in full before verification completes, so a
 * caller must treat it as unverified until this resolves — which is why it is
 * always a scratch path, never the archive.
 */
export async function extractZipEntry(zipPath: string, entry: ZipFileEntry, destination: string): Promise<void> {
  if (entry.isDirectory) fail('CONFIG', `zip entry "${entry.name}" is a directory`);
  if (entry.method !== 0 && entry.method !== 8) {
    fail('PARSE', `zip entry "${entry.name}" uses unsupported compression method ${entry.method}`);
  }

  const handle = await open(zipPath, 'r');
  let dataStart: number;
  try {
    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) fail('PARSE', `zip entry "${entry.name}" has a malformed local header`);
    dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await handle.close();
  }

  let crc = 0;
  let length = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _enc, done) {
      crc = nativeCrc32(chunk, crc);
      length += chunk.length;
      done(null, chunk);
    },
  });

  const source = entry.compressedSize === 0
    ? createReadStream(zipPath, { start: dataStart, end: dataStart - 1 })
    : createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1, highWaterMark: 1 << 20 });
  const stages: NodeJS.ReadWriteStream[] = entry.method === 8 ? [createInflateRaw(), verifier] : [verifier];
  await pipeline(source, ...stages, createWriteStream(destination, { mode: 0o600 }));

  if (length !== entry.uncompressedSize) {
    fail('PARSE', `zip entry "${entry.name}" length mismatch: header says ${entry.uncompressedSize}, got ${length}`);
  }
  if ((crc >>> 0) !== entry.crc32) {
    fail('PARSE', `zip entry "${entry.name}" failed CRC-32 verification`, {
      expected: entry.crc32.toString(16), actual: (crc >>> 0).toString(16),
    });
  }
}
