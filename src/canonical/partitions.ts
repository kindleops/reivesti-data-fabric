/**
 * Projection partitioning.
 *
 * DF-0C through DF-0F folded the **entire estate** on every run. With one county
 * that was invisible; with 3,222 it is the difference between a working system
 * and one that spends an hour recomputing Alaska because a parcel changed in
 * Hennepin. That was the carried P1, and this module is the model that fixes it.
 *
 * ## The idea
 *
 * A projection is a fold over evidence. It can be split into independent folds
 * **exactly where the identity it computes is independent** — and nowhere else.
 * So the partition key is not a convenience: it is a claim about the domain, and
 * a wrong one silently merges or silently separates records.
 *
 * ## Why not partition by source
 *
 * The obvious key is `source_id`, and it is wrong. Property resolution exists
 * precisely to make the assessor, eCRV and the recorder converge on one property.
 * Partitioning by source would put the three observations of one parcel in three
 * partitions that never see each other, which does not slow convergence down —
 * it removes it. Rejected.
 *
 * ## Why not one partition per property
 *
 * Correct, and useless: the address-collision pass compares parcels against each
 * other, so a per-property partition cannot see the conflict it exists to find.
 * It would also mean millions of tiny generation directories. Rejected.
 *
 * ## Why jurisdiction, for property
 *
 * Because property identity **is already jurisdiction-scoped**:
 * `propertyIdFromCountyParcel(countyFips, parcel)`. Two counties cannot produce
 * the same canonical property id, so no fold across counties can change a result
 * — and the one cross-record comparison in the projection (same address, several
 * parcels) is only meaningful inside one county anyway. Partitioning by county
 * is therefore not merely safe here; it *fixes* a latent bug, because the
 * address pass previously grouped on address alone and would have reported a
 * spurious conflict for the same street address in two different states.
 *
 * ## Why NOT jurisdiction, for organizations
 *
 * A company observed as an owner in Hennepin may be registered in Delaware and
 * qualified in Minnesota. Scoping organization identity to a county would make
 * the answer depend on where the observation happened to be seen, which is the
 * definition of a wrong partition. Organization resolution therefore uses a
 * single national partition today. That is not a solved nationwide identity
 * model — DF-0G does not need one — but it is a key that will not have to be
 * unwound to build one.
 */
import { fail } from '../core/errors.ts';
import { sha256 } from '../core/hash.ts';

/**
 * The distinct identity problems the estate solves.
 *
 * Kept separate because they partition differently, which is the whole point:
 * a single "resolution" concept would have forced one key on all of them.
 */
export type ResolutionDomain =
  /** Which parcel is which. Jurisdiction-scoped. */
  | 'PROPERTY_RESOLUTION'
  /** Whether several records describe one transfer. Jurisdiction-scoped. */
  | 'TRANSACTION_RESOLUTION'
  /** Which registration an observed company name refers to. Crosses jurisdictions. */
  | 'ORGANIZATION_RESOLUTION'
  /** Declared so the architecture does not preclude it. No producer in DF-0G. */
  | 'PERSON_RESOLUTION';

export const RESOLUTION_DOMAINS: readonly ResolutionDomain[] = [
  'PROPERTY_RESOLUTION', 'TRANSACTION_RESOLUTION', 'ORGANIZATION_RESOLUTION', 'PERSON_RESOLUTION',
];

/** How a domain's scope is derived. Declared per domain, never assumed. */
export type PartitionScopeKind =
  /** One partition per county or county-equivalent. */
  | 'county'
  /** One partition for the whole country. */
  | 'nation';

export const DOMAIN_SCOPE: Readonly<Record<ResolutionDomain, PartitionScopeKind>> = {
  PROPERTY_RESOLUTION: 'county',
  TRANSACTION_RESOLUTION: 'county',
  ORGANIZATION_RESOLUTION: 'nation',
  PERSON_RESOLUTION: 'nation',
};

/** Short, filesystem-safe domain segment. */
const DOMAIN_SEGMENT: Readonly<Record<ResolutionDomain, string>> = {
  PROPERTY_RESOLUTION: 'property',
  TRANSACTION_RESOLUTION: 'transaction',
  ORGANIZATION_RESOLUTION: 'organization',
  PERSON_RESOLUTION: 'person',
};

export const NATION_SCOPE = 'us';

export type PartitionKey = {
  readonly domain: ResolutionDomain;
  /** A jurisdiction id: `us-county-27053` for county domains, `us` for national. */
  readonly scopeId: string;
};

/** Stable textual id. Used as a directory path and as a digest key. */
export function partitionId(key: PartitionKey): string {
  return `${DOMAIN_SEGMENT[key.domain]}/${key.scopeId}`;
}

