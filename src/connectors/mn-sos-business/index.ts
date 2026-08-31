/**
 * Minnesota Secretary of State business-entity connector.
 *
 * **Live retrieval status: BLOCKED_ON_LICENSED_DELIVERY.**
 *
 * There *is* a sanctioned bulk route, and this is the important difference from
 * DF-0E: Minnesota sells the whole register. The Business Bulk Data product
 * (every business record, active and inactive) is $710 commercially, one-time,
 * and is collected by a signed-in human from the MBLS Portal's Transaction
 * History under an Electronic Media License Agreement made under Minn. Stat.
 * § 13.03 subd. 3. Free copies are available to news media, journalists,
 * researchers and non-commercial requesters, who must agree not to sell or
 * publish the entirety or any substantial portion of the database.
 *
 * So the blocker is a purchase and a signature, not a prohibition — and neither
 * is something software may perform on its own. The connector therefore has **no
 * network transport**: it reads a delivery an operator has bought and placed on
 * disk. `automationStatus` is `manual_only`, so even if a publisher-reaching
 * transport were injected the runtime would refuse it.
 *
 * ## What the licence permits, and where the line is
 *
 * Paragraph A.1 grants a non-exclusive, non-transferable licence "to publish and
 * make available in the normal course of its business to its customers … certain
 * public records", and states that nothing prohibits charging customers a fee
 * for access. Paragraph C.1 is the boundary: the records may be used "only in
 * the normal course of its business, except that Licensee may not resell in bulk
 * or repackage in bulk any substantial part of the Records", and may not
 * sub-license without written consent. C.2 keeps ownership with the office and
 * C.7 forbids presenting the records as the office's Official record.
 *
 * Read plainly: **serving a Reivesti member an answer about one company is
 * permitted; shipping the register is not.** That is why `LicenseClass` exists,
 * why the raw delivery is `RAW_LICENSED` and never leaves the server, and why
 * nothing in this connector is classified `PUBLIC_SAFE`.
 *
 * ## What this source is for
 *
 * Giving Reivesti authoritative evidence about the organisations that already
 * appear in assessor, eCRV and recorder observations. It is emphatically **not**
 * an entity-merging engine: an observed owner name produces a *candidate*
 * registration, and only deterministic evidence turns a candidate into a link.
 * See src/canonical/entity-resolution.ts.
 */
import { fail } from '../../core/errors.ts';
import { sha256 } from '../../core/hash.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import type {
  BatchValidation,
  ChangeContext,
  Connector,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  StreamingConnector,
  StreamingParseSession,
} from '../../runtime/connector.ts';
import { createLocalFileTransport, type Transport } from '../../runtime/transport.ts';
import type { SortOptions } from '../../core/external-sort.ts';
import { MN_SOS_ADAPTER_KEY, MN_SOS_SOURCE_ID } from '../../registry/sources.ts';
import { layoutSignature } from './domain.ts';
import { SOS_NORMALIZATION_VERSION, normalizeSosEntity } from './normalize.ts';
import type { SosEntityRecord } from './record.ts';
import { openSosStream } from './stream.ts';

export { MN_SOS_ADAPTER_KEY, MN_SOS_SOURCE_ID };


export const SOS_CONNECTOR_VERSION = 'mn_sos_connector_1';
export const SOS_PARSER_VERSION = 'mn_sos_parser_1';
export const SOS_SCHEMA_VERSION = 'mn_business_bulk_data_v1';

/**
 * The implementation guide this connector's column layout was transcribed from.
 *
 * A delivery declaring a different guide version quarantines the run. Reading a
 * positional CSV against a layout the publisher has since changed is precisely
 * the failure that must never be silent.
 */
export const PINNED_GUIDE_VERSION = 'mbls-business-bulk-data-implementation-guide/2026-08-31';

/** Digest over the pinned column layout and Appendix II vocabularies. */
export const PINNED_LAYOUT_DIGEST = sha256(layoutSignature());

/** The registry jurisdiction the Minnesota register covers. */
export const MN_JURISDICTION_ID = 'us-mn';

export type SosConnectorOptions = {
  /**
   * A licensed delivery bundle an operator has placed on disk: the delivery
   * manifest as line 1, then the CSV verbatim. See docs/MN-SOS-BUSINESS-ENTITIES.md
   * for the one command that produces it.
   */
  readonly localFile?: string;
  readonly referencePeriod?: string;
  readonly sourceId?: string;
  /** Bounds the spill used to group rows by Master ID. Never changes output. */
  readonly sort?: SortOptions;
  /**
   * Present so the "no sanctioned transport" refusal can be exercised. The
   * runtime refuses any publisher-reaching transport for this source.
   */
  readonly transport?: Transport;
};

