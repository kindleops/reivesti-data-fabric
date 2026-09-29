/**
 * Florida PAR record → canonical rows. Lean on purpose.
 *
 * The map contributes three things nothing else in Florida can:
 *
 *  1. **Identity from the parcel fabric.** The county's own parcel number on
 *     its own polygon — authoritative, and the same key the NAL computes, so
 *     the two converge on one property without consulting each other.
 *  2. **Where the parcel is and how big.** A geometry summary — shape type,
 *     parts, vertices, bounding box, area and centroid — in the county file's
 *     own coordinate system, named from its .prj. Polygons themselves stay in
 *     the retained archive; canonical polygons are a later phase. The area is a
 *     planimetric GIS area Reivesti computed, labelled as such, never the
 *     assessor's land area (that is the NAL's LND_SQFOOT) and never a legal
 *     acreage.
 *  3. **Support for the sale record.** The joined sale echo, as
 *     FL_DOR_PAR_SALE_ECHO observations that TRANSACTION_RESOLUTION attaches to
 *     the SDF's sale — a third statement of one sale, never a second sale.
 *
 * Everything else the .dbf carries is the NAL's, projected once, from the NAL.
 */
import { deterministicId } from '../../core/hash.ts';
import type {
  CanonicalBundle,
  CanonicalEvent,
  PropertyCharacteristicObservation,
  PropertyIdentifierObservation,
  SaleObservation,
  SourceEvidence,
} from '../../canonical/models.ts';
import { parcelObservationId, type SnapshotChangeKind } from '../../canonical/snapshot.ts';
import { NORMALIZATION_CONTRACT_VERSION, PARCEL_IDENTIFIER_EXTENSION, SQUARE_FEET_PER_ACRE } from '../../canonical/normalization-contract.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { FL_PARCEL_IDENTIFIER_SCHEME } from '../fl-dor/identity.ts';
import { flEchoObservationId, flSaleObservation, type FlSaleFacts } from '../fl-dor/sales.ts';
import type { FlParRecord } from './parse.ts';

export const FL_PAR_NORMALIZATION_VERSION = 'fl_par_normalizer_1';
/** How the planimetric area is computed: shoelace over the source coordinates, holes subtracted. */
export const FL_PAR_AREA_DERIVATION = 'shoelace_source_crs_1';
const METRES_PER_FOOT = 0.3048;

export type FlParNormalizeContext = {
  readonly sourceId: string;
  readonly snapshotId: string;
  readonly changeKind: SnapshotChangeKind;
  readonly changedFieldGroups: readonly string[];
};

