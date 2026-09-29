/**
 * One derived PAR row → a typed cadastral record.
 *
 * Refused, each for a stated reason and each counted:
 *
 *  - DELETED_RECORD       the .dbf marks the record deleted;
 *  - UNJOINED_POLYGON     CO_NO is 0 or blank: the polygon joined no roll
 *                         record — water, right-of-way, common elements a
 *                         county draws but does not assess. Not a parcel the
 *                         roll knows, so not a property here;
 *  - routing              CO_NO outside the Department's table, or routing to
 *                         another county than the file's;
 *  - identity             no PARCEL_ID on a joined record.
 *
 * A second polygon with the same parcel id is caught by the runtime's identity
 * index as a duplicate — the first polygon in file order stands, the rest are
 * counted — because a canonical property has one identity, however many rings
 * a county draws for it. Every polygon stays in the retained archive.
 */
import { fail } from '../../core/errors.ts';
import { flCountyByFips, routeFlCounty } from '../fl-dor/counties.ts';
import { flCadastralSourceRecordId, flParcelIdentity } from '../fl-dor/identity.ts';

export type FlParGeometry =
  | { readonly t: number; readonly null: true }
  | {
    readonly t: number;
    readonly np: number;
    readonly nv: number;
    readonly b: readonly [number, number, number, number] | null;
    readonly a: number | null;
    readonly c: readonly [number, number] | null;
    readonly closed: boolean;
  };

export type FlParRecord = {
  readonly countyFips: string;
  readonly dorCode: string;
  readonly parcelId: string;
  readonly normalizedParcel: string;
  readonly matchKey: string;
  /** The polygon's own number in the county GIS; equal to PARCEL_ID wherever measured. */
  readonly parcelNo: string | null;
  readonly geometry: FlParGeometry | null;
  readonly crs: string | null;
  /** Metres per unit of the file's coordinate system, from the .prj. */
  readonly unitMetres: number | null;
  /** The joined sale-echo columns, verbatim (dBASE numerics as exact decimals). */
  readonly echo: Readonly<Record<string, string>>;
  // -- provenance (excluded from change detection)
  readonly fileSha256: string;
  readonly stage: 'PRELIMINARY' | 'FINAL';
  readonly recordNumber: number;
  readonly fileLastModified: string | null;
};

export function parseFlParRow(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): { readonly sourceRecordId: string; readonly record: FlParRecord } {
  const at = `${origin} (record ${String(attributes['__n'] ?? '?')})`;
  if (attributes['__deleted'] === true) fail('PARSE', `${at}: deleted .dbf record`, { reason: 'DELETED_RECORD' });
  const fileCounty = text(attributes, '__c');
  if (fileCounty === null || flCountyByFips(fileCounty) === null) fail('PARSE', `${at}: row carries no release-manifest county`);
  const coNo = text(attributes, 'CO_NO');
  if (coNo === null || coNo === '0') {
    fail('PARSE', `${at}: polygon joined no roll record (CO_NO ${coNo ?? 'blank'})`, { reason: 'UNJOINED_POLYGON' });
  }
  const countyFips = routeFlCounty(coNo, at);
  if (countyFips !== fileCounty) {
    fail('PARSE', `${at}: CO_NO routes to ${countyFips} but the polygon is in ${fileCounty}'s file`, { reason: 'AMBIGUOUS_COUNTY_ROUTING' });
  }
  const identity = flParcelIdentity(countyFips, text(attributes, 'PARCEL_ID'), `${at} in ${countyFips}`);
  const echo: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (/^(M_PAR_SAL|QUAL_CD|VI_CD|SALE_PRC|SALE_YR|SALE_MO|OR_BOOK|OR_PAGE|CLERK_NO|S_CHNG_CD)[12]$/.test(key) && typeof value === 'string') {
      echo[key] = value;
    }
  }
  const county = flCountyByFips(countyFips) as NonNullable<ReturnType<typeof flCountyByFips>>;
  const unit = attributes['__unit'];
  return {
    sourceRecordId: flCadastralSourceRecordId(countyFips, identity.normalizedParcel),
    record: {
      countyFips,
      dorCode: county.dorCode,
      parcelId: identity.rawParcelId,
      normalizedParcel: identity.normalizedParcel,
      matchKey: identity.matchKey,
      parcelNo: text(attributes, 'PARCELNO'),
      geometry: (attributes['__geom'] as FlParGeometry | undefined) ?? null,
      crs: text(attributes, '__crs'),
      unitMetres: typeof unit === 'number' ? unit : null,
      echo,
      fileSha256: text(attributes, '__f') ?? '',
      stage: text(attributes, '__s') === 'F' ? 'FINAL' : 'PRELIMINARY',
      recordNumber: Number(attributes['__n'] ?? 0),
      fileLastModified: text(attributes, '__lm'),
    },
  };
}

/** Identity, geometry and echo; nothing about the file or the record's position in it. */
export function flParContentOf(record: FlParRecord): string {
  const { fileSha256: _f, stage: _s, recordNumber: _n, fileLastModified: _lm, ...stable } = record;
  return JSON.stringify([
    stable.countyFips, stable.parcelId, stable.normalizedParcel, stable.parcelNo, stable.crs, stable.unitMetres,
    stable.geometry, Object.keys(stable.echo).sort().map((k) => [k, stable.echo[k]]),
  ]);
}

function text(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
