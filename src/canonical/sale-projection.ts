/**
 * TRANSACTION_RESOLUTION for sale observations: many statements of a sale,
 * one canonical sale.
 *
 * Florida states most sales two or three times. The Sale Data File has a row
 * for every transfer the appraiser recorded; the NAL roll echoes up to two of
 * them onto the parcel record ("the Department merges selected SDF fields with
 * the submitted NAL"); the cadastral PAR files carry the same echo again,
 * joined from the roll. Read naively that is three sales. It is one, and this
 * fold is what makes it one.
 *
 * ## The rule
 *
 * Per county partition, per property:
 *
 *  1. Every sale-data row is a sale, identified by the publisher's own sale
 *     identifier within the parcel. Re-stated by a later release, it is the
 *     same sale; if the later statement differs, the newest one governs and the
 *     revision is recorded, never overwritten away.
 *  2. An echo SUPPORTS a sale when its month and price are equal and its
 *     recording reference is equal or absent on either side. Exactly one sale
 *     may match; two equally good matches are ambiguous and the echo supports
 *     neither, loudly.
 *  3. An echo whose month and recording reference match exactly one sale but
 *     whose price does not is attached to that sale as DISCREPANT evidence and
 *     reported. It is the same instrument; it does not become a second sale.
 *  4. Echoes that match no sale-data row converge among themselves on
 *     (month, price, reference) and become ECHO_ONLY sales: the roll says a
 *     sale happened that the current sale-data file does not list.
 *
 * ## Why the fold is pure
 *
 * Every field of every output row — ids, timestamps included — is computed
 * from the partition's contributions and nothing else. No run id, no clock.
 * So the projection is identical whatever order its evidence arrived in, which
 * is what "ingest-order invariance" means and what the tests assert: the sale
 * file first, the roll first, or the map first all produce the same bytes.
 */
import { externalSort, groupSorted, type SortOptions } from '../core/external-sort.ts';
import { canonicalJson, deterministicId } from '../core/hash.ts';
import type { SaleObservation, SaleObservationKind } from './models.ts';

/** Version of this fold. Recorded in every TRANSACTION_RESOLUTION manifest. */
export const SALE_RESOLVER_VERSION = 'sale_observation_resolver_1';

/**
 * One sale observation, flattened to what the fold needs. Short keys, as for
 * property contributions: there is one of these per sale per run.
 *
 * `d: 'T'` marks the domain, so a run's single contribution stream can carry
 * property and sale rows and still be split by county AND domain.
 */
export type SaleContribution = {
  readonly d: 'T';
  /** countyFips */ readonly c: string;
  /** propertyId */ readonly p: string;
  /** normalizedParcel */ readonly n: string;
  /** kind */ readonly k: SaleObservationKind;
  /** semanticClass */ readonly sc: string;
  /** observationId */ readonly o: string;
  /** sourceId */ readonly s: string;
  /** sourceRecordId */ readonly r: string;
  /** publisher sale id */ readonly i: string | null;
  /** sale month YYYY-MM */ readonly ym: string | null;
  /** price, exact minor units */ readonly pr: string | null;
  /** price absence reason */ readonly pa: string | null;
  /** price kind */ readonly pk: string;
  /** qualification code, verbatim */ readonly q: string | null;
  /** vacant/improved code */ readonly vi: string | null;
  /** recording reference */ readonly ref: string | null;
  /** multi-parcel code */ readonly mp: string | null;
  /** observedAt */ readonly t: string;
};

export function saleContributionOf(sale: SaleObservation): SaleContribution {
  return {
    d: 'T',
    c: sale.countyFips,
    p: sale.propertyId,
    n: sale.normalizedParcel,
    k: sale.kind,
    sc: sale.semanticClass,
    o: sale.observationId,
    s: sale.evidence.sourceId,
    r: sale.evidence.sourceRecordId,
    i: sale.publisherSaleId,
    ym: sale.saleMonth,
    pr: sale.priceMinor,
    pa: sale.priceAbsentReason,
    pk: sale.priceKind,
    q: sale.qualificationCode,
    vi: sale.vacantImprovedCode,
    ref: sale.recordingReference,
    mp: sale.multiParcelCode,
    t: sale.evidence.observedAt,
  };
}

/** True for a contribution line of the transaction domain. Textual, like every sort key here. */
export function isSaleContributionLine(line: string): boolean {
  return line.includes('"d":"T"');
}

