# Engine contract

Every event is built against this. Read it before writing a line of event code.
The point of this document is that six events built in parallel must compose into
one game, not six games.

## Design space

Fixed **1920 x 1080**. Lay out against exactly those numbers. The stage is scaled
and letterboxed to the window by `App`; you never handle aspect ratio yourself.
`ctx.width` and `ctx.height` are always 1920 and 1080.

## Scene contract

Implement `Scene` from `src/core/Scene.ts`:

```ts
enter(ctx, params)   // build the scene graph. Runs once, before the first update.
update(dt, tick)     // dt is ALWAYS exactly 1/60. Simulation only.
render(alpha)        // position visuals. No simulation, no allocation.
resize(w, h)         // logical size changed
exit()               // release anything not parented to ctx.root
```

Rules that are not negotiable:

- **`update` is the only place state changes.** `dt` is always `1/60`. Never read
  `performance.now()` or `Date.now()` in `update` — it breaks determinism and makes
  a critic's bug report impossible to reproduce.
- **`render` only positions things.** No `new`, no array growth, no texture
  creation. Everything is allocated in `enter`.
- **Never call `Math.random()` in `update`.** Use `ctx.rng`. Cosmetic randomness in
  `render` may use `cosmeticRng`.
- Anything you add to `ctx.root` is destroyed for you on scene exit. Anything else
  (audio loops, timers) you release in `exit()`.

## What you must build on

Do not hand-roll these. Using them is what keeps the six events looking related.

| Need | Use |
|---|---|
| Colour, anything | `src/render/Palette.ts` — `Palettes[eventId]`, `mix`, `aerial`, `lighten` |
| Sky, sun, horizon haze | `src/render/Sky.ts` |
| Depth and scrolling | `src/render/Parallax.ts` |
| Any gradient or glow | `src/render/Gradient.ts` |
| Spray, dust, sparks, splash | `src/render/Particles.ts` |
| Easing, damping, lerp | `src/core/Tween.ts` |

`aerial(color, palette.haze, depth)` is the single most important call for making
depth read. Every layer behind the action gets pushed toward the haze colour in
proportion to its distance. A background that has not been through `aerial` will
look pasted on, and a critic will say so.

## Game feel

- Read input through `ctx.input`. For any action with a timing window, use
  `input.buffered(Action.A, 6)` and then `input.consumeBuffer(Action.A)`. A press
  that arrives a few frames early must still count. This is most of what separates
  an arcade game from a tech demo.
- Call `ctx.perf.markResponse(ctx.input.lastRawPressTime)` on the frame the game
  visibly reacts to a press. This is how the response-time half of the bar gets
  measured; an event that never calls it cannot be verified and will fail review.
- Use `damp(current, target, smoothing, dt)` for camera and follow motion, never a
  raw `lerp(a, b, 0.1)` — the latter is framerate-dependent.

## Audio

Procedural only, through `ctx.audio`. No sample files. `tone()` for pitched hits,
`noise()` for whooshes and impacts, `loopNoise()` for sustained beds (wind, wave,
crowd) — keep the handle and stop it in `exit()`.

## Performance budgets

These are enforced, and unlike frames-per-second they are measurable in the
headless browser (see the caveat below).

| Metric | Budget | Where |
|---|---|---|
| `simMs.p95` | < 2.0 ms | scene `update` |
| `cpuRenderMs.p95` | < 2.0 ms | scene `render` |
| `sceneNodes` | < 1500 | display objects under `ctx.root` |
| `inputLatencyMs.p95` | < 33 ms (two frames) | press to visible response |

Read them with `window.__cg.perf()`.

## The headless GPU caveat — read this before reporting a perf number

The gstack `browse` daemon runs Chromium with **SwiftShader**, a software
rasteriser. There is no GPU. A full-screen 1080p frame costs it ~55 ms, so
**`fps` and `frameMs` from a headless run are meaningless** — the smoke scene,
which costs 0.0 ms of CPU, still reports 17 fps.

Therefore:

- **Never quote headless `fps` as evidence of anything.** Not as a pass, not as a
  failure.
- Judge performance on `simMs`, `cpuRenderMs` and `sceneNodes`, which are pure CPU
  and are accurate headless.
- Real frame rate is verified separately on a GPU-backed browser, not in the
  per-event loop.

Screenshots are unaffected — SwiftShader is pixel-accurate for our 2D content, so
visual comparison in the headless browser is valid.

## Driving the game from outside

`window.__cg` exists for automation:

