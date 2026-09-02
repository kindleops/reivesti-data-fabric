#!/bin/sh
# The DF-0I scale ladder.
#
# Streams synthetic deliveries of the real Minnesota statewide schema, end to
# end, under a 1 GB heap. Synthetic because the point is the shape of the memory
# curve at sizes no real Minnesota delivery reaches, and inventing 5.5 million
# rows is cheaper and safer than copying them.
#
# Usage:  SCRATCH=/some/dir sh tools/scale-ladder.sh [rows ...]
set -u
SCRATCH="${SCRATCH:-./var/ladder}"
LAYER=fixtures/mn-statewide/layer-fields.json
ROWS="${*:-5000 50000 500000 2700000 5500000}"

mkdir -p "$SCRATCH"
for n in $ROWS; do
  bundle="$SCRATCH/syn-$n.bundle"
  [ -f "$bundle" ] || node --no-warnings tools/synthbundle.ts "$bundle" "$n" "$LAYER"
  rm -rf "$SCRATCH/var"
  DF_VAR="$SCRATCH/var" /usr/bin/time -l node --no-warnings --max-old-space-size=1024 \
    src/cli/df.ts stream mn_statewide_parcels__opt_in_counties \
    --file "$bundle" --period "ladder-$n" > "$SCRATCH/run-$n.json" 2> "$SCRATCH/run-$n.time"
  rc=$?
  rss=$(awk '/maximum resident set size/ {print int($1/1048576)}' "$SCRATCH/run-$n.time")
  peak=$(sed -n 's/.*"peakHeapMB": *\([0-9]*\).*/\1/p' "$SCRATCH/run-$n.json" | tail -1)
  echo "$n rc=$rc peakHeapMB=$peak maxRSSMB=$rss"
done
rm -rf "$SCRATCH/var"
