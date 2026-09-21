# California Games — remaster

A browser remaster of California Games (Epyx, 1987). Six events, PixiJS v8 +
TypeScript + Vite. `npm run dev` serves on **:5273**.

The parent `CLAUDE.md` still applies (use gstack `/browse` for web; never the
`mcp__claude-in-chrome__*` tools).

## Read first

- **`ENGINE.md`** — the builder contract. Scene lifecycle, the fixed-timestep
  rule, performance budgets, the art direction findings, and a long section on
  measurement faults. Read it before changing any event's rendering.
- **`SOURCE-NOTES.md`** — what the 1987 original actually does.
- **`README.md`** — the public-facing readme for the GitHub repo.

## Shape

```
src/core/       App, Loop, Input, Audio, Perf, Scene    — shared engine
src/render/     Palette, Hud, Gradient, Staging          — shared drawing
src/game/ui/    Menu, Results (the shared between-event judges screen)
src/game/events/<event>/                                 — one dir per event
scripts/        capture-action.sh, capture-best.sh, score_frame.py, review.sh
```

`src/game/registry.ts` is the only file that imports every event. An event owns
its directory plus its entry in `src/render/Palette.ts`, and nothing else.

`src/render/Hud.ts` is **shared by all six events — do not edit it for one
event's needs.** `themeFor(pal)` derives every plate from that event's own
palette, so per-event adjustment happens through the palette, not the widget.

## Rules that cost real time to learn

**Simulation is fixed-step; rendering interpolates.** `update(dt)` is always
exactly 1/60. `render(alpha)` positions only and allocates nothing. A camera
damped in `render()` against a hardcoded 1/60 converged five times too slowly
under software rendering — camera is simulation state.

**Verify rendering against rendered pixels, never a proxy.** Three separate
"the rig is fixed" reports were produced on offline rasterisers and immediately
contradicted by a reviewer. Rasterisers model paths; they do not model what Pixi
draws — a `fill()` closing across a wrist, a stroke contributed by a
*neighbouring* part, even-odd filling turning overlapping triangles into holes,
caps that do not exist. **Crop the real capture at 8–18× and look.** An offline
model is fine for *arithmetic* (one pass predicted `spread 0.470 / dead 0.216`
and measured 0.467 / 0.218) and wrong for *geometry*.

**A number that looks like progress is when to check hardest.** Eight
measurement faults in this project; every one produced a plausible number rather
than an error. A scorer that measured a shadow instead of the player. A frame
saved under the wrong event's filename. `value_spread` comparing our
HUD-bearing frames against HUD-less reference stills. Read `score_frame.py`'s
header before quoting anything it prints, and always check the `subject_at`
centroid actually lands on the athlete.

**The capture gate is harder than it looks.** Eleven fixes. Seven had nothing to
do with legality — the frame passed every state check and still showed the wrong
thing: a wipeout, a result plate, two tutorial bars, a drop, a bag at head
height under a foot-kick caption. Two rules that emerged:

- *Gate on game state, not wall clock.* The headless tab throttles timers to
  ~3 samples/sec and the simulation advances far slower than the clock.
- *Freeze before shooting, inside the driver.* The gate and the screenshot are
  separate round-trips; the game keeps running between them. `window.__cg.freeze(true)`
  must be called in the same tick as the decision, or the frame judged is not
  the frame chosen.

**A flag meaning "X happened" is not "X is on screen."** Callouts outlive their
causes. `state === 'rally'` was true while the previous drop's DROPPED text was
still fading. Check what is *drawn*.

**A control legend must name the key that is actually bound.** Foot Bag's hint
read `A INSIDE  B OUTSIDE  UP KNEE  DOWN TOE`. `A` and `B` were gamepad face
buttons, sat in a row beside two real keyboard keys, and in `Input.ts` `KeyA` is
WASD-left while `KeyB` was bound to nothing — so the legend told the player to
press a key that walked them away and a key that did nothing. It typechecked, it
rendered, it captured cleanly, and the automated player drove `Action.A`
directly so it never went near the map. Only a human pressing the printed keys
found it. When you add or relabel a hint, follow the label through `KEY_MAP` to
the action and back.

**And it must name the action in words the player already has.** Surfing's read
`RIGHT DRIVE  UP/DOWN CARVE  LEFT CUT BACK  SPACE PUMP/LAUNCH` — four terms of
art in a row, on the event whose controls are least guessable. A player: "what
is carve and cut back in surfing? not clear." Every key was correctly bound, so
the earlier rule would have passed it. A legend teaches the action; jargon
belongs in the scoring call-outs (`CUTBACK`, `ROUNDHOUSE`, `TUBE`), where it
reads as flavour instead of as instructions.

