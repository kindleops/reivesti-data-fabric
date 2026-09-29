/**
 * The restricted-field leakage audit, run over every NAL row as it streams.
 *
 * Two checks, because each catches what the other cannot:
 *
 *  1. **Value check, every row.** Every restricted TEXT value the row carries —
 *     mailing lines, the care-of block, the previous homestead's parcel — must
 *     not appear anywhere in the row's canonical bundle, unless a public column
 *     of the same row states the same text (an owner-occupied home's mailing
 *     line IS its situs line, and the situs is public). Values shorter than six
 *     characters are not searched: "FL" or "1" would match everything.
 *
 *  2. **Sentinel check, a deterministic sample.** The row is normalized again
 *     with EVERY restricted field — text and numeric, the personal exemptions
 *     included — replaced by a unique sentinel, and the bundle is searched for
 *     any sentinel. A hit means some code path copies a restricted field at
 *     all, whatever its value. The sample is every row whose file row number is
 *     a multiple of `sentinelEvery`; `1` checks every row.
 *
 * Contacts are counted by type: the restricted plane is where the mailing and
 * care-of blocks are supposed to go, and a zero there would be its own defect.
 */
import type { NormalizeResult, ParsedRecord } from '../../runtime/connector.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import { FL_NAL_FIELD_MAP, FL_NAL_RESTRICTED_FIELDS } from './field-map.ts';
import type { FlNalRecord } from './parse.ts';
import { normalizeFlNalRecord } from './normalize.ts';
import { readFlUseCode } from '../fl-dor/use-codes.ts';

const TEXT_TYPES = new Set(['String']);
const RESTRICTED_TEXT: readonly string[] = FL_NAL_FIELD_MAP
  .filter((f) => f.disposition === 'RESTRICTED' && TEXT_TYPES.has(f.sourceType))
  .map((f) => f.field);
const PUBLIC_FIELDS: readonly string[] = FL_NAL_FIELD_MAP.filter((f) => f.disposition !== 'RESTRICTED').map((f) => f.field);
const MIN_SEARCH_LENGTH = 6;

/** Every string value in a structure, keys excluded. */
function stringValuesOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValuesOf(v, out);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) stringValuesOf(v, out);
  return out;
}

/** Upper case, every run of non-alphanumerics one space. */
function fold(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

export type FlLeakageReport = {
  readonly rowsInspected: number;
  readonly restrictedValuesSearched: number;
  readonly valueLeaks: Readonly<Record<string, number>>;
  readonly sentinelRowsChecked: number;
  readonly sentinelLeaks: Readonly<Record<string, number>>;
  readonly contactsByType: Readonly<Record<string, number>>;
  readonly rowsWithRestrictedFields: number;
  readonly restrictedFieldsPopulated: Readonly<Record<string, number>>;
};

export function createFlNalLeakageAudit(options: { readonly sentinelEvery: number; readonly sourceId: string }) {
  let rowsInspected = 0;
  let searched = 0;
  let sentinelRows = 0;
  let rowsWithRestricted = 0;
  const valueLeaks: Record<string, number> = {};
  const sentinelLeaks: Record<string, number> = {};
  const contactsByType: Record<string, number> = {};
  const populated: Record<string, number> = {};

  return {
    inspect(parsed: ParsedRecord, result: NormalizeResult): void {
      const record = parsed.record as unknown as FlNalRecord;
      if (record.fields === undefined) return;
      rowsInspected += 1;
      for (const c of result.contacts) contactsByType[c.contactType] = (contactsByType[c.contactType] ?? 0) + 1;
      let any = false;
      for (const field of FL_NAL_RESTRICTED_FIELDS) {
        if (record.fields[field] !== undefined) { populated[field] = (populated[field] ?? 0) + 1; any = true; }
      }
      if (any) rowsWithRestricted += 1;

      // Compared FOLDED — case, punctuation and spacing ignored on both sides —
      // because the bundle carries the situs as a folded comparison key: an
      // owner-occupied home's "123 MAIN ST." mailing line then matches its own
      // public situs key, which is not a leak.
      // Per string VALUE, never the serialized whole: folding a whole document
      // glues neighbouring keys and values into phrases nobody wrote.
      let values: string[] | null = null;
      const bundleValues = (): string[] => (values ??= stringValuesOf(result.bundle).map(fold));
      let publicTexts: string[] | null = null;
      for (const field of RESTRICTED_TEXT) {
        const raw = record.fields[field];
        if (raw === undefined) continue;
        const value = fold(raw);
        if (value.length < MIN_SEARCH_LENGTH) continue;
        searched += 1;
        if (!bundleValues().some((v) => v.includes(value))) continue;
        publicTexts ??= [
          ...PUBLIC_FIELDS.map((p) => record.fields[p]).filter((x): x is string => x !== undefined).map(fold),
          // The use-code table's own wording is public vocabulary, not row data.
          fold(readFlUseCode(record.fields['DOR_UC']).known?.name ?? ''),
        ];
        if (!publicTexts.some((t) => t.includes(value))) valueLeaks[field] = (valueLeaks[field] ?? 0) + 1;
      }

      if (options.sentinelEvery > 0 && record.rowNumber % options.sentinelEvery === 0) {
        sentinelRows += 1;
        const fields: Record<string, string> = { ...record.fields };
        for (const field of FL_NAL_RESTRICTED_FIELDS) fields[field] = `ZZSENTINEL${field}ZZ`;
        const evidence = result.bundle.transaction.evidence as SourceEvidence;
        const probe = normalizeFlNalRecord({ ...record, fields }, evidence, {
          sourceId: options.sourceId, snapshotId: 'sentinel', changeKind: 'unchanged_parcel', changedFieldGroups: [],
        }, parsed.contentDigest);
        const probeJson = JSON.stringify(probe.bundle);
        for (const field of FL_NAL_RESTRICTED_FIELDS) {
          if (probeJson.includes(`ZZSENTINEL${field}ZZ`)) sentinelLeaks[field] = (sentinelLeaks[field] ?? 0) + 1;
        }
      }
    },
    report(): FlLeakageReport {
      return {
        rowsInspected, restrictedValuesSearched: searched, valueLeaks: { ...valueLeaks },
        sentinelRowsChecked: sentinelRows, sentinelLeaks: { ...sentinelLeaks }, contactsByType: { ...contactsByType },
        rowsWithRestrictedFields: rowsWithRestricted, restrictedFieldsPopulated: { ...populated },
      };
    },
  };
}
