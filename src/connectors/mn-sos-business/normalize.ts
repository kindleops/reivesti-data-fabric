/**
 * Minnesota SOS bulk rows → canonical business entities.
 *
 * Three rules govern everything below.
 *
 * **1. The register is authoritative about registrations and nothing else.**
 * `Active` means the registration is in good standing. It does not mean the
 * company trades, employs anyone, holds property or is worth contacting, and no
 * event emitted here says otherwise.
 *
 * **2. Nothing is linked that the source does not link.** An Assumed Name is its
 * own master row in this file with no documented pointer to the business that
 * filed it. So none is invented — the assumed-name record becomes an entity in
 * its own right, flagged as not a legal entity, and any connection to a parent
 * is left to the evidence-scored resolver where it can be reviewed.
 *
 * **3. Names and addresses in this delivery are current, not historical.** The
 * implementation guide states the file carries only names and addresses active
 * at generation time. So `observedAt` is the file's generation timestamp, and
 * this connector emits **no `PRIOR_NAME` observations at all** — a name-history
 * built from monthly snapshots is a Reivesti derivation across deliveries, not a
 * fact this delivery states.
 */
import { contentDigest, deterministicId } from '../../core/hash.ts';
import { normalizeOrganizationName } from '../../canonical/name-normalization.ts';
import {
  addressObservationIdOf,
  entityIdOf,
  filingObservationIdOf,
  filingPartyIdOf,
  nameObservationIdOf,
  normalizeAddress,
  type BusinessAddressObservation,
  type BusinessEntityRecord,
  type BusinessFilingObservation,
  type BusinessFilingParty,
  type BusinessNameObservation,
  type FilingAction,
  type RegistryStatus,
} from '../../canonical/organizations.ts';
import type {
  CanonicalBundle,
  CanonicalEvent,
  PostalAddress,
  SourceEvidence,
} from '../../canonical/models.ts';
import { contactObservationId, type ContactObservation } from '../../contact/contact-plane.ts';
import type { ChangeContext } from '../../runtime/connector.ts';
import {
  addressType,
  businessType,
  filingAction as lookupFilingAction,
  partyNameType,
} from './domain.ts';
import type { SosEntityRecord, SosFieldGroup } from './record.ts';

export const SOS_NORMALIZATION_VERSION = 'mn_sos_normalizer_1';

export type SosNormalizeOptions = {
  readonly registryJurisdictionId: string;
  /**
   * When the publisher generated the delivery. Every name and address in the
   * file is the one active at that moment, so this — not the ingestion clock —
   * is when they were observed to be true.
   */
  readonly fileGeneratedAt: string;
};

export type SosNormalizeResult = {
  readonly bundle: CanonicalBundle;
  readonly entity: BusinessEntityRecord;
  readonly names: readonly BusinessNameObservation[];
  readonly addresses: readonly BusinessAddressObservation[];
  readonly filings: readonly BusinessFilingObservation[];
  readonly parties: readonly BusinessFilingParty[];
  readonly contacts: readonly ContactObservation[];
  /** Domain codes the delivery used that the pinned vocabularies do not know. */
  readonly unknownCodes: readonly string[];
};

