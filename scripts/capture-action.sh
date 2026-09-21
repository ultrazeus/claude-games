#!/usr/bin/env bash
# Capture each event at the PEAK of its action, not at an arbitrary moment.
#
# The reference frames this game is judged against are marketing screenshots:
# staged at the apex of a trick. Sampling our game at a random instant compares
# our dullest frame to their best one, which is not a fair test and was quietly
# costing us every blind review. A neutral critic put it exactly right:
# "B caught the apex; A caught the roll-in."
#
# So each event is driven to a moment worth screenshotting, then captured.
set -uo pipefail

B="${B:-$HOME/.claude/skills/gstack/browse/dist/browse}"
URL="${URL:-http://localhost:5273}"
OUT="${OUT:-captures}"

EVENTS=("$@")
[ ${#EVENTS[@]} -eq 0 ] && EVENTS=(halfpipe surfing bmx skating footbag flyingdisc)

mkdir -p "$OUT"

# One capture at a time, enforced.
#
# The browse daemon owns a SINGLE shared tab. Several agents run in parallel on
# this project, and checking `pgrep` before launching is a race: it reads clear,
# both start, and then each navigates the tab out from under the other. The
# symptom is quiet — individual captures fail and a `best of 3` silently becomes
# `best of 1`, or a frame lands showing another event's scene entirely.
#
# `mkdir` is atomic, so it is a lock. Stale locks from a killed run are cleared
# after 5 minutes; no run legitimately holds the tab that long.
LOCK="${TMPDIR:-/tmp}/cg-capture.lock"
if [ -d "$LOCK" ]; then
  age=$(( $(date +%s) - $(stat -f%m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -gt 300 ]; then rm -rf "$LOCK"; fi
fi
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ "$waited" -ge 600 ]; then
    echo "another capture has held the browse tab for 10 minutes; giving up" >&2
    exit 1
  fi
  [ "$waited" = 0 ] && echo "waiting for the browse tab (another capture is running)..." >&2
  sleep 5
  waited=$(( waited + 5 ))
done
trap 'rm -rf "$LOCK"' EXIT INT TERM

"$B" viewport 1920x1080 >/dev/null 2>&1

# Per-event driver: run until the scene reports a dramatic state, then stop.
driver_for() {
  case "$1" in
    halfpipe) cat <<'JS'
// Pump the transition, then hold a spin so the capture lands mid-air.
let lastH = 0, down = false, best = null, bestH = -1;
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  const h = st.heightAboveFlat, desc = h < lastH; lastH = h;
  if (st.state === 'air') {
    if (down) { window.__cg.release('ArrowDown'); down = false; }
    window.__cg.hold('ArrowRight');
    if (st.airHeight > bestH) { bestH = st.airHeight; }
    if (st.airHeight > 90) { window.__cg.hold('Space'); }
  } else {
    window.__cg.release('ArrowRight'); window.__cg.release('Space');
    if (desc && h > 40 && !down) { window.__cg.hold('ArrowDown'); down = true; }
    else if (h < 30 && down) { window.__cg.release('ArrowDown'); down = false; }
  }
}, 16);
new Promise(r => {
  // Freeze on a frame where the rider is high and rotating.
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (st && st.state === 'air' && st.airHeight > 110 && st.lastTrick !== 'BAIL' && st.score > 0) {
      clearInterval(watch); clearInterval(iv);
      window.__cg.release('ArrowRight'); window.__cg.release('ArrowDown'); window.__cg.release('Space');
      r('air ' + Math.round(st.airHeight));
    }
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); r('timeout'); }, 34000);
})
JS
    ;;
    bmx) cat <<'JS'
let down = false;
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  window.__cg.hold('ArrowRight');
  if (st.state === 'air') {
    if (down) { window.__cg.release('ArrowDown'); down = false; }
    window.__cg.hold('ArrowLeft');
  } else {
    window.__cg.release('ArrowLeft');
    // Preload whenever the terrain starts rising and release shortly after:
    // gating on lipQuality alone never fired on a gentle course.
    if (st.lipQuality > 0.04 && !down) { window.__cg.hold('ArrowDown'); down = true; }
    else if (down && st.lipQuality < 0.02) { window.__cg.release('ArrowDown'); down = false; }
  }
}, 16);
new Promise(r => {
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (st && st.state === 'air' && st.airHeight > 22 && st.score > 0) {
      clearInterval(watch); clearInterval(iv);
      ['ArrowRight','ArrowLeft','ArrowDown'].forEach(k => window.__cg.release(k));
      r('air ' + Math.round(st.airHeight));
    }
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); r('timeout'); }, 34000);
})
JS
    ;;
    skating) cat <<'JS'
