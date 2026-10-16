/**
 * A small Florida roll, in the Department's real 2026 layouts, served by a fake
 * PTO data library: NAL and SDF county CSVs and PAR shapefiles for three
 * counties. Every parcel, owner, address and sale here is invented; values are
 * chosen to exercise one rule each, and the comment beside each says which.
 */
import { FL_NAL_LAYOUTS } from '../../src/connectors/fl-nal/field-map.ts';
import { FL_SDF_LAYOUT_2026 } from '../../src/connectors/fl-sdf/field-map.ts';
import { FL_PAR_DBF_LAYOUT } from '../../src/connectors/fl-cadastral/field-map.ts';
import {
  STATE_PLANE_FL_NORTH_FEET_PRJ, dbfOf, fakePortal, shpOf, square, zipOf,
  type DbfFieldSpec, type FakePortal, type PolygonSpec,
} from './fl-fixture.ts';

export type Row = Readonly<Record<string, string>>;

export const LAFAYETTE = { dorCode: '44', fips: '12067', name: 'Lafayette', stem: 'lafayette' } as const;
export const LIBERTY = { dorCode: '49', fips: '12077', name: 'Liberty', stem: 'liberty' } as const;
export const GULF = { dorCode: '33', fips: '12045', name: 'Gulf', stem: 'gulf' } as const;
export type FixtureCounty = typeof LAFAYETTE | typeof LIBERTY | typeof GULF;

/** CSV exactly as the Department writes it: header row, CRLF, fields quoted only where needed. */
export function csvOf(columns: readonly string[], rows: readonly Row[]): Buffer {
  const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c] ?? '')).join(','))];
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

export function nalRow(county: FixtureCounty, parcel: string, extra: Row = {}): Row {
  return {
    CO_NO: county.dorCode, PARCEL_ID: parcel, FILE_T: 'R', ASMNT_YR: '2026', BAS_STRT: '01', ATV_STRT: '1', GRP_NO: '2',
    DOR_UC: '001', PA_UC: '01', JV: '150000', AV_SD: '120000', AV_NSD: '110000', TV_SD: '95000', TV_NSD: '85000',
    LND_VAL: '30000', LND_UNTS_CD: '1', NO_LND_UNTS: '1', LND_SQFOOT: '43560', DT_LAST_INSPT: '0315', ACT_YR_BLT: '1998',
    EFF_YR_BLT: '2001', TOT_LVG_AREA: '1850', NO_BULDNG: '1', NO_RES_UNTS: '1',
    OWN_NAME: 'INVENTED OWNER ONE', OWN_ADDR1: '900 FICTIONAL MAILING WAY', OWN_CITY: 'NOWHERESVILLE', OWN_STATE: 'FL',
    OWN_ZIPCD: '32000', OWN_STATE_DOM: 'FL', S_LEGAL: 'LOT 1 BLK 2 INVENTED SUB',
    PHY_ADDR1: `${parcel.length} SAMPLE RD`, PHY_CITY: 'MAYO', PHY_ZIPCD: '32066', CENSUS_BK: '120679501001',
    TAX_AUTH_CD: '0100', STATE_PAR_ID: `D${county.dorCode}${parcel.replace(/[^0-9A-Z]/gi, '').slice(-8)}`,
    SEQ_NO: '1', RS_ID: 'A1B2', MP_ID: '12345678',
    ...extra,
  };
}

export function sdfRow(county: FixtureCounty, parcel: string, saleId: string, extra: Row = {}): Row {
  return {
    CO_NO: county.dorCode, PARCEL_ID: parcel, ASMNT_YR: '2026', ATV_STRT: '1', GRP_NO: '2', DOR_UC: '001',
    NBRHD_CD: '100', MKT_AR: '1', CENSUS_BK: '120679501001', SALE_ID_CD: saleId, VI_CD: 'I',
    QUAL_CD: '01', SALE_YR: '2025', SALE_MO: '06', SALE_PRC: '200000', RS_ID: 'A1B2', MP_ID: '12345678',
    STATE_PARCEL_ID: `D${county.dorCode}${parcel.replace(/[^0-9A-Z]/gi, '').slice(-8)}`,
    ...extra,
  };
}

export type ParRecord = { readonly fields: Readonly<Record<string, string | number | null>>; readonly polygon: PolygonSpec };

/** A county PAR shapefile zip in the 118-column joined layout; PARCELNO width 30. */
export function parZipOf(county: FixtureCounty, records: readonly ParRecord[]): Buffer {
  const fields: DbfFieldSpec[] = FL_PAR_DBF_LAYOUT.map((c) => ({
    name: c.name, type: c.type as 'C' | 'N', length: c.length ?? 30, decimals: c.decimals,
  }));
  // The dBASE numerics cannot be blank: a joined record's absent numbers read 0.
  const numeric = new Set(FL_PAR_DBF_LAYOUT.filter((c) => c.type === 'N').map((c) => c.name));
  const rows = records.map((r) => {
    const row: Record<string, string | number | null> = {};
    for (const c of FL_PAR_DBF_LAYOUT) row[c.name] = r.fields[c.name] ?? (numeric.has(c.name) ? 0 : null);
    return row;
  });
  const { shp, shx } = shpOf(records.map((r) => r.polygon));
  const stem = `${county.stem}_2026Ppar`;
  return zipOf([
    { name: `${stem}.shp`, bytes: shp },
    { name: `${stem}.shx`, bytes: shx },
    { name: `${stem}.dbf`, bytes: dbfOf(fields, rows) },
    { name: `${stem}.prj`, bytes: Buffer.from(STATE_PLANE_FL_NORTH_FEET_PRJ) },
    { name: `${stem}.cpg`, bytes: Buffer.from('UTF-8') },
  ]);
}