```js
__cg.scene()                 // current scene id
__cg.scenes()                // registered ids
__cg.goto('halfpipe')        // jump straight to an event
__cg.perf()                  // the report above
__cg.resetPerf()
__cg.overlay(true)           // on-screen perf readout
__cg.press('Space', 80)      // synthetic press with a hold time
__cg.hold('ArrowRight') / __cg.release('ArrowRight')
__cg.mute(true)
```

`window.__cgReady === true` once the first real frame is on screen.

## Capturing for review

```bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
$B viewport 1920x1080
$B goto http://localhost:5273/
$B js "__cg.goto('halfpipe')"
$B js "__cg.mute(true)"
$B screenshot /tmp/shot.png
```

Use the `/browse` skill for all browsing. `mcp__claude-in-chrome__*` tools are
forbidden in this project.

## Staging — read this before touching any art

Six events were reviewed blind against the bar. All six lost, and the critics —
working independently, without knowing which frame was ours — named the **same
three failures in every single event**. They are one class of problem, and
`src/render/Staging.ts` exists so you fix them by calling a function rather than
rediscovering the technique.

### 1. A light source is drawn and nothing obeys it

Every event puts a sun in the sky and then renders a world with no shadows.
Quoted, from three different reviews:

> "It draws its own sun and then renders a shadowless world."
> "A sun is drawn, nothing casts."
> "The rendered sun is decorative — a bloom sprite that lights nothing."

Pick a `KeyLight` and make every surface obey it:

```ts
const key = keyFromLeft(pal.light)
const { lit, shade } = shadePair(pal.near, key)
```

Two values per material is the whole shading model. **A single flat fill on the
largest object in the frame is the thing that reads as unfinished.** Then add the
three consequences of having a light at all: a terminator where a surface turns
away, an `occlusionPool()` where two surfaces meet or a hollow gathers, and a
cast shadow thrown by anything standing on anything.

### 2. Everything floats

Not one object in any of the six events had a contact shadow. The player, the
fence, the signpost, the umbrella, the cacti, the boats — all sitting on a
hairline with no occlusion under them.

Every object that touches the ground gets one, and the player gets one always:

```ts
this.contact = new ContactShadow({ color: pal.shade })
world.addChild(this.contact.sprite)   // BEFORE the character, so it sits under
// in render():
this.contact.place(groundX, groundY, heightAboveGround, surfaceAngle)
```

It is transform-writes only, so it is free. This is the cheapest single fix
available and it was the most repeated note across all six reviews.

### 3. The player loses the focal contest

The eye is supposed to land on the thing the player controls. In our frames it
landed on a sun bloom, on background signage, on HUD text, and in one event on a
**background NPC** — the player character was out-ranked by set dressing.

Rules, from here on:

- The player owns **one saturated hue that nothing else in the frame may use** —
  the HUD included. Reserve it.
- Nothing behind the play plane may carry the highest local contrast. Push
  signage, distant crowds and sky furniture toward the value of what they sit on.
- Give the player a value break from whatever is directly behind them: a rim, a
  darker patch of ground, or a contact shadow. Hue alone is not enough.
- Keep control hints and readouts **out of the playfield**.

### 4. Two habits that give the work away

**Repeated motifs at identical scale.** Sailboats, cacti, fence posts, trees,
grass tufts and crowds were each stamped at one size and one pitch across depths
that should differ. Use `scatter()`, which returns irregular spacing, varied
scale and a variant index.

**Uniform outline weight at every depth.** Called out by name as "the single
loudest vector-app default". Use `depthOutline(depth)` — lines thin and fade with
distance, and past the far band they stop entirely.

### The check before you call an event done

Squint at your capture until detail disappears. If it collapses into one flat
mass, value structure is missing. Then ask, in order:

1. Where is the key light, and does the largest object in the frame obey it?
2. Does every object that touches the ground have a contact shadow?
3. Is the player the first thing the eye lands on?
4. Does anything repeat at identical scale across different depths?

## Composition — the second round of findings

The staging section above came from reviews that asked leading questions about
lighting. Those reviews were **biased**: the prompt named the techniques we were
already working on, so it rewarded them and marked the reference down for a flat
style it chose on purpose. Re-run with neutral wording, the same frames lost four
out of four, decisively.

This section comes from the neutral reviews. It is what actually separates our
frames from the bar, and it is not about rendering.

### 1. There is no value plan

> "The sand, the boardwalk, the railing, the bins, the benches all live inside
> about a fifteen-point luminance band, which means the entire lower two-thirds
> is one undifferentiated mud plane with props embossed into it."

Squint at your capture until detail disappears. You should see **three clearly
separated masses**: a dark near plane, a mid stage, a light sky. If it collapses
into one grey, no amount of lighting detail will save it.

