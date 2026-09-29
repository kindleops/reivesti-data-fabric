/**
 * The Florida Department of Revenue's Property Tax Oversight data library.
 *
 * DOR publishes the statewide tax-roll files — NAL, SDF, NAP — and the county
 * parcel shapefiles in a SharePoint document library under
 * `https://floridarevenue.com/property/dataportal/`. The pages a person clicks
 * through are a view over that library; the library itself answers SharePoint's
 * documented REST interface anonymously:
 *
 *   GET …/_api/web/GetFolderByServerRelativeUrl('<folder>')?$expand=Folders,Files
 *   Accept: application/json;odata=nometadata
 *
 * One request per folder returns every file with its size, ETag and
 * last-modified time — a machine-readable directory listing, not a scraped
 * page. Each file is then one plain GET of its server-relative URL. No account,
 * cookie, token, session state or CAPTCHA is involved anywhere (verified
 * 2026-09-29), and floridarevenue.com's robots.txt restricts neither path for
 * general agents.
 *
 * ## What this module will not touch
 *
 * The library also contains folders whose names begin with `~` — `~NAL-EDR`,
 * `~Public Records` — that hold staff working files and per-requester public
 * records deliveries. They are not part of the published roll, and one of them
 * is named as containing confidential records. Discovery drops every `~`
 * folder from every listing and refuses to list one, so no scheduler can ever
 * reach into them.
 *
 * ## Current data only
 *
 * DOR posts only the most current version of each roll type; earlier ones are
 * available by request, which is a manual path and out of scope. Within the
 * current roll year a county's file moves from the `YYYYP` (preliminary) folder
 * to `YYYYF` (final) when DOR accepts its final roll, so at any moment the
 * statewide release is a MIX of stages — 65 preliminary and 2 final on
 * 2026-09-29. The stage is carried per county, never assumed statewide.
 */
import { fail } from '../../core/errors.ts';
import { canonicalJson, sha256 } from '../../core/hash.ts';
import { getText, type HttpDeps } from '../../runtime/bulk-acquisition.ts';
import { flCountyByFileName, FL_DOR_COUNTIES, type FlDorCounty } from './counties.ts';

export const FL_DOR_ORIGIN = 'https://floridarevenue.com';
export const FL_PTO_LIBRARY = '/property/dataportal/Documents/PTO Data Portal';
const API = `${FL_DOR_ORIGIN}/property/dataportal/_api/web/GetFolderByServerRelativeUrl`;

export type PortalFile = {
  readonly name: string;
  readonly serverRelativeUrl: string;
  /** Absolute download URL. Provenance, never identity. */
  readonly url: string;
  readonly bytes: number;
  /** SharePoint's ETag for the file version, exactly as served. */
  readonly etag: string | null;
  readonly lastModified: string;
  readonly uniqueId: string | null;
  readonly versionLabel: string | null;
};

export type PortalFolder = {
  readonly name: string;
  readonly serverRelativeUrl: string;
  readonly itemCount: number;
  readonly lastModified: string;
};

export type PortalListing = {
  readonly folders: readonly PortalFolder[];
  readonly files: readonly PortalFile[];
  /** `~` folders seen in the listing and dropped unvisited. Counted, never named further. */
  readonly hiddenFoldersIgnored: number;
};

/** True for a path that enters a `~` folder. */
export function isHiddenPortalPath(serverRelativePath: string): boolean {
  return serverRelativePath.split('/').some((segment) => segment.startsWith('~'));
}

export function portalDownloadUrl(serverRelativeUrl: string): string {
  return `${FL_DOR_ORIGIN}${encodeURI(serverRelativeUrl)}`;
}