export function normalizeSosEntity(
  record: SosEntityRecord,
  evidence: SourceEvidence,
  _change: ChangeContext,
  options: SosNormalizeOptions,
): SosNormalizeResult {
  const master = record.master;
  if (master === null) {
    // Guarded by the parser, which routes orphans away from normalisation. The
    // check stays so a future caller cannot quietly produce a nameless entity.
    throw new Error(`cannot normalize master ${record.masterId}: no master row`);
  }

  const entityId = entityIdOf(evidence.sourceId, record.masterId);
  const observedAt = options.fileGeneratedAt;
  const unknownCodes = new Set<string>();

  const type = businessType(master.businessTypeCode);
  if (type === undefined) unknownCodes.add(`business_type:${master.businessTypeCode}`);

  const legal = normalizeOrganizationName(master.minnesotaBusinessName);
  const status = registryStatusOf(master.businessFilingStatus);

  const entity: BusinessEntityRecord = {
    entityId,
    sourceId: evidence.sourceId,
    sourceEntityId: record.masterId,
    registryJurisdictionId: options.registryJurisdictionId,
    originalFilingNumber: master.originalFilingNumber,
    legalName: master.minnesotaBusinessName,
    normalizedName: legal.search,
    compactName: legal.compact,
    businessTypeCode: master.businessTypeCode,
    businessTypeLabel: type?.label ?? null,
    domesticity: type?.domesticity ?? 'unknown',
    registryStatus: status,
    registryStatusRaw: master.businessFilingStatus,
    filingDate: master.filingDate,
    expirationDate: master.expirationDate,
    nextRenewalDueDate: master.nextRenewalDueDate,
    homeJurisdiction: master.homeJurisdiction,
    governingStatute: master.governingStatute,
    homeBusinessName: master.homeBusinessName,
    attributes: {
      // Kept as the register states them rather than folded into the type: a
      // professional LLC and a nonprofit LLC share code 44.
      is_llc_non_profit: master.isLlcNonProfit,
      is_lllp: master.isLllp,
      is_professional: master.isProfessional,
      number_of_shares: master.numberOfShares,
      business_mark_type: master.businessMarkType,
      mark_first_use_date: master.markFirstUseDate,
      mark_classification_number: master.markClassificationNumber,
      /**
       * False for trademarks, assumed names and name reservations. They are
       * rows in the same file and they are not companies — nothing that cannot
       * own property may become a resolution candidate for a property owner.
       */
      is_legal_entity: type?.isLegalEntity ?? false,
      /** Stated so the absence of a parent link is a recorded fact, not an oversight. */
      assumed_name_record: master.businessTypeCode === '59',
      source_export_date: master.exportDate,
    },
    evidence,
  };

  // -- names ---------------------------------------------------------------

  const names: BusinessNameObservation[] = [{
    nameObservationId: nameObservationIdOf(entityId, 'CURRENT_LEGAL_NAME', master.minnesotaBusinessName),
    entityId,
    nameType: 'CURRENT_LEGAL_NAME',
    rawName: master.minnesotaBusinessName,
    normalizedName: legal.search,
    compactName: legal.compact,
    filingNumber: master.originalFilingNumber,
    observedAt,
    evidence,
  }];

  // A foreign entity's home-jurisdiction name is a different string for the same
  // registration, and county records sometimes use it. It is a name of this
  // entity — not a prior name, and not a separate company.
  if (master.homeBusinessName !== null && master.homeBusinessName !== master.minnesotaBusinessName) {
    const home = normalizeOrganizationName(master.homeBusinessName);
    names.push({
      nameObservationId: nameObservationIdOf(entityId, 'HOME_JURISDICTION_NAME', master.homeBusinessName),
      entityId,
      nameType: 'HOME_JURISDICTION_NAME',
      rawName: master.homeBusinessName,
      normalizedName: home.search,
      compactName: home.compact,
      filingNumber: master.originalFilingNumber,
      observedAt,
      evidence,
    });
  }

  // -- filings -------------------------------------------------------------

  const filings: BusinessFilingObservation[] = record.filings.map((f) => ({
    filingObservationId: filingObservationIdOf(entityId, f.filingNumber, f.filingActionRaw, f.filingRank, f.filingDate),
    entityId,
    filingNumber: f.filingNumber,
    originalFilingNumber: master.originalFilingNumber,
    filingActionRaw: f.filingActionRaw,
    filingAction: lookupFilingAction(f.filingActionRaw) as FilingAction,
    filingRank: f.filingRank,
    filingDate: f.filingDate,
    effectiveDate: f.effectiveDate,
    evidence,
  }));
  for (const f of filings) {
    // The guide's action list is explicitly by example, so an unrecognised
    // action is expected and is reported rather than treated as a defect.
    if (f.filingAction === 'OTHER') unknownCodes.add(`filing_action:${f.filingActionRaw}`);
  }

  // -- addresses and parties ------------------------------------------------

  const addresses: BusinessAddressObservation[] = [];
  const parties: BusinessFilingParty[] = [];
  const contacts: ContactObservation[] = [];

  for (const row of record.names) {
    const nameType = row.nameTypeCode === null ? undefined : partyNameType(row.nameTypeCode);
    if (row.nameTypeCode !== null && nameType === undefined) {
      unknownCodes.add(`name_type:${row.nameTypeCode}`);
    }

    const addrType = row.addressTypeCode === null ? undefined : addressType(row.addressTypeCode);
    if (row.addressTypeCode !== null && addrType === undefined) {
      unknownCodes.add(`address_type:${row.addressTypeCode}`);
    }

    const address = postalAddressOf(row);
    const likelyPerson = nameType?.ordinarilyNaturalPerson ?? false;

    if (row.partyName !== null && row.nameTypeCode !== null) {
      parties.push({
        filingPartyId: filingPartyIdOf(entityId, row.nameTypeCode, row.partyName, row.filingNumber),
        entityId,
        nameTypeCode: row.nameTypeCode,
        roleLabel: nameType?.label ?? null,
        rawName: row.partyName,
        normalizedName: normalizeOrganizationName(row.partyName).search,
        likelyNaturalPerson: likelyPerson,
        filingNumber: row.filingNumber,
        observedAt,
        evidence,
      });
    }

    if (address === null) continue;
    const normalized = normalizeAddress(address);

    if (likelyPerson) {
      // The address of a role ordinarily filled by a natural person is personal
      // data. It goes to the restricted plane and nowhere else — there is no
      // field on any canonical type that could hold it, by construction.
      const partyObservationId = row.partyName === null
        ? null
        : filingPartyIdOf(entityId, row.nameTypeCode as string, row.partyName, row.filingNumber);
      contacts.push({
        contactObservationId: contactObservationId(
          evidence.sourceId, evidence.sourceRecordId, partyObservationId, 'mailing_address', normalized,
        ),
        partyId: null,
        partyObservationId,
        contactType: 'mailing_address',
        value: normalized,
        sourceId: evidence.sourceId,
        sourceRecordId: evidence.sourceRecordId,
        observedAt,
        confidence: 'source_stated',
        // A filing address is evidence the address was stated on a filing. It is
        // not permission to write to it, and this connector never grants one.
        permittedUse: 'record_only',
        status: 'observed',
        evidence,
      });
      continue;
    }

    addresses.push({
      addressObservationId: addressObservationIdOf(entityId, row.addressTypeCode ?? '', normalized),
      entityId,
      addressTypeCode: row.addressTypeCode ?? '',
      addressTypeLabel: addrType?.label ?? null,
      family: addrType?.family ?? 'OTHER',
      address,
      normalizedAddress: normalized,
      filingNumber: row.filingNumber,
      observedAt,
      evidence,
    });
  }

  // -- events ---------------------------------------------------------------

  const events: CanonicalEvent[] = [{
    // Keyed by WHEN THE REGISTER SAID IT, not by which run read it. Two monthly
    // deliveries are two observations; the same delivery read twice is one.
    eventId: deterministicId('event', 'BUSINESS_ENTITY_OBSERVED', entityId, observedAt),
    eventType: 'BUSINESS_ENTITY_OBSERVED',
    occurredAt: observedAt,
    subjectId: entityId,
    payload: {
      registryJurisdictionId: options.registryJurisdictionId,
      businessTypeCode: master.businessTypeCode,
      registryStatus: status,
      // The change kind is deliberately NOT here. It is a fact about this run's
      // relationship to the last one, not about the entity, and putting it in a
      // canonical payload made the run's normalized digest depend on ingestion
      // history — so identical bytes digested differently on re-ingest.
      semantics:
        'a registration exists in this register. This says nothing about whether the business trades, '
        + 'holds property or is worth contacting.',
    },
    evidence,
  }];

  if (master.businessFilingStatus !== null) {
    events.push({
      eventId: deterministicId('event', 'BUSINESS_STATUS_OBSERVED', entityId, status, observedAt),
      eventType: 'BUSINESS_STATUS_OBSERVED',
      occurredAt: observedAt,
      subjectId: entityId,
      payload: {
        registryStatus: status,
        registryStatusRaw: master.businessFilingStatus,
        expirationDate: master.expirationDate,
        semantics: 'the status of the REGISTRATION, not of the business.',
      },
      evidence,
    });
  }

  for (const filing of filings) {
    events.push({
      eventId: deterministicId('event', 'BUSINESS_FILING_OBSERVED', filing.filingObservationId),
      eventType: 'BUSINESS_FILING_OBSERVED',
      occurredAt: filing.effectiveDate ?? filing.filingDate,
      subjectId: entityId,
      payload: {
        filingNumber: filing.filingNumber,
        filingAction: filing.filingAction,
        filingActionRaw: filing.filingActionRaw,
        filingRank: filing.filingRank,
      },
      evidence,
    });
  }

  return {
    bundle: {
      transaction: nonTransactionFor(entity, evidence, options),
      parties: [],
      transactionParties: [],
      propertyIdentifiers: [],
      transactionParcels: [],
      properties: [],
      financing: [],
      events,
    },
    entity,
    names,
    addresses,
    filings,
    parties,
    contacts,
    unknownCodes: [...unknownCodes].sort(),
  };
}

