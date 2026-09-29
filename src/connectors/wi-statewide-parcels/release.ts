/**
 * Discovering what the Wisconsin State Cartographer's Office is publishing now.
 *
 * Nothing about the current release is hard-coded as permanent. The SCO
 * publishes one statewide archive per annual version (V1 in 2015 through V12 in
 * 2026, with V13 announced for June 2027) and links every one of them from a
 * single landing page. Discovery reads that page, picks the highest version
 * whose uncompressed geodatabase archive is linked, HEADs it, and asks the
 * FeatureServer what it is serving — three small requests, no download.
 *
 * ## The two paths have different jobs
 *
 *   BULK ARCHIVE   the release. One GET of ~760 MB, measured at 12.7 s, and the
 *                  publisher's exact bytes retained as the artifact.
 *   FEATURESERVER  the witness. Its layer name, count, schema and edit dates
 *                  are compared against the archive; it is never crawled. A
 *                  full crawl is 1,788 pages and paging degrades from 1.2 s at
 *                  offset 0 to 28.9 s at offset 1,000,000 — many hours of load
 *                  on a public service to obtain a file the publisher already
 *                  offers.
 *
 * The version label comes from the archive's own filename
 * (`V12.0.0_Wisconsin_Parcels_2026_…`), and the FeatureServer's layer name
 * (`V1200_WisconsinParcels_2026`) must agree with it. If they disagree, the
 * service has moved to a release the archive has not, or the reverse, and
 * that is reported rather than guessed around.
 */
import { fail } from '../../core/errors.ts';
import { fieldSetDigestOf } from '../../runtime/arcgis-session.ts';
import {
  getText,
  headArchive,
  releaseFingerprintOf,
  type DiscoveredArchiveRelease,
  type HttpDeps,
} from '../../runtime/bulk-acquisition.ts';

export const WI_SCO_DATA_PAGE = 'https://www.sco.wisc.edu/parcels/data/';
export const WI_FEATURE_SERVICE_URL =
  'https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer';
export const WI_FEATURE_LAYER_ID = 0;

/** Links of this shape on the landing page are the statewide archives. */
const ARCHIVE_LINK = /https:\/\/web\.s3\.wisc\.edu\/parcels\/v\d+_parcels\/V(\d+)\.(\d+)\.(\d+)_Wisconsin_Parcels_(\d{4})_10\.3_Uncompressed\.zip/g;

export type WiArchiveLink = {
  readonly url: string;
  readonly filename: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly year: number;
  /** `V12.0.0-2026`. The release label — the publisher's, not ours. */
  readonly referencePeriod: string;
  /** `V1200_WisconsinParcels_2026`, the name the same release carries in the service. */
  readonly expectedLayerName: string;
};

/**
 * Every statewide archive linked from the landing page, newest first.
 *
 * Only the UNCOMPRESSED geodatabase is chosen: the "Compressed" archive is an
 * Esri compressed geodatabase (CDF), a different on-disk format, and the two
 * are the same release.
 */
export function parseArchiveLinks(html: string): readonly WiArchiveLink[] {
  const seen = new Map<string, WiArchiveLink>();
  for (const m of html.matchAll(ARCHIVE_LINK)) {
    const [url, major, minor, patch, year] = m as unknown as [string, string, string, string, string];
    if (seen.has(url)) continue;
    const version = `V${major}.${minor}.${patch}`;
    seen.set(url, {
      url,
      filename: url.slice(url.lastIndexOf('/') + 1),
      major: Number(major), minor: Number(minor), patch: Number(patch), year: Number(year),
      referencePeriod: `${version}-${year}`,
      expectedLayerName: `V${major.padStart(2, '0')}${minor}${patch}_WisconsinParcels_${year}`,
    });
  }
  return [...seen.values()].sort((a, b) =>
    b.major - a.major || b.minor - a.minor || b.patch - a.patch || b.year - a.year);
}

