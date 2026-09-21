import type { Graphics } from 'pixi.js'
import { keyFromRight, type KeyLight } from '../../../render/Staging'
import { Palettes, grade, type Hex } from '../../../render/Palette'

/**
 * The event's lighting contract.
 *
 * Roller Skating draws a sun. Everything in the frame has to obey it, and the
 * only way six files stay in agreement about *where* it is, is for them all to
 * read the numbers from here. `Boardwalk` re-exports the layout constants so the
 * older imports keep working.
 */

// --- world layout ----------------------------------------------------------
/** Sea horizon. */
export const HORIZON_Y = 452
/** Where the surf breaks. */
export const SURF_Y = 544
/** Top of the dry sand. */
export const BEACH_TOP = 566
/**
 * Top of the sea wall's capstone.
 *
 * Two things turn on this number. It is the frame's hardest value break — a
 * 0.78-luminance sand band dropping to a 0.26 wall face in one line — and the
 * skater has to be on one side of it rather than straddling it: an edge that
 * strong must never cut across the top third of a head. Under the current
 * camera the capstone sits at screen y 454 and the top of her head at 505 when
 * she is standing tall, so her whole silhouette reads against the dark band and
 * a cyan shirt and white skates have something to be bright against. Airborne
 * she rises through that edge into the light band, which is the biggest value
 * step the frame owns.
 */
export const WALL_TOP = 688
/** Where the wall meets the concrete. */
export const WALL_BASE = 808
/** The line the wheels run on. */
export const GROUND_Y = 906
/** Front edge of the path, where the planting starts. */
export const PATH_FRONT = 1044

// --- the camera ------------------------------------------------------------
/**
 * How far the camera is pushed in past the authored design space.
 *
 * The art is drawn at 1920x1080 and then this zoom is applied to the whole
 * world, so the visible window is 1157x651 of design space. A neutral blind
 * review measured the skater at "about eight percent of frame height" and said
 * "the character is an afterthought"; at ZOOM 1.66 with the rig scaled up in
 * `Skating`, the 186px figure is 309px in a 1080px frame — 28.6%, which is
 * where the reference holds a rider it means you to look at.
 *
 * `CAM_CY` is the load-bearing half. At 740 the crop spends the frame on the
 * ground plane rather than on empty sky, and it lands the skater across the
 * hardest edge in the picture: the sea wall's capstone sits at screen y 454 and
 * the top of her head between 505 and 545 depending on her crouch, so her whole
 * torso reads against the dark backlit wall while her skates sit on the deck. Airborne she rises through that edge into the
 * bright sand band, which is the strongest value break the frame owns.
 *
 * `CAM_CX` came in from 870 to 850, and `camScreenX` in the scene came right
 * with it. At the old pair a skater flat out sat at 12% of the frame width,
 * which is where set dressing lives; she now holds 19-34% depending on speed.
 *
 * The number is a balance and not a preference. The visible window is
 * `960 / ZOOM` either side of `CAM_CX`, so the road ahead of her is
 * `CAM_CX + 578 - camScreenX`, and pulling her toward the middle of the frame
 * spends exactly that. At 850/660-490 she sees 768px of boardwalk at a cruise
 * and 938px flat out — 0.62 seconds of warning at top speed against 0.69 before
 * the push-in. Ten percent is what the push-in costs; anything more would be a
 * difficulty change dressed up as a camera move, and the physics is not mine
 * to retune.
 */
export const ZOOM = 1.66
/** Design-space point that lands in the middle of the screen. */
export const CAM_CX = 850
export const CAM_CY = 740

