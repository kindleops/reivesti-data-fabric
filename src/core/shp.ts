/**
 * Streaming ESRI shapefile (`.shp`) reader that SUMMARISES geometry.
 *
 * Canonical geometry is deferred: nothing downstream consumes parcel polygons,
 * and 10.8 million of them do not belong in the canonical estate on
 * speculation. The exact geometry stays in the retained publisher archive,
 * byte for byte. What this reader derives per record is small and exact enough
 * to report on and to use later:
 *
 *   parts, points     ring and vertex counts
 *   bbox              as the record header states it, in the source CRS
 *   area              planar, by the shoelace formula, in source CRS units²
 *   centroid          area-weighted over all rings (holes subtract), in the source CRS
 *   ringsClosed       every ring ends where it starts, as the format requires
 *
 * All of it is in the file's own coordinate reference system: Florida's county
 * submissions use several State Plane zones, and reprojecting them is a
 * geometry decision this phase does not take. The CRS travels with the numbers.
 *
 * Memory is one record. Records are read in file order, which is the order of
 * the attribute table's rows, so a caller can walk `.shp` and `.dbf` in lockstep.
 */
import { fail } from './errors.ts';
import { ByteCursor } from './dbf.ts';

export type ShpHeader = {
  readonly shapeType: number;
  readonly fileLengthBytes: number;
  readonly bbox: readonly [number, number, number, number];
};

export type ShpSummary = {
  /** 1-based, as the file numbers it. */
  readonly recordNumber: number;
  readonly shapeType: number;
  /** True for a null shape: the row exists, its geometry does not. */
  readonly nullShape: boolean;
  readonly parts: number;
  readonly points: number;
  readonly bbox: readonly [number, number, number, number] | null;
  /** Absolute planar area in source units². Null when there is no polygon. */
  readonly area: number | null;
  readonly centroid: readonly [number, number] | null;
  readonly ringsClosed: boolean;
};

export type ShpReader = {
  readonly header: ShpHeader;
  records(): AsyncGenerator<ShpSummary>;
};

const POLYGON_TYPES: ReadonlySet<number> = new Set([5, 15, 25]);
const MAX_RECORD_BYTES = 256 * 1024 * 1024;

export async function openShp(chunks: AsyncIterable<Buffer>): Promise<ShpReader> {
  const cursor = new ByteCursor(chunks);
  const head = await cursor.read(100);
  if (head === null) fail('PARSE', 'shapefile is empty');
  if (head.readInt32BE(0) !== 9994) fail('PARSE', 'not a shapefile: bad file code');
  const fileLengthBytes = head.readInt32BE(24) * 2;
  const header: ShpHeader = {
    shapeType: head.readInt32LE(32),
    fileLengthBytes,
    bbox: [head.readDoubleLE(36), head.readDoubleLE(44), head.readDoubleLE(52), head.readDoubleLE(60)],
  };

  async function* records(): AsyncGenerator<ShpSummary> {
    let expectedNumber = 1;
    while (cursor.position < fileLengthBytes) {
      const recordHead = await cursor.read(8);
      if (recordHead === null) fail('PARSE', `shapefile ends at byte ${cursor.position}, before its declared ${fileLengthBytes}`);
      const recordNumber = recordHead.readInt32BE(0);
      const contentBytes = recordHead.readInt32BE(4) * 2;
      if (recordNumber !== expectedNumber) fail('PARSE', `shapefile record ${expectedNumber} is numbered ${recordNumber}`);
      if (contentBytes < 4 || contentBytes > MAX_RECORD_BYTES) fail('PARSE', `shapefile record ${recordNumber} has length ${contentBytes}`);
      const content = await cursor.read(contentBytes);
      if (content === null) fail('PARSE', `shapefile record ${recordNumber} is truncated`);
      yield summarise(recordNumber, content);
      expectedNumber += 1;
    }
    await cursor.drain();
  }

  return { header, records };
}