let cleanTicks = 0;
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  cleanTicks = (st.state === 'skate' || st.state === 'air') ? cleanTicks + 1 : 0;
  window.__cg.hold('ArrowRight');
  if (st.state === 'air') window.__cg.hold('ArrowLeft');
  else {
    window.__cg.release('ArrowLeft');
    if (st.nextHazardIn < 150 && st.nextHazardIn > 40) window.__cg.press('Space', 70);
  }
}, 16);
new Promise(r => {
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (st && st.airHeight > 55 && st.state !== 'fall' && st.state !== 'getup' && !st.downCause && cleanTicks > 130 && st.score > 0) {
      clearInterval(watch); clearInterval(iv);
      ['ArrowRight','ArrowLeft'].forEach(k => window.__cg.release(k));
      r('air ' + Math.round(st.airHeight));
    }
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); r('timeout'); }, 34000);
})
JS
    ;;
    surfing) cat <<'JS'
// Steer toward the POCKET, and stop mashing the trick button.
//
// The old driver climbed the face and pressed Space every 90ms. Measured over
// 20s that produced "BLEW THE LANDING" on 55 samples against a clean trick on
// 13, and left the wave hollow (`wavePitch > 0.6`) on only 2 samples in 64 —
// because nothing was steering toward the section that is actually breaking.
// A gate needing hollow AND settled AND scoring, all true at one sampled
// instant, then essentially never fired.
//
// `pocket` is `lineX - breakX`: how far down the line the rider sits from where
// the wave is breaking. Hold it just ahead of the break, which is where a wave
// is steep, and press for a trick only occasionally so landings have time to
// resolve.
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  if (st.faceT < 0.58) window.__cg.hold('ArrowUp'); else window.__cg.release('ArrowUp');
  // Chase the pocket: stay 40-140px ahead of the breaking point.
  if (st.pocket > 140) { window.__cg.release('ArrowRight'); window.__cg.hold('ArrowLeft'); }
  else if (st.pocket < 40) { window.__cg.release('ArrowLeft'); window.__cg.hold('ArrowRight'); }
  else { window.__cg.release('ArrowLeft'); window.__cg.release('ArrowRight'); }
}, 90);
// Trick attempts are rare and deliberate, not a mash.
const tv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  if (st.wavePitch > 0.4 && st.faceT > 0.55) window.__cg.press('Space', 60);
}, 1400);
// The gate used to accept `faceT > 0.72` on ANY wave, which is "riding high"
// and says nothing about the wave's shape. It duly captured a long flat swell
// with no lip, no curl and no foam — so an entire pass rebuilding the lip
// geometry was invisible in the only frame a critic ever saw.
//
// A clean tick is not a dramatic one. The wave has to be HOLLOW: `wavePitch`
// above 0.6 is the same threshold the tube mechanic itself uses, so this asks
// for the state the event is named for. The flat gate survives only as a
// fallback after 24s, and says so, so a weak frame is never mistaken for a
// chosen one.
//
// And it must not be a FAILURE. The first run under the pitch gate captured a
// wipeout — rider inverted, "BLEW THE LANDING" across the frame, SCORE 0.0 —
// and my composite scored it 0.390 against 0.195 for the frame before it,
// because a rider silhouetted against sky measures well. Better number, worse
// picture. `wipeouts` and `lastCall` are both on the debug state and the gate
// simply was not reading them.
// `lastCall` and `wipeouts` are STICKY — they hold their value long after the
// event. Testing them directly as "is a failure on screen right now" is the
// same bug this project already had with `lastHazard`, where a field set on
// every successful clear made the gate false forever after the first one. It
// was written a second time here and the driver duly timed out on every run.
//
// So both are watched for a CHANGE and converted into a decaying window. A
// probe of 25s of driven play measured: maxPitch 1.0, maxFaceT 1.01, maxScore
// 0.14, maxAir 60, tubedTicks 0, and "BLEW THE LANDING" on 55 samples against
// "STALEFISH (SKETCHY)" on 13. The driver blows four landings in five and never
// tubes, so `tubed` is unreachable as a gate and the thresholds below are set
// to what the simulation actually produces rather than to what would be ideal.
const FAIL_CALL = /BLEW|WIPE|BAIL|LOST|SLAM/i;
const CLEAR_MS = 1500;
new Promise(r => {
  const t0 = Date.now();
  let lastBadAt = 0, prevCall = null, prevWipe = null;
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (!st) return;
    if (prevWipe === null) prevWipe = st.wipeouts;
    if (st.wipeouts > prevWipe) { prevWipe = st.wipeouts; lastBadAt = Date.now(); }
    if (st.lastCall !== prevCall) {
      prevCall = st.lastCall;
      if (FAIL_CALL.test(st.lastCall || '')) lastBadAt = Date.now();
    }
    // A peak five seconds into a 75-second run is the roll-in, not the ride.
    // The gate used to accept the first qualifying instant, so every capture
    // read TIME 1:10 and SCORE 0.2/10 — a frame that says "nothing has happened
    // yet" no matter how good the wave looks. Let the run bank some score
    // first: the reference frames are marketing stills of a run in progress.
    const elapsed = Date.now() - t0;
    if (elapsed < 22000) return;
    const settled = Date.now() - lastBadAt > CLEAR_MS;
    if (st.hintUp) return;              // control legend still on screen
    if (!settled || !(st.score > 0.05)) return;
    // The headless tab throttles timers to roughly three samples a second, so a
    // condition true 3% of the time is essentially never observed. These
    // thresholds are set against what the probe actually measured.
    const hollow = st.wavePitch > 0.45;
    const peak = hollow && (st.airHeight > 40 || st.faceT > 0.62);
    const relaxed = elapsed > 40000 && st.wavePitch > 0.3 && st.faceT > 0.5;
    if (peak || relaxed) {
      clearInterval(watch); clearInterval(iv); clearInterval(tv);
      window.__cg.release('ArrowUp'); window.__cg.release('ArrowLeft'); window.__cg.release('ArrowRight');
      window.__cg.freeze(true);
      r((relaxed && !peak ? 'RELAXED ' : '') + 'pitch ' + st.wavePitch
        + ' faceT ' + st.faceT + ' air ' + st.airHeight + ' call ' + (st.lastCall || '-'));
    }
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); clearInterval(tv); r('timeout'); }, 58000);
})
JS
    ;;
    footbag) cat <<'JS'