Assign the three values first, then pick hues to fit them. Not the other way
round. And the **biggest value jump in the frame belongs to the player**.

### 2. Everything is parallel horizontal bands

> "A stacks five parallel horizontal bands and places its skater flat on the
> lowest one. A horizontal stack cannot stage anything, because every element is
> at the same distance from every edge."

The reference builds every frame on **one dominant diagonal**, and then points
hue, value and line along it so all three converge on the rider. Our side-on
events default to sky / mid / ground / foreground stripes with a flat horizon at
mid-height.

Find the diagonal your event already owns — a transition curve, a wave face, a
descending course, a throw arc — and stage the camera so it runs corner to
corner rather than sitting flat. Add a near-plane occluder that crops the frame
at an angle.

### 3. The player does not own the frame

In our events the player sits at 4–6% of frame height, mid-value against
mid-value. In two of them the brightest thing on screen was a **HUD element**;
in one, the player was out-ranked by a background NPC.

- Reserve one saturated hue for the player that **nothing else may use**,
  including the HUD.
- Put the player where the frame's strongest value break is.
- Scale them up. The reference holds its rider around 20% of frame height.

### 4. The palette is a default, not a decision

> "Blue-sky-over-green-grass — the two colours that arrive for free in any
> engine."

The reference commits to **one hue family** across almost the whole frame and
then spends its contrast budget in two or three rationed places. Ours reach for
a naturalistic local colour per object — a blue sky, green hills, tan wood — a
set of families with no shared temperature.

Pick the family, push every background element toward it, and spend the accents
deliberately.

### 5. Capture the apex, not the approach

> "B caught the apex; A caught the roll-in."

This one was a measurement bug, now fixed: `scripts/capture-action.sh` drives
each event to the peak of its action before the shutter. Use it, not
`capture.sh`, for anything that will be reviewed. A still of a character rolling
along flat ground is not what the event looks like when it is working.

### 6. The character is the first thing a reviewer calls amateur

> "A jointless stick figure — limbs are identical-width rounded rectangles, no
> hands, no feet, the board is a hairline... the subject of an action screenshot
> reads as a placeholder, and nothing else you fix matters until it doesn't."

Limbs taper hard from joint to extremity. Hands and feet exist. The board or bike
has mass. The silhouette reads with negative space between the arms and the
torso. Check it at thumbnail size, because that is where a reviewer looks first.

### 4a. One hue family still needs one complement

A later review caught an over-correction of rule 4. An event committed so hard to
a single hue family that the whole frame sat inside one ~30° wedge:

> "A has no complement anywhere in the frame... Every relationship in it is a
> value relationship, so nothing has a hard graphic read, and the rider is
> sitting on a mid-brown band at mid value with no contrast envelope around him."

The reference does **both**: it holds a warm field across almost the whole frame
*and* drops one large cool complement into it, so the biggest shape is also the
biggest hue contrast. Then it puts the player where they meet.

So: one hue family for the field, **one complement reserved for the player and
what they ride on**, and nothing else allowed to use it. A frame with no
complement is as flat as a frame with five families.

## What separates the frames that win from the frames that lose

Twenty blind critics have now judged these six events against the bars. Four
events win consistently; two lost repeatedly. The losing critiques converge on
two instructions, given in near-identical words by critics who never saw each
other's work and were judging different events.

### Bands, not gradients

> "roughly 45% of the canvas is one undifferentiated olive slab that slides from
> L=105 to L=61 **with no step you can point to**."
> "the ground reads as **a gradient with noise on it**" — Flying Disc

> "cloud at (798,360) is `#C6CDCA` and open sky 80px away is `#C8CECB` — a **two
> level difference** across the entire top 60% of the frame." — Foot Bag

Both events built their big planes as smooth ramps. Every event that wins builds
them as **discrete steps**. A smooth ramp across 45% of the canvas reads as one
flat mass however wide its endpoints are, because the eye finds edges, not
slopes. The prescription, from three critics independently: two or three flat,
decisively separated bands, getting darker toward camera.

This is also why a measured value range can be excellent while the frame reads
flat — `value_spread` sees the endpoints and cannot see whether anything steps.

### A lit aperture behind the athlete

> "place the brightest pocket **directly behind the runner** so the figure sits
> in a lit aperture rather than floating on a grey wall." — Foot Bag

> "a light strip at L≈100-110 **sitting directly behind the thrower**." — Flying Disc

