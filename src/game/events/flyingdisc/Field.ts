import { Container, Graphics, Sprite } from 'pixi.js'
import { Parallax } from '../../../render/Parallax'
import { ParticleSystem } from '../../../render/Particles'
import { horizontalGradient, softDot, verticalGradient } from '../../../render/Gradient'
import {
  Core, darken, grade, graphicDepth, mix, skyAt,
  type EventPalette, type Hex,
} from '../../../render/Palette'
import {
  depthOutline, keyFromRight, scatter, shadePair,
  type KeyLight,
} from '../../../render/Staging'
import { clamp01, damp, lerp } from '../../../core/Tween'
import type { Rng } from '../../../core/Rng'

/**
 * The field: projection, terrain and weather.
 *
 * Flying Disc is the only event in the game that is not side-on, so it needs a
 * camera. Everything here is laid out in *metres* — x across the field, y up,
 * z downfield — and projected through one pinhole camera standing behind the
 * thrower. Working in metres is what lets the disc use real aerodynamic
 * constants instead of pixel fudge factors.
 *
 * ## The lighting moment
 *
 * An hour before the sun goes, in autumn. The sun is LOW and off to the right,
 * just clear of the treeline, and that one decision drives everything here.
 *
 * It replaces a noon sky that a neutral review took apart: stock blue over
 * stock green, a treeline of thirty blobs separated by about five points of
 * value ("noise rather than silhouette"), and a hard-edged dark wedge across
 * the fairway that nothing in frame cast — "the one bold shape reads as a bug,
 * not a choice".
 *
 * Under a low sun the same geometry does real work:
 *
 *   - the treeline is BACKLIT, so it is a dark silhouette against the brightest
 *     band of the sky rather than a pale smear against a blue one;
 *   - shadows are long. The touchline trees throw all the way across the
 *     fairway, and they rake toward the camera rather than lying flat, which is
 *     where this frame's diagonals come from;
 *   - everything standing up gets a warm rim on its right flank and falls away
 *     cool on its left.
 *
 * ## Value plan
 *
 * Assigned before any hue was picked, because that is the order that works.
 * Quoted as 0-255 luma, because that is what the reviews measure and because
 * the previous version of this block was quoted in HSV value and quietly
 * described a sky that no longer exists — it ran "brightest at the horizon,
 * LIGHT mass", which is the exact fault the palette was rewritten to remove.
 * The light mass is the DISC. Nothing else is allowed into it:
 *
 *   disc plate     L 210   the hero, and the ceiling                LIGHT mass
 *   disc trail     L 214   same gold, same object
 *   ---- forty points of clear air, everywhere the arc goes ----
 *   hill crest rim L 165   the brightest non-hero mark in the frame
 *   river glint    L 163   composited, at the top of its breath
 *   sky, brightest L 161   at y=511, below the horizon line
 *   hill lit face  L 157
 *   sky at horizon L 155   the warmest band, and the top of the sky MID mass
 *   near bank      L 155   the warm line between water and field
 *   far wood       L 112
 *   sky at the top of the arc  L  91
 *   ground band 1  L  92   the light strip the thrower stands on
 *   sky at zenith  L  38   indigo, behind the overhead strip
 *   ground band 2  L  56
 *   near wood      L  40   near-black, on the water line            DARK seam
 *   ground band 3  L  36   the near plane                     DARK near plane
 *
 * Three separated masses in a fixed order, with genuine steps between the
 * canopy tiers, and a light-to-dark funnel down the frame rather than a bright
 * lid on it. The athlete's reserved pink carries the biggest CHROMA jump in the
 * frame and his rim light the second biggest value jump, which is where they
 * belong — one step under the disc.
 *
 * ## Composition
 *
 * The old frame was parallel horizontal bands all the way down. Four things now
 * run diagonally and all of them point back at the thrower in the lower left:
 * the mown lanes converging on the vanishing point, the long tree shadows
 * raking down and left, the canopy line climbing toward the right, and the near
 * bank cropping the lower right corner.
 *
 * Nothing in here is rebuilt per frame. `update()` advances weather state and
 * `apply()` writes transforms, so the whole backdrop costs a few hundred
 * property writes and zero allocations.
 */

// --- camera ----------------------------------------------------------------
/** Screen y the ground converges to. Sky above, field below. */
export const HORIZON_Y = 430
/** Screen x of the camera axis. */
export const CENTRE_X = 960
/**
 * Camera height above the grass, metres.
 *
 * This one number is the staging of the whole event, and it used to be 6 — a
 * standing operator looking slightly DOWN at the field. Everything the throw
 * involves then happens below the horizon: the disc flies at two to three
 * metres, so it sat on the busy treeline and read, in a blind review's words,
 * as "a two-pixel smudge"; and the thrower stood entirely on the grass, mid
 * value on mid value, measuring 0.097 of local contrast against her own
 * background.
 *
 * At 2.1 the camera is down in the grass, below both of them. The consequences
 * are the whole art pass:
 *
 *   - the horizon crosses the thrower at the hips, so his torso and his head —
 *     the only saturated hue in the frame — are punched out against the warm
 *     band at L=150 while his legs stay on grass at L=56-92. A value break
 *     above AND below is a contrast envelope, not a tint. That break did NOT
 *     depend on the old pale sky: inverting the gradient kept the step and made
 *     it warmer, and the rim light down his sunward flank (L=207 raw) is the
 *     biggest single value jump on the figure either way;
 *   - the disc climbs ABOVE the horizon line within a few metres of the hand,
 *     so its arc runs across clean sky and its trail draws the throw;
 *   - the ground plane opens out under the camera, which gives the mown lanes a
 *     real convergence instead of a shallow fan, and gives the frame a dark
 *     near plane that is not just a strip along the bottom edge.
 *
 * It is exported because the disc's foreshortening and the scene's tilt planner
 * both need the same number, and two copies of it drifting apart put the disc's
 * shadow in a different place from the disc.
 */
export const CAM_H = 2.1
/**
 * Pixels per metre at one metre of depth. About a 17-degree horizontal field of
 * view — a long lens. That is deliberate: a wide lens throws the far half of the
 * field away into a few pixels above the horizon, and a compressed, banded,
 * poster-flat composition is both what televised field sport looks like and what
 * the 1987 original's screen is.
 */
const FOCAL = 3220
/**
 * Camera standoff, metres. Added to every depth so nothing divides by zero, and
 * chosen with FOCAL so the grass at the throw line lands just off the bottom of
 * the frame: HORIZON_Y + CAM_H * FOCAL / NEAR_D = 1120.
 */
const NEAR_D = 28

// --- field geometry ---------------------------------------------------------
/**
 * Near bank of the river. The grass — and the playable field — stops here, and
 * it sits a couple of metres beyond the longest throw the gauges can produce,
 * so a maximum-power huck downwind can just about get wet.
 */
export const RIVER_Z0 = 74
/** Far bank, where the tree line is rooted. */
export const RIVER_Z1 = 110
/** Resolution of the precomputed depth-grade ramps. */
const DEPTH_STEPS = 24

/**
 * THE GROUND PLANE. Three flat bands, not a ramp.
 *
 * Four independent blind critics, none of whom saw the others, returned the
 * same sentence about the lower half of this frame:
 *
 *   "one undifferentiated olive slab that slides from #656C55 to #3C3F30 with
 *    no step you can point to"
 *   "that dead 55% of the frame"
 *   "a gradient with noise on it"
 *
 * and all three prescribed the same thing: two or three flat, decisively
 * separated bands, with a LIGHT strip directly behind the thrower.
 *
 * The previous version was a smooth curve keyed to the screen row
 * (`valScale = 0.2 + 0.86 * d^1.6`) applied to thirty depth-sorted stripes,
 * with the stripes alternating light/dark on parity. A smooth curve is
 * precisely "no step you can point to", and the parity alternation is
 * precisely "horizontal banding stripes". Both are gone.
 *
 * What replaces them is three drawn shapes with undulating crests, keyed to the
 * horizon rather than to depth, because a low camera's 1/z crushes the far half
 * of the field into forty pixels and a band plan has to live where the pixels
 * are. Perspective is carried by the mown lanes converging on the vanishing
 * point and by the figures' own scale — which is exactly how the two reference
 * frames that win consistently (BMX's dune bands, Halfpipe's terraces) do it.
 *
 * Values are the critics' own numbers, measured as 0-255 luma:
 *
 *   light strip   L  92   the thrower stands on this, in silhouette
 *   mid band      L  56
 *   near band     L  34   dark, but NOT the black vignette it was (L 22):
 *                         "the frame has a floor instead of a hole".
 *
 * Offsets are pixels BELOW the true horizon (HORIZON_Y + camPitch), so the plan
 * holds while the camera tilts to follow a lofted disc.
 *
 * THE THIRD BAND WAS NEVER ON SCREEN. Its top sat 470 px below the horizon; a
 * lofted throw tilts the camera about 120 px, which put it at y=1021 — under a
 * bottom HUD bar whose top edge is at y=934. So the "three flat bands" a whole
 * pass was written for rendered as two, and the frame's dark floor was the HUD
 * rather than the ground. A blind review measured the result down the frame and
 * read it back as a ping-pong:
 *
 *   "the ping-ponging olive ground bands at y=480/540/620 — L=54 -> 105 -> 54
 *    — receding nowhere"
 *
 * The 54 above the light strip is the near wood, not a ground band; the 54
 * below it is band 2; band 3 was invisible. Two fixes, both here: the offsets
 * are compressed so all three bands land inside the visible field at any camera
 * tilt the event can produce, and the light strip comes down from L=105 to
 * L=92 so the three steps read as one descending ramp rather than as a bright
 * stripe with a dark stripe under it.
 *
 * At rest (horizon 430) the steps land at y 492 / 646 / 782; at full tilt
 * (horizon 551) at 613 / 767 / 903. The bottom bar is inset from both edges, so
 * band 3 is visible in both bottom corners and under the bar at every tilt.
 *
 * ---------------------------------------------------------------------------
 * THE LIGHT STRIP CAME BACK, AND THIS TIME IT IS THE APERTURE THE ATHLETE
 * STANDS IN.
 *
 * Bringing band 1 down from L=105 to L=92 fixed the ping-pong and cost the
 * frame the thing `ENGINE.md` says every winning event has. Two blind reviews
 * measured what was left, independently, and agreed to within a point and a
 * half:
 *
 *   "the field is a flat #55613F (L92) and the hero athlete's torso sits at
 *    L99.7 against it — a SEVEN-POINT separation on the single most important
 *    object in the frame"
 *   "the thrower's torso and legs give meanL=67.6 against a background of
 *    meanL=75.7 ... both characters survive only on hue, which will collapse
 *    entirely on a phone in daylight or in any colour-blind view"
 *
 * and both prescribed the same structure: figures at L35-45, ONE lit strip of
 * grass at the horizon around L=95-110, and the thrower cut against it.
 *
 * Measured on captures/flyingdisc.png, the thrower stands with his torso on
 * band 1 (y 660-790) and his legs on band 2 (y 790-925). So band 1 IS the
 * aperture, and it only ever needed to be the light:
 *
 *      band 1   L  92 -> 112    the lit strip. The torso is punched out of it.
 *      band 2   L  56 ->  64    the legs. Lifted, not dropped: at 56 against a
 *                               figure driven to L40 the legs dissolved, which
 *                               is a fault this project has already paid for
 *                               once ("silhouette broken at the knees").
 *      band 3   L  36 ->  26    the near field, and now genuinely the darkest
 *                               green in the frame. The foreground crop that
 *                               cuts the lower right corner comes down with it
 *                               so it stays one step under, not one over.
 *
 * The figure's own half of the same fix is in `Receiver.ts` and `FlyingDisc.ts`
 * (kit, skin, bib, ink), and the surface-by-surface table is in the former.
 * Measured over the thrower's torso box by simulating the recolour on the
 * capture: figure meanL 68.7 -> 60.9 against a background meanL 91.9 -> 97.9,
 * so the break goes 23.2 -> 37.0 points. The bib alone goes 7.7 -> 52.6.
 *
 * Band 3's crest also moves up, 352 -> 300. It was at y=925 at rest, which is
 * under the bottom bar and below the 88%-of-frame line every measurement of
 * this project stops at, so the frame's darkest ground was being drawn almost
 * entirely where nothing looks. At 300 it lands at y=874, under the thrower's
 * feet and inside the picture.
 *
 * NOTE, before reading the numbers above as current: there are FIVE bands now,
 * not three, and the lit strip's crest has moved from 62 to 126. The three
 * offsets this paragraph quotes — 62 / 216 / 300 — are now bands 0, 3 and 4.
 * See the block immediately below.
 */
