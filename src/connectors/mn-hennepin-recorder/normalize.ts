/**
 * Recorder index to canonical.
 *
 * What this file refuses to do:
 *
 *  - It never emits a sale. A deed carries no reliable price; eCRV is the source
 *    for sale economics. Even a stated consideration is recorded as a stated
 *    consideration, not as a sale price.
 *  - It never merges parties. "NORTHSTAR HOMES LLC" and "NORTH STAR HOMES, LLC"
 *    are two observations.
 *  - It never resolves a property from a legal description above `PROVISIONAL`,
 *    and never from an address at all.
 *  - It never treats a satisfaction as evidence of a sale, or an assignment as a
 *    new loan.
 *  - It never lets a correction, a contract for deed, a transfer-on-death deed
 *    or a sheriff's certificate move ownership, even though each touches title.
 *
 * What it produces is deliberately modest: a document, its parties, what land it
 * names, and what other documents it points at. The interesting claims are folds
 * over that, computed separately in `instrument-graph.ts`, where the rules are
 * visible and testable in one place.
 */
import {
  type CanonicalBundle,
  type CanonicalEvent,
  type PartyObservation,
  type PostalAddress,
  type PropertyIdentifierObservation,
  type Property,
  type SourceEvidence,
  normalizeName,
  propertyIdFromCountyParcel,
} from '../../canonical/models.ts';
import {
  type InstrumentParty,
  type InstrumentPartyRole,
  type InstrumentPropertyLink,
  type InstrumentReference,
  type LegalDescriptionObservation,
  type PropertyLinkState,
  type RecordedFinancing,
  type RecordedInstrumentRecord,
  impliedReferenceType,
  instrumentIdOf,
  normalizeDocumentNumber,
  referenceIdOf,
} from '../../canonical/instruments.ts';
import { legalObservationOf } from '../../canonical/legal-description.ts';
import { deterministicId } from '../../core/hash.ts';
import { countyJurisdictionId } from '../../registry/jurisdictions.ts';
import { classifyDocumentType } from './taxonomy.ts';
import { HENNEPIN_COUNTY_FIPS } from './parse.ts';
import type { RecorderRecord } from './record.ts';

export const RECORDER_NORMALIZATION_VERSION = 'mn_hennepin_recorder_norm_1';

/**
 * Role normalisation. Exact matches only.
 *
 * Recorder role vocabularies are small and stable, and a mis-normalised role
 * flips the direction of an ownership inference — grantor and grantee are the
 * difference between acquiring and disposing. Unrecognised roles become `OTHER`
 * with the raw label preserved, and `OTHER` never contributes to ownership.
 */
const ROLE_MAP: Readonly<Record<string, InstrumentPartyRole>> = {
  GRANTOR: 'GRANTOR', GRANTORS: 'GRANTOR', 'FROM': 'GRANTOR',
  GRANTEE: 'GRANTEE', GRANTEES: 'GRANTEE', 'TO': 'GRANTEE',
  MORTGAGOR: 'MORTGAGOR', MORTGAGORS: 'MORTGAGOR',
  MORTGAGEE: 'MORTGAGEE', MORTGAGEES: 'MORTGAGEE',
  ASSIGNOR: 'ASSIGNOR', ASSIGNEE: 'ASSIGNEE',
  TRUSTOR: 'TRUSTOR', TRUSTEE: 'TRUSTEE', BENEFICIARY: 'BENEFICIARY',
  BORROWER: 'BORROWER', LENDER: 'LENDER',
};

export function normalizeRole(rawRole: string): InstrumentPartyRole {
  return ROLE_MAP[rawRole.toUpperCase().replace(/[^A-Z]/g, '')] ?? 'OTHER';
}

export type RecorderNormalizeOutput = {
  readonly bundle: CanonicalBundle;
  readonly instrument: RecordedInstrumentRecord;
  readonly instrumentParties: readonly InstrumentParty[];
  readonly propertyLinks: readonly InstrumentPropertyLink[];
  readonly legalDescriptions: readonly LegalDescriptionObservation[];
  readonly references: readonly InstrumentReference[];
  readonly financing: readonly RecordedFinancing[];
};

