/**
 * One derived SDF row → a typed sale record.
 *
 * Refuses, never repairs: a malformed row; a CO_NO outside the Department's
 * table or routing to a county other than the file's; a blank PARCEL_ID; a
 * blank SALE_ID_CD — a sale without the appraiser's identifier cannot be told
 * apart from the parcel's other sales, and inventing a key for it would make
 * the next release's statement of the same sale look like a different one.
 */
import { fail } from '../../core/errors.ts';
import { flCountyByFips, routeFlCounty } from '../fl-dor/counties.ts';
import { flParcelIdentity, flSdfSourceRecordId } from '../fl-dor/identity.ts';
import { FL_SDF_LAYOUT_2026 } from './field-map.ts';

export type FlSdfRecord = {
  readonly countyFips: string;
  readonly dorCode: string;
  readonly parcelId: string;
  readonly normalizedParcel: string;
  readonly matchKey: string;
  /** The appraiser's sale identifier, verbatim and trimmed. */
  readonly saleId: string;
  // -- provenance (excluded from change detection)
  readonly fileSha256: string;
  readonly stage: 'PRELIMINARY' | 'FINAL';
  readonly rowNumber: number;
  readonly fileLastModified: string | null;
  readonly fields: Readonly<Record<string, string>>;
};

export function parseFlSdfRow(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): { readonly sourceRecordId: string; readonly record: FlSdfRecord } {
  if (attributes['__malformed'] !== undefined) {
    fail('PARSE', `${origin}: malformed CSV record — ${String(attributes['__malformed'])}`);
  }
  const fileCounty = text(attributes, '__c');
  if (fileCounty === null || flCountyByFips(fileCounty) === null) fail('PARSE', `${origin}: row carries no release-manifest county`);
  const countyFips = routeFlCounty(text(attributes, 'CO_NO'), origin);
  if (countyFips !== fileCounty) {
    fail('PARSE', `${origin}: CO_NO routes to ${countyFips} but the row arrived in ${fileCounty}'s file`, { reason: 'AMBIGUOUS_COUNTY_ROUTING' });
  }
  const identity = flParcelIdentity(countyFips, text(attributes, 'PARCEL_ID'), `${origin} in ${countyFips}`);
  const saleId = text(attributes, 'SALE_ID_CD');
  if (saleId === null) fail('PARSE', `${origin}: sale row has no SALE_ID_CD`, { reason: 'SALE_ID_ABSENT' });

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('__') || value === null || value === undefined) continue;
    const v = String(value).trim();
    if (v !== '') fields[key] = v;
  }
  const county = flCountyByFips(countyFips) as NonNullable<ReturnType<typeof flCountyByFips>>;
  return {
    sourceRecordId: flSdfSourceRecordId(countyFips, identity.normalizedParcel, saleId),
    record: {
      countyFips,
      dorCode: county.dorCode,
      parcelId: identity.rawParcelId,
      normalizedParcel: identity.normalizedParcel,
      matchKey: identity.matchKey,
      saleId,
      fileSha256: text(attributes, '__f') ?? '',
      stage: text(attributes, '__s') === 'F' ? 'FINAL' : 'PRELIMINARY',
      rowNumber: Number(attributes['__n'] ?? 0),
      fileLastModified: text(attributes, '__lm'),
      fields,
    },
  };
}

/** Publisher facts in the pinned column order; nothing about the file the row came in. */
export function flSdfContentOf(record: FlSdfRecord): string {
  return JSON.stringify([
    record.countyFips, record.parcelId, record.normalizedParcel, record.saleId,
    FL_SDF_LAYOUT_2026.map((name) => record.fields[name] ?? null),
  ]);
}

function text(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
