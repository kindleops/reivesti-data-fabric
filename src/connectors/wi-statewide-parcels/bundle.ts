/**
 * The publisher's archive → the snapshot bundle the streaming runtime ingests.
 *
 * The archive is the evidence: a zipped File Geodatabase, retained byte for byte
 * in the artifact store before anything reads it. The bundle is DERIVED from it
 * — the same NDJSON contract every ArcGIS-family source emits (header, one
 * feature per line, trailer) — so parsing, drift detection, routing,
 * partitioning, digesting and replay are the machinery Minnesota already proved.
 *
 * ## Deterministic by construction
 *
 * The bundle is a pure function of the archive's bytes. Its header carries no
 * clock reading of its own — the retrieval time is the archive manifest's, which
 * is fixed the moment the bytes landed — and rows are written in OBJECTID order
 * with the geodatabase's own column order. Re-deriving from the same archive on
 * another day, on another machine, with the network off, produces a
 * byte-identical bundle. That is what makes the network-off replay a proof and
 * not a re-run.
 *
 * ## Memory
 *
 * Two entries are inflated to scratch (the table and its offset index, 1.6 GB
 * and 18 MB for V12), CRC-verified, then read one row at a time. The scratch
 * copy is deleted afterwards; it is regenerable and it is not evidence.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../../core/hash.ts';
import { fail } from '../../core/errors.ts';
import { ESRI_REST_TYPE, gdbFileStem, openGdbTable, readGdbCatalog } from '../../core/filegdb.ts';
import { extractZipEntry, listZipFile, type ZipFileEntry } from '../../core/zip-file.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import { SNAPSHOT_TRAILER_KIND } from '../../runtime/arcgis-stream.ts';

/** Its own bundle kind: these bytes came from a geodatabase, not a crawl. */
export const FILEGDB_BUNDLE_KIND = 'df.filegdb.snapshot/1';

/** The parcel table's name inside a V-series geodatabase. */
const PARCEL_TABLE = /^V\d{4}_WisconsinParcels_\d{4}$/;

export type BundleDerivationInput = {
  /** Path of the retained, verified publisher archive. */
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly archiveUrl: string | null;
  readonly archiveFilename: string;
  /** The archive manifest's retrieval time. Never "now". */
  readonly retrievedAt: string;
  readonly referencePeriod: string;
  readonly sourceId: string;
  readonly serviceUrl: string;
  readonly layerId: number;
  readonly scratchDir: string;
  /** Stop after this many rows. Fixtures and smoke tests only. */
  readonly maxRows?: number;
};

export type BundleDerivation = {
  readonly tableName: string;
  readonly validRowCount: number;
  readonly rowsWritten: number;
  readonly rowsWithoutGeometry: number;
  /**
   * Every publisher row, grouped by the raw CONAME string (null as `(null)`),
   * placeholders included — the basis the county inventory was measured on.
   * Bounded by the number of distinct CONAME values, not by rows.
   */
  readonly rowsByConame: Readonly<Record<string, number>>;
  readonly deletedSlots: number;
  readonly fields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
  readonly sourceSchemaDigest: string;
  readonly geometry: { readonly type: string; readonly spatialReference: string | null; readonly hasZ: boolean; readonly hasM: boolean };
  readonly extractMs: number;
  readonly readMs: number;
};

