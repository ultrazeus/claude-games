import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import type { Scene, SceneContext } from '../../../core/Scene'
import { Action } from '../../../core/Input'
import { Sky } from '../../../render/Sky'
import { Parallax } from '../../../render/Parallax'
import { ParticleSystem } from '../../../render/Particles'
import { horizontalGradient, radialGlow, softDot, verticalGradient } from '../../../render/Gradient'
import {
  Core, Palettes, atmosphericDepth, darken, fromHsv, grade, gradientAt, lighten, mix, skyAt,
  toCss, toHsv, type Hex,
} from '../../../render/Palette'
import { ContactShadow, depthOutline, keyFromRight, scatter } from '../../../render/Staging'
import {
  ControlHint, Callout, HUD_MARGIN, Meter, Readout, plate, themeFor } from '../../../render/Hud'
import { clamp, clamp01, damp, lerp, lerpAngle, smoothstep } from '../../../core/Tween'
import { Wave, type FaceSample } from './Wave'
import { Surfer } from './Surfer'
import { ResultsPanel } from '../../ui/Results'

type RideState = 'riding' | 'air' | 'down'

// 90 seconds, per the C64 original: "a maximum of 90 seconds" (Half Pipe),
// "the maximum time is 90 seconds" (Surfing), "for 90 seconds" (Foot Bag).
// This had been 75, which made three of the six events a quarter shorter
// than the source they are remastering.
const RUN_SECONDS = 90

/**
 * The third wipeout ends the run.
 *
 * The original: "the maximum time is 90 seconds and here also after three
 * falls from the board the discipline will end prematurely." We counted the
 * falls from the first day — `wipeouts` has always existed — but spent them
 * only as a scoring penalty, so going over the falls cost 0.85 points and a
 * second and a half, and there was never a reason not to try the biggest
 * thing on every section. A wipeout has to be able to end the run or it is
 * not a risk, it is a rounding error.
 */
const MAX_FALLS = 3

// --- world layout ----------------------------------------------------------
//
// The trough is fixed and the crest rises out of it, so a big section is a tall
// wave rather than a deep hole.
//
// **The camera is now pushed all the way in.** The previous framing held the
// whole wave — horizon, crest, trough and a strip of near water — inside one
// 1080px frame, and a neutral review read exactly what that costs: "three
// horizontal bands (sky, wave, black), one hue family, and a hero the size of a
// thumbnail floating in the middle of the middle band", with "roughly 30% of
// the canvas spending no information" in the near-black bottom third.
//
// Pushing in deletes the bottom band rather than trying to fill it: at this
// magnification the trough is off the bottom of the frame entirely and the
// lower wave face *is* the foreground. The horizon goes the same way — it sits
// at 700 now, below the range the crest travels through, so the open ocean and
// the swell lines behind the wave are permanently hidden behind it and cannot
// stack a fourth parallel band across the frame.
//
// What is left, in stage space:
//
//   250 - ~460  sky, blowing out toward the crest. A wedge, not a band.
//   ~460        the lip, crossing the frame on the one dominant diagonal
//   ~460 - 850  the face: the wall the rider is read against, falling to the
//               core shadow, which runs off the bottom edge of the frame
/** Screen y of the flat water the wave stands out of. */
const STILL_Y = 980
const MIN_HEIGHT = 340
const MAX_HEIGHT = 560
/** Below the crest's whole travel range: the open ocean never shows. */
const HORIZON_Y = 700
/** Where the surfer is held, in stage x. Left of centre: the wall ahead matters. */
const CAM_ANCHOR = 834

// --- staging the camera ----------------------------------------------------
//
// Everything that is world — sky, swell, wave, rider, near water — hangs off
// one container that is canted and pushed in. The HUD does not.
//
// The reason is compositional, not decorative. Squinting at the old frame gave
// five parallel horizontal bands, and a horizontal stack cannot stage anything
// because every element is the same distance from every edge. Canting the whole
// stage by 7 degrees turns the horizon, the crest, the terminator and the near
// water into four diagonals that all run the same way, and the wave's own
// convergence toward the horizon (see `PERSP_*`) crosses them. The push-in is
// what the rotation costs — a rotated rectangle has to be scaled to cover the
// frame — and it is also what gets the rider to a third of the frame height.
/** Cant, radians. Positive drops the far (right) end toward the horizon. */
const TILT = 0.125
/**
 * The push-in.
 *
 * This is the single named fix out of the last review: "push in hard — put the
 * wave lip across the top third and the surfer at 3-4x current size, which
 * deletes the dead black bottom band and gives the frame a foreground in the
 * same move." At 2.2 the visible world is a 870x490 stage-space window instead
 * of the whole 1920x1080 design space, which is roughly a 3.2x crop by area:
 * the rider goes from an eighth of the frame height to a third, the trough and
 * the near water fall off the bottom edge, and the lower face — the thing that
 * was being cropped away before — becomes the foreground plane.
 */
const ZOOM = 2.2
/** Lifts the whole composition a touch off the bottom edge. */
const STAGE_DY = -24

// --- the wave running away down the line -----------------------------------
//
// The far half of the wave converges toward the horizon: the trough climbs and
// the face shortens, so the crest line and the trough line meet somewhere off
// the right of the frame instead of running parallel forever.
//
// It is deliberately switched off anywhere the rider can be. `PERSP_START` is
// far enough ahead of `CAM_ANCHOR` that the surfer, his wake, his spray and the
// whitewater behind him all live in the untouched zone, so nothing he stands on
// is being warped under him. Perspective you cannot ride into costs nothing to
// get wrong.
const PERSP_START = 1120
const PERSP_END = 1900
/** How far the trough climbs toward the horizon at the far end, px. */
const PERSP_LIFT = 170
/** Face height multiplier at the far end. */
const PERSP_SHRINK = 0.62

// --- the near plane --------------------------------------------------------
//
// At the new magnification the trough is below the bottom edge for any wave the
// rider can stand up on, so these only ever come into frame on a small section
// taken from low on the face. They are kept for that case and nothing else.
/** Where the near water cuts across. */
const FG_Y = 906
/** Counter-cant, so the near water and the crest converge instead of tracking. */
const FG_TILT = -0.08

// --- where the camera sits --------------------------------------------------
//
// The old camera tracked the rider alone, which meant the lip went wherever the
// swell put it — sometimes across the middle of the frame, sometimes out of
// shot. Half the reason this event won one blind review and lost the next with
// no code change between them was which moment the shutter caught.
//
// So the camera is anchored to *both*: 55% to the rider and 45% to the crest
// above him. Written out, the stage-space result is
//
//     crest  = CAM_K - 0.55 * drop        rider = CAM_K + 0.45 * drop
//
// where `drop` is how far below the lip the rider is. The lip therefore lands
// in the top third for any drop the ride actually produces, the rider holds the
// lower middle, and the two can never both wander.
/** Stage y the composition is hung from. */
const CAM_K = 505
/** How much of the camera follows the rider rather than the lip. */
const CAM_RIDER = 0.55
/** Time constant of the x follower, in seconds: -1 / ln(0.06). */
const CAM_LEAD = 0.355
const camYFor = (curY: number, crestY: number): number =>
  clamp(CAM_RIDER * curY + (1 - CAM_RIDER) * crestY - CAM_K, -1400, 1400)
/**
 * How much of the face's horizontal run is actually shown. The full run would
 * swing the surfer 300px across the frame on every bottom turn; at 0.38 the
 * carve still sweeps forward and back — which is what surfing looks like —
 * without the camera having to chase him.
 */
const RAKE = 0.38

// --- riding physics --------------------------------------------------------
/** Gravity along the face, before planing lift. */
const GRAVITY = 1750
/** Fraction of face speed retained after one second. */
const FACE_DRAG = 0.22
const CARVE_THRUST = 1280
const PUMP_KICK = 340
const BASE_LINE_SPEED = 680
const MAX_LINE_SPEED = 1180
const AIR_GRAVITY = 1900
/**
 * Face speed at the lip above which the surfer leaves the water without asking.
 * A hollow section throws you off it; a mellow shoulder just lets you float
 * along the top, which is why the threshold is a function of pitch rather than a
 * constant. Without that it is a knife edge — a few pixels per second either
 * side of one number decides between an air every lap and no airs at all.
 */
const FREE_LAUNCH_HOLLOW = 470
const FREE_LAUNCH_MELLOW = 760

// --- the wave's cross-section, drawn ---------------------------------------
//
// Half the pitch of the old sampling, because the push-in doubles how many
// screen pixels one column is worth: at 48 the crest was a 105px-per-segment
// polyline on screen and the faceting showed along the one line the whole
// composition converges on.
const COLS = 56
const COL_STEP = 28

/**
 * Surface noise on the drawn crest, and on every edge hung off it.
 *
 * The single clearest craft failure in the last capture, quoted:
 *
 *   "B also draws water with long straight polygon edges — the pale mint lip is
 *    a flat translucent sheet with a ruler-straight top running off-frame,
 *    which is the single clearest amateur tell in the image; water does not
 *    have straight edges."
 *
 * The cause was structural rather than careless. The crest is `troughYAt -
 * heightAt`, and the swell field behind both is smooth over the ~900 world
 * pixels the pushed-in camera can see, so at 2.2x the crest resolved into a
 * ruler. This is three octaves of surface laid on top of it — swell texture,
 * wind chop, capillary — a pure function of world position and the wave clock,
 * so it is deterministic, costs one sine per column, and every pass that reads
 * `colCrest` inherits it. After this nothing in the frame that follows the
 * crest can be straight.
 *
 * It is drawing only: the physics still rides `Wave.crestYAt`, and the
 * amplitude is a tenth of the smallest wave, so the two never disagree by
 * enough to see.
 */
const crestSurface = (wx: number, t: number): number =>
  Math.sin(wx * 0.00902 + t * 0.90) * 7.4
  + Math.sin(wx * 0.02137 - t * 1.62) * 3.6
  + Math.sin(wx * 0.05310 + t * 2.41) * 1.7

// --- the one light ---------------------------------------------------------
//
// There is a single key in this scene: the dawn sun, low, ahead down the line
// and BEHIND the wave. Every value in the frame is derived from that one fact.
// Its screen position is fixed, because the sky does not scroll.
const SUN_X = 0.6307 * 1920
const SUN_Y = 0.3241 * 1080
const KEY = keyFromRight(Palettes.surfing.light, 0.95)

/**
 * The chroma reservation, enforced rather than described.
 *
 * Rule 3 of the staging brief is that the player owns one saturated hue and
 * nothing else in the frame may use it. On a frame that is *entirely water*
 * that rule has a trap in it: HSV saturation of a dark navy is enormous — the
 * old deep water sat at 0.88, well above the rider's own kit — so the most
 * chromatic thing on screen was a flat mass of shadow at the bottom of the
 * frame, and the rider was not even second.
 *
 * Every water colour therefore goes through this on the way in. Nothing in the
 * scene but the rider's suit carries chroma above the cap, so the reservation
 * holds by construction instead of by good intentions.
 *
 * The cap came down from 0.6 to 0.45 when the face was turned into the light
 * mass. A bright surface keeps far more of its chroma than a dark one does —
 * the detector weights chroma by value, and so does the eye — so the number
 * that was safe while the wave was a dark slate is not safe now. Measured on
 * the detector's own metric the whole background tops out at 0.36 against the
 * suit's 0.59.
 */
const WATER_CHROMA = 0.45
const sea = (c: Hex): Hex => {
  const h = toHsv(c)
  return h.s <= WATER_CHROMA ? c : fromHsv({ h: h.h, s: WATER_CHROMA, v: h.v })
}

/**
 * The one hue the frame reserves for the rider.
 *
 * A vermilion at chroma 0.88 — forty points clear of anything the water is
 * allowed to carry, which is what makes him findable rather than merely
 * present. It is also the frame's single complement: rule 4a of the staging
 * brief is that one hue family across the field still needs one large cool or
 * warm opposite dropped into it, and everything else here is blue.
 *
 * Value matters as much as chroma, and this is the half the last review said
 * was inverted. The suit sits at 0.26 luminance; the face he is read against
 * now sits between 0.61 and 0.79 over the whole band he rides in, rather than
 * being the darkest mass in the picture. Measured on the last capture, that
 * one change takes his contrast against what is behind him from 0.42 to 0.49
 * without touching the rider at all — which is the whole of rule 3: the
 * biggest value break in the frame belongs to the thing the player controls.
 */
const RIDER_SUIT = 0xc41f18
/**
 * The board, and its hue is a decision rather than a default.
 *
 * It used to be a pale cyan — which put it inside the *water's* hue family, on
 * a face that is now the light mass, at nearly the same value. A board that
 * matches the wave it is on is a board that is not there.
 *
 * It is warm bone now. That puts the rider and the thing he stands on in the
 * same warm island in a wholly cool field, which is the mechanism the bar wins
 * with: "the whole background is one warm family, and then it detonates two
 * colours that exist nowhere else in that family". Ours runs the other way
 * round — a cool field, a warm rider — but it is the same mechanism. Its
 * chroma is a fifth of the suit's, so it reinforces him rather than competing.
 */
const RIDER_BOARD = 0xf2dfbd

/**
 * Deterministic hash, so a texture built in `enter` is the same every run and a
 * critic's screenshot can be reproduced.
 */
const hash01 = (seed: number, n: number): number => {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453
  return x - Math.floor(x)
}

/**
 * A puff of broken water with an actual silhouette.
 *
 * Quoted, and it was the craft note that cost the most:
 *
 *   "The spray at centre is a soft white airbrush smear with no particle
 *    silhouette."
 *
 * A radial alpha ramp has no edge, so a thousand of them stacked are a smear
 * however carefully they are thrown. This is one closed path of unequal lobes,
 * filled flat: it has an outline, it has a shaded underside because the sun is
 * behind it, and it has a lit rim on the sunward side. Rotated and scaled per
 * particle it reads as a cloud of water rather than as an airbrush pass.
 *
 * Two of these are built at different seeds and the emitters pick between them,
 * because one shape repeated at one scale is the other half of the same note.
 */
function foamBlob(body: Hex, shade: Hex, rim: Hex, seed: number, size = 96): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return Texture.WHITE
  const c = size / 2
  const lobes = 9
  const px: number[] = []
  const py: number[] = []
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2
    // Unequal radii, and squashed on y: broken water spreads before it rises.
    const r = c * (0.40 + 0.52 * hash01(seed, i));
    px.push(c + Math.cos(a) * r)
    py.push(c + Math.sin(a) * r * 0.74)
  }
  const trace = (): void => {
    ctx.beginPath()
    ctx.moveTo((px[lobes - 1] + px[0]) / 2, (py[lobes - 1] + py[0]) / 2)
    for (let i = 0; i < lobes; i++) {
      const j = (i + 1) % lobes
      ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2)
    }
    ctx.closePath()
  }
  // A faint halo first, so the hard edge lands on something instead of being a
  // cut-out pasted on the water.
  trace()
  ctx.strokeStyle = toCss(body, 0.3)
  ctx.lineWidth = 7
  ctx.stroke()
  trace()
  ctx.fillStyle = toCss(body, 1)
  ctx.fill()
  // The underside, in shadow: the sun is behind and above this water.
  ctx.save()
  trace()
  ctx.clip()
  const grad = ctx.createLinearGradient(0, c * 0.55, 0, size)
  grad.addColorStop(0, toCss(shade, 0))
  grad.addColorStop(1, toCss(shade, 0.62))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  ctx.restore()
  // The lit rim, on the sunward side only.
  ctx.save()
  trace()
  ctx.clip()
  trace()
  ctx.strokeStyle = toCss(rim, 0.85)
  ctx.lineWidth = 5
  ctx.stroke()
  ctx.restore()
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/**
 * Thrown water: a head with a tail, not a blurred dot.
 *
 * The long axis runs along +x so a particle rotated onto its own velocity leads
 * with the head. Two detached droplets trail behind the main mass, which is
 * what gives a burst of these a readable edge at thumbnail size.
 */
function sprayDrop(core: Hex, seed: number, size = 96): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return Texture.WHITE
  const c = size / 2
  ctx.fillStyle = toCss(core, 1)
  // The head: an ellipse forward of centre.
  ctx.beginPath()
  ctx.ellipse(c * 1.42, c, c * 0.40, c * 0.30, 0, 0, Math.PI * 2)
  ctx.fill()
  // The tail: a wedge running back from the head, with a kink in it.
  ctx.beginPath()
  ctx.moveTo(c * 1.72, c - c * 0.14)
  ctx.quadraticCurveTo(c * 0.7, c - c * 0.30 * hash01(seed, 1), c * 0.10, c - c * 0.05)
  ctx.quadraticCurveTo(c * 0.7, c + c * 0.26 * hash01(seed, 2), c * 1.72, c + c * 0.16)
  ctx.closePath()
  ctx.fill()
  // Two droplets torn off the back.
  for (let i = 0; i < 2; i++) {
    ctx.globalAlpha = 0.8 - i * 0.25
    ctx.beginPath()
    ctx.ellipse(
      c * (0.44 - i * 0.30),
      c + (hash01(seed, 3 + i) - 0.5) * c * 0.62,
      c * (0.12 - i * 0.04), c * (0.09 - i * 0.03), 0, 0, Math.PI * 2,
    )
    ctx.fill()
  }
  ctx.globalAlpha = 1
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/**
 * Wind-blown spray: a flat tapered streak, not a blurred dot.
 *
 * This was the last airbrush left in the frame. The same review that put the
 * rider first still named "soft bokeh spray particles that clash with its own
 * hard flat-vector line work", and a radial alpha ramp is exactly that clash:
 * `foamBlob` had already been given a silhouette, while the mist tiers were
 * still two-dimensional gaussians. Scaled to the 400-660 px these tiers run at,
 * a gaussian has a fifty-pixel feathered edge and reads as a smudge on the
 * lens rather than as water in the air.
 *
 * So it is a closed lens shape, pointed at both ends and fattest a third of the
 * way back, filled flat — one wide pass at low alpha under one narrower core,
 * which is the same halo-then-body build `foamBlob` uses. The long axis runs
 * along +x so a particle rotated onto its own velocity leads with its point.
 */
