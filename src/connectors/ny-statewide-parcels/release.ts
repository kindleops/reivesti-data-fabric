/**
 * Discovering what New York State is publishing now — through a service
 * migration.
 *
 * ## The 2026 GeoHub migration is the design constraint
 *
 * NYS ITS Geospatial Services is moving every web service from its legacy
 * ArcGIS Server (`gisservices.its.ny.gov`) to GeoHub, its new ArcGIS Enterprise
 * (`nysgeohub.ny.gov`). Per the publisher's migration page (verified
 * 2026-09-29): legacy vector services stopped receiving updates on
 * 2026-09-18, stay online through October 2026, are planned for retirement in
 * 10/2026, and "all GeoHub service URLs are different than the legacy URLs".
 *
 * So no service hostname is written into this module as a place to fetch
 * from. Two publisher-controlled indirections are, because they are what
 * survived the migration:
 *
 *   PROGRAM PAGE   `https://gis.ny.gov/parcels` — the Statewide Parcel Map
 *                  program's own page. It links the current bulk downloads
 *                  and the current FeatureServers, and was already updated to
 *                  GeoHub. Every URL used is read from it.
 *   CATALOG ITEM   the publisher's ArcGIS Online item for the centroid service
 *                  (owner `NYSGIS_GPO`), whose `url` field was repointed to
 *                  GeoHub on 2026-08-27. Consulted only when the program page
 *                  links no usable service.
 *
 * Every discovered URL must be on an official `ny.gov` host; a mirror is
 * refused. The legacy host is recognised only so it can be de-preferred and
 * flagged — it is never requested by this module on its own initiative.
 *
 * ## Two paths with different jobs, as in Wisconsin
 *
 *   BULK ARCHIVE   the release: `NYS-Tax-Parcel-Centroid-Points.gdb.zip`, one
 *                  File Geodatabase, retained byte for byte.
 *   FEATURESERVER  the witness: its count, schema and title are compared with
 *                  the archive; it is never crawled (5.5 M points at 2,000 per
 *                  page is 2,756 pages against a public service).
 *
 * ## The release label comes from the archive itself
 *
 * The archive's URL carries no version. Its one geodatabase does:
 * `NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb` — the 2025 assessment roll,
 * built 2026-05. Discovery reads the ZIP central directory with one small
 * range request (the host serves `Accept-Ranges: bytes`), so the reference
 * period `2025-2605` is the publisher's own, known before a byte of the 563 MB
 * body is downloaded. Where ranges are not served, the label falls back to the
 * service's own title and publication date, and derivation later refuses an
 * archive whose geodatabase says otherwise.
 *
 * ## The polygon companion
 *
 * `NYS-Tax-Parcels.zip` is the same substrate as polygons for the 38 counties
 * that permit public redistribution (identical keys to the centroids there,
 * measured). It is discovered and HEADed here so the pipeline can retain it as
 * raw geometry evidence; it is never ingested.
 */
import { fail } from '../../core/errors.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import {
  FABRIC_USER_AGENT,
  getText,
  headArchive,
  releaseFingerprintOf,
  type ArchiveHead,
  type DiscoveredArchiveRelease,
  type HttpDeps,
} from '../../runtime/bulk-acquisition.ts';
import { DEFAULT_RETRY, realSleep, withRetry } from '../../runtime/retry.ts';

/** The Statewide Parcel Map program page. The one URL discovery starts from. */
export const NY_PARCELS_PROGRAM_PAGE = 'https://gis.ny.gov/parcels';

/** The publisher's ArcGIS Online catalogue item for the centroid FeatureServer. */
export const NY_CENTROID_CATALOG_ITEM_ID = 'b25e828955bd4391ad17650d6893edde';
/** The publishing account that owns it. An item owned by anyone else is not the publisher's. */
export const NY_CATALOG_OWNER = 'NYSGIS_GPO';
export const ARCGIS_ONLINE_ITEM_API = 'https://www.arcgis.com/sharing/rest/content/items';

/**
 * The legacy ArcGIS Server, retiring October 2026. Named here so a discovered
 * URL on it can be recognised, de-preferred and reported — not to fetch from.
 */