/** Converts the archive, handing each bundle line to `write`. Holds one row. */
export async function deriveWiBundle(
  input: BundleDerivationInput,
  write: (line: string) => Promise<void>,
): Promise<BundleDerivation> {
  const extractStart = Date.now();
  await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
  const workDir = await mkdtemp(join(input.scratchDir, 'gdb-'));
  try {
    const entries = await listZipFile(input.archivePath);
    const gdbEntries = entries.filter((e) => !e.isDirectory && /\.gdb\/[^/]+$/.test(e.name));
    if (gdbEntries.length === 0) fail('PARSE', 'the archive contains no File Geodatabase');
    const byBase = new Map<string, ZipFileEntry>(gdbEntries.map((e) => [e.name.slice(e.name.lastIndexOf('/') + 1), e]));

    const extract = async (base: string): Promise<void> => {
      const entry = byBase.get(base);
      if (entry === undefined) fail('PARSE', `the geodatabase is missing ${base}`);
      await extractZipEntry(input.archivePath, entry, join(workDir, base));
    };

    // The catalogue first, to find the parcel table by name rather than by
    // assuming its file number.
    await extract('a00000001.gdbtable');
    await extract('a00000001.gdbtablx');
    const catalog = await readGdbCatalog(workDir);
    const candidates = [...catalog.keys()].filter((name) => PARCEL_TABLE.test(name));
    if (candidates.length !== 1) {
      fail('SCHEMA_DRIFT', `expected exactly one V-series parcel table, found ${candidates.length}`, {
        tables: [...catalog.keys()],
      });
    }
    const tableName = candidates[0] as string;
    const stem = catalog.get(tableName) as string;
    await extract(`${stem}.gdbtable`);
    await extract(`${stem}.gdbtablx`);
    const extractMs = Date.now() - extractStart;

    const readStart = Date.now();
    const table = await openGdbTableOrFail(workDir, stem, tableName);
    try {
      const info = table.info;
      const fields = info.fields
        .filter((f) => f.type !== 'geometry')
        .map((f) => ({
          name: f.name,
          type: ESRI_REST_TYPE[f.type],
          ...(f.length !== null ? { length: f.length } : {}),
        }));
      const sourceSchemaDigest = fieldSetDigestOf(fields);
      const geometryField = info.fields.find((f) => f.type === 'geometry');

      await write(canonicalJson({
        kind: FILEGDB_BUNDLE_KIND,
        sourceId: input.sourceId,
        serviceUrl: input.serviceUrl,
        layerId: input.layerId,
        referencePeriod: input.referencePeriod,
        acquisition: {
          method: 'publisher_bulk_download',
          downloadUrl: input.archiveUrl,
          archiveFilename: input.archiveFilename,
          archiveSha256: input.archiveSha256,
          archiveBytes: input.archiveBytes,
          format: 'esri_file_geodatabase_10_3_uncompressed_zip',
          table: tableName,
          tableFileStem: stem,
          tableFormatVersion: info.formatVersion,
          note: 'The publisher\'s own statewide archive, read directly. The FeatureServer was used only as a '
            + 'witness: its crawl is 1,788 pages and degrades past 28 s per page at depth.',
        },
        retrievedAt: input.retrievedAt,
        sourceReportedCount: info.validRowCount,
        sourceSchemaDigest,
        layerMetadata: { fields },
        declaredFields: fields.map((f) => f.name).sort(),
        geometry: {
          field: geometryField?.name ?? null,
          type: info.geometry.geometryType,
          spatialReference: spatialReferenceName(info.geometry.spatialReferenceWkt),
          hasZ: info.geometry.hasZ,
          hasM: info.geometry.hasM,
          policy: 'retained in the publisher archive; not decoded into canonical rows',
        },
      }));

      let rowsWritten = 0;
      let rowsWithoutGeometry = 0;
      let lastObjectId = 0;
      const byConame = new Map<string, number>();
      for await (const row of table.rows()) {
        if (input.maxRows !== undefined && rowsWritten >= input.maxRows) break;
        // Nulls are already omitted by the reader, exactly as the REST API omits
        // them, so a row digests the same whichever path delivered it.
        await write(JSON.stringify(row.attributes));
        const coname = (row.attributes as Record<string, unknown>)['CONAME'];
        const conameKey = typeof coname === 'string' ? coname : '(null)';
        byConame.set(conameKey, (byConame.get(conameKey) ?? 0) + 1);
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
        tableName,
        validRowCount: info.validRowCount,
        rowsWritten,
        rowsWithoutGeometry,
        rowsByConame: Object.fromEntries([...byConame].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        deletedSlots: complete ? info.indexedRowCount - rowsWritten : 0,
        fields,
        sourceSchemaDigest,
        geometry: {
          type: info.geometry.geometryType,
          spatialReference: spatialReferenceName(info.geometry.spatialReferenceWkt),
          hasZ: info.geometry.hasZ,
          hasM: info.geometry.hasM,
        },
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

async function openGdbTableOrFail(dir: string, stem: string, name: string) {
  if (stem !== gdbFileStem(Number.parseInt(stem.slice(1), 16))) fail('PARSE', `unexpected table file stem ${stem}`);
  return openGdbTable(dir, stem, name);
}

/** `PROJCS["NAD_1983_HARN_Wisconsin_TM",…` → `NAD_1983_HARN_Wisconsin_TM`. */
function spatialReferenceName(wkt: string | null): string | null {
  if (wkt === null) return null;
  const m = /^[A-Z]+\["([^"]+)"/.exec(wkt);
  return m ? (m[1] as string) : null;
}
