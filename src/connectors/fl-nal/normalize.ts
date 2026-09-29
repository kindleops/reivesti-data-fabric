/**
 * Florida NAL record → canonical rows.
 *
 * Built from ALLOWLISTS, never from "everything except". A column reaches a
 * canonical row only because this file names it; a column the field map calls
 * RESTRICTED is named here only to route it to the restricted plane — mailing
 * blocks — or not at all. So a publisher adding a sensitive column cannot leak
 * it by default: the drift check stops the run, and even past it, nothing here
 * would copy it.
 *
 * What the adapter knows that the contract cannot:
 *
 *  - **Three values, three slots.** JV is JUST value — the appraiser's opinion
 *    of market value on January 1. AV_* are ASSESSED values after the
 *    Save-Our-Homes and non-homestead caps. TV_* are TAXABLE values after
 *    exemptions. Each exists twice, for school and non-school levies. The
 *    canonical `totalValue` is JV; the other four are kept by name and never
 *    folded into a single "taxable value" that would be wrong for one levy.
 *  - **No tax bill.** The NAL carries the tax BASE (taxable values, exemptions,
 *    the taxing-authority code) but no levied amount. `netTax` is null because
 *    the publisher does not state it.
 *  - **Stage is a fact.** A preliminary roll is the appraiser's July statement;
 *    the final roll follows the value adjustment board. Every observation says
 *    which it came from.
 *  - **The sale echo is evidence for a sale, not a sale.** Up to two per row,
 *    "selected" by the Department for statistical analysis — "not necessarily
 *    based on chronological occurrence". They become ASSESSOR_SALE_ECHO
 *    observations that TRANSACTION_RESOLUTION matches onto the SDF's sales.
 */
import { deterministicId, contentDigest } from '../../core/hash.ts';
import {
  normalizeName,
  type AssessmentObservation,
  type CanonicalBundle,
  type CanonicalEvent,
  type Money,
  type PartyObservation,
  type Property,
  type PropertyCharacteristicObservation,
  type PropertyIdentifierObservation,
  type SaleObservation,
  type SourceEvidence,
} from '../../canonical/models.ts';
import { parcelObservationId, type ParcelSnapshotObservation, type SnapshotChangeKind } from '../../canonical/snapshot.ts';
import { contactObservationId, type ContactObservation } from '../../contact/contact-plane.ts';
import { canonicalAddress } from '../../canonical/address.ts';
import {
  NORMALIZATION_CONTRACT_VERSION,
  PARCEL_IDENTIFIER_EXTENSION,
  canonicalArea,
  canonicalMoney,
} from '../../canonical/normalization-contract.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { FL_PARCEL_IDENTIFIER_SCHEME } from '../fl-dor/identity.ts';
import { flEchoObservationId, flSaleObservation, saleSlotStated, type FlSaleFacts } from '../fl-dor/sales.ts';
import { readFlUseCode } from '../fl-dor/use-codes.ts';
import { FL_NAL_FIELD_MAP, FL_NAL_PROPERTY_EXEMPTIONS } from './field-map.ts';
import { flNalContentOf, type FlNalRecord } from './parse.ts';

export const FL_NAL_NORMALIZATION_VERSION = 'fl_nal_normalizer_1';

export type FlNalNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

/** Value columns kept as exact minor units by name. JV is also the canonical total. */
const VALUE_FIELDS: readonly string[] = [
  'JV', 'JV_CHNG', 'AV_SD', 'AV_NSD', 'TV_SD', 'TV_NSD',
  'JV_HMSTD', 'AV_HMSTD', 'JV_NON_HMSTD_RESD', 'AV_NON_HMSTD_RESD', 'JV_RESD_NON_RESD', 'AV_RESD_NON_RESD',
  'JV_CLASS_USE', 'AV_CLASS_USE', 'JV_H2O_RECHRGE', 'AV_H2O_RECHRGE', 'JV_CONSRV_LND', 'AV_CONSRV_LND',
  'JV_HIST_COM_PROP', 'AV_HIST_COM_PROP', 'JV_HIST_SIGNF', 'AV_HIST_SIGNF', 'JV_WRKNG_WTRFNT', 'AV_WRKNG_WTRFNT',
  'NCONST_VAL', 'DEL_VAL', 'LND_VAL', 'SPEC_FEAT_VAL',
];