**Check the thing is on screen before you redraw it.** A player reported the
Roller Skating banana as "some kind of stain". It was: `buildHazardArt` returns
`{ node, a, b }`, and its last line is `node.addChild(shadow, g)` — the animated
`a`/`b` parts are never adopted. The dog renders because its case parents its
own parts and returns early. Banana and beach ball build theirs into a
standalone holder, assign it to `a`, and it goes nowhere. **Both hazards drew
their ground shadow and nothing else** — a dark ellipse on the deck, which is
precisely a stain. I redrew the banana first, and the redraw was not the fix.

Audited afterwards: the "build parts into a struct and let the caller parent
them" shape exists **only** in `Boardwalk.ts` (`partA`/`partB`, the two
`return { node, a, b }` sites). Every other scene parents its art where it
creates it, so the bug class is contained — no need to re-audit. Note the first
heuristic sweep I ran returned zero candidates and was worthless: it counted
`a = holder` as "handed off", so it would have passed this very bug. Search for
the shape, not for a smell.

**An inspection helper that assembles differently from the real path will hide
the bug you are hunting.** The `skatingShow` handle written to check that
redraw did `holder.addChild(node); if (a) holder.addChild(a)` — it adopted the
orphan. So the prop rendered perfectly in isolation while being invisible in
play, and the tool built to verify the fix was the reason the real fault stayed
hidden for another round. An inspector must use the *same* assembly the game
uses, or it is testing something the player never sees.

**`??` does not defend against a computed zero, and Web Audio throws on one.**
`exponentialRampToValueAtTime` rejects a target of 0. BMX's landing thud is
`clamp01(impact / 1500) * 0.2`, and `impact` is velocity *into* the surface —
so a landing that matches the slope, the good one, computes zero and
`AudioBus.noise` took the whole game loop down with it. `spec.gain ?? 0.25`
defaults on null and undefined, never on a real 0. Both `tone` and `noise` now
return early below `MIN_GAIN`: a request for silence is not an error.

The reason it survived 65 reviews is worth more than the bug. **Every automated
capture ran muted, and `tone`/`noise` return early when muted** — the entire
code path was unreachable to the rig that reviewed this game. A test harness
that disables a subsystem cannot find bugs in it, and will report success
loudly while doing so.

**HUD values must be anchored to the edge they must not cross.** `Readout` put
its value at a hard `y = 30`, top-anchored, in a fixed 74px plate. Fine at the
34px default; four events ask for 36 and 40, and those overflowed the bottom
border. A player caught it across two events and asked the right question —
"check in every game if the dynamic numbers are placed into the boxes". The
value is now bottom-anchored with a fixed inset (it cannot overflow at any
size) and the plate height follows the value size. **`__cg.hudAudit()` answers
that question properly**: it walks the live scene graph and reports, per
readout, how far the value's real bounds fall outside its plate. Run it per
scene rather than eyeballing screenshots — six events, 23 readouts, and the eye
will miss one.

**Read the reference for what the geometry *is*, not just how it is lit.** BMX
drew the log revetment starting at the riding line, so the logs began under the
tyres and ran 124px down. Every lighting rule in this project was satisfied —
strata, terminator, value bands — and it still read as a fence with a bike
balanced on it. A player: "why does BMX ride over a seemingly narrow trail?"
The C64 original is a *banked track*: the logs are a retaining wall at its edge
and a wide dirt deck sits on top, which is the surface you ride. The deck was
simply missing. It is now `DECK` (84px) carved out of the top of the band, in
the brightest dirt tones because it is the one surface square to a low sun.

The first attempt used 52px, which was right in proportion to the log band and
still wrong in the frame — the deck was 11% of the berm's visible height
against roughly half in the original. Measure the reference's proportions
against *what fills the screen*, not against the component you are editing.

**A colour is only legible in the context it was mixed for.** `t.label` is
`mix(paperWhite, plate, 0.42)` — mixed *towards the plate*, so it reads on one
and nowhere else. Surfing's end prompts were set bare over sand and all but
vanished. If you place HUD text off its plate, re-pick the colour or bring a
plate with it.

## What the source actually says

Verified against c64-wiki, quoted rather than remembered. Three of these were
wrong in this repo until late, and one is still wrong.

- **Run length is 90 seconds**, not the 1:15 that was here by guesswork. Quoted
  for Half Pipe, Surfing and Foot Bag.
- **Three falls ends the run — but not everywhere.** Half Pipe: "when you fall
  off the board 3 times, the game is early over." Surfing: "after three falls
  from the board the discipline will end prematurely." **Foot Bag is explicitly
  exempt**: "the ball can fall to the floor endlessly, this discipline doesn't
  stop prematurely." Skating and BMX are ours — the source says nothing.
