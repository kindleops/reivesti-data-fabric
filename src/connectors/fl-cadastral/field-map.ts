/**
 * Florida cadastral PAR files — complete field inventory.
 *
 * Each county's "<county>_2026Ppar.zip" is the county property appraiser's
 * parcel shapefile, which the Department joined to the 2026 PRELIMINARY NAL
 * and posted in the PTO Data Portal's Map Data folder. Its .dbf carries 118
 * columns in every county (measured 2026-09-29): the polygon's own PARCELNO,
 * a row id, and the joined roll — the NAL's columns under dBASE's ten-character
 * names ("JV_NON_HMS" for JV_NON_HMSTD_RESD). Only PARCELNO's width differs
 * between counties (10 to 254 characters), so the layout is pinned with that
 * one width free.
 *
 * ## Projected once
 *
 * The joined columns are the SAME publisher facts as the NAL rows they were
 * joined from. Projecting them again would give every parcel two assessments,
 * two owners and two situs addresses that could only ever agree or disagree
 * about a join. So this source contributes what only it has — the polygon, its
 * identity, and the sale echo it carries — and every other joined column is
 * IGNORE_WITH_REASON here: retained in the archive, compared against the NAL by
 * the cross-source audit, projected from the NAL alone. Columns the NAL map
 * calls RESTRICTED stay RESTRICTED here and reach no plane at all — the NAL
 * already routes the same values to the restricted plane.
 *
 * ## The .dbf cannot say "blank" for a number
 *
 * dBASE numerics have no null. Where the roll has no second sale, SALE_YR2 and
 * SALE_PRC2 read 0 (measured: every no-sale slot in Lafayette and Brevard),
 * while the text columns beside them are blank. A sale slot is therefore
 * "stated" by its text columns or a non-zero year, never by a zero number — see
 * `derive.ts` — and a zero price in a stated slot is read as zero, the format's
 * one available meaning.
 */
import type { FieldSpec } from '../mn-statewide-parcels/field-map.ts';
import { FL_NAL_FIELD_MAP } from '../fl-nal/field-map.ts';