/** Codes and descriptive columns carried verbatim onto the characteristics observation. */
const VERBATIM_FIELDS: readonly string[] = [
  'FILE_T', 'BAS_STRT', 'ATV_STRT', 'GRP_NO', 'PA_UC', 'SPASS_CD', 'JV_CHNG_CD', 'PAR_SPLT', 'DISTR_CD', 'DISTR_YR',
  'LND_UNTS_CD', 'NO_LND_UNTS', 'DT_LAST_INSPT', 'IMP_QUAL', 'CONST_CLASS', 'EFF_YR_BLT', 'TOT_LVG_AREA', 'NO_BULDNG',
  'NO_RES_UNTS', 'FIDU_CD', 'S_LEGAL', 'MKT_AR', 'NBRHD_CD', 'PUBLIC_LND', 'TAX_AUTH_CD', 'TWN', 'RNG', 'SEC',
  'CENSUS_BK', 'ALT_KEY', 'RS_ID', 'MP_ID', 'SPC_CIR_CD', 'SPC_CIR_YR', 'SPC_CIR_TXT',
];

/** LND_UNTS_CD → the unit NO_LND_UNTS is counted in (guide field 42). */
const LAND_UNITS: Readonly<Record<string, string>> = {
  '1': 'ACRE', '2': 'SQUARE_FOOT', '3': 'FRONT_FOOT', '4': 'FRONT_FOOT', '5': 'LOT', '6': 'COMBINATION',
};

export type FlNalNormalized = {
  readonly bundle: CanonicalBundle;
  readonly contacts: readonly ContactObservation[];
};