export const NY_LEGACY_GIS_HOST = 'gisservices.its.ny.gov';

export const NY_CENTROID_LAYER_ID = 0;
export const NY_POLYGON_PARCEL_LAYER_ID = 1;

/** The centroid archive's name on the download host. */
const CENTROID_ARCHIVE = /^NYS-Tax-Parcel-Centroid-Points(?:\.gdb)?\.zip$/i;
/** The public polygon archive (the state-owned subset is a different product). */
const POLYGON_ARCHIVE = /^NYS-Tax-Parcels(?:\.gdb)?\.zip$/i;
const CENTROID_SERVICE = /\/arcgis\/rest\/services\/(?:[^/]+\/)?NYS_Tax_Parcel_Centroid_Points\/FeatureServer\/?$/;
const POLYGON_SERVICE = /\/arcgis\/rest\/services\/(?:[^/]+\/)?NYS_Tax_Parcels_Public\/FeatureServer\/?$/;
/** `NYS_2025_Tax_Parcels_Centroid_Points_2605.gdb` → roll year 2025, build 2605. */
const CENTROID_GDB = /^NYS_(\d{4})_Tax_Parcels?_Centroid_Points_(\d{4})\.gdb$/i;
const POLYGON_GDB = /^NYS_(\d{4})_Tax_Parcels?_Public_(\d{4})\.gdb$/i;

/** True for the publisher's own hosts: `ny.gov` and its subdomains, over HTTPS. */
export function isOfficialNyUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'ny.gov' || u.hostname.endsWith('.ny.gov'));
  } catch {
    return false;
  }
}

export function isLegacyNyHost(url: string): boolean {
  try {
    return new URL(url).hostname === NY_LEGACY_GIS_HOST;
  } catch {
    return false;
  }
}

export type NyProgramLinks = {
  readonly centroidArchives: readonly string[];
  readonly polygonArchives: readonly string[];
  readonly centroidServices: readonly string[];
  readonly polygonServices: readonly string[];
  /** Links matching a product name on a host that is not the publisher's. Refused. */
  readonly refusedNonOfficial: readonly string[];
};

/** Every relevant link on the program page, classified. Pure: no network. */
export function parseProgramLinks(html: string, baseUrl: string = NY_PARCELS_PROGRAM_PAGE): NyProgramLinks {
  const hrefs = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = (m[1] as string).trim().replace(/&amp;/g, '&');
    try {
      hrefs.add(new URL(raw, baseUrl).toString());
    } catch { /* not a URL */ }
  }
  const out = {
    centroidArchives: [] as string[], polygonArchives: [] as string[],
    centroidServices: [] as string[], polygonServices: [] as string[], refusedNonOfficial: [] as string[],
  };
  for (const href of [...hrefs].sort()) {
    const u = new URL(href);
    // A service may be linked at a layer (`…/FeatureServer/0`); the service is what is kept.
    const path = u.pathname.replace(/\/+$/, '').replace(/(\/FeatureServer)\/\d+$/, '$1');
    const base = path.slice(path.lastIndexOf('/') + 1);
    const kind = CENTROID_ARCHIVE.test(base) ? 'centroidArchives'
      : POLYGON_ARCHIVE.test(base) ? 'polygonArchives'
      : CENTROID_SERVICE.test(`${path}/`) || CENTROID_SERVICE.test(path) ? 'centroidServices'
      : POLYGON_SERVICE.test(`${path}/`) || POLYGON_SERVICE.test(path) ? 'polygonServices'
      : null;
    if (kind === null) continue;
    if (!isOfficialNyUrl(href)) {
      out.refusedNonOfficial.push(href);
      continue;
    }
    const clean = kind.endsWith('Services') ? `${u.origin}${path}` : `${u.origin}${u.pathname}`;
    if (!out[kind].includes(clean)) out[kind].push(clean);
  }
  return out;
}

