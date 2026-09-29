/**
 * A synthetic Wisconsin statewide parcel release, built at test time.
 *
 * Writes a real (minimal) Esri File Geodatabase — system catalogue plus a
 * `V1200_WisconsinParcels_2026` table carrying the full V12 schema and a
 * geometry column — zips it exactly as the State Cartographer's Office does, and
 * serves it through a fake publisher: landing page, archive HEAD and GET, and a
 * FeatureServer witness. The pipeline under test cannot tell the difference
 * between this and the real thing, which is the point.
 *
 * Every row is invented. Owner names are "Test Owner N"; mailing addresses are
 * on "Invented Way". No live Wisconsin record is committed or generated here.
 */
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';

// ---------------------------------------------------------------------------
// Geodatabase writer
// ---------------------------------------------------------------------------

type FieldKind = 'objectid' | 'string' | 'int32' | 'float64' | 'geometry';
type FieldDef = { readonly name: string; readonly kind: FieldKind; readonly length?: number; readonly alias?: string };

const TYPE_CODE: Readonly<Record<FieldKind, number>> = { int32: 1, float64: 3, string: 4, objectid: 6, geometry: 7 };

/** The V12 geodatabase field order, as the real archive declares it. */
export const V12_FIELDS: readonly FieldDef[] = [
  { name: 'OBJECTID', kind: 'objectid' },
  { name: 'Shape', kind: 'geometry' },
  ...[
    ['STATEID', 100], ['PARCELID', 100], ['TAXPARCELID', 100], ['PARCELDATE', 25], ['TAXROLLYEAR', 10],
    ['OWNERNME1', 254], ['OWNERNME2', 254], ['PSTLADRESS', 200], ['SITEADRESS', 200], ['ADDNUMPREFIX', 50],
    ['ADDNUM', 50], ['ADDNUMSUFFIX', 50], ['PREFIX', 50], ['STREETNAME', 50], ['STREETTYPE', 50], ['SUFFIX', 50],
    ['LANDMARKNAME', 50], ['UNITTYPE', 50], ['UNITID', 50], ['PLACENAME', 100], ['ZIPCODE', 50], ['ZIP4', 50],
    ['STATE', 50], ['SCHOOLDIST', 60], ['SCHOOLDISTNO', 50],
  ].map(([name, length]) => ({ name: name as string, kind: 'string' as const, length: length as number })),
  ...['CNTASSDVALUE', 'LNDVALUE', 'IMPVALUE', 'MFLVALUE', 'ESTFMKVALUE', 'NETPRPTA', 'GRSPRPTA']
    .map((name) => ({ name, kind: 'float64' as const })),
  { name: 'PROPCLASS', kind: 'string', length: 150 },
  { name: 'AUXCLASS', kind: 'string', length: 150 },
  ...['ASSDACRES', 'DEEDACRES', 'GISACRES'].map((name) => ({ name, kind: 'float64' as const })),
  { name: 'CONAME', kind: 'string', length: 50 },
  { name: 'LOADDATE', kind: 'string', length: 10 },
  { name: 'PARCELFIPS', kind: 'string', length: 10 },
  { name: 'PARCELSRC', kind: 'string', length: 50 },
  { name: 'LONGITUDE', kind: 'float64' },
  { name: 'LATITUDE', kind: 'float64' },
  { name: 'Shape_Length', kind: 'float64' },
  { name: 'Shape_Area', kind: 'float64' },
];

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const varuint = (n: number) => {
  const out: number[] = [];
  do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0);
  return Buffer.from(out);
};
const utf16 = (s: string) => Buffer.concat([u8(s.length), Buffer.from(s, 'utf16le')]);