// ---------------------------------------------------------------------------

/**
 * A business registration is not a transaction.
 *
 * The bundle's transaction slot carries an explicit non-transaction placeholder,
 * as the assessor and recorder connectors do: null consideration, null transfer
 * date, no parties, and a `record_kind` that says what this actually is.
 */
function nonTransactionFor(
  entity: BusinessEntityRecord,
  evidence: SourceEvidence,
  options: SosNormalizeOptions,
): CanonicalBundle['transaction'] {
  return {
    transactionId: deterministicId('bizreg', evidence.sourceId, evidence.sourceRecordId),
    sourceId: evidence.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    jurisdictionId: options.registryJurisdictionId,
    // A state register is not a county source. There is no county here and
    // inventing one would put a false locality on every organisation.
    countyFips: '',
    transferDate: null,
    instrumentTypeCode: null,
    totalConsideration: null,
    downPayment: null,
    sellerPaidPoints: null,
    delinquentSpecialAssessmentsPaidByBuyer: null,
    personalPropertyIncludedInTotal: null,
    legalDescription: null,
    characteristics: {
      record_kind: 'business_entity_registration',
      entity_id: entity.entityId,
      registry_status: entity.registryStatus,
      business_type_code: entity.businessTypeCode,
    },
    analyticalMetadata: {
      note:
        'a state business registration. It carries no property, no consideration and no transaction. '
        + 'Linking it to an observed owner name is an evidence-scored resolution decision, never an '
        + 'assumption made here.',
    },
    evidence,
  };
}