/** Legacy last, so a GeoHub (or any newer) URL wins whenever both are linked. */
export function preferCurrent(urls: readonly string[]): readonly string[] {
  return [...urls].sort((a, b) => Number(isLegacyNyHost(a)) - Number(isLegacyNyHost(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Archive identity from the ZIP central directory
// ---------------------------------------------------------------------------

export type ArchiveDirectory = {
  /** Distinct `*.gdb` directory names inside the archive. */
  readonly geodatabases: readonly string[];
  readonly entryCount: number;
};

/**
 * Reads the names inside a remote ZIP without downloading it: the end-of-central-
 * directory record and the directory itself, by range. Two small GETs at most.
 */
export async function readRemoteZipDirectory(url: string, contentLength: number, deps: HttpDeps = {}): Promise<ArchiveDirectory> {
  const tailLength = Math.min(contentLength, 65_557 + 20);
  const tail = await getRange(url, contentLength - tailLength, contentLength - 1, deps);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) fail('PARSE', 'the archive has no ZIP end-of-central-directory record', { url });
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
    // ZIP64: the locator sits immediately before the classic record.
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) fail('PARSE', 'ZIP64 archive without a locator', { url });
    const recordOffset = Number(tail.readBigUInt64LE(loc + 8));
    const record = await getRange(url, recordOffset, recordOffset + 55, deps);
    if (record.readUInt32LE(0) !== 0x06064b50) fail('PARSE', 'ZIP64 end record not found where its locator points', { url });
    entries = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  const tailStart = contentLength - tailLength;
  const cd = cdOffset >= tailStart && cdOffset + cdSize <= contentLength
    ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize)
    : await getRange(url, cdOffset, cdOffset + cdSize - 1, deps);
  const gdbs = new Set<string>();
  let at = 0;
  let count = 0;
  while (at + 46 <= cd.length && cd.readUInt32LE(at) === 0x02014b50) {
    const nameLength = cd.readUInt16LE(at + 28);
    const extra = cd.readUInt16LE(at + 30);
    const comment = cd.readUInt16LE(at + 32);
    const name = cd.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    for (const part of name.split('/')) if (/\.gdb$/i.test(part)) gdbs.add(part);
    at += 46 + nameLength + extra + comment;
    count += 1;
  }
  if (count !== entries) fail('PARSE', `the ZIP central directory lists ${count} entries, its end record says ${entries}`, { url });
  return { geodatabases: [...gdbs].sort(), entryCount: count };
}

async function getRange(url: string, start: number, end: number, deps: HttpDeps): Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return withRetry(async () => {
    const r = await fetchImpl(url, {
      headers: { 'user-agent': deps.userAgent ?? FABRIC_USER_AGENT, range: `bytes=${start}-${end}` },
    });
    if (r.status >= 500 || r.status === 429) throw new Error(`GET ${url} (range) → ${r.status}`);
    if (r.status !== 206) {
      // A server that ignores Range would start sending the whole archive.
      await r.body?.cancel().catch(() => {});
      fail('TRANSPORT', `GET ${url} with a byte range returned ${r.status}, not 206`);
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length !== end - start + 1) throw new Error(`short range: expected ${end - start + 1} bytes, got ${body.length}`);
    return body;
  }, { policy: deps.retryPolicy ?? DEFAULT_RETRY, sleep: deps.sleep ?? realSleep, label: 'ny.range' });
}

// ---------------------------------------------------------------------------
// Release label
// ---------------------------------------------------------------------------

export type NyReleaseLabel = {
  readonly rollYear: number;
  /** `yymm` of the build, e.g. 2605. */
  readonly build: string;
  /** `2025-2605`: the publisher's own roll year and build. */
  readonly referencePeriod: string;
  readonly geodatabase: string | null;
  readonly source: 'archive_directory' | 'service_metadata';
};

