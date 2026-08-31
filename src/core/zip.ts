/**
 * Minimal, dependency-free ZIP reader.
 *
 * The eCRV Weekly Sales Extract ships as a zipped folder of XML documents, so
 * the connector has to open one. Reading the central directory (rather than
 * scanning local headers) means entry order is the archive's own order, which
 * keeps parsing deterministic regardless of how the archive was produced.
 *
 * Supports the two methods real-world archives use: stored (0) and deflate (8).
 * CRC-32 is verified on every entry — a corrupt artifact must fail loudly rather
 * than yield half a record.
 */
import { inflateRawSync } from 'node:zlib';
import { fail } from './errors.ts';

export type ZipEntry = {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function readZip(input: Uint8Array): readonly ZipEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      fail('PARSE', `zip central directory entry ${i} is malformed`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const crc32 = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (name.includes('..') || name.startsWith('/')) fail('PARSE', `zip entry "${name}" has an unsafe path`);

    if (!name.endsWith('/')) {
      entries.push(readLocalEntry(buf, localOffset, { name, method, crc32, compressedSize, uncompressedSize }));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

type CentralInfo = {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
};

function readLocalEntry(buf: Buffer, localOffset: number, info: CentralInfo): ZipEntry {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    fail('PARSE', `zip entry "${info.name}" has a malformed local header`);
  }
  const nameLength = buf.readUInt16LE(localOffset + 26);
  const extraLength = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = buf.subarray(start, start + info.compressedSize);

  let bytes: Buffer;
  if (info.method === 0) bytes = Buffer.from(compressed);
  else if (info.method === 8) {
    try {
      bytes = inflateRawSync(compressed);
    } catch (e) {
      return fail('PARSE', `zip entry "${info.name}" could not be inflated: ${(e as Error).message}`);
    }
  } else {
    return fail('PARSE', `zip entry "${info.name}" uses unsupported compression method ${info.method}`);
  }

  if (bytes.length !== info.uncompressedSize) {
    fail('PARSE', `zip entry "${info.name}" length mismatch: header says ${info.uncompressedSize}, got ${bytes.length}`);
  }
  const actualCrc = crc32(bytes);
  if (actualCrc !== info.crc32) {
    fail('PARSE', `zip entry "${info.name}" failed CRC-32 verification`, {
      expected: info.crc32.toString(16),
      actual: actualCrc.toString(16),
    });
  }
  return {
    name: info.name,
    bytes,
    crc32: info.crc32,
    compressedSize: info.compressedSize,
    uncompressedSize: info.uncompressedSize,
  };
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The EOCD record sits at the end, after a comment of up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return fail('PARSE', 'not a zip archive: no end-of-central-directory record');
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
