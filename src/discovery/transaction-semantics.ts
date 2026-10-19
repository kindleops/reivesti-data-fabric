/**
 * What one transaction-type record MEANS (DF-0Q).
 *
 * The estate already keeps these apart at the canonical layer — a recorded
 * instrument is a document (`instruments.ts`), an SDF row is a sale observation
 * and a roll's copy of it is an echo (`SaleObservationKind`), a notice of sale is
 * a distress event (`DistressEventType`). What it did not have was the same
 * discipline at DISCOVERY time, where a candidate could claim `deed` because the
 * publisher's page mentioned deeds. Wisconsin RETR sat in the catalogue claiming
 * `deed` for exactly that reason: a transfer return is filed alongside a deed and
 * is not one.
 *
 * So every candidate that claims a transaction capability declares the semantic
 * class of its records, and a class may only claim the capabilities its records
 * can actually support. The rules are the ones the brief states and the canonical
 * layer already enforces:
 *
 *   an assessor sale price is not deed consideration;
 *   a foreclosure notice is not a completed foreclosure;
 *   the current owner is not necessarily the buyer in a prior sale;
 *   a mortgage recording is not proof of outstanding debt.
 */
import type { Capability } from '../registry/types.ts';

export type TransactionSemanticClass =
  /** A document as a recorder's (or registrar's) index states it. */
  | 'RECORDED_INSTRUMENT'
  /** A statutory filing that declares a conveyance and its consideration (eCRV, RETR, PTAX-203, SR-1A). */
  | 'TRANSFER_DECLARATION'
  /** An appraiser's or assessor's own sale record, reviewed for a ratio study (FL SDF). */
  | 'ASSESSOR_SALE_OBSERVATION'
  /** A roll's copy of a sale onto the parcel record (FL NAL/PAR echoes, MN sale_date/sale_value). */
  | 'TAX_ROLL_SALE_ECHO'
  /** A notice that a foreclosure has been started or a sale scheduled: NOD, lis pendens, notice of sale. */
  | 'FORECLOSURE_NOTICE'
  /** A tax authority's delinquency, certificate, forfeiture or tax-deed sale record. */
  | 'TAX_SALE_EVENT'
  /** A published schedule of auctions: sheriff, trustee, tax-deed. */
  | 'AUCTION_LISTING';

export const TRANSACTION_SEMANTIC_CLASSES: readonly TransactionSemanticClass[] = [
  'RECORDED_INSTRUMENT', 'TRANSFER_DECLARATION', 'ASSESSOR_SALE_OBSERVATION', 'TAX_ROLL_SALE_ECHO',
  'FORECLOSURE_NOTICE', 'TAX_SALE_EVENT', 'AUCTION_LISTING',
];

/** The capabilities this module governs. Parcel, assessor, tax and the rest are outside it. */
export const TRANSACTION_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'transfer', 'sale_observation', 'sale_economics', 'deed', 'mortgage', 'mortgage_release',
  'lien', 'foreclosure_notice', 'tax_sale', 'tax_delinquency',
]);

export type TransactionSemantics = {
  readonly semanticClass: TransactionSemanticClass;
  /** Exactly what one record asserts. */
  readonly oneRecordMeans: string;
  /** Conclusions a naive consumer would draw and must not. */
  readonly isNot: readonly string[];
  /** The transaction capabilities a record of this class can support. Anything else is an overclaim. */
  readonly mayClaim: readonly Capability[];
  /** Where it lands in the canonical model that exists today. */
  readonly canonicalTarget: string;
};

