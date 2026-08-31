#!/usr/bin/env python3
"""Builds the synthetic Minnesota SOS delivery fixtures.

EVERY NAME AND ADDRESS BELOW IS INVENTED. No row is copied from the real
register, and no licensed bulk data is committed to this repository — the
Electronic Media License Agreement forbids bulk redistribution, and these
fixtures exist precisely so the connector can be exercised without it.

The layout is the one transcribed in src/connectors/mn-sos-business/domain.ts:
one heterogeneous CSV carrying record types 01 (master), 02 (filing history) and
03 (name/address), all keyed by a Master ID GUID.

Run:  python3 fixtures/mn-sos/build.py
"""
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))

MANIFEST = {
    "kind": "df.mn-sos.delivery/1",
    "sourceId": "mn_sos_business_entities",
    "product": "business_bulk_data",
    "registryJurisdictionId": "us-mn",
    "fileGeneratedAt": "2026-08-01T00:00:00.000Z",
    "obtainedAt": "2026-08-02T00:00:00.000Z",
    "entryName": "business_bulk_data.csv",
    "archiveSha256": None,
    "implementationGuideVersion": "mbls-business-bulk-data-implementation-guide/2026-08-31",
    "license": {
        "agreementName": "Electronic Media License Agreement",
        "statutoryAuthority": "Minn. Stat. § 13.03 subd. 3",
        "mayServeCustomers": True,
        "prohibitsBulkResale": True,
        "requiresConsentToSublicense": True,
        "prohibitsOfficialPresentation": True,
        "reviewedAt": "2026-08-31",
        "termsUrl": "https://mblsportal.sos.state.mn.us/",
    },
}

EXPORT_DATE = "08/01/2026"


def gid(n):
    return "00000000-0000-4000-8000-%012d" % n


def q(v):
    """Quotes a field the way the guide describes: enclosed, inner quotes doubled."""
    if v is None:
        v = ""
    return '"' + str(v).replace('"', '""') + '"'


def master(mid, btype, filing_no, name, status="Active", filed="01/15/2020",
           expires=None, renewal=None, home_juris=None, statute=None,
           nonprofit="0", lllp="0", professional="0", home_name=None,
           shares=None, mark_type=None, mark_first_use=None, mark_class=None):
    return [mid, "01", btype, filing_no, name, status, filed, expires, renewal,
            home_juris, statute, nonprofit, lllp, professional, home_name,
            shares, mark_type, mark_first_use, mark_class, None, None, EXPORT_DATE]


def filing(mid, btype, orig_no, filing_no, action, rank="P", filed=None, effective=None):
    return [mid, "02", btype, orig_no, filing_no, action, rank, filed, effective]


def nameaddr(mid, btype, orig_no, filing_no=None, name_type=None, addr_type=None,
             party=None, l1=None, l2=None, city=None, region=None, zipc=None,
             zip4=None, country=None):
    return [mid, "03", btype, orig_no, filing_no, name_type, addr_type, party,
            l1, l2, city, region, zipc, zip4, country]


rows = []

# --- 1. domestic LLC, active, agent + organizer -----------------------------
E1 = gid(1)
rows += [
    master(E1, "44", "1000001", "NORTH STAR HOMES LLC", filed="03/04/2019",
           renewal="12/31/2026"),
    filing(E1, "44", "1000001", "1000001", "Original Filing", "P", "03/04/2019", "03/04/2019"),
    filing(E1, "44", "1000001", "1000455", "Renewal", "S", "01/09/2025", "01/09/2025"),
    nameaddr(E1, "44", "1000001", "1000001", None, "2", None,
             "100 Synthetic Ave", "Suite 220", "Minneapolis", "MN", "55401", "1234", "USA"),
    nameaddr(E1, "44", "1000001", "1000001", "4", "14", "Dana Fictitious",
             "18 Imaginary Rd", None, "Saint Paul", "MN", "55102", None, "USA"),
    nameaddr(E1, "44", "1000001", "1000001", "7", "14", "Robin Placeholder",
             "18 Imaginary Rd", None, "Saint Paul", "MN", "55102", None, "USA"),
]