/** Lists one library folder through the SharePoint REST interface. */
export async function listPortalFolder(serverRelativePath: string, http: HttpDeps = {}): Promise<PortalListing> {
  if (isHiddenPortalPath(serverRelativePath)) {
    fail('CONFIG', 'refusing to list a ~ folder: it is not part of the published roll', { path: serverRelativePath });
  }
  if (!serverRelativePath.startsWith(FL_PTO_LIBRARY)) {
    fail('CONFIG', `refusing to list ${serverRelativePath}: outside the PTO data library`);
  }
  const quoted = serverRelativePath.replace(/'/g, "''");
  const url = `${API}('${encodeURIComponent(quoted).replace(/%2F/g, '/')}')?$expand=Folders,Files`;
  const text = await getText(url, http, { accept: 'application/json;odata=nometadata' });
  let body: { Folders?: RawFolder[]; Files?: RawFile[] };
  try {
    body = JSON.parse(text) as { Folders?: RawFolder[]; Files?: RawFile[] };
  } catch (e) {
    return fail('PARSE', `the PTO library listing for ${serverRelativePath} is not JSON: ${(e as Error).message}`);
  }
  const rawFolders = body.Folders ?? [];
  const folders = rawFolders
    .filter((f) => !f.Name.startsWith('~'))
    .map((f): PortalFolder => ({
      name: f.Name, serverRelativeUrl: f.ServerRelativeUrl, itemCount: Number(f.ItemCount ?? 0), lastModified: f.TimeLastModified,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = (body.Files ?? [])
    .map((f): PortalFile => ({
      name: f.Name,
      serverRelativeUrl: f.ServerRelativeUrl,
      url: portalDownloadUrl(f.ServerRelativeUrl),
      bytes: Number(f.Length),
      etag: f.ETag ?? null,
      lastModified: f.TimeLastModified,
      uniqueId: f.UniqueId ?? null,
      versionLabel: f.UIVersionLabel ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { folders, files, hiddenFoldersIgnored: rawFolders.length - folders.length };
}

type RawFolder = { Name: string; ServerRelativeUrl: string; ItemCount?: number; TimeLastModified: string };
type RawFile = {
  Name: string; ServerRelativeUrl: string; Length: string | number; ETag?: string; TimeLastModified: string;
  UniqueId?: string; UIVersionLabel?: string;
};

// ---------------------------------------------------------------------------
// Tax-roll files: NAL and SDF
// ---------------------------------------------------------------------------

export type FlRollKind = 'NAL' | 'SDF';
/** DOR's own words for the two stages the portal separates. */
export type FlRollStage = 'PRELIMINARY' | 'FINAL';

export type FlCountyFile = {
  /** The county the filename NAMES. Rows still route by their own CO_NO; this is a cross-check. */
  readonly county: FlDorCounty;
  readonly stage: FlRollStage;
  readonly rollYear: number;
  /** The portal folder it was listed in, e.g. `2026P`. */
  readonly folder: string;
  readonly file: PortalFile;
  /** Filename facts that disagree with the Department's own table. Evidence, not errors. */
  readonly nameAnomalies: readonly string[];
  /** For parcel shapefiles: the county's own parcels, or a separately published condominium table. */
  readonly role: 'county_roll' | 'county_parcels' | 'condo_related';
};

export type FlRollRelease = {
  readonly kind: FlRollKind | 'PAR';
  readonly rollYear: number;
  /** The roll year as the reference period — stages vary by county and are carried per file. */
  readonly referencePeriod: string;
  /** Sorted by DOR county number, then role. */
  readonly files: readonly FlCountyFile[];
  /** A preliminary file hidden by the same county's final one, when both were posted. */
  readonly superseded: readonly FlCountyFile[];
  /** DOR county numbers with no file in the current roll. */
  readonly missingCounties: readonly string[];
  /** Files or folders whose names this module could not read. Reported, never guessed at. */
  readonly unrecognized: readonly string[];
  readonly stageCounts: Readonly<Record<string, number>>;
  /** Changes whenever any served byte could have: every file's name, URL, ETag, size and time. */
  readonly releaseFingerprint: string;
  readonly hiddenFoldersIgnored: number;
};

const ROLL_FOLDER = /^(\d{4})([PF])$/;
const ROLL_FILE = /^(.+?)\s+(?:(\d{1,2})\s+)?(Preliminary|Final)\s+(NAL|SDF)\s+(\d{4})\.zip$/i;

/** The current NAL or SDF roll: every county's most advanced posted stage in the latest roll year. */
export async function discoverFlRoll(kind: FlRollKind, http: HttpDeps = {}): Promise<FlRollRelease> {
  const base = `${FL_PTO_LIBRARY}/Tax Roll Data Files/${kind}`;
  const top = await listPortalFolder(base, http);
  const unrecognized: string[] = top.files.map((f) => `${kind}/${f.name}`);
  const rollFolders = top.folders.filter((f) => ROLL_FOLDER.test(f.name));
  for (const f of top.folders) if (!ROLL_FOLDER.test(f.name)) unrecognized.push(`${kind}/${f.name}/`);
  if (rollFolders.length === 0) fail('SCHEMA_DRIFT', `no YYYYP or YYYYF folder under ${kind}: the portal layout changed`);
  const rollYear = Math.max(...rollFolders.map((f) => Number(ROLL_FOLDER.exec(f.name)![1])));

  const candidates: FlCountyFile[] = [];
  let hidden = top.hiddenFoldersIgnored;
  for (const folder of rollFolders.filter((f) => Number(ROLL_FOLDER.exec(f.name)![1]) === rollYear)) {
    const folderStage: FlRollStage = ROLL_FOLDER.exec(folder.name)![2] === 'F' ? 'FINAL' : 'PRELIMINARY';
    const listing = await listPortalFolder(folder.serverRelativeUrl, http);
    hidden += listing.hiddenFoldersIgnored;
    for (const sub of listing.folders) unrecognized.push(`${kind}/${folder.name}/${sub.name}/`);
    for (const file of listing.files) {
      const m = ROLL_FILE.exec(file.name);
      const county = m === null ? null : flCountyByFileName(m[1] as string);
      if (m === null || county === null || (m[4] as string).toUpperCase() !== kind || Number(m[5]) !== rollYear) {
        unrecognized.push(`${kind}/${folder.name}/${file.name}`);
        continue;
      }
      const stage: FlRollStage = (m[3] as string).toLowerCase() === 'final' ? 'FINAL' : 'PRELIMINARY';
      const anomalies: string[] = [];
      if (stage !== folderStage) anomalies.push(`STAGE_FOLDER_MISMATCH:${folder.name}`);
      if (m[2] === undefined) anomalies.push('FILENAME_CODE_ABSENT');
      else if ((m[2] as string).padStart(2, '0') !== county.dorCode) anomalies.push(`FILENAME_CODE_MISMATCH:${(m[2] as string).padStart(2, '0')}`);
      candidates.push({ county, stage, rollYear, folder: folder.name, file, nameAnomalies: anomalies, role: 'county_roll' });
    }
  }

  // One file per county: a final roll supersedes the preliminary one.
  const chosen = new Map<string, FlCountyFile>();
  const superseded: FlCountyFile[] = [];
  for (const c of candidates) {
    const prior = chosen.get(c.county.dorCode);
    if (prior === undefined) { chosen.set(c.county.dorCode, c); continue; }
    if (prior.stage === c.stage) {
      fail('SCHEMA_DRIFT', `two ${c.stage} ${kind} files for ${c.county.dorName}: ${prior.file.name} and ${c.file.name}`);
    }
    const [keep, drop] = c.stage === 'FINAL' ? [c, prior] : [prior, c];
    chosen.set(c.county.dorCode, keep);
    superseded.push(drop);
  }
  return releaseOf(kind, rollYear, [...chosen.values()], superseded, unrecognized, hidden);
}

// ---------------------------------------------------------------------------
// Parcel shapefiles: PAR
// ---------------------------------------------------------------------------

const MAP_YEAR_FOLDER = /^(\d{4})F$/;
const PAR_FILE = /^([a-z]+?)_?(condos?_?)?_?(\d{4})(P?)(?:par)?(?:\.shp)?\.zip$/i;

/**
 * The current statewide parcel shapefiles: each county's April parcel polygons
 * joined by DOR to that year's roll (`<county>_<year>Ppar.zip`), plus the two
 * condominium tables Miami-Dade and St. Johns publish beside their shapefiles.
 */
export async function discoverFlParcelShapefiles(http: HttpDeps = {}): Promise<FlRollRelease> {
  const base = `${FL_PTO_LIBRARY}/Map Data`;
  const top = await listPortalFolder(base, http);
  const years = top.folders.filter((f) => MAP_YEAR_FOLDER.test(f.name))
    .map((f) => ({ folder: f, year: Number(MAP_YEAR_FOLDER.exec(f.name)![1]) }))
    .sort((a, b) => b.year - a.year);
  let hidden = top.hiddenFoldersIgnored;
  for (const { folder, year } of years) {
    const listing = await listPortalFolder(folder.serverRelativeUrl, http);
    hidden += listing.hiddenFoldersIgnored;
    const par = listing.folders.find((f) => f.name === `${folder.name} PAR`);
    if (par === undefined) continue; // older years publish files flat and are not current
    const files = await listPortalFolder(par.serverRelativeUrl, http);
    hidden += files.hiddenFoldersIgnored;
    const unrecognized: string[] = files.folders.map((f) => `Map Data/${folder.name}/${par.name}/${f.name}/`);
    const chosen: FlCountyFile[] = [];
    for (const file of files.files) {
      const m = PAR_FILE.exec(file.name);
      const county = flCountyByFileName(file.name);
      if (m === null || county === null || Number(m[3]) !== year) {
        unrecognized.push(`Map Data/${folder.name}/${par.name}/${file.name}`);
        continue;
      }
      const condo = /condo/i.test(file.name);
      chosen.push({
        county,
        // `P` before `par`: DOR joined these polygons to the PRELIMINARY roll.
        stage: m[4] !== '' ? 'PRELIMINARY' : 'FINAL',
        rollYear: year,
        folder: `${folder.name}/${par.name}`,
        file,
        nameAnomalies: condo || m[4] !== '' ? [] : ['JOIN_STAGE_NOT_STATED_IN_FILENAME'],
        role: condo ? 'condo_related' : 'county_parcels',
      });
    }
    const parcels = chosen.filter((c) => c.role === 'county_parcels');
    const dup = parcels.find((c, i) => parcels.findIndex((d) => d.county.dorCode === c.county.dorCode) !== i);
    if (dup) fail('SCHEMA_DRIFT', `two parcel shapefiles for ${dup.county.dorName} in ${par.name}`);
    return releaseOf('PAR', year, chosen, [], unrecognized, hidden);
  }
  return fail('SCHEMA_DRIFT', 'no Map Data/<year>F/<year>F PAR folder: the portal layout changed');
}

function releaseOf(
  kind: FlRollRelease['kind'],
  rollYear: number,
  files: readonly FlCountyFile[],
  superseded: readonly FlCountyFile[],
  unrecognized: readonly string[],
  hiddenFoldersIgnored: number,
): FlRollRelease {
  const sorted = [...files].sort((a, b) =>
    a.county.dorCode.localeCompare(b.county.dorCode) || a.role.localeCompare(b.role) || a.file.name.localeCompare(b.file.name));
  const primaryRole = kind === 'PAR' ? 'county_parcels' : 'county_roll';
  const present = new Set(sorted.filter((f) => f.role === primaryRole).map((f) => f.county.dorCode));
  const stageCounts: Record<string, number> = {};
  for (const f of sorted.filter((x) => x.role === primaryRole)) stageCounts[f.stage] = (stageCounts[f.stage] ?? 0) + 1;
  return {
    kind,
    rollYear,
    referencePeriod: String(rollYear),
    files: sorted,
    superseded,
    missingCounties: FL_DOR_COUNTIES.filter((c) => !present.has(c.dorCode)).map((c) => c.dorCode),
    unrecognized: [...unrecognized].sort(),
    stageCounts,
    releaseFingerprint: sha256(canonicalJson({
      kind, rollYear,
      files: sorted.map((f) => ({
        county: f.county.dorCode, role: f.role, stage: f.stage, name: f.file.name, url: f.file.url,
        etag: f.file.etag, bytes: f.file.bytes, lastModified: f.file.lastModified,
      })),
    })),
    hiddenFoldersIgnored,
  };
}