Reserving an accent for the athlete is necessary and not sufficient. Foot Bag
reserved its accent properly, measured the best `subject_break` in the project
at 0.446, and lost three reviews with it — because the athlete was a saturated
mark on a wall rather than a figure in a hole. The background has to be built
*around* where the player will be.

Corollary, learned the same way: crushing a background only works if the athlete
then owns an extreme. Foot Bag's background was flattened exactly as asked and
the frame gained nothing, because the hero stayed mid-value. BMX did the inverse
— it **lifted** its berm and put true near-black in front of it — and wins 3-1.

## Rigs: never pin an extremity to an IK target

`ik2` clamps an out-of-reach target onto the reachable circle so the limb
straightens instead of yielding NaN. That is correct. What is not correct is
placing a hand, boot or shoe at the *requested* target afterwards: the drawn
bone stops at `l1 + l2` from the root, the extremity keeps going to the wish,
and the two separate by exactly the over-extension.

A blind review found it before we did, in Foot Bag:

> "The trailing hand is fully detached, floating as a loose brown disc at
> ~(455,565) while the wrist ends in a blunt stump at ~(490,545)."

Always place an extremity at the distal bone's real end:

```ts
const a = Math.atan2(tipY - joint.y, tipX - joint.x)
bone.rotation = a
hand.position.set(joint.x + Math.cos(a) * BONE_LEN, joint.y + Math.sin(a) * BONE_LEN)
```

This is identical to the naive version whenever the target is reachable, so
there is no reason to write it the other way. Rigs that draw the extremity *on*
the bone rather than as a separately positioned node are immune by construction,
which is the better pattern where it fits.

## Measuring a frame before a critic sees it

> Every one of the faults below produced a plausible number instead of an error,
> and most of them were found by a builder rather than by the person quoting the
> numbers. If a measurement in this project looks like progress, that is when to
> check it hardest.

Six measurement mistakes cost this project several rounds. All are fixed, and
all are worth understanding before you trust any review result. The pattern they
share is worth more than any of them individually: **every one produced numbers
that looked like progress.** None of them failed loudly.

### The capture was not comparable

The reference frames this game is judged against are **curated marketing
stills** — chosen from many, at the peak of an action. Ours were whatever
instant the shutter happened to hit. One event won its comparison twice and then
lost it, with no code change in between, purely on which moment got sampled.

`scripts/capture-action.sh` drives each event to the peak of its action.
`scripts/capture-best.sh` samples several and keeps the strongest. Use it for
anything that will be reviewed; never quote a result from a single arbitrary
frame.

### The shutter fired on the worst instant

The capture gate skipped wipeout frames by testing `lastHazard`. But that field
was also set on every *successful* clear, so after the first clean landing the
gate was false forever. Every event was being judged on the one moment it is
guaranteed to look worst. Fixed with a separate `downCause` field.

The gate now also requires `cleanTicks > 130` and `score > 0` — nothing reads
worse in a review than instrumentation at rest.

### The rubric was moved to fit the work

Mid-project the critic prompt was rewritten to ask pointed questions about the
techniques then being built. It duly reported five of six events winning. Re-run
with neutral wording, the same frames lost four out of four.

**A gauntlet is only worth running if the bar cannot be moved to meet the work.**
Keep the critic prompt neutral: ask which frame is better art direction and why,
state that a deliberate flat style is a legitimate choice, and do not name the
techniques you have been working on.

### scripts/score_frame.py

Scores a frame on three measures, each lifted from critic language:

| measure | meaning | target |
|---|---|---|
| `subject_break` | player's local luminance contrast against what is behind them | ≥ 0.28 |
| `value_spread` | p95 − p05 luminance | ≥ 0.45 |
| `dead_frac` | share of playfield that is flat and featureless | ≤ 0.20 |

For calibration, the reference frame measures **0.283 / 0.495 / 0.161**. Note its
value spread is *lower* than several of ours. More contrast is not the goal;
spending it on the subject is.

### The scorer was measuring the shadow

Three separate builders independently found the subject detector locking onto
shade rather than onto the player. HSV saturation is `(max-min)/max`, which a
dark saturated navy maximises: deep water measured 0.88 against a hot pink rider
at 0.69, so "the most saturated cluster" was a flat mass of shadow at the bottom
of the frame. It now uses value-weighted chroma. The reference's own separation
went 0.181 → 0.283 — every number taken before this was measured against a
miscalibrated bar.

**Always check the printed `subject_at` centroid lands on the player.**

### A number can be invalid rather than bad

The detector takes the most colourful ~0.6% of the playfield and calls it the
player. That is only true if the frame reserves a hue for the player. When it
does not, the "subject" is a dust of pixels spanning half the canvas and its
contrast against a local ring is noise. Several bar frames read 0.003 this way,
and so did three of ours — Half Pipe's 0.598, the best number in the project,
came from an accent spread over 49% of frame height and was never measuring the
rider.

