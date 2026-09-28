/**
 * Dependency-free, streaming reader for Esri File Geodatabase tables.
 *
 * ## Why this exists
 *
 * Wisconsin publishes its statewide parcel map as a zipped File Geodatabase —
 * the format the State Cartographer's Office has shipped every annual release in
 * since 2015, and the one most US state and county GIS offices use for bulk
 * distribution. The Fabric has no GDAL and adds no native dependency to read a
 * file format, for the same reason `zip.ts` and `xml.ts` exist: an ingestion
 * runtime whose parsing depends on a system library is a runtime whose replay
 * depends on which version of that library a machine happens to have.
 *
 * The on-disk format is not published by Esri. It has been independently and
 * thoroughly documented by the GDAL OpenFileGDB driver's author
 * (https://github.com/rouault/dump_gdbtable/wiki/FGDB-Spec), and this reader
 * implements the subset of that description an attribute table needs.
 *
 * ## What it reads, and what it deliberately does not
 *
 * - The system catalogue, to find a table by name.
 * - A table's field descriptors, from its `.gdbtable` header.
 * - Rows, located through the `.gdbtablx` offset index so every row carries the
 *   OBJECTID the publisher assigned it (OBJECTID is implicit in the index
 *   position — it is not stored in the row).
 * - Every attribute type a published table plausibly carries.
 *
 * **Geometry is not decoded.** The blob is located and skipped, and its length
 * reported, so a caller can say how many rows carry a shape. Parcel polygons are
 * retained in the publisher's archive, which is immutable evidence; decoding them
 * is a separate decision with its own consumer, not a side effect of reading
 * attributes. Compressed (CDF) geodatabases and raster fields are refused loudly.
 *
 * ## Memory
 *
 * One row at a time. The offset index is read in 1,024-row blocks and rows are
 * served from a bounded read-ahead window, so neither the index nor the table is
 * ever resident. Offsets in an exported geodatabase are monotonic, which makes
 * the window effectively a sequential scan; out-of-order offsets still work, they
 * just refill the window.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './errors.ts';

export type GdbFieldType =
  | 'int16' | 'int32' | 'float32' | 'float64' | 'string' | 'datetime' | 'objectid'
  | 'geometry' | 'binary' | 'raster' | 'guid' | 'globalid' | 'xml'
  | 'int64' | 'date' | 'time' | 'datetime_offset';

const TYPE_BY_CODE: readonly GdbFieldType[] = [
  'int16', 'int32', 'float32', 'float64', 'string', 'datetime', 'objectid',
  'geometry', 'binary', 'raster', 'guid', 'globalid', 'xml',
  'int64', 'date', 'time', 'datetime_offset',
];

/**
 * The ArcGIS REST name for each type, so a geodatabase schema and a
 * FeatureServer schema can be compared field for field.
 */
export const ESRI_REST_TYPE: Readonly<Record<GdbFieldType, string>> = {
  int16: 'esriFieldTypeSmallInteger', int32: 'esriFieldTypeInteger', float32: 'esriFieldTypeSingle',
  float64: 'esriFieldTypeDouble', string: 'esriFieldTypeString', datetime: 'esriFieldTypeDate',
  objectid: 'esriFieldTypeOID', geometry: 'esriFieldTypeGeometry', binary: 'esriFieldTypeBlob',
  raster: 'esriFieldTypeRaster', guid: 'esriFieldTypeGUID', globalid: 'esriFieldTypeGlobalID',
  xml: 'esriFieldTypeXML', int64: 'esriFieldTypeBigInteger', date: 'esriFieldTypeDateOnly',
  time: 'esriFieldTypeTimeOnly', datetime_offset: 'esriFieldTypeTimestampOffset',
};

export type GdbField = {
  readonly name: string;
  readonly alias: string;
  readonly type: GdbFieldType;
  readonly nullable: boolean;
  /** Declared maximum length, strings only. */
  readonly length: number | null;
};

export type GdbGeometryInfo = {
  readonly geometryType: 'none' | 'point' | 'multipoint' | 'polyline' | 'polygon' | 'multipatch' | 'unknown';
  /** The spatial reference as the table declares it (Esri WKT). */
  readonly spatialReferenceWkt: string | null;
  readonly hasZ: boolean;
  readonly hasM: boolean;
};

export type GdbTableInfo = {
  readonly name: string;
  readonly fileStem: string;
  /** Live rows according to the table header. */
  readonly validRowCount: number;
  /** Slots in the offset index, deleted rows included. */
  readonly indexedRowCount: number;
  readonly fields: readonly GdbField[];
  readonly geometry: GdbGeometryInfo;
  readonly formatVersion: number;
};