/** The 118 columns in file order, with dBASE type, width and decimals as the files declare them. */
const DBF_LAYOUT = `PARCELNO:C:*:0 OID_:N:9:0 CO_NO:N:19:5 PARCEL_ID:C:30:0 FILE_T:C:1:0 ASMNT_YR:N:19:5 BAS_STRT:C:2:0 ATV_STRT:C:2:0
GRP_NO:C:1:0 DOR_UC:C:4:0 PA_UC:C:2:0 SPASS_CD:C:1:0 JV:N:19:5 JV_CHNG:N:19:5 JV_CHNG_CD:N:19:5 AV_SD:N:19:5 AV_NSD:N:19:5
TV_SD:N:19:5 TV_NSD:N:19:5 JV_HMSTD:N:19:5 AV_HMSTD:N:19:5 JV_NON_HMS:N:19:5 AV_NON_HMS:N:19:5 JV_RESD_NO:N:19:5
AV_RESD_NO:N:19:5 JV_CLASS_U:N:19:5 AV_CLASS_U:N:19:5 JV_H2O_REC:N:19:5 AV_H2O_REC:N:19:5 JV_CONSRV_:N:19:5 AV_CONSRV_:N:19:5
JV_HIST_CO:N:19:5 AV_HIST_CO:N:19:5 JV_HIST_SI:N:19:5 AV_HIST_SI:N:19:5 JV_WRKNG_W:N:19:5 AV_WRKNG_W:N:19:5 NCONST_VAL:N:19:5
DEL_VAL:N:19:5 PAR_SPLT:N:19:5 DISTR_CD:N:19:5 DISTR_YR:N:19:5 LND_VAL:N:19:5 LND_UNTS_C:N:19:5 NO_LND_UNT:N:19:5
LND_SQFOOT:N:19:5 DT_LAST_IN:N:19:5 IMP_QUAL:C:3:0 CONST_CLAS:N:19:5 EFF_YR_BLT:N:19:5 ACT_YR_BLT:N:19:5 TOT_LVG_AR:N:19:5
NO_BULDNG:N:19:5 NO_RES_UNT:N:19:5 SPEC_FEAT_:N:19:5 M_PAR_SAL1:C:1:0 QUAL_CD1:C:2:0 VI_CD1:C:1:0 SALE_PRC1:N:19:5
SALE_YR1:N:19:5 SALE_MO1:C:2:0 OR_BOOK1:C:6:0 OR_PAGE1:C:6:0 CLERK_NO1:C:20:0 S_CHNG_CD1:N:19:5 M_PAR_SAL2:C:1:0 QUAL_CD2:C:2:0
VI_CD2:C:1:0 SALE_PRC2:N:19:5 SALE_YR2:N:19:5 SALE_MO2:C:2:0 OR_BOOK2:C:6:0 OR_PAGE2:C:6:0 CLERK_NO2:C:20:0 S_CHNG_CD2:N:19:5
OWN_NAME:C:33:0 OWN_ADDR1:C:40:0 OWN_ADDR2:C:40:0 OWN_CITY:C:40:0 OWN_STATE:C:30:0 OWN_ZIPCD:N:19:5 OWN_STATE_:C:2:0
FIDU_NAME:C:33:0 FIDU_ADDR1:C:40:0 FIDU_ADDR2:C:40:0 FIDU_CITY:C:40:0 FIDU_STATE:C:30:0 FIDU_ZIPCD:C:5:0 FIDU_CD:N:19:5
S_LEGAL:C:35:0 APP_STAT:C:1:0 CO_APP_STA:C:1:0 MKT_AR:C:3:0 NBRHD_CD:C:10:0 PUBLIC_LND:C:1:0 TAX_AUTH_C:C:5:0 TWN:C:3:0
RNG:C:3:0 SEC:C:3:0 CENSUS_BK:C:16:0 PHY_ADDR1:C:40:0 PHY_ADDR2:C:40:0 PHY_CITY:C:40:0 PHY_ZIPCD:N:19:5 ALT_KEY:C:26:0
ASS_TRNSFR:C:1:0 PREV_HMSTD:N:19:5 ASS_DIF_TR:N:19:5 CONO_PRV_H:N:19:5 PARCEL_ID_:C:30:0 YR_VAL_TRN:N:19:5 SEQ_NO:N:19:5
RS_ID:C:4:0 MP_ID:C:8:0 STATE_PAR_:C:18:0 SPC_CIR_CD:N:19:5 SPC_CIR_YR:N:19:5 SPC_CIR_TX:C:50:0`;

export type FlParColumn = {
  readonly name: string;
  readonly type: string;
  /** Null for PARCELNO, whose width is the county's own. */
  readonly length: number | null;
  readonly decimals: number;
};

export const FL_PAR_DBF_LAYOUT: readonly FlParColumn[] = DBF_LAYOUT.split(/\s+/).filter((x) => x !== '').map((token) => {
  const [name, type, length, decimals] = token.split(':') as [string, string, string, string];
  return { name, type, length: length === '*' ? null : Number(length), decimals: Number(decimals) };
});

/** The dBASE name → the NAL column it was joined from. Only where truncation is not a unique prefix. */
const EXPLICIT: Readonly<Record<string, string>> = {
  M_PAR_SAL1: 'MULTI_PAR_SAL1', M_PAR_SAL2: 'MULTI_PAR_SAL2', S_CHNG_CD1: 'SAL_CHNG_CD1', S_CHNG_CD2: 'SAL_CHNG_CD2',
};

