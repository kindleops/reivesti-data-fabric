# tools/

Measurement scripts. Not part of the runtime, not imported by it, and not run by
`npm test` — they exist so the numbers in `docs/OFF-HEAP-INDEXING.md` can be
reproduced rather than believed.

| Script | Answers |
|---|---|
| `memprofile.ts` | how many bytes of **heap** each dataset-sized structure retains per row, measured one structure at a time |
| `orgprofile.ts` | what the nation-scoped organization fold costs, since it is the one projection whose input is not partitioned by county |
| `synthbundle.ts` | builds a deterministic synthetic delivery in the real statewide bundle shape, at any row count |
| `scale-ladder.sh` | streams those deliveries end to end under a 1 GB heap and reports peak heap and RSS |
| `estate-state.ts` | captures every partition's and index's files (bytes, mtime, sha256, CURRENT, manifest digests) and diffs two captures — the "zero rewrites" proof |
| `wi-audit.ts` | Wisconsin quality and freshness per county from the retained bundle, and MN↔WI parcel-string reuse via external sort — aggregate output only |
| `ny-audit.ts` | New York completeness per county (min/median/max), quarantine reasons, lineage and roll/spatial years from the retained bundle; a per-parcel leak audit (the derived row against its own owner's mailing-only lines, with a positive control) plus derived key names and restricted file modes; MN/WI/NY parcel-string reuse via external sort, with identifiers extracted per state so an estate can be audited in stages — aggregate output only |

`memprofile.ts` and `orgprofile.ts` need `--expose-gc`: `heapUsed` without a
forced collection measures garbage as well as retention, and a number that can
come out negative cannot tell the two apart.

Every row these scripts generate is invented. They read no source artifact and
no register, and they are the reason the scale proofs do not require committing
real parcel data.