// Fire on the CONTACT, not on a coincidence.
//
// Nine previous versions of this gate sampled for several conditions being
// true at the same instant — a live rally, a built-up score, no failure text,
// the bag inside a height band, a leg mid-swing. The headless tab throttles
// this watcher to roughly three samples a second, so asking for a narrow band
// on a fast-moving object is asking to observe a coincidence that lasts a few
// hundred milliseconds. Three runs in a row timed out.
//
// `lastPopup` changes at the moment of a struck kick, and at that moment the
// bag is at the foot by definition — which is exactly the frame two critics
// asked for ("put the ball at a genuine foot-height kick", "it is being palmed
// by a mitten hand at head height while the popup says OUTSIDE KICK"). So wait
// for the EVENT and shoot on it, rather than polling for its side effects.
const FAIL_POP = /SHANK|DROP|MISS|BAIL|LOST/i;
const KEY_FOR = { inside: 'Space', outside: 'ShiftLeft', knee: 'ArrowUp', toe: 'ArrowDown' };
let armed = 0;
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  if (!st.contactOpen || !st.openMoves) return;
  const now = Date.now();
  if (now - armed < 90) return;
  const open = String(st.openMoves).split(',').filter(Boolean);
  const pick = open.map(m => KEY_FOR[m]).filter(Boolean)[0];
  if (pick) { window.__cg.press(pick, 60); armed = now; }
}, 25);
new Promise(r => {
  let prevPop = null, lastGood = 0;
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (!st) return;
    if (st.hintUp) { prevPop = st.lastPopup; return; }   // legend still up
    if (prevPop === null) { prevPop = st.lastPopup; return; }
    const pop = st.lastPopup || '';
    const changed = pop !== prevPop;
    prevPop = pop;
    // Detecting the contact is not enough: the watcher is throttled to ~3
    // samples a second, so by the time the popup CHANGE is observed the bag has
    // already flown back to head height (measured: 238 and 180 on the frames
    // this produced). So use the popup as a QUALIFIER, not as the trigger —
    // a recent successful kick means the rally is alive and the caption is
    // honest — and wait for the bag to come back down to the foot, which it
    // does once per cycle and therefore lingers near.
    // 'DROPPED' is a CHAIN callout and lives in `chainPop`, not `lastPopup`.
    // Gating only on the per-kick grade let a frame through with DROPPED across
    // the middle of it while the grade itself read clean.
    if (FAIL_POP.test(st.chainPop || '')) { lastGood = 0; return; }
    if (FAIL_POP.test(pop)) { lastGood = 0; return; }
    if (changed && pop) lastGood = Date.now();
    if (!lastGood || Date.now() - lastGood > 4000) return;
    if (st.bagHeight > 135) return;                        // still up by the hands
    if (st.state !== 'rally' || st.rally < 2 || !(st.score > 0)) return;
    clearInterval(watch); clearInterval(iv);
    r('state ' + st.state + ' rally ' + st.rally + ' score ' + st.score
      + ' pop ' + pop + ' bagH ' + Math.round(st.bagHeight));
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); r('timeout'); }, 80000);
})
JS
    ;;
    flyingdisc) cat <<'JS'