function summarise(recordNumber: number, content: Buffer): ShpSummary {
  const shapeType = content.readInt32LE(0);
  if (shapeType === 0) {
    return { recordNumber, shapeType, nullShape: true, parts: 0, points: 0, bbox: null, area: null, centroid: null, ringsClosed: true };
  }
  if (!POLYGON_TYPES.has(shapeType)) {
    fail('PARSE', `shapefile record ${recordNumber} has shape type ${shapeType}; only polygons are summarised`);
  }
  if (content.length < 44) fail('PARSE', `shapefile record ${recordNumber} is too short for a polygon`);
  const bbox: [number, number, number, number] = [
    content.readDoubleLE(4), content.readDoubleLE(12), content.readDoubleLE(20), content.readDoubleLE(28),
  ];
  const parts = content.readInt32LE(36);
  const points = content.readInt32LE(40);
  const partsAt = 44;
  const pointsAt = partsAt + 4 * parts;
  if (parts < 0 || points < 0 || pointsAt + 16 * points > content.length) {
    fail('PARSE', `shapefile record ${recordNumber} declares ${parts} parts / ${points} points beyond its length`);
  }
  if (points === 0) {
    return { recordNumber, shapeType, nullShape: false, parts, points, bbox, area: null, centroid: null, ringsClosed: parts === 0 };
  }

  // Coordinates are shifted to the record's first vertex before the shoelace
  // sums: State Plane values run to millions of feet, and products of those
  // lose the precision a small parcel's area lives in.
  const x0 = content.readDoubleLE(pointsAt);
  const y0 = content.readDoubleLE(pointsAt + 8);
  let signedArea2 = 0; // twice the signed area, summed over rings
  let cx6 = 0;
  let cy6 = 0;
  let ringsClosed = true;
  for (let p = 0; p < parts; p++) {
    const first = content.readInt32LE(partsAt + 4 * p);
    const last = (p + 1 < parts ? content.readInt32LE(partsAt + 4 * (p + 1)) : points) - 1;
    if (first < 0 || last >= points || last < first) {
      fail('PARSE', `shapefile record ${recordNumber} part ${p} spans ${first}..${last} of ${points} points`);
    }
    const fx = content.readDoubleLE(pointsAt + 16 * first);
    const fy = content.readDoubleLE(pointsAt + 16 * first + 8);
    const lx = content.readDoubleLE(pointsAt + 16 * last);
    const ly = content.readDoubleLE(pointsAt + 16 * last + 8);
    if (fx !== lx || fy !== ly || last - first < 3) ringsClosed = false;
    for (let i = first; i < last; i++) {
      const ax = content.readDoubleLE(pointsAt + 16 * i) - x0;
      const ay = content.readDoubleLE(pointsAt + 16 * i + 8) - y0;
      const bx = content.readDoubleLE(pointsAt + 16 * (i + 1)) - x0;
      const by = content.readDoubleLE(pointsAt + 16 * (i + 1) + 8) - y0;
      const cross = ax * by - bx * ay;
      signedArea2 += cross;
      cx6 += (ax + bx) * cross;
      cy6 += (ay + by) * cross;
    }
  }
  // Outer rings are clockwise and holes counter-clockwise, so their signed
  // areas already subtract; the magnitude is the polygon's area.
  const area = Math.abs(signedArea2) / 2;
  const centroid: [number, number] | null = signedArea2 === 0
    ? null
    : [x0 + cx6 / (3 * signedArea2), y0 + cy6 / (3 * signedArea2)];
  return { recordNumber, shapeType, nullShape: false, parts, points, bbox, area, centroid, ringsClosed };
}

/** The linear unit a `.prj` declares, in metres per unit, or null when it declares none. */
export function prjLinearUnitMetres(prjWkt: string): { readonly name: string; readonly metres: number } | null {
  // The projected CRS's own UNIT is the last one in the WKT; the first belongs to the GEOGCS (degrees).
  const units = [...prjWkt.matchAll(/UNIT\["([^"]+)",\s*([0-9.eE+-]+)\]/g)];
  const last = units.at(-1);
  if (last === undefined || /degree/i.test(last[1] as string)) return null;
  const metres = Number(last[2]);
  return Number.isFinite(metres) && metres > 0 ? { name: last[1] as string, metres } : null;
}

/** The projected CRS name a `.prj` declares — e.g. `NAD_1983_StatePlane_Florida_North_FIPS_0903_Feet`. */
export function prjName(prjWkt: string): string | null {
  const m = /^\s*PROJCS\["([^"]+)"/.exec(prjWkt) ?? /^\s*GEOGCS\["([^"]+)"/.exec(prjWkt);
  return m === null ? null : (m[1] as string);
}