export function normalizeFlNalRecord(
  record: FlNalRecord,
  evidence: SourceEvidence,
  ctx: FlNalNormalizeContext,
  /** The digest change detection used for this row; computed once, by the parse session. */
  rowContentDigest: string = contentDigest(flNalContentOf(record)),
): FlNalNormalized {
  const f = record.fields;
  const propertyId = deterministicPropertyId(record);
  const assessmentYear = yearOf(f['ASMNT_YR']);
  const values = moneyFacts(f);
  const situs = situsOf(f);

  // -- identifiers ---------------------------------------------------------
  const identifiers: PropertyIdentifierObservation[] = [{
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: record.parcelId,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    // The appraiser's own parcel number, not re-keyed by the Department. The
    // ROLL may be preliminary; the identifier is the county's.
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  }];
  const stateParcelId = f['STATE_PAR_ID'];
  if (stateParcelId !== undefined) {
    // DOR's uniform statewide code, "cross-referenced longitudinally when a
    // county's coding system changes". Attached to this property by the same
    // row; never a join key, because `source_property_key` does not resolve.
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'state_par_id'),
      identifierType: 'source_property_key',
      value: stateParcelId,
      normalizedValue: stateParcelId.toUpperCase(),
      countyFips: record.countyFips,
      sourceDesignation: 'secondary',
      finality: 'final',
      resolutionState: 'resolved',
      propertyId,
      resolutionMethod: 'same_source_row',
      evidence,
    });
  }
  if (situs.key !== null) {
    identifiers.push({
      observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'address', situs.key),
      identifierType: 'normalized_address',
      value: situs.text as string,
      normalizedValue: situs.key,
      countyFips: record.countyFips,
      sourceDesignation: 'unspecified',
      finality: 'unknown',
      // An address never resolves identity on its own.
      resolutionState: 'unresolved',
      propertyId: null,
      resolutionMethod: null,
      evidence,
    });
  }

  // -- party: the owner of record, by name only ------------------------------
  const parties: PartyObservation[] = [];
  const ownerName = f['OWN_NAME'];
  const ownerObservationId = ownerName !== undefined
    ? deterministicId('partyobs', ctx.sourceId, evidence.sourceRecordId, 'OWN_NAME', ctx.snapshotId)
    : null;
  if (ownerName !== undefined && ownerObservationId !== null) {
    parties.push({
      observationId: ownerObservationId,
      // The roll does not say whether the owner is a person or a company, so
      // neither does the Fabric. Nothing merges owners by name.
      kind: 'unknown',
      role: 'assessor_owner_of_record',
      sourceRole: 'fl_dor_nal:assessor_owner_of_record:OWN_NAME',
      rawName: ownerName,
      normalizedName: normalizeName(ownerName),
      nameParts: { first: null, middle: null, last: null, suffix: null, organizationName: null },
      address: null,
      foreignAddress: null,
      protectedIdentity: false,
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });
  }

  // -- restricted plane only -------------------------------------------------
  const contacts: ContactObservation[] = [];
  const contact = (type: ContactObservation['contactType'], value: string, party: string | null): void => {
    contacts.push({
      contactObservationId: contactObservationId(ctx.sourceId, evidence.sourceRecordId, party, type, value),
      partyId: null,
      partyObservationId: party,
      contactType: type,
      value,
      sourceId: ctx.sourceId,
      sourceRecordId: evidence.sourceRecordId,
      observedAt: evidence.observedAt,
      confidence: 'source_stated',
      permittedUse: 'record_only',
      status: 'observed',
      evidence,
    });
  };
  const mailing = joinParts([f['OWN_ADDR1'], f['OWN_ADDR2'], f['OWN_CITY'], f['OWN_STATE'], f['OWN_ZIPCD']]);
  if (mailing !== null) contact('mailing_address', mailing, ownerObservationId);
  if (f['OWN_STATE_DOM'] !== undefined) contact('contact_note', `state_of_domicile:${f['OWN_STATE_DOM']}`, ownerObservationId);
  const careOf = joinParts([f['FIDU_NAME'], f['FIDU_ADDR1'], f['FIDU_ADDR2'], f['FIDU_CITY'], f['FIDU_STATE'], f['FIDU_ZIPCD']]);
  if (careOf !== null) contact('care_of_block', careOf, ownerObservationId);

  // -- assessment --------------------------------------------------------------
  const useCode = readFlUseCode(f['DOR_UC']);
  const exemptions: Record<string, string> = {};
  for (const name of FL_NAL_PROPERTY_EXEMPTIONS) {
    const v = values.byField[name];
    if (v !== undefined && v !== null) exemptions[name] = v;
  }
  const assessments: AssessmentObservation[] = [{
    observationId: deterministicId('assess', ctx.snapshotId, evidence.sourceRecordId, '1'),
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    snapshotId: ctx.snapshotId,
    assessmentYear,
    tier: 1,
    propertyTypeCode: useCode.code,
    propertyTypeName: useCode.known?.name ?? null,
    homesteadCode: null,
    landValue: moneyOf(values.byField['LND_VAL']),
    buildingValue: null,
    machineryValue: null,
    // JUST value: the appraiser's opinion of market value on January 1.
    totalValue: moneyOf(values.byField['JV']),
    // Two taxable values exist, for school and non-school levies; neither is
    // "the" taxable value, so the slot stays empty and both are kept by name.
    taxableValue: null,
    netTaxCapacity: null,
    // The NAL states no levied tax.
    netTax: null,
    characteristics: {
      value_basis: 'FL_JUST_VALUE_JAN1',
      roll_stage: record.stage,
      assessment_year: assessmentYear,
      use_code_category: useCode.known?.category ?? null,
      use_code_known: useCode.code === null ? null : useCode.known !== null,
      values_minor: values.present,
      property_exemptions_minor: exemptions,
      invalid_money_fields: values.invalid,
      tax_authority_code: f['TAX_AUTH_CD'] ?? null,
    },
    evidence,
  }];

  // -- characteristics -------------------------------------------------------
  const verbatim: Record<string, string> = {};
  for (const name of VERBATIM_FIELDS) if (f[name] !== undefined) verbatim[name] = f[name] as string;
  const landUnitCode = f['LND_UNTS_CD'];
  const area = canonicalArea(f['LND_SQFOOT'] ?? '', 'square_feet');
  const characteristics: PropertyCharacteristicObservation[] = [{
    observationId: deterministicId('charobs', ctx.snapshotId, evidence.sourceRecordId),
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    snapshotId: ctx.snapshotId,
    yearBuilt: plausibleYear(f['ACT_YR_BLT']),
    parcelAreaSqFt: area.present ? area.squareFeet : null,
    characteristics: {
      roll_stage: record.stage,
      roll_year: assessmentYear,
      source_file_sha256: record.fileSha256,
      source_file_last_modified: record.fileLastModified,
      effective_year_built: plausibleYear(f['EFF_YR_BLT']),
      land_unit: landUnitCode !== undefined ? LAND_UNITS[landUnitCode] ?? 'UNKNOWN_CODE' : null,
      situs_address: situs.text,
      canonical_address_key: situs.canonicalKey,
      canonical_area_square_feet: area.present ? area.squareFeet : null,
      canonical_area_source_field: area.present ? 'LND_SQFOOT' : null,
      canonical_area_absent_reason: area.present ? null : area.reason,
      verbatim,
      parcel_match_key: record.matchKey,
      normalization_contract: NORMALIZATION_CONTRACT_VERSION,
      parcel_identifier_extension: PARCEL_IDENTIFIER_EXTENSION,
      parcel_identifier_scheme: FL_PARCEL_IDENTIFIER_SCHEME,
    },
    evidence,
  }];

  // -- sale echoes -------------------------------------------------------------
  const saleObservations: SaleObservation[] = [];
  for (const slot of [1, 2] as const) {
    const facts: FlSaleFacts = {
      publisherSaleId: null,
      year: f[`SALE_YR${slot}`], month: f[`SALE_MO${slot}`], price: f[`SALE_PRC${slot}`],
      qualificationCode: f[`QUAL_CD${slot}`], vacantImproved: f[`VI_CD${slot}`],
      book: f[`OR_BOOK${slot}`], page: f[`OR_PAGE${slot}`], clerk: f[`CLERK_NO${slot}`],
      multiParcel: f[`MULTI_PAR_SAL${slot}`],
    };
    if (!saleSlotStated(facts)) continue;
    saleObservations.push(flSaleObservation({
      kind: 'ASSESSOR_SALE_ECHO',
      semanticClass: 'FL_DOR_NAL_SALE_ECHO',
      observationId: flEchoObservationId(ctx.sourceId, ctx.snapshotId, evidence.sourceRecordId, slot),
      propertyId,
      countyFips: record.countyFips,
      normalizedParcel: record.normalizedParcel,
      ordinal: slot,
      facts,
      evidence,
    }));
  }

  // -- snapshot + property + events ----------------------------------------------
  const parcelObservations: ParcelSnapshotObservation[] = [{
    observationId: parcelObservationId(ctx.snapshotId, evidence.sourceRecordId),
    snapshotId: ctx.snapshotId,
    sourceId: ctx.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    propertyId,
    changeKind: ctx.changeKind,
    // The digest change detection uses: publisher facts, not file provenance.
    contentDigest: rowContentDigest,
    changedFieldGroups: ctx.changedFieldGroups,
    sourceStatusCode: null,
    runId: evidence.runId,
    observedAt: evidence.observedAt,
  }];
  const property: Property = { propertyId, countyFips: record.countyFips, createdFromMethod: 'county_parcel_authoritative' };

  // Payloads are codes, not prose: the prose is in docs/FLORIDA-DOR-NAL.md, and
  // repeating it on eleven million rows would cost gigabytes and say nothing new.
  const events: CanonicalEvent[] = [
    event('PARCEL_OBSERVED', propertyId, evidence, [], { countyFips: record.countyFips, semantics: 'FL_NAL_ROLL_ROW', rollStage: record.stage }),
    event('ASSESSMENT_OBSERVED', propertyId, evidence, [String(assessmentYear ?? '')], {
      assessmentYear, rollStage: record.stage, valueBasis: 'FL_JUST_VALUE_JAN1', justValueMinor: values.byField['JV'] ?? null,
    }),
    ...parties.map((p) => event('ASSESSOR_OWNER_OBSERVED', propertyId, evidence, [p.observationId], { semantics: 'FL_NAL_OWNER_OF_RECORD' })),
  ];

  return {
    bundle: {
      transaction: {
        transactionId: deterministicId('parcelroll', evidence.sourceId, evidence.sourceRecordId),
        sourceId: evidence.sourceId,
        sourceRecordId: evidence.sourceRecordId,
        jurisdictionId: countyJurisdictionId(record.countyFips),
        countyFips: record.countyFips,
        transferDate: null,
        recordingDate: null,
        recordedDocumentNumber: null,
        instrumentTypeCode: null,
        conveyanceTypeCode: null,
        ownershipTypeCode: null,
        rightsRetainedCode: null,
        totalConsideration: null,
        downPayment: null,
        sellerPaidPoints: null,
        delinquentSpecialAssessmentsPaidByBuyer: null,
        personalPropertyIncludedInTotal: null,
        legalDescription: null,
        characteristics: { record_kind: 'parcel_roll_row', property_id: propertyId },
        // A roll row is not a transaction. Its sale echoes are sale evidence,
        // carried as saleObservations for TRANSACTION_RESOLUTION.
        analyticalMetadata: { semantics: 'FL_NAL_ROLL_ROW_NOT_A_TRANSACTION' },
        evidence,
      },
      parties,
      transactionParties: [],
      propertyIdentifiers: identifiers,
      transactionParcels: [],
      properties: [property],
      financing: [],
      events,
      assessments,
      characteristics,
      parcelObservations,
      saleObservations,
    },
    contacts,
  };
}