// Throw LONG, on the gauges, not on a stopwatch.
//
// The old driver pressed Space at 400/1100/1800ms and took whatever angle and
// power happened to be under the cursor. A short 15-21m throw is caught about
// two seconds after release, which is inside the window where the receive
// prompt is still fading — so the shutter either caught the control hint or,
// once that was gated out, the CLEAN CATCH result plate. Neither is a beauty
// frame, and requiring `phase === 'flight'` on a throw that short simply never
// fires, so the round ends and the capture lands on the menu.
//
// `angleGauge` and `powerGauge` are on the debug state. Lock a high angle and
// near-full power, and the disc stays airborne long enough that the frame is a
// disc in flight with nothing overlaid. If a throw is spent, phase returns to
// 'done' and this starts another rather than idling until the timeout.
const A = () => window.__cg.press('Space', 60);
let armed = 0;
const iv = setInterval(() => {
  const st = window.__cg.state(); if (!st) return;
  const now = Date.now();
  if (now - armed < 260) return;              // one press per phase, debounced
  if (st.phase === 'ready' || st.phase === 'done') { A(); armed = now; }
  else if (st.phase === 'angle' && st.angleGauge > 0.45 && st.angleGauge < 0.62) { A(); armed = now; }
  else if (st.phase === 'power' && st.powerGauge > 0.88) { A(); armed = now; }
}, 16);
let flyingSince = 0;
new Promise(r => {
  const watch = setInterval(() => {
    const st = window.__cg.state();
    if (!st || st.phase !== 'flight' || !st.disc || !st.disc.flying) return;
    // Not the first throw. On throw 1 of 5 every readout is still zero —
    // "THROW 1/5, SCORE 00000" — and nothing reads worse in a review than
    // instrumentation at rest. Let a couple of throws land first so the board
    // shows a run in progress, which is what a marketing still shows.
    if (st.throwIndex < 2 || !(st.score > 0)) return;
    // Game time, not wall clock. The prompt fades over `1.6 - phaseTime`, and
    // under software rendering wall-clock seconds buy far less simulation than
    // they should — which is why two of three captures used to time out.
    if (!(st.phaseTime > 1.8)) return;
    if (st.disc.z > 16) {
      clearInterval(watch); clearInterval(iv);
      window.__cg.freeze(true);
      r('phase ' + st.phase + ' z ' + Math.round(st.disc.z)
        + ' throw ' + st.throwIndex + ' score ' + st.score
        + ' spd ' + st.lockedSpeed + ' ang ' + st.lockedAngleDeg);
    }
  }, 16);
  setTimeout(() => { clearInterval(watch); clearInterval(iv); r('timeout'); }, 75000);
})
JS
    ;;
    *) echo "new Promise(r=>setTimeout(()=>r('no driver'),2000))" ;;
  esac
}

# Every event now draws a control legend for its first ~11 seconds, and every
# driver waits for `hintUp` to clear before the shutter opens. Four events had
# no legend at all until now; the two that did cost three blind reviews between
# them, because a gate that waits on a wall clock buys far less game time than
# it looks like under software rendering. `hintUp` is on the debug state, so the
# gate asks the game directly instead of guessing.

# Verify the page is actually showing the event we asked for.
#
# It was not, once, and nothing complained: a Roller Skating capture rendered
# the Foot Bag scene, and the two frames scored identically to three decimals
# because they *were* the same scene. That reads as "skating improved from 0.262
# to 0.415" — a plausible number, not an error, which is how every other
# measurement fault in this project has presented. `__cg.scene()` returns the
# live scene id, so there is no excuse for not asking.
scene_is() {
  "$B" js "window.__cg && window.__cg.scene ? window.__cg.scene() : 'none'" 2>/dev/null \
    | tr -d '"' | tr -d '[:space:]'
}

