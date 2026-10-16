/**
 * Florida PAR shapefiles → one statewide snapshot stream.
 *
 * Each county zip holds a shapefile: .shp (geometry), .dbf (attributes), .prj
 * (coordinate system), .cpg (code page). The .dbf and .shp are read in
 * LOCKSTEP from the retained zip, record n of one with record n of the other,
 * and a count mismatch fails the file rather than pairing attributes with the
 * wrong polygon. Nothing is extracted to disk; one record of each is in memory.
 *
 * What a row carries is deliberately lean — see `field-map.ts`:
 *
 *   identity    CO_NO, PARCELNO, PARCEL_ID
 *   sale echo   the 20 joined sale columns, dBASE numerics as exact decimals
 *   geometry    __geom: shape type, parts, vertices, bbox, area and centroid
 *               in the file's own coordinate system, ring closure
 *   provenance  __f file sha256, __c manifest county, __s stage, __n record
 *               number, __lm Last-Modified, __crs and __unit from the .prj
 *
 * Every record the .dbf declares is emitted, deleted ones included, so the
 * trailer's count reconciles EXACTLY against the header counts the files
 * themselves declare; deleted, unjoined and duplicate records are then refused
 * by the parser, individually, and counted.
 *
 * The condominium unit tables (Miami-Dade, St. Johns) are retained and
 * verified with the release but not interpreted here: they describe units
 * inside a parcel polygon and carry owner names and mailing addresses, and no
 * canonical consumer for them exists in this phase.
 */
import { fail } from '../../core/errors.ts';
import { canonicalJson, sha256 } from '../../core/hash.ts';
import { openDbf, type DbfField } from '../../core/dbf.ts';
import { openShp, prjLinearUnitMetres, prjName } from '../../core/shp.ts';
import { listZipFile, readZipEntry, type ZipFileEntry } from '../../core/zip-file.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import { SNAPSHOT_TRAILER_KIND } from '../../runtime/arcgis-stream.ts';
import type { FlDerivation, FlDerivationSummary, FlDeriveInput } from '../fl-dor/pipeline.ts';
import { FL_PAR_DBF_LAYOUT, dbfDecimal } from './field-map.ts';

export const FL_PAR_BUNDLE_KIND = 'df.fl_dor.par_bundle/1';
export const FL_PAR_DERIVATION_VERSION = 'fl_par_derivation_1';

/** The dBASE columns a derived row carries. Everything else stays in the archive. */
export const FL_PAR_EMITTED_COLUMNS: readonly string[] = [
  'CO_NO', 'PARCELNO', 'PARCEL_ID',
  ...(['1', '2'] as const).flatMap((n) => [
    `M_PAR_SAL${n}`, `QUAL_CD${n}`, `VI_CD${n}`, `SALE_PRC${n}`, `SALE_YR${n}`, `SALE_MO${n}`,
    `OR_BOOK${n}`, `OR_PAGE${n}`, `CLERK_NO${n}`, `S_CHNG_CD${n}`,
  ]),
];

export const FL_PAR_ROW_EXTRA_FIELDS: readonly string[] = ['__geom', '__crs', '__unit', '__deleted', '__f', '__c', '__s', '__n', '__lm'];

/** The declared field set the header carries when every file matches the pinned layout. */
export function flParPinnedFields(): readonly { name: string; type: string; length?: number }[] {
  // PARCELNO's width is the county's own and is left out of the pinned set.
  return FL_PAR_DBF_LAYOUT.map((c) => ({ name: c.name, type: `${c.type}.${c.decimals}`, ...(c.length !== null ? { length: c.length } : {}) }));
}

export const FL_PAR_PINNED_FIELD_SET_DIGEST = fieldSetDigestOf(flParPinnedFields());

type FileInfo = {
  readonly sha256: string;
  readonly dorCode: string;
  readonly role: string;
  readonly dbf: ZipFileEntry | null;
  readonly shp: ZipFileEntry | null;
  readonly crs: string | null;
  readonly unitMetres: number | null;
  readonly encoding: 'utf8' | 'latin1';
  readonly declaredRecords: number;
  readonly problem: string | null;
};

