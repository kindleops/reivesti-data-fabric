/**
 * County participation in the Minnesota statewide aggregation.
 *
 * Participation is **opt-in and per county**, and the publisher says so in
 * layer 0 of the service (and in the matching table of the bulk GeoPackage):
 * one row per Minnesota county, carrying `gac_open_approval` and the date the
 * state acquired that county's data.
 *
 * The table below is that metadata as of the **2026-08-06** aggregation run —
 * 59 approved of 87 counties. It is the EXPECTED participation, not a permanent
 * truth: counties opt in and out, and `reconcileParticipation()` compares what a
 * delivery actually contains against this list and reports the difference rather
 * than assuming it away. A county that joins should show up as an addition in a
 * run report, not as a silent change in coverage.
 *
 * `acquiredAt` is the freshness that matters. It ranges from **2024-05-20 to
 * 2026-08-06** — over two years — so "the statewide layer" is not uniformly
 * fresh, and a county's own direct feed may be considerably newer. That is the
 * evidence behind the field-authority decisions in `authority.ts`.
 *
 * Generated from the delivered artifact; see docs/MN-STATEWIDE-PARCELS.md.
 */

export type CountyParticipation = {
  readonly fips: string;
  readonly name: string;
  /** When the state acquired this county's data. Null where unstated. */
  readonly acquiredAt: string | null;
  /** Rows this county contributed to the pinned run. A reconciliation denominator. */
  readonly expectedRows: number;
};

/** The aggregation run this table was captured from. */
export const AGGREGATION_RUN_DATE = '2026-08-06';

export const MN_STATEWIDE_PARTICIPATION: readonly CountyParticipation[] = [
  { fips: '27001', name: 'Aitkin', acquiredAt: '2026-04-22', expectedRows: 43024 },
  { fips: '27003', name: 'Anoka', acquiredAt: '2026-08-04', expectedRows: 140221 },
  { fips: '27005', name: 'Becker', acquiredAt: '2026-07-22', expectedRows: 35718 },
  { fips: '27009', name: 'Benton', acquiredAt: '2026-02-17', expectedRows: 20313 },
  { fips: '27011', name: 'Big Stone', acquiredAt: '2026-07-30', expectedRows: 7899 },
  { fips: '27017', name: 'Carlton', acquiredAt: '2026-07-16', expectedRows: 34068 },
  { fips: '27019', name: 'Carver', acquiredAt: '2026-08-04', expectedRows: 47886 },
  { fips: '27021', name: 'Cass', acquiredAt: '2026-07-23', expectedRows: 51689 },
  { fips: '27023', name: 'Chippewa', acquiredAt: '2026-03-23', expectedRows: 11962 },
  { fips: '27025', name: 'Chisago', acquiredAt: '2026-08-06', expectedRows: 29949 },
  { fips: '27027', name: 'Clay', acquiredAt: '2026-08-06', expectedRows: 31368 },
  { fips: '27029', name: 'Clearwater', acquiredAt: '2026-04-15', expectedRows: 9778 },
  { fips: '27031', name: 'Cook', acquiredAt: '2026-02-03', expectedRows: 12695 },
  { fips: '27035', name: 'Crow Wing', acquiredAt: '2026-07-19', expectedRows: 76486 },
  { fips: '27037', name: 'Dakota', acquiredAt: '2026-08-04', expectedRows: 154315 },
  { fips: '27041', name: 'Douglas', acquiredAt: '2026-06-30', expectedRows: 33624 },
  { fips: '27045', name: 'Fillmore', acquiredAt: '2026-07-09', expectedRows: 20917 },
  { fips: '27051', name: 'Grant', acquiredAt: '2026-08-04', expectedRows: 7726 },
  { fips: '27053', name: 'Hennepin', acquiredAt: '2026-08-04', expectedRows: 447044 },
  { fips: '27055', name: 'Houston', acquiredAt: '2026-06-29', expectedRows: 16719 },
  { fips: '27059', name: 'Isanti', acquiredAt: '2026-07-01', expectedRows: 23889 },
  { fips: '27061', name: 'Itasca', acquiredAt: '2026-06-26', expectedRows: 80651 },
  { fips: '27063', name: 'Jackson', acquiredAt: '2026-07-09', expectedRows: 11035 },
  { fips: '27071', name: 'Koochiching', acquiredAt: '2026-01-14', expectedRows: 55291 },
  { fips: '27073', name: 'Lac qui Parle', acquiredAt: '2025-12-10', expectedRows: 8876 },
  { fips: '27075', name: 'Lake', acquiredAt: '2026-04-15', expectedRows: 47116 },
  { fips: '27077', name: 'Lake of the Woods', acquiredAt: '2025-07-15', expectedRows: 8957 },
  { fips: '27083', name: 'Lyon', acquiredAt: '2026-06-30', expectedRows: 16402 },
  { fips: '27085', name: 'McLeod', acquiredAt: '2026-05-19', expectedRows: 20467 },
  { fips: '27089', name: 'Marshall', acquiredAt: '2024-05-20', expectedRows: 15374 },
  { fips: '27095', name: 'Mille Lacs', acquiredAt: '2026-02-24', expectedRows: 20928 },
  { fips: '27097', name: 'Morrison', acquiredAt: '2026-07-09', expectedRows: 30117 },
  { fips: '27099', name: 'Mower', acquiredAt: '2026-07-10', expectedRows: 22956 },
  { fips: '27101', name: 'Murray', acquiredAt: '2026-07-14', expectedRows: 10206 },
  { fips: '27107', name: 'Norman', acquiredAt: '2026-06-16', expectedRows: 9705 },
  { fips: '27109', name: 'Olmsted', acquiredAt: '2026-06-23', expectedRows: 75579 },
  { fips: '27111', name: 'Otter Tail', acquiredAt: '2026-02-25', expectedRows: 67033 },
  { fips: '27113', name: 'Pennington', acquiredAt: '2024-11-12', expectedRows: 10470 },
  { fips: '27117', name: 'Pipestone', acquiredAt: '2026-08-06', expectedRows: 8359 },
  { fips: '27119', name: 'Polk', acquiredAt: '2026-06-16', expectedRows: 28885 },
  { fips: '27121', name: 'Pope', acquiredAt: '2026-06-22', expectedRows: 14006 },
  { fips: '27123', name: 'Ramsey', acquiredAt: '2026-08-04', expectedRows: 172178 },
  { fips: '27125', name: 'Red Lake', acquiredAt: '2025-10-22', expectedRows: 4200 },
  { fips: '27129', name: 'Renville', acquiredAt: '2026-06-09', expectedRows: 16157 },
  { fips: '27131', name: 'Rice', acquiredAt: '2026-04-22', expectedRows: 28166 },
  { fips: '27137', name: 'St. Louis', acquiredAt: '2026-02-05', expectedRows: 186455 },
  { fips: '27139', name: 'Scott', acquiredAt: '2026-08-04', expectedRows: 61696 },
  { fips: '27141', name: 'Sherburne', acquiredAt: '2026-04-08', expectedRows: 44573 },
  { fips: '27145', name: 'Stearns', acquiredAt: '2026-07-15', expectedRows: 73181 },
  { fips: '27147', name: 'Steele', acquiredAt: '2026-04-08', expectedRows: 20207 },
  { fips: '27149', name: 'Stevens', acquiredAt: '2026-02-24', expectedRows: 8146 },
  { fips: '27155', name: 'Traverse', acquiredAt: '2025-06-16', expectedRows: 6229 },
  { fips: '27157', name: 'Wabasha', acquiredAt: '2026-07-23', expectedRows: 17323 },
  { fips: '27161', name: 'Waseca', acquiredAt: '2026-07-07', expectedRows: 12327 },
  { fips: '27163', name: 'Washington', acquiredAt: '2026-08-04', expectedRows: 119096 },
  { fips: '27167', name: 'Wilkin', acquiredAt: '2026-07-20', expectedRows: 8572 },
  { fips: '27169', name: 'Winona', acquiredAt: '2026-07-06', expectedRows: 25538 },
  { fips: '27171', name: 'Wright', acquiredAt: '2026-07-01', expectedRows: 75691 },
  { fips: '27173', name: 'Yellow Medicine', acquiredAt: '2025-11-19', expectedRows: 10763 },
];