// ---------------------------------------------------------------------------

function deterministicPropertyId(record: FlNalRecord): string {
  return deterministicId('prop', 'county_parcel', record.countyFips, record.normalizedParcel);
}

function event(
  type: CanonicalEvent['eventType'],
  subjectId: string,
  evidence: SourceEvidence,
  discriminators: readonly string[],
  payload: Readonly<Record<string, unknown>>,
): CanonicalEvent {
  return {
    eventId: deterministicId('event', type, subjectId, ...discriminators, evidence.observedAt),
    eventType: type,
    occurredAt: evidence.observedAt,
    subjectId,
    payload,
    evidence,
  };
}

type MoneyFacts = {
  /** Exact minor units by field; null when the field was blank. */
  readonly byField: Readonly<Record<string, string | null>>;
  /** The non-blank values only, for the observation. */
  readonly present: Readonly<Record<string, string>>;
  readonly invalid: readonly string[];
};

function moneyFacts(f: Readonly<Record<string, string>>): MoneyFacts {
  const byField: Record<string, string | null> = {};
  const present: Record<string, string> = {};
  const invalid: string[] = [];
  for (const name of [...VALUE_FIELDS, ...FL_NAL_PROPERTY_EXEMPTIONS]) {
    const raw = f[name];
    if (raw === undefined) { byField[name] = null; continue; }
    const money = canonicalMoney(raw, 'major_units');
    if (!money.present) { byField[name] = null; invalid.push(name); continue; }
    byField[name] = money.amountMinor.toString();
    if (VALUE_FIELDS.includes(name)) present[name] = byField[name] as string;
  }
  return { byField, present, invalid };
}