/*
 * AND THEN THE FRAME HAD NO HIGHLIGHT IN IT AT ALL.
 *
 * The sky inversion above is right and it stays. What it cost was measurable,
 * and a blind review measured it off `captures/flyingdisc.png` with the HUD
 * masked out:
 *
 *   "A has a p99 of 153 and a median of 95: 99% of its artwork sits in a
 *    25-153 mid-dark mush with NO HIGHLIGHT ANYWHERE, which means the
 *    brightest thing in frame A is its own interface text at 255."
 *   "it paints dusk but lights the ground as if under flat overcast."
 *
 * Reproduced here before anything was changed: over the playfield (rows
 * 120-960) only 2145 pixels of 1.6 million measured above L=170 — 0.13% — and
 * the brightest large surface below the horizon was the five-pixel bank line
 * at L=146. The four events that win this review sit at p99 196-230.
 *
 * The fix is NOT to put the sky back. It is to commit to the one low warm key
 * the fiction already has — a sun eleven degrees up at the frame's right
 * shoulder — and let it land on something. It lands on the fairway, because
 * that is the only large plane in the picture turned toward it, and because a
 * raking light on turf is what a dusk field looks like.
 *
 * So the three bands become five, and the two new ones go at the TOP, between
 * the river bank and the old lit strip:
 *
 *   sun rake   L 196   the strip of turf the low sun grazes at the far bank
 *   falloff    L 156   the light dying out of it
 *   lit strip  L 112   unchanged; the thrower's torso is still punched out
 *   mid band   L  72   lifted 8, so his cast shadow has further to fall
 *   near band  L  31   lifted 5, for the same reason
 *
 * Read down the frame that is 196 / 156 / 112 / 72 / 31 — the "clean monotonic
 * ramp, bright at the horizon, falling steadily to the foreground" the winning
 * reference is measured at, with four steps you can put a finger on instead of
 * a gradient. The ORDER rule the light pool is built on (see `KEY_POOL`: the
 * ground may never be brighter than the ground behind it) holds the whole way
 * down, bank included.
 *
 * What it costs, and why it is affordable: the sun rake is 28 px of full-width
 * turf, about 3% of the playfield, so it is what `p99` now measures — 196
 * against the disc's plate at L=209.8. The disc is still the brightest object
 * in the picture and its arc never crosses this band (the arc's lowest point
 * is 75 px of sky above the bank), so the +48 break the inversion was built to
 * buy the disc is untouched everywhere the disc actually is.
 *
 * And it is not a ruled stripe, which is the thing this frame has already been
 * told off for twice. Its top edge is the bank's own crest, which now
 * undulates; its bottom edge is the falloff band's crest, which undulates
 * further and out of phase; the mown lanes converge across it; and the reeds
 * on the bank stand up through it. Measured along the width its visible depth
 * runs from 14 px to 42 px.
 */
const GROUND_BANDS: { top: number; colour: Hex; wave: number; phase: number }[] = [
  // The sun rake. The brightest ground in the frame, hard against the bank,
  // and the frame's highlight.
  { top: 62, colour: 0xcfc78d, wave: 6, phase: 0.6 },
  // The light dying out of it as the field turns away downfield.
  { top: 90, colour: 0x9ba169, wave: 11, phase: 2.2 },
  // The lit strip. The thrower's torso is punched out of this.
  { top: 126, colour: 0x69764f, wave: 14, phase: 4.1 },
  { top: 216, colour: 0x424c32, wave: 22, phase: 2.9 },
  { top: 300, colour: 0x1b2116, wave: 28, phase: 5.1 },
]
/**
 * The lit strip the thrower's torso is cut against. Index 0 is the sun rake at
 * the top of the ramp, index 4 the near field — the darkest GROUND in the
 * frame, but no longer the darkest mark in it. See SHADOW_TONE.
 */
const BAND_LIT = 2
/** The band the light pool's far tip touches; the pool may never exceed it. */
const BAND_MID = 3

/**
 * One shadow material for the whole field.
 *
 * `Receiver.ts` already says this in a comment — "the same value the touchline
 * trees' shadows use, so every shadow on this field is one material" — and it
 * was not true: the athletes' cast shadows were 0x1f2617 (L=35) and the trees'
 * and the windsock's were `GROUND_BANDS[1].colour`, whatever that happened to
 * be. At L=56 that was not a shadow at all, it was a second copy of the mid
 * band: measured over the right half of the field, 53% of the pixels carried
 * the mid band's exact value and most of them were tree shadow lying on the
 * light strip.
 *
 * One authored value, darker than any ground band it can fall on, used by the
 * copse, the windsock and both athletes. It is also what puts a set of long
 * hard diagonals across the light strip, which is the only thing keeping the
 * biggest plane in the frame from measuring as one unspent mass.
 */
/*
 * TWO DISTANCES, ONE MATERIAL. And the near one had to go darker.
 *
 *   "the hero throwing at (110-300, 480-760) casts no shadow at all while the
 *    distant receiver and the tree clump both do"
 *
 * He does cast one, and it is in the capture: at y=930 it runs x 126-297 at
 * L=28.9 on a light pool at L=56.2. What is wrong is the number. Where the
 * wedge leaves the pool it lies on the near band, which was 0x171c12 at
 * L=26.2 — so the frame's shadow material was THREE POINTS LIGHTER than the
 * ground it fell on, and the half of the shadow that reaches past the pool was
 * not a shadow at all. That is the same bug class the last pass found and it
 * survived because only the pool was measured.
 *
 * So the near tone drops to L=16.5, under every ground value in the frame
 * including the lifted near band at L=31, and the athletes' shadows and the
 * hero's silhouette keep the darkest ink in the picture. Against the pool that
 * is a 47-point step; against the near band, 14.
 *
 * The second tone is aerial perspective, which is `ENGINE.md`'s first rule and
 * the one thing every other far layer in this file already obeys. The copse
 * stands at forty-six to seventy metres and a blind review named what a
 * near-black shadow at that distance does:
 *
 *   "the tree mass plus its cast shadows is the strongest contrast step in
 *    the frame, dragging the eye off the action."
 *
 * It was: L=28.9 on a lit strip at L=112, an 83-point step spread over the
 * largest dark mass in the lower half, next to a hero carrying 72. At L=50.9
 * the copse's shadows step 61 against the strip and the hero's step 47 against
 * a pool he is standing in the middle of — and the largest contrast in the
 * frame goes back to being the man, his rim and the band he is cut against.
 * Same hue, same flat opaque fill, same wedge: one material, seen through
 * more air.
 */
export const SHADOW_TONE = 0x0e1209
/** The same shadow at forty-plus metres. See above. */
const FAR_SHADOW_TONE = 0x2e3623
/** How far each band's crest slides against the camera's lateral pan. */
const BAND_PARALLAX = [8, 10, 18, 24, 28]
/**
 * The river bank's crest, in pixels off its own baseline.
 *
 * Two sines an octave apart, exactly as every ground band's crest is built,
 * and deliberately out of phase with the sun rake band that laps over it: the
 * strip of bank that shows between the water and the grass is the difference
 * of two independent waves, which is what stops three full-width horizontals
 * stacking into "a painted wall rather than water".
 */
const bankCrest = (x: number): number =>
  Math.sin(x * 0.0026 + 1.9) * 3.4 + Math.sin(x * 0.0067 + 4.4) * 1.6

/**
 * THE LIT POCKET WAS UNDER THE WRONG MAN.
 *
 * The band plan above builds one light strip and pins it to the horizon, which
 * is where the RECEIVER stands. The thrower — the subject of the frame this
 * event is judged on — stands four metres from the camera, and the moment the
 * camera tilts up to hold a lofted disc the bands slide down past him and drop
 * him onto band 3. Three blind critics measured the result and two of them
 * wrote the same sentence:
 *
 *   "the thrower is among the darkest shapes in the picture sitting on the
 *    second-darkest band, in the bottom-left corner... meanwhile the brightest
 *    region of the frame is completely empty"
 *   "the hero's trousers and boots sit around L=21 on ground at L=26: his
 *    entire lower half dissolves, so the pose that sells a throw is cut off at
 *    the thigh"
 *
 * Measured on captures/flyingdisc.png at the instant the capture driver
 * shoots: his feet land at y=932 and band 3's crest at y=858, so every pixel
 * of him below the knee was drawn on #171C12 (L=26) while wearing #201C29
 * (L=30). Four points. The aperture existed; the hero was not in it.
 *
 * A second strip would just be a fourth band, and the frame has already paid
 * for one round of "ping-ponging olive ground bands receding nowhere". So this
 * is not a band. It is a SHAPE, it belongs to the thrower rather than to the
 * horizon, and `applyLightPool` drives it off his own projected feet, so it is
 * under him at every camera tilt the event can produce.
 *
 * What it is, in the fiction: the gap between two touchline tree shadows. The
 * copse throws seven long raking wedges down and to the left across the
 * fairway (see `buildCopseShadows`); this is the light between two of them, so
 * it is drawn in the SAME vocabulary — a tapered lozenge, flat, opaque, hard
 * edged, blunt at the near end and pointed at the far one, raked toward the
 * camera. Inverted: a shadow is blunt at the trunk and points away, this is
 * blunt at the man and points up-field.
 *
 * AND THEN IT WAS THE WORST STRIPE OF THE LOT.
 *
 * Three nested steps at L 68 / 95 / 147 were built to a critic's own
 * prescription — "a light pool lifting the grass to roughly L=140-150 in the
 * left third under him". Taking that number literally put the BRIGHTEST GROUND
 * IN THE FRAME in the near foreground, under a horizon strip at L=112, and the
 * next critic measured the result down a column and read it straight back:
 *
 *   "B's equivalent column sawtooths through the ground — 112, 71, 113, 112,
 *    63, 64, 33, 67 — alternating light and dark grass bands with no
 *    directional logic, so the field neither recedes nor directs anything;
 *    it's a stack of arbitrary wedges."
 *
 * Measured on the capture at x=300 the column runs 112 ... 112, 64, 147, 147,
 * 147, 147, 147, 133, 147, 147. The ground gets darker going forward and then
 * jumps thirty-five points ABOVE the horizon to land the foreground on the
 * frame's brightest grass. There is no light in the world that does that, and
 * the reference the frame is judged against does the exact opposite: "a clean
 * monotonic ramp — 92 at the top of the sky, 175 at the horizon, falling
 * steadily to 42 in the foreground dune."
 *
 * So the rule the pool has to obey is not a value, it is an ORDER: the ground
 * may never be brighter than the ground behind it. One shape, one value, and
 * that value sits between band 2 (L=64), which the pool's far tip touches, and
 * band 3 (L=26), which it lies on. At val 0.50 it measures L=56, so a column
 * through the thrower now reads 112, 64, 56, and the ramp falls the whole way
 * to the camera.
 *
 * That is a quieter pocket than the old one and it is worth what it cost: the
 * thrower's shorts and boots (L 20-30) went from four points of separation
 * against band 3 to twenty-six to thirty-six. What it no longer does is
 * out-shout the horizon.
 *
 * At 0.56 it measures L=63.1, which is the same place in the ramp it always
 * held — one step under the mid band, now L=72, and one step over the near
 * band, now L=31. It moved because the whole ramp moved when the frame got a
 * highlight (see GROUND_BANDS), and because the hero's cast shadow is measured
 * against THIS number: at SHADOW_TONE (L=16.5) the wedge under his feet is a
 * 47-point step down off the grass he is standing on, where it used to be 27.
 */
const KEY_POOL: { ax: number; ay: number; len: number; halfH: number; val: number; sat: number; hue: number }[] = [
  { ax: 0.30, ay: 0.18, len: 3.60, halfH: 1.00, val: 0.560, sat: 1.06, hue: -4 },
]
/**
 * The rake. Shallower than `SHADOW_RAKE` because this shape is three times the
 * length of a tree's shadow: at -0.2 its far tip would climb two hundred pixels
 * and land in the sky.
 */
const POOL_RAKE = -0.09
/**
 * How far the tallest step's top edge sits above the anchor, in rig metres.
 *
 * Used as a clamp, and the clamp is the whole reason the pool cannot break the
 * band plan: the anchor is pushed down until the pool's top edge is at or below
 * band 2's crest. The pool therefore lives on the near bands and NEVER on the
 * lit strip at the horizon, at any tilt. At the tilt the review frame is shot
 * at the clamp is inactive (his feet are 74 px below the crest already); at
 * rest it slides the pool down to the grass in front of him, where he is
 * standing on the lit strip and does not need it.
 */
const POOL_TOP = 0.82
/** Authoring resolution of the lozenge, px per unit. See `buildGround`. */
const POOL_UNIT = 100

/**
 * Mown lanes running DOWNFIELD, not across it.
 *
 * A straight world line converges on the vanishing point, so these are the
 * frame's built-in diagonals — the cross-field stripes are the parallel
 * horizontal bands the review objected to, and they have been pushed down to a
 * whisper so these can carry the ground plane instead.
 */
const MOWER_LINES = 11
const MOWER_SPACING = 5
const GLINTS = 14
/** Trees along the right touchline, and the shadows they throw. */
const COPSE = 7
/** Foreground grass clumps along the bottom edge. */
const FRINGE = 6
/**
 * Reed clumps standing on the near bank.
 *
 *   "the dead horizontal river stripe at y~465 runs uninterrupted across all
 *    1365px and cuts the frame in exact halves."
 *
 * It did: the water, the warm bank line and the first grass band are three
 * full-width sprites with horizontal edges, and between the windsock at the
 * left touchline and the copse at the right there was nothing in thirteen
 * hundred pixels to put a vertical through any of them. Reeds are the cheapest
 * honest answer — they belong on a bank, they are lit by the same low sun the
 * bank is, and each one breaks the water/bank edge where it stands. Scattered,
 * not evenly spaced, so the interruption is not a second rhythm.
 */
const REEDS = 16

/**
 * How far a tree's shadow runs, as a multiple of its height.
 *
 * Long, because the sun is low: five times the height puts the sun about eleven
 * degrees up. That reaches
 * most of the way across the fairway from the right touchline, which is exactly
 * the shape the old frame had by accident and could not justify.
 */
const SHADOW_LEN = 1.7
/**
 * Radians the cast shadows dip toward the camera at their far end. Big enough
 * to read as a diagonal: a shadow lying flat at constant depth is one more
 * horizontal band, which is the thing being fixed.
 */
const SHADOW_RAKE = -0.2