/**
 * Counties that had NOT opted in at the pinned run.
 *
 * Recorded because a gap you can name is a gap you can close: these 28 are the
 * difference between 59-county and statewide coverage, and each is a county
 * whose own portal may still publish parcels directly.
 */
export const MN_NOT_PARTICIPATING: readonly string[] = [
  '27007', '27013', '27015', '27033', '27039', '27043', '27047', '27049', '27057', '27065',
  '27067', '27069', '27079', '27081', '27087', '27091', '27093', '27103', '27105', '27115',
  '27127', '27133', '27135', '27143', '27151', '27153', '27159', '27165',
];

export const MN_STATEWIDE_PARTICIPATING_COUNTIES: readonly string[] =
  MN_STATEWIDE_PARTICIPATION.map((c) => c.fips);

const BY_FIPS = new Map(MN_STATEWIDE_PARTICIPATION.map((c) => [c.fips, c] as const));

export function participationOf(fips: string): CountyParticipation | undefined {
  return BY_FIPS.get(fips);
}

export type ParticipationReconciliation = {
  readonly expected: number;
  readonly actual: number;
  /** Counties in the delivery that the pinned table does not list. */
  readonly added: readonly string[];
  /** Counties the pinned table lists that the delivery does not contain. */
  readonly removed: readonly string[];
  /** Counties whose row count moved, with both figures. */
  readonly rowCountChanges: readonly { readonly fips: string; readonly expected: number; readonly actual: number }[];
  readonly matches: boolean;
};

/**
 * Compares a delivery's actual county content against the pinned expectation.
 *
 * Never fails the run on its own: a county opting in is good news, and a county
 * opting out is news the operator has to see rather than a crash. It is reported.
 */
export function reconcileParticipation(
  actualCounts: ReadonlyMap<string, number>,
): ParticipationReconciliation {
  const expectedFips = new Set(MN_STATEWIDE_PARTICIPATING_COUNTIES);
  const actualFips = new Set(actualCounts.keys());

  const added = [...actualFips].filter((f) => !expectedFips.has(f)).sort();
  const removed = [...expectedFips].filter((f) => !actualFips.has(f)).sort();

  const rowCountChanges: { fips: string; expected: number; actual: number }[] = [];
  for (const county of MN_STATEWIDE_PARTICIPATION) {
    const actual = actualCounts.get(county.fips);
    if (actual === undefined || actual === county.expectedRows) continue;
    rowCountChanges.push({ fips: county.fips, expected: county.expectedRows, actual });
  }

  return {
    expected: expectedFips.size,
    actual: actualFips.size,
    added,
    removed,
    rowCountChanges: rowCountChanges.sort((a, b) => a.fips.localeCompare(b.fips)),
    matches: added.length === 0 && removed.length === 0,
  };
}