function fieldDescriptor(f: FieldDef): Buffer {
  const head = Buffer.concat([utf16(f.name), utf16(f.alias ?? ''), u8(TYPE_CODE[f.kind])]);
  switch (f.kind) {
    case 'objectid': return Buffer.concat([head, u8(4), u8(2)]);
    case 'string': return Buffer.concat([head, i32(f.length ?? 50), u8(1), varuint(0)]);
    case 'int32': return Buffer.concat([head, u8(4), u8(1), u8(0)]);
    case 'float64': return Buffer.concat([head, u8(8), u8(1), u8(0)]);
    case 'geometry': {
      const wkt = Buffer.from('PROJCS["NAD_1983_HARN_Wisconsin_TM",GEOGCS["GCS_North_American_1983_HARN"]]', 'utf16le');
      return Buffer.concat([
        head, u8(0), u8(1), u16(wkt.length), wkt,
        u8(7), // flags: has M and has Z
        f64(0), f64(0), f64(10000), // xy origin, scale
        f64(0), f64(10000), // m origin, scale
        f64(0), f64(10000), // z origin, scale
        f64(0.001), f64(0.001), f64(0.001), // tolerances xy, m, z
        f64(0), f64(0), f64(1), f64(1), // extent
        f64(0), f64(0), // z extent (optional block the reader must skip)
        u8(0), i32(1), f64(100), // one spatial grid size
      ]);
    }
  }
}

type Row = Readonly<Record<string, string | number | null | undefined>>;

function encodeRow(fields: readonly FieldDef[], row: Row): Buffer {
  const nullable = fields.filter((f) => f.kind !== 'objectid');
  const bitmap = Buffer.alloc(Math.ceil(nullable.length / 8));
  const values: Buffer[] = [];
  nullable.forEach((f, i) => {
    if (f.kind === 'geometry') {
      // A tiny opaque geometry blob; the reader skips it by length.
      const blob = row['__noGeometry'] ? null : Buffer.from([4, 1, 2, 3]);
      if (blob === null) { bitmap[i >> 3]! |= 1 << (i & 7); return; }
      values.push(varuint(blob.length), blob);
      return;
    }
    const v = row[f.name];
    if (v === null || v === undefined) { bitmap[i >> 3]! |= 1 << (i & 7); return; }
    if (f.kind === 'string') { const b = Buffer.from(String(v), 'utf8'); values.push(varuint(b.length), b); }
    else if (f.kind === 'float64') values.push(f64(Number(v)));
    else if (f.kind === 'int32') values.push(i32(Number(v)));
  });
  return Buffer.concat([bitmap, ...values]);
}

/** One table: `.gdbtable` and `.gdbtablx`. `rows[i]` is OBJECTID i+1; null is a deleted slot. */
function writeTable(fields: readonly FieldDef[], geometryType: number, rows: readonly (Row | null)[]): { table: Buffer; tablx: Buffer } {
  const descriptors = Buffer.concat(fields.map(fieldDescriptor));
  const sectionBody = Buffer.concat([i32(4), u8(geometryType), u8(3), u8(0), u8(0), u16(fields.length), descriptors]);
  const section = Buffer.concat([i32(sectionBody.length), sectionBody]);
  const blobs = rows.map((r) => (r === null ? null : encodeRow(fields, r)));
  const offsets: number[] = [];
  let at = 40 + section.length;
  const body: Buffer[] = [];
  for (const blob of blobs) {
    if (blob === null) { offsets.push(0); continue; }
    offsets.push(at);
    body.push(i32(blob.length), blob);
    at += 4 + blob.length;
  }
  const valid = blobs.filter((b) => b !== null).length;
  const header = Buffer.alloc(40);
  header.writeInt32LE(3, 0);
  header.writeInt32LE(valid, 4);
  header.writeInt32LE(Math.max(0, ...blobs.map((b) => b?.length ?? 0)), 8);
  header.writeInt32LE(5, 12);
  header.writeBigUInt64LE(BigInt(at), 24);
  header.writeBigUInt64LE(40n, 32);
  const table = Buffer.concat([header, section, ...body]);

  const blocks = Math.max(1, Math.ceil(rows.length / 1024));
  const tablx = Buffer.alloc(16 + blocks * 1024 * 5 + 16);
  tablx.writeUInt32LE(3, 0);
  tablx.writeUInt32LE(blocks, 4);
  tablx.writeUInt32LE(rows.length, 8);
  tablx.writeUInt32LE(5, 12);
  offsets.forEach((o, i) => tablx.writeUIntLE(o, 16 + i * 5, 5));
  return { table, tablx };
}

// ---------------------------------------------------------------------------
// ZIP writer
// ---------------------------------------------------------------------------

