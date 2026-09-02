/**
 * Overlap reconciliation: what the normalization contract actually fixed.
 *
 * DF-0H compared Hennepin's own parcel service against the state aggregation and
 * reported four fields in total disagreement over 443,605 parcels. Three of the
 * four were our own representation choices. These tests run the same audit twice
 * over the same rows — once in `'literal'` mode, which is exactly what DF-0H did,
 * and once in `'canonical'` mode — and assert the difference.
 *
 * The tests that matter most here are the ones asserting that conflicts SURVIVE.
 * A normalization pass can always reach 100% agreement by comparing less; the
 * only evidence that it did not is a real disagreement it still reports.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  auditOverlap,
  comparablesFrom,
  overlapMigrationReport,
  CANONICAL_COMPARED_FIELDS,
  COMPARED_FIELDS,
  type OverlapAudit,
} from '../src/canonical/overlap-audit.ts';
import { MN_STATEWIDE_SOURCE_ID } from '../src/connectors/mn-statewide-parcels/index.ts';
import { hennepinFixture, mnStatewideFixture, streamHarness } from './helpers.ts';

const DIRECT = 'mn_hennepin_county_parcels';
const HENNEPIN = '27053';
const AGREES = '0202824410097';
const DISAGREES = '0202824410098';

/** Both connectors over the paired representation fixtures, audited both ways. */
async function auditBothWays(): Promise<{ before: OverlapAudit; after: OverlapAudit }> {
  const harness = streamHarness();
  await harness.run(hennepinFixture('v2-overlap-representation.ndjson'), { period: '2026-08-repr' });
  await harness.runStatewide(mnStatewideFixture('hennepin-overlap-representation.bundle'), { period: '2026-08-repr' });

  const options = {
    directSourceId: DIRECT,
    aggregationSourceId: MN_STATEWIDE_SOURCE_ID,
    decidedAt: '2026-08-31T12:00:00.000Z',
    countyFips: HENNEPIN,
    sort: { chunkLines: 8 },
  };
  return {
    before: await auditOverlap(() => comparablesFrom(harness.store.readTable('bundles')), { ...options, mode: 'literal' as const }),
    after: await auditOverlap(() => comparablesFrom(harness.store.readTable('bundles')), { ...options, mode: 'canonical' as const }),
  };
}

const field = (audit: OverlapAudit, name: string) => {
  const found = audit.agreements.find((a) => a.field === name);
  assert.ok(found !== undefined, `${name} was not audited`);
  return found;
};

// ===========================================================================
// Both sources are still there
// ===========================================================================

test('the two sources describe the same two properties', async () => {
  const { before, after } = await auditBothWays();
  assert.equal(before.overlapping, 2);
  assert.equal(after.overlapping, 2);
  assert.equal(before.onlyDirect, 0);
  assert.equal(before.onlyAggregation, 0);
});

test('both sources declare the same normalization contract version', async () => {
  const { after } = await auditBothWays();
  const versions = Object.values(after.contractVersions);
  assert.equal(versions.length, 2, 'both sources should stamp a contract version');
  assert.equal(new Set(versions).size, 1, 'a cross-version audit compares two different questions');
});

// ===========================================================================
// Before: the DF-0H result, reproduced
// ===========================================================================

test('literal comparison still reports the representation differences as conflicts', async () => {
  const { before } = await auditBothWays();
  // This is the DF-0H behaviour, kept deliberately. If it ever silently
  // "improved", the before/after report would be measuring nothing.
  assert.equal(field(before, 'parcel_area').conflict, 2, 'square feet against acres');
  assert.equal(field(before, 'situs_address').conflict, 2, 'packed street against split components');
  assert.equal(field(before, 'assessor_sale_date').conflict, 2, 'YYYYMM against a padded day');
  assert.equal(field(before, 'tax_total').conflict, 2, 'cents against an integer column');
});

// ===========================================================================
// After: what the contract explains, and what it does not
// ===========================================================================

test('area agrees where it is the same parcel and disagrees where it is not', async () => {
  const { after } = await auditBothWays();
  const area = field(after, 'canonical_parcel_area');
  assert.equal(area.bothPopulated, 2);
  // 79902.43 sq ft against 1.83 acres: the same parcel, within MnGeo's rounding.
  assert.equal(area.equivalentMatch, 1);
  // 5,000 sq ft against 2 acres: not a rounding artifact.
  assert.equal(area.conflict, 1);
});

test('the padded sale day agrees at the precision the source states', async () => {
  const { after } = await auditBothWays();
  const date = field(after, 'canonical_sale_date');
  // '201412' against 2014-12-01, where MnGeo's day is padding: EQUAL, because
  // both resolve to the same month and neither claims more.
  assert.equal(date.exactMatch + date.equivalentMatch, 1);
  // 202401 against 2023-11: a different month.
  assert.equal(date.conflict, 1);
});

