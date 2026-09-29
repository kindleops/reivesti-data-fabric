/**
 * The publisher's archive → the snapshot bundle the streaming runtime ingests.
 *
 * The archive is the evidence: a zipped File Geodatabase, retained byte for byte
 * in the artifact store before anything reads it. The bundle is DERIVED from it
 * — the same NDJSON contract every ArcGIS-family source emits (header, one
 * feature per line, trailer) — so parsing, drift detection, routing,
 * partitioning, digesting and replay are the machinery Minnesota and Wisconsin
 * already proved.
 *
 * ## Deterministic by construction
 *
 * The bundle is a pure function of the archive's bytes. Its header carries only
 * what the archive and fixed constants say — no clock reading, no discovered
 * service URL (that moves with the 2026 migration and lives in the ledger) —
 * and rows are written in OBJECTID order with the geodatabase's own column
 * order. Re-deriving from the same archive with the network off produces a
 * byte-identical bundle.
 *
 * ## Stored compressed
 *
 * 5.5 million rows of 73 attributes is ~6.6 GB of NDJSON. The bundle is written
 * gzip-compressed (`*.ndjson.gz`, a fixed level, fixed 64 KiB input chunks, no
 * flushes, zero header timestamp), which the runtime's line reader already
 * decompresses on the fly. The raw evidence is the publisher's archive, not
 * this file; the bundle is REGENERABLE from it.
 *
 * ## Memory
 *
 * Two entries are inflated to scratch (the table and its offset index, 2.28 GB
 * and 28 MB for the 2025 roll), CRC-verified, then read one row at a time. The
 * scratch copy is deleted afterwards; it is regenerable and it is not evidence.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { join } from 'node:path';
import type { ByteSink } from '../../archive/object-store.ts';
import { canonicalJson } from '../../core/hash.ts';
import { fail } from '../../core/errors.ts';
import { ESRI_REST_TYPE, gdbFileStem, openGdbTable, readGdbCatalog } from '../../core/filegdb.ts';
import { extractZipEntry, listZipFile, type ZipFileEntry } from '../../core/zip-file.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import { SNAPSHOT_TRAILER_KIND } from '../../runtime/arcgis-stream.ts';
import { labelFromGeodatabase, type NyReleaseLabel } from './release.ts';

/**
 * The bundle kind every geodatabase-derived statewide bundle declares: these
 * bytes came from a geodatabase, not a crawl. The same value Wisconsin's uses.
 */
export const NY_FILEGDB_BUNDLE_KIND = 'df.filegdb.snapshot/1';

/** The artifact's filename. The `.gz` suffix is what makes every reader decompress it. */
export const NY_BUNDLE_FILENAME = 'ny-statewide-parcels.bundle.ndjson.gz';

/** Fixed, so the compressed bytes are a pure function of the rows. */
export const NY_BUNDLE_GZIP_LEVEL = 6;
const GZIP_INPUT_CHUNK = 64 * 1024;

/** The centroid table's name inside the geodatabase. Lookup tables sit beside it. */
const CENTROID_TABLE = /^NYS_Tax_Parcels?_Centroid_Points$/i;

export type NyBundleDerivationInput = {
  /** Path of the retained, verified publisher archive. */
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly archiveUrl: string | null;
  readonly archiveFilename: string;
  /** The archive manifest's retrieval time. Never "now". */
  readonly retrievedAt: string;
  /** The release the archive must be. A different geodatabase name is refused. */
  readonly referencePeriod: string;
  readonly sourceId: string;
  readonly layerId: number;
  readonly scratchDir: string;
  /** Stop after this many rows. Fixtures and smoke tests only. */
  readonly maxRows?: number;
};

export type NyBundleDerivation = {
  readonly geodatabase: string;
  readonly label: NyReleaseLabel;
  readonly tableName: string;
  readonly catalogTables: readonly string[];
  readonly validRowCount: number;
  readonly rowsWritten: number;
  readonly rowsWithoutGeometry: number;
  /**
   * Every publisher row, grouped by the raw COUNTY_NAME (null as `(null)`),
   * quarantined rows included — the basis the county inventory was measured on.
   * Bounded by the number of distinct names, not by rows.
   */
  readonly rowsByCountyName: Readonly<Record<string, number>>;
  readonly deletedSlots: number;
  readonly fields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
  readonly sourceSchemaDigest: string;
  readonly geometry: { readonly type: string; readonly spatialReference: string | null; readonly hasZ: boolean; readonly hasM: boolean };
  readonly extractMs: number;
  readonly readMs: number;
};