function windStreak(color: Hex, size = 64, thickness = 0.3): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return Texture.WHITE
  const c = size / 2
  const t = c * thickness
  const lens = (scale: number, alpha: number): void => {
    const up = t * scale
    ctx.beginPath()
    ctx.moveTo(1, c)
    ctx.bezierCurveTo(c * 0.30, c - up, c * 1.05, c - up * 0.88, size - 1, c)
    ctx.bezierCurveTo(c * 1.05, c + up * 0.70, c * 0.30, c + up * 0.82, 1, c)
    ctx.closePath()
    ctx.fillStyle = toCss(color, alpha)
    ctx.fill()
  }
  // The halo first, so the flat body lands on something rather than being a
  // cut-out pasted on the sky.
  lens(1.5, 0.28)
  lens(1, 1)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/**
 * The face, lit by that key rather than ramped by rule.
 *
 * `t` is the fraction of the local wave height below the crest, so the whole
 * model stretches and squashes with the swell.
 *
 * **This ramp was inverted.** The version before it fell 0.95 to 0.17 over the
 * top third of the face and then held a dark slate for the rest, which put the
 * hero of the picture at the bottom of the value range:
 *
 *   "B's value structure is inverted against its own subject: the wave — the
 *    hero — is the darkest, lowest-chroma mass in the picture, while the
 *    brightest thing is empty sky at upper right. The eye lands on nothing."
 *
 * The sun is low and directly behind this wave, so the honest reading and the
 * useful one agree: the face is a backlit sheet, and a backlit sheet is the
 * brightest surface in the frame. The fall is now spread across the whole
 * height instead of being spent in the first 15%, and the band the rider
 * actually rides in is held near the TOP of the range rather than in the
 * middle of it:
 *
 *   0.00 - 0.05  **transmission.** The water at the lip is centimetres thick
 *                and it blows out. lum 0.95.
 *   0.05 - 0.22  **the lit sheet.** Luminous jade falling slowly, lum 0.90 to
 *                0.73. The biggest bright mass in the frame, and it is the
 *                wave, not the sky.
 *   0.22 - 0.46  **the shoulder.** lum 0.73 to 0.54, and this is where the
 *                rider is. A near-black vermilion silhouette on it carries the
 *                largest value break in the picture by a distance.
 *   0.46 - 0.70  **the wall**, falling steadily through the mid values.
 *   0.70 - 0.93  **core shadow.** lum 0.34 to 0.17. Dark, and small: it is the
 *                bottom edge of the frame rather than two thirds of it.
 *   0.93 - 1.00  **reflected light.** Sky bounces up out of the trough.
 *
 * Hue runs 160 to 206 degrees the whole way and chroma is capped at
 * `WATER_CHROMA`. The value falls 0.95 -> 0.17 across the face, which is what
 * answers the dead-frame measure: a mass that is a continuous ramp cannot all
 * sit inside one bin of the histogram.
 */
const FACE_KEYS: readonly { t: number; c: Hex }[] = [
  { t: 0.000, c: sea(0xfaf4dd) },
  { t: 0.022, c: sea(0xe8f5e0) },
  { t: 0.055, c: sea(0xc6efe0) },
  { t: 0.095, c: sea(0xa6e7dc) },
  { t: 0.150, c: sea(0x8adbd7) },
  { t: 0.220, c: sea(0x72cdd1) },
  { t: 0.300, c: sea(0x62bdc9) },
  { t: 0.380, c: sea(0x55acbd) },
  { t: 0.460, c: sea(0x4a9ab0) },
  { t: 0.540, c: sea(0x3f87a0) },
  { t: 0.620, c: sea(0x35738c) },
  { t: 0.700, c: sea(0x2c6079) },
  { t: 0.780, c: sea(0x244e65) },
  { t: 0.860, c: sea(0x1d3d51) },
  { t: 0.930, c: sea(0x182f3f) },
  { t: 1.000, c: sea(0x22394a) },
]

/**
 * Where the fills that draw the face are cut.
 *
 * Hand-placed and **deliberately irregular**. The previous set spaced the long
 * middle of the face at a dead-even 0.046, and an even pitch is the thing a
 * reviewer registers first: "a repeated stamp with identical spacing" was the
 * craft note on the last pass of this event. Water bands because the swell
 * under it is a sum of wavelengths, so the bands it makes are not a ruler.
 *
 * Thin cuts across the transmission zone so the fast part of the ramp resolves
 * instead of stepping; wider, unevenly paced ones down the wall, where one band
 * spans 50 to 90 screen pixels and every boundary is a line of local contrast
 * in a mass that would otherwise be measured as carrying no information.
 */
const BAND_EDGES: readonly number[] = [
  0, 0.014, 0.034, 0.058, 0.079,
  0.104, 0.127, 0.158, 0.183, 0.211,
  0.249, 0.281, 0.326, 0.362, 0.413, 0.451, 0.497, 0.544,
  0.588, 0.627, 0.679,
  0.724, 0.781, 0.839, 0.897, 0.949, 1,
]
const BANDS: readonly { at: number; to: number; c: Hex }[] = (() => {
  const out: { at: number; to: number; c: Hex }[] = []
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const a = BAND_EDGES[i]
    const b = BAND_EDGES[i + 1]
    out.push({ at: a, to: b, c: gradientAt(FACE_KEYS, (a + b) * 0.5) })
  }
  return out
})()

/** Named samples off the same curve, so nothing else has to index BANDS. */
const FACE_LIP = gradientAt(FACE_KEYS, 0.02)
const FACE_UPPER = gradientAt(FACE_KEYS, 0.13)
const FACE_MID = gradientAt(FACE_KEYS, 0.34)
const FACE_CORE = gradientAt(FACE_KEYS, 0.80)
const FACE_BOUNCE = gradientAt(FACE_KEYS, 1)

/**
 * Light coming *through* the lip.
 *
 * Three values, thinnest water first: a blown warm edge where the sheet is
 * almost nothing, luminous jade where it is a few centimetres, and a saturated
 * teal where it thickens back into the face. Added, not painted, so the amount
 * of glow is a function of how thin the water actually is that frame.
 */
const TRANSMIT_EDGE = 0xfaf4d8
const TRANSMIT_MID = 0x9deadb
const TRANSMIT_DEEP = sea(0x4fb9c0)

/**
 * The translucent zone, as a stack of ribbons hung off the crest.
 *
 * Offsets are fractions of the local wave height, and they now start *below*
 * the crest rather than above it: the water above the crest line is the rolled
 * lip, which has its own geometry and its own thickness in `drawCurl`. This is
 * the light that has already come through it and is glowing inside the face.
 */
const TRANS_RIBBONS: readonly { from: number; to: number; c: Hex; a: number }[] = [
  { from: 0.004, to: 0.038, c: TRANSMIT_EDGE, a: 0.36 },
  { from: 0.028, to: 0.086, c: TRANSMIT_MID, a: 0.30 },
  { from: 0.072, to: 0.178, c: TRANSMIT_DEEP, a: 0.22 },
  { from: 0.160, to: 0.360, c: TRANSMIT_DEEP, a: 0.09 },
]
/**
 * The floor under the attenuation.
 *
 * A ribbon whose thickness is a straight multiple of `transmit()` pinches to
 * nothing wherever the water is broken or far away, and a polygon that pinches
 * to nothing is a razor-pointed wedge — which is what the last review saw as
 * "small white chevrons, a repeated stamp with identical spacing" low on the
 * left of the face. Holding a quarter of the thickness at zero transmission
 * means the ribbon narrows and fades instead of terminating in a point.
 */
const TRANS_FLOOR = 0.25
/**
 * How much of the translucent zone survives at the far end of the frame.
 *
 * Carried by ribbon *thickness* rather than by fill opacity, because thickness
 * is a per-column quantity and opacity is per-fill: doing it with opacity means
 * cutting the lip into zones, and every zone boundary is a vertical seam.
 */
const TRANS_FAR = 0.34
/** Extra punch on the near break, tapering to nothing by this column fraction. */
const TRANS_NEAR_SPAN = 0.42

/**
 * Everything below the trough.
 *
 * At the pushed-in framing this is off the bottom edge for any wave the rider
 * can stand up on, and that is the point: it used to be "roughly 30% of the
 * canvas spending no information" in the words of the review that killed the
 * last version. It survives only for the low-section case, and it is a dark
 * slate now rather than the #0a1a2c void that read as the part nobody finished.
 */
const DEEP = sea(0x1e2c3c)

/** The four judged components, in the order they appear on the results card. */
const BAR_LABELS = ['TUBE', 'AIR', 'CARVE', 'FLOW'] as const
const BAR_MAX = [3.4, 2.6, 1.8, 2.2] as const
// Nothing in the HUD may use the rider's reserved hue. These are drawn from the
// water instead, so the only saturated warm in the frame is him. Nor may the
// HUD carry the brightest or the most saturated thing on screen: a neutral
// review put a gold score third in the focal order, ahead of the player. Every
// one of these sits below the lit lip in value and below 0.45 in chroma.
const BAR_COLORS: readonly Hex[] = [TRANSMIT_MID, 0xd9e6d2, 0x7fb4de, 0xbcd9e8]

/**
 * Judged tenths, shown as points.
 *
 * Presentation only. The simulation still scores 0..10 exactly the way the
 * original judges this event, `updateScore` is untouched, and every debug
 * report still carries that number — this is the single multiplier between the
 * judged value and the glyphs on the plate.
 *
 * A blind review that picked this frame anyway still called the HUD a debug
 * build, and "SCORE / 10 -> 0.2" was half of the reason: a denominator printed
 * next to a value is how a test harness writes a number, and a 0.2 on a ten
 * scale reads as a build that has stopped computing rather than as a ride that
 * has not scored yet. A cabinet prints points. A perfect ride is 10000 of them.
 */
const SCORE_POINTS = 1000

const CAUSTICS = 26
const SHAFTS = 5
/** Caustic bands read through the water below the terminator. */
const DEEP_CAUSTICS = 14
/** Sun shafts falling into the water and attenuating with depth. */
const DEEP_SHAFTS = 5
/**
 * Wind chop drawn across the face.
 *
 * The push-in makes a mass of water 700 screen pixels tall, and a 700px mass
 * with nothing in it is measured — correctly — as dead frame however nicely it
 * is graded. These are short strokes lying along the local surface angle, at
 * four weights and an irregular pitch, so the wall has a grain running down the
 * line instead of being a clean ramp with contour lines in it.
 */
const CHOP = 64
/** Samples of the rider's track kept for the wake and the foam trail. */
const WAKE_LEN = 44

export class Surfing implements Scene {
  readonly id = 'surfing'

  private ctx!: SceneContext
  private pal = Palettes.surfing
  private wave = new Wave({ stillY: STILL_Y, minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT })

  // --- scene graph ----------------------------------------------------------
  /**
   * The canted, pushed-in camera. Everything in the world hangs off this; the
   * HUD does not, because a tilted readout is a gimmick rather than a frame.
   */
  private stage = new Container()
  private sky!: Sky
  private parallax!: Parallax
  private foreParallax!: Parallax
  private birds = new Container()
  /** Wave surface, computed in screen space every frame. */
  private waveLayer = new Container()
  private waveGfx = new Graphics()
  /** Wind chop lying along the face. Texture inside the biggest mass. */
  private chopGfx = new Graphics()
  /** Light transmitted through the thin water at the lip. The shot. */
  private transGfx = new Graphics()
  /** The hot spot where the sun sits directly behind the crest. */
  private lipGlow!: Sprite
  /**
   * The pocket: the water immediately behind the rider, lit through.
   *
   * This exists for one reason, which is the focal order. The rider is a
   * near-black silhouette and the brief is that he sits at the frame's
   * strongest value break; this puts that break where he is rather than hoping
   * the wave happens to supply one. It is also true — the pocket is the thinnest
   * water on a breaking wave and it is exactly where a surfer wants to be.
   */
  private pocketGlow!: Sprite
  private causticLayer = new Container()
  /** Submerged light: caustic bands and shafts below the terminator. */
  private deepLayer = new Container()
  private deepCaustics: Sprite[] = []
  private deepCausticSeed = new Float32Array(DEEP_CAUSTICS * 3)
  private deepShafts: Sprite[] = []
  /** Irregular spacing and width for the shafts, so they are not a fence. */
  private shaftOffset = new Float32Array(DEEP_SHAFTS)
  private shaftWidth = new Float32Array(DEEP_SHAFTS)
  private foamGfx = new Graphics()
  /** Particles and the surfer, in world space, scrolled by the camera. */
  private worldLayer = new Container()
  /** Displacement wake and the foam trail off the last turn. */
  private wakeGfx = new Graphics()
  private contact!: ContactShadow
  /** The long cast shadow the rider throws down the face, away from the sun. */
  private castShadow!: Sprite
  /**
   * The near plane, in screen space: spray torn across the lens.
   *
   * There is no near *water* left to draw at this magnification, so what is in
   * front of the camera is weather rather than a band — one tier of spray at a
   * scale and a speed nothing else in the frame runs at, crossing the frame
   * bottom-right to top-left, against the light.
   */
  private nearLayer = new Container()
  private nearMist!: ParticleSystem
  /** The thrown lip and the barrel, drawn over the surfer. */
  private overLayer = new Container()
  private curlGfx = new Graphics()
  private curtainGfx = new Graphics()
  private tubeDark!: Sprite
  private tubeGlow!: Sprite
  private shafts: Sprite[] = []

  private surfer!: Surfer
  /**
   * Two foam systems, not one.
   *
   * A particle system carries a single texture, and a single texture repeated
   * a hundred times at one silhouette is the "repeated stamp" note in another
   * costume. Two blobs at different seeds, picked between at emit, plus the
   * per-particle rotation and scale spread, is enough that no two puffs in a
   * burst are the same shape.
   */
  private foam!: ParticleSystem
  private foamB!: ParticleSystem
  private spray!: ParticleSystem
  private mist!: ParticleSystem

  /** The rider's screen x this frame. Hue, value and line converge on it. */
  private riderSx = CAM_ANCHOR

  /** Rider track, newest last. World space. Drives the wake and foam trail. */
  private wakeX = new Float32Array(WAKE_LEN)
  private wakeY = new Float32Array(WAKE_LEN)
  private wakeLoad = new Float32Array(WAKE_LEN)
  private wakeCount = 0
  private wakeAccum = 0

  private causticSprites: Sprite[] = []
  private causticSeedX = new Float32Array(CAUSTICS)
  private causticSeedF = new Float32Array(CAUSTICS)
  private causticSeedS = new Float32Array(CAUSTICS)
  /** Chop seeds: x along the line, height fraction, length, weight. */
  private chopSeed = new Float32Array(CHOP * 4)
  private birdGfx: Graphics[] = []

  // Per-column wave geometry, rebuilt each frame. Allocated once.
  private colX = new Float32Array(COLS)
  /** World x of each column, so every drawn edge can carry its own ripple. */
  private colWx = new Float32Array(COLS)
  private colCrest = new Float32Array(COLS)
  private colTrough = new Float32Array(COLS)
  private colH = new Float32Array(COLS)
  private colPitch = new Float32Array(COLS)
  private colBroken = new Float32Array(COLS)

  // The rolled lip, rebuilt each frame into pre-allocated scratch. Five edges,
  // each on its own phase, which is what stops the lip reading as a sheet:
  //   A  the back of the roll, ABOVE the crest — the thickness, against the sky
  //   B  the thrown tip, forward and down
  //   C  the underside of the roll, in its own shadow
  //   D  where the falling sheet re-enters the face
  private lipAy = new Float32Array(COLS)
  private lipBx = new Float32Array(COLS)
  private lipBy = new Float32Array(COLS)
  private lipCx = new Float32Array(COLS)
  private lipCy = new Float32Array(COLS)
  private lipDy = new Float32Array(COLS)
  /** Length of the curtain falling off the tip, 0 on an unbroken shoulder. */
  private lipFall = new Float32Array(COLS)

  // --- simulation state -----------------------------------------------------
  private state: RideState = 'riding'
  /** World position along the line. The wave field is a function of this. */
  private lineX = 0
  /** Speed down the line, px/s. */
  private vx = BASE_LINE_SPEED
  /** Position on the face: 0 in the trough, 1 at the lip. */
  private faceT = 0.45
  /** Speed along the face, px/s. Positive climbs. */
  private vFace = 0
  private facing = 1

  // airborne
  private ax = 0
  private ay = 0
  private avx = 0
  private avy = 0
  private rot = 0
  private rotVel = 0
  private spin = 0
  private grabHeld = 0
  private launchY = 0
  private airPeakY = 0

  private downTimer = 0
  private cutbackT = 0
  private cutbackVisual = 0

  // tube
  private tubed = false
  private tubeTime = 0
  private tubeRun = 0
  private tubeAmount = 0

  // scoring, all out of ten
  private tubePts = 0
  private airPts = 0
  private carvePts = 0
  private flowPts = 0
  private airCredit = 0
  private carveCredit = 0
  private flowCredit = 0
  /** Falls this run. `MAX_FALLS` of them ends it, and each costs 0.85. */
  private wipeouts = 0
  private score = 0

  private timeLeft = RUN_SECONDS
  private finished = false
  /** Why the run stopped. Read by `debug`, so a gate can tell the two apart. */
  private endedBy: 'time' | 'falls' = 'time'
  private callText = ''
  private callTimer = 0
  private flash = 0

  // render interpolation
  private prevX = 0
  private prevY = 0
  private prevRot = 0
  private curX = 0
  private curY = 0
  private curRot = 0
  private camX = 0
  private camY = 0

  /** Scratch for face samples. Reused so update and render never allocate. */
  private fs: FaceSample = { fx: 0, fy: 0, angle: 0 }
  /** Cached local wave conditions at the surfer, refreshed once per step. */
  private localH = MIN_HEIGHT
  private localPitch = 0
  private localEnergy = 0.5
  private localAngle = 0

  // audio
  private waveBed: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null
  private tubeBed: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null

  // --- hud ------------------------------------------------------------------
  //
  // Every part of this is from `src/render/Hud.ts`, which exists because the
  // interface was the loudest amateur signal in three separate blind reviews.
  // This event's own entry in that list, quoted in full because it is the
  // cheapest thing on the list to have got wrong:
  //
  //   "The HUD is a debug panel shipped into a beauty shot. Four empty meter
  //    bars (TUBE / AIR / CARVE / FLOW) with zero fill, 'UNDERWAVE 0.0s'
  //    colliding with the panel's bottom edge, 'SCORE / 10' set in 6px caps,
  //    and a bare unlabeled white slider floating at bottom-right. Delete or
  //    fill them; nothing reads worse than instrumentation at rest."
  //
  // Four faults, four fixes, none of them a matter of taste. `Meter` never
  // renders empty, so a run that has scored nothing yet still shows four
  // working instruments. `Readout` sets its label at 16px and its value at
  // 34px on a plate with a 16px inset, so there is no 6px type and nothing can
  // collide with an edge it has no business touching. The tube clock and the
  // speed bar are a labelled readout and a labelled meter on the same margin
  // as everything else, so there is no bare slider. And the full-width band is
  // gone: a band plus plates is two box treatments, and plates win.
  //
  // A later blind review picked this frame over the reference and still called
  // what was left "a HUD that reads like a debug build": the 'SURFING /
  // SUNDOG' badge in the top-left of a *gameplay* frame, the '/ 10'
  // denominator, and four component tracks that are all honestly near zero
  // five seconds into a run. Flooring a meter's fill stops it reading as
  // broken; it cannot stop four of them reading as unfinished. So the play
  // field now carries only what a rider can act on — score, clock, speed,
  // barrel time — and the judged breakdown moved to the results card, where
  // the numbers are final and nothing is competing with them.
  private hud = new Container()
  private timeOut!: Readout
  private scoreOut!: Readout
  private tubeOut!: Readout
  /** The falls count, and the only place the three-falls rule is visible. */
  private fallsOut!: Readout
  private meters: Meter[] = []
  private speedMeter!: Meter
  /** Trick calls, anchored to the rider rather than floating in the sky. */
  private callout!: Callout
  /**
   * The results screen.
   *
   * The original ends a run on a row of five judges holding up cards, and this
   * remake ended it on a centred plate reading `FINAL 8830`. See `src/game/ui/Results.ts`:
   * the judged 0..10 is unchanged, the five cards average to it exactly, and
   * the four component meters moved onto it as the secondary read.
   */
  private judges!: ResultsPanel
  /** Latched, so the results screen is switched on once and not every frame. */
  private resultsShown = false
  private flashQuad!: Sprite

  // =========================================================================
  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = this.pal