/** `Active` / `Inactive` and nothing else. Anything unexpected stays unknown. */
function registryStatusOf(raw: string | null): RegistryStatus {
  if (raw === null) return 'unknown';
  const value = raw.trim().toUpperCase();
  if (value === 'ACTIVE') return 'active';
  if (value === 'INACTIVE') return 'inactive';
  return 'unknown';
}

function postalAddressOf(row: {
  streetAddressLine1: string | null;
  streetAddressLine2: string | null;
  cityName: string | null;
  regionCode: string | null;
  postalCode: string | null;
  postalCodeExtension: string | null;
  countryName: string | null;
}): PostalAddress | null {
  if (
    row.streetAddressLine1 === null && row.streetAddressLine2 === null
    && row.cityName === null && row.postalCode === null
  ) {
    return null;
  }
  const postal = row.postalCode === null
    ? null
    : row.postalCodeExtension === null
      ? row.postalCode
      : `${row.postalCode}-${row.postalCodeExtension}`;
  return {
    line1: row.streetAddressLine1,
    line2: row.streetAddressLine2,
    city: row.cityName,
    stateOrProvince: row.regionCode,
    postalCode: postal,
    country: row.countryName,
  };
}

// ---------------------------------------------------------------------------
// Field-group digests
// ---------------------------------------------------------------------------

/**
 * Per-group digests over one grouped record.
 *
 * A monthly register restates every row, so a run that reports "412,000 changed"
 * has reported nothing. These let it report 900 status changes, 12 name changes
 * and 41 address changes instead.
 */
export function sosFieldGroups(record: SosEntityRecord): Readonly<Record<SosFieldGroup, string>> {
  const m = record.master;
  return {
    identity: contentDigest({
      masterId: record.masterId,
      businessTypeCode: m?.businessTypeCode ?? null,
      originalFilingNumber: m?.originalFilingNumber ?? null,
      legalName: m?.minnesotaBusinessName ?? null,
      homeBusinessName: m?.homeBusinessName ?? null,
      homeJurisdiction: m?.homeJurisdiction ?? null,
    }),
    status: contentDigest({
      status: m?.businessFilingStatus ?? null,
      filingDate: m?.filingDate ?? null,
      expirationDate: m?.expirationDate ?? null,
      nextRenewalDueDate: m?.nextRenewalDueDate ?? null,
    }),
    filings: contentDigest(
      record.filings
        .map((f) => `${f.filingNumber}|${f.filingActionRaw}|${f.filingRank}|${f.filingDate ?? ''}|${f.effectiveDate ?? ''}`)
        .sort(),
    ),
    names: contentDigest(
      [m?.minnesotaBusinessName ?? '', m?.homeBusinessName ?? ''].sort(),
    ),
    addresses: contentDigest(
      record.names
        .filter((r) => r.nameTypeCode === null)
        .map((r) => `${r.addressTypeCode ?? ''}|${r.streetAddressLine1 ?? ''}|${r.streetAddressLine2 ?? ''}|${r.cityName ?? ''}|${r.regionCode ?? ''}|${r.postalCode ?? ''}`)
        .sort(),
    ),
    parties: contentDigest(
      record.names
        .filter((r) => r.nameTypeCode !== null)
        .map((r) => `${r.nameTypeCode ?? ''}|${r.partyName ?? ''}|${r.filingNumber ?? ''}`)
        .sort(),
    ),
  };
}