- **Flying Disc is 3 throws**, not 5.
- **There is no per-event jury in California Games.** The word "judge" does not
  appear in the source at all, and Surfing is scored on points like everything
  else ("the more tricks, the more points"). The row of judges under the palms
  is the **between-event results screen**: "after the end of the event, the
  statement who has won is made. Position 1 counts 5 points, position 2 3
  points, and position 3 one point." Its banner shows the player's *sponsor*,
  which is why it names no event.

The general rule, learned twice here: **go to the source text, not to a summary
of it — including your own.** `SOURCE-NOTES.md` claimed Surfing was "judged as a
score out of 10"; the source says points. A note written from reference images
at the start of a project is a memory, and it decays like one.

## Audio

`src/core/Audio.ts` is the bus, `src/core/Music.ts` the sequencer, `src/core/Prefs.ts`
the persisted switches.

Seven tracks, one per event plus the menu, synthesised — no assets. Each is four
bars of 16th-note steps, scheduled with the standard Web Audio lookahead pattern
(a coarse `setInterval` queues notes at absolute `AudioContext` times), so timer
jitter and background-tab throttling cannot make it stutter. It deliberately
does **not** run off the game loop, which is fixed-step and catches up in
bursts.

**M** toggles music, **N** the ambience beds; both persist to `localStorage`
and are advertised on the menu. Turning music off stops the scheduler rather
than muting a bus — a silent scheduler still builds oscillators forever.

Three things learned here, all of them the same lesson in different clothes:

- **Nothing in this project could hear.** The whole review pipeline is
  screenshots, so the audio shipped untested for the entire build and what a
  player actually got was six events of `loopNoise` — broadband pink noise
  behind a Q≈0.6 lowpass, which is barely a filter — with an empty music bus
  behind it. The first person to listen called it "annoying white noise", and
  they were right. `__cg.probe()` now measures the master: tonal content shows
  sharp peaks and low spectral flatness (music here measures 0.04–0.25), noise
  smears across every bin and approaches 1.
- **Measure over a whole number of cycles, or not at all.** The first
  level-balancing pass probed 700ms of tracks whose loops run 7–10 seconds, so
  every reading sampled a different part of the pattern; the "corrected" levels
  made Half Pipe four times quieter and Foot Bag three times louder, swapping
  the two extremes. Re-measuring over ~one loop put Foot Bag exactly on target
  (0.01107 against 0.0110) and still left Half Pipe and BMX low, because 11s
  covers 1.45 and 1.6 of *their* loops. Repeated runs of one unchanged
  configuration varied by ~2x. A loop length is `16 * 60 / bpm` seconds; probe a
  multiple of it. **Track levels are currently approximate and clamped to
  [0.7, 1.6]** rather than set from a number that would not reproduce — this is
  the one place in the project where the right answer was to stop measuring and
  say so.
- **A stub that returns silently is a bug that never reports.** `loopNoise`
  returned a no-op handle when called before the first gesture unlocked audio,
  which is *always* true for the first scene and for every `?scene=` deep link.
  Those beds were dead for the life of the scene. It defers now.

## The results screen and the named tricks

**`src/game/ui/Results.ts`** is the between-event screen: five judges holding
cards, the event name and the reason the run ended above the board, the score
under it, and four per-event meters along the bottom. It follows **all six**
events. It used to be `surfing/Judges.ts`, wired to Surfing's 0–10 score alone,
which was a mis-scoping — the original's screen is a shared results card and
its banner names the *sponsor*, not the event.

Each event passes a rating and its real score: `show(rating, points)`. Surfing
is judged out of ten natively; the rest convert with `ratingFor(score, par)`,
where `RESULT_PAR` is a presentation constant per event. **Nothing reads par
back into gameplay**, so tuning it cannot change what a run is worth. Foot Bag's
first par was 9000 and a forced run pinned every card at 10 — a par below what a
good run scores makes the panel meaningless, so check it against a real score.

The local end cards are still built and still fed, because `endText`,
`overTitle` and `endCardUp` are what the capture gate reads to know a run
finished. They are simply no longer made visible.

**Foot Bag's named tricks** (`footbag/Moves.ts`) carry the original's names and
point values, matched by `matchTrick` against a rolling history of
`(move, side)` contacts. The marquee ones need a **header**, which is a fifth
move sharing the UP key with the knee — the bag's height picks between them, so
the legend stays four items. Two things that cost time:

- The header's `idealY` is the **crown of a standing player**, derived from the
  rig (hip 114 + torso 64−7 + neck 15 + head radius 28 = 242 units ×
  `PLAYER_SCALE` 1.16 = 281px). A first guess of −232 put the contact at the
  player's *face*; the pose solver then correctly did not rise, and the bag met
  nothing. Derive contact points from the rig, never by eye.