export const TRANSACTION_SEMANTICS: Readonly<Record<TransactionSemanticClass, TransactionSemantics>> = {
  RECORDED_INSTRUMENT: {
    semanticClass: 'RECORDED_INSTRUMENT',
    oneRecordMeans:
      'A document of a stated type, naming stated parties in stated roles, was recorded (or memorialised) '
      + 'by a county office on a stated date under a stated instrument number or book/page.',
    isNot: [
      'a sale, or evidence of a price: a deed\'s stated or tax-implied consideration is not a market price',
      'proof that the grantee still owns the land',
      'for a mortgage: proof that any debt is outstanding, or of its balance',
      'for a release: evidence of a sale',
      'for a lis pendens or notice of default: a completed foreclosure',
    ],
    mayClaim: ['deed', 'mortgage', 'mortgage_release', 'lien', 'foreclosure_notice'],
    canonicalTarget:
      'RecordedInstrument + InstrumentFamily (src/canonical/instruments.ts); events INSTRUMENT_RECORDED, '
      + 'CONVEYANCE_OBSERVED (conveying families only), MORTGAGE_RECORDED / _ASSIGNED / _RELEASED',
  },
  TRANSFER_DECLARATION: {
    semanticClass: 'TRANSFER_DECLARATION',
    oneRecordMeans:
      'A party to a conveyance declared to a revenue authority that a conveyance occurred, with the '
      + 'consideration, parties and property it states, as accepted (or merely filed) by that authority.',
    isNot: [
      'the recorded deed itself: it may name the deed type and recording reference, never stand in for it',
      'a mortgage record: a declared financing type describes this purchase, not a lien',
      'an arm\'s-length finding unless the authority states one',
    ],
    mayClaim: ['transfer', 'sale_economics'],
    canonicalTarget:
      'TransactionEvent + transfer_considerations via the eCRV / RETR connectors; event '
      + 'REAL_ESTATE_TRANSFER_OBSERVED',
  },
  ASSESSOR_SALE_OBSERVATION: {
    semanticClass: 'ASSESSOR_SALE_OBSERVATION',
    oneRecordMeans:
      'An appraiser or assessor recorded that a parcel sold in a period at a price it derived or was told, '
      + 'and how it judged the sale for its ratio study.',
    isNot: [
      'deed consideration: the price is the assessor\'s figure (Florida: derived from documentary stamp tax)',
      'a recorded instrument, though it may cite one by book/page',
      'a statement of who bought: most files name no party',
      'a comparable: "qualified" is a ratio-study decision',
    ],
    mayClaim: ['sale_observation', 'sale_economics'],
    canonicalTarget: 'SaleObservation kind SALE_OBSERVATION (src/canonical/models.ts) → TRANSACTION_RESOLUTION',
  },
  TAX_ROLL_SALE_ECHO: {
    semanticClass: 'TAX_ROLL_SALE_ECHO',
    oneRecordMeans:
      'A roll or parcel layer repeats, on the parcel record, the date and often the price of a prior sale.',
    isNot: [
      'a sale by itself: it supports a sale observation and never becomes a second transaction',
      'evidence that the current owner was the buyer in that sale',
      'sale economics: an echoed price is the roll\'s copy, not a declaration',
    ],
    mayClaim: ['sale_observation'],
    canonicalTarget: 'SaleObservation kind ASSESSOR_SALE_ECHO → folded by TRANSACTION_RESOLUTION as SUPPORTED_MATCH',
  },
  FORECLOSURE_NOTICE: {
    semanticClass: 'FORECLOSURE_NOTICE',
    oneRecordMeans:
      'A notice was posted, published, recorded or filed that a foreclosure has been commenced or a sale '
      + 'has been scheduled against stated property.',
    isNot: [
      'a completed foreclosure or a transfer of title',
      'proof the sale took place: most scheduled sales are postponed, cancelled or reinstated',
      'a statement of the debt outstanding',
    ],
    mayClaim: ['foreclosure_notice'],
    canonicalTarget: 'DistressEvent notice_of_default | notice_of_sale | lis_pendens (src/canonical/models.ts)',
  },
  TAX_SALE_EVENT: {
    semanticClass: 'TAX_SALE_EVENT',
    oneRecordMeans:
      'A taxing authority recorded a delinquency, a tax certificate or lien sale, a forfeiture, or a tax-deed sale '
      + 'against a parcel.',
    isNot: [
      'for a delinquency or certificate: a change of ownership',
      'for a tax-deed sale: proof the redemption period has run, unless the authority says so',
    ],
    mayClaim: ['tax_delinquency', 'tax_sale'],
    canonicalTarget: 'DistressEvent tax_delinquency | tax_sale',
  },
  AUCTION_LISTING: {
    semanticClass: 'AUCTION_LISTING',
    oneRecordMeans: 'A published schedule says a property is offered at a stated auction on a stated date.',
    isNot: [
      'a sale, a result, or a transfer',
      'a legal notice in itself: a listing is usually a copy of a notice published elsewhere',
    ],
    mayClaim: ['foreclosure_notice', 'tax_sale'],
    canonicalTarget: 'none yet — DistressEvent has no listing type; would need one before ingestion',
  },
};

