/**
 * RETR parcel references → provisional property identifier observations.
 *
 * DORMANT, like the rest of this connector: RETR is `MANUAL_ONLY` and nothing
 * here runs against a live file. It exists so that the day an automated RETR
 * distribution appears, its parcels converge with the Wisconsin Statewide
 * Parcel Map without anyone designing the join then. DF-0K proves that shape on
 * synthetic returns only; see tests/wi-statewide-parcels.test.ts.
 *
 * A RETR states the parcel the parties SAID was conveyed. That is a claim about
 * a parcel, not the county's roll, so the observation is `preliminary` and
 * `provisional`. It computes the canonical property id with the SAME function
 * the parcel map uses — `wiParcelIdentity`, punctuation-preserving — so the two
 * sources meet on one id without consulting each other, and the parcel map's
 * authoritative observation promotes the property to `resolved` whichever
 * arrives first.
 *
 * What it does NOT do is fold punctuation to force a match. If a return writes
 * a parcel differently from the roll, the folded key is a candidate for a later
 * resolver to check for uniqueness within the county; it is never identity.
 */
import { deterministicId } from '../../core/hash.ts';
import type { PropertyIdentifierObservation, SourceEvidence } from '../../canonical/models.ts';
import { wiParcelIdentity } from '../wi-statewide-parcels/identity.ts';
import type { RetrRecord } from './parse.ts';

export function retrParcelObservations(
  record: Pick<RetrRecord, 'countyFips' | 'parcels'>,
  evidence: SourceEvidence,
): readonly PropertyIdentifierObservation[] {
  return record.parcels.map((parcel) => {
    const observationId = deterministicId('propid', evidence.sourceId, evidence.sourceRecordId, 'county_parcel', parcel.ordinal);
    let identity: ReturnType<typeof wiParcelIdentity> | null = null;
    try {
      identity = wiParcelIdentity(record.countyFips, parcel.parcelNumber, evidence.sourceRecordId);
    } catch {
      identity = null; // an empty or label-only parcel field identifies nothing
    }
    return {
      observationId,
      identifierType: 'county_parcel',
      value: parcel.parcelNumber,
      normalizedValue: identity?.normalizedParcel ?? parcel.parcelNumber.trim().toUpperCase(),
      countyFips: record.countyFips,
      sourceDesignation: parcel.ordinal === 1 ? 'primary' : 'secondary',
      finality: 'preliminary',
      resolutionState: identity === null ? 'unresolved' : 'provisional',
      propertyId: identity?.propertyId ?? null,
      resolutionMethod: identity === null ? null : 'county_parcel_preliminary',
      evidence,
    };
  });
}
