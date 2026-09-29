/**
 * Recomputing projection partitions.
 *
 * One place, used by three callers that must not diverge: the streaming runtime
 * after a run, the `df partitions rebuild` command, and the tests that prove
 * partition isolation. A second implementation of this loop would be a second
 * opinion about what a partition contains.
 *
 * The contract is narrow on purpose — **recompute exactly these partitions, read
 * nothing else.** A partition's inputs are already separated on disk, so
 * recomputing Hennepin opens no Ramsey file and writes no Ramsey byte. That is
 * the property the whole partitioning exercise exists to buy, and it is asserted
 * rather than assumed.
 */
import { performance } from 'node:perf_hooks';
import { canonicalJson, MultisetDigest } from '../core/hash.ts';
import type { Logger } from '../core/logging.ts';
import { silentLogger } from '../core/logging.ts';
import type { SortOptions } from '../core/external-sort.ts';
import { parsePartitionId, type PartitionManifest } from '../canonical/partitions.ts';
import { projectResolutions } from '../canonical/resolution-projection.ts';
import { SALE_RESOLVER_VERSION, projectSales } from '../canonical/sale-projection.ts';
import type { ParcelAuthority, PropertyConflict, PropertyResolution } from '../canonical/property-resolution.ts';
import { projectOrganizationLinks } from '../canonical/organization-projection.ts';
import { DEFAULT_RULES, RESOLVER_VERSION, type EntityLinkDecision } from '../canonical/entity-resolution.ts';
import type { PartitionActivation, PartitionStore } from './partition-store.ts';

/**
 * Version of the property fold.
 *
 * Recorded in every partition manifest so a resolver change shows up as
 * partitions that need recomputing, rather than as two partitions quietly
 * disagreeing about the same county because one was folded by older code.
 */
export const PROPERTY_RESOLVER_VERSION = 'property_resolver_2';
export { SALE_RESOLVER_VERSION };
export const ORGANIZATION_RESOLVER_VERSION = RESOLVER_VERSION;

export type OrganizationInputs = {
  observations(): AsyncIterable<string>;
  entities(): AsyncIterable<string>;
  addresses(): AsyncIterable<string>;
};

export type RecomputeOptions = {
  readonly partitions: PartitionStore;
  /** Partition ids to recompute. Nothing outside this list is read or written. */
  readonly partitionIds: readonly string[];
  readonly authority: ParcelAuthority;
  readonly runId: string;
  /** Timestamp recorded on conflicts and activations. Never `now()`, so a
   *  recomputation does not move a timestamp that describes evidence. */
  readonly detectedAt: string;
  readonly sort?: SortOptions;
  readonly logger?: Logger;
  /** Supplied only when an organization partition is in the list. */
  readonly organization?: OrganizationInputs;
  /** Rows kept in memory for the run report. Counts stay exact regardless. */
  readonly keepSamples?: number;
};

export type RecomputeResult = {
  readonly activations: readonly PartitionActivation[];
  readonly manifests: readonly PartitionManifest[];
  readonly resolutions: readonly PropertyResolution[];
  readonly conflicts: readonly PropertyConflict[];
  readonly entityLinks: readonly EntityLinkDecision[];
  readonly resolvedCount: number;
  readonly conflictCount: number;
  readonly linkCount: number;
  /** Canonical sales the TRANSACTION_RESOLUTION partitions hold after this recomputation. */
  readonly saleCount: number;
};

