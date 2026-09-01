/**
 * The publisher's bulk GeoPackage, converted to the ArcGIS snapshot bundle.
 *
 * ## Why this exists
 *
 * MnGeo publishes the statewide layer two ways, and both are sanctioned: an
 * ArcGIS FeatureServer, and a GeoPackage download listed as a distribution of
 * the same dataset. DF-0H measured both:
 *
 *   ArcGIS query   37.6 s for 2,000 rows by resultOffset, 51.5 s by objectIds.
 *                  2,710,201 rows is 1,356 pages — **14 to 19 hours** of
 *                  sustained querying against a public state service.
 *   GeoPackage     2,624,212,992 bytes in about two minutes. One request.
 *
 * So the bulk file is the primary acquisition path. That is not a workaround: it
 * is the publisher's own bulk distribution, and hammering a state government's
 * query endpoint for most of a day when a bulk file is offered would be
 * inconsiderate as well as fragile. The ArcGIS transport stays implemented and
 * generic — it is the right path for sources with no bulk distribution, and the
 * verification path for this one.
 *
 * ## The bundle contract is the boundary
 *
 * Acquisition is pluggable; everything downstream is not. This module emits
 * exactly the same NDJSON snapshot bundle the live crawl emits — header line,
 * one feature per line, trailer — so parsing, drift detection, county routing,
 * partitioning, digesting and replay are identical whichever way the bytes
 * arrived. A record ingested from the GeoPackage and the same record ingested
 * from the API produce the same canonical row.
 *
 * Memory is one row at a time: the SQLite cursor is iterated, never materialised.
 */
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from '../../core/hash.ts';
import { fail } from '../../core/errors.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import { SNAPSHOT_TRAILER_KIND } from '../../runtime/arcgis-stream.ts';
import { mnStatewideOutFields } from './field-map.ts';

/**
 * Its own bundle kind. The bytes did not come from an ArcGIS crawl, and saying
 * they did would misdescribe the provenance of the artifact.
 */
export const GPKG_BUNDLE_KIND = 'df.gpkg.snapshot/1';

/** Columns the GeoPackage adds that are not source attributes. */
const NON_ATTRIBUTE_COLUMNS: ReadonlySet<string> = new Set(['Shape', 'gdb_geomattr_data', 'Shape_Length', 'Shape_Area']);

export type GpkgConversionOptions = {
  readonly gpkgPath: string;
  /** Feature table inside the GeoPackage. */
  readonly table: string;
  /** Per-county metadata table, when the package carries one. */
  readonly metadataTable?: string;
  readonly sourceId: string;
  readonly serviceUrl: string;
  readonly layerId: number;
  /** Field set as the live service declares it, for the drift digest. */
  readonly liveFields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
  readonly downloadUrl: string;
  readonly archiveSha256: string;
  readonly retrievedAt: string;
  /** Stop after this many rows. For fixtures and smoke runs only. */
  readonly maxRows?: number;
};

export type GpkgConversionResult = {
  readonly rowsWritten: number;
  readonly reportedCount: number;
  readonly sourceSchemaDigest: string;
};

/**
 * Streams the GeoPackage out as a snapshot bundle.
 *
 * `write` is called once per line. The caller decides where lines go — a file,
 * the artifact store's sink — so this function never holds the output either.
 */
export async function convertGpkgToBundle(
  options: GpkgConversionOptions,
  write: (line: string) => Promise<void>,
): Promise<GpkgConversionResult> {
  const db = new DatabaseSync(options.gpkgPath, { readOnly: true });
  try {
    const columns = (db.prepare(`pragma table_info('${options.table}')`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => !NON_ATTRIBUTE_COLUMNS.has(c));
    if (columns.length === 0) fail('PARSE', `GeoPackage table "${options.table}" has no attribute columns`);

    // The GeoPackage capitalises the object id where the service lower-cases it.
    // Normalised here so a record is identical whichever path it arrived by.
    const select = columns.map((c) => (c === 'OBJECTID' ? '"OBJECTID" as objectid' : `"${c}"`)).join(', ');

    const reportedCount = (db.prepare(`select count(*) n from "${options.table}"`).get() as { n: number }).n;
    const sourceSchemaDigest = fieldSetDigestOf(options.liveFields);

    // Per-county metadata travels in the header: it is the participation record
    // and the per-county freshness evidence, and it belongs inside the immutable
    // artifact rather than in a note beside it.
    let countyMetadata: readonly Record<string, unknown>[] = [];
    if (options.metadataTable !== undefined) {
      try {
        countyMetadata = (db.prepare(
          `select countyfips, countyname, rundate, acqdate, gac_open_approval, data_url from "${options.metadataTable}" order by countyfips`,
        ).all() as Record<string, unknown>[]).map((r) => ({ ...r }));
      } catch {
        countyMetadata = [];
      }
    }

    const header = {
      kind: GPKG_BUNDLE_KIND,
      sourceId: options.sourceId,
      serviceUrl: options.serviceUrl,
      layerId: options.layerId,
      acquisition: {
        method: 'publisher_bulk_download',
        downloadUrl: options.downloadUrl,
        archiveSha256: options.archiveSha256,
        note: 'The publisher\'s own bulk distribution of the same dataset the FeatureServer serves. '
          + 'Chosen over 1,356 paginated queries: one request, and the query path measured 14-19 hours.',
      },
      retrievedAt: options.retrievedAt,
      sourceReportedCount: reportedCount,
      sourceSchemaDigest,
      // Shaped exactly as the ArcGIS header's layer metadata so the generic
      // session's drift check works unchanged.
      layerMetadata: { fields: options.liveFields.map((f) => ({ name: f.name, type: f.type, length: f.length })) },
      declaredFields: [...mnStatewideOutFields()].sort(),
      countyMetadata,
    };
    await write(canonicalJson(header));

    const limit = options.maxRows === undefined ? '' : ` limit ${Math.max(0, Math.trunc(options.maxRows))}`;
    // Ordered by the package's own row id so the artifact is byte-reproducible
    // from the same GeoPackage, which is what makes replay meaningful.
    const cursor = db.prepare(`select ${select} from "${options.table}" order by "OBJECTID"${limit}`);

    let rowsWritten = 0;
    for (const row of cursor.iterate() as Iterable<Record<string, unknown>>) {
      const attributes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        // SQLite hands back nulls for empty columns; the API omits them. Both
        // become an absent key so the two paths digest identically.
        if (value === null) continue;
        attributes[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      await write(JSON.stringify(attributes));
      rowsWritten += 1;
    }

    await write(canonicalJson({
      kind: SNAPSHOT_TRAILER_KIND,
      retrievedFeatureCount: rowsWritten,
      sourceReportedCountAtEnd: reportedCount,
      // A bulk file is a single consistent export, so it cannot move underneath
      // the reader the way a live crawl can. Stated rather than assumed.
      sourceChangedDuringRead: false,
      missingObjectIds: [],
    }));

    return { rowsWritten, reportedCount, sourceSchemaDigest };
  } finally {
    db.close();
  }
}

/** Digest of a GeoPackage's attribute schema, for pinning. */
export function gpkgSchemaDigest(gpkgPath: string, table: string): string {
  const db = new DatabaseSync(gpkgPath, { readOnly: true });
  try {
    const columns = (db.prepare(`pragma table_info('${table}')`).all() as { name: string; type: string }[])
      .filter((c) => !NON_ATTRIBUTE_COLUMNS.has(c.name));
    return sha256(columns.map((c) => `${c.name}:${c.type}`).sort().join('\n'));
  } finally {
    db.close();
  }
}