# --- 2. domestic corporation, several filing parties ------------------------
E2 = gid(2)
rows += [
    master(E2, "66", "1000002", 'LAKESIDE HOLDINGS "MN" INC', filed="06/21/2016",
           shares="10000"),
    filing(E2, "66", "1000002", "1000002", "Original Filing", "P", "06/21/2016", "06/21/2016"),
    filing(E2, "66", "1000002", "1000310", "Amendment", "S", "04/02/2021", "04/02/2021"),
    nameaddr(E2, "66", "1000002", "1000002", None, "3", None,
             "200 Example St", None, "Duluth", "MN", "55802", None, "USA"),
    nameaddr(E2, "66", "1000002", "1000002", "12", "14", "Alex Notreal",
             "12 Nowhere Ln", None, "Duluth", "MN", "55802", None, "USA"),
    nameaddr(E2, "66", "1000002", "1000002", "14", "14", "Sam Invented",
             "12 Nowhere Ln", None, "Duluth", "MN", "55802", None, "USA"),
    nameaddr(E2, "66", "1000002", "1000002", "8", "14", "Jamie Hypothetical",
             "44 Made Up Blvd", None, "Duluth", "MN", "55805", None, "USA"),
]

# --- 3. foreign LLC whose COMPACT name collides with E1 ---------------------
E3 = gid(3)
rows += [
    master(E3, "46", "1000003", "NORTHSTAR HOMES LLC", filed="09/12/2021",
           home_juris="Delaware", statute="322C",
           home_name="Northstar Homes, L.L.C."),
    filing(E3, "46", "1000003", "1000003", "Original Filing", "P", "09/12/2021", "09/12/2021"),
    nameaddr(E3, "46", "1000003", "1000003", None, "2", None,
             "9 Placeholder Way", None, "Bloomington", "MN", "55420", None, "USA"),
]

# --- 4. dissolved domestic corporation --------------------------------------
E4 = gid(4)
rows += [
    master(E4, "66", "1000004", "SUNSET PROPERTIES CORP", status="Inactive",
           filed="02/02/2010", expires="11/30/2023"),
    filing(E4, "66", "1000004", "1000004", "Original Filing", "P", "02/02/2010", "02/02/2010"),
    filing(E4, "66", "1000004", "1000512", "Dissolution", "S", "11/30/2023", "11/30/2023"),
    nameaddr(E4, "66", "1000004", "1000004", None, "2", None,
             "77 Vanished Ct", None, "Rochester", "MN", "55901", None, "USA"),
]

# --- 5. name change: the FILING says so, the delivery carries no prior name --
E5 = gid(5)
rows += [
    master(E5, "44", "1000005", "RIVERBEND VENTURES LLC", filed="05/05/2018"),
    filing(E5, "44", "1000005", "1000005", "Original Filing", "P", "05/05/2018", "05/05/2018"),
    filing(E5, "44", "1000005", "1000600", "Name Change", "S", "07/18/2024", "07/18/2024"),
    nameaddr(E5, "44", "1000005", "1000005", None, "2", None,
             "410 Fabricated Dr", None, "Minneapolis", "MN", "55408", None, "USA"),
]

# --- 6. address changes between deliveries (see the 2026-09 file) -----------
E6 = gid(6)
E6_AUG = nameaddr(E6, "44", "1000006", "1000006", None, "2", None,
                  "8 Old Notional St", None, "Edina", "MN", "55424", None, "USA")
E6_SEP = nameaddr(E6, "44", "1000006", "1000006", None, "2", None,
                  "9000 New Notional Pkwy", "Floor 3", "Edina", "MN", "55435", None, "USA")
rows += [
    master(E6, "44", "1000006", "PRAIRIE GATE PROPERTIES LLC", filed="10/10/2017"),
    filing(E6, "44", "1000006", "1000006", "Original Filing", "P", "10/10/2017", "10/10/2017"),
    E6_AUG,
]