export function parsePartitionId(id: string): PartitionKey {
  const slash = id.indexOf('/');
  if (slash === -1) fail('CONFIG', `malformed partition id "${id}"`);
  const segment = id.slice(0, slash);
  const scopeId = id.slice(slash + 1);
  const domain = RESOLUTION_DOMAINS.find((d) => DOMAIN_SEGMENT[d] === segment);
  if (domain === undefined) fail('CONFIG', `unknown partition domain "${segment}"`);
  if (scopeId === '') fail('CONFIG', `partition id "${id}" has no scope`);
  return { domain, scopeId };
}

/** The county-scoped partition a county FIPS belongs to. */
export function countyPartition(domain: ResolutionDomain, countyFips: string): PartitionKey {
  if (DOMAIN_SCOPE[domain] !== 'county') {
    fail('CONFIG', `${domain} is not county-scoped; asking for a county partition would misplace its rows`);
  }
  if (!/^\d{5}$/.test(countyFips)) {
    fail('CONFIG', `"${countyFips}" is not a 5-digit county FIPS`, {
      remedy: 'a partition scope must be a real jurisdiction; an empty or malformed FIPS would create a bucket '
        + 'that no jurisdiction owns and that nothing would ever recompute',
    });
  }
  return { domain, scopeId: `us-county-${countyFips}` };
}

export function nationPartition(domain: ResolutionDomain): PartitionKey {
  if (DOMAIN_SCOPE[domain] !== 'nation') {
    fail('CONFIG', `${domain} is county-scoped; a national partition would fold unrelated jurisdictions together`);
  }
  return { domain, scopeId: NATION_SCOPE };
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/**
 * Which partitions a run has to recompute.
 *
 * Derived from the jurisdictions the run **actually observed**, not from the
 * mapping's declared scope. A statewide source mapped to 87 counties that
 * delivered one county's rows must recompute one partition, not 87 — and the
 * declared scope cannot tell the difference.
 *
 * Never inferred from file paths. A plan is computed from output and recorded in
 * the run manifest, so what was recomputed is an auditable fact rather than a
 * reconstruction.
 */
export type PartitionPlan = {
  readonly runId: string;
  /** Sorted partition ids. */
  readonly partitions: readonly string[];
  /** The jurisdictions whose rows this run produced. */
  readonly observedJurisdictionIds: readonly string[];
  readonly domains: readonly ResolutionDomain[];
};

export type PlanInput = {
  readonly runId: string;
  /** County FIPS the run emitted rows for. */
  readonly observedCountyFips: Iterable<string>;
  /** True when the run produced organization observations or registrations. */
  readonly producedOrganizationRows: boolean;
  /** True when the run produced transaction-candidate inputs. */
  readonly producedTransactionRows: boolean;
};

export function planPartitions(input: PlanInput): PartitionPlan {
  const counties = [...new Set(input.observedCountyFips)].filter((f) => f !== '').sort();
  const partitions = new Set<string>();
  const domains = new Set<ResolutionDomain>();

  for (const fips of counties) {
    partitions.add(partitionId(countyPartition('PROPERTY_RESOLUTION', fips)));
    domains.add('PROPERTY_RESOLUTION');
    if (input.producedTransactionRows) {
      partitions.add(partitionId(countyPartition('TRANSACTION_RESOLUTION', fips)));
      domains.add('TRANSACTION_RESOLUTION');
    }
  }

  if (input.producedOrganizationRows) {
    partitions.add(partitionId(nationPartition('ORGANIZATION_RESOLUTION')));
    domains.add('ORGANIZATION_RESOLUTION');
  }

  return {
    runId: input.runId,
    partitions: [...partitions].sort(),
    observedJurisdictionIds: counties.map((f) => `us-county-${f}`),
    domains: [...domains].sort(),
  };
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

/**
 * What one partition's projection currently is.
 *
 * `inputDigest` and `outputDigest` are both order-independent multiset digests,
 * so a partition's identity does not depend on the order its contributions were
 * written or its rows emitted.
 */
export type PartitionManifest = {
  readonly partitionId: string;
  readonly domain: ResolutionDomain;
  readonly scopeId: string;
  readonly generation: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly resolverVersion: string;
  readonly rowCount: number;
  readonly inputRowCount: number;
  readonly activatedAt: string;
  /** The run that last recomputed it. Provenance, not identity. */
  readonly runId: string;
};

/**
 * The estate's digest, built from its partitions rather than from its rows.
 *
 * This is the property that makes national scale tractable: updating one county
 * changes one child digest, and the global digest changes with it — predictably,
 * and without re-reading a single row in any other county. A digest computed by
 * re-folding everything would have made the fix pointless.
 */
export function globalDigest(manifests: readonly PartitionManifest[]): string {
  const lines = manifests
    .map((m) => `${m.partitionId}\t${m.outputDigest}`)
    .sort();
  return sha256(lines.join('\n'));
}