fail=0
for ev in "${EVENTS[@]}"; do
  "$B" goto "$URL/?scene=$ev" >/dev/null 2>&1
  "$B" js "new Promise(r=>setTimeout(()=>{try{window.__cg.mute(true)}catch(e){}r(1)},700))" >/dev/null 2>&1

  # The query param is a request, not a guarantee. Drive the switch directly if
  # the router did not take, and give it a moment to build.
  if [ "$(scene_is)" != "$ev" ]; then
    "$B" js "new Promise(r=>{try{window.__cg.goto('$ev')}catch(e){};setTimeout(()=>r(1),900)})" >/dev/null 2>&1
  fi
  before=$(scene_is)
  if [ "$before" != "$ev" ]; then
    printf '%-12s %8s        SCENE MISMATCH before driver: showing %s\n' "$ev" "-" "${before:-?}"
    rm -f "$OUT/$ev.png"
    fail=1
    continue
  fi

  # Hide the control legends for the shot.
  #
  # They used to auto-hide after nine seconds and every driver waited for
  # `hintUp` to clear. That was wrong for the player — the first person to play
  # the game said so immediately: a legend you cannot look up once it has gone
  # is useless. They are persistent now, so the capture turns them off
  # explicitly. This is also strictly more reliable than waiting: no wall-clock
  # guess, no game-time conversion, nothing to race.
  "$B" js "window.__cg.hints(false); 1" >/dev/null 2>&1

  note=$("$B" js "$(driver_for "$ev")" 2>/dev/null | tail -2 | head -1 | tr -d '"')

  # The drivers freeze the simulation THEMSELVES, in the same tick they decide.
  #
  # Freezing from out here was still a separate round-trip — the gate approved a
  # frame, this script then spent hundreds of ms asking the page to stop, and the
  # bag dropped inside that window. A frame chosen on a clean rally kept arriving
  # with DROPPED across it. The decision and the freeze have to be the same tick;
  # only the screenshot may be a round-trip. This is a belt-and-braces repeat for
  # any driver that has not been updated.
  "$B" js "window.__cg.freeze(true); 1" >/dev/null 2>&1

  # And again afterwards: a driver can bail out to the menu or advance to a
  # results screen, and the shutter would happily photograph either.
  after=$(scene_is)
  if [ "$after" != "$ev" ]; then
    printf '%-12s %8s        SCENE MISMATCH after driver: ended on %s\n' "$ev" "-" "${after:-?}"
    rm -f "$OUT/$ev.png"
    fail=1
    continue
  fi

  # A driver that timed out never reached its dramatic state. The shutter used
  # to fire anyway, which is how a Foot Bag frame reading SCORE 0 / RALLY 0 /
  # BEST 0 with every meter empty went to a critic — under a gate that requires
  # `score > 0`. The gate was right; the timeout path went around it. Failing
  # loudly here is better than a resting frame with a plausible filename.
  # An EMPTY note means the driver's JS returned nothing parseable — it threw,
  # or the state shape changed under it. Either way nothing verified that the
  # scene reached its peak, and capturing regardless is how an unverified frame
  # acquires a trustworthy filename. Treat it exactly like a timeout.
  case "$note" in
    ""|*timeout*|*"no driver"*)
      printf '%-12s %8s        DRIVER TIMEOUT, no peak reached: %s\n' "$ev" "-" "$note"
      rm -f "$OUT/$ev.png"
      fail=1
      continue
      ;;
  esac

  "$B" screenshot "$OUT/$ev.png" >/dev/null 2>&1
  "$B" js "window.__cg.freeze(false); 1" >/dev/null 2>&1
  size=$(stat -f%z "$OUT/$ev.png" 2>/dev/null || echo 0)
  printf '%-12s %8s bytes  %s\n' "$ev" "$size" "${note:-?}"
done

# Park the tab. Headless Chromium has no GPU, so WebGL runs on SwiftShader —
# software rasterisation across ~24 threads. A capture leaves the tab sitting on
# a live 1920x1080 scene, and PixiJS keeps rendering it at full rate forever
# with nothing watching: measured at 750-800% CPU, and one session accumulated
# nearly 16 hours of CPU time that way. Every capture used to leave another one
# running. about:blank costs nothing and the next run navigates anyway.
"$B" goto "about:blank" >/dev/null 2>&1

exit $fail
