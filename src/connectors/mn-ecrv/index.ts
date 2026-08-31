/**
 * Minnesota eCRV Weekly Sales Extract connector.
 *
 * Live retrieval status: BLOCKED_ON_ACCESS. The department distributes the
 * extract to approved requesters (ecrv.support@state.mn.us); until that approval
 * exists the registry records automation as `manual_only` and the runtime refuses
 * any transport that would reach the publisher. Everything after retrieval —
 * archival, schema validation, parsing, normalisation, revision detection,
 * replay — runs today against operator-supplied files and fixtures, and will run
 * unchanged against the live feed on the day access is granted.
 *
 * The schema is not transcribed. The connector compiles the department's own
 * published Schema 3 XSD at load time and pins its digest, so a republished or
 * tampered schema file fails immediately rather than quietly changing behaviour.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from '../../core/errors.ts';
import { contentDigest, sha256 } from '../../core/hash.ts';
import type { SourceEvidence } from '../../canonical/models.ts';
import type {
  BatchValidation,
  Connector,
  ConnectorContext,
  DiscoveredRelease,
  NormalizeResult,
  ParsedBatch,
  ParsedRecord,
  RecordValidation,
  SourceRelease,
} from '../../runtime/connector.ts';
import { createLocalFileTransport, type Transport } from '../../runtime/transport.ts';
import { compileXsd, schemaDigest, validateInstance, type ValidationIssue, type XsdModel } from '../../schema/xsd.ts';
import { MN_ECRV_ADAPTER_KEY, MN_ECRV_SOURCE_ID } from '../../registry/sources.ts';
import { ecrvSourceRecordId, parseEcrvDocument, splitArtifact } from './parse.ts';
import { NORMALIZATION_VERSION, normalizeEcrv } from './normalize.ts';

export const CONNECTOR_VERSION = 'mn_ecrv_connector_1';
export const PARSER_VERSION = 'mn_ecrv_parser_1';
export const SCHEMA_VERSION = 'sales_extract_schema_3';

/**
 * sha256 of the department's published Schema 3 XSD
 * (revenue.state.mn.us/sites/default/files/2020-10/Sales Extract Schema3 10-9-2020.txt),
 * retrieved 2026-08-31. Effective for all extracts on or after 2020-11-09.
 */
export const PINNED_SCHEMA_SHA256 = '2bf2edb3094abc7ce0805f1497978646efda6fab929d1aa7a395f7efe483e820';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PINNED_SCHEMA_PATH = resolve(HERE, '../../../fixtures/mn-ecrv/schema/sales-extract-schema-3.xsd');

let cached: { model: XsdModel; digest: string } | null = null;

export function loadPinnedSchema(path: string = PINNED_SCHEMA_PATH): { model: XsdModel; digest: string } {
  if (cached && path === PINNED_SCHEMA_PATH) return cached;
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    return fail('CONFIG', `pinned eCRV schema is missing at ${path}`, { cause: (e as Error).message });
  }
  const actual = sha256(source);
  if (actual !== PINNED_SCHEMA_SHA256) {
    fail('SCHEMA_DRIFT', 'pinned eCRV schema file does not match its recorded digest', {
      path,
      expected: PINNED_SCHEMA_SHA256,
      actual,
      remedy: 'confirm the publisher reissued the schema, review the diff, then update PINNED_SCHEMA_SHA256 and the field map together',
    });
  }
  const model = compileXsd(source, 'sales-extract-schema-3.xsd');
  const result = { model, digest: schemaDigest(model) };
  if (path === PINNED_SCHEMA_PATH) cached = result;
  return result;
}

/** Drift is a property of the publisher's structure, not of one bad filing. */
const DRIFT_CODES: ReadonlySet<ValidationIssue['code']> = new Set(['unknown_element', 'enum_violation', 'wrong_root']);

const validations = new WeakMap<ParsedBatch, BatchValidation>();

export type LocalRelease = {
  readonly path: string;
  /** The period the extract describes, e.g. "2026-W31". */
  readonly referencePeriod: string;
  readonly releaseLabel?: string;
  readonly publicationAt?: string;
  readonly finality?: SourceRelease['finality'];
};

export type EcrvConnectorOptions = {
  /** Files an operator has already obtained lawfully. The only supported input today. */
  readonly localReleases?: readonly LocalRelease[];
  readonly transport?: Transport;
  readonly schemaPath?: string;
  readonly sourceId?: string;
};

