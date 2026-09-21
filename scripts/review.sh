#!/usr/bin/env bash
# Capture every event and build a blind A/B sheet for each against the bar.
#
# The sheets in review/ are what a critic sees: two frames, labelled only A and B,
# with ours randomised into one side. The .key.json files say which is which and
# must never be shown to a critic.
#
#   ./scripts/review.sh              # all events
#   ./scripts/review.sh surfing bmx  # just these
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SP=/private/tmp/claude-501/-Users-julien-Documents-Prive-Software-Claude-Projects-claude-games/c28fa9a4-11da-4ee1-b4a7-5122ab8268a2/scratchpad
PY="${PY:-$SP/venv/bin/python}"
cd "$ROOT"

EVENTS=("$@")
if [ ${#EVENTS[@]} -eq 0 ]; then
  EVENTS=(halfpipe surfing bmx skating footbag flyingdisc)
fi

# Which bar each event is judged against. Water and open landscape go to Alto's
# for atmosphere; everything with a rider and hard-edged terrain goes to OlliOlli.
# The STRONGEST frame each bar has, not a random draw from the folder.
#
# A random draw once served a deliberately washed-out reference, we won, and the
# win had to be thrown out as a soft draw. It has also served UI dialogue
# screens, which are not comparable to a gameplay frame at all. A bar that can
# be got lucky against is not a bar.
#
# These two are the measured best of their sets and the calibration frames
# quoted throughout ENGINE.md (0.283 / 0.495 / 0.161).
OLLI="refs/olliolli/olliolli-grind-rail-pink-sunset-13.png"
ALTOS="refs/altos/altos-odyssey-dunes-sunset-backlit-palms-03.png"
ref_glob() {
  case "$1" in
    surfing|flyingdisc) echo "$ALTOS" ;;
    *)                  echo "$OLLI" ;;
  esac
}

# Capture only when asked. This used to always run capture.sh, which has no
# scene verification, no failure-state gate and no best-of-N selection — so
# building a review sheet silently replaced verified frames with ungated ones.
# Default is now to judge exactly the frames that are on disk.
#
#   ./scripts/review.sh                 # sheets from existing captures
#   RECAPTURE=1 ./scripts/review.sh     # re-capture first, through capture-best
if [ "${RECAPTURE:-0}" = "1" ]; then
  N="${N:-3}" ./scripts/capture-best.sh "${EVENTS[@]}" || {
    echo "capture failed; refusing to build sheets from unverified frames" >&2
    exit 1
  }
fi
echo
mkdir -p review

for ev in "${EVENTS[@]}"; do
  [ -f "captures/$ev.png" ] || { echo "$ev: no capture, skipped"; continue; }
  # shellcheck disable=SC2046
  "$PY" scripts/blind_ab.py \
    --ours "captures/$ev.png" \
    --ref $(ref_glob "$ev") \
    --out "review/$ev-ab.png" \
    --key "review/$ev.key.json" >/dev/null 2>&1 \
    && echo "review/$ev-ab.png  ready" \
    || echo "review/$ev-ab.png  FAILED"
done

echo
echo "Answer keys (do not show a critic):"
for ev in "${EVENTS[@]}"; do
  [ -f "review/$ev.key.json" ] || continue
  a=$("$PY" -c "import json,sys;print(json.load(open('review/$ev.key.json'))['A'])")
  r=$("$PY" -c "import json,sys;print(json.load(open('review/$ev.key.json'))['reference_path'].split('/')[-1])")
  printf '  %-12s A=%-10s vs %s\n' "$ev" "$a" "$r"
done
