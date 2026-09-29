/**
 * A synthetic NYS Tax Parcel Centroid Points release, built at test time.
 *
 * Writes a real (minimal) Esri File Geodatabase — system catalogue, the
 * `NYS_Tax_Parcels_Centroid_Points` point table with the 2025-roll schema in the
 * publisher's own column order and types, and a lookup table beside it — zips it
 * under the publisher's geodatabase name, and serves it through a fake
 * publisher that models what the 2026 migration made interesting: the program
 * page, the archive host (HEAD, GET, byte ranges), the GeoHub FeatureServer, the
 * retiring legacy FeatureServer, and the publisher's ArcGIS Online catalogue item.
 *
 * Every row is invented. Owner names are "TEST OWNER N"; mailing addresses are
 * on "INVENTED WAY". No live New York record is committed or generated here.
 */
import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Geodatabase writer (the Wisconsin fixture's, plus int16 and a point table)
// ---------------------------------------------------------------------------

type FieldKind = 'objectid' | 'string' | 'int16' | 'int32' | 'float64' | 'geometry';
export type NyFieldDef = { readonly name: string; readonly kind: FieldKind; readonly length?: number };

const TYPE_CODE: Readonly<Record<FieldKind, number>> = { int16: 0, int32: 1, float64: 3, string: 4, objectid: 6, geometry: 7 };

const S = (name: string, length: number): NyFieldDef => ({ name, kind: 'string', length });
const D = (name: string): NyFieldDef => ({ name, kind: 'float64' });
const I = (name: string): NyFieldDef => ({ name, kind: 'int32' });
const H = (name: string): NyFieldDef => ({ name, kind: 'int16' });

/** The 2025-roll geodatabase column order and types, as the real archive declares them. */
export const NY_2025_FIELDS: readonly NyFieldDef[] = [
  { name: 'OBJECTID', kind: 'objectid' }, { name: 'Shape', kind: 'geometry' },
  S('COUNTY_NAME', 50), S('MUNI_NAME', 50), S('SWIS', 10), S('PARCEL_ADDR', 255), S('PRINT_KEY', 50), S('SBL', 50),
  S('CITYTOWN_NAME', 50), S('CITYTOWN_SWIS', 10), S('LOC_ST_NBR', 25), S('LOC_STREET', 255), S('LOC_UNIT', 25),
  S('LOC_ZIP', 25), S('PROP_CLASS', 10), S('ROLL_SECTION', 2), D('LAND_AV'), D('TOTAL_AV'), D('FULL_MARKET_VAL'),
  I('YR_BLT'), I('FRONT'), I('DEPTH'), D('SQ_FT'), D('ACRES'), S('SCHOOL_CODE', 10), S('SCHOOL_NAME', 50),
  S('SEWER_TYPE', 2), S('SEWER_DESC', 50), S('WATER_SUPPLY', 2), S('WATER_DESC', 50), S('UTILITIES', 2),
  S('UTILITIES_DESC', 50), S('BLDG_STYLE', 2), S('BLDG_STYLE_DESC', 255), S('HEAT_TYPE', 2), S('HEAT_TYPE_DESC', 50),
  S('FUEL_TYPE', 2), S('FUEL_TYPE_DESC', 50), D('SQFT_LIVING'), I('GFA'), H('NBR_KITCHENS'), H('NBR_FULL_BATHS'),
  H('NBR_BEDROOMS'), S('USED_AS_CODE', 10), S('USED_AS_DESC', 50), S('AG_DIST_CODE', 10), S('AG_DIST_NAME', 50),
  S('MAIL_ADDR', 255), S('PO_BOX', 50), S('MAIL_CITY', 50), S('MAIL_STATE', 50), S('MAIL_ZIP', 50),
  S('ADD_MAIL_ADDR', 255), S('ADD_MAIL_PO_BOX', 50), S('ADD_MAIL_CITY', 50), S('ADD_MAIL_STATE', 50),
  S('ADD_MAIL_ZIP', 10), I('BOOK'), I('PAGE'), D('GRID_EAST'), D('GRID_NORTH'), S('MUNI_PARCEL_ID', 50),
  S('SWIS_SBL_ID', 50), S('SWIS_PRINT_KEY_ID', 50), I('ROLL_YR'), I('SPATIAL_YR'), S('OWNER_TYPE', 10),
  S('PRIMARY_OWNER', 255), S('ADD_OWNER', 255), S('NYS_NAME', 50), S('NYS_NAME_SOURCE', 50), S('DUP_GEO', 5),
  D('CALC_ACRES'), I('ORIG_FID'),
];

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f64 = (n: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const varuint = (n: number) => {
  const out: number[] = [];
  do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0);
  return Buffer.from(out);
};
const utf16 = (s: string) => Buffer.concat([u8(s.length), Buffer.from(s, 'utf16le')]);

function fieldDescriptor(f: NyFieldDef): Buffer {
  const head = Buffer.concat([utf16(f.name), utf16(''), u8(TYPE_CODE[f.kind])]);
  switch (f.kind) {
    case 'objectid': return Buffer.concat([head, u8(4), u8(2)]);
    case 'string': return Buffer.concat([head, i32(f.length ?? 50), u8(1), varuint(0)]);
    case 'int16': return Buffer.concat([head, u8(2), u8(1), u8(0)]);
    case 'int32': return Buffer.concat([head, u8(4), u8(1), u8(0)]);
    case 'float64': return Buffer.concat([head, u8(8), u8(1), u8(0)]);
    case 'geometry': {
      const wkt = Buffer.from('PROJCS["NAD_1983_UTM_Zone_18N",GEOGCS["GCS_North_American_1983"]]', 'utf16le');
      return Buffer.concat([
        head, u8(0), u8(1), u16(wkt.length), wkt,
        u8(7), // flags: has M and has Z
        f64(0), f64(0), f64(10000), // xy origin, scale
        f64(0), f64(10000), // m origin, scale
        f64(0), f64(10000), // z origin, scale
        f64(0.001), f64(0.001), f64(0.001), // tolerances xy, m, z
        f64(0), f64(0), f64(1), f64(1), // extent
        u8(0), i32(1), f64(100), // one spatial grid size
      ]);
    }
  }
}

export type NyRow = Readonly<Record<string, string | number | null | undefined>>;

function encodeRow(fields: readonly NyFieldDef[], row: NyRow): Buffer {
  const nullable = fields.filter((f) => f.kind !== 'objectid');
  const bitmap = Buffer.alloc(Math.ceil(nullable.length / 8));
  const values: Buffer[] = [];
  nullable.forEach((f, i) => {
    if (f.kind === 'geometry') {
      // A 13-byte opaque point blob, the size every real row carries; the reader skips it.
      const blob = row['__noGeometry'] ? null : Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      if (blob === null) { bitmap[i >> 3]! |= 1 << (i & 7); return; }
      values.push(varuint(blob.length), blob);
      return;
    }
    const v = row[f.name];
    if (v === null || v === undefined) { bitmap[i >> 3]! |= 1 << (i & 7); return; }
    if (f.kind === 'string') { const b = Buffer.from(String(v), 'utf8'); values.push(varuint(b.length), b); }
    else if (f.kind === 'float64') values.push(f64(Number(v)));
    else if (f.kind === 'int32') values.push(i32(Number(v)));
    else if (f.kind === 'int16') values.push(i16(Number(v)));
  });
  return Buffer.concat([bitmap, ...values]);
}

/** One table: `.gdbtable` and `.gdbtablx`. `rows[i]` is OBJECTID i+1; null is a deleted slot. */
function writeTable(fields: readonly NyFieldDef[], geometryType: number, rows: readonly (NyRow | null)[]): { table: Buffer; tablx: Buffer } {
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
// Rows
// ---------------------------------------------------------------------------

/** County names as the layer spells them, with their ORPTS SWIS county codes. */
export const NY_FIXTURE_COUNTY: Readonly<Record<string, { readonly fips: string; readonly swisCounty: string }>> = {
  Albany: { fips: '36001', swisCounty: '01' },
  Erie: { fips: '36029', swisCounty: '14' },
  Kings: { fips: '36047', swisCounty: '61' },
  Monroe: { fips: '36055', swisCounty: '26' },
  Nassau: { fips: '36059', swisCounty: '28' },
  NewYork: { fips: '36061', swisCounty: '62' },
  StLawrence: { fips: '36089', swisCounty: '40' },
  Suffolk: { fips: '36103', swisCounty: '47' },
  Westchester: { fips: '36119', swisCounty: '55' },
};

const NYC = new Set(['Bronx', 'Kings', 'NewYork', 'Queens', 'Richmond']);

/**
 * A clean row with invented values. `swis` is the full 6-digit code; `sbl` the
 * unformatted tax map number. Override whatever a test needs.
 */
export function nyParcel(county: string, swis: string, sbl: string, overrides: NyRow = {}): NyRow {
  const n = [...`${swis}${sbl}`].reduce((a, c) => a + c.charCodeAt(0), 0);
  const nyc = NYC.has(county);
  const cityTown = `${swis.slice(0, 4)}00`;
  const printKey = nyc ? null : `${Number(sbl.slice(0, 3)) || 1}.-${n % 9 + 1}-${n % 97}`;
  return {
    COUNTY_NAME: county,
    MUNI_NAME: nyc ? 'Brooklyn' : 'Testville',
    SWIS: swis,
    PARCEL_ADDR: `${n} Test Rd`,
    PRINT_KEY: printKey,
    SBL: sbl,
    CITYTOWN_NAME: nyc ? 'New York' : 'Testville',
    CITYTOWN_SWIS: cityTown,
    LOC_ST_NBR: String(n),
    LOC_STREET: 'Test Rd',
    LOC_ZIP: '12000',
    PROP_CLASS: nyc ? '01' : '210',
    ROLL_SECTION: nyc ? null : '1',
    LAND_AV: 20000,
    TOTAL_AV: 100000 + n,
    FULL_MARKET_VAL: nyc ? null : 125000 + n,
    YR_BLT: 1950,
    FRONT: 60,
    DEPTH: 120,
    SQ_FT: nyc ? 2500 : 0,
    ACRES: nyc ? null : 0.17,
    SCHOOL_CODE: nyc ? null : `${swis.slice(0, 4)}01`,
    SCHOOL_NAME: nyc ? null : 'Test Central',
    BLDG_STYLE: nyc ? 'A1' : '06',
    BLDG_STYLE_DESC: nyc ? 'Test class' : 'Colonial',
    SQFT_LIVING: 1600,
    NBR_KITCHENS: 1,
    NBR_FULL_BATHS: 2,
    NBR_BEDROOMS: 3,
    MAIL_ADDR: nyc ? null : `${100 + n} INVENTED WAY`,
    MAIL_CITY: nyc ? null : 'FAKETOWN',
    MAIL_STATE: nyc ? null : 'NY',
    MAIL_ZIP: nyc ? null : '12000',
    BOOK: nyc ? null : 1234,
    PAGE: nyc ? null : 56,
    GRID_EAST: 600000 + n,
    GRID_NORTH: 1100000 + n,
    MUNI_PARCEL_ID: nyc ? null : `${cityTown}${String(n).padStart(9, '0')}`,
    SWIS_SBL_ID: `${swis}${sbl}`,
    SWIS_PRINT_KEY_ID: printKey === null ? null : `${swis}${printKey}`,
    ROLL_YR: 2025,
    SPATIAL_YR: 2025,
    OWNER_TYPE: '8',
    PRIMARY_OWNER: `TEST OWNER ${n}`,
    CALC_ACRES: 0.18,
    ORIG_FID: n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A release
// ---------------------------------------------------------------------------

export type NyRelease = {
  readonly rollYear: number;
  /** `yymm`, e.g. `2605`. */
  readonly build: string;
  readonly rows: readonly (NyRow | null)[];
  /** Override the table schema, e.g. to simulate a publisher adding a column. */
  readonly fields?: readonly NyFieldDef[];
  /** Override the geodatabase directory name, e.g. to simulate a misnamed release. */
  readonly geodatabase?: string;
};

export type BuiltNyRelease = {
  readonly archive: Buffer;
  readonly geodatabase: string;
  readonly referencePeriod: string;
  readonly validRows: number;
  readonly sha256: string;
};

export function buildNyRelease(release: NyRelease): BuiltNyRelease {
  const geodatabase = release.geodatabase ?? `NYS_${release.rollYear}_Tax_Parcels_Centroid_Points_${release.build}.gdb`;
  const catalogFields: NyFieldDef[] = [{ name: 'ID', kind: 'objectid' }, S('Name', 160), I('FileFormat')];
  // Catalogue slot 19 (0x13) is the point table, as in the real archive; a
  // lookup table sits at 20 so the reader must find the table by name.
  const catalogRows: (NyRow | null)[] = [];
  for (let i = 1; i <= 20; i++) {
    if (i === 8) { catalogRows.push(null); continue; }
    const name = i === 19 ? 'NYS_Tax_Parcels_Centroid_Points' : i === 20 ? 'SWIS_Muni_Codes' : `GDB_System${i}`;
    catalogRows.push({ Name: name, FileFormat: 0 });
  }
  const catalog = writeTable(catalogFields, 0, catalogRows);
  const points = writeTable(release.fields ?? NY_2025_FIELDS, 1, release.rows);
  const lookup = writeTable([{ name: 'OBJECTID', kind: 'objectid' }, S('SWIS', 10), S('COUNTY_NAME', 50)], 0, [{ SWIS: '010100', COUNTY_NAME: 'Albany' }]);
  const g = `${geodatabase}/`;
  const archive = zip([
    { name: g, bytes: null },
    { name: `${g}a00000001.gdbtable`, bytes: catalog.table },
    { name: `${g}a00000001.gdbtablx`, bytes: catalog.tablx },
    { name: `${g}a00000013.gdbtable`, bytes: points.table },
    { name: `${g}a00000013.gdbtablx`, bytes: points.tablx },
    { name: `${g}a00000014.gdbtable`, bytes: lookup.table },
    { name: `${g}a00000014.gdbtablx`, bytes: lookup.tablx },
    { name: `${g}gdb`, bytes: Buffer.from([5, 0, 0, 0]) },
  ]);
  return {
    archive,
    geodatabase,
    referencePeriod: `${release.rollYear}-${release.build}`,
    validRows: release.rows.filter((r) => r !== null).length,
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

/** A polygon archive: only its geodatabase name matters, because it is never read. */
export function buildNyPolygonRelease(rollYear: number, build: string): { readonly archive: Buffer; readonly sha256: string } {
  const g = `NYS_${rollYear}_Tax_Parcels_Public_${build}.gdb/`;
  const archive = zip([{ name: g, bytes: null }, { name: `${g}gdb`, bytes: Buffer.from([5, 0, 0, 0]) }]);
  return { archive, sha256: createHash('sha256').update(archive).digest('hex') };
}

// ---------------------------------------------------------------------------
// A fake publisher, mid-migration
// ---------------------------------------------------------------------------

export const NY_CENTROID_ARCHIVE_URL = 'https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcel-Centroid-Points.gdb.zip';
export const NY_POLYGON_ARCHIVE_URL = 'https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels.zip';
const STATE_OWNED_URL = 'https://gisdata.ny.gov/GISData/State/Parcels/NYS-Tax-Parcels-State-Owned.gdb.zip';
const LEGACY = 'gisservices.its.ny.gov';

export type RequestRecord = { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export type NyPublisherOptions = {
  /** Which centroid/polygon FeatureServers the program page links. */
  readonly serviceLinks?: 'geohub' | 'legacy' | 'both' | 'none';
  /** GeoHub's host. Change it to simulate the publisher moving services again. */
  readonly geohubHost?: string;
  /** What the catalogue item says: its owner, and whether it answers at all. */
  readonly catalogOwner?: string | null;
  /** Add a third-party mirror of the archive to the program page. */
  readonly mirror?: boolean;
  /** Whether the archive host serves byte ranges. */
  readonly ranges?: boolean;
  /** Whether the program page links the archives at all. */
  readonly archiveLinks?: boolean;
};

export type NyFakePublisher = {
  readonly fetchImpl: typeof fetch;
  readonly requests: RequestRecord[];
  publish(release: BuiltNyRelease, options?: { serviceCount?: number; etag?: string; title?: string; publication?: string; serviceFields?: { name: string; type: string; length?: number }[] }): void;
  publishPolygons(release: { archive: Buffer; sha256: string } | null, options?: { etag?: string }): void;
  archiveGets(url?: string): number;
  legacyRequests(): number;
  set(options: NyPublisherOptions): void;
};

const REST_TYPE: Readonly<Record<FieldKind, string>> = {
  objectid: 'esriFieldTypeOID', string: 'esriFieldTypeString', int16: 'esriFieldTypeSmallInteger',
  int32: 'esriFieldTypeInteger', float64: 'esriFieldTypeDouble', geometry: 'esriFieldTypeGeometry',
};

/** The service's attribute list: the geodatabase's, as the GeoHub layer declares it. */
export function nyServiceFields(fields: readonly NyFieldDef[] = NY_2025_FIELDS): { name: string; type: string; length?: number }[] {
  return fields.filter((f) => f.kind !== 'geometry').map((f) => ({
    name: f.name, type: REST_TYPE[f.kind], ...(f.length !== undefined ? { length: f.length } : {}),
  }));
}

export function nyFakePublisher(initial: NyPublisherOptions = {}): NyFakePublisher {
  const requests: RequestRecord[] = [];
  let options: NyPublisherOptions = {
    serviceLinks: 'geohub', geohubHost: 'nysgeohub.ny.gov', catalogOwner: 'NYSGIS_GPO', mirror: false, ranges: true,
    archiveLinks: true, ...initial,
  };
  const published: { release: BuiltNyRelease; serviceCount: number; etag: string; title: string; publication: string; serviceFields: { name: string; type: string; length?: number }[] }[] = [];
  let polygons: { archive: Buffer; sha256: string; etag: string } | null = null;

  const geohub = () => `https://${options.geohubHost}/arcgis/rest/services/Parcels`;
  const legacy = `https://${LEGACY}/arcgis/rest/services`;
  const centroidService = (host: 'geohub' | 'legacy') => `${host === 'geohub' ? geohub() : legacy}/NYS_Tax_Parcel_Centroid_Points/FeatureServer`;
  const polygonService = (host: 'geohub' | 'legacy') => `${host === 'geohub' ? geohub() : legacy}/NYS_Tax_Parcels_Public/FeatureServer`;

  const archiveResponse = (bytes: Buffer, etag: string, method: string, range: string | undefined): Response => {
    const base = {
      etag, 'last-modified': 'Thu, 24 Sep 2026 12:45:48 GMT', 'content-type': 'application/zip',
      ...(options.ranges ? { 'accept-ranges': 'bytes' } : {}),
    };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...base, 'content-length': String(bytes.length) } });
    const m = range === undefined ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m && options.ranges) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      const slice = bytes.subarray(start, end + 1);
      return new Response(new Uint8Array(slice), { status: 206, headers: { ...base, 'content-length': String(slice.length), 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers: { ...base, 'content-length': String(bytes.length) } });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    requests.push({ method, url, headers });
    const current = published.at(-1);

    if (url === 'https://gis.ny.gov/parcels') {
      const links = options.archiveLinks ? [NY_CENTROID_ARCHIVE_URL, NY_POLYGON_ARCHIVE_URL, STATE_OWNED_URL] : [];
      const s = options.serviceLinks;
      if (s === 'geohub' || s === 'both') links.push(centroidService('geohub'), polygonService('geohub'));
      if (s === 'legacy' || s === 'both') links.push(centroidService('legacy'), polygonService('legacy'));
      if (options.mirror) links.push('https://parcels-mirror.example.com/NYS-Tax-Parcel-Centroid-Points.gdb.zip');
      return new Response(`<html><body><h2>Data Download</h2>${links.map((l) => `<a href="${l}">x</a>`).join('\n')}</body></html>`, { status: 200 });
    }
    if (url.startsWith('https://www.arcgis.com/sharing/rest/content/items/')) {
      if (options.catalogOwner === null) return new Response(JSON.stringify({ error: { code: 400 } }), { status: 200 });
      return new Response(JSON.stringify({ id: 'b25e828955bd4391ad17650d6893edde', owner: options.catalogOwner, url: `${centroidService('geohub')}/0` }), { status: 200 });
    }
    if (url === NY_CENTROID_ARCHIVE_URL && current !== undefined) {
      return archiveResponse(current.release.archive, current.etag, method, headers['range']);
    }
    if (url === NY_POLYGON_ARCHIVE_URL && polygons !== null) {
      return archiveResponse(polygons.archive, polygons.etag, method, headers['range']);
    }
    const host = new URL(url).hostname;
    if (host === options.geohubHost || host === LEGACY) {
      const which = host === LEGACY ? 'legacy' : 'geohub';
      if (url.startsWith(`${polygonService(which)}/1/query`)) {
        return new Response(JSON.stringify({ count: polygons === null ? 0 : 7 }), { status: 200 });
      }
      if (url.startsWith(`${centroidService(which)}/0/query`) && url.includes('returnCountOnly=true')) {
        return new Response(JSON.stringify({ count: current?.serviceCount ?? 0 }), { status: 200 });
      }
      if (url === `${centroidService(which)}/0?f=json`) {
        return new Response(JSON.stringify({
          name: 'NYS Tax Parcel Centroid Points', capabilities: 'Query,Extract', maxRecordCount: 2000,
          objectIdField: 'OBJECTID', geometryType: 'esriGeometryPoint',
          advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
          copyrightText: 'Synthetic fixture', fields: current?.serviceFields ?? nyServiceFields(),
        }), { status: 200 });
      }
      if (url === `${centroidService(which)}?f=json`) {
        return new Response(JSON.stringify({
          currentVersion: which === 'legacy' ? 10.81 : 11.5, serviceItemId: which === 'legacy' ? undefined : 'a83d82c6042f49b28f370f2797c9dc9b',
          documentInfo: { Title: current?.title ?? 'NYS 2025 Tax Parcel Centroid Points' },
          serviceDescription: `<div><span>Publication Date: </span><span>${current?.publication ?? 'May 2026'}</span></div>`,
        }), { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetchImpl,
    requests,
    publish(release, o = {}) {
      published.push({
        release, serviceCount: o.serviceCount ?? release.validRows, etag: o.etag ?? `"${release.sha256.slice(0, 16)}"`,
        title: o.title ?? `NYS ${release.referencePeriod.slice(0, 4)} Tax Parcel Centroid Points`,
        publication: o.publication ?? 'May 2026', serviceFields: o.serviceFields ?? nyServiceFields(),
      });
    },
    publishPolygons(release, o = {}) {
      polygons = release === null ? null : { ...release, etag: o.etag ?? `"${release.sha256.slice(0, 16)}"` };
    },
    archiveGets: (url) => requests.filter((r) => r.method === 'GET' && r.headers['range'] === undefined
      && (url === undefined ? r.url.endsWith('.zip') : r.url === url)).length,
    legacyRequests: () => requests.filter((r) => new URL(r.url).hostname === LEGACY).length,
    set(next) { options = { ...options, ...next }; },
  };
}