export type SaleResolutionState =
  /** A sale-data row, supported by at least one echo that matches it exactly. */
  | 'SUPPORTED_MATCH'
  /** A sale-data row that no echo repeats. The normal case for most sales. */
  | 'SALE_OBSERVATION_ONLY'
  /** Echoes of a sale the current sale-data file does not list. */
  | 'ECHO_ONLY';

export type SaleResolution = {
  readonly saleId: string;
  readonly countyFips: string;
  readonly propertyId: string;
  readonly normalizedParcel: string;
  readonly state: SaleResolutionState;
  /** Semantic class of the governing statement. */
  readonly semanticClass: string;
  readonly publisherSaleId: string | null;
  readonly saleMonth: string | null;
  readonly priceMinor: string | null;
  readonly priceAbsentReason: string | null;
  readonly priceKind: string;
  readonly qualificationCode: string | null;
  readonly vacantImprovedCode: string | null;
  readonly recordingReference: string | null;
  readonly multiParcelCode: string | null;
  /**
   * Shared by every sale that names the same recorded instrument in a
   * multi-parcel transfer. Computed from the row's own county and reference, so
   * no pass over other parcels is needed and none can disagree.
   */
  readonly multiParcelGroupId: string | null;
  readonly saleObservationIds: readonly string[];
  readonly supportingEchoIds: readonly string[];
  readonly discrepantEchoIds: readonly string[];
  readonly contributingSourceIds: readonly string[];
  /** Distinct statements of this sale across releases. >1 means it was revised. */
  readonly statementCount: number;
  /** When the governing statement was observed; the first observation of any statement. */
  readonly observedAt: string;
  readonly firstObservedAt: string;
};

export type SaleConflictKind =
  /** An echo names the same month and instrument as a sale, at a different price. */
  | 'echo_price_differs'
  /** An echo fits two or more sales equally well, so it supports none. */
  | 'echo_ambiguous'
  /** A sale-data row was re-stated with different content by a later release. */
  | 'sale_statement_revised';

export type SaleConflict = {
  readonly conflictId: string;
  readonly countyFips: string;
  readonly propertyId: string;
  readonly normalizedParcel: string;
  readonly conflictKind: SaleConflictKind;
  readonly severity: 'info' | 'warn';
  readonly detail: Readonly<Record<string, unknown>>;
  readonly observationIds: readonly string[];
  /** The newest evidence involved: when the conflict became observable. */
  readonly detectedAt: string;
  readonly status: 'open';
};

export type SaleProjectionSinks = {
  resolution(row: SaleResolution): Promise<void>;
  conflict(row: SaleConflict): Promise<void>;
};

export type SaleProjectionResult = {
  readonly saleCount: number;
  readonly supportedMatchCount: number;
  readonly saleObservationOnlyCount: number;
  readonly echoOnlyCount: number;
  readonly conflictCount: number;
};

/** Folds one partition's sale contributions. Memory: one sort chunk plus one property's rows. */
export async function projectSales(
  contributions: () => AsyncIterable<string>,
  sinks: SaleProjectionSinks,
  options: { readonly sort?: SortOptions } = {},
): Promise<SaleProjectionResult> {
  let saleCount = 0;
  let supportedMatchCount = 0;
  let saleObservationOnlyCount = 0;
  let echoOnlyCount = 0;
  let conflictCount = 0;

  const saleLines = async function* (): AsyncGenerator<string> {
    for await (const line of contributions()) if (isSaleContributionLine(line)) yield line;
  };
  const byProperty = groupSorted(
    externalSort(saleLines(), keyOfProperty, options.sort ?? {}),
    keyOfProperty,
    (line) => JSON.parse(line) as SaleContribution,
  );

  for await (const { items } of byProperty) {
    const outcome = foldProperty(items);
    for (const row of outcome.sales) {
      saleCount += 1;
      if (row.state === 'SUPPORTED_MATCH') supportedMatchCount += 1;
      else if (row.state === 'SALE_OBSERVATION_ONLY') saleObservationOnlyCount += 1;
      else echoOnlyCount += 1;
      await sinks.resolution(row);
    }
    for (const row of outcome.conflicts) {
      conflictCount += 1;
      await sinks.conflict(row);
    }
  }

  return { saleCount, supportedMatchCount, saleObservationOnlyCount, echoOnlyCount, conflictCount };
}

type Statement = {
  readonly key: string;
  readonly items: SaleContribution[];
};