export class Field {
  /** Everything from the ridges to the foreground grass. */
  readonly container = new Container()
  /** Cast shadows go here: under the actors, over the grass. */
  readonly shadowLayer = new Container()
  /** The disc, the receiver and the thrower go here. */
  readonly actorLayer = new Container()

  /**
   * The key light. The sun is low and at 0.84 of the width, so it comes from
   * the right, hard and warm, and every surface in this file shades against it.
   */
  readonly key: KeyLight

  /** Camera position, metres. z dollies downfield during a throw. */
  camX = 0
  camZ = 0
  /**
   * Camera tilt, in pixels of horizon drop. A lofted disc climbs off the top of
   * a fixed frame, so the camera looks up to hold it — which is also just what a
   * camera operator does. Everything that is pinned to the horizon moves with
   * it, so the tilt costs one addition in the projection.
   */
  camPitch = 0

  /** Scratch output of `project()`. Read immediately; never retained. */
  px = 0
  py = 0
  /** Pixels per metre at the projected point. */
  ps = 0
  /** False when the projected point is behind the camera plane. */
  pVisible = false

  private pal: EventPalette
  private rng: Rng
  private time = 0
  private windX = 0
  private windZ = 0

  private parallax = new Parallax()
  private clouds = new Container()
  private cloudGfx: Graphics[] = []
  private cloudX: number[] = []

  private treeLine = new Graphics()
  private river!: Sprite
  private riverSun!: Sprite
  private nearBank!: Graphics
  private glints: Sprite[] = []
  private glintX = new Float32Array(GLINTS)
  private glintZ = new Float32Array(GLINTS)
  private glintLen = new Float32Array(GLINTS)
  private glintPhase = new Float32Array(GLINTS)
  private reeds: Graphics[] = []
  private reedX = new Float32Array(REEDS)
  private reedSway = new Float32Array(REEDS)

  private mowers: Sprite[] = []
  private groundBands: Graphics[] = []
  private mowerTint: Hex[] = []

  /** The thrower's lit pocket. One Graphics per step of the falloff. */
  private lightPool = new Container()
  private poolSteps: Graphics[] = []


  private copse: Container[] = []
  private copseShade: Graphics[] = []
  private copseX = new Float32Array(COPSE)
  private copseZ = new Float32Array(COPSE)
  private copseH = new Float32Array(COPSE)



  private windsock = new Container()
  private sockBody = new Graphics()
  private sockShadow!: Graphics
  private sockAngle = 0
  private sockInflate = 0

  private fringe: Graphics[] = []
  private fringeSway = new Float32Array(FRINGE)

  private seeds!: ParticleSystem
  private seedTimer = 0

  constructor(pal: EventPalette, rng: Rng) {
    this.pal = pal
    this.rng = rng
    this.key = keyFromRight(pal.light, 0.95)

    this.buildDepthRamps()
    this.buildRidges()
    this.buildClouds()
    this.buildTreeLine()
    this.buildRiver()
    this.buildGround()
    this.buildCopseShadows()
    this.buildCopseTrees()
    this.buildWindsock()
    // Actors slot in here, between the grass they stand on and the foreground
    // blades they run behind.
    this.container.addChild(this.shadowLayer, this.actorLayer)
    this.buildForeground()

    this.container.interactiveChildren = false
  }

  // ------------------------------------------------------------- projection
  /**
   * Pinhole projection. Writes `px`, `py`, `ps`, `pVisible` rather than
   * returning an object, because this runs a few hundred times a frame and
   * `render` is not allowed to allocate.
   */
  project(x: number, y: number, z: number): void {
    const d = z - this.camZ + NEAR_D
    if (d <= 1.5) {
      this.pVisible = false
      this.ps = 0
      return
    }
    const s = FOCAL / d
    this.ps = s
    this.px = CENTRE_X + (x - this.camX) * s
    this.py = HORIZON_Y + this.camPitch + (CAM_H - y) * s
    this.pVisible = true
  }

  /** Screen y of the grass at depth z. The ground line, used everywhere. */
  groundY(z: number): number {
    const d = z - this.camZ + NEAR_D
    return d <= 1.5 ? 1e5 : HORIZON_Y + this.camPitch + (CAM_H * FOCAL) / d
  }

  /** Screen y of the grass at depth z with the camera level. Tilt planning. */
  groundYLevel(z: number): number {
    const d = z - this.camZ + NEAR_D
    return d <= 1.5 ? 1e5 : HORIZON_Y + (CAM_H * FOCAL) / d
  }

  /** Pixels per metre at depth z. */
  scaleAt(z: number): number {
    const d = z - this.camZ + NEAR_D
    return d <= 1.5 ? 0 : FOCAL / d
  }

  setWind(windX: number, windZ: number): void {
    this.windX = windX
    this.windZ = windZ
  }

  /**
   * Put the lit pocket under the thrower. See `KEY_POOL`.
   *
   * `x`, `y` are his projected feet and `pixelsPerMetre` is the HERO rig scale
   * — the same capped number his own cast shadow is sized by — so the pool,
   * the man and his shadow are all in one space and none of them can drift
   * against the other two.
   */
  applyLightPool(x: number, y: number, pixelsPerMetre: number, visible: boolean): void {
    this.lightPool.visible = visible
    if (!visible) return
    // Never on the lit strip: push the anchor down until the pool's top edge
    // is at or below band 2's crest.
    const crest = HORIZON_Y + this.camPitch + GROUND_BANDS[BAND_MID].top
    const py = Math.max(y, crest + POOL_TOP * pixelsPerMetre)
    for (let i = 0; i < KEY_POOL.length; i++) {
      const s = KEY_POOL[i]
      const g = this.poolSteps[i]
      g.position.set(x + s.ax * pixelsPerMetre, py + s.ay * pixelsPerMetre)
      g.scale.set(s.len * pixelsPerMetre / POOL_UNIT, s.halfH * pixelsPerMetre / POOL_UNIT)
      g.rotation = POOL_RAKE
    }
  }

  // ------------------------------------------------------------ construction
  /**
   * Precomputed colour ramps.
   *
   * Grading a colour costs an HSV round trip and allocates, so every depth-faded
   * colour the field needs is baked into a small lookup at construction. Per the
   * reference numbers the ground loses ~45% saturation across its depth range
   * while value barely moves — depth here is a saturation cue, not a value cue.
   */
  private buildDepthRamps(): void {
    const { pal } = this
    // Only the mown lanes need a depth ramp now. The ground's own value plan is
    // three flat authored colours (GROUND_BANDS), because four blind critics in
    // a row read a computed ramp as "a gradient with noise on it".
    const mower = grade(mix(pal.near, pal.light, 0.34), { satScale: 0.88 })
    for (let i = 0; i < DEPTH_STEPS; i++) {
      const d = i / (DEPTH_STEPS - 1)
      this.mowerTint.push(grade(mower, {
        satScale: 1.0 - 0.36 * d, valScale: 0.72 + 0.3 * d,
        fog: pal.haze, fogAmount: d * 0.3,
      }))
    }
  }

