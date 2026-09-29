/**
 * Streaming dBase III reader — the attribute table of an ESRI shapefile.
 *
 * Florida's statewide parcel shapefiles carry the joined tax-roll attributes in
 * a `.dbf` of about 2 KB per record: 10.8 million records is over 20 GB
 * uncompressed, so the table is read as a stream straight out of the archive,
 * one fixed-width record at a time, and never written to disk.
 *
 * Deliberately literal. A value is the field's bytes, decoded and trimmed; an
 * empty field is `null`. Numbers stay text — `"350000.00000"` — because turning
 * them into floats here would be a normalisation decision taken in the wrong
 * place (money goes through the contract, exactly). Deleted records are
 * yielded flagged, never silently dropped, so a caller counts them.
 *
 * The header's record count is checked against the records actually present:
 * a truncated table fails rather than yielding a short estate.
 */
import { fail } from './errors.ts';

export type DbfField = {
  readonly name: string;
  /** dBase type letter: C character, N numeric, F float, D date, L logical. */
  readonly type: string;
  readonly length: number;
  readonly decimals: number;
  /** Byte offset inside a record, after the deletion flag. */
  readonly offset: number;
};

export type DbfHeader = {
  readonly version: number;
  /** YYYY-MM-DD from the header's last-update bytes, as written. */
  readonly lastUpdate: string;
  readonly recordCount: number;
  readonly headerLength: number;
  readonly recordLength: number;
  readonly languageDriver: number;
  readonly fields: readonly DbfField[];
};

export type DbfRecord = {
  /** 0-based position in the table. */
  readonly index: number;
  readonly deleted: boolean;
  /** One entry per field: trimmed text, or null when the field is blank. */
  readonly values: readonly (string | null)[];
};

export type DbfReader = {
  readonly header: DbfHeader;
  records(): AsyncGenerator<DbfRecord>;
  /** Character fields whose bytes were not valid in the declared encoding. */
  decodeReplacements(): number;
  /** Releases the underlying stream when the caller stops early — after the header, say. */
  close(): Promise<void>;
};

/** Pulls exact byte counts out of an async chunk stream. One pending chunk of memory. */
export class ByteCursor {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private offset = 0;
  private done = false;
  /** Bytes consumed so far. */
  position = 0;

  constructor(chunks: AsyncIterable<Buffer>) {
    this.iterator = chunks[Symbol.asyncIterator]();
  }

  /** Stops reading and lets the source release what it holds (a file handle, an inflater). */
  async close(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.iterator.return?.(undefined);
  }

  /** Exactly `n` bytes, or null at a clean end of stream. A partial read fails. */
  async read(n: number): Promise<Buffer | null> {
    if (this.buffer.length - this.offset >= n) {
      const out = this.buffer.subarray(this.offset, this.offset + n);
      this.offset += n;
      this.position += n;
      return out;
    }
    const parts: Buffer[] = [this.buffer.subarray(this.offset)];
    let have = this.buffer.length - this.offset;
    while (have < n) {
      if (this.done) break;
      const next = await this.iterator.next();
      if (next.done) { this.done = true; break; }
      parts.push(next.value);
      have += next.value.length;
    }
    const joined = Buffer.concat(parts);
    if (joined.length < n) {
      this.buffer = joined;
      this.offset = 0;
      if (joined.length === 0) return null;
      fail('PARSE', `stream ended ${n - joined.length} byte(s) short of a ${n}-byte read at offset ${this.position}`);
    }
    this.buffer = joined;
    this.offset = n;
    this.position += n;
    return joined.subarray(0, n);
  }

  /** Whatever remains, up to `max` bytes. Used for trailers. */
  async rest(max: number): Promise<Buffer> {
    const parts: Buffer[] = [this.buffer.subarray(this.offset)];
    let have = parts[0]!.length;
    while (have < max && !this.done) {
      const next = await this.iterator.next();
      if (next.done) { this.done = true; break; }
      parts.push(next.value);
      have += next.value.length;
    }
    const joined = Buffer.concat(parts);
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    return joined.subarray(0, Math.min(max, joined.length));
  }