export type ArcGisLayerWitness = {
  readonly layerName: string;
  readonly count: number;
  readonly lastEditDate: string | null;
  readonly dataLastEditDate: string | null;
  readonly schemaLastEditDate: string | null;
  readonly capabilities: string;
  readonly maxRecordCount: number | null;
  readonly supportsPagination: boolean;
  readonly supportsOrderBy: boolean;
  readonly objectIdField: string | null;
  readonly geometryType: string | null;
  readonly fields: readonly { readonly name: string; readonly type: string; readonly length?: number }[];
  readonly fieldSetDigest: string;
  readonly copyrightText: string | null;
};

export type WiDiscoveredRelease = DiscoveredArchiveRelease & {
  readonly archive: WiArchiveLink;
  readonly witness: ArcGisLayerWitness;
  /** True when the service is serving the same version the archive is. */
  readonly serviceMatchesArchive: boolean;
  /** Anonymous, free, no session: the facts the core gate depends on, re-observed. */
  readonly access: {
    readonly credentialsRequired: false;
    readonly sessionRequired: false;
    readonly captchaObserved: false;
    readonly archiveAcceptsRanges: boolean;
  };
};

export async function discoverWiRelease(deps: HttpDeps = {}): Promise<WiDiscoveredRelease> {
  const html = await getText(WI_SCO_DATA_PAGE, deps);
  const links = parseArchiveLinks(html);
  const newest = links[0];
  if (newest === undefined) {
    fail('SCHEMA_DRIFT', 'the SCO landing page no longer links a statewide geodatabase archive', {
      page: WI_SCO_DATA_PAGE,
      remedy: 'the page layout or distribution changed; re-verify the source before any further run',
    });
  }

  const head = await headArchive(newest.url, deps);
  const witness = await readWitness(deps);

  return {
    sourceId: 'wi_statewide_parcels',
    referencePeriod: newest.referencePeriod,
    releaseFingerprint: releaseFingerprintOf(head),
    head,
    archive: newest,
    witness,
    serviceMatchesArchive: witness.layerName === newest.expectedLayerName,
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

async function readWitness(deps: HttpDeps): Promise<ArcGisLayerWitness> {
  const layerUrl = `${WI_FEATURE_SERVICE_URL}/${WI_FEATURE_LAYER_ID}`;
  const layer = JSON.parse(await getText(`${layerUrl}?f=json`, deps)) as Record<string, unknown>;
  if (layer['error'] !== undefined) fail('TRANSPORT', 'the FeatureServer returned an error for layer metadata', { error: layer['error'] });
  const countBody = JSON.parse(await getText(`${layerUrl}/query?where=1%3D1&returnCountOnly=true&f=json`, deps)) as { count?: number };
  if (typeof countBody.count !== 'number') fail('TRANSPORT', 'the FeatureServer did not return a count');

  const editing = (layer['editingInfo'] ?? {}) as Record<string, number | undefined>;
  const advanced = (layer['advancedQueryCapabilities'] ?? {}) as Record<string, boolean | undefined>;
  const iso = (ms: number | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
  const fields = ((layer['fields'] ?? []) as { name: string; type: string; length?: number }[])
    .map((f) => ({ name: f.name, type: f.type, ...(f.length !== undefined ? { length: f.length } : {}) }));

  return {
    layerName: String(layer['name'] ?? ''),
    count: countBody.count,
    lastEditDate: iso(editing['lastEditDate']),
    dataLastEditDate: iso(editing['dataLastEditDate']),
    schemaLastEditDate: iso(editing['schemaLastEditDate']),
    capabilities: String(layer['capabilities'] ?? ''),
    maxRecordCount: typeof layer['maxRecordCount'] === 'number' ? layer['maxRecordCount'] : null,
    supportsPagination: advanced['supportsPagination'] === true,
    supportsOrderBy: advanced['supportsOrderBy'] === true,
    objectIdField: typeof layer['objectIdField'] === 'string' ? layer['objectIdField'] : null,
    geometryType: typeof layer['geometryType'] === 'string' ? layer['geometryType'] : null,
    fields,
    fieldSetDigest: fieldSetDigestOf(fields),
    copyrightText: typeof layer['copyrightText'] === 'string' ? layer['copyrightText'] : null,
  };
}