type SaleDraft = {
  readonly identity: string;
  readonly governing: SaleContribution;
  readonly observations: readonly SaleContribution[];
  readonly statementCount: number;
  readonly supporting: SaleContribution[];
  readonly discrepant: SaleContribution[];
};

/**
 * The whole fold for one property. Exported for the permutation tests: the
 * result must not depend on the order of `items`.
 */
export function foldProperty(input: readonly SaleContribution[]): {
  readonly sales: readonly SaleResolution[];
  readonly conflicts: readonly SaleConflict[];
} {
  // Canonical order first, so nothing below can depend on arrival order.
  const items = [...input].sort(compareContributions);
  const anchor = items[0];
  if (anchor === undefined) return { sales: [], conflicts: [] };
  const conflicts: SaleConflict[] = [];

  // -- 1. sale-data rows, one sale per publisher sale identity ----------------
  const bySale = new Map<string, SaleContribution[]>();
  const echoes: SaleContribution[] = [];
  for (const item of items) {
    if (item.k === 'SALE_OBSERVATION' && item.i !== null) {
      const identity = `${item.s}\u0000${item.i}`;
      const list = bySale.get(identity) ?? [];
      list.push(item);
      bySale.set(identity, list);
    } else {
      echoes.push(item);
    }
  }

  const drafts: SaleDraft[] = [];
  for (const [identity, observations] of [...bySale].sort(([a], [b]) => compareText(a, b))) {
    const statements = statementsOf(observations);
    // The newest statement governs; ties are broken by content, never by order.
    const governing = [...observations].sort((a, b) => compareText(b.t, a.t) || compareContributions(a, b))[0] as SaleContribution;
    drafts.push({ identity, governing, observations, statementCount: statements.length, supporting: [], discrepant: [] });
    if (statements.length > 1) {
      conflicts.push(conflictOf('sale_statement_revised', 'info', anchor, observations, {
        publisherSaleId: governing.i, statements: statements.length,
      }));
    }
  }

  // -- 2. echoes: support, discrepancy, ambiguity ------------------------------
  const unmatched: SaleContribution[] = [];
  for (const echo of echoes) {
    const exact = drafts.filter((d) => d.governing.ym === echo.ym && d.governing.pr === echo.pr
      && referencesCompatible(d.governing.ref, echo.ref));
    const chosen = exact.length > 1
      // Two candidates, one of which names the very same instrument: that one.
      ? exact.filter((d) => echo.ref !== null && d.governing.ref === echo.ref)
      : exact;
    if (chosen.length === 1) {
      (chosen[0] as SaleDraft).supporting.push(echo);
      continue;
    }
    if (chosen.length > 1 || exact.length > 1) {
      conflicts.push(conflictOf('echo_ambiguous', 'info', anchor, [echo, ...exact.flatMap((d) => d.observations)], {
        candidates: exact.length, saleMonth: echo.ym,
      }));
      continue;
    }
    const sameInstrument = drafts.filter((d) => echo.ref !== null && d.governing.ref === echo.ref && d.governing.ym === echo.ym);
    if (sameInstrument.length === 1) {
      const draft = sameInstrument[0] as SaleDraft;
      draft.discrepant.push(echo);
      conflicts.push(conflictOf('echo_price_differs', 'warn', anchor, [echo, ...draft.observations], {
        saleMonth: echo.ym, echoPriceMinor: echo.pr, salePriceMinor: draft.governing.pr, reference: echo.ref,
      }));
      continue;
    }
    unmatched.push(echo);
  }

  // -- 3. echo-only sales: echoes of one sale converge on (month, price, ref) --
  const echoOnly = new Map<string, SaleContribution[]>();
  for (const echo of unmatched) {
    const key = `${echo.ym ?? ''}\u0000${echo.pr ?? ''}\u0000${echo.ref ?? ''}`;
    const list = echoOnly.get(key) ?? [];
    list.push(echo);
    echoOnly.set(key, list);
  }

  const sales: SaleResolution[] = [];
  for (const draft of drafts) {
    sales.push(resolutionOf(anchor, draft.governing, {
      saleId: deterministicId('sale', anchor.c, anchor.n, 'sid', draft.governing.i ?? ''),
      state: draft.supporting.length > 0 ? 'SUPPORTED_MATCH' : 'SALE_OBSERVATION_ONLY',
      observations: draft.observations,
      supporting: draft.supporting,
      discrepant: draft.discrepant,
      statementCount: draft.statementCount,
    }));
  }
  for (const [key, group] of [...echoOnly].sort(([a], [b]) => compareText(a, b))) {
    const governing = [...group].sort((a, b) => compareText(b.t, a.t) || compareContributions(a, b))[0] as SaleContribution;
    const [ym, pr, ref] = key.split('\u0000');
    sales.push(resolutionOf(anchor, governing, {
      saleId: deterministicId('sale', anchor.c, anchor.n, 'echo', ym ?? '', pr ?? '', ref ?? ''),
      state: 'ECHO_ONLY',
      observations: [],
      supporting: group,
      discrepant: [],
      statementCount: statementsOf(group).length,
    }));
  }

  return {
    sales: sales.sort((a, b) => compareText(a.saleId, b.saleId)),
    conflicts: conflicts.sort((a, b) => compareText(a.conflictId, b.conflictId)),
  };
}