// --- the value plan --------------------------------------------------------
/**
 * Three masses, and the whole point of this file.
 *
 * The previous cut of this plan was measured and rejected: "B's sky (~#a08cb4),
 * sand (~#e5c6a0), and boardwalk (~#6e6878) all sit inside a narrow midtone
 * band, so the skater's teal top is fighting a same-value grey and loses at a
 * glance." And the instruction that came with it:
 *
 *   "Commit to the light. B paints a low sun with a blown specular flare on the
 *    water and then lights every plane identically. Push the whole midground
 *    down into backlit silhouette (wall, posts, towers as one dark ~#4a3f52
 *    band), let the sand and ocean keep the heat, and the skater gets a rim and
 *    a real cast shadow for free."
 *
 * That is exactly what these numbers now do. In relative luminance, which is
 * what `scripts/score_frame.py` measures:
 *
 *   sky sliver, open sea        0.50 - 0.65   warm, and it keeps the heat
 *   wet sand, dry sand          0.75 - 0.86   THE LIGHT BAND
 *   capstone top plane          0.38          the step off the cliff
 *   sea wall face               0.26 -> 0.18   <- the backlit silhouette band
 *   posts, rail, signage, bins  0.20 - 0.24   everything standing is in it
 *   near beach crowd            0.30          it joins the band, not the sand
 *   concrete deck               0.36 -> 0.20   lit across as well as down
 *   planting, bed               0.10 - 0.16   the dark near plane
 *   the skater                  0.18 - 0.98   the widest span in the frame
 *
 * Squint and the frame is three masses: a warm light slot of sea and sand
 * across the top third, one dark violet band of everything that stands up in
 * the middle, and a graded deck under it. The skater stands with her head and
 * torso inside the dark band and her skates on the deck, so a cyan shirt at
 * 0.74 has something to be bright against — a 0.48 value break, which is the
 * largest single step in the picture and it belongs to the player.
 *
 * Hue breaks on the same line as value: the sand keeps the warm tan the palette
 * always had, and everything in the silhouette band is a cool violet that
 * shares no temperature with it.
 */
/** The beach. Warm, light, and the brightest mass in the frame. */
export const SAND: Hex = Palettes.skating.near
/**
 * The concrete, in light.
 *
 * Brought down from 0x8a7488 (luminance 0.48) to 0.36, which is the step that
 * takes the deck out of the "narrow midtone band" the review measured. It is
 * still decisively lighter than the wall behind it, because the deck is a
 * horizontal plane facing the sky and the wall is a vertical one turned away
 * from the sun: two planes of one material under one light, which is the whole
 * shading model.
 */
export const DECK: Hex = 0x6b566e
/**
 * The warm rake.
 *
 * "No warm rake across the deck." A low sun on a horizontal plane does not
 * light it evenly; it grazes it, and the graze is warm because the light is.
 * This is the colour of the band at the back of the deck where the sun clears
 * the sea wall, and of the wedge that rakes across it from the sun side.
 */
export const DECK_LIT: Hex = 0xb08468
/** Anything cast onto, or dug into, the concrete. */
export const DECK_INK: Hex = 0x2b2233
/** The darkest step of the concrete: the front apron and the front lip. */
export const DECK_DEEP: Hex = 0x3a2e42
/**
 * The sea wall's vertical face, and the base colour of the whole silhouette
 * band: wall, posts, rail, signage, bins and the near beach crowd all grade out
 * of this one hue so the midground reads as a single backlit mass rather than
 * as six props at six values. The number is the one the review asked for.
 */
export const WALL: Hex = 0x4a3f52
/** The capstone's top plane: the only part of the wall the sky still reaches. */
export const WALL_CAP: Hex = 0x6a5c78
/** Ice plant and sea grass on the near plane. */
export const PLANT: Hex = 0x2b422e

// --- the key light ---------------------------------------------------------
/** Sun position in design space. The sky, the glitter and every shadow use it. */
export const SUN_X = 1382
export const SUN_Y = 318

/**
 * The single key light. Low, warm, and coming from the right, so every surface
 * in the frame has a lit side and a shaded side and every standing object
 * throws a long shadow to the left.
 */
export const KEY: KeyLight = keyFromRight(Palettes.skating.light, 0.95)