# --- 7/8. two DIFFERENT entities sharing one normalized legal name ----------
E7, E8 = gid(7), gid(8)
rows += [
    master(E7, "44", "1000007", "SUMMIT PARTNERS LLC", filed="01/20/2015"),
    filing(E7, "44", "1000007", "1000007", "Original Filing", "P", "01/20/2015", "01/20/2015"),
    nameaddr(E7, "44", "1000007", "1000007", None, "2", None,
             "1 Duplicate Name Rd", None, "Saint Cloud", "MN", "56301", None, "USA"),
    master(E8, "66", "1000008", "Summit Partners, Inc.", filed="08/08/2008"),
    filing(E8, "66", "1000008", "1000008", "Original Filing", "P", "08/08/2008", "08/08/2008"),
    nameaddr(E8, "66", "1000008", "1000008", None, "2", None,
             "2 Duplicate Name Rd", None, "Saint Cloud", "MN", "56301", None, "USA"),
]
# E8 is deliberately punctuated differently and carries a DIFFERENT suffix, so
# the normalizer must keep them apart. A second true collision is added below.
E7B = gid(17)
rows += [
    master(E7B, "44", "1000017", "Summit Partners L.L.C.", filed="04/04/2022"),
    filing(E7B, "44", "1000017", "1000017", "Original Filing", "P", "04/04/2022", "04/04/2022"),
    nameaddr(E7B, "44", "1000017", "1000017", None, "2", None,
             "3 Duplicate Name Rd", None, "Saint Cloud", "MN", "56301", None, "USA"),
]

# --- 9/10. two entities at ONE address (a registered-agent service) ---------
E9, E10 = gid(9), gid(10)
SHARED = ("500 Agent Services Plz", "Ste 1000", "Minneapolis", "MN", "55402")
rows += [
    master(E9, "44", "1000009", "CEDAR HOLLOW HOLDINGS LLC", filed="02/11/2020"),
    filing(E9, "44", "1000009", "1000009", "Original Filing", "P", "02/11/2020", "02/11/2020"),
    nameaddr(E9, "44", "1000009", "1000009", None, "3", None, *SHARED, None, "USA"),
    master(E10, "44", "1000010", "BIRCH LANE CAPITAL LLC", filed="02/12/2020"),
    filing(E10, "44", "1000010", "1000010", "Original Filing", "P", "02/12/2020", "02/12/2020"),
    nameaddr(E10, "44", "1000010", "1000010", None, "3", None, *SHARED, None, "USA"),
]

# --- 11. an assumed name: its OWN master row, with no parent link -----------
E11 = gid(11)
rows += [
    master(E11, "59", "1000011", "THE HOMES AT SUMMIT", filed="03/01/2023",
           expires="12/31/2033"),
    filing(E11, "59", "1000011", "1000011", "Original Filing", "P", "03/01/2023", "03/01/2023"),
    nameaddr(E11, "59", "1000011", "1000011", None, "11", None,
             "1 Duplicate Name Rd", None, "Saint Cloud", "MN", "56301", None, "USA"),
]

# --- 12. an assumed name colliding with a real entity's legal name ----------
E12 = gid(12)
rows += [
    master(E12, "59", "1000012", "RIVERBEND VENTURES LLC", filed="06/06/2024"),
    filing(E12, "59", "1000012", "1000012", "Original Filing", "P", "06/06/2024", "06/06/2024"),
]

# --- 13. unknown domain codes: business type, name type, address type -------
E13 = gid(13)
rows += [
    master(E13, "99", "1000013", "UNCLASSIFIED REGISTRATION ENTITY", filed="01/01/2026"),
    nameaddr(E13, "99", "1000013", "1000013", "77", "888", "Pat Unknownrole",
             "5 Unlisted Code Ave", None, "Mankato", "MN", "56001", None, "USA"),
]

# --- 14. a trademark: a row in the same file that is not a company ----------
E14 = gid(14)
rows += [
    master(E14, "57", "1000014", "NORTH STAR HOMES", filed="05/01/2021",
           mark_type="Trademark", mark_first_use="01/01/2019", mark_class="036"),
]

# --- 15. a foreign entity whose HOME name equals another entity's legal name -
E15 = gid(15)
rows += [
    master(E15, "43", "1000015", "CEDAR HOLLOW HOLDINGS OF IOWA INC", filed="07/07/2022",
           home_juris="Iowa", home_name="Cedar Hollow Holdings LLC"),
    filing(E15, "43", "1000015", "1000015", "Original Filing", "P", "07/07/2022", "07/07/2022"),
]

