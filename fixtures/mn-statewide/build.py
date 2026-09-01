#!/usr/bin/env python3
"""Builds the synthetic Minnesota statewide parcel fixtures.

EVERY OWNER NAME AND MAILING ADDRESS BELOW IS INVENTED. County FIPS codes and
county names are public federal geography, not personal data, and are real so
that partition routing is exercised against the actual jurisdiction catalogue.
No live parcel row, owner name or mailing address from the delivered artifact is
committed to this repository.

The bundle shape matches what the GeoPackage converter emits, so fixtures and
the real 2.7-million-row delivery travel the same code path.

Run:  python3 fixtures/mn-statewide/build.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# Real participating counties, so routing is tested against the real catalogue.
HENNEPIN, RAMSEY, ANOKA, CARVER, DAKOTA = '27053', '27123', '27003', '27019', '27037'
NAMES = {HENNEPIN: 'Hennepin', RAMSEY: 'Ramsey', ANOKA: 'Anoka', CARVER: 'Carver', DAKOTA: 'Dakota'}

# The pinned field set, so the drift digest matches the connector's.
LAYER_FIELDS = json.load(open(os.path.join(HERE, 'layer-fields.json')))


def header(fields=None, run='2026-08-06', count=None, rows=None):
    return {
        "kind": "df.gpkg.snapshot/1",
        "sourceId": "mn_statewide_parcels",
        "serviceUrl": "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer",
        "layerId": 1,
        "acquisition": {
            "method": "publisher_bulk_download",
            "downloadUrl": "https://operations.gis.data.mn.gov/api/publicdownload/download/511/plan_parcels_open.gpkg",
            "archiveSha256": "0" * 64,
            "note": "synthetic fixture",
        },
        "retrievedAt": "2026-08-31T12:00:00.000Z",
        "sourceReportedCount": count if count is not None else rows,
        "sourceSchemaDigest": "fixture",
        "layerMetadata": {"fields": fields if fields is not None else LAYER_FIELDS},
        "declaredFields": sorted(f["name"] for f in LAYER_FIELDS),
        "countyMetadata": [
            {"countyfips": f[2:], "countyname": NAMES[f], "rundate": run,
             "acqdate": "2026-08-04", "gac_open_approval": "true", "data_url": None}
            for f in sorted(NAMES)
        ],
    }


def parcel(county, pin, owner=None, taxpayer=None, emv_total=None, emv_land=None,
           year_built=None, sale_date=None, sale_value=None, street="1 Synthetic Ave",
           mkt_year=2026, tax_year=2026, total_tax=None, own_mail=None, acres=1.5):
    """One parcel row. Every name and mailing line is invented."""
    house, _, name = street.partition(" ")
    row = {
        "objectid": abs(hash(county + pin)) % 10_000_000,
        "co_code": county,
        "co_name": NAMES.get(county, "Unknown"),
        "state_code": "MN",
        "county_pin": pin,
        "state_pin": f"{county}-{pin}",
        "anumber": int(house) if house.isdigit() else None,
        "st_name": name.rsplit(" ", 1)[0] if " " in name else name,
        "st_pos_typ": name.rsplit(" ", 1)[1] if " " in name else None,
        "ctu_name": f"{NAMES.get(county, 'Somewhere')} City",
        "zip": "55401",
        "acres_poly": acres,
        "mkt_year": mkt_year,
        "tax_year": tax_year,
        "n_standard": 1,
        "edit_date": "2026-07-01T00:00:00.000Z",
    }
    if owner is not None:
        row["owner_name"] = owner
    if taxpayer is not None:
        row["tax_name"] = taxpayer
    if own_mail is not None:
        for i, line in enumerate(own_mail, start=1):
            row[f"own_add_l{i}"] = line
    if emv_total is not None:
        row["emv_total"] = emv_total
    if emv_land is not None:
        row["emv_land"] = emv_land
    if year_built is not None:
        row["year_built"] = year_built
    if sale_date is not None:
        row["sale_date"] = sale_date
    if sale_value is not None:
        row["sale_value"] = sale_value
    if total_tax is not None:
        row["total_tax"] = total_tax
    return row


def trailer(n, reported=None):
    return {
        "kind": "df.arcgis.snapshot.trailer/2",
        "retrievedFeatureCount": n,
        "sourceReportedCountAtEnd": reported if reported is not None else n,
        "sourceChangedDuringRead": False,
        "missingObjectIds": [],
    }


def write(path, rows, head=None, tail=None):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(head if head is not None else header(rows=len(rows)), sort_keys=True) + "\n")
        for r in rows:
            fh.write(json.dumps(r, sort_keys=True) + "\n")
        fh.write(json.dumps(tail if tail is not None else trailer(len(rows)), sort_keys=True) + "\n")


# --- the five-county baseline ----------------------------------------------
# Deliberately includes the same PIN in two counties and the same street address
# in two counties: both must stay distinct properties.
BASE = [
    parcel(HENNEPIN, "0202824410097", owner="NORTHSTAR HOMES LLC", taxpayer="NORTHSTAR HOMES LLC",
           emv_total=250000, emv_land=88000, year_built=1909, total_tax=3400,
           own_mail=["100 Invented Way", "Minneapolis MN 55401"],
           sale_date="2024-06-15T00:00:00.000Z", sale_value=245000),
    parcel(HENNEPIN, "0202824410098", owner="AVERY FICTITIOUS", emv_total=310000, year_built=1962,
           own_mail=["12 Imaginary Rd"]),
    # Same PIN string as the Hennepin parcel above. Different county, different property.
    parcel(RAMSEY, "0202824410097", owner="LAKESIDE HOLDINGS INC", emv_total=180000, year_built=1975),
    # Same street address as the first Hennepin parcel. Different county.
    parcel(RAMSEY, "112233445566", owner="BLAKE PLACEHOLDER", emv_total=205000,
           street="1 Synthetic Ave", year_built=1998),
    parcel(ANOKA, "AN-0001", owner="PRAIRIE GATE PROPERTIES LLC", emv_total=140000, year_built=2001,
           street="20 Notional Rd"),
    parcel(ANOKA, "AN-0002", owner="ROBIN NOTREAL", emv_total=165000, year_built=1988,
           street="22 Notional Rd"),
    parcel(CARVER, "CV-0001", owner="CEDAR HOLLOW HOLDINGS LLC", emv_total=420000, year_built=2015,
           street="7 Fabricated Ln"),
    parcel(DAKOTA, "DK-0001", owner="SUMMIT PARTNERS LLC", emv_total=99000, year_built=1954,
           street="9 Placeholder Ct"),
]
write(os.path.join(HERE, "five-county-2026-08.bundle"), BASE)

# The same delivery, rows reordered. Canonical output must be identical.
write(os.path.join(HERE, "five-county-2026-08-shuffled.bundle"), list(reversed(BASE)))

# --- the September delta, one change per county ------------------------------
DELTA = [
    # Hennepin: unchanged.
    BASE[0], BASE[1],
    # Ramsey: assessment change.
    parcel(RAMSEY, "0202824410097", owner="LAKESIDE HOLDINGS INC", emv_total=199000, year_built=1975),
    BASE[3],
    # Anoka: owner observation change.
    parcel(ANOKA, "AN-0001", owner="PRAIRIE GATE PROPERTIES II LLC", emv_total=140000, year_built=2001,
           street="20 Notional Rd"),
    BASE[5],
    # Carver: a NEW parcel appears; CV-0001 remains.
    BASE[6],
    parcel(CARVER, "CV-0002", owner="BIRCH LANE CAPITAL LLC", emv_total=375000, year_built=2024,
           street="8 Fabricated Ln"),
    # Dakota: DK-0001 is MISSING from this delivery.
]
write(os.path.join(HERE, "five-county-2026-09.bundle"), DELTA)

# October: Dakota's parcel reappears, everything else as September.
REAPPEAR = DELTA + [BASE[7]]
write(os.path.join(HERE, "five-county-2026-10.bundle"), REAPPEAR)

# --- faults ------------------------------------------------------------------
# A county code that is not a catalogued Minnesota county. Must quarantine.
write(os.path.join(HERE, "fault-unknown-county.bundle"),
      BASE[:2] + [parcel("27999", "XX-0001", owner="NOWHERE LLC"), parcel("48113", "TX-0001", owner="TEXAS LLC")])

# A parcel with no identifier. Must quarantine.
noid = parcel(HENNEPIN, "0202824410099", owner="NO IDENTITY LLC")
del noid["county_pin"]
write(os.path.join(HERE, "fault-missing-pin.bundle"), BASE[:2] + [noid])

# The publisher changed the field set. Must quarantine the whole run.
drifted = [dict(f) for f in LAYER_FIELDS] + [{"name": "brand_new_column", "type": "esriFieldTypeString", "length": 10}]
write(os.path.join(HERE, "fault-field-drift.bundle"), BASE[:2], head=header(fields=drifted, rows=2))

# The same parcel twice in one delivery: multipolygon parcels do this.
write(os.path.join(HERE, "duplicate-parcel.bundle"), BASE[:2] + [BASE[0]])

# --- Hennepin overlap ---------------------------------------------------------
# The statewide view of two Hennepin parcels, against which the direct-county
# fixture is compared: one exact agreement, one conflict, one null-vs-populated.
OVERLAP = [
    parcel(HENNEPIN, "0202824410097", owner="NORTHSTAR HOMES LLC", emv_total=250000,
           year_built=1909, total_tax=3400),
    # year_built disagrees with the direct source (1962 vs 1963) and the
    # statewide layer supplies finished square feet, which the direct feed lacks.
    parcel(HENNEPIN, "0202824410098", owner="AVERY FICTITIOUS", emv_total=310000, year_built=1963),
]
write(os.path.join(HERE, "hennepin-overlap.bundle"), OVERLAP)

print("wrote fixtures to", HERE)