function zip(entries: readonly { readonly name: string; readonly bytes: Buffer | null }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.bytes === null;
    const data = isDir ? Buffer.alloc(0) : deflateRawSync(e.bytes as Buffer);
    const crc = isDir ? 0 : crc32(e.bytes as Buffer);
    const size = isDir ? 0 : (e.bytes as Buffer).length;
    const method = isDir ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------------------------------------------------------------------------
// A release
// ---------------------------------------------------------------------------

export type WiFixtureRow = Row;

/** A clean parcel row with invented values. Override whatever a test needs. */
export function parcel(county: string, parcelId: string, overrides: Row = {}): Row {
  const n = [...parcelId].reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    STATEID: `${county.slice(0, 3)}${parcelId}`,
    PARCELID: parcelId,
    TAXROLLYEAR: '2025',
    OWNERNME1: `TEST OWNER ${n}`,
    PSTLADRESS: `${100 + n} INVENTED WAY , FAKETOWN, WI 5${String(n).padStart(4, '0')}`,
    SITEADRESS: `${n} N TEST ROAD`,
    ADDNUM: String(n),
    PREFIX: 'N',
    STREETNAME: 'TEST',
    STREETTYPE: 'ROAD',
    PLACENAME: 'TOWN OF TESTVILLE',
    ZIPCODE: '53000',
    STATE: 'WI',
    SCHOOLDIST: 'TEST SCHOOL DISTRICT',
    SCHOOLDISTNO: '0001',
    CNTASSDVALUE: 100000 + n,
    LNDVALUE: 20000,
    IMPVALUE: 80000 + n,
    ESTFMKVALUE: 110000.5,
    NETPRPTA: 1097.67,
    GRSPRPTA: 1234.56,
    PROPCLASS: '1',
    ASSDACRES: 1.25,
    DEEDACRES: 1.27,
    GISACRES: 1.07,
    CONAME: county,
    LOADDATE: '3/04/2026',
    PARCELFIPS: COUNTY_CODE[county] ?? '999',
    PARCELSRC: county,
    LONGITUDE: -89.5,
    LATITUDE: 44.5,
    Shape_Length: 100,
    Shape_Area: 500,
    ...overrides,
  };
}

/** Three-digit codes for the counties the fixtures use. */
export const COUNTY_CODE: Readonly<Record<string, string>> = {
  ADAMS: '001', BROWN: '009', CALUMET: '015', DANE: '025', 'EAU CLAIRE': '035', 'FOND DU LAC': '039',
  MILWAUKEE: '079', OUTAGAMIE: '087', 'ST CROIX': '109', WINNEBAGO: '139',
};

export type WiRelease = {
  readonly version: { readonly major: number; readonly minor: number; readonly patch: number; readonly year: number };
  readonly rows: readonly (Row | null)[];
  /** Override the table schema, e.g. to simulate a publisher adding a column. */
  readonly fields?: readonly FieldDef[];
};

export type { FieldDef };

export type BuiltRelease = {
  readonly archive: Buffer;
  readonly filename: string;
  readonly url: string;
  readonly layerName: string;
  readonly validRows: number;
  readonly sha256: string;
};