test('the integer tax column agrees at whole dollars and is not called exact', async () => {
  const { after } = await auditBothWays();
  const tax = field(after, 'canonical_tax_total');
  // 109672.88 against 109673.
  assert.equal(tax.equivalentMatch, 1);
  assert.equal(tax.exactMatch, 0, 'the 88 cents are a real, if small, loss and the report should say so');
  assert.equal(tax.conflict, 1);
});

test('the packed street matches the split components', async () => {
  const { after } = await auditBothWays();
  const address = field(after, 'canonical_address');
  // '2901 78TH ST E' against anumber=2901 / 78th / Street / East.
  assert.equal(address.exactMatch, 1);
  // 14 CEDAR LAKE RD S unit 101 against unit 102. Two homes on one street, and
  // the audit is required to keep them apart.
  assert.equal(address.conflict, 1);
});

// ===========================================================================
// The report
// ===========================================================================

test('the migration report attributes each explained conflict to a cause', async () => {
  const { before, after } = await auditBothWays();
  const report = overlapMigrationReport(before, after);

  assert.equal(report.overlapping, 2);
  assert.equal(report.fields.length, CANONICAL_COMPARED_FIELDS.length);

  for (const migration of report.fields) {
    assert.notEqual(migration.cause, 'not characterised', `${migration.canonicalField} has no stated cause`);
    assert.ok(
      migration.canonicalAgreementRate >= migration.literalAgreementRate,
      `${migration.canonicalField} agreed less after normalization, which needs explaining before it is shipped`,
    );
  }

  const area = report.fields.find((f) => f.canonicalField === 'canonical_parcel_area');
  assert.equal(area?.literalConflicts, 2);
  assert.equal(area?.remainingConflicts, 1);
  assert.equal(area?.explainedByNormalization, 1);
  assert.match(area?.cause ?? '', /acres/);
});

test('the report names the fields normalization did not touch', async () => {
  const { before, after } = await auditBothWays();
  const report = overlapMigrationReport(before, after);
  // Owner and taxpayer names are compared as strings and stay that way. A fuzzy
  // name comparator would raise the number and lower its meaning.
  assert.ok(report.unchangedFields.includes('owner_name'));
  assert.ok(report.unchangedFields.includes('taxpayer_name'));
  assert.ok(report.unchangedFields.includes('normalized_parcel'));
  assert.equal(
    report.unchangedFields.length + report.fields.length,
    COMPARED_FIELDS.length,
    'every literal field is either superseded or listed as untouched',
  );
});

test('a canonical audit does not also report the field it superseded', async () => {
  const { after } = await auditBothWays();
  // Publishing `parcel_area: 0%` beside `canonical_parcel_area: 50%` invites
  // somebody to quote the wrong one in a decision.
  assert.equal(after.agreements.find((a) => a.field === 'parcel_area'), undefined);
  assert.ok(after.agreements.some((a) => a.field === 'canonical_parcel_area'));
});

test('a report across different populations is refused, not averaged', async () => {
  const { before, after } = await auditBothWays();
  assert.throws(
    () => overlapMigrationReport(before, { ...after, overlapping: after.overlapping + 1 }),
    /different populations/,
  );
  assert.throws(() => overlapMigrationReport(after, after), /literal audit against a canonical audit/);
});

// ===========================================================================
// Authority decisions after the re-audit
// ===========================================================================

test('a field that only agrees after normalization is coequal, and says why', async () => {
  const { after } = await auditBothWays();
  // Both parcels' areas would have to agree for a coequal verdict; with one real
  // conflict out of two the honest verdict is not agreement.
  const decision = after.decisions.find((d) => d.field === 'canonical_parcel_area');
  assert.ok(decision !== undefined);
  assert.ok(
    decision.verdict === 'SEMANTICALLY_DIFFERENT' || decision.verdict === 'UNRESOLVED',
    `a 50% agreement rate must not produce a preference; got ${decision.verdict}`,
  );
});

test('normalization changes the verdict only by changing the measurement', async () => {
  const { before, after } = await auditBothWays();
  const literal = before.decisions.find((d) => d.field === 'situs_address');
  const canonical = after.decisions.find((d) => d.field === 'canonical_address');
  // Literally, the addresses agreed on nothing: SEMANTICALLY_DIFFERENT.
  assert.equal(literal?.verdict, 'SEMANTICALLY_DIFFERENT');
  // Canonically they agree on one of two, which is not enough for a preference
  // either — but it is a different, and true, statement.
  assert.notEqual(canonical?.basis, literal?.basis);
});
