/**
 * Florida county CSV files → one statewide snapshot stream.
 *
 * The NAL and the SDF are published as one zipped, comma-delimited file per
 * county, "with field names in the first row". This reads the retained zips in
 * release-manifest order and yields the snapshot-bundle lines the streaming
 * runtime consumes: a header, one attribute object per data row, a trailer.
 * Nothing is buffered beyond one CSV record, and nothing is written to disk.
 *
 * ## Layouts are pinned per file
 *
 * A county file must carry EXACTLY one of the pinned column lists — same
 * names, same order. The 2026 NAL has two (65 preliminary files with 165
 * columns, 2 final files with 167); the SDF has one. A file in any other layout
 * is schema drift: the stream's header then declares a field set that cannot
 * match the pinned digest, and the runtime quarantines the whole run before a
 * row is interpreted. A missing column is not read as "blank on every row".
 *
 * ## What each row carries besides the publisher's fields
 *
 *   __f   sha256 of the county file the row was read from   (provenance)
 *   __c   the county the release manifest filed it under     (cross-check)
 *   __s   P or F, the file's roll stage                      (provenance)
 *   __n   1-based data-row number within the file            (provenance)
 *   __lm  the publisher's Last-Modified for the file         (freshness)
 *
 * All five are excluded from change detection: a county re-posting the same
 * rows in a new file, a new row order, or a later stage is not a change to any
 * parcel's attributes. The stage still travels on every observation.
 *
 * Values are trimmed of outer whitespace; a blank cell is omitted, and an
 * omitted field reads as absent — never as zero.
 */
import { fail } from '../../core/errors.ts';
import { canonicalJson, sha256 } from '../../core/hash.ts';
import { parseCsvRecord } from '../../core/csv.ts';
import { linesFromChunks } from '../../core/lines.ts';
import { listZipFile, readZipEntry, type ZipFileEntry } from '../../core/zip-file.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import { SNAPSHOT_TRAILER_KIND } from '../../runtime/arcgis-stream.ts';
import type { FlDerivation, FlDerivationSummary, FlDeriveInput } from './pipeline.ts';

export const FL_CSV_BUNDLE_KIND = 'df.fl_dor.csv_bundle/1';
export const FL_CSV_DERIVATION_VERSION = 'fl_dor_csv_derivation_1';

/** Provenance keys a derived row carries. Connectors must list them as known fields. */
export const FL_ROW_PROVENANCE_FIELDS: readonly string[] = ['__f', '__c', '__s', '__n', '__lm'];

export type FlCsvLayout = { readonly id: string; readonly columns: readonly string[] };

export type FlCsvDeriveOptions = {
  /** Every pinned layout. A file matching none of them is drift. */
  readonly layouts: readonly FlCsvLayout[];
  /** The union field set the connector pins, with publisher types: the header's field list. */
  readonly fields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
};

/** The pinned field-set digest a connector compares the header against. */
export function flCsvFieldSetDigest(fields: FlCsvDeriveOptions['fields']): string {
  return fieldSetDigestOf(fields.map((f) => ({ name: f.name, type: f.type, ...(f.length !== undefined ? { length: f.length } : {}) })));
}

type FileLayout = {
  readonly sha256: string;
  readonly dorCode: string;
  readonly countyFips: string;
  readonly entry: ZipFileEntry | null;
  readonly columns: readonly string[];
  readonly layoutId: string | null;
  readonly problem: string | null;
};

