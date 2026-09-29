/**
 * One derived NAL row → a typed record.
 *
 * Refuses, and never repairs:
 *
 *  - a row the deriver marked malformed (wrong cell count);
 *  - a CO_NO that is not one of the Department's 67 county numbers;
 *  - a CO_NO that routes to a different county than the file it arrived in —
 *    the statewide audit found none, and a row that did would make routing
 *    ambiguous, so it is quarantined rather than placed by guesswork;
 *  - a PARCEL_ID that is blank or has no letter or digit in it.
 *
 * Values stay exactly as published (trimmed text). Interpretation — money,
 * dates, codes, what is restricted — happens in `normalize.ts`.
 */
import { fail } from '../../core/errors.ts';
import { flCountyByFips, routeFlCounty } from '../fl-dor/counties.ts';
import { flNalSourceRecordId, flParcelIdentity } from '../fl-dor/identity.ts';
import { FL_NAL_FIELD_MAP } from './field-map.ts';

export type FlNalRecord = {
  readonly countyFips: string;
  readonly dorCode: string;
  readonly countyName: string;
  readonly parcelId: string;
  readonly normalizedParcel: string;
  /** Punctuation-folded, for candidate matching only. Never identity. */
  readonly matchKey: string;
  // -- provenance (excluded from change detection)
  readonly fileSha256: string;
  readonly stage: 'PRELIMINARY' | 'FINAL';
  readonly rowNumber: number;
  readonly fileLastModified: string | null;
  /** Every publisher field the row carried, verbatim and trimmed. Blank fields are absent. */
  readonly fields: Readonly<Record<string, string>>;
};

export function parseFlNalRow(
  attributes: Readonly<Record<string, unknown>>,
  origin: string,
): { readonly sourceRecordId: string; readonly record: FlNalRecord } {
  if (attributes['__malformed'] !== undefined) {
    fail('PARSE', `${origin}: malformed CSV record — ${String(attributes['__malformed'])}`);
  }
  const fileCounty = text(attributes, '__c');
  if (fileCounty === null || flCountyByFips(fileCounty) === null) {
    fail('PARSE', `${origin}: row carries no release-manifest county`);
  }
  const countyFips = routeFlCounty(text(attributes, 'CO_NO'), origin);
  if (countyFips !== fileCounty) {
    fail('PARSE', `${origin}: CO_NO routes to ${countyFips} but the row arrived in ${fileCounty}'s file`, {
      reason: 'AMBIGUOUS_COUNTY_ROUTING',
    });
  }
  const county = flCountyByFips(countyFips) as NonNullable<ReturnType<typeof flCountyByFips>>;
  const identity = flParcelIdentity(countyFips, text(attributes, 'PARCEL_ID'), `${origin} in ${countyFips}`);

  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith('__') || value === null || value === undefined) continue;
    const v = String(value).trim();
    if (v !== '') fields[key] = v;
  }

  const record: FlNalRecord = {
    countyFips,
    dorCode: county.dorCode,
    countyName: county.dorName,
    parcelId: identity.rawParcelId,
    normalizedParcel: identity.normalizedParcel,
    matchKey: identity.matchKey,
    fileSha256: text(attributes, '__f') ?? '',
    stage: text(attributes, '__s') === 'F' ? 'FINAL' : 'PRELIMINARY',
    rowNumber: Number(attributes['__n'] ?? 0),
    fileLastModified: text(attributes, '__lm'),
    fields,
  };
  return { sourceRecordId: flNalSourceRecordId(countyFips, identity.normalizedParcel), record };
}

/**
 * What change detection digests: the publisher's facts about the parcel, and
 * nothing about the file they arrived in. SEQ_NO — the row's position in the
 * submission — is renumbered by every file and would make every parcel read as
 * revised on every release.
 */
export function flNalContentOf(record: FlNalRecord): string {
  // A string in the field map's fixed order rather than an object: the runtime
  // canonicalizes whatever this returns, and eleven million key sorts of a
  // 167-key object were a measurable share of a statewide run. The order is
  // pinned by the field map, so the string is as canonical as the sort was.
  return JSON.stringify([
    record.countyFips, record.parcelId, record.normalizedParcel,
    CONTENT_FIELDS.map((name) => record.fields[name] ?? null),
    // A field the pinned layouts do not know cannot reach here — the drift
    // check quarantines the run first — so nothing is silently left out.
  ]);
}

const CONTENT_FIELDS: readonly string[] = FL_NAL_FIELD_MAP.map((f) => f.field).filter((f) => f !== 'SEQ_NO');

function text(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
