/**
 * The parsed shape of one Hennepin County parcel row.
 *
 * A faithful typed restatement of the assessor roll, not an interpretation of
 * it. `restricted` is split out at parse time so nothing downstream can reach
 * taxpayer mailing data without deliberately asking for it.
 */

/** One classified portion of a parcel. A parcel may carry up to four. */
export type HennepinAssessmentTier = {
  readonly tier: number;
  readonly propertyTypeCode: string | null;
  readonly propertyTypeName: string | null;
  readonly homesteadCode: string | null;
  readonly ownerPercent: number | null;
  readonly contiguousIndicator: string | null;
  readonly landValueMinor: number | null;
  readonly buildingValueMinor: number | null;
  readonly machineryValueMinor: number | null;
  readonly totalValueMinor: number | null;
  readonly qualifyingImprovementMinor: number | null;
  readonly veteranExclusionMinor: number | null;
  readonly homesteadExclusionMinor: number | null;
  readonly netTaxCapacityMinor: number | null;
  readonly netTaxMinor: number | null;
};

export type HennepinSitusAddress = {
  readonly houseNumber: string | null;
  readonly fractionalHouseNumber: string | null;
  readonly streetName: string | null;
  readonly condoNumber: string | null;
  readonly municipality: string | null;
  readonly zip: string | null;
  readonly multipleAddresses: boolean;
};

export type HennepinRestricted = {
  /** The four fixed lines the source packs taxpayer name and mailing address into. */
  readonly taxpayerBlockLines: readonly string[];
  readonly mailingMunicipality: string | null;
};

export type HennepinParcelRecord = {
  /** County-assigned 13-digit PID, exactly as published. */
  readonly pid: string;
  readonly normalizedParcel: string;
  readonly countyFips: string;
  /** Service-local row id. Retained for provenance; never an identity. */
  readonly objectId: number | null;
  /** 0 current, 3 non-current, D in process. */
  readonly propertyStatusCode: string | null;
  readonly situs: HennepinSitusAddress;
  /** Owner of record on the roll. */
  readonly ownerName: string | null;
  /**
   * Line 1 of the taxpayer block. The source defines it as "Taxpayer Name and
   * Mailing Address Line 1", so this is a source-formatted reading, not a parse.
   */
  readonly taxpayerNameLine: string | null;
  readonly legalDescription: string | null;
  readonly yearBuilt: number | null;
  readonly parcelAreaSqFt: number | null;
  readonly marketValueTotalMinor: number | null;
  readonly taxableValueTotalMinor: number | null;
  readonly tiers: readonly HennepinAssessmentTier[];
  /** Assessor's echo of a last sale. Never turned into a transfer event. */
  readonly lastSale: {
    readonly date: string | null;
    readonly priceMinor: number | null;
    readonly code: string | null;
    readonly codeName: string | null;
  };
  readonly geography: Readonly<Record<string, unknown>>;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly restricted: HennepinRestricted;
};

/** Named groups used to report *what kind* of thing changed between snapshots. */
export const HENNEPIN_FIELD_GROUPS = [
  'identity',
  'address',
  'owner',
  'assessment',
  'tax',
  'characteristics',
  'geography',
] as const;

export type HennepinFieldGroup = (typeof HENNEPIN_FIELD_GROUPS)[number];