- `TRICKS` is tested **longest first**. SQUINTY O TOOLE contains DOUBLE ARCH's
  opening, and whichever matches first wins.

## Art direction, in one paragraph

One hue family per event; one or two accents reserved for the athlete and the
object in play, at higher chroma than anything else on screen (the HUD accent is
chroma-capped for exactly this reason). Build large planes as **discrete value
bands, not smooth ramps** — the eye finds edges, not slopes. Put a **lit pocket
behind the athlete** so the reserved accent has something to be reserved
against. One dominant diagonal. `ENGINE.md` has the evidence.

## Debug handles (`window.__cg`)

`scene()`, `state()`, `goto(id)`, `press/hold/release(code)`, `mute(on)`,
`hints(on)` (hide control legends for a capture), `freeze(on)` (stop the
simulation for a capture), `perf()`. Events may add their own — e.g.
`surfResults(score)` jumps Surfing to its judges' panel.

Audio and inspection: `music(on)`, `ambience(on)`, `nowPlaying()`,
`probe(ms)` (measures the master — rms, spectral peaks, flatness),
`skatingHazard(kind)` (pin every spawn to one hazard) and
`skatingShow(kind, scale)` (render one hazard's real Pixi art centre-screen),
`hudAudit()` (every live readout's value bounds vs its plate — `clipped: 0` is
the pass), `footbagFeed('outsideL headerR outsideR')` (drive the trick award
path directly — a headless driver good enough to actually land a Doda does not
exist), `footbagPose('header')` and `footbagGull()` (put a pose or the bird on
screen for inspection).
The last two exist because checking how a named prop draws otherwise meant
skating until it spawned and then finding it by colour, which kept latching
onto the skater's blonde hair.

## Publishing

The repo is private for now and **intended to go public**, which is why the
`.gitignore` is stricter than it looks like it needs to be.

`refs/` is excluded permanently. It holds ~58MB of screenshots from the 1987
original (Epyx) and from the two games this was benchmarked against, OlliOlli
World (Roll7) and Alto's Odyssey (Snowman). A remake of an 80s game is one
thing; republishing a current commercial title's art is another. **Git history
is permanent** — committing them while private and flipping to public later
would bake them in, and removing them would then mean `git filter-repo` and a
force-push over every clone. Keeping them out now keeps "go public" a one-click
decision.

`captures/` and `review/` are excluded for size, not law: ~54MB of our own
generated frames, reproducible from `scripts/`. The published screenshots in
`docs/shots/` are the exception — seven curated frames, regenerated whenever
the art changes, because stale ones misrepresent the build (the set before this
pass predated the BMX deck and the banana fix).

`.github/workflows/deploy.yml` builds on every push (it runs `tsc --noEmit`, so
it doubles as CI) and deploys to Pages **only when the repository is actually
public** — Pages is unavailable for private repos on the Free plan, and without
that guard every push would fail at the last step.

## Known-outstanding

- **The prop chroma budget in `Boardwalk.ts` is unverified.** Its long comment
  reasons about "a 66px beach ball in gold and magenta panels covering as much
  of the frame as the skater's kit" and softens the props to ~0.35 chroma to
  keep `score_frame.py` finding the player. But the beach ball and the banana
  were **not being drawn** when those judgements were made — they were bare
  shadows through all 65 blind reviews. Both render now, so the frames those
  numbers were tuned on no longer exist. Re-measure before trusting them; the
  banana has already been raised to ~0.45 on the grounds that its identity *is*
  its colour.

- Foot Bag's Axle tricks (Half Axle 250, Full Axle 500, Axle Foley 750),
  Catch-the-throw-in (1500) and Jester (2000) are still missing. Each needs a
  **verb the remake does not have** — a 180/360 turn, an off-screen throw-in, a
  player-controlled jump — so they are new mechanics rather than new patterns.
  Everything else in the original's scoring table is implemented.
- **Game feel and frame rate: accepted, not measured.** Signed off by the
  project owner. All 65 blind verdicts judged *still frames*, and headless
  Chrome has no GPU so every performance figure here is CPU-bound and
  meaningless. This is a known and accepted gap, not an open task — do not
  spend time trying to measure it headlessly, which is what produced the
  meaningless figures in the first place.
- **Audio: accepted.** Signed off by the project owner after listening. The
  tunes are verified tonal and distinct per event; relative loudness between
  events is deliberately approximate (see the Audio section — the analyser had
  ~2x run-to-run variance and chasing it further was the wrong call). Closed.

- **Kill the browser when you are done with it.** `capture-best.sh` does this on
  exit. A tab left on a live scene renders 1920×1080 forever and one session
  accumulated ~19 hours of CPU time that way.
