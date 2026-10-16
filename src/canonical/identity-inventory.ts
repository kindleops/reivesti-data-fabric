/**
 * The property-identity contract of every source that mints a property id
 * (DF-0O).
 *
 * Three states arrived one at a time, each with its identity rule documented
 * in its own connector. Integration needs them side by side: two sources
 * converge on a property only if they compute the key the same way without
 * consulting each other, and two states stay apart only if nothing in either
 * key can coincide. This is that inventory, as data the tests read — not
 * prose that can drift from the code.
 *
 * Every id is `propertyIdFromCountyParcel(countyFips, normalizedParcel)`: a
 * hash over the literal tag `county_parcel`, the 5-digit county FIPS and the
 * normalized parcel string. The county FIPS carries the state FIPS in its
 * first two digits, so a Minnesota and a New York key can share a parcel
 * string and still never share an id (barring a SHA-256 collision).
 */
import { NORMALIZATION_CONTRACT_VERSION, PARCEL_IDENTIFIER_EXTENSION, type ParcelIdentifierScheme } from './normalization-contract.ts';

export type IdentityContract = {
  readonly sourceId: string;
  readonly stateCode: string;
  readonly stateFips: string;
  readonly contractVersion: string;
  /** null: the v1 rule (case and punctuation folded) with no extension recorded on the row. */
  readonly extension: string | null;
  readonly scheme: ParcelIdentifierScheme;
  /** What the source's identifier names, and within what it is unique. */
  readonly identifierSemantics: string;
  /** The exact string the property id is computed over. */
  readonly normalizedParcel: string;
  readonly leadingZeros: 'PRESERVED';
  readonly punctuation: 'FOLDED' | 'PRESERVED' | 'NOT_PRESENT';
  /** County routing: which field(s) decide the county, and what happens when they disagree. */
  readonly countyRouting: string;
  /** Measured on the full release before the rule was fixed. */
  readonly collisionEvidence: string;
  /** Refused as identity, with the count measured on the certified release. */
  readonly refused: string;
  readonly derivation: 'propertyIdFromCountyParcel(countyFips, normalizedParcel)';
};

export const IDENTITY_CONTRACTS: readonly IdentityContract[] = [
  {
    sourceId: 'mn_statewide_parcels',
    stateCode: 'MN',
    stateFips: '27',
    contractVersion: NORMALIZATION_CONTRACT_VERSION,
    extension: null,
    scheme: 'PUNCTUATION_FOLDED',
    identifierSemantics: 'county PIN (COUNTY_PIN), unique within the county',
    normalizedParcel: 'COUNTY_PIN upper-cased with every non-alphanumeric removed (normalizeParcelId)',
    leadingZeros: 'PRESERVED',
    punctuation: 'FOLDED',
    countyRouting: 'co_code, checked against the federal county catalogue as a Minnesota county; a row it cannot place is quarantined. 59 participating counties',
    collisionEvidence: 'folding shown injective inside every participating county; eCRV↔Hennepin convergence depends on it (02-028-24-41-0097 ≡ 0202824410097)',
    refused: 'rows with no county_pin, or one that folds to nothing, are quarantined',
    derivation: 'propertyIdFromCountyParcel(countyFips, normalizedParcel)',
  },
  {
    sourceId: 'mn_hennepin_county_parcels',
    stateCode: 'MN',
    stateFips: '27',
    contractVersion: NORMALIZATION_CONTRACT_VERSION,
    extension: null,
    scheme: 'PUNCTUATION_FOLDED',
    identifierSemantics: 'Hennepin PID, unique within Hennepin County (27053)',
    normalizedParcel: 'PID upper-cased with every non-alphanumeric removed — the same rule as the statewide layer, so both converge on one id',
    leadingZeros: 'PRESERVED',
    punctuation: 'FOLDED',
    countyRouting: 'fixed: 27053',
    collisionEvidence: 'Hennepin overlap audit (DF-0D/DF-0J): statewide and county rows converge on the same property ids',
    refused: 'rows with no PID are quarantined',
    derivation: 'propertyIdFromCountyParcel(countyFips, normalizedParcel)',
  },
  {
    sourceId: 'wi_statewide_parcels',
    stateCode: 'WI',
    stateFips: '55',
    contractVersion: NORMALIZATION_CONTRACT_VERSION,
    extension: PARCEL_IDENTIFIER_EXTENSION,
    scheme: 'PUNCTUATION_PRESERVING',
    identifierSemantics: 'PARCELID as the county assigns it, unique within the county',
    normalizedParcel: 'PARCELID with outer whitespace trimmed and case folded; nothing else',
    leadingZeros: 'PRESERVED',
    punctuation: 'PRESERVED',
    countyRouting: 'CONAME (where the land lies) through the federal catalogue; PARCELFIPS (the submitter) kept as provenance — they disagree on 5,431 rows',
    collisionEvidence: 'folding punctuation would merge 11,411 pairs of distinct ids inside one county (Brown: 1-1109 vs 11-109); case folding merges 0',
    refused: '58,201 label rows (ROW, GAP, HYDRO, …) with no digit; one row whose CONAME is a city',
    derivation: 'propertyIdFromCountyParcel(countyFips, normalizedParcel)',
  },
  {
    sourceId: 'ny_statewide_parcels',
    stateCode: 'NY',
    stateFips: '36',
    contractVersion: NORMALIZATION_CONTRACT_VERSION,
    extension: PARCEL_IDENTIFIER_EXTENSION,
    scheme: 'PUNCTUATION_PRESERVING',
    identifierSemantics: 'SWIS (6-digit municipal code) + SBL (unformatted tax map number; the 10-digit BBL in New York City) — the publisher\'s SWIS_SBL_ID convention, recomputed from its parts',
    normalizedParcel: 'SWIS followed by the SBL trimmed and case folded; nothing else',
    leadingZeros: 'PRESERVED',
    punctuation: 'NOT_PRESENT',
    countyRouting: 'COUNTY_NAME (folded, federal catalogue) and the SWIS county code must agree; disagreement quarantines',
    collisionEvidence: 'raw (county, SWIS, SBL) 0 collisions over 5,510,061 rows; the same SBL recurs in two towns of one county 123,246 times, so SWIS is part of the key; city/town instead of full SWIS would merge 11,523 keys',
    refused: '6,606 rows with no SBL; 19 Westchester label rows; 208 exact duplicates',
    derivation: 'propertyIdFromCountyParcel(countyFips, normalizedParcel)',
  },
];

export function identityContractOf(sourceId: string): IdentityContract | null {
  return IDENTITY_CONTRACTS.find((c) => c.sourceId === sourceId) ?? null;
}