  /**
   * Two ridges behind the river, in two different rendering modes.
   *
   * The far one is bare contour line on the sky with no fill at all — the single
   * most distinctive trick in the reference art direction, and the cheapest.
   * The near one is filled, and unlike the previous version it is not one flat
   * value: it has a lit face wherever the rock turns toward the sun, a shade
   * face wherever it turns away, and an occlusion pool gathering along its base
   * where the tree line meets it. A single flat fill on the largest object in
   * the frame is the thing that reads as unfinished.
   */
  private buildRidges(): void {
    const { pal } = this

    // --- the sun: one flat disc ---------------------------------------------
    // It used to be a `radialGlow` bloom plus a white core sprite, and a review
    // named the mixture for what it was: "crisp vector trees, airbrushed
    // gradient hills with a canned white radial bloom, and a blurred
    // photographic foreground - three incompatible rendering languages in one
    // frame". This file now speaks one language, so the sun is a hard-edged
    // circle with a hard ring round it, the same way the trees and the canopy
    // are hard-edged shapes. It is also only a few points brighter than the sky
    // it sits in, because a bloom low in the frame out-ranks the athlete.
    // ONE disc, no rings.
    //
    // The two concentric rings sat at radius 74 and 98, which is exactly where
    // the touchline copse stands, and a blind review read the result as
    // "the tree cluster is double-drawn with a ghosted semi-transparent copy".
    // Nothing was double-drawn: two faint circles crossing seven hard tree
    // silhouettes is what a ghost looks like. The sun is also stepped down off
    // the frame's brightest value — "A hands its brightest values to things
    // that are not the subject: sun L=245, flagpole L=221, HUD yellow".
    //
    // Fogged harder than it was, for the same reason the sky came down: the
    // disc has to be the brightest thing in the frame, and at fogAmount 0.3
    // this face measured L=213 against the disc's L=211. A sun a hundred
    // pixels across sitting level with the hero is a second subject.
    //
    // 0.56 left it at L=193.0, which was a seventeen-point step under a disc
    // whose *arc* measured 211 and a two-point step under the disc's actual
    // body at 173 — so on the numbers the sun and the hero were the same
    // brightness. With the plate re-keyed to L=209.8 this came down to 0.70
    // and L=181.9.
    //
    // AND THEN THE FRAME HAD NO HIGHLIGHT IN IT. See GROUND_BANDS: capping
    // everything against the disc left a picture whose 99th percentile was
    // 153. A key light dimmer than the plane it is supposed to be lighting is
    // not restraint, it is an unlit frame — so the sun comes back up to where
    // the fairway it rakes can follow it, at fogAmount 0.50 and L=198.4.
    //
    // It is still not the subject and the arithmetic still says so. The disc's
    // plate is L=209.8: the sun is eleven points under it, the bank it sits
    // over is eight under it, and the sun is one flat hard-edged disc 44 px in
    // radius — 6,000 pixels, a third of one percent of the frame — at the far
    // right shoulder, two thirds of the width from the hero and further still
    // from the arc. No rings, no bloom, no gradient: the two concentric rings
    // that used to sit at radius 74 and 98 crossed the copse and read as
    // "the tree cluster is double-drawn with a ghosted semi-transparent copy".
    const sunDisc = new Graphics()
    const sunFace = grade(mix(Core.sunWhite, Core.paperWhite, 0.4), {
      valScale: 0.97, fog: pal.haze, fogAmount: 0.50,
    })
    /*
     * AND IT HAD TO MOVE, BECAUSE HALF THE CASTERS STOOD TO THE RIGHT OF IT.
     *
     *   "the tree cluster at x 1050-1310 casts hard shadows down-left, i.e.
     *    toward the sun, not away from it"
     *
     * Every shadow on this field rakes down and to the left — the athletes'
     * wedges, the copse's, the windsock pole's — which is correct for a sun
     * off to the right, and the copse was standing at screen x 1490 to 1840
     * with the disc at 1596. Three of the seven trees were BEYOND the light
     * they were shading away from, so their shadows ran under it. One sun, one
     * direction: the disc moves out to the frame's right shoulder and the
     * copse comes inboard (see `buildCopseShadows`) until every caster in the
     * picture is on the shaded side of it.
     */
    sunDisc.circle(1812, 318, 44).fill(sunFace)
    this.parallax.addLayer(sunDisc, { factorX: 0.012, factorY: 1 })

    /*
     * TONAL, for the same reason the clouds are.
     *
     * These two were a fixed indigo — `mix(skyAt(pal, 0.26), deepInk, …)`,
     * sampled at t=0.26 where the sky is a cool mauve. The layer carries
     * factorY 1, so it rides the camera's tilt: on any lofted throw the pitch
     * pushes both contours down into the warm band, where a cool indigo
     * hairline at L=95 crossing an orange sky at L=150 stops reading as a
     * distant range and starts reading as overhead cable. Two of them, spanning
     * the full width, crossing in front of the cloud banks.
     *
     * A contour on a sky cannot be an authored colour, because the sky it is
     * on is not a fixed colour. So it is laid on like the clouds: a dark of the
     * scene's own, at an alpha, which darkens whatever is behind it by a fixed
     * FRACTION and therefore keeps the sky's hue at every tilt. A thin wash
     * below each crest gives the line a body, so it is a range seen edge-on
     * rather than a wire strung across the frame.
     *
     * Composited on the warm band (sky L=150) the nearer contour measures
     * L=123 on the line and L=141 in the wash; on the indigo at the top of the
     * arc (L=90) the same marks measure 81 and 87. A step of twenty-seven and
     * nine, always in the sky's own colour.
     */
    const far = new Container()
    const rangeInk = mix(pal.far, Core.deepInk, 0.35)
    const contour = (g: Graphics, step: number, at: (x: number) => number): void => {
      g.moveTo(-120, at(-120))
      for (let x = -120; x <= 2060; x += step) g.lineTo(x, at(x))
      g.lineTo(2060, 560).lineTo(-120, 560).closePath()
    }
    const crestFar = (x: number): number => 300
      + Math.sin(x * 0.0027 + 0.4) * 26
      + Math.sin(x * 0.0061 + 2.1) * 12
      + Math.sin(x * 0.0143 + 4.3) * 5
    const crestFarther = (x: number): number => 272
      + Math.sin(x * 0.0019 + 2.6) * 20
      + Math.sin(x * 0.0047 + 0.9) * 10

    const ridgeFar = new Graphics()
    contour(ridgeFar, 20, crestFar)
    ridgeFar.fill({ color: rangeInk, alpha: 0.1 })
    ridgeFar.moveTo(-120, crestFar(-120))
    for (let x = -120; x <= 2060; x += 20) ridgeFar.lineTo(x, crestFar(x))
    ridgeFar.stroke({ color: rangeInk, width: 2, alpha: 0.3 })
    // A second, even fainter contour inside the first reads as a further range.
    const ridgeFarther = new Graphics()
    contour(ridgeFarther, 26, crestFarther)
    ridgeFarther.fill({ color: rangeInk, alpha: 0.06 })
    ridgeFarther.moveTo(-120, crestFarther(-120))
    for (let x = -120; x <= 2060; x += 26) ridgeFarther.lineTo(x, crestFarther(x))
    ridgeFarther.stroke({ color: rangeInk, width: 2, alpha: 0.18 })
    far.addChild(ridgeFarther, ridgeFar)
    // factorY 1 so the ridges ride the horizon exactly as the camera tilts.
    this.parallax.addLayer(far, { factorX: 0.022, factorY: 1 })

    // --- near ridge: two values and a terminator -----------------------------
    const near = new Container()
    // The hills are the MIDDLE step of the ladder that runs down the frame:
    // sky 145-161, range 89-106, wood 71, water 52-62. They were the light step
    // once, which is the fault the block below is about.
    //
    // fogAmount has now come down twice — 0.88 to 0.72 when the haze itself
    // came down with the inverted sky, and 0.72 to 0.32 here. Fog is a lerp
    // toward the haze (L=161), so it is a FLOOR on how dark a distant thing can
    // be: no amount of valScale could get this range under the sky while it was
    // being dissolved three quarters of the way into it.
    /*
     * THE MID-DISTANCE DISSOLVED INTO THE SKY.
     *
     *   "the far ridge at (700,350) samples (158,125,96) and the sky beside it
     *    at (600,380) samples (160,125,96), literally the same value, so the
     *    mid-distance dissolves"
     *
     * Measured on the capture the critic was reading: the lit ribbon under the
     * crest came out at L=156.8 and the crest rim at L=174.4, against a sky
     * that the cloud lenses bring down to L=144-146 where the range crosses
     * it. So the hills were not merely level with the sky, they were BRIGHTER
     * than it, and a range lighter than the air behind it has no depth in it at
     * all. The paragraph above was written for a pale noon sky and never
     * re-measured after the gradient was inverted.
     *
     * Under a low sun a distant range is backlit, so it goes dark and slightly
     * violet: the treeline eighty pixels below it already does exactly this at
     * L=71. At valScale 0.72 / fogAmount 0.32 the range lands at
     *
     *   rim   L 125      lit  L 106      shade  L  89
     *
     * which is 39 to 56 points under the sky it stands against and 18 to 35
     * over the wood in front of it — a real step on both sides, where there was
     * a four-point step on one and an inversion on the other. It also lands
     * clear of the modal luminance the frame's two biggest flat masses sit in,
     * so `dead_frac` is unchanged at 0.220 rather than the 0.251 a softer
     * version of this same fix measured.
     */
    const base = grade(pal.far, {
      satScale: 0.42, valScale: 0.72, hueShift: -4, fog: pal.haze, fogAmount: 0.32,
    })
    // Not `shadePair`. The shared pair drops the shade face by 26% of value,
    // which is right for something near enough to have a terminator and wrong
    // for a range dissolving into its own haze: it would put a 0.60 mass
    // directly behind the athlete's torso and eat the break the sky is giving
    // her. Two values, four points apart, is all a hill at this distance gets.
    const lit = grade(base, { valScale: 1.05, satScale: 0.92 })
    const shade = grade(base, { valScale: 0.9, satScale: 1.1 })
    // Lower and quieter than it was: the crest used to reach y 254, which is
    // exactly the band the thrower's head and shoulders now occupy.
    const crest = (x: number): number => 356
      + Math.sin(x * 0.0038 + 1.2) * 30
      + Math.sin(x * 0.0094 + 3.4) * 12
      + Math.sin(x * 0.021 + 0.7) * 5

    const g = new Graphics()
    // The whole mass in the shade value first.
    g.moveTo(-120, 560)
    for (let x = -120; x <= 2060; x += 16) g.lineTo(x, crest(x))
    g.lineTo(2060, 560).lineTo(-120, 560).closePath()
    g.fill(shade)

    // Lit faces: a ribbon under the crest wherever the slope descends to the
    // right, which is the side turned toward the sun. Where it does not, the
    // shade fill below shows through — and that edge is the terminator.
    //
    // THE RIBBON TAPERS WITH THE SLOPE. It used to be a constant 58 px deep
    // and emitted per 16 px segment, so wherever the crest levelled off the
    // ribbon simply stopped — leaving a vertical cliff between a lit quad and
    // its neighbour. A blind review found exactly what that draws:
    //
    //   "a hard-edged rectangular plateau in the hills around x 565-880 /
    //    y 340-360 that reads as an unresolved polygon rather than a landform"
    //
    // It was not a landform and it was not a mistake in the crest function: it
    // was the terminator being drawn as a butt joint. Scaling the face depth by
    // the slope makes the ribbon run to a point where the hill turns away,
    // which is what a terminator on a rounded mass actually looks like, and
    // there is no straight edge left anywhere in the range.
    const FACE = 62
    /** Slope, in px of fall per px of run, at which the face is full depth. */
    const FULL = 0.55
    let prevDepth = 0
    for (let x = -120; x < 2060; x += 16) {
      const y0 = crest(x)
      const y1 = crest(x + 16)
      const depth = FACE * clamp01((y1 - y0) / (16 * FULL))
      if (depth <= 0.5 && prevDepth <= 0.5) { prevDepth = depth; continue }
      g.moveTo(x, y0).lineTo(x + 16, y1)
        .lineTo(x + 16, y1 + depth).lineTo(x, y0 + prevDepth).closePath()
      prevDepth = depth
    }
    g.fill(lit)

    // A snowline-thin rim of direct sun exactly on the crest.
    g.moveTo(-120, crest(-120))
    for (let x = -120; x <= 2060; x += 16) g.lineTo(x, crest(x))
    // The rim comes down with the range. At 0.5 toward the key it measured
    // L=174.4 — brighter than the sky, brighter than the hills, and the
    // highest value anywhere in the mid-distance. At 0.22 it is L=125: the
    // lightest mark on the range and still twenty points under the air.
    g.stroke({ color: mix(lit, pal.light, 0.22), width: 2.5, alpha: 0.40 })

    const outline = depthOutline(0.7)
    g.moveTo(-120, crest(-120))
    for (let x = -120; x <= 2060; x += 16) g.lineTo(x, crest(x))
    g.stroke({
      color: grade(shade, { valScale: 0.84, satScale: 1.12 }),
      width: outline.width, alpha: outline.alpha * 0.8,
    })
    near.addChild(g)

    // No occlusion pool along the base any more. It was a soft vertical
    // gradient laid under the range, and against a pale mass it read as the
    // airbrush the review objected to. The tree line in front of it is a hard
    // near-black edge, which separates the two far better than a smudge did.
    this.parallax.addLayer(near, { factorX: 0.05, factorY: 1 })

    this.container.addChild(this.parallax.container)
  }

  /**
   * Cloud: TONAL STRATUS. Shade on the sky, not an object in it.
   *
   * This layer has now failed three distinct ways and the third one is the
   * instructive one.
   *
   * 1. Cumulus banks built from rows of tangent circles. A blind review listed
   *    the frame's incompatible vocabularies — "A mixes outlined characters,
   *    unoutlined trees, bubble clouds" — and the bubbles were the only thing
   *    in the scene assembled from primitives rather than drawn as a
   *    silhouette. They were also the brightest mass in the frame at L>210,
   *    parked at x 680 where the disc's arc passes, so the hero crossed them
   *    and vanished.
   *
   * 2. Drawn lenses, opaque, lit face offset DOWN. The dark mass then showed
   *    only as a rim along the top and the bank read as a sandbar.
   *
   * 3. Drawn lenses, opaque, lit face offset UP. The warm fill became the mass
   *    and the dark body became a hard navy underside: flying rocks. Solid,
   *    two-value, hard-edged shapes in the middle of a sky read as GEOLOGY,
   *    because that is exactly how the hills eighty pixels below them are
   *    drawn. The fault was never the silhouette; it was opacity.
   *
   * A cloud is the one thing in this frame that is not an object. So it is not
   * drawn as one: each bank is a flat lens laid on the sky at low alpha, which
   * darkens what is behind it by a fixed FRACTION rather than replacing it with
   * a value of its own. It therefore tracks the gradient automatically — deeper
   * against the indigo at the top, warmer against the band at the horizon — and
   * can never become a mass, because its value is defined relative to whatever
   * it lies on. A second lens offset up and toward the sun lifts the top edge
   * the same way. Nothing is ever more than about fifteen points off the sky it
   * sits in, so the disc keeps every point of its lead.
   */
  private buildClouds(): void {
    const { pal } = this
    // Shade, not paint. Applied at alpha, so these two are fractions of what is
    // behind them rather than colours in the value plan.
    const shade = mix(pal.far, Core.deepInk, 0.15)
    const sunned = pal.light

    //                x     y   scale
    const specs: [number, number, number][] = [
      [286, 178, 1.0], [1246, 238, 0.82], [640, 292, 1.15], [1802, 150, 0.7],
    ]
    const seeds = [1.7, 4.2, 0.6, 3.1]

    /**
     * One lens, as a single closed path: a tapered roll over three octaves on
     * top, a near-flat sagging base underneath. Long and low, because evening
     * stratus is, and because a tall shape in the upper third is a shape the
     * disc has to fly around.
     */
    const roll = (t: number, seed: number): number => 0.58
      + 0.24 * Math.sin(t * 8.7 + seed)
      + 0.15 * Math.sin(t * 3.3 + seed * 1.9)
      + 0.09 * Math.sin(t * 19.1 + seed * 0.7)

    const lens = (
      g: Graphics, hw: number, h: number, seed: number, dx: number, dy: number, k: number,
    ): void => {
      const N = 56
      g.moveTo(dx - hw * k, dy)
      for (let i = 0; i <= N; i++) {
        const t = i / N
        const x = -hw + t * 2 * hw
        const taper = Math.pow(Math.sin(Math.PI * t), 0.5)
        g.lineTo(dx + x * k, dy - h * taper * roll(t, seed) * k)
      }
      for (let i = N; i >= 0; i--) {
        const t = i / N
        const x = -hw + t * 2 * hw
        const sag = Math.pow(Math.sin(Math.PI * t), 0.7)
          * (0.12 + 0.07 * Math.sin(t * 5.1 + seed * 0.8))
        g.lineTo(dx + x * k, dy + h * sag * k)
      }
      g.closePath()
    }

    for (let i = 0; i < specs.length; i++) {
      const [x, y, scale] = specs[i]
      const g = new Graphics()
      const hw = 186 + (i % 2) * 46
      const h = 40 + (i % 3) * 11

      // The bank's own shade.
      lens(g, hw, h, seeds[i], 0, 0, 1)
      g.fill({ color: shade, alpha: 0.38 })
      // The top, where the low sun still reaches: the same lens offset up and
      // toward the light, laid over the shade rather than beside it. Composited
      // against a sky at L=110 the bank measures roughly L=96 in the body and
      // L=119 along the top — fourteen points under and nine points over, which
      // is a cloud and is ninety points short of the disc.
      lens(g, hw, h, seeds[i], hw * 0.04, -h * 0.2, 0.86)
      g.fill({ color: sunned, alpha: 0.24 })

      g.position.set(x, y)
      this.clouds.addChild(g)
      g.scale.set(scale)
      this.cloudGfx.push(g)
      this.cloudX.push(x)
    }
    this.container.addChild(this.clouds)
  }