export type GdbRow = {
  readonly objectId: number;
  /** Attribute values by field name. Nulls are omitted, not stored. */
  readonly attributes: Record<string, unknown>;
  /** Byte length of the geometry blob, or null when the row has none. */
  readonly geometryBytes: number | null;
};

const GEOMETRY_TYPES: Readonly<Record<number, GdbGeometryInfo['geometryType']>> = {
  0: 'none', 1: 'point', 2: 'multipoint', 3: 'polyline', 4: 'polygon', 9: 'multipatch',
};

/** File stem for the n-th catalogue entry: a%08x, lower-case hex. */
export function gdbFileStem(tableNumber: number): string {
  return `a${tableNumber.toString(16).padStart(8, '0')}`;
}

/** Names of every table in the geodatabase, keyed by their file stem. */
export async function readGdbCatalog(gdbDir: string): Promise<ReadonlyMap<string, string>> {
  const table = await openGdbTable(gdbDir, gdbFileStem(1), 'GDB_SystemCatalog');
  const out = new Map<string, string>();
  try {
    for await (const row of table.rows()) {
      const name = row.attributes['Name'];
      if (typeof name === 'string') out.set(name, gdbFileStem(row.objectId));
    }
  } finally {
    await table.close();
  }
  return out;
}

export type GdbTableReader = {
  readonly info: GdbTableInfo;
  rows(): AsyncGenerator<GdbRow>;
  close(): Promise<void>;
};

/** Opens a table by catalogue name. */
export async function openGdbTableByName(gdbDir: string, name: string): Promise<GdbTableReader> {
  const catalog = await readGdbCatalog(gdbDir);
  const stem = catalog.get(name);
  if (stem === undefined) {
    fail('PARSE', `geodatabase has no table named "${name}"`, { tables: [...catalog.keys()].slice(0, 50) });
  }
  return openGdbTable(gdbDir, stem, name);
}