export function deriveFlParBundle(input: FlDeriveInput): FlDerivation {
  const rowsByFile: Record<string, number> = {};
  const crsByFile: Record<string, string | null> = {};
  let rowsWritten = 0;
  let deletedRows = 0;
  let done = false;

  async function* lines(): AsyncGenerator<string> {
    const infos: FileInfo[] = [];
    for (const { entry, artifact } of input.files) {
      infos.push(await inspect(input.artifactStore.localPath(artifact), entry.sha256, entry.dorCode, entry.role));
    }
    const parcels = infos.filter((i) => i.role === 'county_parcels');
    const drift = parcels.filter((i) => i.problem !== null);
    const declared = [
      ...flParPinnedFields(),
      ...drift.map((i) => ({ name: `UNPINNED_LAYOUT:${i.dorCode}:${sha256(i.problem ?? '').slice(0, 12)}`, type: 'drift' })),
    ];
    for (const i of infos) crsByFile[i.sha256] = i.crs;

    yield canonicalJson({
      kind: FL_PAR_BUNDLE_KIND,
      derivationVersion: FL_PAR_DERIVATION_VERSION,
      sourceId: input.manifest.sourceId,
      rollYear: input.manifest.rollYear,
      releaseFingerprint: input.manifest.releaseFingerprint,
      sourceSchemaDigest: fieldSetDigestOf(declared),
      layerMetadata: { fields: declared },
      // The files' own .dbf headers declare their record counts: the
      // publisher-stated denominator the trailer must reconcile against.
      sourceReportedCount: parcels.reduce((sum, i) => sum + i.declaredRecords, 0),
      files: infos.map((i) => ({ dorCode: i.dorCode, role: i.role, sha256: i.sha256, crs: i.crs, unitMetres: i.unitMetres, records: i.declaredRecords, problem: i.problem })),
    });

    if (drift.length === 0) {
      let budget = input.maxRows ?? Number.POSITIVE_INFINITY;
      for (const [index, { entry, artifact }] of input.files.entries()) {
        const info = infos[index] as FileInfo;
        if (info.role !== 'county_parcels' || budget <= 0) continue;
        const path = input.artifactStore.localPath(artifact);
        const dbf = await openDbf(readZipEntry(path, info.dbf as ZipFileEntry), { encoding: info.encoding });
        const shapes = (await openShp(readZipEntry(path, info.shp as ZipFileEntry))).records();
        const columns = dbf.header.fields.map((f, i) => [f, i] as const).filter(([f]) => FL_PAR_EMITTED_COLUMNS.includes(f.name));
        const stage = entry.stage === 'FINAL' ? 'F' : 'P';
        for await (const record of dbf.records()) {
          const shape = await shapes.next();
          if (shape.done) fail('PARSE', `${entry.name}: the .shp ends before the .dbf (record ${record.index + 1})`);
          if (budget <= 0) break;
          budget -= 1;
          const row: Record<string, unknown> = {};
          if (record.deleted) {
            row['__deleted'] = true;
            deletedRows += 1;
          } else {
            for (const [field, i] of columns) {
              const value = valueOf(field, record.values[i] ?? null);
              if (value !== null) row[field.name] = value;
            }
            const s = shape.value;
            row['__geom'] = s.nullShape
              ? { t: s.shapeType, null: true }
              : { t: s.shapeType, np: s.parts, nv: s.points, b: s.bbox, a: s.area, c: s.centroid, closed: s.ringsClosed };
          }
          if (info.crs !== null) row['__crs'] = info.crs;
          if (info.unitMetres !== null) row['__unit'] = info.unitMetres;
          row['__f'] = entry.sha256;
          row['__c'] = entry.countyFips;
          row['__s'] = stage;
          row['__n'] = record.index + 1;
          if (entry.lastModified !== null) row['__lm'] = entry.lastModified;
          rowsByFile[entry.sha256] = (rowsByFile[entry.sha256] ?? 0) + 1;
          rowsWritten += 1;
          yield JSON.stringify(row);
        }
        if (budget > 0) {
          const extra = await shapes.next();
          if (!extra.done) fail('PARSE', `${entry.name}: the .shp has more records than the .dbf`);
        } else {
          await shapes.return(undefined);
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
        sourceSchemaDigest: FL_PAR_PINNED_FIELD_SET_DIGEST,
        rowsByFile,
        facts: { derivationVersion: FL_PAR_DERIVATION_VERSION, deletedRows, crsByFile },
      };
    },
  };
}

/** A dBASE value as the row carries it: numerics as exact decimals, text trimmed, blanks omitted. */
function valueOf(field: DbfField, raw: string | null): string | null {
  if (raw === null) return null;
  if (field.type === 'N' || field.type === 'F') return dbfDecimal(raw);
  const text = raw.trim();
  return text === '' ? null : text;
}

/** Reads a county zip's entries and .dbf header; checks the layout against the pinned one. */
async function inspect(path: string, sha: string, dorCode: string, role: string): Promise<FileInfo> {
  const entries = (await listZipFile(path)).filter((e) => !e.isDirectory);
  const byExt = (ext: string): ZipFileEntry | null => entries.find((e) => e.name.toLowerCase().endsWith(ext)) ?? null;
  const dbfEntry = byExt('.dbf');
  const shpEntry = byExt('.shp');
  const prj = await smallText(path, byExt('.prj'));
  const cpg = (await smallText(path, byExt('.cpg')))?.trim() ?? null;
  const encoding: 'utf8' | 'latin1' = cpg !== null && /1252|latin|8859/i.test(cpg) ? 'latin1' : 'utf8';
  const base = { sha256: sha, dorCode, role, dbf: dbfEntry, shp: shpEntry, crs: prj === null ? null : prjName(prj), unitMetres: prj === null ? null : prjLinearUnitMetres(prj)?.metres ?? null, encoding };
  if (role !== 'county_parcels') return { ...base, declaredRecords: 0, problem: null };
  if (dbfEntry === null || shpEntry === null) return { ...base, declaredRecords: 0, problem: `missing ${dbfEntry === null ? '.dbf' : '.shp'}` };
  const dbf = await openDbf(readZipEntry(path, dbfEntry), { encoding });
  const fields = dbf.header.fields;
  await dbf.close();
  const mismatch = fields.length !== FL_PAR_DBF_LAYOUT.length
    ? `${fields.length} columns, pinned ${FL_PAR_DBF_LAYOUT.length}`
    : FL_PAR_DBF_LAYOUT.map((pinned, i) => {
      const f = fields[i] as DbfField;
      const same = f.name === pinned.name && f.type === pinned.type && f.decimals === pinned.decimals
        && (pinned.length === null || f.length === pinned.length);
      return same ? null : `column ${i + 1} is ${f.name}:${f.type}:${f.length}:${f.decimals}`;
    }).find((x) => x !== null) ?? null;
  return { ...base, declaredRecords: dbf.header.recordCount, problem: mismatch };
}

async function smallText(path: string, entry: ZipFileEntry | null): Promise<string | null> {
  if (entry === null) return null;
  const parts: Buffer[] = [];
  for await (const chunk of readZipEntry(path, entry)) parts.push(chunk);
  return Buffer.concat(parts).toString('utf8');
}