export function normalizeFlParRecord(
  record: FlParRecord,
  evidence: SourceEvidence,
  ctx: FlParNormalizeContext,
  rowContentDigest: string,
): CanonicalBundle {
  const propertyId = deterministicId('prop', 'county_parcel', record.countyFips, record.normalizedParcel);

  const identifier: PropertyIdentifierObservation = {
    observationId: deterministicId('propid', ctx.sourceId, evidence.sourceRecordId, 'county_parcel'),
    identifierType: 'county_parcel',
    value: record.parcelId,
    normalizedValue: record.normalizedParcel,
    countyFips: record.countyFips,
    sourceDesignation: 'primary',
    finality: 'final',
    resolutionState: 'resolved',
    propertyId,
    resolutionMethod: 'county_parcel_authoritative',
    evidence,
  };

  const g = record.geometry;
  const drawn = g !== null && !('null' in g);
  const areaSqFt = drawn && g.a !== null && record.unitMetres !== null
    ? Math.abs(g.a) * (record.unitMetres / METRES_PER_FOOT) ** 2
    : null;

  const characteristics: PropertyCharacteristicObservation[] = [{
    observationId: deterministicId('charobs', ctx.snapshotId, evidence.sourceRecordId),
    propertyId,
    countyFips: record.countyFips,
    normalizedParcel: record.normalizedParcel,
    snapshotId: ctx.snapshotId,
    yearBuilt: null,
    // The assessor's land area is the NAL's; this is a drawing's area, kept apart.
    parcelAreaSqFt: null,
    characteristics: {
      geometry_kind: g === null ? null : drawn ? 'POLYGON_SUMMARY' : 'NULL_SHAPE',
      shape_type: g?.t ?? null,
      parts: drawn ? g.np : null,
      vertices: drawn ? g.nv : null,
      rings_closed: drawn ? g.closed : null,
      bbox_source_crs: drawn ? g.b : null,
      centroid_source_crs: drawn ? g.c : null,
      area_source_units: drawn ? g.a : null,
      gis_area_square_feet: areaSqFt === null ? null : Math.round(areaSqFt * 100) / 100,
      gis_area_acres: areaSqFt === null ? null : Math.round((areaSqFt / SQUARE_FEET_PER_ACRE) * 10_000) / 10_000,
      gis_area_derivation: areaSqFt === null ? null : FL_PAR_AREA_DERIVATION,
      source_crs: record.crs,
      source_crs_unit_metres: record.unitMetres,
      parcel_no: record.parcelNo,
      parcel_no_equals_parcel_id: record.parcelNo === null ? null : record.parcelNo === record.parcelId,
      roll_stage_joined: record.stage,
      source_file_sha256: record.fileSha256,
      source_file_last_modified: record.fileLastModified,
      parcel_match_key: record.matchKey,
      normalization_contract: NORMALIZATION_CONTRACT_VERSION,
      parcel_identifier_extension: PARCEL_IDENTIFIER_EXTENSION,
      parcel_identifier_scheme: FL_PARCEL_IDENTIFIER_SCHEME,
    },
    evidence,
  }];

  // The dBASE numerics cannot be blank, so a slot is "stated" by its text
  // columns or a non-zero year — never by a zero the format wrote for nothing.
  const saleObservations: SaleObservation[] = [];
  for (const slot of [1, 2] as const) {
    const e = record.echo;
    const year = e[`SALE_YR${slot}`];
    const stated = [`QUAL_CD${slot}`, `SALE_MO${slot}`, `OR_BOOK${slot}`, `OR_PAGE${slot}`, `CLERK_NO${slot}`, `M_PAR_SAL${slot}`, `VI_CD${slot}`]
      .some((k) => e[k] !== undefined) || (year !== undefined && year !== '0');
    if (!stated) continue;
    const facts: FlSaleFacts = {
      publisherSaleId: null,
      year: year === '0' ? undefined : year,
      month: e[`SALE_MO${slot}`],
      price: e[`SALE_PRC${slot}`],
      qualificationCode: e[`QUAL_CD${slot}`],
      vacantImproved: e[`VI_CD${slot}`],
      book: e[`OR_BOOK${slot}`], page: e[`OR_PAGE${slot}`], clerk: e[`CLERK_NO${slot}`],
      multiParcel: e[`M_PAR_SAL${slot}`],
    };
    saleObservations.push(flSaleObservation({
      kind: 'ASSESSOR_SALE_ECHO',
      semanticClass: 'FL_DOR_PAR_SALE_ECHO',
      observationId: flEchoObservationId(ctx.sourceId, ctx.snapshotId, evidence.sourceRecordId, slot),
      propertyId,
      countyFips: record.countyFips,
      normalizedParcel: record.normalizedParcel,
      ordinal: slot,
      facts,
      evidence,
    }));
  }

  const events: CanonicalEvent[] = [{
    eventId: deterministicId('event', 'PARCEL_OBSERVED', propertyId, evidence.sourceId, evidence.observedAt),
    eventType: 'PARCEL_OBSERVED',
    occurredAt: evidence.observedAt,
    subjectId: propertyId,
    payload: { countyFips: record.countyFips, semantics: 'FL_PAR_POLYGON' },
    evidence,
  }];

  return {
    transaction: {
      transactionId: deterministicId('parcelmap', evidence.sourceId, evidence.sourceRecordId),
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
      characteristics: { record_kind: 'parcel_map_polygon', property_id: propertyId },
      analyticalMetadata: { semantics: 'FL_PAR_POLYGON_NOT_A_TRANSACTION' },
      evidence,
    },
    parties: [],
    transactionParties: [],
    propertyIdentifiers: [identifier],
    transactionParcels: [],
    properties: [{ propertyId, countyFips: record.countyFips, createdFromMethod: 'county_parcel_authoritative' }],
    financing: [],
    events,
    characteristics,
    parcelObservations: [{
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
    }],
    saleObservations,
  };
}

export function flParFieldGroups(record: FlParRecord): Readonly<Record<string, string>> {
  return {
    identity: deterministicId('fg', record.countyFips, record.parcelId, record.parcelNo ?? ''),
    geometry: deterministicId('fg', JSON.stringify(record.geometry), record.crs ?? '', String(record.unitMetres ?? '')),
    sale: deterministicId('fg', JSON.stringify(Object.keys(record.echo).sort().map((k) => [k, record.echo[k]]))),
  };
}
