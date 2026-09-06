/**
 * What kind of transfer a RETR describes.
 *
 * A Real Estate Transfer Return proves that **a conveyance was filed**. It does
 * not, on its own, prove that a property changed hands at a market price. Roughly
 * a third of Wisconsin's returns are gifts, inheritances, divorces, corrections,
 * foreclosures and transfers between related entities, and every one of them
 * would look like a "sale" to anything that read the price field and stopped.
 *
 * So this module produces classifications only from what the publisher itself
 * states — the conveyance type, the ch. 77.25 exemption claimed, the declared
 * party relationship, the ownership share and the rights retained — and each
 * classification carries the field and value that produced it. Nothing here
 * infers investor behaviour, distress, or motive.
 *
 * ## Why a set, not a label
 *
 * Real returns carry several of these at once. "Parent/child or
 * grandparent/grandchild - part sale/part gift", with partial ownership and a
 * retained life estate, is simultaneously a relationship transfer, a gift, and a
 * partial-interest transfer — and flattening that to one enum would throw away
 * two thirds of what the county was told. Every applicable classification is
 * emitted with its basis, and `primaryClassification` names the one that most
 * governs how the transfer should be read.
 */
import {
  WI_CONVEYANCE_TYPES,
  WI_FEE_EXEMPTIONS,
  WI_OWNERSHIP_TYPES,
  WI_PARTY_RELATIONSHIPS,
  WI_RIGHTS_RETAINED,
  exemptionCode,
} from './codes.ts';

export type TransferClassification =
  /**
   * The source's own fields are consistent with an arm's-length sale. Requires
   * ALL of: conveyance type "Sale", no declared relationship, full ownership, no
   * rights retained, no fee exemption, and a stated sale price above zero.
   */
  | 'MARKET_SALE_SUPPORTED'
  /** A conveyance the source describes in terms that exclude a market price. */
  | 'NON_MARKET_TRANSFER_SUPPORTED'
  /** The parties declared a relationship to each other. */
  | 'RELATIONSHIP_TRANSFER'
  /** The source calls it a gift, in whole or in part. */
  | 'GIFT_TRANSFER'
  /** A ch. 77.25 transfer-fee exemption was claimed. */
  | 'EXEMPT_TRANSFER'
  /** Foreclosure, a sheriff's deed, or a deed in lieu. */
  | 'FORECLOSURE_RELATED'
  /** Less than the grantor's whole interest, or rights retained. */
  | 'PARTIAL_INTEREST_TRANSFER'
  /** The source did not say enough to classify. Never a synonym for "sale". */
  | 'UNKNOWN_TRANSFER_TYPE';

export type ClassificationEvidence = {
  readonly classification: TransferClassification;
  /** The publisher field the classification was read from. */
  readonly field: string;
  /** The publisher value, verbatim. */
  readonly value: string;
};

export type TransferClassificationResult = {
  /**
   * The classification that most governs how this transfer should be read.
   *
   * Ordered by how strongly each excludes a market reading, most exclusive
   * first, so that a transfer which is both a gift and a relationship transfer
   * is primarily a gift.
   */
  readonly primary: TransferClassification;
  /** Every applicable classification, each with the field that produced it. */
  readonly all: readonly ClassificationEvidence[];
  /** Publisher values that are not in the pinned code lists. Drift, not error. */
  readonly unknownCodes: readonly string[];
};

export type ClassificationInput = {
  readonly conveyanceType: string | null;
  readonly feeExemption: string | null;
  readonly relationship: string | null;
  readonly ownershipType: string | null;
  readonly rightsRetained: string | null;
  /** Minor units. Null when the source stated no price at all. */
  readonly salePriceMinor: bigint | null;
};

/** Conveyance types that describe a foreclosure or its equivalents. */
const FORECLOSURE_CONVEYANCES: ReadonlySet<string> = new Set([
  'County/municipality foreclosure judgment',
  'Foreclosure or In lieu of foreclosure (no prior interest in property or mortgage)',
  'Foreclosure or In lieu of foreclosure (with prior interest in property or mortgage)',
  "Judgment/Sheriff's deed (no prior interest in the mortgage or property)",
  "Judgment/Sheriff's deed (with prior interest in the mortgage or property)",
]);

/** Conveyance types the publisher describes as a gift, wholly or partly. */
const GIFT_CONVEYANCES: ReadonlySet<string> = new Set([
  'Gift',
  'Parent/child or grandparent/grandchild - gift',
  'Parent/child or grandparent/grandchild - part sale/part gift',
]);

