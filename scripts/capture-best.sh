#!/usr/bin/env bash
# Capture each event N times at its action peak and keep the strongest frame.
#
# A single capture compared against a curated marketing still is not a fair test:
# the reference is a chosen frame, ours was whatever instant the shutter hit. One
# event won twice and then lost with no code change between, purely on which
# moment got sampled. This samples several and selects on a stated criterion
# (scripts/score_frame.py), which is the same thing a press screenshot does.
#
# Selection is not pure ranking. Ranking on the scorer alone once cost an event a
# win it already held: the top-scoring candidate put the rider on the horizon
# line. score_frame.py sorts candidates that commit a named compositional fault
# last regardless of score, so this picks the best *clean* frame and only falls
# back to a faulted one when every candidate is faulted. Read the flags it prints
# rather than just the number.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SP=/private/tmp/claude-501/-Users-julien-Documents-Prive-Software-Claude-Projects-claude-games/c28fa9a4-11da-4ee1-b4a7-5122ab8268a2/scratchpad
PY="${PY:-$SP/venv/bin/python}"
N="${N:-3}"
cd "$ROOT"

EVENTS=("$@")
[ ${#EVENTS[@]} -eq 0 ] && EVENTS=(halfpipe surfing bmx skating footbag flyingdisc)

mkdir -p captures/candidates

for ev in "${EVENTS[@]}"; do
  # Clear this event's old candidates first. They are timestamped only by mtime,
  # so a stale frame from a previous build sat in the pool and could be selected
  # as "best" — and once was.
  rm -f "captures/candidates/$ev"-*.png
  cands=()
  fails=0
  for i in $(seq 1 "$N"); do
    # Do NOT silence this. A capture that fails its scene check, times out, or
    # never reaches a peak prints the reason; discarding it turned `N=3` into a
    # silent best-of-two, and the frame that survived measured break 0.041 and
    # went to three critics as if it were representative.
    OUT=captures/candidates ./scripts/capture-action.sh "$ev" 2>&1 | sed "s/^/  [$ev $i] /"
    if [ -f "captures/candidates/$ev.png" ]; then
      mv "captures/candidates/$ev.png" "captures/candidates/$ev-$i.png"
      cands+=("captures/candidates/$ev-$i.png")
    else
      fails=$(( fails + 1 ))
    fi
  done
  if [ ${#cands[@]} -eq 0 ]; then
    echo "$ev: NO CANDIDATES — all $N captures failed"
    continue
  fi
  if [ "$fails" -gt 0 ]; then
    printf '%-12s WARNING: only %s of %s captures succeeded\n' "$ev" "${#cands[@]}" "$N"
  fi
  best=$("$PY" scripts/score_frame.py "${cands[@]}" 2>&1 >/dev/null | tail -1)
  line=$("$PY" scripts/score_frame.py "${cands[@]}" 2>/dev/null | head -1)
  cp "$best" "captures/$ev.png"
  printf '%-12s best of %s  %s\n' "$ev" "${#cands[@]}" "$line"
done

# Shut the browser down when we are finished with it.
#
# Headless Chromium has no GPU, so every frame of this game is rasterised on the
# CPU across ~24 threads — measured at 750-800% on the user's machine, and one
# session quietly accumulated ~19 hours of CPU time. Parking the tab on
# about:blank (which capture-action.sh does) drops it to idle, but the process
# still sits there holding memory and waking up.
#
# Captures are rare and bursty and the daemon spawns a fresh browser on next
# use, so the default is to kill it. Set KEEP_BROWSER=1 when running several
# capture batches back to back.
kill_browser() {
  if [ "${KEEP_BROWSER:-0}" = "1" ]; then return 0; fi
  pkill -f "chrome-headless-shell" 2>/dev/null
  sleep 1
  printf 'browser shut down (%s processes left)\n' \
    "$(pgrep -f 'chrome-headless-shell' | wc -l | tr -d ' ')"
}
trap kill_browser EXIT

# Defence in depth against the fault that started all this: a capture that
# rendered a different event's scene. capture-action.sh now verifies the live
# scene id, but two frames of the same scene is cheap to test for and the
# failure is silent by nature — the numbers look fine, they just belong to
# another event. Anything under ~6 mean absolute difference is the same scene.
if [ ${#EVENTS[@]} -gt 1 ]; then
  "$PY" - "${EVENTS[@]}" <<'PYEOF'
import itertools, sys
import numpy as np
from PIL import Image
names = [n for n in sys.argv[1:]]
ims = {}
for n in names:
    try:
        ims[n] = np.asarray(Image.open(f"captures/{n}.png").convert("RGB").resize((240, 135)), dtype=float)
    except OSError:
        pass
dupes = [(a, b, float(np.abs(ims[a] - ims[b]).mean()))
         for a, b in itertools.combinations(sorted(ims), 2)
         if np.abs(ims[a] - ims[b]).mean() < 6]
for a, b, d in dupes:
    print(f"  !! {a} and {b} are the SAME SCENE (mean abs diff {d:.2f}) — one capture is mislabelled")
print("  scenes distinct" if not dupes else "")
sys.exit(1 if dupes else 0)
PYEOF
fi