export function normalizeRecorderRecord(
  record: RecorderRecord,
  evidence: SourceEvidence,
  sourceId: string,
): RecorderNormalizeOutput {
  const countyFips = HENNEPIN_COUNTY_FIPS;
  const jurisdictionId = countyJurisdictionId(countyFips);
  const instrumentId = instrumentIdOf(countyFips, record.registrationSystem, record.documentNumber);
  const classification = classifyDocumentType(record.documentTypeRaw);

  const instrument: RecordedInstrumentRecord = {
    instrumentId,
    sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId,
    countyFips,
    documentNumber: record.documentNumber,
    registrationSystem: record.registrationSystem,
    certificateOfTitleNumber: record.certificateOfTitleNumber,
    documentTypeRaw: record.documentTypeRaw,
    documentTypeNormalized: classification.family,
    recordedAt: record.recordedAt,
    documentDate: record.documentDate,
    // Only ever the indexed figure. A blank here means the index was blank.
    statedConsideration: record.considerationMinor,
    bookPage: record.bookPage,
    evidence,
  };

  // --- parties --------------------------------------------------------------
  const parties: PartyObservation[] = [];
  const instrumentParties: InstrumentParty[] = [];

  record.parties.forEach((p, index) => {
    const observationId = deterministicId('partyobs', sourceId, evidence.sourceRecordId, String(index), p.rawRole, p.name);
    const address = addressOf(p);
    const normalizedRole = normalizeRole(p.rawRole);

    parties.push({
      observationId,
      // A recorder index does not classify person versus organisation, and
      // guessing from the shape of a name is the inference this layer refuses.
      kind: 'unknown',
      role: 'other',
      sourceRole: `hennepin_recorder:${p.rawRole}`,
      rawName: p.name,
      normalizedName: normalizeName(p.name),
      nameParts: { first: null, middle: null, last: null, suffix: null, organizationName: null },
      address,
      foreignAddress: null,
      protectedIdentity: false,
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });

    instrumentParties.push({
      instrumentId,
      partyObservationId: observationId,
      rawRole: p.rawRole,
      normalizedRole,
      sequence: p.sequence,
      rawName: p.name,
      normalizedName: normalizeName(p.name),
      address,
      resolutionState: 'unresolved',
      partyId: null,
      evidence,
    });
  });

  // --- legal descriptions ----------------------------------------------------
  const legalDescriptions = record.legalDescriptions.map((raw, i) =>
    legalObservationOf(instrumentId, i + 1, raw, evidence));

  // --- property linkage -------------------------------------------------------
  const propertyLinks: InstrumentPropertyLink[] = [];
  const propertyIdentifiers: PropertyIdentifierObservation[] = [];
  const properties = new Map<string, Property>();

  for (const [index, normalizedParcel] of record.parcelIds.entries()) {
    const propertyId = propertyIdFromCountyParcel(countyFips, normalizedParcel);
    propertyLinks.push({
      instrumentId,
      propertyId,
      countyFips,
      normalizedParcel,
      // The recorder index stated a county parcel identifier outright. This is
      // the only link state strong enough to move ownership.
      linkState: 'DIRECT_PARCEL',
      linkMethod: 'recorder_indexed_pid',
      legalDescriptionId: null,
      evidence,
    });
    propertyIdentifiers.push({
      observationId: deterministicId('propid', sourceId, evidence.sourceRecordId, 'parcel', String(index + 1), normalizedParcel),
      identifierType: 'county_parcel',
      value: normalizedParcel,
      normalizedValue: normalizedParcel,
      countyFips,
      sourceDesignation: index === 0 ? 'primary' : 'secondary',
      // The recorder indexes the parcel a document was filed against; the
      // county's own parcel authority is the assessor roll (DF-0C), so this is
      // preliminary rather than final and resolves only to provisional.
      finality: 'preliminary',
      resolutionState: 'provisional',
      propertyId,
      resolutionMethod: 'recorder_indexed_pid',
      evidence,
    });
    if (!properties.has(propertyId)) {
      properties.set(propertyId, { propertyId, countyFips, createdFromMethod: 'recorder_indexed_pid' });
    }
  }

  // A document with legal descriptions but no indexed parcel is not unlinked —
  // it is unresolved, which is a different and recoverable state. The legal
  // descriptions are retained so a later, measured resolution model can work on
  // them; nothing here guesses.
  if (record.parcelIds.length === 0) {
    const state: PropertyLinkState = legalDescriptions.length > 0 ? 'UNRESOLVED' : 'UNRESOLVED';
    propertyLinks.push({
      instrumentId,
      propertyId: null,
      countyFips,
      normalizedParcel: null,
      linkState: state,
      linkMethod: legalDescriptions.length > 0 ? 'legal_description_only_unmatched' : 'no_property_reference',
      legalDescriptionId: legalDescriptions[0]?.legalDescriptionId ?? null,
      evidence,
    });
  }

  // --- references --------------------------------------------------------------
  const referenceType = impliedReferenceType(classification.family);
  const references: InstrumentReference[] = record.referencedDocuments.map((r) => {
    const toNormalized = normalizeDocumentNumber(r.documentNumber);
    return {
      referenceId: referenceIdOf(instrumentId, toNormalized),
      fromInstrumentId: instrumentId,
      toDocumentNumber: r.documentNumber,
      toNormalizedDocumentNumber: toNormalized,
      // Falls back to the referencing document's own system: a satisfaction of a
      // Torrens mortgage is itself filed with the Registrar.
      toRegistrationSystem: r.registrationSystem === 'unknown' ? record.registrationSystem : r.registrationSystem,
      // Resolved later, by a fold over the whole estate. Unresolved is normal
      // and is never a reason to drop the pointer.
      toInstrumentId: null,
      resolved: false,
      referenceType,
      evidence,
    };
  });

  // --- financing -----------------------------------------------------------------
  const financing: RecordedFinancing[] = [];
  const isMortgageFamily = classification.family === 'MORTGAGE'
    || classification.family === 'MORTGAGE_ASSIGNMENT'
    || classification.family === 'MORTGAGE_RELEASE';

  if (isMortgageFamily) {
    financing.push({
      recordedFinancingId: deterministicId('recfin', instrumentId),
      instrumentId,
      propertyId: [...properties.keys()][0] ?? null,
      countyFips,
      // Only the indexed principal. A mortgage's amount is not derivable from
      // recording fees, and an assignment or satisfaction usually states none.
      principalAmountMinor: record.principalMinor,
      recordedAt: record.recordedAt,
      documentDate: record.documentDate,
      maturityDate: record.maturityDate,
      // Which mortgage this acts on is a reference-graph answer, filled in by
      // the fold once the target is in the estate.
      actsOnInstrumentId: null,
      lifecycleState: classification.family === 'MORTGAGE'
        ? 'recorded'
        : classification.family === 'MORTGAGE_ASSIGNMENT' ? 'assigned' : 'released',
      evidence,
    });
  }

  // --- events -----------------------------------------------------------------------
  const events: CanonicalEvent[] = [];
  const eventId = (type: string, subject: string): string =>
    deterministicId('evt', type, subject, evidence.sourceRecordId, evidence.rawRecordHash);

  // Always true, always safe: a document of this type was recorded on this date.
  events.push({
    eventId: eventId('INSTRUMENT_RECORDED', instrumentId),
    eventType: 'INSTRUMENT_RECORDED',
    occurredAt: record.recordedAt,
    subjectId: instrumentId,
    payload: {
      countyFips,
      documentNumber: record.documentNumber,
      registrationSystem: record.registrationSystem,
      documentTypeRaw: record.documentTypeRaw,
      family: classification.family,
      recognisedType: classification.recognised,
      parcelCount: record.parcelIds.length,
      referenceCount: references.length,
    },
    evidence,
  });

  // A conveyance observation needs a conveying family AND a parcel the recorder
  // indexed itself. A deed we cannot tie to land is still a recorded document,
  // and nothing more.
  const conveys = classification.entry?.safeConveyanceEvent === true;
  const hasDirectParcel = properties.size > 0;
  if (conveys && hasDirectParcel) {
    for (const propertyId of properties.keys()) {
      events.push({
        eventId: eventId('CONVEYANCE_OBSERVED', propertyId),
        eventType: 'CONVEYANCE_OBSERVED',
        occurredAt: record.recordedAt,
        subjectId: propertyId,
        payload: {
          instrumentId,
          countyFips,
          documentTypeRaw: record.documentTypeRaw,
          grantors: instrumentParties.filter((p) => p.normalizedRole === 'GRANTOR').length,
          grantees: instrumentParties.filter((p) => p.normalizedRole === 'GRANTEE').length,
          // Stated so no consumer mistakes a conveyance for a priced sale.
          semantics: 'a conveying instrument was recorded; sale economics come from eCRV, not from a deed',
        },
        evidence,
      });
    }
  }

  if (classification.family === 'MORTGAGE' && hasDirectParcel) {
    events.push({
      eventId: eventId('MORTGAGE_RECORDED', instrumentId),
      eventType: 'MORTGAGE_RECORDED',
      occurredAt: record.recordedAt,
      subjectId: instrumentId,
      payload: {
        countyFips,
        principalMinor: record.principalMinor,
        mortgagors: instrumentParties.filter((p) => p.normalizedRole === 'MORTGAGOR').length,
        mortgagees: instrumentParties.filter((p) => p.normalizedRole === 'MORTGAGEE').length,
      },
      evidence,
    });
  }
  if (classification.family === 'MORTGAGE_ASSIGNMENT') {
    events.push({
      eventId: eventId('MORTGAGE_ASSIGNED', instrumentId),
      eventType: 'MORTGAGE_ASSIGNED',
      occurredAt: record.recordedAt,
      subjectId: instrumentId,
      payload: {
        countyFips,
        referencedDocuments: references.map((r) => r.toDocumentNumber),
        semantics: 'the lender\'s interest moved; this is not a new loan against the property',
      },
      evidence,
    });
  }
  if (classification.family === 'MORTGAGE_RELEASE') {
    events.push({
      eventId: eventId('MORTGAGE_RELEASED', instrumentId),
      eventType: 'MORTGAGE_RELEASED',
      occurredAt: record.recordedAt,
      subjectId: instrumentId,
      payload: {
        countyFips,
        referencedDocuments: references.map((r) => r.toDocumentNumber),
        semantics: 'a lien was discharged; the payoff amount and the reason are not recorded',
      },
      evidence,
    });
  }

  return {
    bundle: {
      transaction: nonTransactionFor(instrumentId, jurisdictionId, countyFips, record, evidence),
      parties,
      transactionParties: [],
      propertyIdentifiers,
      transactionParcels: [],
      properties: [...properties.values()],
      financing: [],
      events,
    },
    instrument,
    instrumentParties,
    propertyLinks,
    legalDescriptions,
    references,
    financing,
  };
}

