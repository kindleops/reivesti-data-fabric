/**
 * Field grouping for change reporting.
 *
 * Extracted from the connector so the buffered and streaming parsers compute
 * identical group digests — if they drifted apart, the same artifact would
 * classify differently depending on which path read it.
 */
import { contentDigest } from '../../core/hash.ts';
import { fieldGroupDigests } from '../../canonical/snapshot.ts';
import type { HennepinParcelRecord } from './record.ts';

export function fieldGroupsOf(record: HennepinParcelRecord): Readonly<Record<string, string>> {
  return fieldGroupDigests({
    identity: { pid: record.pid, status: record.propertyStatusCode },
    address: record.situs,
    owner: { owner: record.ownerName, taxpayer: record.taxpayerNameLine },
    assessment: {
      tiers: record.tiers,
      marketTotal: record.marketValueTotalMinor,
      taxableTotal: record.taxableValueTotalMinor,
    },
    tax: {
      total: record.attributes['tax_total'],
      net: record.attributes['total_net_tax'],
      paid: record.attributes['net_tax_paid'],
      delinquent: record.attributes['earliest_delinquent_year'],
    },
    characteristics: {
      yearBuilt: record.yearBuilt,
      area: record.parcelAreaSqFt,
      legal: record.legalDescription,
    },
    geography: record.geography,
  }, contentDigest);
}

/** A single digest over every group, used as the snapshot index's group column. */
export function combinedGroupDigest(groups: Readonly<Record<string, string>>): string {
  return contentDigest(groups);
}
