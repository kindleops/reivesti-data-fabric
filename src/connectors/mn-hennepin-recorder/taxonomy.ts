/**
 * Hennepin recorded-document taxonomy.
 *
 * Assembled from three authoritative sources, because RecordEASE publishes no
 * machine-readable type list and its terms forbid extracting one:
 *
 *  1. Hennepin County's own recording fee schedule, which names the document
 *     classes the office charges for (Abstract and Torrens memorials,
 *     assignments, satisfactions, partial releases, plats, certificates of
 *     title, state tax liens and releases, well disclosure certificates).
 *  2. Minn. Stat. ch. 507 (conveyancing and recording) and ch. 508 / 508A
 *     (Torrens registered land, Registrar of Titles, certificates of title and
 *     memorials).
 *  3. The eCRV Schema 3 `deedTypeCde` enumeration already pinned in DF-0B —
 *     Minnesota's own authoritative vocabulary for deed types, which the state
 *     collects on every qualifying transfer.
 *
 * The table is therefore *expected* types, not *observed* ones. Until sanctioned
 * access exists there is no count column to fill in honestly, and inventing one
 * would be worse than leaving it null.
 *
 * The matcher is deliberately strict. An unrecognised label becomes `OTHER` with
 * the raw text preserved — never a nearest-neighbour guess, because a document
 * family drives ownership and lien inferences and a wrong guess is a wrong fact.
 */
import type { InstrumentFamily, ReferenceType } from '../../canonical/instruments.ts';

export type SemanticEffect =
  | 'conveys_legal_title'
  | 'creates_equitable_interest'
  | 'creates_lien'
  | 'transfers_lien_interest'
  | 'discharges_lien'
  | 'amends_prior_document'
  | 'gives_notice'
  | 'establishes_or_amends_title_registration'
  | 'defines_land'
  | 'none_or_unknown';

export type DocumentTypeEntry = {
  /** The label as a recorder index is expected to write it. */
  readonly rawType: string;
  readonly family: InstrumentFamily;
  readonly semanticEffect: SemanticEffect;
  /**
   * Whether a conveyance observation may be derived. `false` for everything
   * that moves an interest without being a market conveyance of legal title.
   */
  readonly safeConveyanceEvent: boolean;
  /** Whether this type is expected to reference prior document numbers. */
  readonly expectsReferences: boolean;
  readonly impliedReference: ReferenceType | null;
  readonly notes: string;
};