    // The cant and the push-in, applied once to everything that is world.
    this.stage.pivot.set(ctx.width / 2, ctx.height / 2)
    this.stage.position.set(ctx.width / 2, ctx.height / 2 + STAGE_DY)
    this.stage.rotation = TILT
    this.stage.scale.set(ZOOM)
    this.stage.interactiveChildren = false
    ctx.root.addChild(this.stage)

    this.sky = new Sky(pal, {
      width: ctx.width, height: ctx.height,
      // Low dawn sun ahead down the line, so the wave face is backlit and every
      // lip in the frame glows from behind.
      // Low dawn sun ahead down the line, placed so the push-in keeps it in
      // frame: it sits just above the lip in the upper right, which is the one
      // corner the wave does not occupy, and it is the reason the crest glows.
      sunX: SUN_X / 1920, sunY: SUN_Y / 1080, sunSize: 230, sunIntensity: 0.8,
      // The haze band is hung on the crest rather than on the horizon — the
      // horizon is behind the wave now — so the sky warms into the lip.
      horizonY: 470,
    })
    this.stage.addChild(this.sky.container)
    // The sun is the key, not the subject.
    //
    // "The brightest thing is empty sky at upper right. The eye lands on
    // nothing." That was a sun core at 0.42 over a sky ramping to near-white,
    // and between them they out-valued the hero of the picture. The sky under
    // it is now a quiet mid band, and the sun is turned down to match: it
    // still tells you where the light is coming from, and the brightest thing
    // in the frame is the water it is shining through.
    this.sky.setSunIntensity(0.24)

    this.parallax = new Parallax()
    this.stage.addChild(this.parallax.container)
    this.buildBackdrop()
    this.stage.addChild(this.birds)
    this.buildBirds()

    // Order inside the wave layer is the light model, bottom up: the body, the
    // submerged light read through it, the streaks running down the face, then
    // the transmission through the lip over the top of all of it, then foam.
    this.pocketGlow = new Sprite(radialGlow(mix(TRANSMIT_MID, KEY.tint, 0.22), 256, 1.6))
    this.pocketGlow.anchor.set(0.5)
    this.pocketGlow.blendMode = 'add'
    this.waveLayer.addChild(
      this.waveGfx, this.deepLayer, this.chopGfx, this.causticLayer, this.transGfx,
      this.pocketGlow, this.foamGfx,
    )
    this.transGfx.blendMode = 'add'
    this.waveLayer.interactiveChildren = false
    this.worldLayer.interactiveChildren = false
    this.stage.addChild(this.waveLayer)
    this.buildCaustics()
    this.buildChop()
    this.buildDeepLight()

    // The near plane goes down BEFORE the world layer, on purpose. It is high
    // enough to crop the foot of the wave, which is the whole point of it, and
    // that means it is also high enough to swallow the rider at the bottom of a
    // bottom turn. A near-plane occluder may crop the stage; it may never crop
    // the subject.
    this.foreParallax = new Parallax()
    this.stage.addChild(this.foreParallax.container)
    this.buildForeground()

    this.stage.addChild(this.worldLayer)
    // Foam with a silhouette: a lumpy closed shape with a shaded underside and
    // a rim where the sun catches it, instead of an airbrush dot. The shade is
    // taken off the face's own ramp so the puffs sit in the water's value
    // world rather than being white paper laid on it.
    const foamShade = sea(grade(FACE_MID, { valScale: 0.72, satScale: 1.05 }))
    this.foam = new ParticleSystem(
      foamBlob(0xeef8fb, foamShade, mix(Core.paperWhite, pal.light, 0.5), 0x51, 96), 150,
    )
    this.foamB = new ParticleSystem(
      foamBlob(0xe2f2f6, foamShade, mix(Core.paperWhite, pal.light, 0.35), 0xc7, 96), 90,
    )
    this.mist = new ParticleSystem(windStreak(lighten(pal.haze, 0.4), 64, 0.26), 96)
    this.worldLayer.addChild(
      this.mist.container, this.foam.container, this.foamB.container, this.wakeGfx,
    )

    // The rider sits on the water, so the occlusion under the board goes down
    // before he does. Without this he is pasted onto a colour. Both of these
    // are sized for the push-in: the review's note was that "the board meets
    // the water with zero evidence", and evidence has to be big enough to see.
    this.contact = new ContactShadow({
      color: sea(grade(FACE_CORE, { valScale: 0.52, satScale: 1.1 })),
      width: 210, height: 44, alpha: 0.72, maxGap: 360,
    })
    this.castShadow = new Sprite(
      softDot(sea(grade(FACE_CORE, { valScale: 0.58, satScale: 1.1 })), 96, 0.3),
    )
    this.castShadow.anchor.set(0.5)
    this.castShadow.eventMode = 'none'
    this.worldLayer.addChild(this.castShadow, this.contact.sprite)

    // Reserved chroma: the suit is the one saturated warm in the frame and
    // nothing else — water, sky, foam, HUD — is allowed anywhere near it. See
    // `sea()`: every other colour in the scene is capped below it by
    // construction, so the rider wins the chroma contest rather than losing it
    // to a mass of dark navy the way the last version did.
    //
    // Scale: 0.86 here and the stage push-in multiplies it by ZOOM, so the rig
    // stands about 360 px — a third of the frame — trimming. The review looked
    // at the last one, at an eighth, and called it "a hero the size of a
    // thumbnail floating in the middle of the middle band".
    this.surfer = new Surfer(RIDER_SUIT, RIDER_BOARD, KEY.tint)
    this.surfer.setScale(0.86)
    this.worldLayer.addChild(this.surfer.container)

    // Spray is a streak, not a dot, and every particle is rotated onto its own
    // velocity at emit. "Randomly scattered rather than following the lip's
    // direction or the light" was the review's worst craft note; a round dot
    // cannot follow anything, because it has no direction to point.
    this.spray = new ParticleSystem(sprayDrop(Core.sunWhite, 0x3b, 96), 190, 'add')
    this.worldLayer.addChild(this.spray.container)

    // The near plane, in screen space: one tier of spray torn across the lens,
    // at a scale and speed nothing else in the frame runs at.
    this.stage.addChild(this.nearLayer)
    this.nearMist = new ParticleSystem(
      windStreak(mix(pal.light, Core.paperWhite, 0.35), 64, 0.24), 56,
    )
    this.nearLayer.addChild(this.nearMist.container)
    this.nearLayer.interactiveChildren = false

    this.overLayer.addChild(this.curlGfx, this.curtainGfx)
    this.stage.addChild(this.overLayer)
    this.buildTubeFx()

    this.buildHud()
    ctx.root.addChild(this.hud)

    this.resetRun()

    // The wave bed. Cutoff and gain ride how close the break is, so the roar
    // builds as the section catches up and goes muffled and huge inside the tube.
    this.waveBed = ctx.audio.loopNoise({ cutoff: 620, q: 0.7, gain: 0.05 })
    this.tubeBed = ctx.audio.loopNoise({ cutoff: 180, q: 0.9, gain: 0.0001 })