  /** Drains and returns how many bytes were left unread. */
  async drain(): Promise<number> {
    let left = this.buffer.length - this.offset;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) { this.done = true; break; }
      left += next.value.length;
    }
    return left;
  }
}

export async function openDbf(
  chunks: AsyncIterable<Buffer>,
  options: { readonly encoding?: 'utf8' | 'latin1' } = {},
): Promise<DbfReader> {
  const encoding = options.encoding ?? 'utf8';
  const cursor = new ByteCursor(chunks);
  const fixed = await cursor.read(32);
  if (fixed === null) fail('PARSE', 'dbf table is empty');
  const version = fixed.readUInt8(0);
  const lastUpdate = `${1900 + fixed.readUInt8(1)}-${String(fixed.readUInt8(2)).padStart(2, '0')}-${String(fixed.readUInt8(3)).padStart(2, '0')}`;
  const recordCount = fixed.readUInt32LE(4);
  const headerLength = fixed.readUInt16LE(8);
  const recordLength = fixed.readUInt16LE(10);
  const languageDriver = fixed.readUInt8(29);
  if (headerLength < 33 || recordLength < 1) fail('PARSE', `dbf header is malformed (header ${headerLength}, record ${recordLength})`);

  const rest = await cursor.read(headerLength - 32);
  if (rest === null) fail('PARSE', 'dbf header is truncated');
  const fields: DbfField[] = [];
  let offset = 0;
  for (let p = 0; p + 32 <= rest.length && rest.readUInt8(p) !== 0x0d; p += 32) {
    const nameEnd = rest.indexOf(0, p);
    const name = rest.toString('latin1', p, nameEnd === -1 || nameEnd > p + 11 ? p + 11 : nameEnd).trim();
    const type = String.fromCharCode(rest.readUInt8(p + 11));
    const length = rest.readUInt8(p + 16);
    const decimals = rest.readUInt8(p + 17);
    fields.push({ name, type, length, decimals, offset });
    offset += length;
  }
  if (fields.length === 0) fail('PARSE', 'dbf header declares no fields');
  if (offset + 1 !== recordLength) {
    fail('PARSE', `dbf field widths sum to ${offset + 1} bytes but records are ${recordLength}`);
  }

  let replacements = 0;
  const header: DbfHeader = { version, lastUpdate, recordCount, headerLength, recordLength, languageDriver, fields };

  async function* records(): AsyncGenerator<DbfRecord> {
    for (let index = 0; index < recordCount; index++) {
      const raw = await cursor.read(recordLength);
      if (raw === null) fail('PARSE', `dbf declares ${recordCount} records but ends after ${index}`);
      const flag = raw.readUInt8(0);
      if (flag !== 0x20 && flag !== 0x2a) fail('PARSE', `dbf record ${index} has deletion flag 0x${flag.toString(16)}`);
      const values: (string | null)[] = new Array(fields.length);
      for (let f = 0; f < fields.length; f++) {
        const field = fields[f] as DbfField;
        const start = 1 + field.offset;
        const text = raw.toString(field.type === 'C' ? encoding : 'latin1', start, start + field.length).trim();
        if (field.type === 'C' && text.includes('�')) replacements += 1;
        values[f] = text === '' ? null : text;
      }
      yield { index, deleted: flag === 0x2a, values };
    }
    // An end-of-file marker (0x1A) may follow; anything beyond it is not data.
    const tail = await cursor.rest(2);
    if (tail.length > 0 && tail.readUInt8(0) !== 0x1a) {
      fail('PARSE', `dbf has ${tail.length}+ byte(s) after its ${recordCount} declared records`);
    }
    await cursor.drain();
  }

  return { header, records, decodeReplacements: () => replacements, close: () => cursor.close() };
}
