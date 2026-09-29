/**
 * The automated-acquisition gate (DF-0J.1A).
 *
 * The doctrine these tests hold in place: **a human is not an acquisition
 * mechanism.** A source that can only be obtained by a person opening a browser
 * is not a production source, however free, however lawful, however good the
 * data — and it may not count toward core coverage.
 *
 * This gate exists because of a specific failure. Wisconsin RETR is free, public
 * domain, and its terms permit anything; DF-0J duly marked it CORE_CANONICAL and
 * the coverage report announced transfer coverage for all 72 Wisconsin counties.
 * No byte of it had ever been fetched, and none could be: the file lives behind
 * a fifteen-minute session in a tax portal. The registry was not lying about any
 * single field. It was drawing a conclusion from four true facts — free, public,
 * permitted, parsed — none of which is "reachable".
 *
 * The distinction every test below turns on is PERMISSION versus MECHANISM.
 * `automationStatus` answers "may we?"; `acquisitionClass` answers "is there
 * anything to automate?". Both must pass, and neither implies the other.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAPPINGS, SOURCES, WI_RETR_SOURCE_ID, defaultRegistry } from '../src/registry/sources.ts';
import { assessActivation, isCoreActivatable } from '../src/registry/policy.ts';
import {
  AUTOMATED_ACQUISITION_CLASSES,
  isAutomatedAcquisition,
  type AcquisitionClass,
  type SourceDefinition,
} from '../src/registry/types.ts';
import { buildCoverage, nationalCoverageReport } from '../src/registry/coverage.ts';

const AT = '2026-09-19';

/** A source that passes every gate except the one under test. */
function source(over: Partial<SourceDefinition> = {}): SourceDefinition {
  return {
    sourceId: 'probe', sourceAuthority: 'A', sourceProgram: 'P', sourceFamily: 'F',
    sourceName: 'N', sourceHomepage: 'https://example.gov', accessType: 'api',
    automationStatus: 'sanctioned', termsStatus: 'reviewed_permitted', licenseStatus: 'public_domain',
    costModel: 'free', historicalDepth: null, expectedRefreshFrequency: 'monthly',
    sourcePriority: 1, active: true, carriesRestrictedContact: false,
    costClass: 'FREE_BULK', acquisitionClass: 'AUTOMATED_BULK_DOWNLOAD',
    role: 'CORE_CANONICAL_SOURCE', notes: '',
    ...over,
  };
}

const FULL = { schemaPinned: true, provenanceReproducible: true } as const;

// 1 ------------------------------------------------------------------------
test('a free, lawful, schema-pinned source is still refused when only a human can fetch it', () => {
  const a = assessActivation(source({ acquisitionClass: 'MANUAL_ONLY' }), FULL);
  assert.equal(a.verdict, 'BLOCKED_MANUAL_ACQUISITION');
  assert.equal(a.gate, 'acquisition');
  assert.equal(a.zeroCost, true, 'it really is free; that was never the problem');
  assert.equal(isCoreActivatable(source({ acquisitionClass: 'MANUAL_ONLY' }), FULL), false);
});

// 2 ------------------------------------------------------------------------
test('an unestablished acquisition path is ineligible, never assumed automated', () => {
  // Same posture as costClass: silence is not a yes. A row that simply omits the
  // field must not inherit eligibility from the rows around it.
  const omitted = source();
  const { acquisitionClass: _drop, ...withoutField } = omitted;
  const a = assessActivation(withoutField as SourceDefinition, FULL);
  assert.equal(a.verdict, 'BLOCKED_MANUAL_ACQUISITION');
  assert.equal(a.acquisitionClass, 'UNKNOWN_AUTOMATION');
  assert.match(a.reason, /unknown is not automated/);
});

// 3 ------------------------------------------------------------------------
test('prohibited automation reports a permission failure, not a mechanism failure', () => {
  // The two blocked verdicts must stay distinguishable: one clears by finding a
  // different distribution, the other only by the publisher changing its terms.
  const a = assessActivation(source({ acquisitionClass: 'PROHIBITED_AUTOMATION' }), FULL);
  assert.equal(a.verdict, 'BLOCKED_AUTOMATION');
  assert.notEqual(a.verdict, 'BLOCKED_MANUAL_ACQUISITION');
});

