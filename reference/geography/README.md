# Pinned federal geography

The jurisdiction registry is **built from these files**, not from a remembered
county count, and both are verified by sha256 at load. If a file changes, the
registry refuses to load rather than quietly producing a different country.

| File | Authority | Product | Retrieved | sha256 |
|---|---|---|---|---|
| `2025_Gaz_counties_national.txt` | U.S. Census Bureau | 2025 Gazetteer Files — Counties (national) | 2026-08-31 | `1914f0d83243362de83b8ddd298c213b1768d63d62d19464743289abd8bb35b1` |
| `national_county2020.txt` | U.S. Census Bureau | 2020 national county and county-equivalent codes | 2026-08-31 | `9f6e5f6eb6ac2f5e9a36d5fd01dec77991bddc75118f748a069441a4782970d6` |

Sources:
- https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_counties_national.zip
- https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt

Two files rather than one, deliberately. The 2025 Gazetteer is the **current**
geography — everything in it is active, and it is where Connecticut's nine
planning regions appear. The 2020 codes file additionally carries the legal CLASS
code and the island areas, and comparing the two is what makes the *changes*
visible: eight retired Connecticut counties, and fourteen island-area entries
outside the newer product's scope.

Public-domain U.S. federal government data. No personal information, no licence
restriction. Committed because a registry built from an unpinned download is a
registry nobody can reproduce.

To re-pin, change `GEOGRAPHY_PROVENANCE` in `src/registry/us-geography.ts`
deliberately — never silently.