The scorer now prints `?no-subject` for these. **A flagged reading is not a
result and must not be quoted as one.** It is still a finding, just a different
one: a subject box taller than a third of the frame means the accent is not
reserved, which is exactly the mechanism every critique says the bar wins with.

### The subject was a caption

BMX measured `subject_at 876,272` and read `subject_found: true` with no faults.
That centroid was the word **CRASH**. The amber sky measured 0.35–0.44
colourfulness against a rider at 0.69, so the top 0.6% of the playfield was
caption glyphs plus sky, and every `subject_break` quoted for that event was
measuring text. A compact chromatic blob is indistinguishable from an athlete to
this detector — the validity flag does not catch it, because a caption is exactly
the shape the flag is looking for.

There is no automatic fix. `subject_at` is printed on every line **so that a
human reads it**, and this one went unread for several rounds while the number
beside it was quoted as progress.

The art fix and the measurement fix turned out to be the same fix. The detector
clamps its threshold at 0.35, so once the warm family is desaturated far enough,
twelve background pixels in the whole field clear that floor and nine of them are
the bike. Reserve the accent hard enough and the detector can no longer find
anything else — which is the bar's mechanism, stated as a measurement.

### The shutter photographed the wrong event

A Roller Skating capture rendered the **Foot Bag** scene. Both frames then scored
`0.415 / 0.673 / 0.150` with the same centroid, because they were the same
scene 98.6% pixel-identical. Read as a result, that is "skating improved from
0.262 to 0.415 after its art pass".

`window.__cg.scene()` has always returned the live scene id. The capture script
simply never asked. It now verifies **before** the driver and **again after** it,
because a driver can bail to the menu or advance to a results screen and the
shutter would happily photograph either; on mismatch it deletes the file and
exits non-zero. `capture-best.sh` additionally cross-checks every pair of
captured frames for near-identity, since that failure is silent by construction.

Related, same script: a driver that **timed out** never reached its dramatic
state, and the shutter used to fire anyway. That is how a Foot Bag frame reading
`SCORE 0 / RALLY 0 / BEST 0` with every meter empty reached a critic — under a
gate that explicitly requires `score > 0`. The gate was correct; the timeout path
went around it. A timeout is now a failure, not a frame.

### A clean tick is not a dramatic one

The Surfing gate accepted `faceT > 0.72`, which means "riding high" and says
nothing about the wave's shape. It captured a long flat swell with no lip, no
curl and no foam — so an entire pass rebuilding the lip geometry was invisible in
the only frame a critic ever saw. It now requires `wavePitch > 0.6`, the same
threshold the tube mechanic uses, and a relaxed fallback labels itself `RELAXED`
so a weak frame is never mistaken for a chosen one.

**Write each event's gate around the state the event is named for.**

### Guards, not more scoring terms

Selecting best-of-N on the three measures above cost one event a win it already
held — the chosen frame scored well and put the rider exactly on the horizon
line. The temptation is to add a term for that. Don't: the lesson from rewriting
the critic prompt applies to the scorer too, and a proxy with a term for every
fault becomes a thing you optimise against instead of a thing that catches
mistakes.

Faults the critics named **in their own words** are pass/fail gates instead, and
ranking among the survivors is untouched. Currently `on-horizon` ("the single
worst place to put a subject") and `subject-small` (the bar puts its subject at
5–18% of frame height). Adding one requires a critic quote, not an opinion.

**It finds the player as the most colourful cluster, and that detector was wrong
for most of this project.** It originally used HSV saturation, which is
`(max−min)/max` — a number a *dark* saturated colour maximises. Three separate
agents, working independently on three different events, found it locking onto
shadow instead of onto the character: deep navy water measured 0.88 saturation
against a hot-pink rider at 0.69. Every `subject_break` reported before that fix
may have been measuring a flat mass of shade.

It now uses value-weighted chroma. Two consequences worth carrying:

- `score_frame.py` prints `subject_at`. **Always check that centroid lands on
  the player** before believing the number next to it.
- Keep every non-player surface below roughly 0.45 chroma and the player above
  0.6, so the reserved hue is genuinely reserved. That is good art direction
  independently — it is the mechanism the reference wins with — and it happens to
  make the measurement honest.

This is a sanity check, not a verdict — one event beat the reference on all three
measures and still lost decisively on scale and staging. Numbers catch the
obvious failures early so the critic's attention goes to the real ones.
