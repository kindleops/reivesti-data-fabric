#!/usr/bin/env python3
"""Builds the Hennepin side of the representation-overlap fixture.

EVERY PARCEL BELOW IS INVENTED. The parcel identifiers, owner names and mailing
lines are synthetic; no live Hennepin row is committed to this repository. The
street names are real Hennepin geography — public, and the point of the fixture
is that one source packs them and the other splits them — but the house numbers
are arbitrary and no invented owner is attached to a real address.

What is NOT invented is the *shape* of the differences. Each value pair here was
taken from the real DF-0I overlap audit of parcel 0102724110003, where Hennepin's
own service and the state aggregation describe the same parcel and write it down
differently:

    area       79902.43 square feet      vs  1.83 acres
    tax        109672.88                 vs  109673 (integer column)
    sale date  '201412' (YYYYMM)         vs  2014-12-01 (day is padding)
    street     '78TH ST E' packed        vs  st_name/st_pos_typ/st_pos_dir split

The second parcel exists so the audit cannot come out at 100%: its two sources
genuinely disagree, and a comparator that "fixed" that would be worse than the
one that reported it.

Run:  python3 fixtures/hennepin/build-overlap.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "v2-2026-08.ndjson")

lines = open(TEMPLATE, encoding="utf-8").read().splitlines()
header = json.loads(lines[0])
template = json.loads(lines[1])

# Every attribute the layer publishes, blanked. Starting from the real field set
# keeps the fixture on the pinned schema digest rather than a subset of it.
BLANK = {k: None for k in template}


def parcel(**overrides):
    row = dict(BLANK)
    row.update(overrides)
    return row


AGREES = parcel(
    OBJECTID=9_000_001,
    PID=            "0202824410097",
    PID_TEXT=       "02-028-24-41-0097",
    # Square feet, to two decimals, as Hennepin publishes them.
    PARCEL_AREA=    79902.43,
    # Dollars and cents. TOT_NET_TAX is what the literal comparison reads and
    # TAX_TOT is what the contract reads; both carry the cents MnGeo's integer
    # column cannot.
    TAX_TOT=        109672.88,
    TOT_NET_TAX=    109672.88,
    TOTAL_MV1=      250000,
    # A year and a month. There is no day in this field and none is invented.
    SALE_DATE=      "201412",
    SALE_PRICE=     245000,
    SALE_CODE=      "W",
    SALE_CODE_NAME= "WARRANTY DEED",
    # Name, type and directional packed into one space-padded column.
    STREET_NM=      "78TH ST E           ",
    HOUSE_NO=       2901,
    ZIP_CD=         "55425",
    MUNIC_CD=       "01",
    MUNIC_NM=       "BLOOMINGTON",
    MAILING_MUNIC_NM="BLOOMINGTON",
    OWNER_NM=       "NORTHSTAR HOMES LLC",
    TAXPAYER_NM=    "NORTHSTAR HOMES LLC",
    TAXPAYER_NM_1=  "100 INVENTED WAY",
    BUILD_YR=       "1909",
    MKT_VAL_TOT=    250000,
    LAND_MV1=       88000,
    BLDG_MV1=       162000,
    ABBREV_ADDN_NM= "SYNTHETIC ADDITION",
)

DISAGREES = parcel(
    OBJECTID=9_000_002,
    PID=            "0202824410098",
    PID_TEXT=       "02-028-24-41-0098",
    # Not 2.0 acres by any rounding: a real disagreement about the parcel.
    PARCEL_AREA=    5000.0,
    TAX_TOT=        4200.00,
    TOT_NET_TAX=    4200.00,
    TOTAL_MV1=      310000,
    # A different month, not a different precision.
    SALE_DATE=      "202401",
    SALE_PRICE=     512000,
    SALE_CODE=      "W",
    SALE_CODE_NAME= "WARRANTY DEED",
    STREET_NM=      "CEDAR LAKE RD S     ",
    HOUSE_NO=       14,
    # Unit 101 here, unit 102 in the aggregation. Two homes, and the audit must
    # keep saying so.
    CONDO_NO=       "101",
    ZIP_CD=         "55416",
    MUNIC_CD=       "01",
    MUNIC_NM=       "MINNEAPOLIS",
    MAILING_MUNIC_NM="MINNEAPOLIS",
    OWNER_NM=       "AVERY FICTITIOUS",
    TAXPAYER_NM=    "AVERY FICTITIOUS",
    BUILD_YR=       "1962",
    MKT_VAL_TOT=    310000,
    LAND_MV1=       120000,
    BLDG_MV1=       190000,
    ABBREV_ADDN_NM= "SYNTHETIC ADDITION",
)

ROWS = [AGREES, DISAGREES]

head = dict(header)
head["sourceReportedCount"] = len(ROWS)
head["requestedIdCount"] = len(ROWS)
trailer = {
    "kind": "df.arcgis.snapshot.trailer/2",
    "missingObjectIds": [],
    "retrievedFeatureCount": len(ROWS),
    "sourceChangedDuringRead": False,
    "sourceReportedCountAtEnd": len(ROWS),
}

out = os.path.join(HERE, "v2-overlap-representation.ndjson")
with open(out, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(head, sort_keys=True) + "\n")
    for row in ROWS:
        fh.write(json.dumps(row, sort_keys=True) + "\n")
    fh.write(json.dumps(trailer, sort_keys=True) + "\n")

print("wrote", out)