// 4 ------------------------------------------------------------------------
test('every automated class passes the gate, and only those classes do', () => {
  const all: AcquisitionClass[] = [
    'AUTOMATED_API', 'AUTOMATED_BULK_DOWNLOAD', 'AUTOMATED_OPEN_DATA',
    'AUTOMATED_PUBLIC_HTTP', 'AUTOMATED_BROWSER_ALLOWED',
    'MANUAL_ONLY', 'PROHIBITED_AUTOMATION', 'UNKNOWN_AUTOMATION',
  ];
  for (const acquisitionClass of all) {
    const eligible = assessActivation(source({ acquisitionClass }), FULL).verdict === 'CORE_ELIGIBLE';
    assert.equal(eligible, isAutomatedAcquisition(acquisitionClass), acquisitionClass);
  }
  assert.equal(AUTOMATED_ACQUISITION_CLASSES.size, 5);
});

// 5 ------------------------------------------------------------------------
test('a manual-delivery source cannot be laundered into core by relabelling it', () => {
  // FREE_MANUAL_DELIVERY states in the COST field that a person receives the
  // file. Declaring an automated acquisition class alongside it is a
  // contradiction, and the gate resolves it against the optimistic field.
  const a = assessActivation(source({
    costClass: 'FREE_MANUAL_DELIVERY',
    acquisitionClass: 'AUTOMATED_API',
  }), FULL);
  assert.equal(a.verdict, 'BLOCKED_MANUAL_ACQUISITION');
});

// 6 ------------------------------------------------------------------------
test('permission to automate is not a mechanism for automating', () => {
  // The precise confusion that produced the Wisconsin error. `sanctioned` says
  // the publisher does not mind; it says nothing about there being a URL.
  const a = assessActivation(source({
    automationStatus: 'sanctioned',
    acquisitionClass: 'MANUAL_ONLY',
  }), FULL);
  assert.equal(a.verdict, 'BLOCKED_MANUAL_ACQUISITION');
});

// 7 ------------------------------------------------------------------------
test('no manually-acquired source contributes to national core coverage', () => {
  const registry = defaultRegistry();
  const report = nationalCoverageReport(registry, buildCoverage(registry), AT);
  for (const s of SOURCES) {
    if (isAutomatedAcquisition(s.acquisitionClass ?? 'UNKNOWN_AUTOMATION')) continue;
    assert.equal(isCoreActivatable(s, FULL), false, `${s.sourceId} is not automatically acquirable`);
  }
  // Minnesota's 59 parcel counties plus Wisconsin's 72 (DF-0K, a statewide
  // parcel map a scheduler retrieves unattended), and transfer coverage is
  // still zero nationally. Both statewide transfer sources are parsed and
  // neither is reachable — the gap the next phase has to close.
  assert.equal(report.jurisdictionsWithCoreSource, 131);
  assert.equal(report.byCapability.find((c) => c.capability === 'transfer')?.covered, 0);
});

// 8 ------------------------------------------------------------------------
test('Wisconsin RETR is dormant, and the registry says why in so many words', () => {
  const retr = SOURCES.find((s) => s.sourceId === WI_RETR_SOURCE_ID);
  assert.ok(retr, 'the connector stays in the tree; only its activation is withdrawn');
  assert.equal(retr.acquisitionClass, 'MANUAL_ONLY');
  assert.equal(retr.role, 'DEFERRED');
  assert.equal(isCoreActivatable(retr, FULL), false);
  // The verdict has to carry the reason. "Postponed" and "postponed because a
  // person must fetch it by hand" send a reader to two different places.
  assert.match(assessActivation(retr, FULL).reason, /MANUAL_ONLY/);
  // It is still free and its terms are still fine. Nothing about the data changed.
  assert.equal(retr.costClass, 'FREE_PUBLIC_DOWNLOAD');
  assert.equal(retr.licenseStatus, 'public_domain');
  // The mapping stays so the 72 counties remain visible as a known gap rather
  // than vanishing from the matrix as if Wisconsin had never been looked at.
  assert.equal(MAPPINGS.filter((m) => m.sourceId === WI_RETR_SOURCE_ID).length, 1);
});