# --- 16. an entity whose address line carries an embedded newline -----------
E16 = gid(16)
rows += [
    master(E16, "44", "1000016", "MULTILINE ADDRESS LLC", filed="09/09/2023"),
    nameaddr(E16, "44", "1000016", "1000016", None, "2", None,
             "12 Wrapped\nLine Rd", None, "Wayzata", "MN", "55391", None, "USA"),
]

# --- 18. the one name BOTH county sources already mention -------------------
# eCRV and the Hennepin assessor fixtures each observe "SYNTHETIC HOLDINGS LLC".
# Registering it here is what makes cross-source convergence testable: two
# independent county observations, one candidate registration.
E18 = gid(18)
rows += [
    master(E18, "44", "1000018", "SYNTHETIC HOLDINGS LLC", filed="11/11/2014"),
    filing(E18, "44", "1000018", "1000018", "Original Filing", "P", "11/11/2014", "11/11/2014"),
    nameaddr(E18, "44", "1000018", "1000018", None, "2", None,
             "3120 Fabricated Pkwy", None, "Minneapolis", "MN", "55416", None, "USA"),
    nameaddr(E18, "44", "1000018", "1000018", "4", "14", "Morgan Imaginary",
             "3120 Fabricated Pkwy", None, "Minneapolis", "MN", "55416", None, "USA"),
]

# --- orphans: rows whose master row is absent from the delivery -------------
ORPHAN_FILING = gid(900)
ORPHAN_PARTY = gid(901)
rows += [
    filing(ORPHAN_FILING, "44", "1000900", "1000900", "Amendment", "S", "01/01/2025", "01/01/2025"),
    nameaddr(ORPHAN_PARTY, "44", "1000901", "1000901", "4", "14", "Casey Orphaned",
             "3 Detached Way", None, "Duluth", "MN", "55802", None, "USA"),
]


def csv_lines(rowset):
    return [",".join(q(c) for c in r) for r in rowset]


def write_bundle(path, rowset, manifest=MANIFEST, seed=None):
    ordered = list(rowset)
    if seed is not None:
        random.Random(seed).shuffle(ordered)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(manifest, separators=(",", ":")) + "\n")
        for line in csv_lines(ordered):
            fh.write(line + "\n")


# The MALFORMED row is appended as raw text: it is short by design, so it cannot
# be produced by the row builders above.
def write_with_malformed(path, rowset, seed):
    write_bundle(path, rowset, seed=seed)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write('"' + gid(902) + '","01","44"\n')


write_with_malformed(os.path.join(HERE, "register-2026-08.bundle"), rows, seed=7)

# The same delivery, rows in a different order. Canonical output must be
# byte-identical: the register is a set of facts, not a sequence of lines.
write_with_malformed(os.path.join(HERE, "register-2026-08-shuffled.bundle"), rows, seed=99)

# September: E6 moved, E4 stayed dissolved, and E13 is gone from the register.
sept_manifest = dict(MANIFEST)
sept_manifest["fileGeneratedAt"] = "2026-09-01T00:00:00.000Z"
sept_manifest["obtainedAt"] = "2026-09-02T00:00:00.000Z"
sept_rows = [r for r in rows if not (r[0] == E6 and r[1] == "03") and r[0] != E13]
sept_rows.append(E6_SEP)
write_bundle(os.path.join(HERE, "register-2026-09.bundle"), sept_rows,
             manifest=sept_manifest, seed=13)

# A delivery whose implementation-guide version has moved. Must quarantine.
drift_manifest = dict(MANIFEST)
drift_manifest["implementationGuideVersion"] = "mbls-business-bulk-data-implementation-guide/2027-01-01"
write_bundle(os.path.join(HERE, "fault-guide-version-drift.bundle"), rows[:6],
             manifest=drift_manifest, seed=1)

# A delivery whose licence does not permit serving customers. Must quarantine
# BEFORE any row is read: unusable bytes must not enter the estate.
lic_manifest = json.loads(json.dumps(MANIFEST))
lic_manifest["license"]["mayServeCustomers"] = False
write_bundle(os.path.join(HERE, "fault-license-not-permitted.bundle"), rows[:6],
             manifest=lic_manifest, seed=2)

print("wrote fixtures to", HERE)