function resolutionOf(
  anchor: SaleContribution,
  governing: SaleContribution,
  parts: {
    readonly saleId: string;
    readonly state: SaleResolutionState;
    readonly observations: readonly SaleContribution[];
    readonly supporting: readonly SaleContribution[];
    readonly discrepant: readonly SaleContribution[];
    readonly statementCount: number;
  },
): SaleResolution {
  const all = [...parts.observations, ...parts.supporting, ...parts.discrepant];
  const times = all.map((x) => x.t).sort();
  return {
    saleId: parts.saleId,
    countyFips: anchor.c,
    propertyId: anchor.p,
    normalizedParcel: anchor.n,
    state: parts.state,
    semanticClass: governing.sc,
    publisherSaleId: governing.i,
    saleMonth: governing.ym,
    priceMinor: governing.pr,
    priceAbsentReason: governing.pa,
    priceKind: governing.pk,
    qualificationCode: governing.q,
    vacantImprovedCode: governing.vi,
    recordingReference: governing.ref,
    multiParcelCode: governing.mp,
    multiParcelGroupId: governing.mp !== null && governing.ref !== null
      ? deterministicId('multiparcel', anchor.c, governing.ref)
      : null,
    saleObservationIds: unique(parts.observations.map((x) => x.o)),
    supportingEchoIds: unique(parts.supporting.map((x) => x.o)),
    discrepantEchoIds: unique(parts.discrepant.map((x) => x.o)),
    contributingSourceIds: unique(all.map((x) => x.s)),
    statementCount: parts.statementCount,
    observedAt: governing.t,
    firstObservedAt: times[0] ?? governing.t,
  };
}

function conflictOf(
  kind: SaleConflictKind,
  severity: SaleConflict['severity'],
  anchor: SaleContribution,
  involved: readonly SaleContribution[],
  detail: Record<string, unknown>,
): SaleConflict {
  const observationIds = unique(involved.map((x) => x.o));
  return {
    conflictId: deterministicId('saleconflict', kind, anchor.c, anchor.n, ...observationIds),
    countyFips: anchor.c,
    propertyId: anchor.p,
    normalizedParcel: anchor.n,
    conflictKind: kind,
    severity,
    detail,
    observationIds,
    detectedAt: involved.map((x) => x.t).sort().at(-1) ?? anchor.t,
    status: 'open',
  };
}

/** Distinct statements: the same sale observed with the same content in two releases is one statement. */
function statementsOf(items: readonly SaleContribution[]): readonly Statement[] {
  const out = new Map<string, SaleContribution[]>();
  for (const item of items) {
    const key = canonicalJson([item.ym, item.pr, item.pa, item.q, item.vi, item.ref, item.mp]);
    const list = out.get(key) ?? [];
    list.push(item);
    out.set(key, list);
  }
  return [...out].map(([key, list]) => ({ key, items: list }));
}

/** Equal, or absent on either side. Two DIFFERENT references are two instruments. */
function referencesCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order over contributions: by observation id, then by full content. */
function compareContributions(a: SaleContribution, b: SaleContribution): number {
  return compareText(a.o, b.o) || compareText(canonicalJson(a), canonicalJson(b));
}

function keyOfProperty(line: string): string {
  const marker = '"p":"';
  const at = line.indexOf(marker);
  if (at === -1) return '';
  const from = at + marker.length;
  const to = line.indexOf('"', from);
  return to === -1 ? line.slice(from) : line.slice(from, to);
}