export function createMnEcrvConnector(options: EcrvConnectorOptions = {}): Connector {
  const sourceId = options.sourceId ?? MN_ECRV_SOURCE_ID;
  const transport = options.transport ?? createLocalFileTransport();
  const schemaPath = options.schemaPath ?? PINNED_SCHEMA_PATH;

  return {
    adapterKey: MN_ECRV_ADAPTER_KEY,
    connectorVersion: CONNECTOR_VERSION,
    parserVersion: PARSER_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    schemaVersion: SCHEMA_VERSION,
    transport,

    async discover(): Promise<readonly DiscoveredRelease[]> {
      const releases = options.localReleases ?? [];
      if (releases.length === 0) {
        fail(
          'ACCESS_BLOCKED',
          'no eCRV Weekly Sales Extract is available to this connector',
          {
            sourceId,
            remedy:
              'request extract access from ecrv.support@state.mn.us, then configure localReleases with the delivered file, '
              + 'or supply a file an operator has already obtained',
          },
        );
      }
      return releases.map((r) => ({
        release: {
          releaseId: `${sourceId}__${r.referencePeriod}`,
          sourceId,
          releaseLabel: r.releaseLabel ?? `eCRV Weekly Sales Extract ${r.referencePeriod}`,
          referencePeriod: r.referencePeriod,
          publicationAt: r.publicationAt ?? null,
          // The department may reissue a week's extract; nothing in the feed
          // declares finality, so we do not claim it.
          finality: r.finality ?? 'unknown',
          sourceVersion: SCHEMA_VERSION,
        },
        request: { locator: r.path, filename: basenameOf(r.path) },
      }));
    },

    parse(ctx: ConnectorContext, bytes: Uint8Array): ParsedBatch {
      const { model, digest } = loadPinnedSchema(schemaPath);
      const documents = splitArtifact(bytes);

      const records: ParsedRecord[] = [];
      const recordValidations: RecordValidation[] = [];
      const unknownFields = new Set<string>();
      const missingFields = new Set<string>();
      const seen = new Map<string, string>();

      for (const doc of documents) {
        const parsed = parseEcrvDocument(doc.xml, doc.name);
        const issues = [...validateInstance(parsed.root, model)];

        // The county code appears twice in the filing. If the two disagree the
        // record has no unambiguous jurisdiction, and guessing is not an option.
        const propertyCounty = parsed.record.property.countyCode;
        if (propertyCounty !== null && propertyCounty !== parsed.record.countyCode) {
          issues.push({
            code: 'type_violation',
            path: '/ecrvForm/propertyForm/county',
            message: `propertyForm/county "${propertyCounty}" disagrees with headerForm/countyCde "${parsed.record.countyCode}"`,
          });
        }

        // Two documents claiming the same publisher key inside one artifact is a
        // publisher-side fault; both are flagged rather than one silently winning.
        const previous = seen.get(parsed.sourceRecordId);
        if (previous !== undefined) {
          issues.push({
            code: 'cardinality',
            path: '/ecrvForm/headerForm/crvNumberId',
            message: `duplicate source record ${parsed.sourceRecordId}, already read from ${previous}`,
          });
        }
        seen.set(parsed.sourceRecordId, doc.name);

        for (const issue of issues) {
          if (issue.code === 'unknown_element') unknownFields.add(issue.path);
          if (issue.code === 'missing_element') missingFields.add(issue.path);
        }

        records.push({
          sourceRecordId: parsed.sourceRecordId,
          record: parsed.record as unknown as Readonly<Record<string, unknown>>,
          contentDigest: contentDigest(parsed.record),
          rawFragmentDigest: sha256(doc.xml),
        });
        recordValidations.push({ sourceRecordId: parsed.sourceRecordId, issues });
      }

      const driftReasons: string[] = [];
      for (const rv of recordValidations) {
        for (const issue of rv.issues) {
          if (DRIFT_CODES.has(issue.code)) driftReasons.push(`${issue.code} at ${issue.path}: ${issue.message}`);
        }
      }

      const batch: ParsedBatch = {
        records,
        schemaDigest: digest,
        schemaVersion: SCHEMA_VERSION,
        unknownFields: [...unknownFields].sort(),
        missingFields: [...missingFields].sort(),
      };

      validations.set(batch, {
        schemaDrift: driftReasons.length > 0,
        // Deduplicated: one added element across 40,000 filings is one reason.
        driftReasons: [...new Set(driftReasons)].sort().slice(0, 25),
        records: recordValidations.map((rv) => ({
          sourceRecordId: rv.sourceRecordId,
          issues: rv.issues.filter((i) => !DRIFT_CODES.has(i.code)),
        })),
      });

      ctx.logger.debug('mn_ecrv.parsed', { documents: documents.length, records: records.length });
      return batch;
    },

    validate(_ctx: ConnectorContext, batch: ParsedBatch): BatchValidation {
      const v = validations.get(batch);
      if (!v) fail('CONFIG', 'validate() called with a batch this connector did not produce');
      return v;
    },

    normalize(_ctx: ConnectorContext, parsed: ParsedRecord, evidence: SourceEvidence): NormalizeResult {
      const result = normalizeEcrv(parsed.record as never, evidence, sourceId);
      return { bundle: result.bundle, contacts: result.contacts };
    },
  };
}

function basenameOf(path: string): string {
  return join(path).split('/').pop() ?? path;
}

export { ecrvSourceRecordId };