/** Capabilities a set of declared classes may claim between them. */
export function claimableBy(classes: readonly TransactionSemanticClass[]): ReadonlySet<Capability> {
  return new Set(classes.flatMap((c) => TRANSACTION_SEMANTICS[c].mayClaim));
}

/**
 * Transaction capabilities claimed that no declared class can support. Empty
 * means consistent. A transaction capability claimed with no class declared at
 * all is reported too: undeclared semantics are how a sale echo becomes a deed.
 */
export function semanticOverclaims(
  capabilities: readonly Capability[],
  classes: readonly TransactionSemanticClass[] | undefined,
): readonly Capability[] {
  const allowed = claimableBy(classes ?? []);
  return capabilities.filter((c) => TRANSACTION_CAPABILITIES.has(c) && !allowed.has(c));
}

// ---------------------------------------------------------------------------
// The registered sources, classified
// ---------------------------------------------------------------------------

/**
 * The semantic class of every registered source that touches a transaction
 * capability, as DF-0Q reads its own docs and connectors. Recorded here rather
 * than as a field on `SourceDefinition` so that research cannot edit the
 * registry the runtime acts on; `registrySemanticFindings` reports where a
 * mapping claims more than its class supports.
 */
export const REGISTERED_SOURCE_SEMANTICS: Readonly<Record<string, readonly TransactionSemanticClass[]>> = {
  // A revenue filing. It states the deed type and the declared financing; it is
  // not the recorded deed and not a mortgage record (MN-ECRV.md §6).
  mn_dor_ecrv_weekly_sales_extract: ['TRANSFER_DECLARATION'],
  wi_dor_retr_historical: ['TRANSFER_DECLARATION'],
  mn_hennepin_recorded_instruments: ['RECORDED_INSTRUMENT'],
  // ASSESSOR_REPORTED_SALE_OBSERVATION: sale_date / sale_value on the parcel record.
  mn_statewide_parcels: ['TAX_ROLL_SALE_ECHO'],
  fl_dor_sdf: ['ASSESSOR_SALE_OBSERVATION'],
  fl_dor_nal: ['TAX_ROLL_SALE_ECHO'],
  fl_statewide_cadastral: ['TAX_ROLL_SALE_ECHO'],
  tx_dallas_foreclosure_notices: ['FORECLOSURE_NOTICE'],
};

export type RegistrySemanticFinding = {
  readonly sourceId: string;
  readonly mappingId: string;
  readonly classes: readonly TransactionSemanticClass[];
  readonly overclaimed: readonly Capability[];
};

/** Mappings whose declared capabilities exceed what their source's records can support. */
export function registrySemanticFindings(
  mappings: readonly { readonly mappingId: string; readonly sourceId: string; readonly capabilities: readonly Capability[] }[],
): readonly RegistrySemanticFinding[] {
  const out: RegistrySemanticFinding[] = [];
  for (const m of mappings) {
    const classes = REGISTERED_SOURCE_SEMANTICS[m.sourceId];
    const overclaimed = semanticOverclaims(m.capabilities, classes);
    if (overclaimed.length > 0) out.push({ sourceId: m.sourceId, mappingId: m.mappingId, classes: classes ?? [], overclaimed });
  }
  return out;
}