export async function recomputePartitions(options: RecomputeOptions): Promise<RecomputeResult> {
  const logger = options.logger ?? silentLogger();
  const keepSamples = options.keepSamples ?? 200;
  const sort = options.sort ?? {};

  const activations: PartitionActivation[] = [];
  const manifests: PartitionManifest[] = [];
  const resolutions: PropertyResolution[] = [];
  const conflicts: PropertyConflict[] = [];
  const entityLinks: EntityLinkDecision[] = [];
  let resolvedCount = 0;
  let conflictCount = 0;
  let linkCount = 0;
  let saleCount = 0;

  for (const id of options.partitionIds) {
    const key = parsePartitionId(id);
    const started = performance.now();

    try {
      if (key.domain === 'TRANSACTION_RESOLUTION') {
        const { digest: inputDigest, rowCount: inputRowCount } = await options.partitions.contributionDigest(key);
        const writer = await options.partitions.beginProjection(key, options.runId);
        const output = new MultisetDigest();
        let rows = 0;
        try {
          const result = await projectSales(
            () => options.partitions.readContributions(key),
            {
              async resolution(row) {
                output.add(canonicalJson(row));
                rows += 1;
                await writer.write('resolutions', row);
              },
              async conflict(row) {
                output.add(canonicalJson(row));
                await writer.write('conflicts', row);
              },
            },
            { sort },
          );
          saleCount += result.saleCount;
          manifests.push(await writer.commit({
            inputDigest,
            outputDigest: output.value(),
            resolverVersion: SALE_RESOLVER_VERSION,
            rowCount: rows,
            inputRowCount,
            activatedAt: options.detectedAt,
            runId: options.runId,
          }));
          activations.push({ partitionId: id, state: 'activated', generation: writer.generation, reason: null });
        } catch (e) {
          await writer.abort();
          throw e;
        }
      } else if (key.domain === 'PROPERTY_RESOLUTION') {
        const { digest: inputDigest, rowCount: inputRowCount } = await options.partitions.contributionDigest(key);
        const writer = await options.partitions.beginProjection(key, options.runId);
        const output = new MultisetDigest();
        let rows = 0;
        try {
          const result = await projectResolutions(
            // Tagged with their run, so conflict provenance is read from the
            // evidence rather than from whichever run recomputes the county.
            () => options.partitions.readContributionsTagged(key),
            {
              async resolution(row) {
                output.add(canonicalJson(row));
                rows += 1;
                if (resolutions.length < keepSamples) resolutions.push(row);
                await writer.write('resolutions', row);
              },
              async conflict(row) {
                // Conflicts are part of the partition's output, so they are part
                // of its digest: a county whose conflicts changed is a county
                // whose projection changed.
                output.add(canonicalJson(row));
                if (conflicts.length < keepSamples) conflicts.push(row);
                await writer.write('conflicts', row);
              },
            },
            { authority: options.authority, runId: options.runId, detectedAt: options.detectedAt, sort },
          );
          resolvedCount += result.resolvedCount;
          conflictCount += result.conflictCount;
          manifests.push(await writer.commit({
            inputDigest,
            outputDigest: output.value(),
            resolverVersion: PROPERTY_RESOLVER_VERSION,
            rowCount: rows,
            inputRowCount,
            activatedAt: options.detectedAt,
            runId: options.runId,
          }));
          activations.push({ partitionId: id, state: 'activated', generation: writer.generation, reason: null });
        } catch (e) {
          await writer.abort();
          throw e;
        }
      } else if (key.domain === 'ORGANIZATION_RESOLUTION') {
        const inputs = options.organization;
        if (inputs === undefined) {
          activations.push({
            partitionId: id, state: 'skipped', generation: null,
            reason: 'no organization inputs were supplied to this recomputation',
          });
          continue;
        }
        const writer = await options.partitions.beginProjection(key, options.runId);
        const output = new MultisetDigest();
        const input = new MultisetDigest();
        let rows = 0;
        try {
          const summary = await projectOrganizationLinks(
            () => tee(inputs.observations(), input),
            () => inputs.entities(),
            () => inputs.addresses(),
            async (decision) => {
              output.add(canonicalJson(decision));
              rows += 1;
              if (entityLinks.length < keepSamples) entityLinks.push(decision);
              await writer.write('entity_links', decision);
            },
            { rules: DEFAULT_RULES, decidedAt: options.detectedAt, sort },
          );
          linkCount += summary.observations;
          manifests.push(await writer.commit({
            inputDigest: input.value(),
            outputDigest: output.value(),
            resolverVersion: ORGANIZATION_RESOLVER_VERSION,
            rowCount: rows,
            inputRowCount: input.size,
            activatedAt: options.detectedAt,
            runId: options.runId,
          }));
          activations.push({ partitionId: id, state: 'activated', generation: writer.generation, reason: null });
          logger.info('partition.entity_links', { partitionId: id, ...summary });
        } catch (e) {
          await writer.abort();
          throw e;
        }
      } else {
        // PERSON_RESOLUTION is declared so the architecture does not preclude
        // it. No connector produces person identity evidence, and inventing an
        // empty partition would claim coverage that does not exist.
        activations.push({
          partitionId: id, state: 'skipped', generation: null,
          reason: `${key.domain} has no producer in this phase`,
        });
      }
    } catch (e) {
      // Per-partition. Partitions are independent by construction, so a failure
      // here leaves every other partition individually consistent — possibly at
      // a different generation, which the activation record states plainly
      // rather than papering over with a claim of global atomicity.
      activations.push({
        partitionId: id, state: 'failed', generation: null,
        reason: e instanceof Error ? e.message : String(e),
      });
      logger.error('partition.failed', {
        partitionId: id, message: e instanceof Error ? e.message : String(e),
      });
    }

    logger.info('partition.projected', { partitionId: id, ms: Math.round(performance.now() - started) });
  }

  return { activations, manifests, resolutions, conflicts, entityLinks, resolvedCount, conflictCount, linkCount, saleCount };
}

/** Passes a stream through while digesting it, so the input digest costs no extra pass. */
async function* tee(source: AsyncIterable<string>, digest: MultisetDigest): AsyncGenerator<string> {
  for await (const line of source) {
    digest.add(line);
    yield line;
  }
}
