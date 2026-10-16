/**
 * Florida SDF row → canonical rows: one FL_DOR_SALE_OBSERVATION.
 *
 * What the row IS: the property appraiser's record that this parcel changed
 * ownership in this month, at a price derived from the documentary stamp tax,
 * and how the appraiser qualified the sale.
 *
 * What it is NOT, and so what is never emitted:
 *
 *  - a deed or recorded instrument — no instrument type, no grantor, no
 *    grantee; the recording reference is kept as a reference and nothing more;
 *  - a transfer declaration — nobody declared anything on it;
 *  - an arm's-length finding — the qualification code is the appraiser's
 *    ratio-study decision, kept verbatim with the dimensions its official
 *    wording supports, and "qualified" never becomes "comparable";
 *  - a declared consideration. The price lives in `transfer_considerations`
 *    with kind SALE_PRICE_DOC_STAMP_DERIVED, and `totalConsideration` stays
 *    null, so no query can mistake a stamp-derived figure for a price the
 *    parties stated.
 *
 * No party is observed: the SDF names none.
 */
import { deterministicId } from '../../core/hash.ts';
import type {
  CanonicalBundle,
  CanonicalEvent,
  PropertyIdentifierObservation,
  SourceEvidence,
  TransferClassificationRow,
  TransferConsideration,
} from '../../canonical/models.ts';
import { parcelObservationId, type ParcelSnapshotObservation, type SnapshotChangeKind } from '../../canonical/snapshot.ts';
import { NORMALIZATION_CONTRACT_VERSION, PARCEL_IDENTIFIER_EXTENSION } from '../../canonical/normalization-contract.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { FL_PARCEL_IDENTIFIER_SCHEME } from '../fl-dor/identity.ts';
import {
  FL_SALE_CHANGE_CODES,
  flQualificationClassifications,
  readFlMultiParcel,
  readFlQualification,
  readFlVacantImproved,
} from '../fl-dor/qualification.ts';
import { FL_PRICE_KIND, flSaleObservation } from '../fl-dor/sales.ts';
import { readFlUseCode } from '../fl-dor/use-codes.ts';
import type { FlSdfRecord } from './parse.ts';

export const FL_SDF_NORMALIZATION_VERSION = 'fl_sdf_normalizer_1';
export const FL_SALE_SEMANTIC_CLASS = 'FL_DOR_SALE_OBSERVATION';

