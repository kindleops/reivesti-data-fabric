/**
 * Restricted contact plane.
 *
 * Two separations are enforced here, and they are not the same question:
 *
 *   MAY WE OBSERVE THIS?   — a retention question, answered by `status`.
 *   MAY WE USE THIS CHANNEL TO CONTACT SOMEONE? — a permission question,
 *                            answered by `permittedUse`, which this module only
 *                            records. Nothing here decides to contact anybody,
 *                            and no outbound, suppression or consent logic lives
 *                            in the Data Fabric.
 *
 * The structural guarantee is stronger than the access check: no canonical
 * transaction, party or property type in `src/canonical` has a field that can
 * hold a phone number or an email address. Contact data cannot leak into market
 * intelligence by accident, because there is nowhere for it to land. This module
 * is the only place it exists, and reads require an explicit principal.
 */
import { fail } from '../core/errors.ts';
import { deterministicId } from '../core/hash.ts';
import type { SourceEvidence } from '../canonical/models.ts';

export type ContactType =
  | 'phone'
  | 'email'
  | 'contact_note'
  | 'unstructured_submitter_block'
  /** A taxpayer or owner mailing address. Useful for ownership resolution,
   *  personal enough that it lives here rather than on a canonical party. */
  | 'mailing_address';

/**
 * What the observation may lawfully be used for. `record_only` is the default
 * and the only value DF-0B ever assigns: a phone number appearing on a public
 * filing is evidence that the number was stated, not permission to dial it.
 */
export type PermittedUse = 'record_only' | 'identity_resolution' | 'operator_review';

export type ContactStatus = 'observed' | 'suppressed' | 'protected_identity';

export type ContactObservation = {
  readonly contactObservationId: string;
  /** Set only once a party is genuinely resolved; otherwise the observation stands alone. */
  readonly partyId: string | null;
  /** Null for record-level material that belongs to no single party. */
  readonly partyObservationId: string | null;
  readonly contactType: ContactType;
  readonly value: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly observedAt: string;
  /** How much the source's own framing supports this being the party's channel. */
  readonly confidence: 'source_stated' | 'inferred';
  readonly permittedUse: PermittedUse;
  readonly status: ContactStatus;
  readonly evidence: SourceEvidence;
};

/**
 * Who is asking. Anonymous and member principals model the public and
 * customer-facing surfaces of the Reivesti application, which consume canonical
 * outputs and must never reach this plane.
 */
export type AccessPrincipal = 'anonymous' | 'member' | 'operator' | 'service';

const READERS: ReadonlySet<AccessPrincipal> = new Set<AccessPrincipal>(['operator', 'service']);

export type ContactPlane = {
  record(observation: ContactObservation): void;
  /** Throws RESTRICTED for any principal outside the reader set. */
  read(principal: AccessPrincipal, filter?: { partyObservationId?: string }): readonly ContactObservation[];
  /** Exact row count, regardless of how many rows are retained for reading. */
  size(): number;
  /** Per-type counts. Also value-free, for run reports. */
  countsByType(): Readonly<Record<string, number>>;
};

export type ContactPlaneOptions = {
  /**
   * Rows kept for inspection. Counts remain exact beyond it.
   *
   * A county-scale run produces one mailing-address observation per parcel, and
   * retaining 448,000 of them in a Map is dataset-sized memory for no benefit:
   * the durable record is the restricted partition on disk, and this plane is an
   * access-controlled window onto recent activity. Unbounded by default so the
   * buffered runtime behaves exactly as before.
   */
  readonly maxRetained?: number;
};

export function createContactPlane(options: ContactPlaneOptions = {}): ContactPlane {
  const maxRetained = options.maxRetained ?? Number.POSITIVE_INFINITY;
  const rows = new Map<string, ContactObservation>();
  const typeCounts: Record<string, number> = {};
  const recordedIds = new Set<string>();
  let recorded = 0;

  return {
    record(observation) {
      // Deterministic id: replaying the same evidence re-records the same row
      // rather than accumulating duplicates of somebody's phone number.
      if (!recordedIds.has(observation.contactObservationId)) {
        recordedIds.add(observation.contactObservationId);
        recorded += 1;
        typeCounts[observation.contactType] = (typeCounts[observation.contactType] ?? 0) + 1;
      }
      if (rows.size < maxRetained || rows.has(observation.contactObservationId)) {
        rows.set(observation.contactObservationId, observation);
      }
    },
    read(principal, filter) {
      if (!READERS.has(principal)) {
        fail('RESTRICTED', `principal "${principal}" may not read the restricted contact plane`, { principal });
      }
      const all = [...rows.values()].sort((a, b) => a.contactObservationId.localeCompare(b.contactObservationId));
      if (!filter?.partyObservationId) return all;
      return all.filter((r) => r.partyObservationId === filter.partyObservationId);
    },
    size() {
      // Exact even when retention is capped: an operator asking "how many
      // contact observations did that run produce?" must not get a truncated
      // answer because of a memory setting.
      return recorded;
    },
    countsByType() {
      return { ...typeCounts };
    },
  };
}

export function contactObservationId(
  sourceId: string,
  sourceRecordId: string,
  partyObservationId: string | null,
  contactType: ContactType,
  value: string,
): string {
  return deterministicId('contact', sourceId, sourceRecordId, partyObservationId, contactType, value);
}
