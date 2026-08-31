/**
 * Hennepin County "County Parcels" field inventory and mapping decisions.
 *
 * One row for every one of the 122 fields the layer publishes, proven from the
 * service's own metadata rather than assumed. There is no default and no
 * catch-all: a field the county adds has no row here, and the coverage test
 * fails until somebody decides what it means.
 *
 * Dispositions (as DF-0C defines them):
 *   KEEP_RAW           retained verbatim in the parsed source record; no further treatment
 *   NORMALIZE          typed and carried as source-stated parcel attributes
 *   CANONICALIZE       becomes a first-class field or row on a canonical entity
 *   HISTORIZE          stored as a time-aware observation, never overwritten by a later snapshot
 *   DERIVE_LATER       retained; interpretation deferred to a later phase, not guessed now
 *   RESTRICTED         personal data; restricted plane only, never canonical output
 *   IGNORE_WITH_REASON deliberately not carried forward, with the reason recorded
 *
 * HISTORIZE is the disposition DF-0B did not need. An assessor roll restates the
 * same parcel every month, so a value written over the top of its predecessor
 * destroys the only interesting thing about it: that it changed.
 */

export type HennepinDisposition =
  | 'KEEP_RAW'
  | 'NORMALIZE'
  | 'CANONICALIZE'
  | 'HISTORIZE'
  | 'DERIVE_LATER'
  | 'RESTRICTED'
  | 'IGNORE_WITH_REASON';

export type HennepinFieldMapping = {
  readonly field: string;
  readonly sourceType: string;
  readonly maxLength: number | null;
  readonly disposition: HennepinDisposition;
  readonly target: string | null;
  readonly note: string;
};

