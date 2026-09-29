/**
 * Florida DOR fixtures: invented rows in the Department's REAL published
 * layouts, packaged exactly as the PTO data library serves them.
 *
 * - NAL and SDF: comma-delimited, CRLF, a header row, one zip per county,
 *   the column lists copied from the 2026 files themselves (165 and 23).
 * - PAR: an ESRI shapefile (.shp/.shx/.dbf/.prj/.cpg) per county, polygons
 *   joined to 118 roll attributes, zipped.
 * - The library: a SharePoint REST folder listing per folder, and a GET per
 *   file — the only two requests the connector makes.
 *
 * Nothing here is a real parcel, owner or address.
 */
import { crc32, deflateRawSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

export function zipOf(entries: readonly { readonly name: string; readonly bytes: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = deflateRawSync(e.bytes);
    const crc = crc32(e.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(e.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export type DbfFieldSpec = { readonly name: string; readonly type: 'C' | 'N'; readonly length: number; readonly decimals?: number };
export type DbfRowSpec = { readonly [field: string]: string | number | boolean | null | undefined; readonly __deleted?: boolean };

/** A dBase III table. Numbers are written right-aligned with the declared decimals, text left-aligned. */
export function dbfOf(
  fields: readonly DbfFieldSpec[],
  rows: readonly DbfRowSpec[],
  options: { readonly declaredCount?: number; readonly eof?: boolean } = {},
): Buffer {
  const recordLength = 1 + fields.reduce((s, f) => s + f.length, 0);
  const headerLength = 32 + 32 * fields.length + 1;
  const head = Buffer.alloc(32);
  head.writeUInt8(0x03, 0); head.writeUInt8(126, 1); head.writeUInt8(7, 2); head.writeUInt8(27, 3);
  head.writeUInt32LE(options.declaredCount ?? rows.length, 4);
  head.writeUInt16LE(headerLength, 8); head.writeUInt16LE(recordLength, 10);
  const descriptors = fields.map((f) => {
    const d = Buffer.alloc(32);
    d.write(f.name.slice(0, 10), 0, 'latin1');
    d.writeUInt8(f.type.charCodeAt(0), 11); d.writeUInt8(f.length, 16); d.writeUInt8(f.decimals ?? 0, 17);
    return d;
  });
  const records = rows.map((row) => {
    const r = Buffer.alloc(recordLength, 0x20);
    r.writeUInt8(row.__deleted ? 0x2a : 0x20, 0);
    let at = 1;
    for (const f of fields) {
      const v = row[f.name];
      if (v !== null && v !== undefined && typeof v !== 'boolean') {
        const text = f.type === 'N' && typeof v === 'number' ? v.toFixed(f.decimals ?? 0) : String(v);
        const bytes = Buffer.from(text, 'utf8');
        if (bytes.length > f.length) throw new Error(`${f.name}: ${text} is wider than ${f.length}`);
        bytes.copy(r, f.type === 'N' ? at + f.length - bytes.length : at);
      }
      at += f.length;
    }
    return r;
  });
  return Buffer.concat([head, ...descriptors, Buffer.from([0x0d]), ...records, ...(options.eof === false ? [] : [Buffer.from([0x1a])])]);
}

export type Ring = readonly (readonly [number, number])[];
/** A polygon as rings; outer rings clockwise, holes counter-clockwise. `null` is a null shape. */
export type PolygonSpec = readonly Ring[] | null;

/** An axis-aligned square ring, closed, clockwise (outer) unless `hole`. */
export function square(x: number, y: number, size: number, hole = false): Ring {
  const cw: [number, number][] = [[x, y], [x, y + size], [x + size, y + size], [x + size, y], [x, y]];
  return hole ? [...cw].reverse() : cw;
}

export function shpOf(polygons: readonly PolygonSpec[]): { shp: Buffer; shx: Buffer } {
  const records: Buffer[] = [];
  const index: Buffer[] = [];
  let offsetWords = 50;
  let [xmin, ymin, xmax, ymax] = [Infinity, Infinity, -Infinity, -Infinity];
  polygons.forEach((rings, i) => {
    let content: Buffer;
    if (rings === null) {
      content = Buffer.alloc(4); // shape type 0
    } else {
      const points = rings.flat();
      const parts = rings.length;
      content = Buffer.alloc(44 + 4 * parts + 16 * points.length);
      content.writeInt32LE(5, 0);
      const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
      const bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
      [xmin, ymin, xmax, ymax] = [Math.min(xmin, bb[0]), Math.min(ymin, bb[1]), Math.max(xmax, bb[2]), Math.max(ymax, bb[3])];
      bb.forEach((v, k) => content.writeDoubleLE(v, 4 + 8 * k));
      content.writeInt32LE(parts, 36); content.writeInt32LE(points.length, 40);
      let start = 0;
      rings.forEach((ring, p) => { content.writeInt32LE(start, 44 + 4 * p); start += ring.length; });
      points.forEach((pt, k) => { content.writeDoubleLE(pt[0], 44 + 4 * parts + 16 * k); content.writeDoubleLE(pt[1], 44 + 4 * parts + 16 * k + 8); });
    }
    const head = Buffer.alloc(8);
    head.writeInt32BE(i + 1, 0); head.writeInt32BE(content.length / 2, 4);
    records.push(head, content);
    const ix = Buffer.alloc(8);
    ix.writeInt32BE(offsetWords, 0); ix.writeInt32BE(content.length / 2, 4);
    index.push(ix);
    offsetWords += (8 + content.length) / 2;
  });
  const fileHeader = (lengthWords: number) => {
    const h = Buffer.alloc(100);
    h.writeInt32BE(9994, 0); h.writeInt32BE(lengthWords, 24); h.writeInt32LE(1000, 28); h.writeInt32LE(5, 32);
    [xmin, ymin, xmax, ymax].forEach((v, k) => h.writeDoubleLE(Number.isFinite(v) ? v : 0, 36 + 8 * k));
    return h;
  };
  const shpBody = Buffer.concat(records);
  const shxBody = Buffer.concat(index);
  return {
    shp: Buffer.concat([fileHeader(50 + shpBody.length / 2), shpBody]),
    shx: Buffer.concat([fileHeader(50 + shxBody.length / 2), shxBody]),
  };
}

export const STATE_PLANE_FL_NORTH_FEET_PRJ =
  'PROJCS["NAD_1983_StatePlane_Florida_North_FIPS_0903_Feet",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",'
  + 'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.017453292519943295]],'
  + 'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",1968500.0],PARAMETER["False_Northing",0.0],'
  + 'PARAMETER["Central_Meridian",-84.5],PARAMETER["Standard_Parallel_1",29.583333333333332],'
  + 'PARAMETER["Standard_Parallel_2",30.75],PARAMETER["Latitude_Of_Origin",29.0],UNIT["Foot_US",0.30480060960121924]]';

// ---------------------------------------------------------------------------
// The PTO data library, as SharePoint serves it
// ---------------------------------------------------------------------------

export type PortalRequest = { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export type FakePortal = {
  /** Places a file at a server-relative path under the library (folders are implied). */
  put(path: string, bytes: Buffer, meta?: { readonly etag?: string; readonly lastModified?: string }): void;
  remove(path: string): void;
  /** A folder that exists but holds only what `put` placed, e.g. a `~` folder. */
  folder(path: string): void;
  readonly requests: PortalRequest[];
  fileGets(): number;
  fetchImpl: typeof fetch;
};

export const PTO_ROOT = '/property/dataportal/Documents/PTO Data Portal';

export function fakePortal(): FakePortal {
  const files = new Map<string, { bytes: Buffer; etag: string; lastModified: string }>();
  const folders = new Set<string>([PTO_ROOT]);
  const requests: PortalRequest[] = [];
  let gets = 0;
  let version = 0;

  const addFolders = (path: string) => {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  };

  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const api = /\/_api\/web\/GetFolderByServerRelativeUrl\('(.+)'\)\?\$expand=Folders,Files$/.exec(url);
    if (api !== null) {
      const path = decodeURIComponent(api[1] as string).replace(/''/g, "'");
      if (!folders.has(path)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const childFolders = [...folders].filter((f) => f !== path && f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/'));
      const childFiles = [...files.entries()].filter(([f]) => f.startsWith(`${path}/`) && !f.slice(path.length + 1).includes('/'));
      return new Response(JSON.stringify({
        Folders: childFolders.map((f) => ({ Name: f.slice(path.length + 1), ServerRelativeUrl: f, ItemCount: 0, TimeLastModified: '2026-09-01T00:00:00Z' })),
        Files: childFiles.map(([f, v]) => ({
          Name: f.slice(path.length + 1), ServerRelativeUrl: f, Length: String(v.bytes.length), ETag: v.etag,
          TimeLastModified: v.lastModified, UniqueId: v.etag, UIVersionLabel: '1.0',
        })),
      }), { status: 200, headers: { 'content-type': 'application/json;odata=nometadata' } });
    }
    const path = decodeURI(new URL(url).pathname);
    const file = files.get(path);
    if (file === undefined) return new Response('not found', { status: 404 });
    if (method === 'GET') gets += 1;
    return new Response(method === 'HEAD' ? null : file.bytes, {
      status: 200,
      headers: { etag: file.etag, 'content-length': String(file.bytes.length), 'last-modified': new Date(file.lastModified).toUTCString() },
    });
  }) as typeof fetch;

  return {
    put(path, bytes, meta = {}) {
      const full = `${PTO_ROOT}/${path}`;
      addFolders(full);
      version += 1;
      files.set(full, {
        bytes,
        etag: meta.etag ?? `"{${String(version).padStart(8, '0')}-FIXTURE},1"`,
        lastModified: meta.lastModified ?? '2026-07-27T11:00:00Z',
      });
    },
    remove(path) { files.delete(`${PTO_ROOT}/${path}`); },
    folder(path) { const full = `${PTO_ROOT}/${path}`; addFolders(full); folders.add(full); },
    requests,
    fileGets: () => gets,
    fetchImpl,
  };
}