  /**
   * The tree line on the far bank: three SILHOUETTE BANDS, not a stamp field.
   *
   * What was here before was thirty-odd overlapping crowns, all graded from the
   * same base toward the same haze, which put the whole band inside about five
   * points of value. A neutral review read it exactly as it was built:
   *
   *   "the treeline is 30-odd overlapping blobs separated by maybe 5% value,
   *    which resolves as noise rather than silhouette."
   *
   * The fix is value, not detail. Three tiers, and the steps between them are
   * enormous — roughly 0.60, 0.36 and 0.19 in value — so at any size the band
   * resolves into three strata instead of one texture.
   *
   * The two far tiers are drawn as CONTINUOUS canopy masses: one filled polygon
   * each, with a rolling profile that climbs toward the right. A distant wood
   * is a shape, and drawing individual crowns into it is what produced the
   * noise. Only the near tier — the one on the waterline, near-black — is built
   * from individual trees, because that is the only tier at which a silhouette
   * can carry a crown at all.
   *
   * Every tier's profile climbs left to right. That climb is one of the frame's
   * four diagonals and it lifts the dead-flat horizon the review objected to.
   *
   * Authored once at 10 px per metre with its origin on the ground at the far
   * bank, then positioned and uniformly scaled each frame. One Graphics, one
   * transform write, however far the camera dollies.
   */
  private buildTreeLine(): void {
    const { pal } = this
    const g = this.treeLine
    const M = 10
    const FROM = -74
    const TO = 74
    const skyBehind = skyAt(pal, 0.4)

    /**
     * Canopy profile: average height plus a left-to-right climb plus three
     * octaves of roll. Metres.
     *
     * `climb` is measured over the 88 metres the lens actually sees at this
     * depth, not over the authored span, because a rise spread across the part
     * of the band that is off screen is a rise nobody can see — and this climb
     * is the whole point. It is what lifts the treeline off the dead-flat
     * horizontal the composition review objected to.
     */
    const VIS = 44
    const climb = (x: number): number => {
      const t = clamp01((x + VIS) / (VIS * 2))
      return t * t
    }
    const profile = (
      x: number, base: number, rise: number, rough: number, seed: number,
    ): number => base + rise * climb(x) + rough * (
      Math.sin(x * 0.082 + seed) * 0.52
      + Math.sin(x * 0.213 + seed * 1.7) * 0.31
      + Math.sin(x * 0.51 + seed * 0.43) * 0.17
    )

    /** One continuous canopy mass, emitted as a single closed path. */
    const emitCanopy = (
      lift: number, base: number, rise: number, rough: number, seed: number,
    ): void => {
      const by = -lift * M
      g.moveTo(FROM * M, by + 4 * M)
      for (let x = FROM; x <= TO; x += 1.4) {
        g.lineTo(x * M, by - profile(x, base, rise, rough, seed) * M)
      }
      g.lineTo(TO * M, by + 4 * M).closePath()
    }

    // Heights are roughly a third of what they were, and that is a composition
    // decision rather than a botanical one. The band used to stand eleven
    // metres and span 280 px of screen, which put a busy dark mass across
    // exactly the part of the sky the thrower's head and shoulders now occupy
    // and gave the disc nothing but treeline to fly against. A hedgerow and
    // scrub on the far bank keeps the seam — which the value plan needs — and
    // gives the pale band back.

    // --- tier 1: the far wood ------------------------------------------------
    // Fogged nearly all the way into the sky it sits against, so it is a pale
    // mass. It exists to give the dark tiers something to be dark against.
    //
    // Re-keyed with the sky. The fog these tiers dissolve into came down by
    // seventy points of luminance, so the old fogAmounts would have landed
    // tier 1 at L=137 against hills at L=141 — two masses inside four points,
    // which is the "no step you can point to" failure one layer further back.
    // The ladder is authored explicitly now: hills 141, far wood 110, middle
    // wood 80, near wood 41. Four steps, none of them under twenty-five points.
    emitCanopy(1.0, 2.2, 1.2, 0.34, 1.3)
    g.fill(grade(pal.mid, {
      ...graphicDepth(0.9), valScale: 1.9, hueShift: 8, fog: skyBehind, fogAmount: 0.32,
    }))

    // --- tier 2: the middle wood ---------------------------------------------
    // valScale 1.35 -> 1.08, which is L=82 -> L=70, and the reason is the light
    // strip below it rather than anything about this band. With the grass at
    // L=112 and the far wood at L=112, an L=82 middle wood sat exactly where
    // the sky's own mass sits: `score_frame.py` found its modal luminance at
    // L=90 with a +-13 window, and this band, the grass and a third of the sky
    // were all inside it — 28% of the frame measuring as unspent. Dropping it
    // to 70 turns the horizon into light / dark seam / light, which is the
    // structure the athletes' heads and torsos are cut against.
    emitCanopy(0.5, 1.8, 1.0, 0.42, 4.1)
    g.fill(grade(pal.mid, {
      ...graphicDepth(0.5), valScale: 1.08, hueShift: 4, fog: pal.haze, fogAmount: 0.18,
    }))

    // --- tier 3: the near wood, on the waterline -----------------------------
    // Near-black, backlit, and the only tier drawn as individual trees. Twelve
    // of them, with a skirt tying them into one mass so the band still reads as
    // woodland rather than as a row of separate symbols.
    const dark = grade(pal.mid, { valScale: 0.86, satScale: 1.12 })
    const places = scatter({
      count: 12, from: FROM + 4, to: TO - 4, seed: 0x7a3955,
      scaleRange: [0.7, 1.3], variants: 3,
    })
    const trees = places.map((p) => {
      // The near tier climbs too, so all three profiles agree on the diagonal.
      // Taller, and the skirt below them is thinner, because this tier is the
      // ONE value inversion left in the lower half of the frame — near-black
      // sitting directly above grass at L=92 — and a dark band is a fault
      // where a row of dark TREES is a landscape. A blind review read the
      // previous proportions as a third olive stripe: "the ping-ponging olive
      // ground bands ... receding nowhere". Two thirds of that band was skirt.
      const h = (1.9 + 1.4 * climb(p.x)) * p.scale
      return { x: p.x, h, w: h * (0.34 + p.jitter * 0.22), conifer: p.variant < 2 }
    })

    /*
     * ONE `fill()` PER CONTOUR. THE PREVIOUS VERSION DREW THIS BAND AS
     * WIREFRAME, AND TWO BLIND REVIEWS CALLED IT PLACEHOLDER ART.
     *
     *   "A's horizon 'trees' are unfilled open-stroke wireframe triangles and
     *    circle-clusters — literal placeholder vector paths left on screen."
     *   "stroke-only, unfilled wireframe pylons ... sitting next to
     *    solid-filled trees — a work-in-progress tell no shipped frame would
     *    survive."
     *
     * They were right, and the mechanism is worth writing down because nothing
     * in the source looked wrong. The whole band — the skirt, then twelve trees
     * of three stacked triangles or four overlapping circles each — was emitted
     * as ONE path and closed with a single `fill()`. Pixi fills a path of many
     * closed contours by EVEN-ODD: wherever two contours overlapped, the
     * overlap came out as a hole, and a conifer is three triangles that overlap
     * by design. Measured on captures/flyingdisc.png, the interior of the tree
     * at x=470 reads #505447 — pixel-identical to the mid wood forty rows above
     * it — while its outline reads #766448. The fill was never there.
     *
     * Then a second `emitTrees()` stroked the same path for a backlight, so
     * what survived was the construction lines: the internal edges where the
     * stacked triangles and the crown circles cross. That is the "wireframe".
     * It was invisible while the sky above it was pale; inverting the sky put a
     * warm L=102 line on an L=82 ground and made it the loudest thing at the
     * horizon. The copse trees a hundred pixels away were never affected —
     * `Graphics.circle()` is its own primitive there — which is exactly the
     * "wireframe trees next to solid-filled trees" the second critic saw.
     *
     * So: every contour gets its own `fill()`, which no winding rule can turn
     * into a hole, and the stroke pass is gone. This file already argues the
     * case against that stroke for the copse — "a backlit tree against a pale
     * sky is a silhouette; a silhouette does not need an outline, and one that
     * does not follow the shape is a halo" — and this outline did not follow
     * the shape. Where the sun is is carried by the hills, the copse and every
     * shadow on the field; it does not need restating on a band twelve pixels
     * tall.
     */
    // Skirt: the undergrowth the trunks stand in, so the band has a base.
    g.moveTo(FROM * M, 0)
    for (let x = FROM; x <= TO; x += 3) {
      g.lineTo(x * M, -(0.42 + 0.2 * Math.sin(x * 0.19 + 2.2)) * M)
    }
    g.lineTo(TO * M, 0).closePath().fill(dark)

    for (const t of trees) {
      const bx = t.x * M
      if (t.conifer) {
        for (let i = 0; i < 3; i++) {
          const s = i / 3
          const yTop = -t.h * M * (0.46 + s * 0.54)
          const yBot = -t.h * M * s * 0.54
          const half = t.w * M * 0.5 * (1 - s * 0.5)
          g.moveTo(bx, yTop).lineTo(bx + half, yBot).lineTo(bx - half, yBot)
            .closePath().fill(dark)
        }
      } else {
        const crownY = -t.h * M * 0.62
        const r = t.w * M * 0.64
        g.rect(bx - M * 0.17, crownY, M * 0.34, -crownY).fill(dark)
        g.circle(bx, crownY, r).fill(dark)
        g.circle(bx - r * 0.7, crownY + r * 0.3, r * 0.64).fill(dark)
        g.circle(bx + r * 0.74, crownY + r * 0.24, r * 0.6).fill(dark)
        g.circle(bx - r * 0.08, crownY - r * 0.58, r * 0.56).fill(dark)
      }
    }

    this.container.addChild(g)
  }

  /**
   * The river.
   *
   * Under a low sun the water is DARK, not bright: at a grazing angle it
   * reflects the near-black treeline standing on the far bank, and looking
   * straight down at the near bank it reflects the dusty navy zenith. So the
   * river joins the treeline as one dark seam across the middle of the frame,
   * which is what gives the squint test something to separate.
   *
   * The exception is the sun's glitter path — one narrow warm band, the single
   * brightest thing below the horizon. It runs where the dark seam meets the
   * field and is what stops the two dark masses fusing into a slab.
   */
  private buildRiver(): void {
    const { pal, rng } = this
    const sunPath = mix(pal.far, pal.light, 0.58)
    // TWO FLAT BANDS, not four, and not a vertical gradient.
    //
    // Hard steps were right; four of them in sixteen pixels were not. Measured
    // down the middle of captures/flyingdisc.png, the twenty-four pixels from
    // the foot of the treeline to the first blade of grass carried six separate
    // values — L 40, 71, 60, 146, 66, 92 — and a blind review read them off the
    // screen as a rendering fault rather than as a river:
    //
    //   "the current stack of unmotivated parallel navy/blue/tan stripes at
    //    y 455-470 looks like z-fighting"
    //
    // At this camera height the river cannot afford more than two ideas: the
    // water, and the one band of it the sun is on. Four pixels is not a band,
    // it is a scanline. So the far shallows and the near deep merge into one
    // dark water value, and the sun path keeps its own step — which is the one
    // that means something, because it is the brightest mark below the horizon
    // and the thing that stops the treeline and the field fusing into a slab.
    const water = verticalGradient([
      { t: 0, c: grade(pal.far, { satScale: 1.12, valScale: 0.8 }) },
      { t: 0.299, c: grade(pal.far, { satScale: 1.12, valScale: 0.8 }) },
      { t: 0.3, c: sunPath },
      { t: 0.52, c: sunPath },
      { t: 0.521, c: grade(pal.far, { satScale: 1.24, valScale: 0.56 }) },
      { t: 1, c: grade(pal.far, { satScale: 1.24, valScale: 0.56 }) },
    ], 128)
    this.river = new Sprite(water)
    this.container.addChild(this.river)
    /*
     * AND THE WATER STILL HAD NO DIRECTION IN IT.
     *
     *   "a hard unmodulated blue-grey stripe running the full width at y~490"
     *
     * Unmodulated is the operative word and a vertical gradient cannot fix it:
     * every column of this river carried the identical three values across all
     * 1920 px, so whatever the steps did down the band they did nothing along
     * it. There is one sun in this scene and it is at x=1812; the water under
     * it is where its path lands, and by the left touchline there is no path
     * at all. One horizontal wash says both, in the same warm the bank and the
     * sun rake are keyed to, and it costs one sprite.
     */
    const lane = mix(sunPath, pal.light, 0.45)
    this.riverSun = new Sprite(horizontalGradient([
      { t: 0, c: lane, a: 0 },
      { t: 0.46, c: lane, a: 0.1 },
      { t: 0.82, c: lane, a: 0.5 },
      { t: 1, c: lane, a: 0.72 },
    ], 128))
    this.container.addChild(this.riverSun)

    /*
     * Hard-edged slivers. An additive soft dot on water is a lens artefact, and
     * this frame has committed to flat shapes.
     *
     * That paragraph was written for this layer and then only half applied:
     * the texture stayed `softDot` and the sprite stayed `blendMode = 'add'`.
     * Additive is not a value, it is an increment, so the only way to know what
     * these measure is to composite them — and they measured L=229.6 at their
     * breathing peak over the river's own sun path (L=146.3). That is TWENTY
     * POINTS ABOVE THE DISC, on fourteen slivers roughly sixty pixels long, in
     * the frame's own dead centre. The whole sky inversion exists to make the
     * gold the brightest thing in the picture; an additive sparkle silently
     * took it back.
     *
     * So they are flat now, in the sky's own key, at a value the palette sets
     * rather than one the blend mode computes: raw L=165.9, composited at the
     * top of the breath L=163.3, which is +46.4 under the disc's plate and one
     * step under the hill crest's rim. Still the brightest thing below the
     * horizon, which is what the water is for; no longer a second subject.
     */
    const glintTex = softDot(grade(pal.light, { valScale: 0.86 }), 32, 0.96)
    for (let i = 0; i < GLINTS; i++) {
      const s = new Sprite(glintTex)
      s.anchor.set(0.5)
      this.container.addChild(s)
      this.glints.push(s)
      this.glintX[i] = rng.range(-52, 52)
      this.glintZ[i] = rng.range(RIVER_Z0 + 1.5, RIVER_Z1 - 1.5)
      this.glintLen[i] = rng.range(1.2, 3.6)
      this.glintPhase[i] = rng.range(0, Math.PI * 2)
    }

    // Near bank: trodden grass and gravel where the field ends, catching the low
    // sun full on. It is the warm line that separates the dark water from the
    // cool field.
    //
    // ONE value, for the same reason the river now has two. It was two, and the
    // step between them was four points of luminance across three pixels —
    // which buys nothing and costs one more line in a part of the frame that
    // was already being read as z-fighting.
    /*
     * AND IT IS THE TOP OF THE LIGHT RAMP NOW, AND ITS EDGE UNDULATES.
     *
     * Two things, one shape. At valScale 1.12 this measured L=149.6 and it was
     * the brightest large surface anywhere below the horizon in a frame whose
     * p99 was 153 — see GROUND_BANDS. It is the nearest ground to the low sun
     * and the first thing that sun touches, so it takes the top of the ramp at
     * L=201.3, one step over the sun rake band beneath it (L=196.5) and eight
     * under the disc's plate.
     *
     * And it was a Sprite: a rectangle, so its top edge was a ruled line
     * 1920 px long lying directly on two other ruled lines.
     *
     *   "a hard unmodulated blue-grey stripe running the full width at y~490 —
     *    a painted wall rather than water"
     *
     * Reeds were added last pass and the line was still read as ruled, because
     * the reeds were 9-21 px of bank-coloured tuft ON a bank-coloured band.
     * The edge itself has to move. So this is a Graphics with a crest built the
     * way every ground band's crest is built — two sines an octave apart — and
     * the strip of it that shows between the water and the sun rake's own
     * crest now varies from nothing to sixteen pixels along the width.
     *
     * It is drawn as a 240 px slab rather than a measured depth because the
     * sun rake band paints over everything below its crest at every camera
     * tilt the event can reach, so the bank's lower edge is never on screen.
     */
    const bank = grade(mix(pal.near, pal.light, 0.4), { satScale: 0.62, valScale: 1.5 })
    this.nearBank = new Graphics()
    this.nearBank.moveTo(-1920, bankCrest(-1920))
    for (let x = -1920; x <= 1920; x += 20) this.nearBank.lineTo(x, bankCrest(x))
    this.nearBank.lineTo(1920, 240).lineTo(-1920, 240).closePath().fill(bank)
    this.container.addChild(this.nearBank)

    // Reeds. See `REEDS`. Authored at 10 px per metre like the trees, rooted
    // at y = 0 so the bank line runs through their feet, and drawn in the
    // bank's own light because they stand against the dark water rather than
    // against the grass — a dark tuft on a dark river is not an interruption,
    // it is more river.
    const reedLit = grade(bank, { valScale: 1.02, satScale: 0.92 })
    const reedShade = grade(bank, { valScale: 0.62, satScale: 1.15 })
    for (let i = 0; i < REEDS; i++) {
      // Scattered along the bank, clustered rather than spaced: even spacing
      // would replace one horizontal rhythm with a second.
      // +-26 m at this depth is +-1130 px, which is the frame and a little
      // pan either side. The glints use +-52 because most of them are meant to
      // fall outside it; these are meant to land ON the line they break.
      this.reedX[i] = rng.range(-26, 26)
      this.reedSway[i] = rng.range(0, Math.PI * 2)
      // 0.7-1.4 m. At 27 px per metre on the bank that is 19-38 px of
      // vertical standing UP off a water-to-grass step about six pixels deep,
      // so each clump crosses the water band and breaks the foot of the far
      // wood as well. It was 0.35-0.85 m, which put the tallest of them at
      // 23 px — a tuft sitting on the line rather than a mark through it, and
      // the stripe was reported as a painted wall for a second round running.
      // Still nowhere near a second treeline: the copse beside them stands at
      // 250 px.
      const h = rng.range(7, 14)
      const w = rng.range(1.6, 3.6)
      const g = new Graphics()
      // A fan of blades: one closed silhouette, one fill, the same rule every
      // shape in this file follows.
      const blades = 3 + (i % 3)
      for (let b = 0; b < blades; b++) {
        const t = blades === 1 ? 0 : (b / (blades - 1)) * 2 - 1
        const tipX = t * w
        const tipY = -h * (1 - 0.3 * Math.abs(t))
        g.moveTo(-0.9, 0)
          .quadraticCurveTo(tipX * 0.35, tipY * 0.6, tipX, tipY)
          .quadraticCurveTo(tipX * 0.5, tipY * 0.55, 0.9, 0)
          .closePath()
          .fill(b < blades / 2 ? reedShade : reedLit)
      }
      this.reeds.push(g)
      this.container.addChild(g)
    }
  }