export const HENNEPIN_FIELD_MAP: readonly HennepinFieldMapping[] = [
  { field: 'OBJECTID', sourceType: 'OID', maxLength: null, disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Service-local row id. Stable only within one snapshot of one service, so never an identity.' },
  { field: 'PID', sourceType: 'String', maxLength: 13, disposition: 'CANONICALIZE', target: 'property_identifier[county_parcel]', note: 'County-assigned 13-digit property ID. The authoritative parcel identity for Hennepin, and the join key to eCRV preliminary PIDs.' },
  { field: 'PID_TEXT', sourceType: 'String', maxLength: 12, disposition: 'KEEP_RAW', target: 'source_record.raw', note: 'Significant PID fragment within a quarter/quarter section, not a second full identifier.' },
  { field: 'DIV_STATUS_DATE', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.division_status_date', note: '' },
  { field: 'FEATURECODE', sourceType: 'Integer', maxLength: null, disposition: 'NORMALIZE', target: 'parcel.characteristics.feature_code', note: '' },
  { field: 'STATE_CD', sourceType: 'Integer', maxLength: null, disposition: 'NORMALIZE', target: 'parcel.characteristics.state_code', note: '' },
  { field: 'TORRENS_TYP', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.torrens_type', note: 'Current title type.' },
  { field: 'HOUSE_NO', sourceType: 'Integer', maxLength: null, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Situs house number. Evidence only: an address never resolves a property.' },
  { field: 'FRAC_HOUSE_NO', sourceType: 'String', maxLength: 3, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Fractional house number.' },
  { field: 'STREET_NM', sourceType: 'String', maxLength: 20, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Situs street name.' },
  { field: 'CONDO_NO', sourceType: 'String', maxLength: 5, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Condominium unit designation.' },
  { field: 'MAILING_MUNIC_CD', sourceType: 'String', maxLength: 2, disposition: 'RESTRICTED', target: 'contact_observation.mailing_address', note: 'Part of the taxpayer mailing address. Personal; restricted plane only.' },
  { field: 'MAILING_MUNIC_NM', sourceType: 'String', maxLength: 16, disposition: 'RESTRICTED', target: 'contact_observation.mailing_address', note: 'Part of the taxpayer mailing address. Personal; restricted plane only.' },
  { field: 'ZIP_CD', sourceType: 'String', maxLength: 5, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Retained as TEXT: leading zeros are significant.' },
  { field: 'MULTI_ADDR_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.multi_address_indicator', note: 'Flags a parcel carrying several addresses; a reason not to trust one address as identity.' },
  { field: 'OWNER_NM', sourceType: 'String', maxLength: 35, disposition: 'CANONICALIZE', target: 'party_observation[assessor_owner_of_record]', note: 'Owner of record on the assessor roll. An observation, never a deed-derived ownership history.' },
  { field: 'TAXPAYER_NM', sourceType: 'String', maxLength: 28, disposition: 'CANONICALIZE', target: 'party_observation[assessor_taxpayer]', note: 'The source defines this as "Taxpayer Name and Mailing Address Line 1" - it packs a name and an address line into one field. Only line 1 is treated as a name, and that reading is recorded as source-formatted rather than parsed.' },
  { field: 'TAXPAYER_NM_1', sourceType: 'String', maxLength: 28, disposition: 'RESTRICTED', target: 'contact_observation.mailing_address', note: 'Taxpayer mailing address line 2. Personal; restricted plane only.' },
  { field: 'TAXPAYER_NM_2', sourceType: 'String', maxLength: 28, disposition: 'RESTRICTED', target: 'contact_observation.mailing_address', note: 'Taxpayer mailing address line 3. Personal; restricted plane only.' },
  { field: 'TAXPAYER_NM_3', sourceType: 'String', maxLength: 28, disposition: 'RESTRICTED', target: 'contact_observation.mailing_address', note: 'Taxpayer mailing address line 4. Personal; restricted plane only.' },
  { field: 'MUNIC_CD', sourceType: 'String', maxLength: 2, disposition: 'NORMALIZE', target: 'parcel.geography.municipality_code', note: '' },
  { field: 'MUNIC_NM', sourceType: 'String', maxLength: 16, disposition: 'CANONICALIZE', target: 'property_identifier[normalized_address]', note: 'Municipality of the property itself.' },
  { field: 'SCHOOL_DIST_NO', sourceType: 'String', maxLength: 3, disposition: 'NORMALIZE', target: 'parcel.geography.school_district', note: '' },
  { field: 'WATERSHED_NO', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.geography.watershed', note: '' },
  { field: 'SEWER_DIST_NO', sourceType: 'String', maxLength: 2, disposition: 'NORMALIZE', target: 'parcel.geography.sewer_district', note: '' },
  { field: 'TIF_PROJECT_NO', sourceType: 'String', maxLength: 4, disposition: 'NORMALIZE', target: 'parcel.geography.tif_project', note: '' },
  { field: 'PROPERTY_STATUS_CD', sourceType: 'String', maxLength: 1, disposition: 'CANONICALIZE', target: 'parcel_snapshot_observation.sourceStatusCode', note: '0 current, 3 non-current, D in process. A non-current parcel is present in the snapshot, which is not the same as absent from it.' },
  { field: 'FORFEIT_LAND_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.forfeited_land', note: '' },
  { field: 'CO_OP_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.cooperative', note: '' },
  { field: 'PRI_SEC_CODE', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.primary_secondary_code', note: 'Distinguishes the primary record for stacked multi-tax parcels.' },
  { field: 'ABBREV_ADDN_NM', sourceType: 'String', maxLength: 37, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: 'Plat/addition name.' },
  { field: 'ADDITION_NO', sourceType: 'String', maxLength: 5, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: '' },
  { field: 'LOT', sourceType: 'String', maxLength: 3, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: '' },
  { field: 'BLOCK', sourceType: 'String', maxLength: 3, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: '' },
  { field: 'METES_BNDS1', sourceType: 'String', maxLength: 37, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: 'Metes and bounds line 1 of 4.' },
  { field: 'METES_BNDS2', sourceType: 'String', maxLength: 37, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: 'Metes and bounds line 2 of 4.' },
  { field: 'METES_BNDS3', sourceType: 'String', maxLength: 37, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: 'Metes and bounds line 3 of 4.' },
  { field: 'METES_BNDS4', sourceType: 'String', maxLength: 37, disposition: 'CANONICALIZE', target: 'parcel.legalDescription', note: 'Metes and bounds line 4 of 4.' },
  { field: 'MORE_METES_BNDS_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.metes_bounds_truncated', note: 'Flags that the legal description is truncated in this feed.' },
  { field: 'ABSTR_TORRENS_CD', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.abstract_torrens_code', note: '' },
  { field: 'BUILD_YR', sourceType: 'String', maxLength: 4, disposition: 'HISTORIZE', target: 'property_characteristic_observation.yearBuilt', note: 'Corrected from time to time, so stored per snapshot rather than as an eternal fact.' },
  { field: 'SALE_DATE', sourceType: 'String', maxLength: 6, disposition: 'DERIVE_LATER', target: 'source_record.raw', note: 'The assessor roll echoes a last-sale date. Minnesota eCRV is the authoritative transfer source, so no transfer or sale event is derived from this field.' },
  { field: 'SALE_PRICE', sourceType: 'Integer', maxLength: null, disposition: 'DERIVE_LATER', target: 'source_record.raw', note: 'See SALE_DATE. Never emitted as a sale.' },
  { field: 'SALE_CODE', sourceType: 'String', maxLength: 1, disposition: 'DERIVE_LATER', target: 'source_record.raw', note: 'Sale transaction type code; mapping deferred.' },
  { field: 'SALE_CODE_NAME', sourceType: 'String', maxLength: 50, disposition: 'DERIVE_LATER', target: 'source_record.raw', note: 'Sale transaction type label; mapping deferred.' },
  { field: 'PARCEL_AREA', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'property_characteristic_observation.parcelAreaSqFt', note: 'Area in square feet.' },
  { field: 'MKT_VAL_TOT', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.totalValue', note: 'Total estimated market value for the parcel.' },
  { field: 'TAXABLE_VAL_TOT', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.taxableValue', note: '' },
  { field: 'NET_IMPRV_AMT', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.net_improvement', note: '' },
  { field: 'TOT_NET_TAX', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.total_net_tax', note: '' },
  { field: 'TOT_SPEC_TAX', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.total_special_tax', note: '' },
  { field: 'TAX_TOT', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.tax_total', note: '' },
  { field: 'NET_TAX_PD', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.net_tax_paid', note: '' },
  { field: 'TOT_PENALTY_PD', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.total_penalty_paid', note: '' },
  { field: 'EARLIEST_DELQ_YR', sourceType: 'String', maxLength: 2, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.earliest_delinquent_year', note: 'Two-digit year as the source states it. Not expanded to four digits: the century is not stated and guessing it would invent data.' },
  { field: 'COMP_JUDG_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.composite_judgment', note: '' },
  { field: 'MTG_CO_NBR', sourceType: 'String', maxLength: 3, disposition: 'NORMALIZE', target: 'parcel.characteristics.mortgage_company_number', note: 'An escrow servicer code, not a lien or a lender identity.' },
  { field: 'GR_ACRE_OPEN_SPACE_CD', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.green_acres_open_space', note: '' },
  { field: 'PETITION_REVIEW_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.petition_review_pending', note: '' },
  { field: 'TAX_ADJ_PEND_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.tax_adjustment_pending', note: '' },
  { field: 'DIV_PEND_IND', sourceType: 'String', maxLength: 1, disposition: 'NORMALIZE', target: 'parcel.characteristics.division_pending', note: 'Signals a pending parcel split; a reason not to treat a later absence as retirement.' },
  { field: 'PR_TYP_CD1', sourceType: 'String', maxLength: 2, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeCode', note: 'Property type code for sub-record 1.' },
  { field: 'PR_TYP_NM1', sourceType: 'String', maxLength: 29, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeName', note: 'Property type name for sub-record 1.' },
  { field: 'HMSTD_CD1', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.homesteadCode', note: 'Homestead code for sub-record 1. An occupancy classification for tax purposes, not a residency fact.' },
  { field: 'OWNER_PCT1', sourceType: 'Single', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.owner_percent', note: 'Ownership percentage for sub-record 1.' },
  { field: 'CONT_IND1', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.contiguous', note: 'Contiguous indicator for sub-record 1.' },
  { field: 'LAND_MV1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.landValue', note: 'Land market value for sub-record 1.' },
  { field: 'BLDG_MV1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.buildingValue', note: 'Building market value for sub-record 1.' },
  { field: 'MACH_MV1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.machineryValue', note: 'Machinery market value for sub-record 1.' },
  { field: 'TOTAL_MV1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.totalValue', note: 'Total market value for sub-record 1.' },
  { field: 'QUAL_IMPR1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.qualifying_improvement', note: 'Qualifying improvement for sub-record 1.' },
  { field: 'VET_EXCL1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.veteran_exclusion', note: 'Veteran exclusion for sub-record 1.' },
  { field: 'HMS_EXCL1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.homestead_exclusion', note: 'Homestead exclusion for sub-record 1.' },
  { field: 'NET_TC1', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTaxCapacity', note: 'Net tax capacity for sub-record 1.' },
  { field: 'NET_TAX1', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTax', note: 'Net tax for sub-record 1.' },
  { field: 'PR_TYP_CD2', sourceType: 'String', maxLength: 2, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeCode', note: 'Property type code for sub-record 2.' },
  { field: 'PR_TYP_NM2', sourceType: 'String', maxLength: 29, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeName', note: 'Property type name for sub-record 2.' },
  { field: 'HMSTD_CD2', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.homesteadCode', note: 'Homestead code for sub-record 2. An occupancy classification for tax purposes, not a residency fact.' },
  { field: 'OWNER_PCT2', sourceType: 'Single', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.owner_percent', note: 'Ownership percentage for sub-record 2.' },
  { field: 'CONT_IND2', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.contiguous', note: 'Contiguous indicator for sub-record 2.' },
  { field: 'LAND_MV2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.landValue', note: 'Land market value for sub-record 2.' },
  { field: 'BLDG_MV2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.buildingValue', note: 'Building market value for sub-record 2.' },
  { field: 'MACH_MV2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.machineryValue', note: 'Machinery market value for sub-record 2.' },
  { field: 'TOTAL_MV2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.totalValue', note: 'Total market value for sub-record 2.' },
  { field: 'QUAL_IMPR2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.qualifying_improvement', note: 'Qualifying improvement for sub-record 2.' },
  { field: 'VET_EXCL2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.veteran_exclusion', note: 'Veteran exclusion for sub-record 2.' },
  { field: 'HMS_EXCL2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.homestead_exclusion', note: 'Homestead exclusion for sub-record 2.' },
  { field: 'NET_TC2', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTaxCapacity', note: 'Net tax capacity for sub-record 2.' },
  { field: 'NET_TAX2', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTax', note: 'Net tax for sub-record 2.' },
  { field: 'PR_TYP_CD3', sourceType: 'String', maxLength: 2, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeCode', note: 'Property type code for sub-record 3.' },
  { field: 'PR_TYP_NM3', sourceType: 'String', maxLength: 29, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeName', note: 'Property type name for sub-record 3.' },
  { field: 'HMSTD_CD3', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.homesteadCode', note: 'Homestead code for sub-record 3. An occupancy classification for tax purposes, not a residency fact.' },
  { field: 'OWNER_PCT3', sourceType: 'Single', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.owner_percent', note: 'Ownership percentage for sub-record 3.' },
  { field: 'CONT_IND3', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.contiguous', note: 'Contiguous indicator for sub-record 3.' },
  { field: 'LAND_MV3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.landValue', note: 'Land market value for sub-record 3.' },
  { field: 'BLDG_MV3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.buildingValue', note: 'Building market value for sub-record 3.' },
  { field: 'MACH_MV3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.machineryValue', note: 'Machinery market value for sub-record 3.' },
  { field: 'TOTAL_MV3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.totalValue', note: 'Total market value for sub-record 3.' },
  { field: 'QUAL_IMPR3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.qualifying_improvement', note: 'Qualifying improvement for sub-record 3.' },
  { field: 'VET_EXCL3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.veteran_exclusion', note: 'Veteran exclusion for sub-record 3.' },
  { field: 'HMS_EXCL3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.homestead_exclusion', note: 'Homestead exclusion for sub-record 3.' },
  { field: 'NET_TC3', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTaxCapacity', note: 'Net tax capacity for sub-record 3.' },
  { field: 'NET_TAX3', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTax', note: 'Net tax for sub-record 3.' },
  { field: 'PR_TYP_CD4', sourceType: 'String', maxLength: 2, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeCode', note: 'Property type code for sub-record 4.' },
  { field: 'PR_TYP_NM4', sourceType: 'String', maxLength: 29, disposition: 'HISTORIZE', target: 'assessment_observation.propertyTypeName', note: 'Property type name for sub-record 4.' },
  { field: 'HMSTD_CD4', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.homesteadCode', note: 'Homestead code for sub-record 4. An occupancy classification for tax purposes, not a residency fact.' },
  { field: 'OWNER_PCT4', sourceType: 'Single', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.owner_percent', note: 'Ownership percentage for sub-record 4.' },
  { field: 'CONT_IND4', sourceType: 'String', maxLength: 1, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.contiguous', note: 'Contiguous indicator for sub-record 4.' },
  { field: 'LAND_MV4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.landValue', note: 'Land market value for sub-record 4.' },
  { field: 'BLDG_MV4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.buildingValue', note: 'Building market value for sub-record 4.' },
  { field: 'MACH_MV4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.machineryValue', note: 'Machinery market value for sub-record 4.' },
  { field: 'TOTAL_MV4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.totalValue', note: 'Total market value for sub-record 4.' },
  { field: 'QUAL_IMPR4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.qualifying_improvement', note: 'Qualifying improvement for sub-record 4.' },
  { field: 'VET_EXCL4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.veteran_exclusion', note: 'Veteran exclusion for sub-record 4.' },
  { field: 'HMS_EXCL4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.characteristics.homestead_exclusion', note: 'Homestead exclusion for sub-record 4.' },
  { field: 'NET_TC4', sourceType: 'Integer', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTaxCapacity', note: 'Net tax capacity for sub-record 4.' },
  { field: 'NET_TAX4', sourceType: 'Double', maxLength: null, disposition: 'HISTORIZE', target: 'assessment_observation.netTax', note: 'Net tax for sub-record 4.' },
  { field: 'Shape', sourceType: 'Geometry', maxLength: null, disposition: 'IGNORE_WITH_REASON', target: null, note: 'Parcel geometry is not retrieved in DF-0C (returnGeometry=false). Geometry belongs in geospatial storage, not in canonical operational tables, and pulling it would multiply artifact size for no DF-0C consumer.' },
  { field: 'Shape.STArea()', sourceType: 'Double', maxLength: null, disposition: 'IGNORE_WITH_REASON', target: null, note: 'Derived from geometry, which is not retrieved. PARCEL_AREA carries the county figure.' },
  { field: 'Shape.STLength()', sourceType: 'Double', maxLength: null, disposition: 'IGNORE_WITH_REASON', target: null, note: 'Derived from geometry, which is not retrieved.' },
  { field: 'LAT', sourceType: 'Double', maxLength: null, disposition: 'NORMALIZE', target: 'parcel.geography.latitude', note: 'Representative point supplied by the county.' },
  { field: 'LON', sourceType: 'Double', maxLength: null, disposition: 'NORMALIZE', target: 'parcel.geography.longitude', note: 'Representative point supplied by the county.' },
];

/**
 * Fields the interactive property-search UI shows that this dataset does NOT
 * contain. Recorded so the gap is documented rather than rediscovered, and so a
 * later phase knows precisely what it would have to go somewhere else for.
 */
export const HENNEPIN_ABSENT_FIELDS: readonly { field: string; note: string }[] = [
  { field: 'assessmentYear', note: 'No assessment-year column exists. Values are current-as-of-snapshot; the year is NOT inferred from the capture date.' },
  { field: 'livingArea / finishedSquareFeet', note: 'Building area is not in this layer. Only PARCEL_AREA (land) is published.' },
  { field: 'bedrooms / bathrooms / stories / rooms', note: 'Interior characteristics are not in this layer.' },
  { field: 'constructionType / quality / condition', note: 'Not in this layer.' },
  { field: 'effectiveYearBuilt', note: 'Only BUILD_YR is published.' },
  { field: 'units', note: 'Unit counts are not in this layer.' },
  { field: 'neighborhoodCode', note: 'Assessment neighbourhood is not in this layer.' },
  { field: 'exemptionDetail', note: 'Only VET_EXCL and HMS_EXCL amounts are published, not an exemption catalogue.' },
  { field: 'permits', note: 'Building permits are a separate county system; out of DF-0C scope.' },
  { field: 'ownerMailingStreetAddress', note: 'The taxpayer block packs name and address into four fixed lines (TAXPAYER_NM..NM_3); there is no discrete mailing street field.' },
];

const BY_FIELD = new Map(HENNEPIN_FIELD_MAP.map((f) => [f.field, f] as const));

export function hennepinFieldMapping(field: string): HennepinFieldMapping | undefined {
  return BY_FIELD.get(field);
}

export function hennepinMappedFields(): readonly string[] {
  return [...BY_FIELD.keys()].sort();
}

/** Fields safe to request from the service: everything except deliberate omissions. */
export function hennepinOutFields(): readonly string[] {
  return HENNEPIN_FIELD_MAP
    .filter((f) => f.disposition !== 'IGNORE_WITH_REASON')
    .map((f) => f.field);
}

/** Fields that must never reach canonical output. */
export function hennepinRestrictedFields(): readonly string[] {
  return HENNEPIN_FIELD_MAP.filter((f) => f.disposition === 'RESTRICTED').map((f) => f.field);
}

export function hennepinDispositionCounts(): Readonly<Record<HennepinDisposition, number>> {
  const counts = {
    KEEP_RAW: 0, NORMALIZE: 0, CANONICALIZE: 0, HISTORIZE: 0,
    DERIVE_LATER: 0, RESTRICTED: 0, IGNORE_WITH_REASON: 0,
  };
  for (const f of HENNEPIN_FIELD_MAP) counts[f.disposition] += 1;
  return counts;
}