export const HENNEPIN_DOCUMENT_TYPES: readonly DocumentTypeEntry[] = [
  // --- conveyances ---------------------------------------------------------
  {
    rawType: 'WARRANTY DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes: 'eCRV deedTypeCde WARRNTY. The ordinary market conveyance.',
  },
  {
    rawType: 'LIMITED WARRANTY DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes: 'eCRV deedTypeCde LIMWARRNTY.',
  },
  {
    rawType: 'SPECIAL WARRANTY DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes: 'eCRV deedTypeCde SPECWARNTY.',
  },
  {
    rawType: 'QUIT CLAIM DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes:
      'eCRV deedTypeCde QUITCLAIM. Conveys whatever interest the grantor has, which may be none. '
      + 'Routinely used to clear title, add a spouse or move property into a trust, so a quit claim '
      + 'is a conveyance and very often not a sale.',
  },
  {
    rawType: 'TRUSTEES DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes: 'eCRV deedTypeCde TRUSTEE.',
  },
  {
    rawType: 'PERSONAL REPRESENTATIVE DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: true, expectsReferences: false, impliedReference: null,
    notes: 'eCRV deedTypeCde PERREPDEED. Estate conveyance; rarely an arm\'s-length sale.',
  },
  {
    rawType: 'CONTRACT FOR DEED',
    family: 'CONTRACT_FOR_DEED', semanticEffect: 'creates_equitable_interest',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes:
      'Creates an equitable interest; legal title stays with the vendor until the contract is paid. '
      + 'Deliberately NOT a conveyance: treating it as one would transfer ownership years early.',
  },
  {
    rawType: 'TRANSFER ON DEATH DEED',
    family: 'CONVEYANCE', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes:
      'Minn. Stat. 507.071. Conveys nothing until the grantor dies, and is revocable until then. '
      + 'Recording it is not an ownership change.',
  },

  // --- mortgages and their lifecycle ---------------------------------------
  {
    rawType: 'MORTGAGE',
    family: 'MORTGAGE', semanticEffect: 'creates_lien',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Creates a lien. Never an ownership change.',
  },
  {
    rawType: 'ASSIGNMENT OF MORTGAGE',
    family: 'MORTGAGE_ASSIGNMENT', semanticEffect: 'transfers_lien_interest',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'ASSIGNS',
    notes:
      'Moves the lender\'s interest to a new holder. NOT a new loan against the property, and not '
      + 'a transaction involving the owner at all.',
  },
  {
    rawType: 'SATISFACTION OF MORTGAGE',
    family: 'MORTGAGE_RELEASE', semanticEffect: 'discharges_lien',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'SATISFIES',
    notes:
      'Discharges the lien. Commonly follows a sale or a refinance, and is evidence of neither on '
      + 'its own: the payoff amount is not recorded and the reason is not stated.',
  },
  {
    rawType: 'PARTIAL RELEASE OF MORTGAGE',
    family: 'MORTGAGE_RELEASE', semanticEffect: 'discharges_lien',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'RELEASES',
    notes: 'Releases part of the encumbered land. The mortgage survives on the remainder.',
  },
  {
    rawType: 'ASSIGNMENT OF LEASES AND RENTS',
    family: 'LEASE_RELATED', semanticEffect: 'creates_lien',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'REFERENCES',
    notes: 'Usually recorded alongside a commercial mortgage as additional security.',
  },

  // --- liens ----------------------------------------------------------------
  {
    rawType: 'MECHANICS LIEN',
    family: 'LIEN', semanticEffect: 'creates_lien',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Minn. Stat. ch. 514.',
  },
  {
    rawType: 'STATE TAX LIEN',
    family: 'LIEN', semanticEffect: 'creates_lien',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Recorded at no charge per the Hennepin fee schedule.',
  },
  {
    rawType: 'STATE TAX LIEN RELEASE',
    family: 'LIEN_RELEASE', semanticEffect: 'discharges_lien',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'RELEASES',
    notes: '$30 per the Hennepin fee schedule.',
  },
  {
    rawType: 'LIEN RELEASE',
    family: 'LIEN_RELEASE', semanticEffect: 'discharges_lien',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'RELEASES',
    notes: '',
  },

  // --- foreclosure ----------------------------------------------------------
  {
    rawType: 'SHERIFFS CERTIFICATE OF SALE',
    family: 'FORECLOSURE_RELATED', semanticEffect: 'conveys_legal_title',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'REFERENCES',
    notes:
      'Issued at a foreclosure sale. It does transfer an interest, but subject to a redemption '
      + 'period, so recording it is not yet an ownership change. Kept out of the conveyance family '
      + 'for exactly that reason.',
  },
  {
    rawType: 'NOTICE OF PENDENCY',
    family: 'FORECLOSURE_RELATED', semanticEffect: 'gives_notice',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Notice of a pending foreclosure action.',
  },
  {
    rawType: 'LIS PENDENS',
    family: 'FORECLOSURE_RELATED', semanticEffect: 'gives_notice',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Notice of pending litigation affecting title.',
  },

  // --- corrections and title -------------------------------------------------
  {
    rawType: 'CORRECTION DEED',
    family: 'CORRECTION', semanticEffect: 'amends_prior_document',
    safeConveyanceEvent: false, expectsReferences: true, impliedReference: 'AMENDS',
    notes:
      'Fixes an error in an earlier document. Emphatically not a second conveyance: counting it as '
      + 'one would invent an ownership change that never happened.',
  },
  {
    rawType: 'AFFIDAVIT',
    family: 'OTHER', semanticEffect: 'none_or_unknown',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Too varied to classify from a type label alone.',
  },
  {
    rawType: 'CERTIFICATE OF TITLE',
    family: 'TITLE_RELATED', semanticEffect: 'establishes_or_amends_title_registration',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Torrens. Minn. Stat. ch. 508. Names the owner and lists memorialised encumbrances.',
  },
  {
    rawType: 'PLAT',
    family: 'TITLE_RELATED', semanticEffect: 'defines_land',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Subdivision or CIC plat. Creates the lots later deeds refer to.',
  },
  {
    rawType: 'WELL DISCLOSURE CERTIFICATE',
    family: 'OTHER', semanticEffect: 'none_or_unknown',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Filed with many conveyances; $54 per the Hennepin fee schedule.',
  },
  {
    rawType: 'EASEMENT',
    family: 'OTHER', semanticEffect: 'none_or_unknown',
    safeConveyanceEvent: false, expectsReferences: false, impliedReference: null,
    notes: 'Conveys a limited right, not fee ownership.',
  },
];

const BY_NORMALIZED = new Map(HENNEPIN_DOCUMENT_TYPES.map((e) => [normalizeTypeLabel(e.rawType), e] as const));

/** Comparison form for type labels: case, punctuation and spacing insensitive. */
export function normalizeTypeLabel(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

export type TypeClassification = {
  readonly family: InstrumentFamily;
  readonly entry: DocumentTypeEntry | null;
  /** True when the label was recognised outright rather than defaulted. */
  readonly recognised: boolean;
};

/**
 * Classifies a raw document type.
 *
 * Exact match on the normalized label, or nothing. No fuzzy matching, no
 * substring heuristics, no "contains DEED so it must be a conveyance" — a
 * `TRANSFER ON DEATH DEED` contains DEED and conveys nothing, and a
 * `SATISFACTION OF MORTGAGE` contains MORTGAGE and creates no lien.
 *
 * An unrecognised type is `OTHER`. The raw label is always retained by the
 * caller, and the coverage report lists unrecognised labels so the table can be
 * extended by a human who has seen real data.
 */
export function classifyDocumentType(rawType: string): TypeClassification {
  const entry = BY_NORMALIZED.get(normalizeTypeLabel(rawType));
  if (!entry) return { family: 'OTHER', entry: null, recognised: false };
  return { family: entry.family, entry, recognised: true };
}

export function documentTypeEntries(): readonly DocumentTypeEntry[] {
  return HENNEPIN_DOCUMENT_TYPES;
}

export function familyCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of HENNEPIN_DOCUMENT_TYPES) out[e.family] = (out[e.family] ?? 0) + 1;
  return out;
}
