/**
 * eCRV Weekly Sales Extract field inventory and mapping decisions.
 *
 * One row for every one of the 151 leaf elements the pinned Schema 3 declares,
 * each with an explicit disposition. There is no default and no catch-all: an
 * element the publisher adds in a future schema has no row here, and the
 * coverage test fails until somebody decides what it means. That failure is the
 * point — silent pass-through of unclassified source fields is how provenance
 * rots.
 *
 * Dispositions:
 *   KEEP_RAW           retained verbatim in the parsed source record; no further treatment
 *   NORMALIZE          typed and carried as source-stated characteristics or metadata
 *   CANONICALIZE       becomes a first-class field or row on a canonical entity
 *   DERIVE_LATER       retained; interpretation deferred to a later phase, not guessed now
 *   RESTRICTED_CONTACT routed to the restricted contact plane, never to canonical output
 *   COUNTY_ONLY        county/city-added; NOT present in the Weekly Sales Extract at all
 *   IGNORE_WITH_REASON deliberately not carried forward, with the reason recorded
 *
 * Everything parsed is retained in the raw source record regardless of
 * disposition, except RESTRICTED_CONTACT values, which are split out before the
 * canonical record is built.
 */

export type FieldDisposition =
  | 'KEEP_RAW'
  | 'NORMALIZE'
  | 'CANONICALIZE'
  | 'DERIVE_LATER'
  | 'RESTRICTED_CONTACT'
  | 'COUNTY_ONLY'
  | 'IGNORE_WITH_REASON';

export type FieldMapping = {
  /** Path from the schema root, as the compiled XSD enumerates it. */
  readonly path: string;
  readonly disposition: FieldDisposition;
  /** Where the value lands, or null when it lands nowhere. */
  readonly target: string | null;
  readonly note: string;
};