export function deriveFlCsvBundle(input: FlDeriveInput, options: FlCsvDeriveOptions): FlDerivation {
  const rowsByFile: Record<string, number> = {};
  const layoutsByFile: Record<string, string | null> = {};
  let rowsWritten = 0;
  let malformedRows = 0;
  let replacementRows = 0;
  let done = false;

  async function* lines(): AsyncGenerator<string> {
    // Headers first, from every file, so drift is declared before any row.
    const layouts: FileLayout[] = [];
    for (const { entry, artifact } of input.files) {
      layouts.push(await layoutOf(input.artifactStore.localPath(artifact), entry.sha256, entry.dorCode, entry.countyFips, options.layouts));
    }
    const drift = layouts.filter((l) => l.layoutId === null);
    const declared = [
      ...options.fields.map((f) => ({ name: f.name, type: f.type, ...(f.length !== undefined ? { length: f.length } : {}) })),
      // One synthetic field per drifted file: the field-set digest cannot match,
      // so the runtime quarantines before interpreting a row.
      ...drift.map((l) => ({ name: `UNPINNED_LAYOUT:${l.dorCode}:${sha256(l.columns.join(',')).slice(0, 12)}`, type: 'drift' })),
    ];
    for (const l of layouts) layoutsByFile[l.sha256] = l.layoutId;

    yield canonicalJson({
      kind: FL_CSV_BUNDLE_KIND,
      derivationVersion: FL_CSV_DERIVATION_VERSION,
      sourceId: input.manifest.sourceId,
      rollYear: input.manifest.rollYear,
      releaseFingerprint: input.manifest.releaseFingerprint,
      sourceSchemaDigest: fieldSetDigestOf(declared),
      layerMetadata: { fields: declared },
      // The Department publishes no row count for these files.
      sourceReportedCount: null,
      layouts: layouts.map((l) => ({ dorCode: l.dorCode, sha256: l.sha256, layoutId: l.layoutId, problem: l.problem })),
    });

    if (drift.length === 0) {
      let budget = input.maxRows ?? Number.POSITIVE_INFINITY;
      for (const [i, { entry, artifact }] of input.files.entries()) {
        const layout = layouts[i] as FileLayout;
        if (budget <= 0) break;
        let rowNumber = 0;
        const stage = entry.stage === 'FINAL' ? 'F' : 'P';
        for await (const cells of csvRecords(input.artifactStore.localPath(artifact), layout.entry as ZipFileEntry)) {
          if (budget <= 0) break;
          rowNumber += 1;
          budget -= 1;
          const row: Record<string, string | number> = {};
          if (cells.length !== layout.columns.length) {
            // Kept as a row the parser will refuse and count, never silently dropped.
            malformedRows += 1;
            row['__malformed'] = `expected ${layout.columns.length} cells, found ${cells.length}`;
          } else {
            for (let c = 0; c < cells.length; c++) {
              const value = (cells[c] as string).trim();
              if (value !== '') row[layout.columns[c] as string] = value;
            }
          }
          if (cells.some((c) => c.includes('�'))) replacementRows += 1;
          row['__f'] = entry.sha256;
          row['__c'] = entry.countyFips;
          row['__s'] = stage;
          row['__n'] = rowNumber;
          if (entry.lastModified !== null) row['__lm'] = entry.lastModified;
          rowsByFile[entry.sha256] = (rowsByFile[entry.sha256] ?? 0) + 1;
          rowsWritten += 1;
          yield JSON.stringify(row);
        }
      }
    }

    yield canonicalJson({
      kind: SNAPSHOT_TRAILER_KIND,
      retrievedFeatureCount: rowsWritten,
      missingObjectIds: [],
      sourceReportedCountAtEnd: null,
      sourceChangedDuringRead: false,
    });
    done = true;
  }

  return {
    lines: lines(),
    summary(): FlDerivationSummary {
      if (!done) fail('CONFIG', 'derivation summary requested before the stream was exhausted');
      return {
        rowsWritten,
        sourceSchemaDigest: flCsvFieldSetDigest(options.fields),
        rowsByFile,
        facts: { derivationVersion: FL_CSV_DERIVATION_VERSION, malformedRows, replacementRows, layoutsByFile },
      };
    },
  };
}

/** Reads one county zip's header row and matches it against the pinned layouts. */
async function layoutOf(
  zipPath: string,
  sha: string,
  dorCode: string,
  countyFips: string,
  layouts: readonly FlCsvLayout[],
): Promise<FileLayout> {
  const entries = (await listZipFile(zipPath)).filter((e) => !e.isDirectory);
  if (entries.length !== 1) {
    return {
      sha256: sha, dorCode, countyFips, entry: null, columns: entries.map((e) => e.name), layoutId: null,
      problem: `expected one CSV entry, found ${entries.length}`,
    };
  }
  const entry = entries[0] as ZipFileEntry;
  const reader = linesFromChunks(readZipEntry(zipPath, entry), 'utf8');
  const first = await reader.next();
  await reader.return(undefined);
  const columns = first.done ? [] : (parseCsvRecord(stripBom(first.value), ',', '"') ?? []).map((c) => c.trim());
  const match = layouts.find((l) => l.columns.length === columns.length && l.columns.every((c, i) => c === columns[i]));
  return {
    sha256: sha, dorCode, countyFips, entry, columns, layoutId: match?.id ?? null,
    problem: match ? null : `header matches no pinned layout (${columns.length} columns)`,
  };
}

/** Data records of one zipped CSV, header skipped. A quoted field may span lines. */
async function* csvRecords(zipPath: string, entry: ZipFileEntry): AsyncGenerator<readonly string[]> {
  const reader = linesFromChunks(readZipEntry(zipPath, entry), 'utf8');
  let header = true;
  let pending = '';
  for await (const line of reader) {
    if (header) { header = false; continue; }
    pending = pending === '' ? line : `${pending}\n${line}`;
    if (pending.length > 1 << 20) fail('PARSE', `${entry.name}: a record exceeds 1 MiB; an unterminated quote is the likely cause`);
    const cells = parseCsvRecord(pending, ',', '"');
    if (cells === null) continue;
    pending = '';
    // A trailing empty line is not a record.
    if (cells.length === 1 && (cells[0] as string).trim() === '') continue;
    yield cells;
  }
  if (pending !== '') fail('PARSE', `${entry.name}: the file ends inside a quoted field`);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