/** The NAL column a PAR column carries, or null for the columns only the map has. */
export function nalFieldOfParColumn(name: string): string | null {
  if (name === 'PARCELNO' || name === 'OID_') return null;
  const explicit = EXPLICIT[name];
  if (explicit !== undefined) return explicit;
  const nal = FL_NAL_FIELD_MAP.map((f) => f.field);
  if (nal.includes(name)) return name;
  const candidates = nal.filter((f) => f.length > name.length && f.startsWith(name));
  if (candidates.length !== 1) throw new Error(`${name}: ${candidates.length} NAL columns share this dBASE prefix`);
  return candidates[0] as string;
}

const SALE_ECHO = /^(M_PAR_SAL|QUAL_CD|VI_CD|SALE_PRC|SALE_YR|SALE_MO|OR_BOOK|OR_PAGE|CLERK_NO|S_CHNG_CD)[12]$/;

export const FL_PAR_FIELD_MAP: readonly (FieldSpec & { readonly nalField: string | null })[] = FL_PAR_DBF_LAYOUT.map((c) => {
  const nalField = nalFieldOfParColumn(c.name);
  const nal = nalField === null ? undefined : FL_NAL_FIELD_MAP.find((f) => f.field === nalField);
  const base = { field: c.name, sourceType: c.type === 'N' ? 'Double' : 'String', ...(c.length !== null ? { maxLength: c.length } : {}), nalField };
  if (c.name === 'PARCELNO') {
    return { ...base, group: 'identity', disposition: 'CANONICALIZE', note: 'The polygon\'s parcel number in the county\'s GIS. Equal to the joined PARCEL_ID on every joined record measured; the width is the county\'s own.' } as const;
  }
  if (c.name === 'OID_') {
    return { ...base, group: 'provenance', disposition: 'IGNORE_WITH_REASON', note: 'Row object id of the shapefile export: a position, renumbered by every export, never identity.' } as const;
  }
  if (c.name === 'CO_NO') {
    return { ...base, group: 'identity', disposition: 'CANONICALIZE', note: 'DOR county number of the JOINED roll record; 0 where the polygon joined no roll record, which is quarantined as UNJOINED_POLYGON.' } as const;
  }
  if (c.name === 'PARCEL_ID') {
    return { ...base, group: 'identity', disposition: 'CANONICALIZE', note: 'The joined roll\'s parcel id: with the county, the canonical identity — the same key the NAL computes, so the map and the roll converge.' } as const;
  }
  if (SALE_ECHO.test(c.name)) {
    return { ...base, group: 'sale', disposition: 'CANONICALIZE', note: `Joined sale echo (${nalField}). Becomes a FL_DOR_PAR_SALE_ECHO that TRANSACTION_RESOLUTION matches onto the SDF sale — support, never a second sale.` } as const;
  }
  if (nal?.disposition === 'RESTRICTED') {
    return { ...base, group: nal.group, disposition: 'RESTRICTED', note: `Joined ${nalField}: restricted in the NAL and here. Retained in the archive; reaches no plane from this source.` } as const;
  }
  return {
    ...base, group: nal?.group ?? 'provenance', disposition: 'IGNORE_WITH_REASON',
    note: `Joined ${nalField}: the same roll fact the NAL publishes, from the same preliminary roll. Projected once, from the NAL; compared by the cross-source audit.`,
  } as const;
});

export function flParDispositionCounts(): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const x of FL_PAR_FIELD_MAP) out[x.disposition] = (out[x.disposition] ?? 0) + 1;
  return out;
}

/** The dBASE numeric the files declare as N(19,5), as the decimal it holds: "2026.00000" → "2026". Never a float. */
export function dbfDecimal(raw: string | null): string | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '') return null;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (match === null) return text;
  const [, sign, whole = '', fraction = ''] = match;
  const trimmedFraction = fraction.replace(/0+$/, '');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
  const value = trimmedFraction === '' ? trimmedWhole : `${trimmedWhole}.${trimmedFraction}`;
  return value === '0' ? '0' : `${sign}${value}`;
}