// ---------------------------------------------------------------------------

/**
 * A recorded document is not a transaction.
 *
 * As with the assessor connector, the bundle's transaction slot carries an
 * explicitly non-transaction placeholder rather than being made optional: null
 * consideration, null transfer date, no parties, and a `record_kind` that says
 * what it is. The transaction *candidate* — the hypothesis that this document
 * and an eCRV filing describe one event — is computed separately.
 */
function nonTransactionFor(
  instrumentId: string,
  jurisdictionId: string,
  countyFips: string,
  record: RecorderRecord,
  evidence: SourceEvidence,
): CanonicalBundle['transaction'] {
  return {
    transactionId: deterministicId('instrrec', evidence.sourceId, evidence.sourceRecordId),
    sourceId: evidence.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId,
    countyFips,
    transferDate: null,
    instrumentTypeCode: record.documentTypeRaw,
    // DF-0J added these general transfer-declaration facts for Wisconsin RETR.
    // Null here is the honest answer: this source either does not state them, or
    // states them on a different canonical row (the recorder's document number
    // belongs to its instrument, which is the authority for it).
    recordingDate: null,
    recordedDocumentNumber: null,
    conveyanceTypeCode: null,
    ownershipTypeCode: null,
    rightsRetainedCode: null,
    totalConsideration: null,
    downPayment: null,
    sellerPaidPoints: null,
    delinquentSpecialAssessmentsPaidByBuyer: null,
    personalPropertyIncludedInTotal: null,
    legalDescription: record.legalDescriptions[0] ?? null,
    characteristics: {
      record_kind: 'recorded_instrument',
      instrument_id: instrumentId,
      registration_system: record.registrationSystem,
      recorded_at: record.recordedAt,
    },
    analyticalMetadata: {
      note:
        'a recorded document, not a transaction. Sale economics come from eCRV; the parcel roll comes '
        + 'from the assessor. Whether these describe one event is a transaction candidate, computed '
        + 'across sources and never assumed.',
    },
    evidence,
  };
}

function addressOf(p: {
  addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null;
}): PostalAddress | null {
  if (p.addressLine1 === null && p.city === null && p.state === null && p.postalCode === null) return null;
  return {
    line1: p.addressLine1,
    line2: null,
    city: p.city,
    stateOrProvince: p.state,
    postalCode: p.postalCode,
    country: null,
  };
}