/** Converts the archive, handing each bundle line to `write`. Holds one row. */
export async function deriveNyBundle(
  input: NyBundleDerivationInput,
  write: (line: string) => Promise<void>,
): Promise<NyBundleDerivation> {
  const extractStart = Date.now();
  await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(input.scratchDir, 'gdb-'));
  try {
    const entries = await listZipFile(input.archivePath);
    const gdbNames = new Set<string>();
    for (const e of entries) for (const part of e.name.split('/')) if (/\.gdb$/i.test(part)) gdbNames.add(part);
    if (gdbNames.size !== 1) fail('PARSE', `the archive holds ${gdbNames.size} geodatabases, expected exactly one`, { geodatabases: [...gdbNames] });
    const geodatabase = [...gdbNames][0] as string;
    const label = labelFromGeodatabase(geodatabase);
    if (label === null) fail('SCHEMA_DRIFT', `"${geodatabase}" is not a centroid geodatabase name this connector knows`);
    if (label.referencePeriod !== input.referencePeriod) {
      fail('SCHEMA_DRIFT', `the archive is release ${label.referencePeriod}, not ${input.referencePeriod}`, {
        geodatabase,
        remedy: 'the archive and the release discovery named disagree; nothing is derived from a misnamed release',
      });
    }

    const gdbEntries = entries.filter((e) => !e.isDirectory && e.name.includes(`${geodatabase}/`));
    const byBase = new Map<string, ZipFileEntry>(gdbEntries.map((e) => [e.name.slice(e.name.lastIndexOf('/') + 1), e]));
    const extract = async (base: string): Promise<void> => {
      const entry = byBase.get(base);
      if (entry === undefined) fail('PARSE', `the geodatabase is missing ${base}`);
      await extractZipEntry(input.archivePath, entry, join(workDir, base));
    };

    // The catalogue first, to find the centroid table by name rather than by
    // assuming its file number.
    await extract('a00000001.gdbtable');
    await extract('a00000001.gdbtablx');
    const catalog = await readGdbCatalog(workDir);
    const catalogTables = [...catalog.keys()].filter((n) => !n.startsWith('GDB_')).sort();
    const candidates = [...catalog.keys()].filter((name) => CENTROID_TABLE.test(name));
    if (candidates.length !== 1) {
      fail('SCHEMA_DRIFT', `expected exactly one centroid table, found ${candidates.length}`, { tables: [...catalog.keys()] });
    }
    const tableName = candidates[0] as string;
    const stem = catalog.get(tableName) as string;
    if (stem !== gdbFileStem(Number.parseInt(stem.slice(1), 16))) fail('PARSE', `unexpected table file stem ${stem}`);
    await extract(`${stem}.gdbtable`);
    await extract(`${stem}.gdbtablx`);
    const extractMs = Date.now() - extractStart;

    const readStart = Date.now();
    const table = await openGdbTable(workDir, stem, tableName);
    try {
      const info = table.info;
      const fields = info.fields
        .filter((f) => f.type !== 'geometry')
        .map((f) => ({ name: f.name, type: ESRI_REST_TYPE[f.type], ...(f.length !== null ? { length: f.length } : {}) }));
      const sourceSchemaDigest = fieldSetDigestOf(fields);
      const geometryField = info.fields.find((f) => f.type === 'geometry');
      const spatialReference = spatialReferenceName(info.geometry.spatialReferenceWkt);

      await write(canonicalJson({
        kind: NY_FILEGDB_BUNDLE_KIND,
        sourceId: input.sourceId,
        // The witness service is discovered per run and moves with the 2026
        // migration; it is recorded in the ledger, never in the bundle.
        serviceUrl: null,
        layerId: input.layerId,
        referencePeriod: input.referencePeriod,
        acquisition: {
          method: 'publisher_bulk_download',
          downloadUrl: input.archiveUrl,
          archiveFilename: input.archiveFilename,
          archiveSha256: input.archiveSha256,
          archiveBytes: input.archiveBytes,
          format: 'esri_file_geodatabase_zip',
          geodatabase,
          rollYear: label.rollYear,
          build: label.build,
          table: tableName,
          tableFileStem: stem,
          tableFormatVersion: info.formatVersion,
          catalogTables,
          note: 'The publisher\'s own statewide archive, read directly. The FeatureServer was used only as a '
            + 'witness: a crawl of 5.5 million points is 2,756 pages against a public service.',
        },
        retrievedAt: input.retrievedAt,
        sourceReportedCount: info.validRowCount,
        sourceSchemaDigest,
        layerMetadata: { fields },
        declaredFields: fields.map((f) => f.name).sort(),
        geometry: {
          field: geometryField?.name ?? null,
          type: info.geometry.geometryType,
          spatialReference,
          hasZ: info.geometry.hasZ,
          hasM: info.geometry.hasM,
          policy: 'the parcel centroid point; retained in the publisher archive, not decoded into canonical rows',
        },
      }));

      let rowsWritten = 0;
      let rowsWithoutGeometry = 0;
      let lastObjectId = 0;
      const byCounty = new Map<string, number>();
      for await (const row of table.rows()) {
        if (input.maxRows !== undefined && rowsWritten >= input.maxRows) break;
        // Nulls are already omitted by the reader, exactly as the REST API omits
        // them, so a row digests the same whichever path delivered it.
        await write(JSON.stringify(row.attributes));
        const county = (row.attributes as Record<string, unknown>)['COUNTY_NAME'];
        const key = typeof county === 'string' ? county : '(null)';
        byCounty.set(key, (byCounty.get(key) ?? 0) + 1);
        if (row.geometryBytes === null) rowsWithoutGeometry += 1;
        rowsWritten += 1;
        lastObjectId = row.objectId;
      }

      const complete = input.maxRows === undefined;
      await write(canonicalJson({
        kind: SNAPSHOT_TRAILER_KIND,
        retrievedFeatureCount: rowsWritten,
        sourceReportedCountAtEnd: info.validRowCount,
        // One file, one consistent export: it cannot move under the reader.
        sourceChangedDuringRead: false,
        missingObjectIds: [],
        rowsWithoutGeometry,
        lastObjectId,
        truncatedForFixture: !complete,
      }));

      return {
        geodatabase,
        label,
        tableName,
        catalogTables,
        validRowCount: info.validRowCount,
        rowsWritten,
        rowsWithoutGeometry,
        rowsByCountyName: Object.fromEntries([...byCounty].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        deletedSlots: complete ? info.indexedRowCount - rowsWritten : 0,
        fields,
        sourceSchemaDigest,
        geometry: { type: info.geometry.geometryType, spatialReference, hasZ: info.geometry.hasZ, hasM: info.geometry.hasM },
        extractMs,
        readMs: Date.now() - readStart,
      };
    } finally {
      await table.close();
    }
  } finally {
    // Scratch, not evidence. The archive it came from is the evidence.
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * A line writer that gzips into a byte sink, deterministically: fixed level,
 * fixed input chunking, no intermediate flush, and Node's zlib writes a zero
 * timestamp in the gzip header.
 */
export function gzipLineWriter(sink: ByteSink, level: number = NY_BUNDLE_GZIP_LEVEL): {
  write(line: string): Promise<void>;
  close(): Promise<void>;
} {
  const gzip = createGzip({ level });
  const done = pipeline(gzip, new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sink.write(chunk).then(() => callback(), callback);
    },
  }));
  // Surfaced by close(); attached now so a failing sink is never unhandled.
  done.catch(() => {});
  let pending: string[] = [];
  let size = 0;
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const chunk = Buffer.from(pending.join(''), 'utf8');
    pending = [];
    size = 0;
    if (!gzip.write(chunk)) await Promise.race([once(gzip, 'drain'), done]);
  };
  return {
    async write(line) {
      pending.push(line, '\n');
      size += line.length + 1;
      if (size >= GZIP_INPUT_CHUNK) await flush();
    },
    async close() {
      await flush();
      gzip.end();
      await done;
    },
  };
}

/** `PROJCS["NAD_1983_UTM_Zone_18N",…` → `NAD_1983_UTM_Zone_18N`. */
function spatialReferenceName(wkt: string | null): string | null {
  if (wkt === null) return null;
  const m = /^[A-Z]+\["([^"]+)"/.exec(wkt);
  return m ? (m[1] as string) : null;
}