export async function openGdbTable(gdbDir: string, fileStem: string, name: string): Promise<GdbTableReader> {
  const tablePath = join(gdbDir, `${fileStem}.gdbtable`);
  const indexPath = join(gdbDir, `${fileStem}.gdbtablx`);
  const table = await open(tablePath, 'r');
  let indexHandle: FileHandle | null = null;
  try {
    indexHandle = await open(indexPath, 'r');
    const header = Buffer.alloc(40);
    await table.read(header, 0, 40, 0);
    const validRowCount = header.readInt32LE(4);
    const fieldsOffset = Number(header.readBigUInt64LE(32));

    const sectionLength = Buffer.alloc(4);
    await table.read(sectionLength, 0, 4, fieldsOffset);
    const section = Buffer.alloc(sectionLength.readUInt32LE(0) + 4);
    await table.read(section, 0, section.length, fieldsOffset);
    const parsed = parseFieldSection(section, name);

    const indexHeader = Buffer.alloc(16);
    await indexHandle.read(indexHeader, 0, 16, 0);
    const blocks = indexHeader.readUInt32LE(4);
    const indexedRowCount = indexHeader.readUInt32LE(8);
    const offsetSize = indexHeader.readUInt32LE(12);
    if (offsetSize < 4 || offsetSize > 6) fail('PARSE', `${name}: unsupported offset width ${offsetSize}`);

    // A sparse index carries a block bitmap after the offsets. Exported
    // statewide releases are dense; a sparse one is refused rather than misread.
    const indexStat = await indexHandle.stat();
    const trailerAt = 16 + blocks * 1024 * offsetSize;
    if (indexStat.size >= trailerAt + 4) {
      const trailer = Buffer.alloc(4);
      await indexHandle.read(trailer, 0, 4, trailerAt);
      if (trailer.readUInt32LE(0) !== 0) {
        fail('PARSE', `${name}: sparse .gdbtablx block map is not supported`, { remedy: 'compact the geodatabase' });
      }
    }

    const info: GdbTableInfo = {
      name, fileStem, validRowCount, indexedRowCount,
      fields: parsed.fields, geometry: parsed.geometry, formatVersion: parsed.version,
    };
    const index = indexHandle;
    return {
      info,
      rows: () => iterateRows(table, index, info, parsed.nullableCount, offsetSize),
      async close() {
        await table.close();
        await index.close();
      },
    };
  } catch (e) {
    await table.close();
    if (indexHandle) await indexHandle.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Field descriptors
// ---------------------------------------------------------------------------

type FieldSection = {
  readonly version: number;
  readonly fields: readonly GdbField[];
  readonly geometry: GdbGeometryInfo;
  readonly nullableCount: number;
};

function parseFieldSection(buf: Buffer, table: string): FieldSection {
  const version = buf.readUInt32LE(4);
  if (version !== 3 && version !== 4 && version !== 6) {
    fail('PARSE', `${table}: unsupported geodatabase table version ${version}`);
  }
  const geometryCode = buf.readUInt8(8);
  const fieldCount = buf.readUInt16LE(12);
  let p = 14;
  const fields: GdbField[] = [];
  let srs: string | null = null;
  let hasZ = false;
  let hasM = false;
  let nullableCount = 0;

  const utf16 = (chars: number): string => {
    const s = buf.subarray(p, p + chars * 2).toString('utf16le');
    p += chars * 2;
    return s;
  };

  for (let i = 0; i < fieldCount; i++) {
    const name = utf16(buf.readUInt8(p++));
    const alias = utf16(buf.readUInt8(p++));
    const code = buf.readUInt8(p++);
    const type = TYPE_BY_CODE[code];
    if (type === undefined) fail('PARSE', `${table}.${name}: unknown field type code ${code}`);

    let nullable = true;
    let length: number | null = null;
    switch (type) {
      case 'string': {
        length = buf.readInt32LE(p);
        nullable = (buf.readUInt8(p + 4) & 1) !== 0;
        p += 5;
        const defaultLength = readVarUint(buf, p);
        p = defaultLength.next + defaultLength.value;
        break;
      }
      case 'objectid':
        nullable = false;
        p += 2;
        break;
      case 'geometry': {
        nullable = (buf.readUInt8(p + 1) & 1) !== 0;
        p += 2;
        const wktBytes = buf.readUInt16LE(p);
        p += 2;
        srs = buf.subarray(p, p + wktBytes).toString('utf16le');
        p += wktBytes;
        const flags = buf.readUInt8(p++);
        hasM = (flags & 2) !== 0;
        hasZ = (flags & 4) !== 0;
        // origin/scale for XY, then M and Z when present, then tolerances.
        p += 8 * 3;
        if (hasM) p += 8 * 2;
        if (hasZ) p += 8 * 2;
        p += 8;
        if (hasM) p += 8;
        if (hasZ) p += 8;
        p += 8 * 4; // xmin ymin xmax ymax
        // Optional z/m extents, then the spatial-grid sizes. The documented way
        // to find the grid block is its shape: 00, then a little-endian count of
        // one to three. Anything else is another optional double.
        for (;;) {
          if (p + 5 > buf.length) fail('PARSE', `${table}.${name}: geometry descriptor overruns its section`);
          const count = buf.readUInt8(p + 1);
          if (buf[p] === 0 && count >= 1 && count <= 3 && buf[p + 2] === 0 && buf[p + 3] === 0 && buf[p + 4] === 0) {
            p += 5 + 8 * count;
            break;
          }
          p += 8;
        }
        break;
      }
      case 'raster':
        return fail('PARSE', `${table}.${name}: raster fields are not supported`);
      case 'binary': case 'guid': case 'globalid': case 'xml':
        nullable = (buf.readUInt8(p + 1) & 1) !== 0;
        p += 2;
        break;
      default: {
        // Fixed-width numeric and temporal types: width, flags, default.
        nullable = (buf.readUInt8(p + 1) & 1) !== 0;
        const defaultLength = buf.readUInt8(p + 2);
        p += 3 + defaultLength;
        break;
      }
    }
    if (nullable && type !== 'objectid') nullableCount += 1;
    fields.push({ name, alias, type, nullable, length });
  }

  return {
    version,
    fields,
    geometry: { geometryType: GEOMETRY_TYPES[geometryCode] ?? 'unknown', spatialReferenceWkt: srs, hasZ, hasM },
    nullableCount,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Read-ahead window size. Bounded: the reader never holds more than this plus one row. */
const WINDOW_BYTES = 4 << 20;

async function* iterateRows(
  table: FileHandle,
  index: FileHandle,
  info: GdbTableInfo,
  nullableCount: number,
  offsetSize: number,
): AsyncGenerator<GdbRow> {
  const nullBytes = Math.ceil(nullableCount / 8);
  let window = Buffer.alloc(0);
  let windowStart = 0;

  const readAt = async (offset: number, length: number): Promise<Buffer> => {
    if (offset >= windowStart && offset + length <= windowStart + window.length) {
      return window.subarray(offset - windowStart, offset - windowStart + length);
    }
    const size = Math.max(WINDOW_BYTES, length);
    const fresh = Buffer.alloc(size);
    const { bytesRead } = await table.read(fresh, 0, size, offset);
    window = fresh.subarray(0, bytesRead);
    windowStart = offset;
    if (bytesRead < length) fail('PARSE', `${info.name}: row at ${offset} runs past the end of the table`);
    return window.subarray(0, length);
  };

  const blockBytes = 1024 * offsetSize;
  const block = Buffer.alloc(blockBytes);
  for (let first = 0; first < info.indexedRowCount; first += 1024) {
    await index.read(block, 0, blockBytes, 16 + first * offsetSize);
    const last = Math.min(info.indexedRowCount, first + 1024);
    for (let slot = first; slot < last; slot++) {
      const at = (slot - first) * offsetSize;
      const offset = block.readUIntLE(at, offsetSize);
      if (offset === 0) continue; // deleted or never-written row
      const sizeBuf = await readAt(offset, 4);
      const rowSize = sizeBuf.readInt32LE(0);
      if (rowSize < 0) continue; // a freed row still referenced by a stale slot
      const blob = await readAt(offset + 4, rowSize);
      yield decodeRow(blob, slot + 1, info, nullBytes);
    }
  }
}

function decodeRow(blob: Buffer, objectId: number, info: GdbTableInfo, nullBytes: number): GdbRow {
  const attributes: Record<string, unknown> = {};
  let geometryBytes: number | null = null;
  let p = nullBytes;
  let nullableIndex = 0;

  for (const field of info.fields) {
    if (field.type === 'objectid') {
      attributes[field.name] = objectId;
      continue;
    }
    if (field.nullable) {
      const isNull = (blob[nullableIndex >> 3]! & (1 << (nullableIndex & 7))) !== 0;
      nullableIndex += 1;
      if (isNull) continue;
    }
    switch (field.type) {
      case 'int16': attributes[field.name] = blob.readInt16LE(p); p += 2; break;
      case 'int32': attributes[field.name] = blob.readInt32LE(p); p += 4; break;
      case 'float32': attributes[field.name] = blob.readFloatLE(p); p += 4; break;
      case 'float64': attributes[field.name] = blob.readDoubleLE(p); p += 8; break;
      case 'int64': attributes[field.name] = Number(blob.readBigInt64LE(p)); p += 8; break;
      case 'datetime': case 'date':
        attributes[field.name] = oleDaysToIso(blob.readDoubleLE(p)); p += 8; break;
      case 'time': attributes[field.name] = blob.readDoubleLE(p); p += 8; break;
      case 'datetime_offset':
        attributes[field.name] = oleDaysToIso(blob.readDoubleLE(p)); p += 10; break;
      case 'string': case 'xml': {
        const len = readVarUint(blob, p);
        attributes[field.name] = blob.subarray(len.next, len.next + len.value).toString('utf8');
        p = len.next + len.value;
        break;
      }
      case 'geometry': {
        const len = readVarUint(blob, p);
        geometryBytes = len.value;
        p = len.next + len.value;
        break;
      }
      case 'binary': {
        const len = readVarUint(blob, p);
        p = len.next + len.value;
        break;
      }
      case 'guid': case 'globalid':
        attributes[field.name] = guidOf(blob.subarray(p, p + 16)); p += 16; break;
      default:
        fail('PARSE', `${info.name}.${field.name}: cannot decode ${field.type}`);
    }
    if (p > blob.length) fail('PARSE', `${info.name}: row ${objectId} overruns its blob at ${field.name}`);
  }
  return { objectId, attributes, geometryBytes };
}

function readVarUint(buf: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = start;
  for (;;) {
    const byte = buf[p++];
    if (byte === undefined) fail('PARSE', 'truncated variable-length integer');
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: p };
    shift += 7;
    if (shift > 49) fail('PARSE', 'variable-length integer too large');
  }
}

/** Esri dates are days since 1899-12-30, as a double. */
function oleDaysToIso(days: number): string {
  return new Date(Math.round((days - 25569) * 86_400_000)).toISOString();
}

function guidOf(b: Buffer): string {
  const hex = (from: number, to: number, reverse: boolean) => {
    const bytes = [...b.subarray(from, to)];
    return (reverse ? bytes.reverse() : bytes).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return `{${hex(0, 4, true)}-${hex(4, 6, true)}-${hex(6, 8, true)}-${hex(8, 10, false)}-${hex(10, 16, false)}}`.toUpperCase();
}