export function buildRelease(release: WiRelease): BuiltRelease {
  const { major, minor, patch, year } = release.version;
  const layerName = `V${String(major).padStart(2, '0')}${minor}${patch}_WisconsinParcels_${year}`;
  const stem = `V${major}.${minor}.${patch}_Wisconsin_Parcels_${year}_10.3_Uncompressed`;
  const catalogFields: FieldDef[] = [
    { name: 'ID', kind: 'objectid' }, { name: 'Name', kind: 'string', length: 160 }, { name: 'FileFormat', kind: 'int32' },
  ];
  const catalogRows: (Row | null)[] = [];
  for (let i = 1; i <= 12; i++) {
    if (i === 11) { catalogRows.push(null); continue; } // a deleted slot, as real catalogues have
    catalogRows.push({ Name: i === 12 ? layerName : `GDB_System${i}`, FileFormat: 0 });
  }
  const catalog = writeTable(catalogFields, 0, catalogRows);
  const parcels = writeTable(release.fields ?? V12_FIELDS, 4, release.rows);
  const gdb = `${stem}/${stem}.gdb/`;
  const archive = zip([
    { name: `${stem}/`, bytes: null },
    { name: gdb, bytes: null },
    { name: `${gdb}a00000001.gdbtable`, bytes: catalog.table },
    { name: `${gdb}a00000001.gdbtablx`, bytes: catalog.tablx },
    { name: `${gdb}a0000000c.gdbtable`, bytes: parcels.table },
    { name: `${gdb}a0000000c.gdbtablx`, bytes: parcels.tablx },
    { name: `${gdb}gdb`, bytes: Buffer.from([5, 0, 0, 0]) },
  ]);
  const filename = `${stem}.zip`;
  return {
    archive,
    filename,
    url: `https://web.s3.wisc.edu/parcels/v${major}_parcels/${filename}`,
    layerName,
    validRows: release.rows.filter((r) => r !== null).length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// A fake publisher
// ---------------------------------------------------------------------------

export type RequestRecord = { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export type FakePublisher = {
  readonly fetchImpl: typeof fetch;
  readonly requests: RequestRecord[];
  /** Publish a release: the landing page links it and the service serves it. */
  publish(release: BuiltRelease, options?: { serviceCount?: number; etag?: string }): void;
  archiveGets(): number;
};

/** The service's attribute list: the geodatabase's, plus the hosted layer's own additions. */
function serviceFields(): { name: string; type: string; length?: number }[] {
  const out = V12_FIELDS.filter((f) => f.kind !== 'geometry' && !f.name.startsWith('Shape_')).map((f) => ({
    name: f.name,
    type: f.kind === 'objectid' ? 'esriFieldTypeOID' : f.kind === 'string' ? 'esriFieldTypeString' : 'esriFieldTypeDouble',
    ...(f.length !== undefined ? { length: f.length } : {}),
  }));
  out.splice(out.length, 0, { name: 'SITEADRESS_STAND', type: 'esriFieldTypeString', length: 255 },
    { name: 'Shape__Area', type: 'esriFieldTypeDouble' }, { name: 'Shape__Length', type: 'esriFieldTypeDouble' });
  return out;
}

export function fakePublisher(): FakePublisher {
  const requests: RequestRecord[] = [];
  const published: { release: BuiltRelease; serviceCount: number; etag: string }[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    requests.push({ method, url, headers });
    const current = published.at(-1);

    if (url === 'https://www.sco.wisc.edu/parcels/data/') {
      const links = published.map((p) => `<a href="${p.release.url}">download</a>`).join('\n');
      return new Response(`<html><body><p>This data is provided free of charge</p>${links}</body></html>`, { status: 200 });
    }
    const archive = published.findLast((p) => p.release.url === url);
    if (archive !== undefined) {
      const h = {
        etag: archive.etag, 'last-modified': 'Tue, 30 Jun 2026 21:11:02 GMT',
        'content-length': String(archive.release.archive.length), 'accept-ranges': 'bytes',
        'x-amz-version-id': `v-${archive.etag}`,
      };
      return new Response(method === 'HEAD' ? null : new Uint8Array(archive.release.archive), { status: 200, headers: h });
    }
    if (url.includes('/FeatureServer/0/query') && url.includes('returnCountOnly=true')) {
      return new Response(JSON.stringify({ count: current?.serviceCount ?? 0 }), { status: 200 });
    }
    if (url.includes('/FeatureServer/0?f=json')) {
      return new Response(JSON.stringify({
        name: current?.release.layerName ?? 'none', capabilities: 'Query', maxRecordCount: 2000,
        objectIdField: 'OBJECTID', geometryType: 'esriGeometryPolygon',
        advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
        editingInfo: { lastEditDate: 1782854489649, dataLastEditDate: 1782854489649, schemaLastEditDate: 1781824438654 },
        copyrightText: 'Synthetic fixture', fields: serviceFields(),
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetchImpl,
    requests,
    publish(release, options = {}) {
      published.push({ release, serviceCount: options.serviceCount ?? release.validRows, etag: options.etag ?? `"${release.sha256.slice(0, 16)}"` });
    },
    archiveGets: () => requests.filter((r) => r.method === 'GET' && r.url.endsWith('.zip')).length,
  };
}
