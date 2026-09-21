#!/usr/bin/env bash
# Capture one frame of each event for review.
#
# The browse daemon owns a single shared tab, so this is deliberately sequential.
# Run it from the repo root with the dev server already up on :5273.
#
#   ./scripts/capture.sh              # all events
#   ./scripts/capture.sh surfing bmx  # just these
set -uo pipefail

B="${B:-$HOME/.claude/skills/gstack/browse/dist/browse}"
URL="${URL:-http://localhost:5273}"
OUT="${OUT:-captures}"
SETTLE_MS="${SETTLE_MS:-2600}"

EVENTS=("$@")
if [ ${#EVENTS[@]} -eq 0 ]; then
  EVENTS=(halfpipe surfing bmx skating footbag flyingdisc menu)
fi

mkdir -p "$OUT"
"$B" viewport 1920x1080 >/dev/null 2>&1

for ev in "${EVENTS[@]}"; do
  "$B" goto "$URL/?scene=$ev" >/dev/null 2>&1
  # Let the scene boot, mute it, then give it time to reach a representative
  # moment: a still of frame zero shows a game that has not started yet.
  "$B" js "new Promise(r=>setTimeout(()=>{try{window.__cg.mute(true)}catch(e){}r(1)},400))" >/dev/null 2>&1
  "$B" js "new Promise(r=>setTimeout(()=>r(1),$SETTLE_MS))" >/dev/null 2>&1
  "$B" screenshot "$OUT/$ev.png" >/dev/null 2>&1
  state=$("$B" js "JSON.stringify(window.__cg.state())" 2>/dev/null | tail -2 | head -1)
  size=$(stat -f%z "$OUT/$ev.png" 2>/dev/null || echo 0)
  printf '%-12s %8s bytes  %s\n' "$ev" "$size" "${state:-no state}"
done