export const ECRV_FIELD_MAP: readonly FieldMapping[] = [
  { path: '/ecrvForm/headerForm/countyCde', disposition: 'CANONICALIZE', target: 'transaction.countyFips + jurisdictionId', note: 'Minnesota county code 01-87. Resolved to county FIPS through the jurisdiction catalogue.' },
  { path: '/ecrvForm/headerForm/crvNumberId', disposition: 'CANONICALIZE', target: 'transaction.sourceRecordId', note: 'With countyCde, the publisher key for the filing. Evidence of identity, not Reivesti identity.' },
  { path: '/ecrvForm/buyersForm/individuals/addressLine1', disposition: 'CANONICALIZE', target: 'party_observation.address.line1', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/addressLine2', disposition: 'CANONICALIZE', target: 'party_observation.address.line2', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/city', disposition: 'CANONICALIZE', target: 'party_observation.address.city', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/contactNotes', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text about how to reach the party. Restricted plane only.' },
  { path: '/ecrvForm/buyersForm/individuals/country', disposition: 'CANONICALIZE', target: 'party_observation.address.country', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/daytimePhone', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.phone', note: 'Personal contact channel. Restricted plane only; never reaches canonical party or transaction rows.' },
  { path: '/ecrvForm/buyersForm/individuals/email', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.email', note: 'Personal contact channel. Restricted plane only.' },
  { path: '/ecrvForm/buyersForm/individuals/firstName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.first', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/foreignAddress', disposition: 'CANONICALIZE', target: 'party_observation.foreignAddress', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id. Not stable across releases, so never used as identity.' },
  { path: '/ecrvForm/buyersForm/individuals/lastName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.last', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/middleName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.middle', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/nameSuffix', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.suffix', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/person', disposition: 'CANONICALIZE', target: 'party_observation.kind', note: 'Source-stated person/organisation classification. Not inferred from the name.' },
  { path: '/ecrvForm/buyersForm/individuals/privateIndicator', disposition: 'CANONICALIZE', target: 'party_observation.protectedIdentity', note: 'Address-confidentiality or judicial-privacy participant. Raises handling requirements; never used to drop the transaction.' },
  { path: '/ecrvForm/buyersForm/individuals/stateOrProvince', disposition: 'CANONICALIZE', target: 'party_observation.address.stateOrProvince', note: '' },
  { path: '/ecrvForm/buyersForm/individuals/zip', disposition: 'CANONICALIZE', target: 'party_observation.address.postalCode', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/addressLine1', disposition: 'CANONICALIZE', target: 'party_observation.address.line1', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/addressLine2', disposition: 'CANONICALIZE', target: 'party_observation.address.line2', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/city', disposition: 'CANONICALIZE', target: 'party_observation.address.city', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/contactNotes', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text about how to reach the party. Restricted plane only.' },
  { path: '/ecrvForm/buyersForm/organizations/country', disposition: 'CANONICALIZE', target: 'party_observation.address.country', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/daytimePhone', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.phone', note: 'Personal contact channel. Restricted plane only; never reaches canonical party or transaction rows.' },
  { path: '/ecrvForm/buyersForm/organizations/email', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.email', note: 'Personal contact channel. Restricted plane only.' },
  { path: '/ecrvForm/buyersForm/organizations/foreignAddress', disposition: 'CANONICALIZE', target: 'party_observation.foreignAddress', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id. Not stable across releases, so never used as identity.' },
  { path: '/ecrvForm/buyersForm/organizations/organizationName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.organizationName', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/person', disposition: 'CANONICALIZE', target: 'party_observation.kind', note: 'Source-stated person/organisation classification. Not inferred from the name.' },
  { path: '/ecrvForm/buyersForm/organizations/privateIndicator', disposition: 'CANONICALIZE', target: 'party_observation.protectedIdentity', note: 'Address-confidentiality or judicial-privacy participant. Raises handling requirements; never used to drop the transaction.' },
  { path: '/ecrvForm/buyersForm/organizations/stateOrProvince', disposition: 'CANONICALIZE', target: 'party_observation.address.stateOrProvince', note: '' },
  { path: '/ecrvForm/buyersForm/organizations/zip', disposition: 'CANONICALIZE', target: 'party_observation.address.postalCode', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/addressLine1', disposition: 'CANONICALIZE', target: 'party_observation.address.line1', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/addressLine2', disposition: 'CANONICALIZE', target: 'party_observation.address.line2', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/city', disposition: 'CANONICALIZE', target: 'party_observation.address.city', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/contactNotes', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text about how to reach the party. Restricted plane only.' },
  { path: '/ecrvForm/sellersForm/individuals/country', disposition: 'CANONICALIZE', target: 'party_observation.address.country', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/daytimePhone', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.phone', note: 'Personal contact channel. Restricted plane only; never reaches canonical party or transaction rows.' },
  { path: '/ecrvForm/sellersForm/individuals/email', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.email', note: 'Personal contact channel. Restricted plane only.' },
  { path: '/ecrvForm/sellersForm/individuals/firstName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.first', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/foreignAddress', disposition: 'CANONICALIZE', target: 'party_observation.foreignAddress', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id. Not stable across releases, so never used as identity.' },
  { path: '/ecrvForm/sellersForm/individuals/lastName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.last', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/middleName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.middle', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/nameSuffix', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.suffix', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/person', disposition: 'CANONICALIZE', target: 'party_observation.kind', note: 'Source-stated person/organisation classification. Not inferred from the name.' },
  { path: '/ecrvForm/sellersForm/individuals/privateIndicator', disposition: 'CANONICALIZE', target: 'party_observation.protectedIdentity', note: 'Address-confidentiality or judicial-privacy participant. Raises handling requirements; never used to drop the transaction.' },
  { path: '/ecrvForm/sellersForm/individuals/stateOrProvince', disposition: 'CANONICALIZE', target: 'party_observation.address.stateOrProvince', note: '' },
  { path: '/ecrvForm/sellersForm/individuals/zip', disposition: 'CANONICALIZE', target: 'party_observation.address.postalCode', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/addressLine1', disposition: 'CANONICALIZE', target: 'party_observation.address.line1', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/addressLine2', disposition: 'CANONICALIZE', target: 'party_observation.address.line2', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/city', disposition: 'CANONICALIZE', target: 'party_observation.address.city', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/contactNotes', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text about how to reach the party. Restricted plane only.' },
  { path: '/ecrvForm/sellersForm/organizations/country', disposition: 'CANONICALIZE', target: 'party_observation.address.country', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/daytimePhone', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.phone', note: 'Personal contact channel. Restricted plane only; never reaches canonical party or transaction rows.' },
  { path: '/ecrvForm/sellersForm/organizations/email', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.email', note: 'Personal contact channel. Restricted plane only.' },
  { path: '/ecrvForm/sellersForm/organizations/foreignAddress', disposition: 'CANONICALIZE', target: 'party_observation.foreignAddress', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id. Not stable across releases, so never used as identity.' },
  { path: '/ecrvForm/sellersForm/organizations/organizationName', disposition: 'CANONICALIZE', target: 'party_observation.nameParts.organizationName', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/person', disposition: 'CANONICALIZE', target: 'party_observation.kind', note: 'Source-stated person/organisation classification. Not inferred from the name.' },
  { path: '/ecrvForm/sellersForm/organizations/privateIndicator', disposition: 'CANONICALIZE', target: 'party_observation.protectedIdentity', note: 'Address-confidentiality or judicial-privacy participant. Raises handling requirements; never used to drop the transaction.' },
  { path: '/ecrvForm/sellersForm/organizations/stateOrProvince', disposition: 'CANONICALIZE', target: 'party_observation.address.stateOrProvince', note: '' },
  { path: '/ecrvForm/sellersForm/organizations/zip', disposition: 'CANONICALIZE', target: 'party_observation.address.postalCode', note: '' },
  { path: '/ecrvForm/propertyForm/county', disposition: 'NORMALIZE', target: 'source_record.property.countyCode', note: 'Repeat of headerForm/countyCde. Cross-checked; a disagreement quarantines the record.' },
  { path: '/ecrvForm/propertyForm/displayMnPropertyAddress', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Controls display on the state form. Says nothing about the property.' },
  { path: '/ecrvForm/propertyForm/displayParcel', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Controls display on the state form. Says nothing about the property.' },
  { path: '/ecrvForm/propertyForm/irrigatedAcres', disposition: 'NORMALIZE', target: 'transaction.characteristics.irrigated_acres', note: '' },
  { path: '/ecrvForm/propertyForm/legalDescription', disposition: 'CANONICALIZE', target: 'transaction.legalDescription', note: '' },
  { path: '/ecrvForm/propertyForm/mnPropertyAddresses/city', disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: '' },
  { path: '/ecrvForm/propertyForm/mnPropertyAddresses/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/propertyForm/mnPropertyAddresses/street1', disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: '' },
  { path: '/ecrvForm/propertyForm/mnPropertyAddresses/street2', disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: '' },
  { path: '/ecrvForm/propertyForm/mnPropertyAddresses/zip', disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: '' },
  { path: '/ecrvForm/propertyForm/needsAcreageDetails', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Form-flow flag deciding which sub-form the submitter must complete.' },
  { path: '/ecrvForm/propertyForm/needsApartmentDetails', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Form-flow flag deciding which sub-form the submitter must complete.' },
  { path: '/ecrvForm/propertyForm/needsTimberDetails', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Form-flow flag deciding which sub-form the submitter must complete.' },
  { path: '/ecrvForm/propertyForm/newBuildingsOnSaleYear', disposition: 'NORMALIZE', target: 'transaction.characteristics.new_buildings_in_sale_year', note: 'New construction between 1 January of the sale year and the agreement date, as declared.' },
  { path: '/ecrvForm/propertyForm/numberOfRentalBuildings', disposition: 'NORMALIZE', target: 'transaction.characteristics.rental_buildings', note: '' },
  { path: '/ecrvForm/propertyForm/numberOfRentalUnitsInAllBuildings', disposition: 'NORMALIZE', target: 'transaction.characteristics.rental_units', note: '' },
  { path: '/ecrvForm/propertyForm/parcels/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/propertyForm/parcels/parcelId', disposition: 'CANONICALIZE', target: 'property_identifier[county_parcel]', note: 'Submitter-stated preliminary PID. Scoped to the county; county-final PIDs are not in this extract.' },
  { path: '/ecrvForm/propertyForm/parcels/primary', disposition: 'CANONICALIZE', target: 'property_identifier.sourceDesignation', note: '' },
  { path: '/ecrvForm/propertyForm/plannedUses/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/propertyForm/plannedUses/tier1Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.plannedUses', note: 'Use taxonomy code. The code list is published with the web-service schemas, not the extract; mapping is deferred rather than guessed.' },
  { path: '/ecrvForm/propertyForm/plannedUses/tier2Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.plannedUses', note: 'Use taxonomy code; mapping deferred.' },
  { path: '/ecrvForm/propertyForm/plannedUses/tier3Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.plannedUses', note: 'Use taxonomy code; mapping deferred.' },
  { path: '/ecrvForm/propertyForm/plannedUses/primaryInd', disposition: 'DERIVE_LATER', target: 'source_record.property.plannedUses', note: '' },
  { path: '/ecrvForm/propertyForm/principalResidence', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_intends_principal_residence', note: 'A statement of buyer intent at the time of sale. Deliberately NOT recorded as an owner-occupancy fact about the property.' },
  { path: '/ecrvForm/propertyForm/propertyPrograms/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/propertyForm/propertyPrograms/parcelProgramAcres', disposition: 'NORMALIZE', target: 'transaction.characteristics.conservation_program_acres', note: '' },
  { path: '/ecrvForm/propertyForm/propertyPrograms/parcelProgramCode', disposition: 'NORMALIZE', target: 'transaction.characteristics.conservation_program_code', note: 'CRP, SFIA or WRP enrolment as declared.' },
  { path: '/ecrvForm/propertyForm/tillableAcres', disposition: 'NORMALIZE', target: 'transaction.characteristics.tillable_acres', note: '' },
  { path: '/ecrvForm/propertyForm/totalAcres', disposition: 'NORMALIZE', target: 'transaction.characteristics.deeded_acres', note: 'The eCRV "deeded acres" figure as the submitter stated it.' },
  { path: '/ecrvForm/propertyForm/usesBeforeSale/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/propertyForm/usesBeforeSale/tier1Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.usesBeforeSale', note: 'Prior-use taxonomy code; mapping deferred.' },
  { path: '/ecrvForm/propertyForm/usesBeforeSale/tier2Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.usesBeforeSale', note: 'Prior-use taxonomy code; mapping deferred.' },
  { path: '/ecrvForm/propertyForm/usesBeforeSale/tier3Cde', disposition: 'DERIVE_LATER', target: 'source_record.property.usesBeforeSale', note: 'Prior-use taxonomy code; mapping deferred.' },
  { path: '/ecrvForm/propertyForm/whatIsIncludedInSale', disposition: 'NORMALIZE', target: 'transaction.characteristics.included_in_sale_code', note: 'Raw code A/B/L retained. The published guidance describes land only, land with buildings and buildings only; the code-to-label mapping is not stated in the extract schema, so only the code is authoritative here.' },
  { path: '/ecrvForm/salesAgreementForm/agreement2YrsOld', disposition: 'NORMALIZE', target: 'transaction.characteristics.agreement_over_two_years_old', note: '"Old purchase": the agreement predates the sale year by more than two years.' },
  { path: '/ecrvForm/salesAgreementForm/buyerPartInterest', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_acquired_partial_interest', note: '' },
  { path: '/ecrvForm/salesAgreementForm/deedContractDate', disposition: 'CANONICALIZE', target: 'transaction.transferDate', note: '' },
  { path: '/ecrvForm/salesAgreementForm/deedPayoff', disposition: 'NORMALIZE', target: 'transaction.characteristics.contract_for_deed_payoff', note: 'Payoff or resale of an existing contract for deed.' },
  { path: '/ecrvForm/salesAgreementForm/deedTypeCde', disposition: 'CANONICALIZE', target: 'transaction.instrumentTypeCode', note: 'Source code retained unmapped: WARRNTY, QUITCLAIM, TRUSTEE, PROBATE, PERREPDEED, CONFORDEED, LIMWARRNTY, SPECWARNTY, OTHER.' },
  { path: '/ecrvForm/salesAgreementForm/didBuyerLease', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_leased_before_sale', note: '' },
  { path: '/ecrvForm/salesAgreementForm/didSellerLease', disposition: 'NORMALIZE', target: 'transaction.characteristics.seller_leased_after_sale', note: '' },
  { path: '/ecrvForm/salesAgreementForm/downPmtEquity', disposition: 'CANONICALIZE', target: 'transaction.downPayment', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/balloonPaymentAmt', disposition: 'CANONICALIZE', target: 'financing_event.balloonAmount', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/balloonPaymentDate', disposition: 'CANONICALIZE', target: 'financing_event.balloonDate', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/contractMortgageAmt', disposition: 'CANONICALIZE', target: 'financing_event.principalAmount', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/interestRate', disposition: 'CANONICALIZE', target: 'financing_event.interestRatePercent', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/interestRateType', disposition: 'CANONICALIZE', target: 'financing_event.interestRateType', note: 'FIXED or VARIABLE.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/monthlyPaymentAmt', disposition: 'CANONICALIZE', target: 'financing_event.paymentAmount', note: 'Amount per payment; the payment period is paymentType, which is not always monthly despite the element name.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/needsBalloonPaymentDate', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Form-flow flag controlling whether the date field is required.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/needsPaymentTypeOther', disposition: 'IGNORE_WITH_REASON', target: null, note: 'Form-flow flag controlling whether the free-text field is required.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/numberPayments', disposition: 'CANONICALIZE', target: 'financing_event.numberOfPayments', note: '' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/paymentFor', disposition: 'CANONICALIZE', target: 'financing_event.paymentAppliesToCode', note: 'INTANDPRIN, INTONLY or PRINONLY.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/paymentType', disposition: 'CANONICALIZE', target: 'financing_event.paymentFrequencyCode', note: 'MNTLY, QRTLY, SMANNUAL, ANNUAL or OTHER.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/paymentTypeOther', disposition: 'NORMALIZE', target: 'financing_event.paymentFrequencyCode', note: 'Free-text period used when paymentType is OTHER.' },
  { path: '/ecrvForm/salesAgreementForm/financeArrangements/selected', disposition: 'CANONICALIZE', target: 'financing_event.selectedBySource', note: 'Whether the submitter selected this arrangement on the form.' },
  { path: '/ecrvForm/salesAgreementForm/financeType', disposition: 'CANONICALIZE', target: 'financing_event.financeTypeCode', note: 'CASH, CD (contract for deed), MORTGAGE or ASSUMED. CD is never folded into MORTGAGE.' },
  { path: '/ecrvForm/salesAgreementForm/guaranteeRentIncome', disposition: 'NORMALIZE', target: 'transaction.characteristics.minimum_guaranteed_rental_income', note: '' },
  { path: '/ecrvForm/salesAgreementForm/leaseOptionToBuy', disposition: 'NORMALIZE', target: 'transaction.characteristics.lease_with_option_to_buy', note: '' },
  { path: '/ecrvForm/salesAgreementForm/likeKindExchange', disposition: 'NORMALIZE', target: 'transaction.characteristics.like_kind_exchange', note: 'IRC 1031 exchange as declared.' },
  { path: '/ecrvForm/salesAgreementForm/personalProperties/id', disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Form-local element id.' },
  { path: '/ecrvForm/salesAgreementForm/personalProperties/propertyDescription', disposition: 'NORMALIZE', target: 'transaction.characteristics.personal_property', note: '' },
  { path: '/ecrvForm/salesAgreementForm/personalProperties/propertyValue', disposition: 'NORMALIZE', target: 'transaction.characteristics.personal_property', note: '' },
  { path: '/ecrvForm/salesAgreementForm/personalProperties/selected', disposition: 'NORMALIZE', target: 'transaction.characteristics.personal_property', note: '' },
  { path: '/ecrvForm/salesAgreementForm/personalPropertyIncludedInTotal', disposition: 'CANONICALIZE', target: 'transaction.personalPropertyIncludedInTotal', note: '' },
  { path: '/ecrvForm/salesAgreementForm/receivedInTrade', disposition: 'NORMALIZE', target: 'transaction.characteristics.property_received_in_trade', note: '' },
  { path: '/ecrvForm/salesAgreementForm/sellerLeaseMonths', disposition: 'NORMALIZE', target: 'transaction.characteristics.seller_lease_months', note: '' },
  { path: '/ecrvForm/salesAgreementForm/sellerPdPts', disposition: 'CANONICALIZE', target: 'transaction.sellerPaidPoints', note: '' },
  { path: '/ecrvForm/salesAgreementForm/specialAssesmtAmt', disposition: 'CANONICALIZE', target: 'transaction.delinquentSpecialAssessmentsPaidByBuyer', note: 'Delinquent taxes and special assessments the buyer agreed to pay.' },
  { path: '/ecrvForm/salesAgreementForm/totPurchaseAmt', disposition: 'CANONICALIZE', target: 'transaction.totalConsideration', note: '' },
  { path: '/ecrvForm/supplementaryForm/adjacentPropertyInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_owns_adjacent_property', note: '' },
  { path: '/ecrvForm/supplementaryForm/buyerAppraisalAmt', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_appraisal_amount', note: '' },
  { path: '/ecrvForm/supplementaryForm/buyerAppraisalInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_obtained_appraisal', note: '' },
  { path: '/ecrvForm/supplementaryForm/giftInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.gift_or_inheritance', note: '' },
  { path: '/ecrvForm/supplementaryForm/governmentInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.government_party', note: '' },
  { path: '/ecrvForm/supplementaryForm/legalActionInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.foreclosure_or_legal_proceeding', note: 'Declares that the sale arose from a legal proceeding. It is NOT a foreclosure event: no DISTRESS_EVENT is emitted from an eCRV.' },
  { path: '/ecrvForm/supplementaryForm/nameChangeInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.name_change_only', note: '' },
  { path: '/ecrvForm/supplementaryForm/nonListedComment', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text. Frequently names people and describes relationships, so it is isolated until reviewed rather than published to market intelligence.' },
  { path: '/ecrvForm/supplementaryForm/nonListedInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.not_publicly_promoted', note: '' },
  { path: '/ecrvForm/supplementaryForm/nonMarketPriceComment', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.contact_note', note: 'Unbounded submitter free text; isolated for the same reason as nonListedComment.' },
  { path: '/ecrvForm/supplementaryForm/nonMarketPriceInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.significant_price_difference', note: '' },
  { path: '/ecrvForm/supplementaryForm/relatedInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.buyer_seller_related', note: 'Transaction-level relationship. Never promoted to a standing fact about either party.' },
  { path: '/ecrvForm/supplementaryForm/sellerAppraisalAmt', disposition: 'NORMALIZE', target: 'transaction.characteristics.seller_appraisal_amount', note: '' },
  { path: '/ecrvForm/supplementaryForm/sellerAppraisalInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.seller_obtained_appraisal', note: '' },
  { path: '/ecrvForm/supplementaryForm/taxExemptInd', disposition: 'NORMALIZE', target: 'transaction.characteristics.tax_exempt_party', note: '' },
  { path: '/ecrvForm/submitterForm', disposition: 'RESTRICTED_CONTACT', target: 'contact_observation.unstructured_submitter_block', note: 'Declared in the XSD with no content model at all (xs:anyType), so its shape is not guaranteed by the authority and it may carry submitter identity. Retained verbatim in the restricted plane and never parsed into canonical fields.' },
];

/**
 * Data the county or city adds during processing. The department states plainly
 * that the extract "only contains the information provided by the submitter; it
 * does not contain any data that may be added by a county or city", and Schema 3
 * bears that out: none of the following appears anywhere in it. They are listed
 * so the gap is documented rather than rediscovered, and so DF-0C knows exactly
 * what it is being asked to supply.
 */
export const ECRV_COUNTY_ONLY_FIELDS: readonly FieldMapping[] = [
  { path: '(absent) yearBuilt', disposition: 'COUNTY_ONLY', target: null, note: 'County-added. Comes from an assessor source, not eCRV.' },
  { path: '(absent) neighborhoodCode', disposition: 'COUNTY_ONLY', target: null, note: 'County-added assessment neighbourhood.' },
  { path: '(absent) estimatedMarketValue', disposition: 'COUNTY_ONLY', target: null, note: 'County-added assessor value (land, building, total).' },
  { path: '(absent) propertyClassification', disposition: 'COUNTY_ONLY', target: null, note: 'County-added property class (the D-codes in the web-service schemas).' },
  { path: '(absent) finalParcelIds', disposition: 'COUNTY_ONLY', target: null, note: 'County-verified final PIDs. The extract carries submitter-stated preliminary PIDs only; final parcel identity must not be fabricated from them.' },
  { path: '(absent) studyAcceptReject', disposition: 'COUNTY_ONLY', target: null, note: 'Sales-ratio study accept/reject decision and rejection reason. Analytical metadata; its absence never affects whether the transfer is ingested.' },
  { path: '(absent) acceptDate', disposition: 'COUNTY_ONLY', target: null, note: 'Date the county or city accepted the eCRV. Not in the extract, so the run cannot state when acceptance happened - only that the extract contains accepted eCRVs.' },
  { path: '(absent) submitDate', disposition: 'COUNTY_ONLY', target: null, note: 'Submission timestamp. Not in the extract. deedContractDate is the only date the transfer itself carries.' },
  { path: '(absent) auditorId', disposition: 'COUNTY_ONLY', target: null, note: 'Not present in the extract schema.' },
  { path: '(absent) salesAdjustments', disposition: 'COUNTY_ONLY', target: null, note: 'County-entered sale adjustments used in the ratio study.' },
];

const BY_PATH = new Map(ECRV_FIELD_MAP.map((f) => [f.path, f] as const));

export function fieldMapping(path: string): FieldMapping | undefined {
  return BY_PATH.get(path);
}

export function mappedPaths(): readonly string[] {
  return [...BY_PATH.keys()].sort();
}

export function dispositionCounts(): Readonly<Record<FieldDisposition, number>> {
  const counts = {
    KEEP_RAW: 0, NORMALIZE: 0, CANONICALIZE: 0, DERIVE_LATER: 0,
    RESTRICTED_CONTACT: 0, COUNTY_ONLY: 0, IGNORE_WITH_REASON: 0,
  };
  for (const f of ECRV_FIELD_MAP) counts[f.disposition] += 1;
  return counts;
}