  /**
   * The grass: three flat value bands and the downfield mower lines.
   *
   * See GROUND_BANDS for why this is three drawn shapes rather than thirty
   * depth-sorted stripes on a computed ramp. Each band is one closed shape with
   * an undulating crest, authored across twice the screen width so it can slide
   * a little against the camera's lateral pan, and filled all the way to the
   * bottom of the frame — nearer bands paint over farther ones, so the only
   * thing the eye sees of each is its crest and the strip below it. That is a
   * designed surface. Three overlapping shapes, three values, two steps you can
   * put a finger on.
   */
  private buildGround(): void {
    for (let i = 0; i < GROUND_BANDS.length; i++) {
      const { colour, wave, phase } = GROUND_BANDS[i]
      const g = new Graphics()
      // The crest. Two sines an octave apart, no more: a field is not a dune
      // range, and the undulation is here to stop the step reading as a ruled
      // line, not to pretend the pitch is hilly.
      g.moveTo(-1920, 0)
      for (let x = -1920; x <= 1920; x += 24) {
        g.lineTo(x, Math.sin(x * 0.0021 + phase) * wave + Math.sin(x * 0.0053 + phase * 2.3) * wave * 0.4)
      }
      g.lineTo(1920, 1300).lineTo(-1920, 1300).closePath()
      g.fill(colour)
      // Grass catching the low sun along the crest. One thin lit line per step
      // is how the reference frames that win draw a terrace edge, and it is the
      // only mark allowed on this plane: it describes the step it sits on.
      if (i > 0) {
        g.moveTo(-1920, Math.sin(-1920 * 0.0021 + phase) * wave
          + Math.sin(-1920 * 0.0053 + phase * 2.3) * wave * 0.4)
        for (let x = -1920; x <= 1920; x += 24) {
          g.lineTo(x, Math.sin(x * 0.0021 + phase) * wave + Math.sin(x * 0.0053 + phase * 2.3) * wave * 0.4)
        }
        g.stroke({ color: GROUND_BANDS[i - 1].colour, width: 2.5, alpha: 0.5 })
      }
      this.container.addChild(g)
      this.groundBands.push(g)
    }

    // The thrower's lit pocket. Over the bands, UNDER the mown lanes and under
    // the touchline trees' shadows, which is the order the fiction needs: the
    // lanes still describe the surface the light falls on, and a tree shadow
    // still crosses the light rather than the light erasing it.
    //
    // Authored once in a unit box — near end blunt at x = -1, far tip at
    // x = +1, half-height 1 — so one path serves every depth and every step,
    // exactly as the copse shadows do. `applyLightPool` supplies the length,
    // the width and the rake.
    //
    // Drawn at POOL_UNIT px per unit rather than at 1, and scaled back down.
    // Pixi flattens a curve when the path is BUILT, in the path's own units,
    // and falls back to its eight-segment minimum for anything short: a
    // one-unit lozenge blown up to a thousand pixels is an octagon. The trees
    // are authored at 10 px per metre for the same reason.
    for (const step of KEY_POOL) {
      const U = POOL_UNIT
      const g = new Graphics()
      g.moveTo(U, 0)
        .quadraticCurveTo(0.42 * U, -0.60 * U, -0.16 * U, -0.88 * U)
        .quadraticCurveTo(-0.72 * U, -1.0 * U, -0.96 * U, -0.46 * U)
        .quadraticCurveTo(-1.10 * U, 0, -0.96 * U, 0.46 * U)
        .quadraticCurveTo(-0.72 * U, 1.0 * U, -0.16 * U, 0.88 * U)
        .quadraticCurveTo(0.42 * U, 0.60 * U, U, 0)
        .closePath()
        .fill(grade(GROUND_BANDS[BAND_LIT].colour, {
          valScale: step.val, satScale: step.sat, hueShift: step.hue,
        }))
      this.lightPool.addChild(g)
      this.poolSteps.push(g)
    }
    this.lightPool.visible = false
    this.container.addChild(this.lightPool)

    // Mown lanes. Each is one rotated sprite laid along a world line from the
    // camera to the far bank, so it converges on the vanishing point — the only
    // geometry in the scene that is a true diagonal by construction. The
    // texture fades toward the far end, which is `depthOutline`'s rule applied
    // to a line that spans every depth at once.
    const lane = horizontalGradient([
      { t: 0, c: 0xffffff, a: 1 },
      { t: 0.45, c: 0xffffff, a: 0.62 },
      { t: 1, c: 0xffffff, a: 0.08 },
    ], 128)
    for (let i = 0; i < MOWER_LINES; i++) {
      const s = new Sprite(lane)
      s.anchor.set(0, 0.5)
      this.container.addChild(s)
      this.mowers.push(s)
    }
  }

  /*
   * Ground decals: REMOVED, not tuned.
   *
   * Four blind critics, none of whom saw the others, and all four named the
   * same population:
   *
   *   "a dozen soft pale and dark ellipses scattered across (600-1365, 420-700)"
   *   "pale elliptical blobs at random scales that describe nothing - not cloud
   *    shadow, not wear, not mow lines"
   *   "kill the soft ellipse 'stains'"
   *
   * The last pass hardened them from 0.4 to 0.9 and halved the count, and they
   * were still read as stains. The mistake was not their edge or their number,
   * it was that a flat-shape frame has no vocabulary for a mark that means
   * nothing. The ground's value plan is three authored bands now; the marks
   * that say the surface has a texture are the mown lanes, which converge on
   * the vanishing point and therefore describe something.
   */

  /**
   * The long shadows the touchline trees rake back across the fairway.
   *
   * This is the frame's boldest dark shape, and in the previous version it was
   * a bug. It was drawn with a horizontal gradient, which is soft along its
   * length but razor-hard top and bottom, and the trees casting it sat at 20-26
   * metres off the axis — past the right edge of the lens at that depth. So a
   * hard-edged dark wedge slashed across the field from nothing visible, and a
   * neutral review said the obvious thing about it:
   *
   *   "the one bold shape in A reads as a bug, not a choice."
   *
   * Three changes make it a choice:
   *
   *   1. The trees move inboard to 12-18 metres, comfortably inside the frame
   *      at the depth they stand, so the caster is always on screen above its
   *      own shadow.
   *   2. It is a DRAWN SHAPE, not a stretched radial gradient.
   *   3. It is long (the sun is low) and RAKED toward the camera, so it runs
   *      diagonally down and left across the fairway instead of lying flat as
   *      one more horizontal band.
   *
   * Point 2 was wrong for one more round, and two blind reviews caught it:
   *
   *   "the Gaussian-blurred shadow smear from x 500 to x 1170 clashes with
   *    every other hard 2px navy-stroked edge in the piece"
   *   "an airbrushed ellipse ... which is both the darkest mass in the lower
   *    half and detached from the feet"
   *
   * A 128 px dot at 0.86 hardness is hard *at 128 px*. Stretched to the eight
   * hundred pixels a twenty-metre shadow covers, its falloff is a hundred
   * pixels wide and seven of them overlapping is a photographic blur laid over
   * a hard-edged vector scene. So each one is a closed polygon now: a tapered
   * lozenge, wide and blunt at the trunk, narrowing to a point at the far end,
   * authored at 10 px per metre like the trees and scaled by the field. No
   * gradients, no textures, one rendering language.
   */
  private buildCopseShadows(): void {
    const { rng } = this
    // Flat, opaque, and exactly the mid band's own value. Seven multiply
    // wedges at 0.21 stacked into "a 600px multi-lobed shadow smear with
    // sheared hard edges" — the previous pass hardened their outlines and
    // missed that the fault was the STACK, not the edge: overlapping
    // transparencies make a gradient no matter how crisp each piece is. At
    // alpha 1 in a single flat colour, seven overlapping wedges are one shape
    // with one value, which is what "a hard-edged stylised shadow instead of
    // the blurred streak" asks for.
    //
    // It used to be `GROUND_BANDS[1].colour` — the mid band's own value, which
    // is not a shadow, it is a second copy of a ground plane. See SHADOW_TONE.
    //
    // FAR, not near. These lie at forty-six to seventy metres and they were
    // the frame's strongest contrast step; the hero's is now the darkest mark
    // in the picture and these are the same material seen through more air.
    const shade = FAR_SHADOW_TONE

    const places = scatter({ count: COPSE, from: 46, to: 70, seed: 0x2f1d05, scaleRange: [0.8, 1.45] })
    for (let i = 0; i < COPSE; i++) {
      const p = places[i]
      this.copseZ[i] = p.x
      // Inboard, so the tree that throws each shadow is inside the frame AND
      // on the shaded side of the sun: at 12-18 m the cluster reached screen
      // x 1840, past the disc at 1596, and its shadows ran back underneath the
      // light. See the sun note in `buildSky`.
      this.copseX[i] = 8.5 + p.jitter * 4
      // Shorter than they were, for the same reason the tree line is: from a
      // camera 2.1 m off the grass a 10 m poplar at fifty metres stands 400 px
      // and owns the sky. These are the right-hand balance to the thrower, not
      // the subject.
      this.copseH[i] = 3.6 * p.scale + rng.range(0, 0.8)
      // Authored in a unit box running from the trunk at x = 0 out to x = -1,
      // half-height 0.5 at the trunk: the transform in `apply` supplies the
      // real length and width, so one shape serves every depth.
      const g = new Graphics()
      g.moveTo(0, -0.42)
        .quadraticCurveTo(-0.5, -0.5, -0.86, -0.19)
        .quadraticCurveTo(-0.97, -0.07, -1, 0)
        .quadraticCurveTo(-0.97, 0.07, -0.86, 0.19)
        .quadraticCurveTo(-0.5, 0.5, 0, 0.42)
        .closePath()
        .fill(shade)
      g.alpha = 1
      this.container.addChild(g)
      this.copseShade.push(g)
    }
  }