/**
 * Conveyance types that are not a market sale, whatever price is attached.
 *
 * Inheritance, divorce, corrections, entity reorganisations, partitions and
 * conveyances into and out of trusts. A price may still be present — a
 * part-sale to a child has one — and it is still not a market price.
 */
const NON_MARKET_CONVEYANCES: ReadonlySet<string> = new Set([
  'Affidavit of correction/correction instrument',
  'Deed in satisfaction of land contract',
  'Divorce or between spouses',
  'Land contract amendment',
  'Member(s) to LLC or LLC to member(s)',
  'Parcel creation (WRPLA improvement document or other type of document)',
  'Partition',
  'Partner(s) to partnership or Partnership to partner(s)',
  'Shareholder(s) to corporation or corporation to shareholder(s)',
  "Sheriff's deed of partition",
  "Termination of decedent's interest",
  'Transfer by affidavit (PR-1831)',
  'Trust (conveyance to)',
  'Trustee to a 3rd party',
  'Trustee to beneficiary',
  'Will, decedent, or survivorship',
]);

/**
 * Exemption codes that state a relationship between the parties.
 *
 * The statutory subsection is what is matched, never the publisher's shorthand
 * label — the label list contains at least one typo, and a label could be
 * reworded without the statute changing.
 */
const RELATIONSHIP_EXEMPTION_CODES: ReadonlySet<string> = new Set([
  '7',    // subsidiary corporation to parent
  '8',    // parent/child, grandparent/grandchild
  '8m',   // between spouses
  '8n',   // domestic partners
  '9',    // agent and principal, trustee to beneficiary
  '15',   // corporation and its family shareholders
  '15m',  // partnership and family partners
  '15s',  // LLC and its family members
]);

/** Exemption codes that state a gift. */
const GIFT_EXEMPTION_CODES: ReadonlySet<string> = new Set(['2g', '8']);

/** Exemption codes that state a foreclosure or tax-delinquency disposal. */
const FORECLOSURE_EXEMPTION_CODES: ReadonlySet<string> = new Set(['4', '14']);

/** Exemption codes that state a partial interest or a partition. */
const PARTIAL_INTEREST_EXEMPTION_CODES: ReadonlySet<string> = new Set(['5', '10', '10m']);

/**
 * Most-exclusive first.
 *
 * A transfer that is both a foreclosure and exempt is primarily a foreclosure:
 * the exemption tells you no fee was owed, the foreclosure tells you what
 * happened. `MARKET_SALE_SUPPORTED` is last because it is the only one that has
 * to survive every other test to be reached.
 */
const PRIMARY_ORDER: readonly TransferClassification[] = [
  'FORECLOSURE_RELATED',
  'GIFT_TRANSFER',
  'RELATIONSHIP_TRANSFER',
  'PARTIAL_INTEREST_TRANSFER',
  'NON_MARKET_TRANSFER_SUPPORTED',
  'EXEMPT_TRANSFER',
  'MARKET_SALE_SUPPORTED',
  'UNKNOWN_TRANSFER_TYPE',
];