/** Exact minor units → the model's Money, refusing anything past 2^53 rather than rounding it. */
function moneyOf(minor: string | null | undefined): Money | null {
  if (minor === null || minor === undefined) return null;
  const n = Number(minor);
  return Number.isSafeInteger(n) ? { amountMinor: n, currency: 'USD' } : null;
}

function yearOf(raw: string | undefined): number | null {
  return raw !== undefined && /^\d{4}$/.test(raw) ? Number(raw) : null;
}

/** A four-digit year the contract can use; anything else stays null. */
function plausibleYear(raw: string | undefined): number | null {
  const y = yearOf(raw);
  return y !== null && y >= 1600 && y <= 2100 ? y : null;
}

function joinParts(parts: readonly (string | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => p !== undefined && p !== '');
  return kept.length === 0 ? null : kept.join(', ');
}

/**
 * The situs: the address as published, plus the comparison key the resolution
 * fold uses. The key includes the city and ZIP, so "100 MAIN ST" in two towns
 * of one county is two addresses, not a shared-address conflict.
 */
function situsOf(f: Readonly<Record<string, string>>): { readonly text: string | null; readonly key: string | null; readonly canonicalKey: string | null } {
  const line1 = f['PHY_ADDR1'];
  if (line1 === undefined || !/[A-Z0-9]/i.test(line1)) return { text: null, key: null, canonicalKey: null };
  const text = joinParts([line1, f['PHY_ADDR2'], f['PHY_CITY'], f['PHY_ZIPCD']]) as string;
  const canonical = canonicalAddress({
    houseNumber: null, houseNumberPrefix: null, houseNumberSuffix: null, preDirectional: null, preType: null,
    streetName: [line1, f['PHY_ADDR2']].filter((x) => x !== undefined).join(' '),
    postType: null, postDirectional: null, unitType: null, unitId: null,
    city: f['PHY_CITY'] ?? null, state: 'FL', postalCode: f['PHY_ZIPCD'] ?? null, postalCodeExtension: null,
  });
  return { text, key: normalizeName(text), canonicalKey: canonical.present ? canonical.comparisonKey : null };
}

/** Field groups for change reporting, from the field map's own grouping. */
const GROUPS: ReadonlyMap<string, readonly string[]> = (() => {
  const out = new Map<string, string[]>();
  for (const spec of FL_NAL_FIELD_MAP) {
    if (spec.field === 'SEQ_NO') continue;
    const list = out.get(spec.group) ?? [];
    list.push(spec.field);
    out.set(spec.group, list);
  }
  return out;
})();

export function flNalFieldGroups(record: FlNalRecord): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [group, fields] of GROUPS) {
    out[group] = deterministicId('fg', ...fields.map((name) => record.fields[name] ?? ''));
  }
  return out;
}