  /**
   * The trees themselves. Tall, narrow, in front of the river and rooted on the
   * grass, so they give the empty upper field a vertical event as well as
   * something to cast. Two values each, like everything else under the key.
   */
  private buildCopseTrees(): void {
    const { pal, key } = this
    const M = 10
    const base = grade(pal.mid, {
      ...graphicDepth(0.36), hueShift: 14, fog: pal.haze, fogAmount: 0.2,
    })
    const { lit, shade } = shadePair(base, key)
    const trunk = grade(shade, { valScale: 0.74, satScale: 1.2 })

    for (let i = 0; i < COPSE; i++) {
      const h = this.copseH[i] * M
      const w = h * (i % 3 === 0 ? 0.42 : 0.26)
      const c = new Container()
      const g = new Graphics()

      /*
       * THE TRUNK TOP GOES INSIDE THE CROWN.
       *
       *   "tree trunks drawn over their own canopies at x 1050-1160"
       *
       * Two separate faults, and this is the cheaper one. A broadleaf's crown
       * bottoms out at -0.442 h and the trunk stopped at -0.42 h, so between
       * them ran a two-hundredth of the tree's height of open sky — a floating
       * crown with a post under it, which at this size reads as the post being
       * in front. It runs to -0.56 h now, well inside both crown forms, and
       * the crown is filled after it so nothing of it shows above the leaves.
       */
      g.rect(-w * 0.055, -h * 0.56, w * 0.11, h * 0.56).fill(trunk)
      if (i % 3 === 0) {
        // Broadleaf: a lobed crown with the sun on its upper right.
        const cy = -h * 0.66
        const r = w * 0.52
        g.circle(0, cy, r).circle(-r * 0.62, cy + r * 0.34, r * 0.6).circle(r * 0.6, cy + r * 0.3, r * 0.58)
        g.fill(shade)
        g.circle(r * 0.3, cy - r * 0.26, r * 0.66).circle(r * 0.78, cy + r * 0.12, r * 0.36)
        g.fill(lit)
      } else {
        // Poplar: a tall spindle, lit down its right flank.
        g.ellipse(0, -h * 0.6, w * 0.5, h * 0.42).fill(shade)
        g.ellipse(w * 0.15, -h * 0.64, w * 0.3, h * 0.34).fill(lit)
      }
      // NO outline pass.
      //
      // A review asked for one drawing language — "A mixes outlined
      // characters, unoutlined trees, bubble clouds" — and the answer to it is
      // NOT to ring these in ink. The language this file speaks is: a closed
      // hard-edged silhouette in a shade value, a lit face over it on the sun
      // side, and at most one thin warm rim along the terminator. The hills do
      // it, the far wood does it, the clouds do it now that they are drawn
      // lenses instead of stacked circles, and these trees do it. The
      // characters are outlined because `depthOutline` gives an outline to
      // what is NEAR and takes it away with distance, which is the same rule
      // stated in the same terms.
      //
      // This line used to stroke a poplar-shaped ellipse around EVERY tree,
      // including the broadleaves, whose crowns are three circles — so a large
      // translucent ring floated around each of them, attached to nothing. Two
      // rounds of critique found it and both read it as a rendering bug:
      // "the tree cluster is double-drawn with a ghosted semi-transparent
      // copy", "thin light arcs ringing the tree clusters". A backlit tree
      // against a pale sky is a silhouette; a silhouette does not need an
      // outline, and one that does not follow the shape is a halo.

      c.addChild(g)
      this.copse.push(c)
    }

    /*
     * AND THE OTHER FAULT WAS THE PAINTER'S ORDER, WHICH WAS INVERTED.
     *
     * `scatter` returns its places in increasing depth, so `copseZ[0]` is the
     * NEAREST tree at forty-six metres and `copseZ[6]` the farthest at seventy
     * — and the loop above added them to the display list in that order, which
     * draws the farthest tree LAST, on top of everything in front of it. Crop
     * the cluster out of `captures/flyingdisc.png` at 4x and it is exactly what
     * the critic reported: a hard dark bar running down over the lit face of a
     * crown that stands four metres closer to the camera. Nothing was drawn
     * over its own canopy; a distant trunk was drawn over its neighbour's.
     *
     * Sorted far to near, so the cluster reads as a cluster with depth in it.
     * `this.copse` keeps its build order because `apply` indexes it against
     * `copseX/Z/H`; only the z-order changes.
     */
    const order = this.copse.map((_, i) => i).sort((a, b) => this.copseZ[b] - this.copseZ[a])
    for (const i of order) this.container.addChild(this.copse[i])
  }

  /*
   * Cloud ground-shadows: REMOVED, not tuned.
   *
   * Two 128 px radial gradients at 0.4 hardness, stretched to forty metres of
   * grass. Three independent blind reviews took them apart, and between them
   * they named every reason this idea cannot work in this frame:
   *
   *   "the Gaussian-blurred shadow smear from x 500 to x 1170 clashes with
   *    every other hard 2px navy-stroked edge in the piece"
   *   "a formless brown smear ... that has no visible caster and points at
   *    nothing"
   *   "the darkest mass in the lower half"
   *
   * The caster was there, pinned overhead — but pinned in the CLOUD layer's
   * screen space, which parallaxes on its own factor, so the two only lined up
   * by accident. And the frame's darkest dark is spent on the athlete now.
   * A scene that has committed to hard-edged flat shapes has no place to put a
   * four-hundred-pixel airbrush stroke.
   */

  /*
   * Gusts: REMOVED. Eight more soft ellipses drifting over the grass at 0.14,
   * in the same population the critics called stains. The windsock, the seed
   * heads and the disc's own drift carry the wind.
   */

  /**
   * A windsock on the near bank. The HUD gives the player a diagram; this gives
   * them its meaning without reading anything.
   *
   * It does not use the athletes' pink. That hue is reserved for the player and
   * a saturated windsock out-ranking the protagonist is exactly the failure the
   * review named.
   */
  private buildWindsock(): void {
    const { pal, key } = this
    const M = 10

    // The pole obeys the key too: lit flank on the sun side, shade behind it.
    const poleBase = grade(pal.shade, { valScale: 1.35, satScale: 0.32 })
    const poleFaces = shadePair(poleBase, key)
    const pole = new Graphics()
    pole.rect(-0.8, -5.2 * M, 0.9, 5.2 * M).fill(poleFaces.shade)
    pole.rect(0.1, -5.2 * M, 0.7, 5.2 * M).fill(poleFaces.lit)
    this.windsock.addChild(pole)

    // Occlusion where the pole enters the turf: a tight dark pool, so it is
    // planted rather than resting on a hairline.
    const foot = new Sprite(softDot(grade(pal.near, { valScale: 0.4, satScale: 1.3 }), 32, 0.4))
    foot.anchor.set(0.5, 0.5)
    foot.blendMode = 'multiply'
    foot.alpha = 0.6
    foot.width = 12
    foot.height = 4
    this.windsock.addChild(foot)

    // Sock built pointing along +x from the top of the pole; rotation and an
    // x-squash do the rest, so a crosswind fills it and a headwind foreshortens.
    const sock = this.sockBody
    // Backlit, so it reads as a dark shape against the warm band rather than
    // as a second saturated object. The subject detector finds the player as
    // the frame's most colourful cluster, and a rust-orange sock on the left
    // touchline was being counted as part of the athlete — a "subject" box 49%
    // of the frame tall. Props separate on value in this frame; only the
    // athlete and the disc are allowed to separate on chroma.
    const rust = grade(0xe4572e, { satScale: 0.5, valScale: 0.6, fog: pal.haze, fogAmount: 0.3 })
    // Backlit cloth, not a white flag. "A hands its brightest values to things
    // that are not the subject — sun L=245, flagpole #F0DBB5 L=221, HUD yellow
    // — while the thrower's legs and jersey sit on a field of L=85-92." The
    // white band on this sock was the flagpole in that sentence.
    const cloth = grade(Core.paperWhite, { valScale: 0.56, satScale: 1.4, fog: pal.haze, fogAmount: 0.34 })
    const bands: [number, number, Hex][] = [
      [0, 0.34, rust], [0.34, 0.66, cloth], [0.66, 1, rust],
    ]
    const L = 2.6 * M
    const r0 = 0.52 * M
    const r1 = 0.24 * M
    for (const [a, b, colour] of bands) {
      const ra = r0 + (r1 - r0) * a
      const rb = r0 + (r1 - r0) * b
      sock.moveTo(a * L, -ra).lineTo(b * L, -rb).lineTo(b * L, rb).lineTo(a * L, ra)
        .closePath().fill(colour)
    }
    // The underside of the tube is in its own shadow.
    sock.moveTo(0, r0 * 0.3).lineTo(L, r1 * 0.3).lineTo(L, r1).lineTo(0, r0)
      .closePath().fill({ color: darken(rust, 0.42), alpha: 0.4 })
    // Its own silhouette for the outline: a fill only keeps the path for the
    // stroke that immediately follows it, so the banded loop above cannot carry
    // the whole shape.
    sock.moveTo(0, -r0).lineTo(L, -r1).lineTo(L, r1).lineTo(0, r0).closePath()
      .stroke({ color: grade(rust, { valScale: 0.58, satScale: 1.18 }), width: 1.4 })
    sock.position.set(0, -5.2 * M)
    this.windsock.addChild(sock)

    // The pole's shadow on the grass, thrown away from the sun like everything
    // else that stands on this field. A DRAWN wedge in the same flat value as
    // the trees' shadows, not a soft dot: a blind review found a stray
    // "orphan ellipse" in the lower left of this frame and this was one of two
    // candidates. Authored in a unit box, scaled at apply().
    this.sockShadow = new Graphics()
    this.sockShadow.moveTo(0, -0.34).lineTo(-1, -0.06).lineTo(-1, 0.06).lineTo(0, 0.34)
      .closePath().fill(FAR_SHADOW_TONE)
    this.container.addChild(this.sockShadow)
    this.container.addChild(this.windsock)
  }

  /**
   * Foreground: the near-plane crop.
   *
   * Two jobs. The first is value — this is the only part of the scene allowed
   * to be the darkest green in the frame, and it is what stops the composition
   * bottoming out into one flat plane.
   *
   * The second is the composition itself. A neutral review put the problem
   * plainly: "its horizon, its treeline, its field bands and its HUD slabs are
   * all horizontal and parallel, so the eye slides sideways and never lands."
   * So the dominant foreground element is no longer a row of grass along the
   * bottom edge — it is a BANK cutting the lower right corner on a diagonal,
   * running from the right edge down to the bottom edge, in near-silhouette.
   * It crops the frame at an angle, it points back down and left at the
   * thrower, and it is the darkest mass in the picture.
   *
   * Its top edge is kept below the shallowest depth the receiver can occupy, so
   * it never eats the man the player is controlling.
   */
  private buildForeground(): void {
    const { rng } = this
    /*
     * The near plane is DARK, but it is not a hole.
     *
     * "from y 360 to the bottom edge the field sits between #323829 and
     *  #2b3226 with a black vignette crushing it to #12171a by y 740"
     * "lift the foreground off black so it stops reading as an unfinished
     *  vignette"
     *
     * Every value down here was computed off `pal.near` through two or three
     * chained `valScale`s, and chained multiplication is how a near plane ends
     * up at L 22 without anyone choosing L 22. So these are authored, in the
     * same 0-255 luma the band plan uses, and they sit in a fixed relationship
     * to the near band behind them (L 34):
     *
     *   bank          L 20   one step under the band it crops
     *   bank crest    L 59   grass catching the low sun along the edge
     *   blades        L 18   the darkest mass in the lower frame, and small
     *   blade rims    L 54
     *
     * A floor, not a hole.
     *
     * Every one of these came down by six or seven points with the near band
     * it crops, which went L 36 -> 26 in the same pass that made band 1 the
     * light strip. They are authored against that band, not against black, and
     * the relationship — one step under, with a lit crest four times its own
     * value on it — is the thing that has to hold. The lit crest is still what
     * keeps this off "an unfinished vignette".
     */
    const bladeDark: Hex = 0x0f140d
    const bladeLit: Hex = 0x303927
    const faces = { shade: bladeDark, lit: bladeLit }
    const ink: Hex = 0x0a0d06

    // --- the angled bank -----------------------------------------------------
    const bankDeep: Hex = 0x101610
    const bankLit: Hex = 0x353e2a
    const bank = new Graphics()
    // Hypotenuse from the bottom edge up to the right edge: one long diagonal.
    const BX0 = 1075
    const BY1 = 828
    bank.moveTo(BX0, 1090)
    bank.bezierCurveTo(1330, 1006, 1600, 906, 1962, BY1)
    bank.lineTo(1962, 1090).closePath()
    bank.fill(bankDeep)
    // Grass catching the low sun along the crest, so the bank is a surface with
    // a lit edge rather than a black triangle pasted over the corner.
    bank.moveTo(BX0, 1090)
    bank.bezierCurveTo(1330, 1006, 1600, 906, 1962, BY1)
    bank.stroke({ color: bankLit, width: 5, alpha: 0.6 })
    // Blades breaking the crest line, so the edge is grass and not a cut.
    for (let i = 0; i < 34; i++) {
      const t = i / 33
      const x = BX0 + (1962 - BX0) * t
      const y = 1090 + (BY1 - 1090) * (t * t * 0.42 + t * 0.58) - rng.range(0, 6)
      const h = rng.range(26, 78)
      const bend = rng.range(-26, 26)
      bank.moveTo(x - 5, y)
        .quadraticCurveTo(x + bend * 0.35, y - h * 0.6, x + bend, y - h)
        .quadraticCurveTo(x + bend * 0.3 + 4, y - h * 0.55, x + 5, y)
        .closePath()
    }
    bank.fill(bankDeep)
    this.container.addChild(bank)

    // Clumps live in the LEFT of the frame only: the bank owns the right, and an
    // even row of grass along the whole bottom edge is a vignette asset rather
    // than an observed ground plane. None of them is near the thrower.
    //                        x      spread  height scale
    const clumps: [number, number, number][] = [
      [46, 320, 1.05], [318, 270, 0.66], [520, 180, 0.28],
      [858, 215, 0.4], [1040, 230, 0.46], [1240, 245, 0.54],
    ]
    for (const [cx, spread, hScale] of clumps) {
      const g = new Graphics()
      // Blades are generated once and emitted repeatedly: fill() consumes the
      // pending path, so each pass has to re-declare it.
      const blades: number[][] = []
      for (let i = 0; i < 22; i++) {
        blades.push([
          rng.range(-spread * 0.5, spread * 0.5),
          rng.range(96, 248) * hScale,
          rng.range(-52, 52),
          rng.range(6, 12),
        ])
      }
      const emit = (dx: number): void => {
        for (const [x, h, bend, w] of blades) {
          g.moveTo(x + dx - w * 0.5, 0)
            .quadraticCurveTo(x + dx + bend * 0.35, -h * 0.6, x + dx + bend, -h)
            .quadraticCurveTo(x + dx + bend * 0.3 + w * 0.6, -h * 0.55, x + dx + w * 0.5, 0)
            .closePath()
        }
      }
      emit(0)
      g.fill(faces.shade)
      // A sliver of the same blades offset onto the sun side: the lit edge.
      emit(3)
      g.fill({ color: faces.lit, alpha: 0.55 })
      emit(0)
      g.stroke({ color: ink, width: 2, alpha: 0.5 })
      g.position.set(cx, 1082)
      this.container.addChild(g)
      this.fringe.push(g)
    }

    // Seed heads catching the low sun: warm motes, not pale green ones.
    //
    // And under the disc's ceiling, which is the only reason this line changed.
    // `mix(light, paperWhite, 0.35)` measures L=212.3 — two and a half points
    // ABOVE the disc's plate — so ninety-six foreground motes were the joint
    // brightest thing in the frame with the hero. Keyed into the haze instead
    // they measure L=164.2, +45.5 under the plate: still the warmest thing in
    // the near grass, no longer competing with the throw.
    this.seeds = new ParticleSystem(
      softDot(grade(mix(this.pal.light, this.pal.haze, 0.4), { valScale: 0.92 }), 32, 0.86), 96,
    )
    this.container.addChild(this.seeds.container)
  }