export function classifyTransfer(input: ClassificationInput): TransferClassificationResult {
  const found: ClassificationEvidence[] = [];
  const unknownCodes: string[] = [];
  const add = (classification: TransferClassification, field: string, value: string): void => {
    if (!found.some((e) => e.classification === classification && e.field === field)) {
      found.push({ classification, field, value });
    }
  };

  const conveyance = input.conveyanceType;
  const exemption = input.feeExemption;
  const code = exemptionCode(exemption);

  // Drift: a value the publisher's own dictionary does not list. Recorded and
  // reported, never silently treated as one of the known values.
  for (const [field, value, known] of [
    ['Conveyance Type', conveyance, WI_CONVEYANCE_TYPES],
    ['Fee Exemption', exemption, WI_FEE_EXEMPTIONS],
    ['Grantor/Grantee Relationship', input.relationship, WI_PARTY_RELATIONSHIPS],
    ['Ownership Type', input.ownershipType, WI_OWNERSHIP_TYPES],
    ['Rights Retained by Grantor', input.rightsRetained, WI_RIGHTS_RETAINED],
  ] as const) {
    if (value !== null && value !== '' && !known.includes(value)) unknownCodes.push(`${field}=${value}`);
  }

  // -- what the conveyance type says ---------------------------------------
  if (conveyance !== null) {
    if (FORECLOSURE_CONVEYANCES.has(conveyance)) add('FORECLOSURE_RELATED', 'Conveyance Type', conveyance);
    if (GIFT_CONVEYANCES.has(conveyance)) add('GIFT_TRANSFER', 'Conveyance Type', conveyance);
    if (NON_MARKET_CONVEYANCES.has(conveyance)) add('NON_MARKET_TRANSFER_SUPPORTED', 'Conveyance Type', conveyance);
    if (conveyance === 'Partition' || conveyance === "Sheriff's Deed of Partition"
      || conveyance === "Sheriff's deed of partition") {
      add('PARTIAL_INTEREST_TRANSFER', 'Conveyance Type', conveyance);
    }
    // A part sale/part gift is exactly that: neither wholly market nor wholly gift.
    if (conveyance === 'Parent/child or grandparent/grandchild - part sale/part gift') {
      add('RELATIONSHIP_TRANSFER', 'Conveyance Type', conveyance);
    }
    if (conveyance === 'Parent/child or grandparent/grandchild - gift') {
      add('RELATIONSHIP_TRANSFER', 'Conveyance Type', conveyance);
    }
  }

  // -- what the exemption says ---------------------------------------------
  if (exemption !== null && exemption !== '') {
    add('EXEMPT_TRANSFER', 'Fee Exemption', exemption);
    if (code !== null) {
      if (RELATIONSHIP_EXEMPTION_CODES.has(code)) add('RELATIONSHIP_TRANSFER', 'Fee Exemption', exemption);
      if (GIFT_EXEMPTION_CODES.has(code)) add('GIFT_TRANSFER', 'Fee Exemption', exemption);
      if (FORECLOSURE_EXEMPTION_CODES.has(code)) add('FORECLOSURE_RELATED', 'Fee Exemption', exemption);
      if (PARTIAL_INTEREST_EXEMPTION_CODES.has(code)) add('PARTIAL_INTEREST_TRANSFER', 'Fee Exemption', exemption);
      // 11/11m (will, descent, survivorship, transfer on death), 3 (correction),
      // 12 (condemnation), 13 (value under $1,000), 16 (to trust), 17 (land
      // contract satisfaction) and the entity-reorganisation codes all describe
      // conveyances that have no market price by construction.
      if (['3', '11', '11m', '12', '13', '16', '17', '6', '6d', '6m', '6q', '6t', '20', '21', '1', '2', '2r', '18']
        .includes(code)) {
        add('NON_MARKET_TRANSFER_SUPPORTED', 'Fee Exemption', exemption);
      }
    }
  }

  // -- what the parties declared about each other ---------------------------
  if (input.relationship !== null && input.relationship !== '' && input.relationship !== 'No relationship') {
    add('RELATIONSHIP_TRANSFER', 'Grantor/Grantee Relationship', input.relationship);
  }

  // -- how much actually moved ----------------------------------------------
  if (input.ownershipType === 'Partial') add('PARTIAL_INTEREST_TRANSFER', 'Ownership Type', input.ownershipType);
  if (input.rightsRetained === 'Life Estate' || input.rightsRetained === 'Easement') {
    add('PARTIAL_INTEREST_TRANSFER', 'Rights Retained by Grantor', input.rightsRetained);
  }

  // -- the one positive finding, and it has to earn it ----------------------
  //
  // Every condition is the publisher's own statement. A missing conveyance type
  // does not qualify; neither does a sale with a relationship, a partial
  // interest, a retained right, an exemption, or no price.
  const marketSupported =
    conveyance === 'Sale'
    && (input.relationship === 'No relationship' || input.relationship === null || input.relationship === '')
    && input.ownershipType === 'Full'
    && (input.rightsRetained === 'None' || input.rightsRetained === null || input.rightsRetained === '')
    && (exemption === null || exemption === '')
    && input.salePriceMinor !== null
    && input.salePriceMinor > 0n
    && found.length === 0;

  if (marketSupported) add('MARKET_SALE_SUPPORTED', 'Conveyance Type', conveyance);

  if (found.length === 0) {
    return {
      primary: 'UNKNOWN_TRANSFER_TYPE',
      all: [{
        classification: 'UNKNOWN_TRANSFER_TYPE',
        field: 'Conveyance Type',
        value: conveyance ?? '',
      }],
      unknownCodes,
    };
  }

  const primary = PRIMARY_ORDER.find((c) => found.some((e) => e.classification === c)) ?? 'UNKNOWN_TRANSFER_TYPE';
  return { primary, all: found, unknownCodes };
}