export function labelFromGeodatabase(name: string, pattern: RegExp = CENTROID_GDB): NyReleaseLabel | null {
  const m = pattern.exec(name);
  if (m === null) return null;
  const rollYear = Number(m[1]);
  const build = m[2] as string;
  return { rollYear, build, referencePeriod: `${rollYear}-${build}`, geodatabase: name, source: 'archive_directory' };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "NYS 2025 Tax Parcel Centroid Points" + "Publication Date: May 2026" → 2025-2605. */
export function labelFromServiceMetadata(title: string | null, description: string | null): NyReleaseLabel | null {
  const year = title === null ? null : /\bNYS\s+(\d{4})\s+Tax\s+Parcel/i.exec(title);
  const pub = description === null ? null : /Publication\s+Date:\s*([A-Za-z]+)\s+(\d{4})/i.exec(description.replace(/<[^>]+>/g, ' '));
  if (year === null || pub === null) return null;
  const month = MONTHS.indexOf((pub[1] as string).toLowerCase());
  if (month < 0) return null;
  const build = `${(pub[2] as string).slice(2)}${String(month + 1).padStart(2, '0')}`;
  return { rollYear: Number(year[1]), build, referencePeriod: `${year[1]}-${build}`, geodatabase: null, source: 'service_metadata' };
}

// ---------------------------------------------------------------------------
// Witness
// ---------------------------------------------------------------------------

export type NyServiceWitness = {
  readonly serviceUrl: string;
  readonly layerId: number;
  /** How the URL was found: the program page, or the publisher's catalogue item. */
  readonly discoveredVia: 'program_page' | 'catalog_item';
  readonly onLegacyHost: boolean;
  readonly serverVersion: number | null;
  readonly serviceItemId: string | null;
  readonly title: string | null;
  readonly layerName: string;
  readonly count: number;
  readonly capabilities: string;
  readonly maxRecordCount: number | null;
  readonly supportsPagination: boolean;
  readonly objectIdField: string | null;
  readonly geometryType: string | null;
  readonly fields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
  readonly fieldSetDigest: string;
  readonly copyrightText: string | null;
  /** The release the service says it serves, from its title and publication date. */
  readonly label: NyReleaseLabel | null;
};

async function readWitness(
  serviceUrl: string,
  layerId: number,
  discoveredVia: NyServiceWitness['discoveredVia'],
  deps: HttpDeps,
): Promise<NyServiceWitness> {
  const service = JSON.parse(await getText(`${serviceUrl}?f=json`, deps)) as Record<string, unknown>;
  if (service['error'] !== undefined) fail('TRANSPORT', 'the FeatureServer returned an error for service metadata', { error: service['error'] });
  const layer = JSON.parse(await getText(`${serviceUrl}/${layerId}?f=json`, deps)) as Record<string, unknown>;
  if (layer['error'] !== undefined) fail('TRANSPORT', 'the FeatureServer returned an error for layer metadata', { error: layer['error'] });
  const countBody = JSON.parse(await getText(`${serviceUrl}/${layerId}/query?where=1%3D1&returnCountOnly=true&f=json`, deps)) as { count?: number };
  if (typeof countBody.count !== 'number') fail('TRANSPORT', 'the FeatureServer did not return a count');

  const doc = (service['documentInfo'] ?? {}) as Record<string, unknown>;
  const title = typeof doc['Title'] === 'string' ? doc['Title'] : null;
  const description = typeof service['serviceDescription'] === 'string' ? service['serviceDescription']
    : typeof service['description'] === 'string' ? service['description'] : null;
  const advanced = (layer['advancedQueryCapabilities'] ?? {}) as Record<string, boolean | undefined>;
  const fields = ((layer['fields'] ?? []) as { name: string; type: string; length?: number }[])
    .map((f) => ({ name: f.name, type: f.type, ...(f.length !== undefined ? { length: f.length } : {}) }));
  return {
    serviceUrl,
    layerId,
    discoveredVia,
    onLegacyHost: isLegacyNyHost(serviceUrl),
    serverVersion: typeof service['currentVersion'] === 'number' ? service['currentVersion'] : null,
    serviceItemId: typeof service['serviceItemId'] === 'string' ? service['serviceItemId'] : null,
    title,
    layerName: String(layer['name'] ?? ''),
    count: countBody.count,
    capabilities: String(layer['capabilities'] ?? ''),
    maxRecordCount: typeof layer['maxRecordCount'] === 'number' ? layer['maxRecordCount'] : null,
    supportsPagination: advanced['supportsPagination'] === true,
    objectIdField: typeof layer['objectIdField'] === 'string' ? layer['objectIdField'] : null,
    geometryType: typeof layer['geometryType'] === 'string' ? layer['geometryType'] : null,
    fields,
    fieldSetDigest: fieldSetDigestOf(fields),
    copyrightText: typeof layer['copyrightText'] === 'string' ? layer['copyrightText'] : null,
    label: labelFromServiceMetadata(title, description),
  };
}

/**
 * The centroid FeatureServer named by the publisher's catalogue item — the
 * fallback when the program page links none. The item must be owned by the
 * publisher and point at an official host.
 */
export async function serviceFromCatalogItem(deps: HttpDeps = {}): Promise<string | null> {
  const item = JSON.parse(await getText(`${ARCGIS_ONLINE_ITEM_API}/${NY_CENTROID_CATALOG_ITEM_ID}?f=json`, deps)) as Record<string, unknown>;
  if (item['error'] !== undefined || item['owner'] !== NY_CATALOG_OWNER || typeof item['url'] !== 'string') return null;
  const url = (item['url'] as string).replace(/\/\d+\/?$/, '').replace(/\/+$/, '');
  return isOfficialNyUrl(url) && CENTROID_SERVICE.test(new URL(url).pathname) ? url : null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type NyCompanionArchive = {
  readonly url: string;
  readonly filename: string;
  readonly head: ArchiveHead;
  readonly releaseFingerprint: string;
  readonly label: NyReleaseLabel | null;
  /** The public polygon service's parcel count, where it answered. */
  readonly serviceCount: number | null;
  readonly serviceUrl: string | null;
};

export type NyDiscoveredRelease = DiscoveredArchiveRelease & {
  readonly archive: { readonly url: string; readonly filename: string; readonly label: NyReleaseLabel; readonly entryCount: number | null };
  readonly witness: NyServiceWitness;
  /** True when the service's own title and publication date name the archive's release. */
  readonly serviceMatchesArchive: boolean;
  /** The links the program page offered, for the report. */
  readonly programLinks: NyProgramLinks;
  /** The polygon archive, retained as raw geometry evidence and never ingested. */
  readonly companion: NyCompanionArchive | null;
  /** Why the polygon archive could not be discovered, when it was linked and failed. */
  readonly companionError: string | null;
  readonly migration: {
    readonly legacyHost: string;
    /** True when anything this release depends on sits on the retiring host. */
    readonly dependsOnLegacyHost: boolean;
    readonly witnessHost: string;
    readonly archiveHost: string;
  };
  /** Anonymous, free, no session: the facts the core gate depends on, re-observed. */
  readonly access: {
    readonly credentialsRequired: false;
    readonly sessionRequired: false;
    readonly captchaObserved: false;
    readonly archiveAcceptsRanges: boolean;
  };
};

export async function discoverNyRelease(deps: HttpDeps = {}): Promise<NyDiscoveredRelease> {
  const html = await getText(NY_PARCELS_PROGRAM_PAGE, deps);
  const links = parseProgramLinks(html);

  const archiveUrl = preferCurrent(links.centroidArchives)[0];
  if (archiveUrl === undefined) {
    fail('SCHEMA_DRIFT', 'the parcel program page no longer links the centroid archive', {
      page: NY_PARCELS_PROGRAM_PAGE,
      refused: links.refusedNonOfficial,
      remedy: 'the page layout or distribution changed; re-verify the source before any further run',
    });
  }
  const head = await headArchive(archiveUrl, deps);
  if (head.contentLength === null) fail('TRANSPORT', 'the archive host did not state a content length', { url: archiveUrl });

  // ---- the witness: program page first, the publisher's catalogue item second
  let serviceUrl = preferCurrent(links.centroidServices).find((u) => !isLegacyNyHost(u)) ?? null;
  let discoveredVia: NyServiceWitness['discoveredVia'] = 'program_page';
  if (serviceUrl === null) {
    const fromCatalog = await serviceFromCatalogItem(deps).catch(() => null);
    if (fromCatalog !== null) {
      serviceUrl = fromCatalog;
      discoveredVia = 'catalog_item';
    } else {
      // Only the retiring host is left. Used, and flagged, rather than trusted.
      serviceUrl = preferCurrent(links.centroidServices)[0] ?? null;
    }
  }
  if (serviceUrl === null) {
    fail('SCHEMA_DRIFT', 'no centroid FeatureServer is linked by the program page or the publisher\'s catalogue item', {
      page: NY_PARCELS_PROGRAM_PAGE, catalogItem: NY_CENTROID_CATALOG_ITEM_ID,
    });
  }
  const witness = await readWitness(serviceUrl, NY_CENTROID_LAYER_ID, discoveredVia, deps);

  // ---- the release label: the archive's own geodatabase name ------------------
  let label: NyReleaseLabel | null = null;
  let entryCount: number | null = null;
  if (head.acceptRanges) {
    const directory = await readRemoteZipDirectory(archiveUrl, head.contentLength, deps);
    entryCount = directory.entryCount;
    const labels = directory.geodatabases.map((g) => labelFromGeodatabase(g)).filter((l): l is NyReleaseLabel => l !== null);
    if (labels.length !== 1) {
      fail('SCHEMA_DRIFT', `expected exactly one centroid geodatabase in the archive, found ${labels.length}`, {
        geodatabases: directory.geodatabases,
      });
    }
    label = labels[0] as NyReleaseLabel;
  } else {
    label = witness.label;
  }
  if (label === null) {
    fail('SCHEMA_DRIFT', 'the release cannot be named: neither the archive nor the service states a roll year and build', {
      title: witness.title,
    });
  }

  // The companion is evidence, not the release: its failure is recorded, never fatal.
  let companion: NyCompanionArchive | null = null;
  let companionError: string | null = null;
  try {
    companion = await discoverCompanion(links, deps);
  } catch (error) {
    companionError = error instanceof Error ? error.message : String(error);
  }
  const witnessHost = new URL(witness.serviceUrl).hostname;
  const archiveHost = new URL(archiveUrl).hostname;
  return {
    sourceId: 'ny_statewide_parcels',
    referencePeriod: label.referencePeriod,
    releaseFingerprint: releaseFingerprintOf(head),
    head,
    archive: { url: archiveUrl, filename: archiveUrl.slice(archiveUrl.lastIndexOf('/') + 1), label, entryCount },
    witness,
    serviceMatchesArchive: witness.label !== null && witness.label.referencePeriod === label.referencePeriod,
    programLinks: links,
    companion,
    companionError,
    migration: {
      legacyHost: NY_LEGACY_GIS_HOST,
      dependsOnLegacyHost: isLegacyNyHost(witness.serviceUrl) || isLegacyNyHost(archiveUrl),
      witnessHost,
      archiveHost,
    },
    // Established by the requests above: none carried a credential, cookie or
    // token, and each was answered. A login wall or CAPTCHA would have failed
    // them rather than returned a layer and an archive head.
    access: {
      credentialsRequired: false,
      sessionRequired: false,
      captchaObserved: false,
      archiveAcceptsRanges: head.acceptRanges,
    },
  };
}

async function discoverCompanion(links: NyProgramLinks, deps: HttpDeps): Promise<NyCompanionArchive | null> {
  const url = preferCurrent(links.polygonArchives)[0];
  if (url === undefined) return null;
  const head = await headArchive(url, deps);
  let label: NyReleaseLabel | null = null;
  if (head.acceptRanges && head.contentLength !== null) {
    const directory = await readRemoteZipDirectory(url, head.contentLength, deps);
    label = directory.geodatabases.map((g) => labelFromGeodatabase(g, POLYGON_GDB)).find((l) => l !== null) ?? null;
  }
  const serviceUrl = preferCurrent(links.polygonServices).find((u) => !isLegacyNyHost(u)) ?? null;
  let serviceCount: number | null = null;
  if (serviceUrl !== null) {
    const body = JSON.parse(await getText(`${serviceUrl}/${NY_POLYGON_PARCEL_LAYER_ID}/query?where=1%3D1&returnCountOnly=true&f=json`, deps)
      .catch(() => '{}')) as { count?: number };
    serviceCount = typeof body.count === 'number' ? body.count : null;
  }
  return {
    url, filename: url.slice(url.lastIndexOf('/') + 1), head, releaseFingerprint: releaseFingerprintOf(head),
    label, serviceCount, serviceUrl,
  };
}