  // ------------------------------------------------------------------ update
  /** Advance weather and water. Simulation only — no transform writes. */
  update(dt: number): void {
    this.time += dt
    const wx = this.windX
    const speed = Math.hypot(wx, this.windZ)

    // Clouds and their shadows travel together, faster than the wind at ground
    // level because the air above the field is always moving quicker.
    for (let i = 0; i < this.cloudGfx.length; i++) {
      this.cloudX[i] += wx * 3.4 * dt
      if (this.cloudX[i] > 2280) this.cloudX[i] -= 2680
      if (this.cloudX[i] < -400) this.cloudX[i] += 2680
    }

    // Glints ride the current, which flows across the field, not with the wind.
    for (let i = 0; i < GLINTS; i++) {
      this.glintX[i] += (2.1 + wx * 0.3) * dt
      if (this.glintX[i] > 54) this.glintX[i] -= 108
      if (this.glintX[i] < -54) this.glintX[i] += 108
    }

    // The sock lags the wind, which is what makes it look like fabric.
    const targetAngle = Math.atan2(this.windZ * 0.55, -wx)
    this.sockAngle = damp(this.sockAngle, targetAngle, 0.02, dt)
    this.sockInflate = damp(this.sockInflate, clamp01(speed / 4), 0.04, dt)

    for (let i = 0; i < FRINGE; i++) {
      this.fringeSway[i] = Math.sin(this.time * (1.1 + i * 0.17) + i * 2.2) * (0.02 + speed * 0.012)
        + wx * 0.022
    }

    // Seed heads: emitted in screen space near the lower half of the frame and
    // blown along. They are the smallest, cheapest cue that air is moving.
    this.seedTimer -= dt
    if (this.seedTimer <= 0) {
      this.seedTimer = 0.07 + this.rng.next() * 0.12
      const fromLeft = wx >= 0
      this.seeds.emit({
        x: fromLeft ? -40 : 1960,
        y: this.rng.range(600, 1072),
        vx: wx * 34 + (fromLeft ? 40 : -40),
        vy: this.rng.range(-26, 10),
        life: this.rng.range(2.6, 5),
        size: this.rng.range(4, 11),
        sizeEnd: this.rng.range(2, 6),
        alpha: this.rng.range(0.22, 0.5),
        alphaEnd: 0,
        gravity: 7,
        drag: 0.86,
      })
    }
    this.seeds.update(dt)
  }

  // ------------------------------------------------------------------- apply
  /** Write every transform for the backdrop. Positions only, zero allocation. */
  apply(): void {
    const camX = this.camX
    this.parallax.scrollTo(camX * 46, -this.camPitch)

    this.clouds.y = this.camPitch * 0.85
    for (let i = 0; i < this.cloudGfx.length; i++) {
      this.cloudGfx[i].x = this.cloudX[i] - camX * 14
    }

    // --- tree line and river -------------------------------------------------
    const treeS = this.scaleAt(RIVER_Z1)
    this.treeLine.position.set(CENTRE_X - camX * treeS, this.groundY(RIVER_Z1) + 1)
    this.treeLine.scale.set(treeS / 10)

    const yFar = this.groundY(RIVER_Z1)
    const yNear = this.groundY(RIVER_Z0)
    this.river.position.set(0, yFar)
    this.river.width = 1920
    this.river.height = Math.max(2, yNear - yFar)
    this.riverSun.position.set(0, yFar)
    this.riverSun.width = 1920
    this.riverSun.height = Math.max(2, yNear - yFar)

    // Positioned, never scaled. It used to be a Sprite stretched to the depth
    // of two and a half metres of bank, which at this camera height is five
    // pixels — and scaling a 240 px slab down to five would scale its crest
    // to nothing, when the crest is the entire reason it is a shape. The slab
    // runs to y = 240 in its own space and the sun rake band paints over
    // everything below its own crest at every tilt, so the bank's foot is
    // never on screen and never needs measuring.
    //
    // Seated seven pixels ABOVE the projected bank so the crest, which swings
    // +-5, always cuts UP into the water rather than down off it: a crest that
    // dipped below the water's own bottom edge would open a hole between them.
    this.nearBank.position.set(-camX * 6, yNear - 7)

    // Reeds on that bank. One scale for all of them — they stand at one depth
    // — and a slow lean off the same wind the windsock reads.
    const reedS = this.scaleAt(RIVER_Z0) / 10
    for (let i = 0; i < REEDS; i++) {
      const g = this.reeds[i]
      this.project(this.reedX[i], 0, RIVER_Z0)
      if (!this.pVisible) { g.visible = false; continue }
      g.visible = true
      g.position.set(this.px, this.py + 1)
      g.scale.set(reedS)
      g.rotation = 0.06 * this.windX + 0.03 * Math.sin(this.time * 1.1 + this.reedSway[i])
    }

    const glintScale = this.scaleAt((RIVER_Z0 + RIVER_Z1) * 0.5)
    for (let i = 0; i < GLINTS; i++) {
      const s = this.glints[i]
      this.project(this.glintX[i], 0.04, this.glintZ[i])
      if (!this.pVisible) { s.visible = false; continue }
      s.visible = true
      s.position.set(this.px, this.py)
      s.width = this.glintLen[i] * this.ps
      s.height = Math.max(1.5, 0.22 * glintScale)
      // Breathing alpha, offset per glint, so the surface never pulses in sync.
      // Opened up from 0.14-0.40 now the blend is normal rather than additive:
      // at 0.40 of a flat colour the sliver was a smudge. The ceiling is set by
      // the composite, not by taste — 0.85 over the sun path measures L=163.3.
      s.alpha = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(this.time * 2.3 + this.glintPhase[i]))
    }

    // --- the three value bands ----------------------------------------------
    // Pinned to the TRUE horizon, so the plan survives the camera tilting up
    // after a lofted disc, and slid laterally against the pan so the crests are
    // part of the world rather than decals on the lens.
    const horizon = HORIZON_Y + this.camPitch
    for (let i = 0; i < this.groundBands.length; i++) {
      const g = this.groundBands[i]
      g.y = horizon + GROUND_BANDS[i].top
      g.x = -camX * BAND_PARALLAX[i]
    }

    // --- mown lanes ----------------------------------------------------------
    // A straight line in the world is a straight line on screen, so one rotated
    // sprite per lane is exact. They all converge on the vanishing point, which
    // is where the field's perspective actually comes from — and, now that the
    // cross-field stripes have been muted to a hue shift, they are the diagonal
    // structure of the lower two thirds of the frame.
    //
    // The two lanes that bracket the throw line are drawn heavier than the rest
    // so the eye has one corridor to ride rather than nine equal lines. That
    // corridor ends at the thrower's feet.
    // The lanes start well behind the camera plane so they reach the bottom
    // corners of the frame. They are the frame's dominant diagonal and the
    // corridor the eye rides up to the thrower; a lane that stops two thirds of
    // the way down the picture is a fan, not a perspective.
    const lineNearZ = this.camZ - 17
    const lineFarZ = RIVER_Z0 - 0.4
    const nearScale = this.scaleAt(lineNearZ)
    for (let i = 0; i < MOWER_LINES; i++) {
      const s = this.mowers[i]
      const wx = (i - (MOWER_LINES - 1) / 2) * MOWER_SPACING
      this.project(wx, 0.02, lineNearZ)
      const x0 = this.px, y0 = this.py
      const vis0 = this.pVisible
      this.project(wx, 0.02, lineFarZ)
      if (!vis0 || !this.pVisible) { s.visible = false; continue }
      const dx = this.px - x0
      const dy = this.py - y0
      const len = Math.hypot(dx, dy)
      if (len < 2) { s.visible = false; continue }
      // The lanes either side of the throw line. THROWER_X is -3.2, so the pair
      // at -6 and 0 metres is the corridor he stands in.
      const lead = wx === 0 || wx === -MOWER_SPACING
      s.visible = true
      s.position.set(x0, y0)
      s.rotation = Math.atan2(dy, dx)
      s.width = len
      s.height = Math.max(3, (lead ? 0.05 : 0.03) * nearScale)
      // Carried harder than before. With the field's own value ramp doing the
      // depth work, the lanes are free to be the marks that keep the lower
      // third of the frame from reading as one flat unspent plane.
      // Halved. They are still the frame's diagonal and still the corridor the
      // eye rides up to the thrower, but at 0.78 they were eleven bright lines
      // laid over a plane that the value plan needs to read as one dark mass.
      //
      // Lifted a third of the way back, because the plane they lie on is no
      // longer a dark mass: band 1 is the light strip now and it is the
      // biggest single surface in the picture. Two thirds of it measured as
      // carrying no information at all, and these lanes are the only marks on
      // it that describe anything — they converge on the vanishing point, so
      // they say where the field goes.
      s.alpha = lead ? 0.58 : 0.36
      s.tint = this.mowerTint[Math.round(DEPTH_STEPS * (lead ? 0.3 : 0.45))]
    }

    // --- touchline trees and their raking shadows ----------------------------
    for (let i = 0; i < COPSE; i++) {
      const c = this.copse[i]
      const sh = this.copseShade[i]
      this.project(this.copseX[i], 0, this.copseZ[i])
      if (!this.pVisible) { c.visible = false; sh.visible = false; continue }
      const px = this.px
      const py = this.py
      const ps = this.ps
      c.visible = true
      c.position.set(px, py)
      c.scale.set(ps / 10)
      sh.visible = true
      sh.position.set(px, py)
      // 0.26 was 1.3 m of half-width on a four-metre tree: at the trunk that
      // is fifty-three pixels either side of the base, and the mass it made
      // was the other half of "the tree mass plus its cast shadows is the
      // strongest contrast step in the frame". A fifth narrower, and twenty
      // points lighter (FAR_SHADOW_TONE), puts the frame's largest dark shape
      // back where it belongs: under the hero.
      sh.scale.set(this.copseH[i] * SHADOW_LEN * ps, this.copseH[i] * 0.21 * ps)
      sh.rotation = SHADOW_RAKE
    }

    // --- windsock ------------------------------------------------------------
    // Left touchline. The trees own the right one, and putting the two on
    // opposite sides is what stops the upper field being empty on one half and
    // crowded on the other.
    this.project(-24, 0, RIVER_Z0 - 1)
    this.windsock.visible = this.pVisible
    this.sockShadow.visible = this.pVisible
    if (this.pVisible) {
      const ps = this.ps
      this.windsock.position.set(this.px, this.py)
      this.windsock.scale.set(ps / 10)
      this.sockBody.rotation = this.sockAngle
      // Inflation is an x-squash: slack in still air, taut in a blow.
      this.sockBody.scale.set(lerp(0.34, 1, this.sockInflate), lerp(0.62, 1, this.sockInflate))
      // Thrown away from the sun, and sized in metres.
      this.sockShadow.position.set(this.px, this.py)
      this.sockShadow.scale.set(5.2 * ps, 0.9 * ps)
      this.sockShadow.rotation = SHADOW_RAKE
    }

    // --- foreground grass ----------------------------------------------------
    for (let i = 0; i < this.fringe.length; i++) {
      this.fringe[i].skew.x = this.fringeSway[i]
      // The foreground is nearest the camera, so it swings furthest on a tilt.
      this.fringe[i].y = 1082 + this.camPitch * 1.25
    }
  }

  destroy(): void {
    this.seeds.clear()
    this.parallax.destroy()
    this.container.destroy({ children: true })
  }
}
