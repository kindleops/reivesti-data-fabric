/**
 * The parsed shape of one eCRV document.
 *
 * This is a faithful, typed re-statement of what the submitter filed — not an
 * interpretation of it. Source codes stay as source codes. Absence stays null.
 * Multiple buyers stay multiple buyers.
 *
 * `restricted` is separated at parse time so that everything downstream of the
 * parser can only reach contact data by deliberately reaching for it.
 */

export type EcrvPartyBlock = 'individuals' | 'organizations';

export type EcrvParty = {
  /** Stable within the document: block, ordinal and the form-local element id. */
  readonly partyKey: string;
  readonly side: 'buyer' | 'seller';
  readonly block: EcrvPartyBlock;
  readonly ordinal: number;
  readonly formElementId: string | null;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly nameSuffix: string | null;
  readonly organizationName: string | null;
  /** The source's own person/organisation flag. Never inferred from the name. */
  readonly isPerson: boolean | null;
  readonly privateIndicator: boolean | null;
  readonly foreignAddress: boolean | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly stateOrProvince: string | null;
  readonly zip: string | null;
  readonly country: string | null;
};

export type EcrvParcel = {
  readonly formElementId: string | null;
  readonly parcelId: string | null;
  readonly primary: boolean | null;
};

export type EcrvAddress = {
  readonly formElementId: string | null;
  readonly street1: string | null;
  readonly street2: string | null;
  readonly city: string | null;
  readonly zip: string | null;
};

export type EcrvUse = {
  readonly formElementId: string | null;
  readonly tier1Code: string | null;
  readonly tier2Code: string | null;
  readonly tier3Code: string | null;
  readonly primaryInd: boolean | null;
};

export type EcrvPropertyProgram = {
  readonly formElementId: string | null;
  readonly programCode: string | null;
  readonly programAcres: string | null;
};

export type EcrvPersonalProperty = {
  readonly formElementId: string | null;
  readonly description: string | null;
  /** Minor units. */
  readonly valueMinor: number | null;
  readonly selected: boolean | null;
};

export type EcrvFinanceArrangement = {
  readonly ordinal: number;
  readonly formElementId: string | null;
  readonly contractMortgageAmountMinor: number | null;
  readonly interestRatePercent: number | null;
  readonly interestRateTypeCode: string | null;
  readonly paymentAmountMinor: number | null;
  readonly paymentTypeCode: string | null;
  readonly paymentTypeOther: string | null;
  readonly paymentForCode: string | null;
  readonly numberOfPayments: number | null;
  readonly balloonAmountMinor: number | null;
  readonly balloonDate: string | null;
  readonly selected: boolean | null;
};

export type EcrvRestricted = {
  /** Keyed by `EcrvParty.partyKey`. */
  readonly partyContacts: readonly {
    readonly partyKey: string;
    readonly daytimePhone: string | null;
    readonly email: string | null;
    readonly contactNotes: string | null;
  }[];
  readonly nonListedComment: string | null;
  readonly nonMarketPriceComment: string | null;
  /**
   * `submitterForm` is declared with no content model in the pinned XSD, so its
   * contents are whatever the department chooses to put there. Retained verbatim
   * and never interpreted.
   */
  readonly submitterFormRaw: string | null;
};

export type EcrvRecord = {
  readonly countyCode: string;
  readonly crvNumber: string;
  readonly property: {
    readonly countyCode: string | null;
    readonly legalDescription: string | null;
    readonly parcels: readonly EcrvParcel[];
    readonly addresses: readonly EcrvAddress[];
    readonly plannedUses: readonly EcrvUse[];
    readonly usesBeforeSale: readonly EcrvUse[];
    readonly programs: readonly EcrvPropertyProgram[];
    readonly totalAcres: string | null;
    readonly tillableAcres: string | null;
    readonly irrigatedAcres: string | null;
    readonly principalResidence: boolean | null;
    readonly newBuildingsOnSaleYear: boolean | null;
    readonly numberOfRentalBuildings: number | null;
    readonly numberOfRentalUnitsInAllBuildings: number | null;
    readonly whatIsIncludedInSaleCode: string | null;
  };
  readonly buyers: readonly EcrvParty[];
  readonly sellers: readonly EcrvParty[];
  readonly sale: {
    readonly deedContractDate: string | null;
    readonly deedTypeCode: string | null;
    readonly totalPurchaseAmountMinor: number | null;
    readonly downPaymentEquityMinor: number | null;
    readonly sellerPaidPointsMinor: number | null;
    readonly specialAssessmentAmountMinor: number | null;
    readonly personalPropertyIncludedInTotal: boolean | null;
    readonly financeTypeCode: string | null;
    readonly financeArrangements: readonly EcrvFinanceArrangement[];
    readonly personalProperties: readonly EcrvPersonalProperty[];
    readonly agreement2YrsOld: boolean | null;
    readonly buyerPartInterest: boolean | null;
    readonly deedPayoff: boolean | null;
    readonly didBuyerLease: boolean | null;
    readonly didSellerLease: boolean | null;
    readonly sellerLeaseMonths: number | null;
    readonly guaranteeRentIncome: boolean | null;
    readonly leaseOptionToBuy: boolean | null;
    readonly likeKindExchange: boolean | null;
    readonly receivedInTrade: boolean | null;
  };
  readonly supplementary: {
    readonly adjacentPropertyInd: boolean | null;
    readonly buyerAppraisalInd: boolean | null;
    readonly buyerAppraisalAmountMinor: number | null;
    readonly sellerAppraisalInd: boolean | null;
    readonly sellerAppraisalAmountMinor: number | null;
    readonly giftInd: boolean | null;
    readonly governmentInd: boolean | null;
    readonly legalActionInd: boolean | null;
    readonly nameChangeInd: boolean | null;
    readonly nonListedInd: boolean | null;
    readonly nonMarketPriceInd: boolean | null;
    readonly relatedInd: boolean | null;
    readonly taxExemptInd: boolean | null;
  };
  readonly restricted: EcrvRestricted;
};