export type FlSdfNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export function normalizeFlSdfRecord(
  record: FlSdfRecord,
  evidence: SourceEvidence,
  ctx: FlSdfNormalizeContext,
  rowContentDigest: string,
): { readonly bundle: CanonicalBundle; readonly extraRows: Readonly<Record<string, readonly unknown[]>> } {
  const f = record.fields;
  const propertyId = deterministicId('prop', 'county_parcel', record.countyFips, record.normalizedParcel);
  // One observation per release: the canonical SALE — stable across releases —
  // is TRANSACTION_RESOLUTION's, keyed by the appraiser's sale identifier.
  const transactionId = deterministicId('flsale', ctx.snapshotId, evidence.sourceRecordId);

  const identifier: PropertyIdentifierObservation = {
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: record.parcelId,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    finality: 'final',
    // A sale names a parcel; it does not define one. Only the roll and the map
    // resolve identity. A sale whose parcel neither lists stays provisional.
    resolutionState: 'provisional',
    propertyId,
    resolutionMethod: 'county_parcel_reference',
    evidence,
  };

  const sale = flSaleObservation({
    kind: 'SALE_OBSERVATION',
    semanticClass: FL_SALE_SEMANTIC_CLASS,
    observationId: transactionId,
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    ordinal: 1,
    facts: {
      publisherSaleId: record.saleId,
      year: f['SALE_YR'], month: f['SALE_MO'], price: f['SALE_PRC'],
      qualificationCode: f['QUAL_CD'], vacantImproved: f['VI_CD'],
      book: f['OR_BOOK'], page: f['OR_PAGE'], clerk: f['CLERK_NO'],
      multiParcel: f['MULTI_PAR_SAL'],
    },
    evidence,
  });
  const qualification = readFlQualification(f['QUAL_CD']);
  const useCode = readFlUseCode(f['DOR_UC']);
  const saleChange = f['SAL_CHG_CD'];

  const consideration: TransferConsideration = {
    transactionId,
    kind: FL_PRICE_KIND,
    amountMinor: sale.priceMinor,
    absentReason: sale.priceAbsentReason,
    currency: 'USD',
    sourceField: 'SALE_PRC',
    // Observed: the PUBLISHER derived it from the stamps; Reivesti computed nothing.
    derivationVersion: null,
  };
  const classifications: TransferClassificationRow[] = flQualificationClassifications(qualification)
    .map((c) => ({ transactionId, classification: c.classification, primary: c.primary, basisField: 'QUAL_CD', basisValue: c.basisValue }));

  const events: CanonicalEvent[] = [{
    eventId: deterministicId('event', 'PROPERTY_SALE_OBSERVED', transactionId),
    eventType: 'PROPERTY_SALE_OBSERVED',
    occurredAt: sale.saleMonth === null ? null : `${sale.saleMonth}-01`,
    subjectId: propertyId,
    payload: {
      semantics: FL_SALE_SEMANTIC_CLASS,
      saleMonth: sale.saleMonth,
      occurredAtPrecision: 'month',
      qualificationCode: sale.qualificationCode,
      priceKind: FL_PRICE_KIND,
    },
    evidence,
  }];

  const parcelObservations: ParcelSnapshotObservation[] = [{
    observationId: parcelObservationId(ctx.snapshotId, evidence.sourceRecordId),
    snapshotId: ctx.snapshotId,
    sourceId: ctx.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    propertyId,
    changeKind: ctx.changeKind,
    contentDigest: rowContentDigest,
    changedFieldGroups: ctx.changedFieldGroups,
    sourceStatusCode: null,
    runId: evidence.runId,
    observedAt: evidence.observedAt,
  }];

  const bundle: CanonicalBundle = {
    transaction: {
      transactionId,
      sourceId: ctx.sourceId,
      sourceRecordId: evidence.sourceRecordId,
      jurisdictionId: countyJurisdictionId(record.countyFips),
      countyFips: record.countyFips,
      // The SDF states a month, not a day. The month is on the sale observation
      // and in `characteristics`; no date column is given a day that was never published.
      transferDate: null,
      recordingDate: null,
      // The reference the appraiser recorded, as a reference. No instrument is created from it.
      recordedDocumentNumber: sale.recordingReference,
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
      characteristics: {
        semantic_class: FL_SALE_SEMANTIC_CLASS,
        publisher_sale_id: record.saleId,
        sale_month: sale.saleMonth,
        sale_date_precision: 'month',
        price_kind: FL_PRICE_KIND,
        price_minor: sale.priceMinor,
        price_absent_reason: sale.priceAbsentReason,
        qualification_code: qualification.code,
        qualification_status: qualification.status,
        qualification_known: qualification.known,
        ratio_study: qualification.ratioStudy,
        vacant_improved: readFlVacantImproved(f['VI_CD']),
        multi_parcel: readFlMultiParcel(f['MULTI_PAR_SAL']),
        sale_change: saleChange === undefined ? null : FL_SALE_CHANGE_CODES[saleChange] ?? 'UNKNOWN_CODE',
        sale_change_code: saleChange ?? null,
        use_code: useCode.code,
        use_code_known: useCode.code === null ? null : useCode.known !== null,
        assessment_year: f['ASMNT_YR'] !== undefined && /^\d{4}$/.test(f['ASMNT_YR']) ? Number(f['ASMNT_YR']) : null,
        roll_stage: record.stage,
        source_file_sha256: record.fileSha256,
        source_file_last_modified: record.fileLastModified,
        state_parcel_id: f['STATE_PARCEL_ID'] ?? null,
        normalization_contract: NORMALIZATION_CONTRACT_VERSION,
        parcel_identifier_extension: PARCEL_IDENTIFIER_EXTENSION,
        parcel_identifier_scheme: FL_PARCEL_IDENTIFIER_SCHEME,
      },
      analyticalMetadata: {
        qualification_basis: qualification.basis,
        qualification_facts: qualification.facts,
        qualification_list_version: qualification.listVersion,
        comparable: 'NOT_ASSERTED',
      },
      evidence,
    },
    parties: [],
    transactionParties: [],
    propertyIdentifiers: [identifier],
    transactionParcels: [{ transactionId, propertyIdentifierObservationId: identifier.observationId, ordinal: 1 }],
    properties: [],
    financing: [],
    events,
    parcelObservations,
    saleObservations: [sale],
  };
  return { bundle, extraRows: { transfer_considerations: [consideration], transfer_classifications: classifications } };
}

export function flSdfFieldGroups(record: FlSdfRecord): Readonly<Record<string, string>> {
  const f = record.fields;
  const g = (...names: string[]): string => deterministicId('fg', ...names.map((n) => f[n] ?? ''));
  return {
    identity: g('CO_NO', 'PARCEL_ID', 'SALE_ID_CD', 'MP_ID', 'STATE_PARCEL_ID'),
    sale: g('SALE_YR', 'SALE_MO', 'SALE_PRC', 'QUAL_CD', 'VI_CD', 'MULTI_PAR_SAL', 'SAL_CHG_CD'),
    recording: g('OR_BOOK', 'OR_PAGE', 'CLERK_NO'),
    assessment: g('ASMNT_YR', 'ATV_STRT', 'GRP_NO', 'DOR_UC'),
    geography: g('NBRHD_CD', 'MKT_AR', 'CENSUS_BK'),
    provenance: g('RS_ID'),
  };
}