export function parRecord(county: FixtureCounty, parcel: string, x: number, extra: Readonly<Record<string, string | number | null>> = {}): ParRecord {
  return {
    fields: { PARCELNO: parcel, OID_: 1, CO_NO: Number(county.dorCode), PARCEL_ID: parcel, ASMNT_YR: 2026, JV: 150000, ...extra },
    // A 100 ft square: 10,000 ft² in US survey feet.
    polygon: [square(1_900_000 + x * 1000, 400_000, 100)],
  };
}

// ---------------------------------------------------------------------------
// The fixture roll
// ---------------------------------------------------------------------------

/** Lafayette's parcels. Each id exercises an identity rule. */
export const P_DASHED = '01-02-03-0001-0000-0010';
export const P_ZEROS = '0000012345';
export const P_PUNCT_A = '1-1109';
export const P_PUNCT_B = '11-109';

export function lafayetteNal(): Row[] {
  return [
    nalRow(LAFAYETTE, P_DASHED, {
      OWN_NAME: 'INVENTED HOLDINGS LLC',
      // Restricted: a fiduciary block and an owner-personal exemption (widow).
      FIDU_NAME: 'INVENTED CARE OF', FIDU_ADDR1: '77 FICTIONAL TRUST LN', FIDU_CITY: 'NOWHERESVILLE', FIDU_STATE: 'FL', FIDU_ZIPCD: '32001',
      EXMPT_01: '25000', EXMPT_33: '5000', APP_STAT: 'W',
      ASS_TRNSFR_FG: '1', PARCEL_ID_PRV_HMSTD: 'PREV-000-PARCEL', CONO_PRV_HM: '11', YR_VAL_TRNSF: '2024',
      // Sale echo 1: the SDF's sale 2501, exactly.
      MULTI_PAR_SAL1: '', QUAL_CD1: '01', VI_CD1: 'I', SALE_PRC1: '200000', SALE_YR1: '2025', SALE_MO1: '6',
      OR_BOOK1: '123', OR_PAGE1: '45',
    }),
    nalRow(LAFAYETTE, P_ZEROS, {
      OWN_NAME: 'INVENTED PERSON TWO',
      // A zero-price sale is a stated zero, echoed from sale 2503.
      QUAL_CD1: '11', VI_CD1: 'I', SALE_PRC1: '0', SALE_YR1: '2025', SALE_MO1: '3', CLERK_NO1: '2025001234',
    }),
    nalRow(LAFAYETTE, P_PUNCT_A, { OWN_NAME: 'INVENTED PERSON THREE', PHY_ADDR1: '5 SHARED ADDRESS CT' }),
    nalRow(LAFAYETTE, P_PUNCT_B, { OWN_NAME: 'INVENTED PERSON FOUR', PHY_ADDR1: '5 SHARED ADDRESS CT', DOR_UC: '105' }),
  ];
}

export function lafayetteSdf(): Row[] {
  return [
    sdfRow(LAFAYETTE, P_DASHED, '2501', { OR_BOOK: '123', OR_PAGE: '45' }),
    // A second sale of the same parcel: qualified multi-parcel, never echoed.
    sdfRow(LAFAYETTE, P_DASHED, '2502', { SALE_YR: '2026', SALE_MO: '01', SALE_PRC: '250000', QUAL_CD: '05', MULTI_PAR_SAL: 'D', OR_BOOK: '130', OR_PAGE: '1' }),
    sdfRow(LAFAYETTE, P_ZEROS, '2503', { QUAL_CD: '11', SALE_YR: '2025', SALE_MO: '03', SALE_PRC: '0', CLERK_NO: '2025001234' }),
    sdfRow(LAFAYETTE, P_PUNCT_A, '2504', { QUAL_CD: '77', SALE_YR: '2025', SALE_MO: '09', SALE_PRC: '', OR_BOOK: '140', OR_PAGE: '2' }),
    sdfRow(LAFAYETTE, P_PUNCT_B, '2505', { QUAL_CD: '99', SALE_YR: '2026', SALE_MO: '02', SALE_PRC: '175000', OR_BOOK: '141', OR_PAGE: '9', SAL_CHG_CD: '3' }),
  ];
}