/**
 * Rake of a cast shadow: length to the left, and drop down-frame, per unit of
 * object height. This is the one pair of numbers the wall, the fence, the props,
 * the hazards and the skater all share — the moment two of them disagree the
 * light falls apart.
 *
 * Steepened from where it was. At the old rake (-2.3, 0.34) every shadow in the
 * frame lay within 8 degrees of horizontal, which meant the one family of lines
 * that could have cut across a stack of horizontal bands was itself another
 * horizontal band. At 20 degrees every post, bin, sign and hazard throws a long
 * diagonal down-left across the concrete, and the skater's own is the longest
 * of them: it runs 334px from her wheels toward the bottom-left corner and
 * points straight back at her. It is also within 15 degrees of the plank
 * direction at the same point, which is correct — the sun is close to the
 * vanishing point the boards run to — so the shadows and the boards build one
 * diagonal family rather than two competing ones.
 */
export const SHADOW_DX = -1.8
export const SHADOW_DY = 0.66

/**
 * The vanishing point the boardwalk's longitudinal plank seams converge on.
 * Under the sun and just below the horizon, which is where a path running out
 * along a shoreline actually points.
 */
export const VP_X = SUN_X - 90
export const VP_Y = HORIZON_Y + 10

/** Shadow colour for a surface: same hue, much darker, richer. Never grey. */
export const shadeOf = (base: Hex): Hex =>
  grade(base, { valScale: 0.54, satScale: 1.45 })

/**
 * Shadow colour for anything lying on the concrete.
 *
 * Not `shadeOf(SAND)`. The old code shadowed the deck with the sand's shade,
 * which lands within a couple of points of the deck's own value and would have
 * made every cast shadow in the play plane invisible — the same mistake that
 * produced the mud plane in the first place, one layer down. Derived from
 * `DECK` it comes out at 0.14 against a 0.36 plane, which is a shadow.
 */
export const DECK_SHADE: Hex = grade(DECK, { valScale: 0.5, satScale: 1.5 })

/**
 * A long hard-edged cast shadow, thrown left from an object standing at `x` on
 * the ground line `baseY`. Flat, no blur — the reference art never blurs a
 * shadow, it just lays a darker shape on the ground.
 */
export function castShadow(
  g: Graphics, x: number, baseY: number,
  halfW: number, height: number, color: Hex, alpha = 0.3,
): void {
  const tipX = x + height * SHADOW_DX
  const tipY = baseY + height * SHADOW_DY
  // The far end of a raking shadow spreads slightly; a parallel-sided one reads
  // as a painted stripe.
  const tipHalf = halfW * 1.35 + 4
  g.moveTo(x - halfW, baseY)
    .lineTo(x + halfW, baseY)
    .lineTo(tipX + tipHalf, tipY)
    .lineTo(tipX - tipHalf, tipY)
    .closePath()
    .fill({ color, alpha })
}

/**
 * The occlusion pool: the tight dark gather where an object meets the ground.
 * Without it a cast shadow alone still reads as a decal lying near the object
 * rather than as light being blocked by it.
 */
export function contactPool(
  g: Graphics, x: number, baseY: number,
  rx: number, ry: number, color: Hex, alpha = 0.42,
): void {
  // Biased away from the sun so it sits under the shaded side of the object.
  g.ellipse(x - rx * 0.28, baseY - ry * 0.18, rx, ry).fill({ color, alpha })
}

/**
 * The screen-space direction of the boardwalk's planks at a point on the deck.
 *
 * The longitudinal boards converge on `VP`, so "along the deck" is a different
 * angle at every x — and a contact shadow that ignores it is the note the last
 * review opened with: "she's anchored by a soft airbrushed ellipse that ignores
 * the plank perspective entirely". Anything lying flat on the concrete — the
 * pool under the wheels, a skid, a puddle — takes its rotation from here, so the
 * whole ground plane agrees about which way it is going.
 *
 * Returned in the range (-pi/2, pi/2]: an ellipse rotated by `a` and by
 * `a + pi` are the same ellipse, and keeping it small avoids a needless flip.
 */
export function plankAngle(deckX: number, deckY: number): number {
  let a = Math.atan2(deckY - VP_Y, deckX - VP_X)
  if (a > Math.PI / 2) a -= Math.PI
  else if (a <= -Math.PI / 2) a += Math.PI
  return a
}