    this.exposeResultsHandle()
  }

  /**
   * `window.__cg.surfResults(score?)` — jump straight to the judges' panel.
   *
   * A results screen that only appears after seventy-five seconds of play is a
   * screen nobody can photograph, and a capture script that has to *earn* a
   * given score to check the panel's arithmetic is a capture script that tests
   * the physics instead. This ends the run where it stands, optionally pinning
   * the judged value first, and redraws the panel from it.
   *
   * It is a debug affordance and nothing else: it is not reachable from any
   * input, it changes no rule, and `updateScore` is not involved. `App` puts
   * `__cg` on the window before any scene enters, so this extends that object
   * rather than replacing it.
   */
  private exposeResultsHandle(): void {
    const w = window as unknown as Record<string, unknown>
    const cg = (w.__cg ?? (w.__cg = {})) as Record<string, unknown>
    cg.surfResults = (score?: number): number => {
      if (typeof score === 'number') this.score = clamp(score, 0, 10)
      this.timeLeft = 0
      this.endedBy = 'time'
      // Deliberately not `endRun`: that recomputes the judged value from the
      // run's own credits, which is the opposite of pinning a score to check
      // the panel's arithmetic against.
      this.finished = true
      this.showResults()
      this.resultsShown = true
      this.judges.setVisible(true)
      return this.score
    }
    // `window.__cg.surfFalls(n?)` — the other ending. Books `n` falls (three by
    // default) and, if that reaches the limit, ends the run down the real
    // falls path, so the panel a capture photographs is the one a player who
    // ate it three times would get. The score is the run's own, not pinned.
    cg.surfFalls = (n = MAX_FALLS): number => {
      this.wipeouts = Math.max(0, Math.round(n))
      if (this.wipeouts >= MAX_FALLS) {
        this.endRun('falls')
        this.resultsShown = true
        this.judges.setVisible(true)
      }
      return this.wipeouts
    }
  }

  // ---------------------------------------------------------------- backdrop
  //
  // The push-in changed what a backdrop even is here. The old one was four
  // bands of open swell and a headland sitting between the horizon and the
  // crest: a second stack of horizontal lines, and the exact thing the review
  // called "three horizontal bands". None of it is reachable now — the horizon
  // sits below the crest's whole travel and the wave covers it — so what is
  // left behind the wave is sky, and the sky gets the work instead.
  //
  // Two cloud tiers, at different pitch, scale and value, sitting in the wedge
  // above the lip. They are what stops a quarter of the frame being a clean
  // vertical ramp, and they run the same way as the crest so the composition
  // keeps its one diagonal.
  private buildBackdrop(): void {
    const pal = this.pal

    // Open ocean, only ever seen over the top of a small section or from the
    // peak of an air. Graded almost all the way into the sky behind it.
    const open = new Graphics()
    open.rect(-80, HORIZON_Y - 2, 2100, 1080 - HORIZON_Y + 80)
      .fill(sea(grade(pal.far, atmosphericDepth(0.94, skyAt(pal, HORIZON_Y / 1080)))))
    open.moveTo(-80, HORIZON_Y - 1).lineTo(2020, HORIZON_Y - 1)
      .stroke({ color: lighten(pal.haze, 0.3), width: 2, alpha: 0.45 })
    this.parallax.container.addChild(open)

    // Cloud tiers.
    //
    // Each puff is **one closed path**, not a stack of circles: overlapping
    // translucent circles show every seam where they cross, which is what the
    // first pass of this looked like and it read as soap bubbles. A run of
    // half-circle arcs along a baseline gives a lumpy silhouette that fills as
    // a single shape, and `scatter()` keeps the lobes off an even pitch.
    //
    // They are lit from *underneath*, because the sun is low and behind the
    // wave. A cloud with a lit top in a frame whose entire premise is
    // backlight is the kind of mistake a reviewer registers without being able
    // to name it.
    const bank = (
      baseY: number, count: number, size: number, body: Hex, lit: Hex, alpha: number,
      seed: number,
    ) => (): Container => {
      const c = new Container()
      const g = new Graphics()
      const places = scatter({ count, from: 0, to: 2400, seed, scaleRange: [0.6, 1.55] })
      for (let i = 0; i < count; i++) {
        const pl = places[i]
        const r = size * pl.scale
        const y = baseY + (pl.variant - 1) * size * 0.36
        const lobes = 3 + (pl.variant % 2)
        const x0 = pl.x - r * (0.8 + lobes * 0.5)
        let x = x0
        g.moveTo(x, y)
        for (let k = 0; k < lobes; k++) {
          // Lobes of different radius and different height, tallest toward the
          // middle, and stepped closer together than they are wide so they
          // merge into one lumpy silhouette instead of reading as a row of
          // domes. It is one path, so the overlaps leave no seam.
          const lr = r * (0.40 + 0.60 * Math.sin(((k + 0.5) / lobes) * Math.PI))
            * (0.78 + (k % 2) * 0.4)
          const cx = x + lr * 0.86
          g.arc(cx, y - lr * (0.10 + (k % 2) * 0.2), lr, Math.PI, 0)
          x = cx + lr * 0.86
        }
        g.lineTo(x, y).closePath().fill({ color: body, alpha })
        // The lit underside, along the baseline only and only where the puff
        // actually is — a short warm edge, not a swoosh hung under it.
        g.moveTo(x0 + r * 0.3, y + 1)
          .lineTo(x - r * 0.3, y + 1)
          .stroke({ color: lit, width: 2.4 + r * 0.035, alpha: alpha * 0.95, cap: 'round' })
      }
      c.addChild(g)
      return c
    }

    // High and far: pale, and barely separated from the sky it sits in.
    //
    // Their value is now bracketed from both sides. At the old 0.55 mix they
    // sat at luminance 0.79, level with the lit face, and a cloud bank level
    // with the subject is a second light mass. Too far the other way and the
    // sky is a flat plane — measured, that alone put 16% of the frame into the
    // dead band. So they sit at 0.60: clearly above the sky they are in,
    // clearly below the water the light is coming through.
    this.parallax.addWrappingLayer(
      bank(
        292, 8, 44,
        mix(skyAt(pal, 0.40), Core.paperWhite, 0.45),
        mix(pal.light, Core.paperWhite, 0.4),
        0.7, 0x91ce21,
      ),
      { factorX: 0.018, factorY: 0.02, wrapWidth: 2400, copies: 3 },
    )
    // Low bank, sitting on the lip line: darker than the blown sky behind the
    // crest, so it is the thing that stops that corner being an empty mass.
    this.parallax.addWrappingLayer(
      // The low bank goes the other way: darker than the sky it sits in, so the
      // wedge above the lip carries a silhouette as well as a highlight.
      bank(
        398, 6, 58,
        sea(mix(skyAt(pal, 0.26), darken(pal.mid, 0.3), 0.62)),
        mix(pal.light, Core.sunWhite, 0.5),
        0.5, 0x2ad70b,
      ),
      { factorX: 0.045, factorY: 0.035, wrapWidth: 2400, copies: 3 },
    )

    // Cirrus: the cheapest structure a sky can carry, and the one that costs
    // no mass. Long thin streaks at two values and a shallow tilt that runs
    // the same way as the crest.
    const cirrus = (): Container => {
      const c = new Container()
      const g = new Graphics()
      const places = scatter({ count: 22, from: 0, to: 2400, seed: 0x51c2a7, scaleRange: [0.5, 1.7] })
      for (let i = 0; i < 22; i++) {
        const pl = places[i]
        const y = 246 + pl.jitter * pl.jitter * 214
        const len = 170 + pl.scale * 330
        const cool = pl.variant === 0
        g.moveTo(pl.x, y)
          .quadraticCurveTo(pl.x + len * 0.5, y + len * 0.05, pl.x + len, y + len * 0.13)
          .stroke({
            color: cool
              ? sea(mix(skyAt(pal, 0.30), darken(pal.near, 0.25), 0.55))
              : mix(skyAt(pal, 0.46), Core.paperWhite, 0.42),
            width: 3 + pl.scale * 7,
            alpha: cool ? 0.3 : 0.42,
            cap: 'round',
          })
      }
      c.addChild(g)
      return c
    }
    this.parallax.addWrappingLayer(cirrus, {
      factorX: 0.03, factorY: 0.025, wrapWidth: 2400, copies: 3,
    })

    // Two bands of open swell, kept only for the same rare frames the horizon
    // is visible in at all.
    const lines: [number, number, number, number, number][] = [
      [HORIZON_Y + 16, 4, 12, 0.92, 7],
      [HORIZON_Y + 58, 9, 22, 0.82, 4],
    ]
    for (let li = 0; li < lines.length; li++) {
      const [y, amp, thick, depth, k] = lines[li]
      const body = sea(grade(pal.far, atmosphericDepth(depth, skyAt(pal, y / 1080))))
      const cap = sea(grade(lighten(pal.haze, 0.45), atmosphericDepth(depth * 0.8, skyAt(pal, y / 1080))))
      const factory = (): Container => {
        const c = new Container()
        const sg = new Graphics()
        sg.moveTo(0, y)
        for (let x = 0; x <= 1920; x += 24) {
          sg.lineTo(x, y + Math.sin((x / 1920) * Math.PI * 2 * k + li * 1.7) * amp)
        }
        sg.lineTo(1920, y + thick + amp).lineTo(0, y + thick + amp).closePath().fill(body)
        sg.moveTo(0, y)
        for (let x = 0; x <= 1920; x += 24) {
          sg.lineTo(x, y + Math.sin((x / 1920) * Math.PI * 2 * k + li * 1.7) * amp)
        }
        sg.stroke({ color: cap, width: 1 + li * 0.8, alpha: 0.5 })
        c.addChild(sg)
        return c
      }
      this.parallax.addWrappingLayer(factory, {
        factorX: 0.06 + li * 0.06, factorY: 0.03 + li * 0.02, wrapWidth: 1920, copies: 3,
      })
    }
  }

  /**
   * Wind chop, seeded once and drawn against the face every frame.
   *
   * Placed with `scatter()` so the strokes do not sit on a pitch: the review's
   * standing note about this project is that repeated motifs at identical scale
   * and spacing are the thing that gives the work away.
   */
  private buildChop(): void {
    const places = scatter({ count: CHOP, from: 0, to: 1, seed: 0x3c0b21, scaleRange: [0.45, 1.6] })
    for (let i = 0; i < CHOP; i++) {
      const pl = places[i]
      // World x along the line, spread over two frames' worth of wave.
      this.chopSeed[i * 4] = pl.x * 2400
      // Height fraction on the face. Weighted down the wall, where the mass is.
      this.chopSeed[i * 4 + 1] = 0.05 + pl.jitter * 0.86
      this.chopSeed[i * 4 + 2] = pl.scale
      this.chopSeed[i * 4 + 3] = pl.variant
    }
  }

  private buildBirds(): void {
    for (let i = 0; i < 3; i++) {
      const g = new Graphics()
      const tint = grade(this.pal.shade, atmosphericDepth(0.8, skyAt(this.pal, 0.42)))
      g.moveTo(-11, 0).quadraticCurveTo(-5, -5, 0, -1)
        .quadraticCurveTo(5, -5, 11, 0)
        .quadraticCurveTo(5, -2, 0, 1)
        .quadraticCurveTo(-5, -2, -11, 0)
        .closePath().fill(tint)
      g.scale.set(0.8 + i * 0.22)
      this.birdGfx.push(g)
      this.birds.addChild(g)
    }
    this.birds.interactiveChildren = false
  }

  /** Streaks of light running down the face. Positioned only, never rebuilt. */
  private buildCaustics(): void {
    const tex = horizontalGradient(
      [{ t: 0, c: 0xffffff, a: 0 }, { t: 0.5, c: 0xffffff, a: 1 }, { t: 1, c: 0xffffff, a: 0 }],
      128,
    )
    const rng = this.ctx.rng
    for (let i = 0; i < CAUSTICS; i++) {
      const s = new Sprite(tex)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      s.tint = mix(0xbfe8ea, this.pal.light, rng.next() * 0.45)
      this.causticSeedX[i] = rng.range(0, 2200)
      this.causticSeedF[i] = rng.range(0.1, 0.9)
      this.causticSeedS[i] = rng.next()
      this.causticSprites.push(s)
      this.causticLayer.addChild(s)
    }
    this.causticLayer.interactiveChildren = false
  }

  /**
   * Submerged light: the content of what used to be a dead flat bottom third.
   *
   * Two families, both read *through* the water rather than drawn on top of it:
   * caustic bands that ripple across the foot of the face and into the near
   * water, and shafts falling away from the sun that attenuate with depth. Both
   * are sprites, positioned against the column sample already taken this frame,
   * so the whole pass is transform writes.
   */
  private buildDeepLight(): void {
    const rng = this.ctx.rng
    const bandTex = horizontalGradient(
      [{ t: 0, c: 0xffffff, a: 0 }, { t: 0.5, c: 0xffffff, a: 1 }, { t: 1, c: 0xffffff, a: 0 }],
      128,
    )
    for (let i = 0; i < DEEP_CAUSTICS; i++) {
      const s = new Sprite(bandTex)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      // Depth below the terminator, 0 at the core shadow to 1 in the near water.
      //
      // Jittered off the even step it used to be. `i / (N - 1)` puts fourteen
      // bands down the face at one exact pitch, and an exact pitch is the
      // "repeated stamp with identical spacing" a reviewer picked out of the
      // last capture — the regularity reads even when the individual mark does
      // not. The jitter is bigger than the step, so the order shuffles too.
      const d = clamp01(i / (DEEP_CAUSTICS - 1) + rng.spread(0.14))
      this.deepCausticSeed[i * 3] = rng.range(0, 2400)
      this.deepCausticSeed[i * 3 + 1] = d
      this.deepCausticSeed[i * 3 + 2] = rng.range(0, Math.PI * 2)
      // Chroma, not value: the light down here is the trough bounce, so it is
      // the cool end of the water's own hue rather than a white smear.
      s.tint = mix(FACE_BOUNCE, TRANSMIT_DEEP, 0.25 + d * 0.4)
      this.deepCaustics.push(s)
      this.deepLayer.addChild(s)
    }

    // Shafts: bright where they enter the surface, gone by the time they are
    // deep. A vertical gradient is the attenuation, so no per-frame maths.
    const shaftTex = verticalGradient(
      [
        { t: 0, c: 0xffffff, a: 0 },
        { t: 0.16, c: 0xffffff, a: 0.9 },
        { t: 0.62, c: 0xffffff, a: 0.26 },
        { t: 1, c: 0xffffff, a: 0 },
      ],
      128,
    )
    for (let i = 0; i < DEEP_SHAFTS; i++) {
      const s = new Sprite(shaftTex)
      this.shaftOffset[i] = rng.range(-120, 120)
      this.shaftWidth[i] = rng.range(16, 94)
      s.anchor.set(0.5, 0)
      s.blendMode = 'add'
      s.tint = mix(this.pal.light, TRANSMIT_MID, 0.3 + (i % 3) * 0.12)
      this.deepShafts.push(s)
      this.deepLayer.addChild(s)
    }
    this.deepLayer.interactiveChildren = false

    // The hot spot: the sun is behind the crest, so the crest directly in front
    // of it blows out. This is what stops the translucency reading as a flat
    // ribbon of colour painted along the whole lip.
    this.lipGlow = new Sprite(radialGlow(mix(KEY.tint, TRANSMIT_MID, 0.4), 256, 1.7))
    this.lipGlow.anchor.set(0.5)
    this.lipGlow.blendMode = 'add'
    this.waveLayer.addChild(this.lipGlow)
  }

  /**
   * Near water: the dark mass, and the near-plane occluder that crops the
   * frame at an angle.
   *
   * Two jobs. The colour job is that the near plane holds the lowest value in
   * the frame while carrying the *highest* saturation, which is the direction
   * aerial perspective actually runs.
   *
   * The compositional job is the angle. The whole layer is canted against the
   * stage — `FG_TILT` is a counter-rotation, so on screen the near water rises
   * at about a third of the rate the crest does. The two lines therefore
   * converge toward the far end of the wave instead of running parallel, which
   * is the difference between a diagonal and a stack of bands. It also sits
   * high enough to cut the foot of the face off, so the frame is cropped rather
   * than fully described — and high enough that the water in front of the
   * camera is a mass and not a hairline along the bottom edge.
   *
   * The bands stay horizontal in their own space, so they still tile without a
   * seam; the cant is applied once to the container that holds them.
   */
  private buildForeground(): void {
    const pal = this.pal
    const specs: [number, number, number, Hex, number][] = [
      [FG_Y, 13, 0.3, sea(grade(DEEP, { satScale: 1.02, valScale: 1.0 })), 4],
      [FG_Y + 54, 17, 0.52, sea(grade(DEEP, { satScale: 1.06, valScale: 0.8 })), 3],
    ]
    for (let i = 0; i < specs.length; i++) {
      const [y, amp, factor, color, k] = specs[i]
      const edge = mix(pal.light, mix(pal.haze, color, 0.3), 0.45)
      const wave = (x: number): number => y + Math.sin((x / 1920) * Math.PI * 2 * k + i * 2.1) * amp
      const factory = (): Container => {
        const c = new Container()
        const g = new Graphics()
        g.moveTo(0, y)
        for (let x = 0; x <= 1920; x += 20) g.lineTo(x, wave(x))
        // Deep enough that the cant can never open a gap at the bottom corners.
        g.lineTo(1920, 1720).lineTo(0, 1720).closePath().fill(color)
        // The lit edge, in eight pieces of unequal weight. One continuous
        // stroke at one width reads as vector art; chop catching a low sun
        // does not light evenly along its length.
        for (let seg = 0; seg < 8; seg++) {
          const x0 = (seg * 1920) / 8
          const x1 = ((seg + 1) * 1920) / 8
          const bias = 0.5 + 0.5 * Math.sin((seg / 8) * Math.PI * 2 * 3 + i * 1.3)
          g.moveTo(x0, wave(x0))
          for (let x = x0 + 16; x <= x1; x += 16) g.lineTo(x, wave(x))
          g.stroke({
            color: edge,
            width: 1.2 + bias * 2.6,
            alpha: 0.2 + bias * 0.45,
            cap: 'round',
          })
        }
        c.addChild(g)
        return c
      }
      this.foreParallax.addWrappingLayer(factory, { factorX: factor, factorY: 1, wrapWidth: 1920, copies: 3 })
    }
    this.foreParallax.container.pivot.set(960, FG_Y)
    this.foreParallax.container.position.set(960, FG_Y)
    this.foreParallax.container.rotation = FG_TILT
  }

  private buildTubeFx(): void {
    // Light coming through the thin part of the curl, the one thing that makes a
    // barrel read as a hollow space rather than a blue shape over a surfer.
    const shaftTex = horizontalGradient(
      [{ t: 0, c: 0xffffff, a: 0 }, { t: 0.42, c: 0xffffff, a: 0.85 }, { t: 1, c: 0xffffff, a: 0 }],
      128,
    )
    // Order matters: the darkening pass goes down first, and the shafts and the
    // exit glow are added back on top of it. Reversed, the barrel is just dim.
    this.tubeDark = new Sprite(Texture.WHITE)
    this.tubeDark.tint = darken(this.pal.shade, 0.55)
    // Oversized: the stage is canted and overscanned, so a 1920x1080 quad no
    // longer reaches the corners of the frame it is supposed to be darkening.
    this.tubeDark.x = -200
    this.tubeDark.width = 2320
    this.tubeDark.height = 1560
    this.tubeDark.alpha = 0
    this.overLayer.addChild(this.tubeDark)

    for (let i = 0; i < SHAFTS; i++) {
      const s = new Sprite(shaftTex)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      s.tint = mix(KEY.tint, 0xffffff, 0.3)
      s.alpha = 0
      this.shafts.push(s)
      this.overLayer.addChild(s)
    }

    this.tubeGlow = new Sprite(radialGlow(this.pal.light, 256, 1.9))
    this.tubeGlow.anchor.set(0.5)
    this.tubeGlow.blendMode = 'add'
    this.tubeGlow.alpha = 0
    this.overLayer.addChild(this.tubeGlow)
    this.overLayer.interactiveChildren = false
  }

  // --------------------------------------------------------------------- hud
  //
  // Two faces used by role, not at random: Anton carries every number and every
  // shouted word, Archivo at one weight carries every label. Both come out of
  // `Hud.ts`, so the six events share one shape language rather than each
  // inventing their own.
  //
  // Colour rule: the rider owns the vermilion and nothing here may touch it.
  // `themeFor` derives the plates from this event's own palette, so the
  // interface is the water's temperature and there is not one pure grey in a
  // frame that has no greys. The meters are drawn from the water and the sun
  // and are held below the value of the lit lip.
  private hint?: ControlHint

  private buildHud(): void {
    const t = themeFor(this.pal)

    // How to play. Four of the six events shipped without this; the menu
    // only explains how to drive the menu. It fades after nine seconds so it
    // does not become furniture.
    // Plain language, not surf jargon. A player: "what is carve and cut back in
    // surfing? not clear" — and they were right: DRIVE, CARVE, CUT BACK and
    // PUMP are four terms of art in a row, on the one event whose controls are
    // the least guessable. A legend has to teach the action; the jargon still
    // lives where it belongs, in the scoring call-outs (CUTBACK, ROUNDHOUSE,
    // TUBE), where it reads as flavour rather than as instructions.
    this.hint = new ControlHint(t, [
      { key: 'UP / DOWN', action: 'UP / DOWN THE WAVE' },
      { key: 'RIGHT', action: 'SPEED UP' },
      { key: 'LEFT', action: 'TURN BACK' },
      { key: 'SPACE', action: 'PUMP · AIR AT LIP' },
    ])
    this.hud.addChild(this.hint.container)
    const M = HUD_MARGIN

    // No title card and no sponsor ident.
    //
    // A 'SURFING / SUNDOG' badge in the top-left corner is a title card plus a
    // sponsor plate sitting on top of live play, which is what a dev overlay
    // looks like: a shipped arcade title does not label its own event over the
    // field, because the cabinet and the menu already did. Deleting it also
    // hands the upper-left quarter back to the lip — the curl is there, and it
    // is where the lower-left-to-upper-right motion vector ends up.

    this.timeOut = new Readout(t, 'TIME', { width: 196 })
    this.timeOut.container.position.set(960 - 98, M)
    this.hud.addChild(this.timeOut.container)

    // Falls, on the clock's shoulder: same plate, same top margin, same
    // height, one 14px gutter away. Nothing that was already on the HUD moves,
    // and the upper-left quarter stays with the curl. Three falls end the run,
    // so the rule has to be legible while there is still a decision to make
    // — "1 / 3" before a big section is the whole risk in four glyphs.
    this.fallsOut = new Readout(t, 'FALLS', { width: 150 })
    this.fallsOut.container.position.set(960 - 98 - 14 - 150, M)
    this.hud.addChild(this.fallsOut.container)

    // Points, not a decimal with its denominator printed beside it. See
    // `SCORE_POINTS`: judging is untouched, only the glyphs change.
    this.scoreOut = new Readout(t, 'SCORE', { width: 272, align: 'right' })
    this.scoreOut.container.position.set(1920 - M - 272, M)
    this.hud.addChild(this.scoreOut.container)

    // The tube clock and the speed bar. Both labelled, both on the same plate
    // language as everything else, both clear of the edge they used to sit on:
    // "'UNDERWAVE 0.0s' colliding with the panel's bottom edge" and "a bare
    // unlabeled white slider floating at bottom-right" were one fault twice.
    this.tubeOut = new Readout(t, 'UNDERWAVE', { width: 272, align: 'right' })
    this.tubeOut.container.position.set(1920 - M - 272, 876)
    this.hud.addChild(this.tubeOut.container)

    const speedPanel = new Container()
    speedPanel.addChild(plate(t, 272, 74))
    this.speedMeter = new Meter(t, 'SPEED', 232, mix(Core.paperWhite, 0x7fb4de, 0.5))
    this.speedMeter.container.position.set(20, 18)
    speedPanel.addChild(this.speedMeter.container)
    speedPanel.position.set(1920 - M - 272, 1080 - M - 74)
    this.hud.addChild(speedPanel)

    // Trick calls ride with the rider. "Feedback belongs to the thing it
    // describes" — a name floating in the middle of the sky is a second
    // subject competing with the first one.
    this.callout = new Callout(66)
    this.hud.addChild(this.callout.container)

    // The judged breakdown, on the results card instead of on the play field.
    //
    // A score with no visible breakdown is a number nobody can play toward, so
    // the four components stay — but they belong where they are finished. Four
    // stacked tracks in the corner of a live frame are four widgets that are
    // all honestly near zero for the first half of a run, and a floor under
    // the fill stops each one reading as broken without stopping the set of
    // them reading as unbuilt. Here they are full-width, at the end, with the
    // whole card to themselves.
    this.judges = new ResultsPanel(this.pal, 'SURFING', BAR_LABELS, BAR_COLORS)
    this.meters.push(...this.judges.meters)
    // Added after every play-field readout, so the panel covers the HUD it
    // replaces rather than fighting it for the same pixels.
    this.hud.addChild(this.judges.container)

    this.flashQuad = new Sprite(Texture.WHITE)
    this.flashQuad.width = 1920
    this.flashQuad.height = 1080
    this.flashQuad.alpha = 0
    this.flashQuad.blendMode = 'add'
    this.hud.addChild(this.flashQuad)
    this.hud.interactiveChildren = false
  }

  private resetRun(): void {
    this.state = 'riding'
    // Drop in on a section that is already standing up, with the peel just
    // behind the surfer's shoulder. The swell field is deterministic, so this
    // is a chosen frame rather than a lucky one: whitewater low on the left, a
    // hollow peak throwing over the rider, and the shoulder tapering away to
    // the right toward the horizon. It is also the opening every surf film has.
    this.lineX = 3680
    this.wave.breakX = this.lineX - 470
    this.wave.foamLength = 700
    this.wave.reformT = 0
    this.vx = BASE_LINE_SPEED
    this.faceT = 0.62
    this.vFace = 0
    this.facing = 1
    this.rot = 0
    this.spin = 0
    this.timeLeft = RUN_SECONDS
    this.finished = false
    this.endedBy = 'time'
    this.tubeTime = 0
    this.tubeRun = 0
    this.airCredit = 0
    this.carveCredit = 0
    this.flowCredit = 0
    this.wipeouts = 0
    this.callTimer = 0
    this.wakeCount = 0
    this.wakeAccum = 0
    this.refreshLocal()
    this.placeOnFace()
    this.prevX = this.curX
    this.prevY = this.curY
    this.prevRot = this.curRot
    this.camX = this.curX - CAM_ANCHOR + this.vx * CAM_LEAD
    this.camY = camYFor(this.curY, this.wave.crestYAt(this.curX))
  }

  /** Cache the wave conditions where the surfer is. Once per step. */
  private refreshLocal(): void {
    this.localH = this.wave.heightAt(this.lineX)
    this.localPitch = this.wave.pitchAt(this.lineX)
    this.localEnergy = this.wave.energyAt(this.lineX)
  }

  /** Put the visual position on the face from `lineX` and `faceT`. */
  private placeOnFace(): void {
    const f = this.wave.face.sample(this.localPitch, this.faceT, this.fs)
    this.localAngle = f.angle
    this.curX = this.lineX + f.fx * this.localH * RAKE
    this.curY = this.wave.troughYAt(this.lineX) - f.fy * this.localH
    // How much of the surface angle the board takes on, signed by whether the
    // surfer is climbing or dropping. Trimming fast down the line flattens it
    // out; carving hard puts the board on the face.
    const carve = clamp(this.vFace / (Math.abs(this.vFace) + this.vx * 0.55 + 60), -1, 1)
    this.curRot = clamp(-f.angle * carve, -1.75, 1.75) + this.cutbackVisual * 0.55
  }

  private get arcLenPx(): number {
    return this.wave.face.arcLength(this.localPitch) * this.localH
  }

  // ------------------------------------------------------------------ update
  update(dt: number, _tick: number): void {
    this.hint?.tick(dt)
    // Never both: the panel carries its own two lines telling you how to leave.
    if (this.finished && this.hint) this.hint.container.visible = false
    const input = this.ctx.input
    this.prevX = this.curX
    this.prevY = this.curY
    this.prevRot = this.curRot

    this.wave.update(dt)
    this.wave.follow(this.state === 'air' ? this.ax : this.lineX)

    if (!this.finished) {
      this.timeLeft = Math.max(0, this.timeLeft - dt)
      if (this.timeLeft <= 0) this.endRun('time')
    }

    switch (this.state) {
      case 'riding': this.updateRiding(dt); break
      case 'air': this.updateAir(dt); break
      case 'down': this.updateDown(dt); break
    }

    this.updateTube(dt)
    this.updateScore(dt)
    this.updateCamera(dt)
    this.recordWake(dt)
    this.emitAmbientFoam()

    this.cutbackVisual = damp(this.cutbackVisual, this.cutbackT > 0 ? 1 : 0, 0.0004, dt)
    this.callTimer = Math.max(0, this.callTimer - dt)
    this.callout.tick(dt)
    this.flash = Math.max(0, this.flash - dt * 2.8)
    this.sky.update(dt)
    this.foam.update(dt)
    this.foamB.update(dt)
    this.spray.update(dt)
    this.mist.update(dt)
    this.nearMist.update(dt)
    this.surfer.update(dt, this.rotVel, this.vx)
    this.updateAudio()

    if (input.justPressed(Action.Back)) this.ctx.goto('menu')
    if (this.finished && input.justPressed(Action.Start)) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.resetRun()
    }
  }

  // -------------------------------------------------------------- riding
  private updateRiding(dt: number): void {
    const input = this.ctx.input
    const rng = this.ctx.rng
    this.refreshLocal()

    const arcLen = this.arcLenPx
    const f = this.wave.face.sample(this.localPitch, this.faceT, this.fs)
    const ang = f.angle

    // Planing lift. A surfer holds a vertical wall because he is going fast
    // across it, not because he is strong: speed is what buys height here, and
    // height is what buys speed back. That loop is the whole event.
    const lift = clamp01(this.vx / 760)
    let accel = -GRAVITY * (1 - 0.74 * lift) * Math.sin(ang)

    const carveIn = input.axisY()
    if (carveIn !== 0) {
      accel -= carveIn * CARVE_THRUST
      this.ctx.perf.markResponse(input.lastRawPressTime)
    }
    if (input.justPressed(Action.A)) {
      // A pump up the face. At the lip, the same press becomes the launch.
      this.vFace += PUMP_KICK
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.noise({ duration: 0.12, cutoff: 2600, toCutoff: 700, gain: 0.07 })
    }

    this.vFace += accel * dt
    this.vFace *= Math.pow(FACE_DRAG, dt)
    this.faceT += (this.vFace * dt) / arcLen

    // --- the lip -----------------------------------------------------------
    if (this.faceT >= 1) {
      const wantsAir = input.buffered(Action.A, 7)
      const threshold = lerp(FREE_LAUNCH_MELLOW, FREE_LAUNCH_HOLLOW, this.localPitch)
      if (this.vFace > 90 && (wantsAir || this.vFace > threshold)) {
        if (wantsAir) input.consumeBuffer(Action.A)
        this.launch(wantsAir)
        return
      }
      this.faceT = 1
      if (this.vFace > 0) this.vFace = 0
    }

    // --- the trough: the bottom turn ---------------------------------------
    if (this.faceT <= 0) {
      this.faceT = 0
      if (this.vFace < -70) {
        // All that downward speed goes into the turn and comes back out as
        // drive down the line. The single most important thing in surfing.
        const drop = -this.vFace
        this.vFace = drop * 0.66 + 90
        this.vx = Math.min(MAX_LINE_SPEED, this.vx + Math.min(320, drop * 0.34))
        this.flash = Math.max(this.flash, 0.18)
        this.burstSpray(12, 0.9)
        this.ctx.audio.noise({ duration: 0.3, cutoff: 1500, toCutoff: 380, gain: 0.14 })
      } else if (this.vFace < 0) {
        this.vFace = 0
      }
    }

    // --- down the line -----------------------------------------------------
    const pocket = this.lineX - this.wave.breakX
    const inFoam = pocket < -26 && this.wave.brokenAt(this.lineX) > 0.28

    // Cutback: turn back toward the pocket. Scrubs speed, scores, and is how
    // you get back under a lip that has run away from you.
    if (input.justPressed(Action.Left) && this.cutbackT <= 0) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.cutbackT = 0.66
      if (this.vx > 400 && this.faceT > 0.28) {
        this.carveCredit += 0.7 + clamp01(this.vx / MAX_LINE_SPEED) * 0.8
        this.call(this.faceT > 0.72 ? 'ROUNDHOUSE' : 'CUTBACK', 0xd7e7f0)
      }
      this.burstSpray(20, 1.35)
      this.ctx.audio.noise({ duration: 0.36, cutoff: 2100, toCutoff: 300, gain: 0.17 })
    }
    if (this.cutbackT > 0) this.cutbackT -= dt

    const trim = lerp(0.6, 1.0, this.faceT)
    const power = lerp(0.72, 1.26, this.localEnergy)
    let target = BASE_LINE_SPEED * trim * power
    if (input.isDown(Action.Right)) {
      target *= 1.17
      this.ctx.perf.markResponse(input.lastRawPressTime)
    }
    if (this.cutbackT > 0) target *= 0.4
    if (inFoam) target *= 0.55
    this.vx = clamp(damp(this.vx, target, 0.14, dt), 0, MAX_LINE_SPEED)

    this.lineX += this.vx * dt
    // A cutback physically carries the surfer back up the line toward the peel.
    if (this.cutbackT > 0) this.lineX -= 210 * dt
    this.facing = 1

    // --- caught inside -----------------------------------------------------
    // Higher on the face buys slack, because the foam is at the bottom of the
    // wave. The brokenAt() test matters as much as the line test: what takes you
    // down is actual whitewater, so a section that has just reformed somewhere
    // up the line can never reach out and wipe you out.
    const catchLine = this.wave.breakX - (80 + 180 * this.faceT)
    if (this.lineX < catchLine && this.wave.brokenAt(this.lineX) > 0.22) {
      this.wipeout('CAUGHT INSIDE')
      return
    }
    if (inFoam && rng.chance(0.55)) this.burstFoamAt(this.curX, this.curY, 3)

    // The surfer has moved down the line; resample before placing him, or he
    // sits on last frame's wave for a frame every time a section changes.
    this.refreshLocal()
    this.placeOnFace()

    // Board spray. Scales with speed and with how hard the rail is loaded.
    //
    // "The board meets the water with zero evidence: no spray fan off the tail,
    // no wake line, no contact shadow on the face." There are now three
    // separate pieces of evidence and this is the loudest: a continuous fan of
    // water thrown off the tail, at a rate the ride can actually sustain
    // rather than one particle every few frames.
    const load = Math.abs(this.vFace) / 700 + (this.cutbackT > 0 ? 1.2 : 0)
    if (this.vx > 260) this.burstSpray(1 + (rng.chance(0.4 + load * 0.4) ? 1 : 0), 0.5 + load * 0.45)
    // The sheet where the rail actually cuts the water: low, fast, backward,
    // and lit from behind, so the board reads as being *in* the water rather
    // than sitting on top of a colour.
    if (this.vx > 200 && rng.chance(0.75)) {
      const vx = -rng.range(180, 520) - this.vx * 0.1
      const vy = -rng.range(20, 150)
      this.spray.emit({
        x: this.curX - 52 + rng.spread(24), y: this.curY + 14 + rng.spread(10),
        vx, vy, rotation: Math.atan2(vy, vx),
        life: rng.range(0.2, 0.5),
        size: rng.range(18, 48), sizeEnd: rng.range(6, 18),
        color: rng.chance(0.45) ? KEY.tint : TRANSMIT_MID,
        alpha: 0.4, gravity: 900, drag: 0.35,
      })
    }
  }

  private launch(boosted: boolean): void {
    const f = this.wave.face.sample(this.localPitch, 1, this.fs)
    this.state = 'air'
    this.ax = this.lineX + f.fx * this.localH * RAKE
    this.ay = this.wave.troughYAt(this.lineX) - this.localH
    // Launch direction: the lip's own tangent, pulled toward vertical.
    //
    // A pitching lip really does throw you down the line as well as up, but
    // taken literally the tangent of a 158-degree overhang fires the surfer
    // almost horizontally — so the hollowest sections, the ones that should
    // launch him hardest, produced the smallest airs. Blending 45% tangent with
    // a fixed vertical component keeps the forward throw and still gets him off
    // the water.
    const tx = -Math.cos(f.angle)
    const ty = -Math.sin(f.angle)
    const bx = tx * 0.45
    const by = ty * 0.45 - 0.62
    const bl = Math.hypot(bx, by) || 1
    const ux = bx / bl
    const uy = by / bl
    const kick = this.vFace * (boosted ? 1.16 : 1)
    this.avx = this.vx * 0.9 + ux * kick
    this.avy = uy * kick
    this.rot = this.curRot
    this.rotVel = 0
    this.spin = 0
    this.grabHeld = 0
    this.launchY = this.ay
    this.airPeakY = this.ay
    // The track stops at the lip. Carrying it through the air would draw a
    // foam ribbon across the sky on landing.
    this.wakeCount = 0
    this.wakeAccum = 0
    this.ctx.audio.noise({ duration: 0.26, cutoff: 3800, toCutoff: 900, gain: 0.15 })
    this.burstSpray(14, 1.1)
    this.mist.burst(5, () => ({
      x: this.ax + this.ctx.rng.spread(60), y: this.ay + this.ctx.rng.spread(30),
      vx: -this.ctx.rng.range(60, 260), vy: -this.ctx.rng.range(20, 120),
      life: this.ctx.rng.range(0.6, 1.3),
      size: this.ctx.rng.range(90, 180), sizeEnd: this.ctx.rng.range(120, 220),
      alpha: 0.24, gravity: 60, drag: 0.5,
    }))
  }

  // ----------------------------------------------------------------- air
  private updateAir(dt: number): void {
    const input = this.ctx.input

    const spinInput = input.axisX()
    if (spinInput !== 0) {
      this.rotVel += spinInput * 13 * dt
      this.ctx.perf.markResponse(input.lastRawPressTime)
    }
    this.rotVel = clamp(this.rotVel * Math.pow(0.55, dt), -11, 11)
    this.rot += this.rotVel * dt
    this.spin += this.rotVel * dt

    if (input.isDown(Action.A)) {
      this.grabHeld += dt
      if (input.justPressed(Action.A)) this.ctx.perf.markResponse(input.lastRawPressTime)
    }

    this.avy += AIR_GRAVITY * dt
    this.ax += this.avx * dt
    this.ay += this.avy * dt
    if (this.ay < this.airPeakY) this.airPeakY = this.ay

    this.curX = this.ax
    this.curY = this.ay
    this.curRot = this.rot

    // Re-entry. Dropping back below the lip line means the face is under the
    // board again; where the crest is lower down the line, you land lower.
    if (this.avy > 0) {
      if (this.ay >= this.wave.crestYAt(this.ax)) { this.land(); return }
    }
    if (this.ay > STILL_Y + 140) this.wipeout('OVER THE FALLS')
  }

  private land(): void {
    this.lineX = this.ax
    this.refreshLocal()
    const speed = Math.hypot(this.avx, this.avy)

    // Judged the way the half pipe judges a re-entry: how far the board is from
    // the line it is actually travelling along when it meets the water.
    const wanted = clamp(Math.atan2(this.avy, this.avx), -1.35, 1.35)
    let diff = ((this.rot - wanted + Math.PI) % (Math.PI * 2)) - Math.PI
    if (diff < -Math.PI) diff += Math.PI * 2
    const off = Math.abs(diff)
    const inFoam = this.wave.brokenAt(this.ax) > 0.35

    if (off > 0.95 || inFoam) { this.wipeout(inFoam ? 'ATE IT' : 'BLEW THE LANDING'); return }

    const clean = off < 0.5
    this.state = 'riding'
    this.faceT = 0.97
    // The landing drives straight back down the face, which is what an off-the-
    // lip looks like and what sets up the next bottom turn.
    this.vFace = -speed * (clean ? 0.6 : 0.34)
    this.vx = clamp(Math.max(this.avx * 0.85, 280) * (clean ? 1 : 0.62), 0, MAX_LINE_SPEED)
    this.facing = 1
    this.scoreAir(clean)
    this.flash = clean ? 0.7 : 0.3
    this.ctx.audio.noise({ duration: 0.28, cutoff: clean ? 2500 : 1100, toCutoff: 260, gain: clean ? 0.2 : 0.14 })
    if (clean) this.ctx.audio.tone({ freq: 430, toFreq: 690, duration: 0.15, type: 'triangle', gain: 0.09 })
    this.burstSpray(clean ? 18 : 9, 1.2)
    this.placeOnFace()
  }

  private scoreAir(clean: boolean): void {
    const height = Math.max(0, this.launchY - this.airPeakY)
    const halfTurns = Math.round(Math.abs(this.spin) / Math.PI)
    const degrees = halfTurns * 180
    const grabbed = this.grabHeld > 0.16

    let name = ''
    if (degrees >= 180) name = String(degrees)
    if (grabbed) name = name ? `${name} GRAB` : 'STALEFISH'
    if (!name && height > 110) name = 'AIR'
    if (!name && height > 40) name = 'FLOATER'

    const credit = (height * 1.0 + degrees * 0.8 + (grabbed ? 90 : 0)) * (clean ? 1 : 0.4)
    this.airCredit += credit
    if (name) this.call(clean ? name : `${name} (SKETCHY)`)
  }

  // ------------------------------------------------------------- wipeout
  /**
   * A fall, and possibly the last one.
   *
   * The `down` guard is what keeps the count honest — there are four call
   * sites (caught inside, over the falls, ate it, blew the landing) and more
   * than one can be true in the same tick, which would otherwise book two
   * falls for one fall and end a run a wipeout early.
   *
   * A wipeout after the run is over still plays out: the wave and the surfer
   * keep running behind the judges' panel, and swallowing the state change
   * would leave `updateAir` re-triggering "OVER THE FALLS" every tick forever.
   * It simply is not counted, so the readout cannot print "4 / 3".
   */
  private wipeout(reason: string): void {
    if (this.state === 'down') return
    this.state = 'down'
    this.downTimer = 1.35
    this.wakeCount = 0
    if (!this.finished) this.wipeouts++
    this.tubeRun = 0
    this.tubed = false
    this.call(reason, mix(Core.paperWhite, 0x7fb4de, 0.55))
    this.flash = 0.5
    this.ctx.audio.noise({ duration: 0.75, cutoff: 1400, toCutoff: 160, gain: 0.26 })
    this.ctx.audio.tone({ freq: 170, toFreq: 60, duration: 0.5, type: 'sawtooth', gain: 0.09 })
    this.burstFoamAt(this.curX, this.curY, 26)
    this.avx = this.vx * 0.3
    this.avy = -180
    this.rotVel = this.ctx.rng.spread(6) + 4
    // Third one and the run is over — through `endRun`, so the judges' panel
    // comes up exactly as it does on the clock. There is one ending.
    if (this.wipeouts >= MAX_FALLS) this.endRun('falls')
  }

  private updateDown(dt: number): void {
    this.avy += AIR_GRAVITY * 0.5 * dt
    this.ax = this.curX + this.avx * dt
    this.ay = Math.min(this.curY + this.avy * dt, this.wave.troughYAt(this.curX) + 30)
    this.rot += this.rotVel * dt
    this.curX = this.ax
    this.curY = this.ay
    this.curRot = this.rot
    if (this.ctx.rng.chance(0.5)) this.burstFoamAt(this.curX, this.curY, 2)

    this.downTimer -= dt
    if (this.downTimer <= 0) {
      // Back up, out on the shoulder, with the next section standing up behind.
      this.state = 'riding'
      this.lineX = this.wave.breakX + 780
      this.vx = BASE_LINE_SPEED * 0.8
      this.faceT = 0.5
      this.vFace = 0
      this.rot = 0
      this.rotVel = 0
      this.spin = 0
      this.cutbackT = 0
      this.wakeCount = 0
      this.wakeAccum = 0
      this.refreshLocal()
      this.placeOnFace()
      this.prevX = this.curX
      this.prevY = this.curY
      this.prevRot = this.curRot
    }
  }

  // ---------------------------------------------------------------- tube
  private updateTube(dt: number): void {
    const pocket = this.lineX - this.wave.breakX
    const wasTubed = this.tubed
    this.tubed = this.state === 'riding'
      && this.localPitch > 0.62
      && this.faceT > 0.45 && this.faceT < 0.98
      && pocket > -70 && pocket < 380

    if (this.tubed) {
      this.tubeTime += dt
      this.tubeRun += dt
      if (!wasTubed) {
        this.call('TUBE!', TRANSMIT_MID)
        this.ctx.audio.tone({ freq: 240, toFreq: 150, duration: 0.5, type: 'sine', gain: 0.1 })
      }
      // Spray blasting past the surfer out of the barrel.
      if (this.ctx.rng.chance(0.7)) this.burstSpray(2, 0.7)
    } else {
      if (wasTubed && this.tubeRun > 0.7) this.call(`OUT CLEAN  ${this.tubeRun.toFixed(1)}s`, TRANSMIT_MID)
      this.tubeRun = 0
    }
    this.tubeAmount = damp(this.tubeAmount, this.tubed ? 1 : 0, 0.0006, dt)
  }

  /**
   * The running score, out of ten, the way the original judges this event.
   * Four components that saturate independently, so a run that is all tube and
   * no carving cannot reach a ten, and a wipeout costs most of a point.
   */
  private updateScore(dt: number): void {
    if (this.state === 'riding' && !this.finished) {
      const pocket = this.lineX - this.wave.breakX
      if (pocket > -60 && pocket < 560 && this.faceT > 0.42) {
        this.flowCredit += dt * (0.6 + this.localPitch)
      }
    }
    this.tubePts = 3.4 * clamp01(this.tubeTime / 9)
    this.airPts = 2.6 * clamp01(this.airCredit / 780)
    this.carvePts = 1.8 * clamp01(this.carveCredit / 7)
    this.flowPts = 2.2 * clamp01(this.flowCredit / 26)
    if (!this.finished) {
      this.score = clamp(
        this.tubePts + this.airPts + this.carvePts + this.flowPts - 0.85 * this.wipeouts,
        0, 10,
      )
    }
  }

  /**
   * The one way a run ends: the clock, or the third fall.
   *
   * `updateScore(0)` first, because the falls path ends the run *inside* the
   * tick that booked the fall, before the score is next recomputed — without
   * it the judges would average a run whose final wipeout had not been paid
   * for. It re-evaluates the existing formula with dt = 0; no term changes.
   */
  private endRun(reason: 'time' | 'falls' = 'time'): void {
    if (this.finished) return
    this.updateScore(0)
    this.endedBy = reason
    this.finished = true
    this.showResults()
    this.ctx.audio.tone({ freq: 520, toFreq: 780, duration: 0.5, type: 'triangle', gain: 0.12 })
    this.ctx.audio.tone({ freq: 780, toFreq: 1040, duration: 0.4, delay: 0.16, type: 'triangle', gain: 0.1 })
  }

  /**
   * Hand the finished score to the judges.
   *
   * Presentation only, and it reads `this.score` rather than being handed a
   * number, so there is exactly one place the judged value can come from.
   * `SCORE_POINTS` is still nothing but the multiplier between that 0..10 and
   * the glyphs a cabinet prints.
   */
  private showResults(): void {
    // `flashQuad` is the one HUD child that sits above the panel, so a run that
    // ends mid-tube would otherwise tint the results screen for half a second.
    this.flash = 0
    this.judges.show(this.score, this.score * SCORE_POINTS)
    this.meters[0].set(this.tubePts / BAR_MAX[0])
    this.meters[1].set(this.airPts / BAR_MAX[1])
    this.meters[2].set(this.carvePts / BAR_MAX[2])
    this.meters[3].set(this.flowPts / BAR_MAX[3])
  }

  /**
   * Framing, not following.
   *
   * The vertical rule got tightened when the stage was canted and pushed in:
   * the camera now takes 70% of the rider's travel up and down the face, so he
   * lives in a 170 px band around the crest line instead of swinging from the
   * lip to the bottom of the frame. That band is where the value break is —
   * a near-black rider crossing the boundary between the lit lip and the mid
   * wall — and a composition only works if the subject stays in it.
   */
  private updateCamera(dt: number): void {
    // The lead term is not a nicety, it is the difference between the rider
    // being where the composition puts him and being a third of a frame to the
    // right of it. `damp` is an exponential follower with a time constant of
    // -1/ln(0.06) = 0.355s, and the rider runs down the line at 680-1180 px/s,
    // so a plain follower sits a permanent 240-420 world px behind him. At the
    // old magnification that was a nudge; at 2.2x it is 530-920 screen px, and
    // it put him off the right of the frame with the wall he is riding toward
    // out of shot. Feeding his speed forward cancels it exactly.
    const speed = this.state === 'air' ? this.avx : this.vx
    this.camX = damp(this.camX, this.curX - CAM_ANCHOR + speed * CAM_LEAD, 0.06, dt)
    this.camY = damp(this.camY, camYFor(this.curY, this.wave.crestYAt(this.curX)), 0.025, dt)
  }

  private updateAudio(): void {
    if (!this.waveBed || !this.tubeBed) return
    // The bed tracks how close the break is: distant hiss out on the shoulder,
    // a full roar in the pocket.
    const pocket = Math.abs(this.lineX - this.wave.breakX)
    const near = 1 - clamp01(pocket / 1300)
    const t = this.tubeAmount
    this.waveBed.setGain(lerp(0.04, 0.16, near) * (1 - t * 0.6))
    this.waveBed.setCutoff(lerp(420, 2100, near) * (1 - t * 0.72) + 160)
    this.tubeBed.setGain(lerp(0.0001, 0.2, t))
    this.tubeBed.setCutoff(lerp(150, 320, t))
  }

  // ------------------------------------------------------------ particles
  //
  // Everything in here obeys two rules that the last review said the old
  // version obeyed neither of.
  //
  // **Direction.** "The white speckle field on the right shoulder is randomly
  // scattered rather than following the lip's direction or the light, which is
  // exactly what unconsidered particle work looks like." So every particle is
  // launched along a vector taken from the wave — the lip's own tangent, the
  // board's heading — and then *rotated onto that vector*, because the texture
  // is a streak with a long axis and a streak pointing the wrong way is worse
  // than a dot. `lipTan` is where the tangent comes from.
  //
  // **Light.** The sun is behind the lip, so water in the air between the
  // camera and the sun is lit from behind and blows out, and water away from
  // it is a grey wisp. `backlit()` is that falloff, and it is applied to both
  // the opacity and the colour of every airborne particle in the scene.

  /**
   * Unit vector along the lip at this world x, pointing down the line.
   *
   * The slope is clamped, and that clamp is the whole fix for foam ending up
   * in the sky. Every emitter here throws water *along* this vector, which is
   * right: broken water runs down the line with the peel. But at the left of
   * the frame the crest climbs out of shot, and over a 120 px baseline that
   * section measures a slope of five or six — so "along the lip" resolved to
   * very nearly straight up, and a puff given 190 px/s along it left the water
   * altogether. A blind review found the result: "a cluster of stray pale
   * bokeh floating in the sky at top-left, well away from any water."
   *
   * Real foam does climb a steep lip, but it climbs the *face*, and the face
   * is not what a two-sample finite difference across a wave peak measures.
   * Capping the rise at 100 px over the baseline holds every emitter to about
   * forty degrees, which is the steepest a peel actually throws.
   */
  private lipTan(wx: number, out: { x: number; y: number }): void {
    const raw = this.crestForEmit(wx + 60) - this.crestForEmit(wx - 60)
    const dy = clamp(raw, -100, 100)
    const len = Math.hypot(120, dy)
    out.x = 120 / len
    out.y = dy / len
  }

  /** How hard the sun behind the wave is lighting airborne water here. */
  private backlit(wx: number): number {
    return clamp01(1 - Math.abs(wx - this.camX - SUN_X) / 820)
  }

  /** Scratch for lip tangents, so emission never allocates. */
  private tan = { x: 1, y: 0 }

  private burstSpray(n: number, power: number): void {
    const rng = this.ctx.rng
    const x = this.curX
    const y = this.curY
    // Off the tail and back down the line, which is where water thrown by a
    // rail actually goes: opposite the direction of travel, fanned by the
    // angle the board is sitting at.
    const base = Math.PI + this.curRot * 0.5
    this.spray.burst(n, () => {
      const a = base + rng.spread(0.62) - 0.5
      const sp = rng.range(220, 720) * power
      const vx = Math.cos(a) * sp + this.vx * 0.16
      const vy = Math.sin(a) * sp - rng.range(60, 260) * power
      const lit = this.backlit(x)
      // Thrown water breaks *up*, it does not swell and dissolve. A particle
      // whose size ramps to 1.5x while its alpha ramps to zero spends the back
      // half of its life as a large faint disc, which is a bokeh dot however
      // hard the silhouette on it is — see `windStreak`. Ending smaller than it
      // started keeps the drop reading as a drop right up to the frame it
      // stops existing on.
      const sz = rng.range(26, 78) * (0.7 + power * 0.4)
      return {
        x: x - 46 + rng.spread(22), y: y + 8 + rng.spread(16),
        vx, vy,
        rotation: Math.atan2(vy, vx),
        life: rng.range(0.32, 0.8),
        size: sz, sizeEnd: sz * rng.range(0.66, 0.94),
        color: mix(Core.sunWhite, this.pal.light, 0.2 + lit * 0.5),
        alpha: 0.4 + lit * 0.42, gravity: 1250, drag: 0.42,
      }
    })
  }

  /**
   * Which foam system a puff comes out of.
   *
   * Deterministic — `ctx.rng` is simulation state — and it is the cheap half of
   * not stamping one silhouette across the whole break.
   */
  private foamSys(): ParticleSystem {
    return this.ctx.rng.chance(0.62) ? this.foam : this.foamB
  }

  private burstFoamAt(x: number, y: number, n: number): void {
    const rng = this.ctx.rng
    this.lipTan(x, this.tan)
    const tx = this.tan.x
    const ty = this.tan.y
    this.foamSys().burst(n, () => {
      // Along the lip, not across it: broken water runs down the line with the
      // peel and lifts off the surface, it does not spray sideways at random.
      const along = rng.range(-90, 210)
      const off = -rng.range(24, 150)
      const sz = rng.range(34, 104)
      return {
        x: x + rng.spread(64), y: y + rng.spread(34),
        vx: tx * along - ty * off, vy: Math.max(ty * along + tx * off, -170),
        life: rng.range(0.5, 1.15),
        // A wide scale spread and a random start angle, because a blob with a
        // silhouette only reads as many blobs if it is never twice the same
        // size at the same angle. The end size is a fraction of the start
        // rather than a second independent draw: growing while fading is what
        // turns a lobed silhouette back into a bokeh disc.
        size: sz, sizeEnd: sz * rng.range(0.6, 0.88),
        rotation: rng.range(0, Math.PI * 2), spin: rng.spread(1.4),
        color: 0xf2fbff, alpha: 0.5 + this.backlit(x) * 0.22, gravity: 460, drag: 0.4,
      }
    })
  }

  /**
   * Whitewater along the peel. The broken part of the wave is a cloud of
   * particles rather than a white polygon — a white polygon is the single
   * fastest way to make water look like paper.
   */
  /**
   * The crest as it will actually be *drawn* at this world x.
   *
   * Particles are emitted against this rather than against `crestYAt`, so the
   * spray out on the far shoulder sits on the wave the renderer draws instead
   * of on the one the physics holds. Deterministic: `camX` is simulation state.
   */
  private crestForEmit(wx: number): number {
    const k = this.perspK(wx - this.camX)
    const surf = crestSurface(wx, this.wave.time)
    if (k <= 0) return this.wave.crestYAt(wx) + surf
    return this.wave.troughYAt(wx) - k * PERSP_LIFT
      - this.wave.heightAt(wx) * lerp(1, PERSP_SHRINK, k) + surf
  }

  private emitAmbientFoam(): void {
    const rng = this.ctx.rng
    const w = this.wave
    // The visible world is a 930px window at this magnification, not 2000.
    const lo = this.camX + 430
    const hi = this.camX + 1470
    for (let i = 0; i < 4; i++) {
      // Near the break, and only there.
      //
      // The camera runs at 700 world px/s and the stage is pushed in 2.2x, so
      // a stationary puff crosses fifteen hundred screen pixels a second: at
      // the old 0.62 of the foam tail and a second of life, whitewater born on
      // the face behind the rider ended its life a full frame-width to the
      // left, over a part of the swell whose crest had since dropped away
      // beneath it. That is the last of the sky bokeh, and it is a lifetime
      // problem rather than a placement one. The peel this framing can
      // actually show is the part next to the break; the rest of the foam tail
      // is off the left edge before it is a pixel.
      const wx = w.breakX - rng.range(0, w.foamLength * 0.30)
      if (wx < lo - 150 || wx > hi) continue
      // Born on the face, not on the crest line.
      //
      // This emitter was the stray bokeh in the sky at top-left, and tinting it
      // magenta for one capture settled where it was coming from: a ribbon of
      // puffs lying just *outside* the drawn lip, all the way up the back of
      // the wave to the top of the frame. Whitewater does not live there. It
      // was being born within 46 px of a crest line that, at the left of the
      // frame, is the silhouette edge itself, and then given lift; anything at
      // all pushed it off the water and into open sky, where a lobed blob
      // fading out at low alpha reads as a bokeh ring.
      //
      // Emitting well down the face puts it back on the water it came off —
      // and the offset has to clear the puff's own radius, not just the crest
      // line. A 128 px blob born 26 px under the crest still hangs half its
      // silhouette over the lip, which is why the first pass at this left a
      // row of pale rings lying along the outside of the edge: their centres
      // were on the water and their bodies were not.
      const sz = rng.range(40, 104)
      const y = this.crestForEmit(wx) + sz * 0.62 + rng.range(12, 116)
      this.lipTan(wx, this.tan)
      const along = rng.range(-30, 150)
      // Lift, capped.
      //
      // At 190 px/s against 210 of gravity a puff climbed the best part of a
      // hundred world pixels, which the 2.2x push-in turns into two hundred on
      // screen — far enough over the lip that, at the left of the frame where
      // the crest runs up out of shot, the whitewater ended up in open sky.
      // A blind review found it there: "a cluster of stray pale bokeh floating
      // in the sky at top-left, well away from any water". It was foam leaving
      // its emitter, and ballooning to 205 px as it faded is what made it read
      // as bokeh rather than as foam in the wrong place.
      // Settling, not lifting.
      //
      // The wave is drawn in stage space and the camera runs down the line, so
      // a puff with a fixed world position slides left across the frame at
      // fifteen hundred pixels a second — and the crest it was born under is
      // two hundred pixels lower by the time it gets to the inside, because
      // that part of the wave has broken. Holding still while the water falls
      // away beneath you is how foam ends up in the sky without ever moving
      // up. So it leaves the peel with a slight *downward* bias and a gravity
      // that can keep up with a collapsing crest.
      const off = rng.range(-14, 74)
      // And a ceiling on the rise itself, independent of the tangent: no puff
      // of whitewater leaves the peel faster than it can be pulled back.
      this.foamSys().emit({
        x: wx, y,
        vx: this.tan.x * along - this.tan.y * off,
        vy: Math.max(this.tan.y * along + this.tan.x * off, -64),
        life: rng.range(0.26, 0.48),
        size: sz, sizeEnd: sz * rng.range(0.62, 0.9),
        rotation: rng.range(0, Math.PI * 2), spin: rng.spread(1.1),
        color: 0xeef8fc,
        alpha: rng.range(0.34, 0.56) + this.backlit(wx) * 0.22,
        gravity: 640, drag: 0.42,
      })
    }

    // Offshore wind tearing spray back off the pitching lip, in three tiers.
    // Every one of them leaves **along the lip tangent** and is rotated onto
    // its own velocity, so the field lies down the line the way the wind and
    // the light both run instead of scattering.

    // MID: off the lip around the pocket. The tier the eye actually reads.
    if (rng.chance(0.75)) {
      const wx = w.breakX + rng.range(40, 900)
      if (wx > lo - 380 && wx < hi && w.pitchAt(wx) > 0.42) {
        this.lipTan(wx, this.tan)
        const sp = rng.range(180, 480)
        const lift = rng.range(40, 210)
        const vx = -this.tan.x * sp + this.tan.y * lift
        const vy = -this.tan.y * sp - this.tan.x * lift
        const lit = this.backlit(wx)
        this.mist.emit({
          x: wx, y: this.crestForEmit(wx) - rng.range(0, 30),
          vx, vy, rotation: Math.atan2(vy, vx),
          life: rng.range(0.7, 1.5),
          size: rng.range(110, 250), sizeEnd: rng.range(150, 300),
          color: mix(this.pal.haze, this.pal.light, 0.3 + lit * 0.6),
          alpha: (0.1 + rng.range(0, 0.12)) * (0.5 + lit * 1.1),
          gravity: 20, drag: 0.55,
        })
      }
    }
    // FAR: out on the shoulder toward the horizon. Short, slow, shallow and
    // barely there — it has a long way of air in front of it.
    if (rng.chance(0.4)) {
      const wx = this.camX + rng.range(1150, 1460)
      if (w.pitchAt(wx) > 0.34) {
        this.lipTan(wx, this.tan)
        const sp = rng.range(50, 150)
        const vx = -this.tan.x * sp
        const vy = -this.tan.y * sp - rng.range(8, 40)
        this.mist.emit({
          x: wx, y: this.crestForEmit(wx) - rng.range(0, 12),
          vx, vy, rotation: Math.atan2(vy, vx),
          life: rng.range(0.9, 1.8),
          size: rng.range(36, 84), sizeEnd: rng.range(50, 110),
          color: mix(this.pal.haze, this.pal.light, 0.5),
          alpha: rng.range(0.05, 0.11),
          gravity: 6, drag: 0.7,
        })
      }
    }
    // NEAR: torn across the lens. Big, fast, steep, and the only tier with
    // real opacity — a foreground plane crossing the camera rather than
    // something happening out on the wave. Screen space, bottom right to top
    // left, so it crosses the diagonal the composition is built on.
    if (rng.chance(0.16)) {
      const vx = -rng.range(620, 1300)
      const vy = -rng.range(120, 400)
      this.nearMist.emit({
        x: rng.range(1700, 2160), y: rng.range(620, 1080),
        vx, vy, rotation: Math.atan2(vy, vx),
        life: rng.range(0.8, 1.7),
        size: rng.range(220, 460), sizeEnd: rng.range(280, 520),
        alpha: rng.range(0.09, 0.19), gravity: 150, drag: 0.5,
      })
    }
  }

  /**
   * Record where the rail has been.
   *
   * Sim state, so it is deterministic and survives a replay. Sampled at 22 Hz
   * rather than every step because a 60 Hz track of a 680 px/s rider is 11 px
   * apart and the ribbon gains nothing from the extra vertices.
   */
  private recordWake(dt: number): void {
    if (this.state !== 'riding') return
    this.wakeAccum += dt
    if (this.wakeAccum < 1 / 22) return
    this.wakeAccum = 0
    const load = clamp01(
      Math.abs(this.vFace) / 620 + (this.cutbackT > 0 ? 0.9 : 0) + this.vx / 2600,
    )
    if (this.wakeCount >= WAKE_LEN) {
      this.wakeX.copyWithin(0, 1)
      this.wakeY.copyWithin(0, 1)
      this.wakeLoad.copyWithin(0, 1)
      this.wakeCount = WAKE_LEN - 1
    }
    this.wakeX[this.wakeCount] = this.curX
    this.wakeY[this.wakeCount] = this.curY
    this.wakeLoad[this.wakeCount] = load
    this.wakeCount++
  }

  private call(text: string, tone: Hex = Core.paperWhite): void {
    this.callText = text
    this.callTimer = 1.6
    this.callout.show(text, tone)
  }

  // ------------------------------------------------------------------ render
  render(alpha: number): void {
    const x = lerp(this.prevX, this.curX, alpha)
    const y = lerp(this.prevY, this.curY, alpha)
    const rot = lerpAngle(this.prevRot, this.curRot, alpha)
    const camX = this.camX
    const camY = this.camY

    this.riderSx = x - camX
    this.sampleColumns(camX)
    this.sampleLip()
    this.drawWave()
    this.drawDeepLight(camX, camY)
    this.drawChop(camX)
    this.drawCaustics(camX)
    this.drawTransmission()
    this.placeLipGlow(camY)
    this.placePocketGlow(y)
    this.drawFoamLine()
    this.drawWake()

    this.waveLayer.y = -camY
    this.worldLayer.position.set(-camX, -camY)
    this.overLayer.y = -camY
    this.parallax.scrollTo(camX, camY * 0.35)
    this.foreParallax.scrollTo(camX, camY)
    this.drawBirds(camX, camY)

    this.surfer.container.position.set(x, y)
    this.surfer.container.rotation = rot
    this.poseSurfer()
    this.placeShadows(x, y, rot)

    this.drawCurl()
    // `overLayer` is already offset by -camY, so the surfer's position inside it
    // is (world x - camX, world y). Subtracting camY here too would apply it
    // twice and the barrel would drift off the surfer the moment he got air.
    this.drawTube(x - camX, y)
    this.placeCallout(x, y)
    this.renderHud()
  }

  /**
   * How far into the run-away the far end of the wave is at this screen x.
   *
   * Zero everywhere the rider can reach, so nothing under him is ever being
   * warped; it climbs only out past `PERSP_START`, which is where the wave
   * stops being a place you can ride and starts being distance.
   */
  private perspK(sx: number): number {
    return smoothstep(PERSP_START, PERSP_END, sx)
  }

  /** Sample the swell across the frame. One pass, reused by every wave pass. */
  private sampleColumns(camX: number): void {
    const w = this.wave
    for (let i = 0; i < COLS; i++) {
      const sx = -COL_STEP + i * COL_STEP
      const wx = camX + sx
      this.colX[i] = sx
      const k = this.perspK(sx)
      // The trough climbs toward the horizon and the face shortens with it, so
      // the crest holds its line while the foot of the wave rises to meet it.
      // Crest and trough converge; two of the frame's parallel bands become one
      // wedge pointing down the line.
      const trough = w.troughYAt(wx) - k * PERSP_LIFT
      const h = w.heightAt(wx) * lerp(1, PERSP_SHRINK, k)
      this.colWx[i] = wx
      this.colTrough[i] = trough
      this.colH[i] = h
      // The drawn crest is the physical crest plus surface. Everything hung off
      // it — bands, foam, curl, transmission — is therefore a curve.
      this.colCrest[i] = trough - h + crestSurface(wx, w.time)
      this.colPitch[i] = w.pitchAt(wx)
      this.colBroken[i] = w.brokenAt(wx)
    }
  }

  /**
   * The wave body, as the lit ramp in `FACE_KEYS` resolved into fills.
   *
   * This is the one place in the event that rebuilds geometry per frame, and it
   * has to: the wave *is* the level, and a level that cannot change shape cannot
   * break and reform. Cost is kept in hand by spending resolution where the
   * light is doing something — every column across the thin terminator bands,
   * every second column across the three wide plateaus, where the curve is
   * smooth and a boundary cannot be seen anyway.
   */
  private drawWave(): void {
    const g = this.waveGfx
    const last = COLS - 1
    g.clear()
    for (let b = 0; b < BANDS.length; b++) {
      const top = BANDS[b].at
      const bot = BANDS[b].to
      // Resolution is spent where the light is doing something. Full column
      // resolution through the transmission and the first terminator, where the
      // eye is and a boundary would be visible; half across the wall; a third
      // down in the core shadow, where the curve is smooth, the values are
      // close together and nothing can be seen anyway.
      const step = bot - top < 0.032 ? 1 : top > 0.62 ? 3 : 2
      for (let i = 0; ; i += step) {
        const j = i > last ? last : i
        const y = this.colCrest[j] + this.colH[j] * top
        if (i === 0) g.moveTo(this.colX[j], y)
        else g.lineTo(this.colX[j], y)
        if (j === last) break
      }
      for (let i = last; ; i -= step) {
        const j = i < 0 ? 0 : i
        g.lineTo(this.colX[j], this.colCrest[j] + this.colH[j] * bot)
        if (j === 0) break
      }
      g.closePath().fill(BANDS[b].c)
    }
    // Everything in front of the wave: the deepest chroma in the scene, and
    // now also its lowest value, which is what anchors the dark mass.
    // Closed against the *drawn* foot of the face rather than against the
    // physical trough: the crest carries surface now and the two would
    // otherwise disagree by a dozen pixels and leave a seam along the bottom.
    g.moveTo(this.colX[0], this.colCrest[0] + this.colH[0])
    for (let i = 1; i < COLS; i++) g.lineTo(this.colX[i], this.colCrest[i] + this.colH[i])
    g.lineTo(this.colX[last], 1200).lineTo(this.colX[0], 1200).closePath().fill(DEEP)
  }

  /**
   * How much light gets through the lip at this column.
   *
   * Thin water transmits; thick water does not. Pitch is the proxy for
   * thickness — a section throwing a barrel has a sheet at the lip you can read
   * a headline through — and broken water transmits nothing at all because it
   * is air. The last term is the depth attenuation down the line.
   */
  private transmit(i: number): number {
    const depth = i / (COLS - 1)
    return (0.40 + 0.66 * this.colPitch[i])
      * (1 - this.colBroken[i] * 0.92)
      * lerp(1, TRANS_FAR, depth)
  }

  /**
   * The headline: light coming *through* the wave.
   *
   * The sun is directly behind the face, so the water under the lip is a lit
   * sheet — blown warm at the top, luminous jade below it, falling back into
   * the face's own teal as it thickens. Added rather than painted, so it reads
   * as light in the water instead of paint on it.
   *
   * Two changes from the version a review took apart. Every ribbon keeps a
   * floor under its thickness (`TRANS_FLOOR`), because a ribbon that pinches to
   * zero where the water is broken terminates in a razor-pointed wedge — the
   * "small white chevrons" on the left of the last capture. And every edge
   * carries a ripple at its own frequency, so no two boundaries in the glow are
   * parallel and none of them is straight.
   */
  private drawTransmission(): void {
    const g = this.transGfx
    const last = COLS - 1
    const time = this.wave.time
    g.clear()
    // The lower edge of every ribbon is the upper edge plus a strictly POSITIVE
    // wobble, never its own independent ripple. Two independent ripples on a
    // ribbon three pixels thick cross each other, and a polygon whose edges
    // cross fills as a bowtie — a razor-pointed wedge sitting on the face,
    // which is what a reviewer read as "small white chevrons" last time.
    for (let r = 0; r < TRANS_RIBBONS.length; r++) {
      const rb = TRANS_RIBBONS[r]
      const ph = r * 1.7
      for (let i = 0; i <= last; i++) {
        const t = TRANS_FLOOR + (1 - TRANS_FLOOR) * this.transmit(i)
        const rip = Math.sin(this.colWx[i] * 0.0163 + time * 1.4 + ph) * 3.4
        const y = this.colCrest[i] + this.colH[i] * rb.from * t + rip
        if (i === 0) g.moveTo(this.colX[i], y)
        else g.lineTo(this.colX[i], y)
      }
      for (let i = last; i >= 0; i--) {
        const t = TRANS_FLOOR + (1 - TRANS_FLOOR) * this.transmit(i)
        const rip = Math.sin(this.colWx[i] * 0.0163 + time * 1.4 + ph) * 3.4
        const swell = 3.2 + Math.sin(this.colWx[i] * 0.0119 - time * 1.1 + ph * 1.9) * 2.1
          + Math.sin(this.colWx[i] * 0.0271 + time * 1.7) * 1.0
        g.lineTo(
          this.colX[i],
          this.colCrest[i] + this.colH[i] * rb.to * t + rip + swell,
        )
      }
      g.closePath().fill({ color: rb.c, alpha: rb.a })
    }
    // One more pass on the near break only, tapering across part of the frame.
    // Closing the polygon on itself is what makes the extra opacity near the
    // camera arrive without a seam.
    const span = Math.max(2, Math.round(last * TRANS_NEAR_SPAN))
    for (let i = 0; i <= span; i++) {
      const t = this.transmit(i) * (1 - i / span)
      const rip = Math.sin(this.colWx[i] * 0.0208 + time * 1.9) * 2.6
      const y = this.colCrest[i] + this.colH[i] * 0.012 * t + rip
      if (i === 0) g.moveTo(this.colX[i], y)
      else g.lineTo(this.colX[i], y)
    }
    for (let i = span; i >= 0; i--) {
      const t = this.transmit(i) * (1 - i / span)
      const rip = Math.sin(this.colWx[i] * 0.0208 + time * 1.9) * 2.6
      const swell = 2.6 + Math.sin(this.colWx[i] * 0.0151 - time * 1.3) * 1.9
      g.lineTo(
        this.colX[i],
        this.colCrest[i] + this.colH[i] * 0.105 * t + rip + swell,
      )
    }
    g.closePath().fill({ color: TRANSMIT_MID, alpha: 0.26 })
  }

  /**
   * Caustic bands and sun shafts read through the water below the terminator.
   *
   * This is the fill for what the review called the dead zone. Both families
   * resolve their y against the column sample already taken this frame, so the
   * whole pass is sprite transforms and costs nothing.
   */
  private drawDeepLight(camX: number, camY: number): void {
    const t = this.wave.time
    for (let i = 0; i < DEEP_CAUSTICS; i++) {
      const s = this.deepCaustics[i]
      const d = this.deepCausticSeed[i * 3 + 1]
      const ph = this.deepCausticSeed[i * 3 + 2]
      let sx = (this.deepCausticSeed[i * 3] - camX * 0.72 + t * 38) % 2400
      if (sx < 0) sx += 2400
      sx -= 240
      const crest = this.colAt(sx, this.colCrest)
      const h = this.colAt(sx, this.colH)
      // From the terminator down through the core shadow and on past the
      // trough. This span is exactly the mass the review called dead.
      const f = 0.44 + d * 0.62
      const below = Math.max(0, f - 1) * 240
      s.position.set(sx, crest + h * Math.min(f, 1) + below + Math.sin(t * 0.9 + ph) * 7)
      // The scale ramp: a band at the foot of the face is a fifth the width of
      // one crossing the near water, and five times thinner.
      s.width = 110 + d * 560
      s.height = 3 + d * 16
      s.rotation = Math.sin(t * 0.5 + ph) * 0.05
      s.alpha = (0.09 + 0.22 * d) * (0.48 + 0.52 * Math.sin(t * 1.4 + ph))
    }

    for (let i = 0; i < DEEP_SHAFTS; i++) {
      const s = this.deepShafts[i]
      // Unequal gaps. `520 + i * 230` is a picket fence of light, and a picket
      // fence is what an even step always turns into.
      const sx = 470 + i * 214 + this.shaftOffset[i] + Math.sin(t * 0.31 + i * 1.7) * 30
      const crest = this.colAt(sx, this.colCrest)
      const h = this.colAt(sx, this.colH)
      const broken = this.colAt(sx, this.colBroken)
      const y = crest + h * 0.42
      s.position.set(sx, y)
      s.width = 30 + this.shaftWidth[i]
      s.height = h * 0.85 + 230
      // Aimed away from the sun, in screen space, because a shaft that falls
      // vertically is a light with no position in the world.
      s.rotation = Math.atan2(y - camY - SUN_Y, sx - SUN_X) - Math.PI / 2
      s.alpha = (0.09 + (i % 2) * 0.05) * (1 - broken * 0.8)
    }
  }

  /**
   * Wind chop lying on the face.
   *
   * This is texture inside the biggest mass in the frame, and it exists because
   * of a measurement rather than a taste: a wall of water 700 screen pixels
   * tall with nothing in it but band boundaries is counted as dead frame no
   * matter how carefully it is graded, and dead frame is what the last review
   * spent its first paragraph on.
   *
   * Two families. Most of them lie **along the line**, parallel to the crest,
   * because that is the direction the swell and the offshore wind both run and
   * it reinforces the one diagonal the whole composition is built on. A third
   * of them run **down the face**, which is the drainage off the back of the
   * previous wave and stops the first family reading as contour lines. Colour
   * is sampled off the face's own ramp a little above and a little below where
   * the stroke sits, so every one of them is the water's own value, moved.
   */
  private drawChop(camX: number): void {
    const g = this.chopGfx
    g.clear()
    const t = this.wave.time
    for (let i = 0; i < CHOP; i++) {
      let sx = (this.chopSeed[i * 4] - camX * 0.99 + t * 26) % 2400
      if (sx < 0) sx += 2400
      sx -= 560
      const fy = this.chopSeed[i * 4 + 1]
      const sc = this.chopSeed[i * 4 + 2]
      const down = this.chopSeed[i * 4 + 3] === 0
      const crest = this.colAt(sx, this.colCrest)
      const h = this.colAt(sx, this.colH)
      const broken = this.colAt(sx, this.colBroken)
      if (broken > 0.7) continue
      const y = crest + h * fy + Math.sin(t * 0.7 + i * 1.3) * 4
      // Lighter above the stroke, darker below: a ripple has a lit face and a
      // shaded one, and one line of a single colour is a scratch, not water.
      const lit = gradientAt(FACE_KEYS, clamp01(fy - 0.17))
      const dark = gradientAt(FACE_KEYS, clamp01(fy + 0.13))
      // Weighted DOWN the face rather than up it. The top of the face is now
      // the light mass and the thing the rider is read against, so laying the
      // heaviest grain across it would spend the one clean value break in the
      // frame on texture.
      const fade = (1 - broken) * (0.34 + 0.66 * smoothstep(0.10, 0.52, fy))
      if (down) {
        const len = (34 + sc * 74)
        const lean = 0.34 + sc * 0.4
        g.moveTo(sx, y)
          .lineTo(sx + len * lean, y + len)
          .stroke({ color: dark, width: 2 + sc * 3, alpha: 0.3 * fade, cap: 'round' })
      } else {
        // The stroke tracks the crest, so it lies on the wave rather than on
        // the screen: a horizontal tick on a canted stage is a mistake you can
        // see from across the room.
        const len = 90 + sc * 240
        // Tracks the crest, plus its own small tilt: chop all running at one
        // angle is a hatch, and a hatch is not water.
        const y2 = y + (this.colAt(sx + len, this.colCrest) - crest) + (sc - 1) * len * 0.05
        g.moveTo(sx, y).lineTo(sx + len, y2)
          .stroke({ color: dark, width: 2.4 + sc * 4.2, alpha: 0.34 * fade, cap: 'round' })
        g.moveTo(sx + len * 0.12, y - 3.5 - sc * 3).lineTo(sx + len * 0.94, y2 - 3.5 - sc * 3)
          .stroke({ color: lit, width: 1.6 + sc * 2.4, alpha: 0.3 * fade, cap: 'round' })
      }
    }
  }

  /**
   * The board's displacement wake and the foam trail off the last turn.
   *
   * The track is recorded in `update` so it is deterministic; this only turns
   * it into a tapering ribbon with a dark groove under it. A wake drawn as
   * white alone is a scribble — the water the rail has pushed down is what
   * makes it read as displacement.
   */
  private drawWake(): void {
    const g = this.wakeGfx
    g.clear()
    const n = this.wakeCount
    if (n < 5) return
    const hw = (i: number): number => (2.4 + 20 * (i / (n - 1))) * (0.45 + this.wakeLoad[i])
    const foam = mix(0xe8f7fb, TRANSMIT_MID, 0.22)
    const groove = sea(grade(FACE_CORE, { valScale: 0.66, satScale: 1.08 }))
    // Five chunks rather than one fill, because a single polygon cannot fade
    // along its own length; and the groove under it is cut the same way, so the
    // dark side thins with the foam instead of running at one weight the whole
    // way back to where the turn started.
    const chunks = 5
    for (let c = 0; c < chunks; c++) {
      const i0 = Math.floor((c * (n - 1)) / chunks)
      const i1 = Math.floor(((c + 1) * (n - 1)) / chunks)
      if (i1 - i0 < 1) continue
      const age = c / (chunks - 1)
      for (let i = i0; i <= i1; i++) {
        const y = this.wakeY[i] + 11 - hw(i)
        if (i === i0) g.moveTo(this.wakeX[i], y)
        else g.lineTo(this.wakeX[i], y)
      }
      for (let i = i1; i >= i0; i--) g.lineTo(this.wakeX[i], this.wakeY[i] + 11 + hw(i))
      g.closePath().fill({ color: foam, alpha: lerp(0.05, 0.4, age) })

      g.moveTo(this.wakeX[i0], this.wakeY[i0] + 15 + hw(i0))
      for (let i = i0 + 1; i <= i1; i++) g.lineTo(this.wakeX[i], this.wakeY[i] + 15 + hw(i))
      g.stroke({
        color: groove,
        width: lerp(2.4, 10, age),
        alpha: lerp(0.12, 0.5, age),
        cap: 'round', join: 'round',
      })
    }

    // The fan off the tail, drawn rather than thrown.
    //
    // The particle fan says there is water in the air; this says where it left
    // the board, which is the half the review was actually missing — "the board
    // meets the water with zero evidence". Seven tapered blades off the tail,
    // each one shorter and fainter than the last, opening against the
    // direction of travel and bending up out of the face.
    if (this.state !== 'riding' || this.vx < 240) return
    const tailX = this.wakeX[n - 1]
    const tailY = this.wakeY[n - 1]
    const power = clamp01((this.vx - 240) / 700) * (0.5 + this.wakeLoad[n - 1] * 0.9)
    const spread = 0.5 + this.wakeLoad[n - 1] * 0.5
    for (let b = 0; b < 7; b++) {
      const u = b / 6
      const a = Math.PI + this.curRot * 0.5 - spread * 0.5 + spread * u - 0.34
      const len = (96 + 150 * power) * (0.55 + 0.75 * Math.sin(Math.PI * (0.25 + u * 0.7)))
      const ex = tailX + Math.cos(a) * len
      const ey = tailY + Math.sin(a) * len - len * 0.34
      g.moveTo(tailX - 14, tailY + 12)
        .quadraticCurveTo((tailX + ex) * 0.5 - 10, (tailY + ey) * 0.5 + 8, ex, ey)
        .stroke({
          color: mix(Core.sunWhite, this.pal.light, 0.25 + u * 0.4),
          width: (6.4 - u * 4) * (0.5 + power),
          alpha: (0.3 - u * 0.18) * (0.35 + power * 0.9),
          cap: 'round',
        })
    }
  }

  /**
   * Occlusion under the board, and the shadow it throws down the face.
   *
   * Two things, because they do two jobs: the pool says the board is touching
   * the water, and the long smear away from the sun says there is a light.
   */
  private placeShadows(x: number, y: number, rot: number): void {
    if (this.state === 'down') {
      this.contact.hide()
      this.castShadow.visible = false
      return
    }
    const airborne = this.state === 'air'
    // The drawn crest, not the physical one, or the board's shadow floats a
    // dozen pixels off the water it is supposed to be lying on.
    const crest = this.wave.crestYAt(x) + crestSurface(x, this.wave.time)
    const gap = airborne ? Math.max(0, crest - y) : 0
    const surfaceY = airborne ? crest : y
    // The sun is to the right, so everything falls to the left. Both of these
    // are scaled to the rider at the new magnification: a 150px smudge under a
    // 360px rider is the sort of thing that reads as floating.
    this.contact.place(x - 16 - gap * 0.16, surfaceY + 17, gap, rot)
    this.castShadow.visible = true
    this.castShadow.position.set(x - 62 - gap * 0.24, surfaceY + 36)
    this.castShadow.rotation = rot + 0.2
    this.castShadow.width = 330
    this.castShadow.height = 70
    this.castShadow.alpha = 0.4 * KEY.strength * (1 - clamp01(gap / 460))
  }

  /** Linear read into this frame's column sample, by screen x. */
  private colAt(sx: number, arr: Float32Array): number {
    const f = clamp((sx + COL_STEP) / COL_STEP, 0, COLS - 1.001)
    const i = f | 0
    return lerp(arr[i], arr[i + 1], f - i)
  }

  /**
   * Foam along the crest, thickening hard where the wave has gone over.
   *
   * Everything here is depth-aware now. The old version drew one 4px white
   * stroke at one opacity from the near break to the distant horizon, which the
   * review named as the loudest vector-app default in the frame. The ribbon
   * thins continuously with distance, and the highlight on top of it is cut
   * into segments that take their weight from `depthOutline()` — so it thins,
   * fades, and past the far band stops being drawn at all.
   */
  private drawFoamLine(): void {
    const g = this.foamGfx
    const last = COLS - 1
    g.clear()
    // Under-layer: churned water behind the break, as two shallow tiers rather
    // than one deep slab. At the old framing the slab was 210px tall; the
    // push-in would have made it 460 screen pixels of flat pale fill, which is
    // the fastest way there is to make water read as paper. The whitewater's
    // volume comes from the particle cloud over it instead.
    const time = this.wave.time
    for (let tier = 0; tier < 2; tier++) {
      const depth = tier === 0 ? 0.14 : 0.26
      const ph = tier * 2.4
      g.moveTo(this.colX[0], this.colCrest[0] - 4)
      for (let i = 1; i < COLS; i++) g.lineTo(this.colX[i], this.colCrest[i] - 4)
      // The lower edge is a run of unequal lobes, not a scaled copy of the
      // crest. Whitewater has a silhouette — it is a pile of broken water with
      // fingers running out of it — and two curves at the same frequency are a
      // ribbon however far apart they sit.
      for (let i = last; i >= 0; i--) {
        const wx = this.colWx[i]
        const lobe = 1
          + 0.46 * Math.sin(wx * 0.0173 - time * 2.1 + ph)
          + 0.26 * Math.sin(wx * 0.0397 + time * 3.0 + ph * 1.7)
          + 0.14 * Math.sin(wx * 0.0861 - time * 4.2)
        g.lineTo(
          this.colX[i],
          this.colCrest[i] + this.colBroken[i] * this.colH[i] * depth * lobe,
        )
      }
      g.closePath().fill({
        color: mix(0xdff1f5, tier === 0 ? FACE_UPPER : FACE_MID, 0.5 + tier * 0.2),
        alpha: tier === 0 ? 0.44 : 0.3,
      })
    }

    // The crest ribbon: thin on an open wall, thicker where it is pitching, and
    // tapering the whole way down the line toward the horizon.
    g.moveTo(this.colX[0], this.colCrest[0] - 2)
    for (let i = 1; i < COLS; i++) g.lineTo(this.colX[i], this.colCrest[i] - 2)
    for (let i = last; i >= 0; i--) {
      const taper = lerp(1.2, 0.34, i / last)
      const lobe = 1 + 0.42 * Math.sin(this.colWx[i] * 0.0241 - time * 2.6)
        + 0.2 * Math.sin(this.colWx[i] * 0.0533 + time * 3.4)
      const t = (2 + this.colPitch[i] * 10 + this.colBroken[i] * 30) * taper * lobe
      g.lineTo(this.colX[i], this.colCrest[i] + t)
    }
    g.closePath().fill({ color: mix(0xdff1f5, FACE_LIP, 0.4), alpha: 0.74 })

    // The highlight on the lip, in seven pieces of falling weight. The far two
    // are not drawn: at that distance a line has no weight left.
    //
    // It used to run at one bright weight the whole way across, and the neutral
    // review said the eye landed on it before anything else in the frame —
    // ahead of the player. So it is held down to about half, mixed off pure
    // white into the water's own hue, and then given back, hard, over a few
    // hundred pixels either side of the rider. A line is allowed to be the
    // loudest thing in the frame as long as it is loudest where he is: that is
    // line converging on the subject rather than competing with him.
    const segs = 7
    for (let seg = 0; seg < segs; seg++) {
      const d = (seg + 0.5) / segs
      const o = depthOutline(d)
      if (o.alpha <= 0) continue
      const i0 = Math.floor((seg * last) / segs)
      const i1 = Math.min(last, Math.ceil(((seg + 1) * last) / segs))
      const mid = (this.colX[i0] + this.colX[i1]) * 0.5
      const near = (mid - this.riderSx) / 250
      const focus = 1 + 1.15 * Math.exp(-near * near)
      g.moveTo(this.colX[i0], this.colCrest[i0] - 1)
      for (let i = i0 + 1; i <= i1; i++) g.lineTo(this.colX[i], this.colCrest[i] - 1)
      g.stroke({
        color: mix(TRANSMIT_MID, FACE_UPPER, 0.4),
        width: o.width * (0.7 + focus * 0.3),
        alpha: clamp01(o.alpha * 0.26 * focus),
        cap: 'round',
      })
    }
  }

  /**
   * The hot spot on the crest directly in front of the sun.
   *
   * Without it the transmission is an even ribbon down the whole lip, which is
   * paint. With it there is one place the light is actually coming from and the
   * glow falls off either side of it.
   */
  private placeLipGlow(camY: number): void {
    const sx = SUN_X
    const crest = this.colAt(sx, this.colCrest)
    const pitch = this.colAt(sx, this.colPitch)
    const broken = this.colAt(sx, this.colBroken)
    this.lipGlow.position.set(sx - 40, crest + 6)
    this.lipGlow.width = 880
    this.lipGlow.height = 250
    this.lipGlow.alpha = (0.11 + 0.20 * pitch) * (1 - broken * 0.9)
      * clamp01(1 - Math.abs(crest - camY - SUN_Y) / 900)
  }

  /**
   * The pocket, lit from behind, sitting directly on the rider.
   *
   * The neutral review's focal order was: white lip stroke, sun glow, HUD
   * number, player — fourth, in his own event. Two of those were fixed by
   * turning things down; this is the one that turns something up. It is a soft
   * lift in the water immediately behind and above the board, so the darkest
   * shape in the frame is read against the brightest water on the face, which
   * puts the strongest value break where the player is rather than wherever the
   * swell happened to leave one.
   *
   * It fades out inside the barrel, where the tube's own light takes over.
   */
  private placePocketGlow(screenY: number): void {
    const sx = this.riderSx
    const pitch = this.colAt(sx, this.colPitch)
    const broken = this.colAt(sx, this.colBroken)
    const g = this.pocketGlow
    // Sized to the rider, not to the old framing: he is 360px tall now and a
    // lift that does not reach past his shoulders puts the value break
    // somewhere other than on him.
    // Smaller and weaker than it was, because it no longer has to manufacture
    // the value break on its own. The face above the rider is the light mass
    // now; this only has to put the *brightest* part of it where he is. At the
    // old size and strength on the new ramp it blew a 1000px hole of white
    // behind him, which is the airbrush smear a review already named once.
    g.position.set(sx + 34, screenY - 110)
    g.width = 720
    g.height = 470
    g.alpha = this.state === 'down'
      ? 0.04
      : (0.13 + 0.15 * pitch) * (1 - broken * 0.5) * (1 - this.tubeAmount * 0.7)
  }

  /**
   * The rolled lip, resolved into geometry once per frame.
   *
   * The thing this replaces was a sheared band: one offset applied to the crest
   * polyline and filled flat, which is a translucent sheet with a ruler for a
   * top edge. A lip is not a sheet. It is a rope of water the thickness of a
   * car, thrown forward off the crest, with its own lit top, its own shaded
   * underside and a sheet falling off the front of it.
   *
   * So it gets four edges instead of one, each carrying its own ripple at its
   * own frequency and phase. Two edges at the same phase are parallel, and two
   * parallel edges are a sheet again however wiggly they both are.
   */
  private sampleLip(): void {
    const t = this.wave.time
    for (let i = 0; i < COLS; i++) {
      const wx = this.colWx[i]
      const p = this.colPitch[i]
      const h = this.colH[i]
      const crest = this.colCrest[i]
      // Broken water has already thrown, so there is almost no rope left to
      // draw — but never *none*: a rope of zero thickness is a polygon whose
      // two edges land on each other, and a polygon whose edges cross is the
      // razor-pointed wedge artefact this whole pass exists to get rid of.
      const solid = 0.26 + 0.74 * (1 - this.colBroken[i])

      // The three wobbles are strictly POSITIVE offsets rather than signed
      // ripples, which is what makes the ordering A < B < C < D impossible to
      // break at any pitch, any wave height and any amount of foam. Each is a
      // different pair of frequencies on a different phase, so no two edges of
      // the rope run parallel and not one of them is a straight line.
      const w1 = 3.4 + Math.sin(wx * 0.01410 + t * 1.30) * 2.2
        + Math.sin(wx * 0.03310 - t * 2.05) * 1.1
      const w2 = 5.6 + Math.sin(wx * 0.01170 - t * 1.05 + 2.1) * 3.6
        + Math.sin(wx * 0.02640 + t * 1.83) * 1.9
      const w3 = 8.0 + Math.sin(wx * 0.00920 + t * 0.82 + 4.3) * 5.0
        + Math.sin(wx * 0.02130 - t * 1.51) * 2.8

      const thick = h * (0.018 + 0.052 * p) * solid
      const reach = h * (0.030 + 0.300 * p) * solid
      const drop = h * (0.010 + 0.205 * p) * solid
      this.lipAy[i] = crest - thick * (0.55 + 0.34 * p) - w1
      this.lipBx[i] = this.colX[i] + reach
      this.lipBy[i] = crest + drop + w2 * 0.5
      this.lipCx[i] = this.colX[i] + reach * 0.74
      this.lipCy[i] = this.lipBy[i] + thick * (1.5 + 1.1 * p) + w2 * 0.4
      this.lipDy[i] = this.lipCy[i] + h * (0.030 + 0.26 * p) + w3
      this.lipFall[i] = h * smoothstep(0.40, 0.96, p) * (0.14 + 0.30 * p) * solid
    }
  }

  /**
   * The lip, drawn as a solid with a lit top, a shaded underside and a curtain
   * falling off it.
   *
   * Four fills and one segmented rim, in the order light actually arrives:
   * the sun is *behind* this rope of water, so the top of the roll is the
   * brightest surface in the frame, the front of it is a step down, and the
   * underside — the only part of the wave the sun cannot reach through — is the
   * dark that makes the whole thing read as hollow rather than as a blue slope.
   */
  private drawCurl(): void {
    const g = this.curlGfx
    const last = COLS - 1
    g.clear()

    // Light comes through the rope from behind, so its top edge is the
    // brightest water on screen and its underside is the darkest.
    // Four values across it, and the gaps between them are the point: a
    // lip lit from one side and filled with one colour is the flat translucent
    // sheet this replaces. Luminance runs 0.91 / 0.75 / 0.39 / 0.24.
    const crown = mix(TRANSMIT_EDGE, TRANSMIT_MID, 0.42)
    const front = mix(TRANSMIT_MID, FACE_MID, 0.5)
    const under = sea(grade(FACE_MID, { valScale: 0.60, satScale: 1.06 }))
    const throat = sea(grade(FACE_CORE, { valScale: 0.95, satScale: 1.04 }))

    // 1. The crown of the roll: back edge (above the crest) to the middle of
    //    the rope. This is the only place in the frame allowed to be brighter
    //    than the lit face beneath it.
    for (let i = 0; i <= last; i++) {
      if (i === 0) g.moveTo(this.colX[i], this.lipAy[i])
      else g.lineTo(this.colX[i], this.lipAy[i])
    }
    for (let i = last; i >= 0; i--) {
      g.lineTo(
        (this.colX[i] + this.lipBx[i]) * 0.5,
        (this.lipAy[i] + this.lipBy[i]) * 0.5,
      )
    }
    g.closePath().fill({ color: crown, alpha: 0.95 })

    // 2. The front of the rope, turning away from the light.
    for (let i = 0; i <= last; i++) {
      const x = (this.colX[i] + this.lipBx[i]) * 0.5
      const y = (this.lipAy[i] + this.lipBy[i]) * 0.5
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
    for (let i = last; i >= 0; i--) g.lineTo(this.lipBx[i], this.lipBy[i])
    g.closePath().fill({ color: front, alpha: 0.95 })

    // 3. The underside. Nothing gets through here, so it is the value break
    //    that turns a slope into an overhang.
    for (let i = 0; i <= last; i++) {
      if (i === 0) g.moveTo(this.lipBx[i], this.lipBy[i])
      else g.lineTo(this.lipBx[i], this.lipBy[i])
    }
    for (let i = last; i >= 0; i--) g.lineTo(this.lipCx[i], this.lipCy[i])
    g.closePath().fill({ color: under, alpha: 0.9 })

    // 4. The shadow the rope throws down the face under it, fading out where
    //    the sheet re-enters the water.
    for (let i = 0; i <= last; i++) {
      if (i === 0) g.moveTo(this.lipCx[i], this.lipCy[i])
      else g.lineTo(this.lipCx[i], this.lipCy[i])
    }
    for (let i = last; i >= 0; i--) g.lineTo(this.colX[i], this.lipDy[i])
    g.closePath().fill({ color: throat, alpha: 0.42 })

    // 5. The curtain: the sheet of water already falling off the tip, where the
    //    section is hollow enough to be throwing one. Its bottom edge is a run
    //    of unequal lobes rather than a line, because a falling sheet breaks up
    //    into fingers before it lands — and because a straight bottom edge here
    //    would undo everything above it.
    const t = this.wave.time
    for (let i = 0; i <= last; i++) {
      if (i === 0) g.moveTo(this.lipCx[i], this.lipCy[i])
      else g.lineTo(this.lipCx[i], this.lipCy[i])
    }
    for (let i = last; i >= 0; i--) {
      const wx = this.colWx[i]
      const lobe = 0.62 + 0.38 * Math.sin(wx * 0.0186 - t * 2.3)
        + 0.22 * Math.sin(wx * 0.0451 + t * 3.1)
      g.lineTo(this.lipCx[i], this.lipCy[i] + this.lipFall[i] * lobe)
    }
    g.closePath().fill({ color: mix(TRANSMIT_MID, Core.paperWhite, 0.3), alpha: 0.24 })

    // 6. The lit edge along the back of the rope, in seven pieces of falling
    //    weight. `depthOutline` thins and fades it with distance and stops
    //    drawing it entirely past the far band, so it is a highlight rather
    //    than a uniform vector outline running to the horizon.
    const segs = 7
    for (let seg = 0; seg < segs; seg++) {
      const o = depthOutline((seg + 0.5) / segs)
      if (o.alpha <= 0) continue
      const i0 = Math.floor((seg * last) / segs)
      const i1 = Math.min(last, Math.ceil(((seg + 1) * last) / segs))
      g.moveTo(this.colX[i0], this.lipAy[i0] + 0.5)
      for (let i = i0 + 1; i <= i1; i++) g.lineTo(this.colX[i], this.lipAy[i] + 0.5)
      g.stroke({
        color: mix(Core.paperWhite, TRANSMIT_EDGE, 0.5),
        width: o.width * 1.05,
        alpha: clamp01(o.alpha * 0.55),
        cap: 'round',
      })
    }
  }

  private drawCaustics(camX: number): void {
    const w = this.wave
    const span = 2260
    const drift = w.time * 60
    for (let i = 0; i < CAUSTICS; i++) {
      const s = this.causticSprites[i]
      let sx = (this.causticSeedX[i] - camX * 0.94 + drift) % span
      if (sx < 0) sx += span
      sx -= 170
      const wx = camX + sx
      const k = this.perspK(sx)
      const h = w.heightAt(wx) * lerp(1, PERSP_SHRINK, k)
      const crest = w.troughYAt(wx) - k * PERSP_LIFT - h
      const p = w.pitchAt(wx)
      const fy = this.causticSeedF[i]
      const f = w.face.sample(p, fy, this.fs)
      s.position.set(sx, crest + (1 - fy) * h)
      s.rotation = f.angle
      const sz = this.causticSeedS[i]
      s.width = h * (0.12 + sz * 0.22)
      s.height = 3 + sz * 7
      // Brightest high on the face where the dawn light comes through the water.
      s.alpha = (0.14 + 0.3 * p) * smoothstep(0.02, 0.35, fy) * (1 - w.brokenAt(wx))
    }
  }

  private drawBirds(camX: number, camY: number): void {
    const t = this.wave.time
    for (let i = 0; i < this.birdGfx.length; i++) {
      const g = this.birdGfx[i]
      let bx = (700 + i * 330 - camX * 0.1 - t * 34) % 1100
      if (bx < 0) bx += 1100
      g.position.set(bx + 380, 318 + i * 30 + Math.sin(t * 0.7 + i * 2.2) * 13 - camY * 0.08)
      g.rotation = Math.sin(t * 0.7 + i * 2.2) * 0.12
    }
  }

  private poseSurfer(): void {
    const airborne = this.state === 'air'
    const down = this.state === 'down'
    const carveLoad = clamp01(Math.abs(this.vFace) / 640)
    this.surfer.setPose({
      crouch: down ? 1
        : airborne ? 0.3 + this.grabHeld * 0.4
          : clamp01(0.18 + carveLoad * 0.7 + this.tubeAmount * 0.35 + this.cutbackVisual * 0.3),
      lean: airborne ? clamp(this.rotVel * 0.05, -0.4, 0.4)
        : clamp(this.vx / 2200 - this.cutbackVisual * 0.5, -0.45, 0.4),
      reach: airborne ? 1 : clamp01(0.2 + this.cutbackVisual * 0.8 + carveLoad * 0.3),
      // The trailing hand goes into the wall inside the barrel. One pose, and
      // the whole frame reads as being inside something.
      drag: down ? 0 : this.tubeAmount * 0.9,
      twist: down ? 0 : clamp(-this.cutbackVisual + this.tubeAmount * 0.35, -1, 1),
      grab: airborne && this.grabHeld > 0.06 ? 1 : 0,
      facing: this.facing,
    })
    this.surfer.apply()
  }

  /** The barrel: the water closing over the camera side, and the light in it. */
  private drawTube(screenX: number, screenY: number): void {
    const t = this.tubeAmount
    const g = this.curtainGfx
    g.clear()
    if (t > 0.004) {
      // The near wall rises and closes over the viewer, peaking at the surfer.
      const peak = screenY - 70
      // The base sits well below the frame: the stage is canted, so the lowest
      // visible point of the world is a good deal further down than 1080.
      g.moveTo(-60, 1460)
      for (let sx = -60; sx <= 1990; sx += 40) {
        const d = (sx - screenX) / 620
        g.lineTo(sx, lerp(1180, peak, t * Math.exp(-d * d)))
      }
      g.lineTo(1990, 1460).closePath().fill(darken(DEEP, 0.35))
      // A lit rim where the curtain catches the light coming down the tube.
      g.moveTo(-60, lerp(1180, peak, t * Math.exp(-((((-60 - screenX) / 620)) ** 2))))
      for (let sx = -60; sx <= 1990; sx += 40) {
        const d = (sx - screenX) / 620
        g.lineTo(sx, lerp(1180, peak, t * Math.exp(-d * d)))
      }
      g.stroke({ color: mix(FACE_UPPER, Core.paperWhite, 0.4), width: 5, alpha: 0.7 * t })
    }

    // Pinned back to the screen: everything else in this layer scrolls with the
    // camera, but a full-frame darkening pass must not.
    this.tubeDark.y = this.camY - 240
    this.tubeDark.alpha = t * 0.44
    this.tubeGlow.position.set(screenX - 230, screenY - 110)
    this.tubeGlow.width = 900
    this.tubeGlow.height = 620
    this.tubeGlow.alpha = t * 0.62

    for (let i = 0; i < SHAFTS; i++) {
      const s = this.shafts[i]
      s.alpha = t * (0.16 + (i % 2) * 0.12)
      s.position.set(screenX - 380 + i * 150, screenY - 200 + (i % 3) * 60)
      s.width = 760
      s.height = 34 + i * 12
      s.rotation = -1.12 + i * 0.07
    }
  }

  private renderHud(): void {
    const mins = Math.floor(this.timeLeft / 60)
    const secs = Math.floor(this.timeLeft % 60)
    this.timeOut.set(`${mins}:${secs.toString().padStart(2, '0')}`)
    this.scoreOut.set(String(Math.round(this.score * SCORE_POINTS)))
    this.tubeOut.set(`${this.tubeTime.toFixed(1)}s`)
    this.fallsOut.set(`${this.wipeouts} / ${MAX_FALLS}`)

    // The breakdown lives on the judges' panel and is written once, by
    // `showResults`, with the run over and the values final. Only the speed
    // bar is a live instrument.
    this.speedMeter.set(this.vx / MAX_LINE_SPEED)

    if (this.resultsShown !== this.finished) {
      this.resultsShown = this.finished
      this.judges.setVisible(this.finished)
    } else if (this.finished) {
      this.judges.syncHints()
    }
    this.flashQuad.alpha = this.flash * 0.1
    this.flashQuad.tint = this.tubed ? this.pal.light : Core.paperWhite
  }

  /**
   * Put the trick call next to the rider.
   *
   * The HUD is not on the canted stage, so the rider's screen position has to
   * be carried across the stage transform by hand — `toGlobal` would do it, but
   * it allocates and `render` may not. This is the same rotate-scale-translate
   * `enter` applies to the stage, written out.
   */
  private placeCallout(worldX: number, worldY: number): void {
    if (!this.callout.active) return
    const dx = (worldX - this.camX - 960) * ZOOM
    const dy = (worldY - this.camY - 540) * ZOOM
    const c = Math.cos(TILT)
    const sn = Math.sin(TILT)
    const sx = 960 + dx * c - dy * sn
    const sy = 540 + STAGE_DY + dx * sn + dy * c
    // Up and ahead of him, and kept inside the frame margins whatever the
    // camera is doing.
    // Kept inside the frame and off the two readouts on the right margin: a
    // call that lands on the tube clock is the HUD colliding with itself again.
    const tx = clamp(sx + 210, 300, 1470)
    const ty = clamp(sy - 210, 170, 810)
    this.callout.placeAt(sx, sy, tx - sx, ty - sy)
  }

  resize(width: number, height: number): void {
    this.sky.resize(width, height)
    this.stage.pivot.set(width / 2, height / 2)
    this.stage.position.set(width / 2, height / 2 + STAGE_DY)
  }

  exit(): void {
    const cg = (window as unknown as Record<string, unknown>).__cg as
      Record<string, unknown> | undefined
    if (cg) { delete cg.surfResults; delete cg.surfFalls }
    this.waveBed?.stop(0.3)
    this.tubeBed?.stop(0.3)
    this.waveBed = null
    this.tubeBed = null
    this.foam.clear()
    this.foamB.clear()
    this.spray.clear()
    this.mist.clear()
    this.nearMist.clear()
  }

  debug(): Record<string, unknown> {
    return {
      // Is the control legend still on screen? The capture gate needs this:
      // three blind reviews were spent on a frame with a tutorial bar across
      // the player, and a wall-clock delay is wrong under software rendering
      // where the simulation advances far slower than the clock.
      // `finished` is part of it: once the panel is up the legend is gone and
      // the panel's own two lines are the legend, gated on the same switch.
      hintUp: (this.hint?.visible ?? false) && !this.finished,
      state: this.state,
      score: Math.round(this.score * 100) / 100,
      timeLeft: Math.round(this.timeLeft * 10) / 10,
      finished: this.finished,
      endedBy: this.finished ? this.endedBy : '',
      // where the surfer is
      lineX: Math.round(this.lineX),
      speed: Math.round(this.vx),
      faceT: Math.round(this.faceT * 1000) / 1000,
      faceSpeed: Math.round(this.vFace),
      // what the wave is doing here
      waveHeight: Math.round(this.localH),
      wavePitch: Math.round(this.localPitch * 100) / 100,
      waveEnergy: Math.round(this.localEnergy * 100) / 100,
      wavePhase: Math.round(this.wave.time * 100) / 100,
      breakX: Math.round(this.wave.breakX),
      pocket: Math.round(this.lineX - this.wave.breakX),
      reforming: this.wave.reformT > 0,
      // the good bits
      tubed: this.tubed,
      tubeTime: Math.round(this.tubeTime * 100) / 100,
      tubeRun: Math.round(this.tubeRun * 100) / 100,
      airHeight: this.state === 'air' ? Math.round(this.launchY - this.airPeakY) : 0,
      spinDeg: Math.round((this.spin * 180) / Math.PI),
      faceAngle: Math.round(this.localAngle * 100) / 100,
      cutback: this.cutbackT > 0,
      wipeouts: this.wipeouts,
      falls: this.wipeouts,
      maxFalls: MAX_FALLS,
      lastCall: this.callText,
      parts: {
        tube: Math.round(this.tubePts * 100) / 100,
        air: Math.round(this.airPts * 100) / 100,
        carve: Math.round(this.carvePts * 100) / 100,
        flow: Math.round(this.flowPts * 100) / 100,
      },
    }
  }
}