export function lafayettePar(): ParRecord[] {
  return [
    parRecord(LAFAYETTE, P_DASHED, 1, { QUAL_CD1: '01', VI_CD1: 'I', SALE_PRC1: 200000, SALE_YR1: 2025, SALE_MO1: '6', OR_BOOK1: '123', OR_PAGE1: '45' }),
    parRecord(LAFAYETTE, P_ZEROS, 2, { QUAL_CD1: '11', VI_CD1: 'I', SALE_PRC1: 0, SALE_YR1: 2025, SALE_MO1: '3', CLERK_NO1: '2025001234' }),
    parRecord(LAFAYETTE, P_PUNCT_A, 3),
    parRecord(LAFAYETTE, P_PUNCT_B, 4),
    // A polygon the Department joined to no roll record: water, right of way.
    { fields: { PARCELNO: 'ROW', OID_: 5, CO_NO: 0 }, polygon: [square(1_950_000, 400_000, 50)] },
    // A second polygon of a parcel already drawn: a duplicate identity.
    parRecord(LAFAYETTE, P_DASHED, 6),
  ];
}

export function libertyNal(): Row[] {
  // The same id string as a Lafayette parcel: a different parcel in another county.
  return [nalRow(LIBERTY, P_ZEROS, { OWN_NAME: 'INVENTED PERSON FIVE' }), nalRow(LIBERTY, '9999-0001', { OWN_NAME: 'INVENTED CORP INC' })];
}

export function libertySdf(): Row[] {
  return [sdfRow(LIBERTY, P_ZEROS, '2601', { QUAL_CD: '30', SALE_PRC: '100000', OR_BOOK: '50', OR_PAGE: '5' })];
}

export function libertyPar(): ParRecord[] {
  return [parRecord(LIBERTY, P_ZEROS, 10), parRecord(LIBERTY, '9999-0001', 11)];
}

/**
 * A large synthetic county NAL zip, built one row at a time into external
 * Buffers: no row object outlives its own line, so a memory test measures
 * the pipeline and not the fixture.
 */
export function syntheticNalZip(county: FixtureCounty, rows: number): Buffer {
  const columns = FL_NAL_LAYOUTS.fl_nal_2026_preliminary;
  const parts: Buffer[] = [Buffer.from(`${columns.join(',')}\r\n`)];
  for (let i = 0; i < rows; i++) {
    // Distinct situs per parcel, as in a real roll: a shared address is its own test.
    const row = nalRow(county, `SYN-${String(i).padStart(7, '0')}`, { OWN_NAME: `INVENTED OWNER ${i}`, PHY_ADDR1: `${i} SYNTHETIC RD` });
    parts.push(Buffer.from(`${columns.map((c) => row[c] ?? '').join(',')}\r\n`));
  }
  return zipOf([{ name: `NAL${county.dorCode}P202601.csv`, bytes: Buffer.concat(parts) }]);
}

export type FlFixtureOptions = {
  readonly nal?: Partial<Record<'44' | '49' | '33', readonly Row[]>>;
  readonly sdf?: Partial<Record<'44' | '49' | '33', readonly Row[]>>;
  readonly par?: Partial<Record<'44' | '49' | '33', readonly ParRecord[]>>;
};

/** A portal serving the fixture roll. Files can be replaced to simulate a new release. */
export function flFixturePortal(options: FlFixtureOptions = {}): FakePortal & { publish(o: FlFixtureOptions): void } {
  const portal = fakePortal();
  const counties = [LAFAYETTE, LIBERTY, GULF];
  const publish = (o: FlFixtureOptions) => {
    for (const c of counties) {
      const nal = o.nal?.[c.dorCode];
      if (nal !== undefined) {
        portal.put(`Tax Roll Data Files/NAL/2026P/${c.name} ${c.dorCode} Preliminary NAL 2026.zip`,
          zipOf([{ name: `NAL${c.dorCode}P202601.csv`, bytes: csvOf(FL_NAL_LAYOUTS.fl_nal_2026_preliminary, nal) }]));
      }
      const sdf = o.sdf?.[c.dorCode];
      if (sdf !== undefined) {
        portal.put(`Tax Roll Data Files/SDF/2026P/${c.name} ${c.dorCode} Preliminary SDF 2026.zip`,
          zipOf([{ name: `SDF${c.dorCode}P202601.csv`, bytes: csvOf(FL_SDF_LAYOUT_2026, sdf) }]));
      }
      const par = o.par?.[c.dorCode];
      if (par !== undefined) portal.put(`Map Data/2026F/2026F PAR/${c.stem}_2026Ppar.zip`, parZipOf(c, par));
    }
  };
  publish({
    nal: { '44': lafayetteNal(), '49': libertyNal(), ...options.nal },
    sdf: { '44': lafayetteSdf(), '49': libertySdf(), ...options.sdf },
    par: { '44': lafayettePar(), '49': libertyPar(), ...options.par },
  });
  // The staff folder the connector must never enter.
  portal.folder('Tax Roll Data Files/~NAL-EDR/2026P');
  portal.put('Tax Roll Data Files/~NAL-EDR/2026P/NAL_CONF_2026P_to_analysts.txt', Buffer.from('never read'));
  return Object.assign(portal, { publish });
}