export function createMnSosBusinessConnector(options: SosConnectorOptions = {}): StreamingConnector {
  const sourceId = options.sourceId ?? MN_SOS_SOURCE_ID;
  const transport = options.transport ?? createLocalFileTransport();

  /**
   * Set by `openStream` from the delivery manifest.
   *
   * The generation timestamp and the register's jurisdiction are properties of
   * the *delivery*, not of the connector, and normalisation must not invent
   * either — so it refuses to run before a manifest has been read.
   */
  let delivery: { fileGeneratedAt: string; registryJurisdictionId: string } | null = null;

  const base: Connector = {
    adapterKey: MN_SOS_ADAPTER_KEY,
    connectorVersion: SOS_CONNECTOR_VERSION,
    parserVersion: SOS_PARSER_VERSION,
    normalizationVersion: SOS_NORMALIZATION_VERSION,
    schemaVersion: SOS_SCHEMA_VERSION,
    transport,
    /**
     * The bulk file is a state of the world: it restates the whole register each
     * month. So absence detection applies — a Master ID present in July and gone
     * in August is a fact about the delivery worth recording.
     *
     * It is *not* a fact about the company. A registration that leaves the file
     * has not necessarily ceased to exist, and nothing downstream may read it
     * that way.
     */
    snapshotSource: true,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      if (!options.localFile) {
        fail(
          'ACCESS_BLOCKED',
          'no licensed Minnesota SOS bulk delivery is available to this connector',
          {
            sourceId,
            reason:
              'Business Bulk Data is a purchased product delivered through the MBLS Portal to a signed-in '
              + 'account under an Electronic Media License Agreement (Minn. Stat. § 13.03 subd. 3). There is '
              + 'no machine endpoint, and neither the purchase nor the signature may be automated.',
            remedy:
              'purchase Business Bulk Data ($710 commercial one-time; free for news media, journalists, '
              + 'researchers and non-commercial use), download the ZIP from MBLS Portal → Transaction History, '
              + 'build the delivery bundle and pass it as localFile',
            doNot:
              'do not scrape the MBLS public search as a substitute; it is a different access route under '
              + 'different terms and is not the licensed product.',
          },
        );
      }
      const referencePeriod = options.referencePeriod ?? 'unspecified';
      return [{
        release: {
          releaseId: `${sourceId}__${referencePeriod}`,
          sourceId,
          releaseLabel: `Minnesota business bulk data ${referencePeriod}`,
          referencePeriod,
          publicationAt: null,
          // The register is restated monthly; a given month's file is not amended.
          finality: 'final',
          sourceVersion: SOS_SCHEMA_VERSION,
        },
        request: {
          locator: options.localFile,
          filename: options.localFile.split('/').pop() ?? 'mn-sos-delivery.bundle',
        },
      }];
    },

    // A 2.5 GB CSV must never be read into memory, so the buffered path is not
    // merely unimplemented — it is refused, so no caller can reach it by accident.
    parse(): ParsedBatch {
      return fail('CONFIG', 'the MN SOS connector is streaming; the runtime must call openStream');
    },
    validate(): BatchValidation {
      return fail('CONFIG', 'the MN SOS connector is streaming; the runtime must call openStream');
    },

    normalize(
      _ctx: ConnectorContext,
      parsed: ParsedRecord,
      evidence: SourceEvidence,
      change: ChangeContext,
    ): NormalizeResult {
      if (delivery === null) {
        fail('CONFIG', 'normalize was called before a delivery manifest was read');
      }
      const result = normalizeSosEntity(
        parsed.record as unknown as SosEntityRecord,
        evidence,
        change,
        delivery,
      );
      return {
        bundle: result.bundle,
        // Filing-party addresses for roles ordinarily held by natural persons.
        // They exist only here; no canonical type has a field that could hold one.
        contacts: result.contacts,
        extraRows: {
          business_entities: [result.entity],
          business_entity_names: result.names,
          business_entity_addresses: result.addresses,
          business_entity_filings: result.filings,
          business_filing_parties: result.parties,
        },
      };
    },
  };

  return {
    ...base,
    streaming: true,
    async openStream(_ctx, lines): Promise<StreamingParseSession> {
      const session = await openSosStream(lines, {
        schemaVersion: SOS_SCHEMA_VERSION,
        pinnedLayoutDigest: PINNED_LAYOUT_DIGEST,
        pinnedGuideVersion: PINNED_GUIDE_VERSION,
        ...(options.sort !== undefined ? { sort: options.sort } : {}),
      });
      delivery = {
        fileGeneratedAt: session.manifest.fileGeneratedAt,
        registryJurisdictionId: session.manifest.registryJurisdictionId,
      };
      return session;
    },
  };
}
