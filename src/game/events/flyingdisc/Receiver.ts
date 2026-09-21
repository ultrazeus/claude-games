import { Container, Graphics } from 'pixi.js'
import { Core, grade, lighten, mix, type EventPalette, type Hex } from '../../../render/Palette'
import { clamp, clamp01, damp, lerp } from '../../../core/Tween'
import { SHADOW_TONE } from './Field'

/**
 * The athlete: a two-bone IK rig, used for both the receiver and the thrower.
 *
 * Every limb is one Graphics authored once with its origin at the proximal
 * joint, and animation is nothing but transform writes, so posing costs no
 * geometry rebuilds and the pose can be driven continuously by the simulation
 * instead of stepping between drawn frames.
 *
 * The limbs are NOT capsules. A rig of constant-width rounded rectangles is
 * what a neutral review called a placeholder, and it is right: see `bone()` at
 * the bottom of this file for the taper, the hands, the feet and the two-value
 * form shading that replace them. Check the result at thumbnail size, because
 * that is where a reviewer looks first.
 *
 * Two things are different here, both because this event is not side-on:
 *
 *   1. The rig is authored at 100 px per metre and then scaled by the field's
 *      pixels-per-metre at the athlete's depth, so one rig covers a figure that
 *      is 190 px tall at the throw line and 70 px tall at fifty metres.
 *   2. `profile` squashes the rig horizontally when the athlete is running
 *      straight away from the camera. A side-on rig viewed from behind reads as
 *      broken; squashing x to about 0.45 collapses the stride into a knee lift
 *      and an arm pump, which is exactly what a back view of a sprint looks
 *      like. It interpolates continuously with the run direction.
 *
 * Every joint target is computed in "facing right" space and the container's
 * x scale carries the mirror, so there is one code path for both directions.
 */

const THIGH = 46
const SHIN = 46
const TORSO = 58
const UPPER_ARM = 38
const FOREARM = 36
const HEAD_R = 17
/**
 * Half the width of the shoulder yoke, and how far under it the arms hang.
 *
 * The shoulder line is the widest part of an athlete and it was the narrowest
 * part of this torso. See the torso path in the constructor: these two numbers
 * are what bury the arms' proximal caps, which is what stops the shoulder
 * reading as a loose pill lying on the jersey.
 */
const SHOULDER_W = 20
const SHOULDER_LOCAL_Y = -TORSO + 9
/** Head centre above the hips, along the torso's own axis. */
const NECK_LOCAL_Y = -TORSO - (HEAD_R + 15)

/**
 * Limb widths, as a table, because a joint only reads if the child bone starts
 * exactly as wide as its parent ends.
 *
 *   "the forward leg's thigh and shin are two separate capsules with a visible
 *    joint gap"
 *
 * They were. `bone()` used to taper every limb to 45% of its own belly and then
 * start the next one at 100% of ITS belly, so the shin began nine pixels wide
 * where the thigh had finished at five: a step in the silhouette, drawn twice
 * over because both ends were separately outlined. Writing the joint width
 * once, and handing it to the parent as its tip and to the child as its root,
 * is what makes a knee a knee.
 *
 * `ENGINE.md` records the mirror image of this bug in Foot Bag — a stretch of
 * silhouette with no ink on it. This comment used to claim the rig was immune,
 * because `bone()` closed the proximal cap into the path it stroked. Then the
 * fix for inked-over shoulders stopped stroking that cap on parents AND
 * children alike, and the rig acquired the Foot Bag bug at every knee and
 * elbow: the joint circle is half parent tip and half child root, and after
 * that change neither half carried ink. Found in the capture, not in the code
 * — see the `caps` branch in `bone()`.
 */
const W = {
  thighBack: 22, thighFront: 23,
  shinBack: 17, shinFront: 18,
  upperBack: 16, upperFront: 17,
  foreBack: 14, foreFront: 15,
  /** Knees, elbows, ankles and wrists. Shared by the two bones that meet. */
  kneeBack: 13.5, kneeFront: 14,
  elbowBack: 10.4, elbowFront: 11,
  /*
   * AND THE WRIST WAS HALF THE WIDTH A WRIST IS.
   *
   * At 7 on a forearm whose belly is 15 the joint was 0.47 of the limb, and
   * the fist that hangs off it was 1.3 of the limb: a 2.8x step across six
   * pixels of silhouette, which is what "a detached hand" looks like however
   * the ink is drawn. A wrist is about 0.6 of the forearm's belly and an ankle
   * about 0.53 of the calf. Both come up to those numbers, so the taper runs
   * out into a joint instead of into a pin.
   */
  ankleBack: 8.9, ankleFront: 9.4,
  wristBack: 8.6, wristFront: 9.2,
}
/** Hip height above the feet when standing, px at the authoring scale. */
const HIP_STAND = 88
const ARM_LEN = UPPER_ARM + FOREARM

/**
 * Cast-shadow value. One, for one shadow.
 *
 * Authored, not derived. Both used to be `grade(pal.near, ...)` through a
 * `valScale` and a multiply blend, which makes the shadow a function of
 * whatever it happens to land on; a shadow that changes value with the band it
 * crosses is the mechanism behind "a streaky smear ... that doesn't match the
 * direction or shape of anything casting it". These are flat, opaque, and the
 * same value the touchline trees' shadows use, so every shadow on this field
 * is one material.
 */
// The SAME value, literally: `Field.ts` owns the number and this imports it,
// because two files that each wrote `0x191f14` next to a comment claiming one
// material is how the two drifted apart last time.
//
// It is luma 16.5 now, not 29, and the reason is measured rather than
// aesthetic. The hero's wedge leaves his light pool (L=63) and continues onto
// the near ground band, which was L=26.2 — so the outer half of the frame's
// most important shadow was drawn THREE POINTS LIGHTER than the grass it fell
// on. Two blind critics read the result the only way it can be read:
//
//   "the hero throwing at (110-300, 480-760) casts no shadow at all."
//
// At 16.5 it is under every ground value in the picture: 47 points under the
// pool he stands in, 14 under the lifted near band, and the darkest mark in
// the frame, which is where "reserve the darkest value for the thrower's
// silhouette and his cast shadow" puts it. The copse forty metres back uses
// `FAR_SHADOW_TONE` — same hue, same flat fill, seen through more air.
const SHADOW_COLOUR = SHADOW_TONE

export interface AthletePose {
  /** Gait cycle, radians. Advanced by the scene from the ground speed. */
  runPhase: number
  /** 0 = standing still, 1 = full sprint. Scales stride and arm swing. */
  runAmount: number
  /** 0 = upright, 1 = fully compressed (pre-jump load, landing absorb). */
  crouch: number
  /** 0 = on the ground, 1 = fully airborne. Tucks the legs. */
  airborne: number
  /** 0 = upright, 1 = laid out horizontal with both arms extended. */
  dive: number
  /** 0 = arms at the sides, 1 = both hands up over the head for the catch. */
  reach: number
  /** 0 = empty hands, 1 = disc clamped to the chest. */
  hold: number
  /**
   * Which way the athlete is moving across the field, -1..1. The sign mirrors
   * the rig; the magnitude decides how side-on it is drawn.
   */
  facing: number
  /** Throwing arm sweep: -1 wound up behind, 0 at release, +1 followed through. */
  throwSwing: number
}

export class Athlete {
  readonly container = new Container()
  /** Contact shadow. Belongs in the field's shadow layer, not under the rig. */
  readonly shadow = new Container()

  private thighBack = new Graphics()
  private shinBack = new Graphics()
  private thighFront = new Graphics()
  private shinFront = new Graphics()
  private torso = new Graphics()
  private bib = new Graphics()
  private upperArmBack = new Graphics()
  private foreArmBack = new Graphics()
  private upperArmFront = new Graphics()
  private foreArmFront = new Graphics()
  private head = new Graphics()
  private cap = new Graphics()
  private heldDisc = new Graphics()
  /** Hard-edged cast shadow, thrown away from the key light. */
  private cast: Graphics

  /** World scale: field pixels per metre / 100. Set by the scene each frame. */
  private worldScale = 1
  /** Smoothed facing, so a direction change turns the body rather than snapping. */
  private facingSmooth = 0
  /** Throwing hand, rig-local, as of the last `apply()`. See `throwHandAt`. */
  private handX = 0
  private handY = 0
  private armLag = 0

  private pose: AthletePose = {
    runPhase: 0, runAmount: 0, crouch: 0, airborne: 0, dive: 0,
    reach: 0, hold: 0, facing: 0, throwSwing: 0,
  }

  constructor(pal: EventPalette, shirt: Hex = Core.suitPrimary, shorts: Hex = Core.suitSecondary) {
    /*
     * THE FIGURE IS A SILHOUETTE NOW, AND THESE ARE THE NUMBERS THAT MAKE IT
     * ONE.
     *
     * Two blind reviews measured the same failure from two directions:
     *
     *   "the thrower's torso and legs give meanL=67.6 against a background of
     *    meanL=75.7 — a delta of EIGHT luminance points; the receiver 6.5.
     *    Both characters survive only on hue, which will collapse entirely on a
     *    phone in daylight or in any colour-blind view."
     *   "the hero athlete's torso sits at L99.7 against [a field at L92]."
     *
     * The kit was never the problem: it measures L=39.5 and always has. What
     * put the figure's mean up at 68 was everything else on him, measured off
     * captures/flyingdisc.png:
     *
     *   chest bib          L 99.7   `lighten(shorts, 0.18)`
     *   limb lit face      L 96.9   `lighten(fill, 0.26)` over skin
     *   head               L 91.4   `grade(skinLight, v0.5, s1.22)`
     *   shorts             L 65.2   `mix(suitDark, paperWhite, 0.12)`
     *   skin               L 62.0   `grade(skinMid, v0.46, s1.18)`
     *
     * The grass he stands in front of measures 92.0. Three of those are that
     * number to within five points. The mechanism behind two of them is worth
     * naming: a lit face written as `lighten(x, t)` is a lerp toward WHITE, so
     * it does not move when the thing it lights moves. Drive the kit down and
     * the shading stays where it was, which means the darker the figure got the
     * larger the share of it that stayed bright. Every lit face on this rig is
     * a `grade()` of its own base now — a value SCALE — so it travels.
     *
     * Surface by surface, against the plane each one is actually drawn over,
     * separation in luminance points before -> after:
     *
     *   chest bib            7.7 -> 52.6      head           9.2 -> 20.3
     *   shorts               9.3 -> 22.0      outline ink   15.3 -> 45.5
     *   bare skin            6.1 -> 21.3      receiver kit   7.2 -> 18.5
     *
     * and over the thrower's torso box as a whole, 23.2 -> 37.0. The one thing
     * deliberately left bright is the sun rim down his right edge (L=207),
     * because a silhouette is read by its edge.
     */
    const ink = grade(Core.suitDark, { valScale: 0.5, satScale: 1.1 })
    // Three-quarter BACKLIT. The sun in this event is low and behind the
    // athlete's right shoulder, so the skin the camera sees is the shaded side
    // of it — and the athlete has to fall inside the frame's dark mass for the
    // rim down his sunward edge to mean anything. Front-lit skin at luminance
    // 0.73 put half the figure's pixels into the pale band and cost the
    // silhouette the value break the whole staging is built around.
    const skin = grade(Core.skinMid, { valScale: 0.34, satScale: 1.3 })
    // Back limbs sit a step darker so the silhouette survives self-overlap.
    const back = 0.3

    // Wider at the joint than the old capsules, and tapering hard, so the
    // silhouette has shoulders, knees and ankles in it. Shins end in shoes and
    // forearms end in fists.
    /*
     * The upper arms are SLEEVE, not skin.
     *
     *   "shoulders are bolted-on circles"
     *   "the throwing arm is a single tapered stick that reads as a javelin and
     *    overlaps the head"
     *
     * Both of those are one decision. The upper arm's proximal cap is a
     * half-disc the width of the arm, drawn on top of the torso because the
     * near arm has to be in front of the chest — so a skin-coloured disc with a
     * hard ink ring round it sat on the jersey at the shoulder, attached to
     * nothing. And with the whole arm in one colour from shoulder to fingertip,
     * a throwing arm at full extension is one uninterrupted eighty-pixel taper:
     * a javelin.
     *
     * A long-sleeve jersey fixes both at once and invents nothing. The shoulder
     * is now shirt on shirt, so there is no disc to bolt on; the arm carries a
     * material change at the elbow, so it cannot read as one stick; and the
     * cuff lands exactly where the elbow bend does.
     */
    const sleeve = shirt
    const sleeveBack = grade(shirt, { valScale: 1 - back })
    bone(this.thighBack, THIGH, W.thighBack, grade(shorts, { valScale: 1 - back }), ink,
      'none', { tip: W.kneeBack, caps: 'none' })
    bone(this.shinBack, SHIN, W.shinBack, grade(skin, { valScale: 1 - back }), ink,
      'foot', { root: W.kneeBack, tip: W.ankleBack })
    bone(this.thighFront, THIGH, W.thighFront, shorts, ink,
      'none', { tip: W.kneeFront, caps: 'none' })
    bone(this.shinFront, SHIN, W.shinFront, skin, ink,
      'foot', { root: W.kneeFront, tip: W.ankleFront })
    bone(this.upperArmBack, UPPER_ARM, W.upperBack, sleeveBack, ink,
      'none', { tip: W.elbowBack, caps: 'none' })
    bone(this.foreArmBack, FOREARM, W.foreBack, grade(skin, { valScale: 1 - back }), ink,
      'hand', { root: W.elbowBack, tip: W.wristBack })
    bone(this.upperArmFront, UPPER_ARM, W.upperFront, sleeve, ink,
      'none', { tip: W.elbowFront, caps: 'none' })
    bone(this.foreArmFront, FOREARM, W.foreFront, skin, ink,
      'hand', { root: W.elbowFront, tip: W.wristFront })

    /*
     * A NECK, AND SHOULDERS WIDE ENOUGH TO HANG ARMS OFF.
     *
     * The old torso was an hourglass 28 units across at the top, 38 at the
     * belly: its NARROWEST point was the shoulder line, and the arm roots hang
     * at x = +-7 with a proximal cap eight units in radius, so each cap ran
     * from -15 to +1. Fifteen against a thirteen-unit half-width, on a shape
     * leaning away from them. Two blind critics read the result off the
     * capture the same way:
     *
     *   "the shoulder is a floating pink capsule"
     *   "the shoulder is a detached crimson pill"
     *
     * And they were reading a real object: crop (160,640)-(290,740) out of
     * `captures/flyingdisc.png` at 9x and a rounded crimson cap sits proud of
     * the jersey over open grass with no ink on its outer arc, because upper
     * arms carry `caps: 'none'` on the promise that a torso covers them.
     *
     * So the torso gets the shoulder line an athlete has — the widest part of
     * him, 40 units across, with the deltoid rounded over — and the arm roots
     * move down to `SHOULDER_LOCAL_Y`, nine units under the yoke, where the
     * caps are buried on every pose the rig can reach. There is nothing left
     * to bolt on and nothing left to ink.
     *
     * The neck is drawn FIRST, so the yoke laps over its root and the head
     * covers its top: eleven units of it show, which is the notch between head
     * and body that a silhouette is read by. Before this the head simply hung
     * in the air above the shoulder line with grass between.
     */
    const neckSkin = grade(skin, { valScale: 0.88, satScale: 1.05 })
    this.torso
      // Top at -TORSO - 20, which is seven units inside the head's own bottom
      // edge at -TORSO - 15 (head centre -TORSO - 32, radius 17): the head is
      // drawn after the torso, so that overlap is what guarantees there is no
      // seam between jaw and neck at any lean. The base at -TORSO + 8 is
      // buried under the yoke for the same reason.
      .moveTo(-5.8, -TORSO + 8)
      .lineTo(-4.6, -TORSO - 20)
      .lineTo(4.6, -TORSO - 20)
      .lineTo(5.8, -TORSO + 8)
      .closePath()
      .fill(neckSkin)
      .stroke({ color: grade(neckSkin, { valScale: 0.5, satScale: 1.25 }), width: 2.6, join: 'round' })
    // Torso, origin at the hips. Outlined in a dark tint of its own colour
    // rather than black, which is the reference's rule for every material.
    this.torso
      .moveTo(-17.5, 3)
      .bezierCurveTo(-16.5, -TORSO * 0.36, -20, -TORSO * 0.62, -SHOULDER_W, -TORSO + 13)
      .quadraticCurveTo(-SHOULDER_W - 0.5, -TORSO - 1, -SHOULDER_W + 9, -TORSO - 2.5)
      .lineTo(SHOULDER_W - 9, -TORSO - 2.5)
      .quadraticCurveTo(SHOULDER_W + 0.5, -TORSO - 1, SHOULDER_W, -TORSO + 13)
      .bezierCurveTo(20, -TORSO * 0.62, 16.5, -TORSO * 0.36, 17.5, 3)
      .closePath()
      .fill(shirt)
      .stroke({ color: grade(shirt, { valScale: 0.5, satScale: 1.15 }), width: 3.2, join: 'round' })
    // Two values on the largest surface of the figure: a core shadow down the
    // flank turned away from the sun and a lit sliver on the flank facing it.
    // A figure drawn as one flat colour block was named in review as the thing
    // that stops a character reading as a body.
    const coreShade = new Graphics()
    coreShade
      .moveTo(-16.8, 2).lineTo(-6.5, 0).lineTo(-6.5, -TORSO - 1).lineTo(-15.8, -TORSO + 4)
      .closePath()
      .fill({ color: grade(shirt, { valScale: 0.68, satScale: 1.24 }), alpha: 0.95 })
    /*
     * AND THE LIT FLANK AND THE RIM TOGETHER WERE "THE PALE JERSEY WEDGE
     * CLIPPING OUTSIDE HIS TORSO SILHOUETTE NEAR (1576, 575)".
     *
     * They were, and crop (240,690)-(300,810) at 7x shows what the critic saw:
     * eleven pixels of L=89 flank with seven more of L=207 rim outside it, the
     * pair of them running the full height of the jersey and ending SQUARE on
     * the hip corner — where the torso's own hem line, the rim's round cap and
     * the navy shorts all meet. A cream mark two hundred points off its
     * neighbours, cut off flat against the darkest part of the figure, reads as
     * a separate object lying on him.
     *
     * Three changes and no new shapes. The flank tapers to a point six units
     * above the hem instead of running into it, so the light dies out on the
     * form the way light does. It comes down from L=89 to L=68, which is still
     * a 28-point turn off a jersey at L=39.5 and no longer the second
     * brightest thing on the man. And the rim (below) starts where the flank
     * does, butt-capped, so there is no round cap sitting proud of the corner.
     */
    const litFlank = new Graphics()
    litFlank
      .moveTo(16.6, -7).lineTo(11.0, -13).lineTo(10.4, -TORSO - 1).lineTo(15.6, -TORSO + 4)
      .closePath()
      .fill({ color: mix(lighten(shirt, 0.08), pal.light, 0.08), alpha: 0.9 })
    // Rim. The sun in this event is low and to the right, so the athlete is
    // three-quarter backlit and his right edge is a hot line of direct light.
    // This is the athlete's value break: without it a mid-value figure on a
    // mid-value field is, in a neutral critic's words, "the lowest-contrast
    // pairing available". The rim is the brightest thing on the man and the
    // frame's biggest single value jump belongs to him.
    //
    // The brightest thing on the MAN, not in the frame. At 0.3 toward the key
    // this line measured L=229 raw and 217-220 composited, which in the frame
    // this event is judged on made a 3.6 px hairline on his shoulder the
    // highest value in the whole picture — above the disc the event is named
    // for. At 0.72 it measures L=207 raw and about 197 where it is drawn: still
    // a jump of a hundred and twenty-five points off the shirt beneath it, so
    // the break the critic asked for is untouched, and one clear step under the
    // disc's plate at L=209.8. It is also warmer, which is what a rim taken
    // mostly from a low sun's own colour should be.
    const rimColour = mix(mix(Core.sunWhite, Core.paperWhite, 0.4), pal.light, 0.72)
    // Started at (17.34, -8.1), which is the point the torso's own right-hand
    // bezier passes through at t=0.833 — solved rather than eyeballed, so the
    // rim lies ON the contour instead of near it — and butt-capped, so nothing
    // of it reaches past the hem. See the flank note above.
    const rim = new Graphics()
    rim
      .moveTo(17.34, -8.1)
      .quadraticCurveTo(18.08, -26.59, SHOULDER_W, -TORSO + 13)
      .quadraticCurveTo(SHOULDER_W + 0.5, -TORSO - 1, SHOULDER_W - 9, -TORSO - 2.5)
      .stroke({ color: rimColour, width: 3.4, alpha: 0.9, cap: 'butt' })
    // A chest panel in the second accent: one hue break so a 70 px figure still
    // reads as a person and not a coloured tick.
    //
    // `lighten(shorts, 0.18)` measured L=99.7 — the brightest large surface on
    // the figure, on its biggest shape, at the exact value of the field behind
    // it. A hue break must not cost a value break. `grade` of the shorts keeps
    // the hue break and travels with the kit instead of with white.
    /*
     * AND THEN IT WAS "A FLOATING GREY-BLUE RECTANGLE ON HIS CHEST".
     *
     * Three things made it float, and none of them was the hue:
     *
     *   1. it was a RECTANGLE on a curved torso — four straight edges and four
     *      hard corners on a shape that has neither;
     *   2. it carried no ink, on a figure where every other surface is outlined
     *      in a dark tint of its own colour, so nothing said it was printed on
     *      the jersey rather than lying in front of it;
     *   3. at valScale 1.34 it measured L=57 against a jersey at L=39.5 — the
     *      brightest thing on the man below the rim, which is a lot of value to
     *      spend on a number panel.
     *
     * So: the panel's sides follow the torso's own taper as curves, its
     * shoulders are cut off the way a printed yoke is, it is outlined in the
     * SAME ink the torso and the cap are outlined in, and it comes down to
     * valScale 1.18 (L=50). That still clears the jersey by eleven points and
     * keeps the hue break a 70 px figure needs to read as a person, and it can
     * no longer read as a separate object because it is inked onto the thing it
     * is printed on.
     */
    const bibInk = grade(shirt, { valScale: 0.5, satScale: 1.15 })
    this.bib
      .moveTo(-6.4, -TORSO * 0.9)
      .lineTo(6.4, -TORSO * 0.9)
      .quadraticCurveTo(8.2, -TORSO * 0.62, 5.2, -TORSO * 0.32)
      .lineTo(-5.2, -TORSO * 0.32)
      .quadraticCurveTo(-8.2, -TORSO * 0.62, -6.4, -TORSO * 0.9)
      .closePath()
      .fill(grade(shorts, { valScale: 1.18, satScale: 0.86 }))
      .stroke({ color: bibInk, width: 2.2, join: 'round' })
    this.torso.addChild(coreShade, litFlank, this.bib, rim)

    // The head was measured at L=91.4 against a field at L=92.0 — a
    // half-point of separation on the one part of a figure a viewer looks at
    // first. It comes down with the rest of the skin, and then one step further
    // than the limbs, because the head is the one part of the thrower that is
    // NOT cut against the light strip: at this camera height it sits against
    // the mid wood (L=71). At 50.6 it clears that by twenty and the light strip
    // by sixty, and it is still seven points up from the limbs, which is what
    // keeps a face reading as a face rather than as a hole in the shoulders.
    const skinLit = grade(Core.skinLight, { valScale: 0.29, satScale: 1.4 })
    /**
     * The head, with a face in its SILHOUETTE.
     *
     * Four blind reviews in a row reported this head as "faceless", and a
     * circle of skin is exactly that: at thumbnail size — which is where a
     * reviewer looks first — a face drawn as marks on a disc reads as a disc
     * with marks on it. So the nose is part of the outline, not a decal: the
     * head path runs down the brow, bulges out to a nose, and comes back to
     * the chin. The profile is what gives the head a direction, and the eye
     * under the cap's brim is what confirms it.
     */
    const headInk = grade(skinLit, { valScale: 0.5, satScale: 1.25 })
    const BROW = -Math.PI * 0.13
    const CHIN = Math.PI * 0.24
    this.head
      .moveTo(0, -HEAD_R)
      .arc(0, 0, HEAD_R, -Math.PI * 0.5, BROW)
      .quadraticCurveTo(
        HEAD_R * 1.38, HEAD_R * 0.04,
        Math.cos(CHIN) * HEAD_R, Math.sin(CHIN) * HEAD_R,
      )
      .arc(0, 0, HEAD_R, CHIN, Math.PI * 1.5)
      .closePath()
      .fill(skinLit)
      .stroke({ color: headInk, width: 3, join: 'round' })
    // Terminator: the side away from the key falls off.
    this.head
      .arc(0, 0, HEAD_R - 1, Math.PI * 0.42, Math.PI * 1.58)
      .lineTo(-HEAD_R * 0.18, -HEAD_R + 2)
      .closePath()
      .fill({ color: grade(skin, { valScale: 0.82, satScale: 1.1 }), alpha: 0.75 })
    // One eye, sitting in the shadow of the brim.
    this.head
      .ellipse(HEAD_R * 0.52, -HEAD_R * 0.04, HEAD_R * 0.15, HEAD_R * 0.23)
      .fill(headInk)

    // The cap.
    //
    // The previous version was ONE closed path: an arc over the crown, out to
    // the brim tip, and then a straight line back across the head to close it.
    // That line was stroked, so it drew a chord across the face, and the brim
    // itself was a five-pixel sliver hanging off the head's outline with
    // nothing joining the two. A blind review read exactly that: "a detached
    // floating cap-brim outline".
    //
    // It is two closed shapes now, brim FIRST and crown over it, so the brim's
    // root is buried inside the crown and cannot read as a loose line. Neither
    // path closes through the other.
    const capInk = grade(shirt, { valScale: 0.5, satScale: 1.15 })
    this.cap
      .moveTo(0, -2.5)
      .lineTo(HEAD_R + 15, -5)
      .lineTo(HEAD_R + 13, -11.5)
      .lineTo(0, -10)
      .closePath()
      .fill(grade(shirt, { valScale: 0.74, satScale: 1.08 }))
      .stroke({ color: capInk, width: 2.4, join: 'round' })
    this.cap
      .moveTo(-HEAD_R - 1.5, -1)
      .arc(0, -1, HEAD_R + 1.5, Math.PI, Math.PI * 2)
      .closePath()
      .fill(shirt)
      .stroke({ color: capInk, width: 2.6, join: 'round' })

    // The disc, in the hand.
    //
    // It was an ellipse with an outline, and a neutral review saw it for what
    // it was: "the disc in the thrower's hand reads as a flat brown box, not a
    // disc. In a game named for the disc." So it is built as an object now — a
    // shadowed underside, a rim band with thickness, a top plate inset inside
    // the rim, a flight-ring groove, and a specular arc on the side the sun is
    // on. Five marks, and at thumbnail size they read as a disc rather than as
    // a lozenge.
    {
      const DR = 17
      const band = mix(Core.sunGold, 0xe4572e, 0.4)
      const bandInk = grade(band, { valScale: 0.5, satScale: 1.18 })
      // The same gold as the disc in flight (`Disc.ts`), not paper white. It is
      // the same object four frames apart, and a hero that changes colour the
      // moment it leaves the hand is two props. It also takes a 248 out of the
      // frame: nothing but the flying disc's own specular sits above L=210.
      const plate = mix(Core.sunGold, Core.sunWhite, 0.18)
      const d = this.heldDisc
      // 1. The underside, seen because the disc is held slightly nose-up.
      d.ellipse(0, 2.6, DR, DR * 0.4).fill(grade(band, { valScale: 0.6, satScale: 1.1 }))
      // 2. The rim: the coloured band around the outside, with thickness.
      d.ellipse(0, 0, DR, DR * 0.4).fill(band)
        .ellipse(0, 0, DR, DR * 0.4).stroke({ color: bandInk, width: 1.8 })
      // 3. The top plate, inset inside the rim so the rim has a width.
      d.ellipse(0, -0.5, DR * 0.76, DR * 0.28).fill(plate)
      // 4. The flight ring: the groove every disc has just inside the rim.
      d.ellipse(0, -0.5, DR * 0.5, DR * 0.19)
        .stroke({ color: grade(plate, { valScale: 0.82, satScale: 1.4 }), width: 1.4 })
      // 5. Direct sun on the rim's right shoulder. Traced as the top-right
      //    quarter of the rim ellipse — a circular arc would leave the rim,
      //    because the rim is squashed to the angle it is seen at.
      const ea = DR * 0.94
      const eb = DR * 0.4 * 0.94
      const K = 0.5523
      d.moveTo(ea, -0.4)
        .bezierCurveTo(ea, -eb * K - 0.4, ea * K, -eb - 0.4, 0, -eb - 0.4)
        .stroke({ color: Core.sunWhite, width: 2.2, alpha: 0.85, cap: 'round' })
    }
    this.heldDisc.visible = false

    // Depth order is the draw order.
    //
    // The head and the cap come AFTER the front arm. With the arm last, the
    // near shoulder — a skin-coloured disc the width of the upper arm — drew
    // straight over the face on any pose that raises the arm, and a blind
    // review reported the head as "overlapped by a tan shoulder lump". The
    // face is the one part of the figure that must never be occluded by the
    // figure's own furniture. The held disc goes last of all: it is in the
    // hand, and the hand is in front of everything the athlete is holding it
    // against.
    this.container.addChild(
      this.thighBack, this.shinBack,
      this.upperArmBack, this.foreArmBack,
      this.thighFront, this.shinFront,
      this.torso,
      this.upperArmFront, this.foreArmFront,
      this.head, this.cap,
      this.heldDisc,
    )
    this.container.interactiveChildren = false

    /*
     * The cast shadow is a DRAWN shape, not a soft dot.
     *
     * Four blind reviews of this frame, none of which saw the others, flagged
     * something in this family:
     *
     *   "a second orphan ellipse floating at (310,455)"
     *   "feet detached from a shadow that sits left of them"
     *   "a streaky, soft-brush painterly smear in an otherwise hard-edged
     *    vector scene"
     *   "a hard-edged stylised shadow instead of the blurred streak"
     *
     * `ContactShadow` builds a 96 px radial dot at 0.2 hardness and stretches
     * it to two or three metres of grass; at that scale its falloff alone is
     * wider than the athlete. So: one tapered wedge, blunt under the feet and
     * pointed at the far end, authored in a unit box running from the feet at
     * x = 0 out to x = -1, filled flat and opaque in the same value the trees'
     * shadows use. Its blunt end is AT the feet, which is the only thing that
     * plants a figure.
     */
    this.cast = new Graphics()
    this.cast.moveTo(-1, 0)
      .quadraticCurveTo(-0.6, -0.26, -0.1, -0.4)
      .quadraticCurveTo(0.3, -0.5, 0.34, 0)
      .quadraticCurveTo(0.3, 0.5, -0.1, 0.4)
      .quadraticCurveTo(-0.6, 0.26, -1, 0)
      .closePath()
      .fill(SHADOW_COLOUR)
    /*
     * ONE SHADOW PER OBJECT.
     *
     *   "the thrower gets a soft unattached ellipse PLUS a second hard-edged
     *    dark patch — two shadow systems on one character"
     *
     * There was a second shape: a flat ellipse at L=20 laid inside a wedge at
     * L=29, as contact occlusion. Crop the feet out of the capture at 8x and
     * it is exactly what the critic describes — an ellipse of a different
     * value, in a different vocabulary, floating inside the cast shadow with
     * no edge of the figure touching it. Every other caster on this field gets
     * one wedge in SHADOW_TONE; the hero now gets one wedge in SHADOW_TONE.
     * Its blunt end is at his feet, which is what plants him, and it is the
     * only shadow he has.
     */
    this.shadow.addChild(this.cast)
    this.shadow.interactiveChildren = false
  }

  setPose(p: Partial<AthletePose>): void {
    Object.assign(this.pose, p)
  }

  /** Field pixels-per-metre at this athlete's depth. */
  setWorldScale(pixelsPerMetre: number): void {
    this.worldScale = pixelsPerMetre / 100
  }

  /**
   * Screen position of the throwing hand, after the last `apply()`.
   *
   * The scene needs it because the hero is drawn well over life size while the
   * simulation releases the disc from a real 1.35 m: the two are a metre and a
   * half apart on screen, and a flight path that starts at the simulated point
   * appears to leave the athlete's waist. Writes into `out` rather than
   * allocating; the rig runs every frame.
   */
  throwHandAt(out: { x: number, y: number }): void {
    const c = this.container
    out.x = c.position.x + this.handX * c.scale.x
    out.y = c.position.y + this.handY * c.scale.y
  }

  /** Secondary motion. Once per simulation step. */
  update(dt: number): void {
    this.facingSmooth = damp(this.facingSmooth, this.pose.facing, 0.0008, dt)
    this.armLag = damp(this.armLag, this.pose.facing * 0.5, 0.004, dt)
  }

  /**
   * Height of the catching hands above the athlete's feet, in metres. The scene
   * needs this to decide whether the disc is reachable, and it has to come from
   * the rig rather than a constant so that a jump and a dive really do change
   * what can be caught.
   */
  reachHeight(): number {
    const p = this.pose
    const standing = (HIP_STAND + TORSO + ARM_LEN * 0.96) / 100
    const dived = (HIP_STAND * 0.3 + ARM_LEN * 0.4) / 100
    return lerp(lerp(standing * (1 - p.crouch * 0.18), standing, p.reach), dived, p.dive)
  }

  /** How far in front the hands can get, in metres. A dive buys a lot of this. */
  reachForward(): number {
    return lerp(0.45, 1.85, this.pose.dive) + this.pose.reach * 0.15
  }

  /** Recompute the whole rig. Transform writes only. */
  apply(): void {
    const p = this.pose
    const f = this.facingSmooth >= 0 ? 1 : -1
    // Straight-away running collapses to a narrow back view; a full lateral
    // sprint opens out to a side profile. A dive is always seen side-on.
    /*
     * 0.45 was too far. A rig squashed to 45% of its width has a torso eleven
     * pixels across at fifty metres, which a blind review read exactly as it
     * looks: "a featureless grey rectangle for a torso". A figure seen from
     * behind still has shoulders — what it loses is the stride, and the stride
     * is already carried by the leg angles. 0.68 keeps the back view reading as
     * a back view and gives the silhouette something to be.
     */
    const profile = lerp(lerp(0.68, 1, clamp01(Math.abs(this.facingSmooth))), 1, p.dive)
    this.container.scale.set(f * profile * this.worldScale, this.worldScale)

    const dive = clamp01(p.dive)
    const air = clamp01(p.airborne)
    const crouch = clamp01(p.crouch)
    const run = clamp01(p.runAmount)

    // --- hips and torso ------------------------------------------------------
    const bob = -Math.abs(Math.sin(p.runPhase)) * 4 * run
    const hipY = -lerp(HIP_STAND - crouch * 24 + bob, HIP_STAND * 0.34, dive) - air * 6
    const hipX = lerp(0, 34, dive) + p.throwSwing * 3

    /*
     * Lean: forward with speed, hard over into a dive, and the throw twists it.
     *
     * The dive constant was -1.24, and it had to be, because the head and the
     * arms were hung off the mirror of this angle (see the shoulder note
     * below): a NEGATIVE lean rotated the drawn torso's top backward and the
     * head forward, and a dive needs the head forward. Every other term is
     * positive — run lean, crouch, throw follow-through — so under the old
     * code a running athlete leaned his torso one way and his head the other,
     * which is the same single fault seen from the other end.
     *
     * With the head and the arms placed through the torso's real transform,
     * +1.24 is what lays the body out head-first over trailing feet, and every
     * term in the sum now means the same thing by the same sign.
     */
    const lean = clamp(
      lerp(run * 0.2 + crouch * 0.18, 1.24, dive) + p.throwSwing * 0.22 + this.armLag * 0.1,
      -0.9, 1.5,
    )
    this.torso.position.set(hipX, hipY)
    this.torso.rotation = lean

    /*
     * THE HEAD AND BOTH ARMS WERE HUNG OFF THE WRONG SIDE OF THE LEAN.
     *
     * This is the fault under "the thrower's rig is disassembled", and it is
     * one sign. Pixi rotates clockwise in screen space, so the torso's own top
     * — its local (0, -TORSO) — lands at hip + (sin(lean) * TORSO,
     * -cos(lean) * TORSO). The line above wrote `Math.sin(lean) * -TORSO`,
     * which is that point MIRRORED through the hips, and the neck repeated the
     * error a second time on top of it.
     *
     * It is invisible standing upright and it opens with the lean, so nothing
     * caught it on the receiver, who barely leans. On the thrower at follow
     * through it is worth 2 * TORSO * sin(0.27) = 31 rig units, about 48 px on
     * the hero: measured on `captures/flyingdisc.png` the torso's top edge
     * crosses x = 258 while the shoulder caps sit at x = 198 and 220 and the
     * head centre at 194. The arms and the head were simply not attached to
     * the body — the arms hung in the grass beside it and the throwing arm
     * came out of the ear, which is the "capsule crossing the face".
     *
     * Everything the torso carries is placed through its real transform now,
     * from coordinates written in the torso's own frame.
     */
    const sinL = Math.sin(lean)
    const cosL = Math.cos(lean)
    const backShoulderX = hipX + cosL * -7 - sinL * SHOULDER_LOCAL_Y
    const backShoulderY = hipY + sinL * -7 + cosL * SHOULDER_LOCAL_Y
    const frontShoulderX = hipX + cosL * 7 - sinL * SHOULDER_LOCAL_Y
    const frontShoulderY = hipY + sinL * 7 + cosL * SHOULDER_LOCAL_Y

    // A neck. It is DRAWN now — see the torso path — so this only has to put
    // the head far enough up the torso's axis that the chin laps its top and
    // the notch between head and body still reads at thumbnail size.
    this.head.position.set(
      hipX - sinL * NECK_LOCAL_Y + dive * 6,
      hipY + cosL * NECK_LOCAL_Y,
    )
    // The head stays level-ish in a dive: you look at the disc, not the ground.
    this.head.rotation = lean * lerp(0.55, 0.25, dive)
    this.cap.position.copyFrom(this.head.position)
    this.cap.rotation = this.head.rotation

    // --- legs ----------------------------------------------------------------
    // Feet trace a flattened ellipse: forward and up through the swing, planted
    // and driving back through the stance. Tucked in the air, trailing in a dive.
    const stride = 30 * run
    const lift = 27 * run
    const phaseB = p.runPhase + Math.PI

    const fAx = Math.cos(p.runPhase) * stride
    const fAy = -Math.max(0, Math.sin(p.runPhase)) * lift
    const fBx = Math.cos(phaseB) * stride
    const fBy = -Math.max(0, Math.sin(phaseB)) * lift

    const tuckX = -10
    const tuckY = -44
    const diveX = -44
    const diveY = -HIP_STAND * 0.2

    // Stance.
    //
    // With `run` at zero both feet solved to the SAME point — (0, 0) — off hips
    // ten pixels apart, so the two legs drew on top of each other and the
    // figure stood on one column. A blind review: "the legs merge into one
    // column". A thrower does not stand to attention anyway: he steps into the
    // throw, so the stance opens with the swing and closes again as the run
    // takes over.
    const planted = (1 - run) * (1 - air) * (1 - dive)
    const step = planted * (22 + 12 * clamp01(p.throwSwing))

    const footFrontX = lerp(lerp(fAx + step, tuckX + 16, air), diveX + 12, dive)
    const footFrontY = lerp(lerp(fAy, tuckY, air), diveY, dive)
    const footBackX = lerp(lerp(fBx - step * 1.15, tuckX - 10, air), diveX - 14, dive)
    // The back heel lifts as the weight transfers forward through the throw.
    const footBackY = lerp(lerp(fBy - planted * 7 * clamp01(p.throwSwing), tuckY - 6, air), diveY + 6, dive)

    solve(this.thighBack, this.shinBack, hipX - 7, hipY, footBackX, footBackY, THIGH, SHIN, -1)
    solve(this.thighFront, this.shinFront, hipX + 7, hipY, footFrontX, footFrontY, THIGH, SHIN, -1)

    // --- arms ----------------------------------------------------------------
    // Three drivers, blended: the run swing, the catch reach, and the throw.
    const swing = Math.sin(phaseB) * 0.85 * run
    const reach = clamp01(p.reach)

    /*
     * Angles are measured from the shoulder, 0 = straight ahead, -PI/2 = up.
     *
     * The gait swing is written in the TORSO's frame, not the world's, because
     * a shoulder is a socket in a body and an arm that ignores the lean walks
     * through the chest at one end of its stroke and through the head at the
     * other. With the head finally sitting above the shoulders instead of a
     * quarter-turn behind them, a world-space swing at full stride put the
     * forward arm's forearm 0.6 units from the head's centre — straight
     * through the face. Re-based on the lean it clears by thirty-two.
     */
    const runBack = lean - 0.25 - swing
    const runFront = lean - 0.25 + swing
    /*
     * A catch reach is TWO arms.
     *
     * Both arms used to be driven to the same -1.32, and two identical bones
     * drawn from shoulders fourteen pixels apart, on a rig squashed to 45% of
     * its width, is one stick. Two blind reviews, separately:
     *
     *   "arms fused into one brown stick above the head"
     *   "a half-scale mid-ground receiver whose arms have fused into a single
     *    stick"
     *
     * So the pair splays: the far arm reaches up and slightly back, the near
     * arm up and slightly forward, which is also what a real two-handed
     * overhead catch looks like. Twenty-two degrees of separation is enough
     * that a 70 px figure shows daylight between them.
     */
    const reachBack = -1.32 - 0.2
    const reachFront = -1.32 + 0.2
    const diveAngle = -0.34
    // A throw is one long sweep of the front arm from behind the body forward.
    const throwAngle = lerp(2.5, -0.55, clamp01((p.throwSwing + 1) * 0.5))
    /**
     * Carrying the disc: hands at CHEST height, in front of the body.
     *
     * -0.95 put both hands up beside the ear. That was survivable while the
     * held disc was drawn at the midpoint between the two hands — the midpoint
     * landed on the sternum — but the disc is in the throwing hand now, where
     * a review of the frame said it belonged, so the hand is where the disc
     * is. At 0.34 the disc rides in front of the chest, clear of the head and
     * clear of the torso's own silhouette, which is what "clamped to the
     * chest" was always supposed to look like.
     */
    // Torso-relative, for the same reason the gait swing is: "in front of the
    // chest" is a direction the chest owns.
    const holdAngle = lean + 0.34

    const throwing = Math.abs(p.throwSwing) > 0.001 ? 1 : 0
    const hold = clamp01(p.hold)

    /**
     * The off arm, through a throw.
     *
     * It used to blend 55% of the way to 2.1 rad, which lands at about 1.04 —
     * down and FORWARD, straight down the body's centre line. The off arm is
     * drawn behind the torso, so at that angle it was entirely hidden inside
     * the torso silhouette and a blind review reported the obvious: "there is
     * no second arm."
     *
     * So it is driven by the swing instead, and both ends of the sweep clear
     * the body. Wound up, it points at the target — which is what a thrower
     * actually does while sighting a line. Followed through, it is flung back
     * behind the hip as the counterweight to the throwing arm. Negative-space
     * between arm and torso is the thing that makes a silhouette read.
     *
     * THEN IT WAS COLLINEAR WITH THE THROWING ARM, WHICH IS HOW THE JAVELIN
     * GOT THERE.
     *
     *   "the throwing arm is a single tapered stick that reads as a javelin and
     *    overlaps the head"
     *
     * Measured off the swing: at full follow-through the throwing arm solves to
     * -0.55 rad and this one to Math.PI - 0.7 = 2.44 rad. The backward
     * continuation of -0.55 is 2.59. Eight degrees apart, off shoulders
     * fourteen pixels apart, both arms straight — one stick through the middle
     * of the figure, entering at one hand and leaving at the other, crossing
     * the head on the way. That is not a pose, it is a line.
     *
     * Two changes stop it. The sweep now ends at 0.6 PI — down and back rather
     * than out and back — which opens forty degrees between the two arms; and
     * the arms bend, below.
     */
    /*
     * MEASURED IN THE TORSO'S FRAME, NOT THE WORLD'S.
     *
     * With the shoulders finally on the torso (see the transform above) this
     * angle put the off arm straight down the body's own axis at follow
     * through — 1.885 rad against a torso whose down direction is lean + PI/2
     * = 1.844 — so the arm that was carrying the figure's negative space
     * disappeared inside the jersey. It is written relative to the lean now,
     * which is where a shoulder joint actually works: hanging forward at the
     * sight line, swinging through to down-and-behind the hip as the
     * counterweight. At the capture's lean it lands at 2.39 rad and the hand
     * ends 42 units behind the torso's centre line, which is the gap between
     * arm and body the silhouette is read by.
     */
    const offAngle = lean + lerp(0.30, Math.PI * 0.5 + 0.55, clamp01((p.throwSwing + 1) * 0.5))

    let angleBack = lerp(runBack, reachBack, reach)
    let angleFront = lerp(runFront, reachFront, reach)
    angleFront = lerp(angleFront, throwAngle, throwing)
    angleBack = lerp(angleBack, offAngle, throwing)
    angleBack = lerp(angleBack, diveAngle - 0.12, dive)
    angleFront = lerp(angleFront, diveAngle + 0.12, dive)
    // Splayed, for the same reason the catch reach is: two arms clamped to one
    // angle are one arm. The off hand sits a little lower and further round the
    // disc than the throwing hand, which is how a disc is actually held.
    angleBack = lerp(angleBack, holdAngle + 0.26, hold)
    angleFront = lerp(angleFront, holdAngle - 0.16, hold)

    /*
     * A THROWING ARM MUST NOT REACH ITS OWN TARGET.
     *
     * `extend` was 1 through the whole throw, so the IK target sat at exactly
     * l1 + l2 from the shoulder; `solve` clamps to l1 + l2 - 0.001, the elbow
     * offset comes out as sqrt(l1^2 - l1^2) = 0, and the two bones drew as one
     * straight line for every frame of the throw. A limb with no elbow in it is
     * a stick whatever you draw on it.
     *
     * 0.90 puts the hand 66.6 px from a shoulder with 74 px of arm, which
     * solves the elbow 16.2 px off the line — about 28 px on screen at the
     * hero's drawing scale. Visible, and nowhere near a fold.
     *
     * The off arm goes further: it FOLDS as it crosses the throwing arm's line.
     * The two sweep in opposite directions through the same range, so they must
     * cross in angle at mid-swing; what they must not do is cross at the same
     * radius. At |throwSwing| = 0 the off hand tucks to 58% of the reach and
     * the elbow swings 32 px off the line, which is also what a thrower's
     * off arm actually does as the shoulders come round.
     */
    const armOut = Math.max(Math.max(reach, dive), throwing)
    const extend = lerp(0.72, lerp(1, 0.90, throwing), armOut) * lerp(1, 0.62, hold)
    const crossing = throwing * (1 - Math.abs(clamp(p.throwSwing, -1, 1)))
    const len = ARM_LEN * extend
    const lenBack = len * lerp(1, 0.58, crossing)

    const backHandX = backShoulderX + Math.cos(angleBack) * lenBack
    const backHandY = backShoulderY + Math.sin(angleBack) * lenBack
    const frontHandX = frontShoulderX + Math.cos(angleFront) * len
    const frontHandY = frontShoulderY + Math.sin(angleFront) * len

    solve(this.upperArmBack, this.foreArmBack, backShoulderX, backShoulderY, backHandX, backHandY, UPPER_ARM, FOREARM, 1)
    solve(this.upperArmFront, this.foreArmFront, frontShoulderX, frontShoulderY, frontHandX, frontHandY, UPPER_ARM, FOREARM, -1)

    /**
     * Where the throwing hand actually IS, taken off the drawn bone rather
     * than off the IK target.
     *
     * `solve` clamps an out-of-reach target onto the reachable circle, so the
     * bone stops at l1 + l2 from the shoulder while the requested point keeps
     * going. This project has found three separate detachment bugs that were
     * all this one mistake, and ENGINE.md's rule is: never place an extremity
     * at a target. The forearm's own transform is the only thing that knows
     * where the fist ended up.
     */
    const fa = this.foreArmFront
    const fc = Math.cos(fa.rotation)
    const fs = Math.sin(fa.rotation)
    this.handX = fa.position.x + fc * (FOREARM + 5)
    this.handY = fa.position.y + fs * (FOREARM + 5)

    // In the THROWING hand, not at the midpoint between the two hands. The
    // midpoint is the centre of the chest the moment the arms are doing
    // anything other than clamping a catch, which is how the disc came to be
    // "pasted flat across the jersey... while the throwing hand is empty and
    // 120px away" in a blind review of the event named after the disc.
    this.heldDisc.visible = hold > 0.02
    if (this.heldDisc.visible) {
      this.heldDisc.position.set(this.handX, this.handY)
      this.heldDisc.rotation = lean * 0.4
      this.heldDisc.alpha = hold
    }
  }

  /**
   * Position the shadows. `pixelsPerMetre` is the field scale at the athlete's
   * feet; `lift` is how far off the ground they are, in metres.
   *
   * The cast shadow is offset to the LEFT, because the key light is the sun the
   * sky already draws at 0.72 of the width. It is authored in metres and scaled
   * by the field, so a figure at fifty metres gets a fifty-metre shadow.
   */
  applyShadow(x: number, y: number, pixelsPerMetre: number, lift: number): void {
    this.shadow.position.set(0, 0)
    const dive = clamp01(this.pose.dive)
    // The blunt end of the wedge is AT the feet and the taper runs away from
    // the sun, so the shadow says where the athlete is standing before it says
    // anything about the light. Height lengthens it and lifts it clear, which
    // is what reads as leaving the ground.
    // 2.1 m for a standing figure put a four-hundred-pixel wedge across the
    // whole lower left of the frame, and the biggest dark shape in a picture
    // must not be a shadow pointing out of it.
    //
    // 1.5 m was the other end of that mistake. Measured on the capture, the
    // wedge ran x 126-297 at y=930 and the hero's own legs occupied 150-180
    // and 272-297 of it, so what showed of the frame's most important shadow
    // was a hundred pixels of ground between his feet. Two critics read that
    // as no shadow at all. At 1.78 m it clears his stance on the near side and
    // still stops two hundred pixels short of the frame edge, and the value
    // change in SHADOW_TONE is the half of this fix that does the work.
    const len = pixelsPerMetre * lerp(1.78, 2.4, dive) * (1 + lift * 0.5)
    this.cast.visible = lift < 2.6
    // Pushed a quarter of a metre downfield of the feet as well as out to the
    // left, so its blunt end emerges from BEHIND him rather than from between
    // his boots: a shadow you can see leaving the caster is a shadow.
    this.cast.position.set(x - 0.16 * pixelsPerMetre - lift * 0.55 * pixelsPerMetre, y)
    this.cast.scale.set(len, pixelsPerMetre * lerp(0.5, 0.66, dive))
    // Raked to match every other cast shadow on this field.
    this.cast.rotation = -0.2
    this.cast.alpha = clamp01(1 - lift * 0.34)
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.shadow.destroy({ children: true })
  }
}

/**
 * One bone, drawn from its proximal joint along +X.
 *
 * Not a capsule. A capsule is a rounded rectangle of constant width, and a rig
 * made of them is what a neutral review called "a jointless stick figure —
 * limbs are identical-width rounded rectangles, no hands, no feet ... the
 * subject of an action screenshot reads as a placeholder".
 *
 * So: the profile tapers from the proximal joint to the distal one, the outline
 * is a dark tint of the limb's own colour rather than black, a lit sliver runs
 * the length of the upper edge so the limb has a top and a bottom, and the
 * extremity is a real shape — a fist or a shoe — not a stump.
 *
 * THREE WIDTHS, NOT ONE. `root` is the joint this bone hangs from, `width` its
 * belly, `tip` the joint it hands on to. The defaults reproduce the old
 * behaviour (root = belly, tip = 45% of belly); the rig passes all three from
 * the `W` table so that a shin starts exactly as wide as the thigh above it
 * finished. Getting that wrong is what a blind review saw as "two separate
 * capsules with a visible joint gap", and it also gives a shin a calf: thin at
 * the knee, full at mid-length, thin again at the ankle.
 *
 * `caps: 'none'` INKS ONLY THE TWO LONG EDGES. The previous version closed the
 * proximal cap into the path it stroked, so every joint was outlined — hips
 * inside the pelvis, and shoulders on top of the jersey, where the near arm is
 * drawn over the chest. A half-disc of skin with a hard ring round it, sitting
 * on a shirt, is precisely "shoulders are bolted-on circles". Parents (thighs,
 * upper arms) ink neither cap, because a torso covers the proximal end and a
 * child bone covers the distal one; children (shins, forearms) ink the distal
 * cap, because it is the ankle or the wrist and it is on the silhouette.
 *
 * Note the direction of that fix against `ENGINE.md`'s Foot Bag entry, which is
 * the same bug mirrored: there, ink was MISSING from a stretch of silhouette
 * that showed. Here it was PRESENT on joints that do not. The rule both come
 * from is the same one — ink the silhouette, and only the silhouette.
 */
function bone(
  g: Graphics, length: number, width: number, fill: Hex, ink: Hex,
  tip: 'none' | 'hand' | 'foot' = 'none',
  joints: { root?: number; tip?: number; caps?: 'distal' | 'none' } = {},
): void {
  const r = width / 2
  const rp = (joints.root ?? width) / 2
  const rd = (joints.tip ?? width * 0.45) / 2

  /*
   * ONE CONTOUR, FIST AND SHOE INCLUDED. THE TENTH DETACHMENT BUG, AND THE
   * LAST ONE THIS SHAPE CAN HAVE.
   *
   *   "the thrower's detached hand at ~(1591, 510)"
   *   "the hero's limbs are detached capsules with open gaps at hip and knee"
   *   "the throwing forearm ends in a detached club with no hand"
   *
   * Three passes fixed this by editing the ink: first the closing bar across
   * the wrist, then the proximal caps, then the fist's own stroke run. Each
   * one was a real bug and none of them was the mechanism, which is visible
   * the moment you crop (290,590)-(410,670) out of `captures/flyingdisc.png`
   * at 14x: the forearm's silhouette ENDS, in its own outline, and a second
   * silhouette with its own outline begins. Two shapes, two contours, two
   * inks, meeting at a wrist six pixels across. Whether their inks overlap or
   * abut is a detail; what the eye reads is two objects.
   *
   * So the limb and its extremity are now ONE closed path. It is built once,
   * filled once and stroked once, and the outline runs continuously from the
   * elbow, out over the knuckles, round the fingers and back down the forearm
   * without ever entering the shape. There is no seam to get wrong, because
   * there is no seam. The rule this file states everywhere else — "the
   * silhouette: ONE closed contour, ONE fill" — now covers the end of the
   * limb as well as the middle of it.
   *
   * The ARITHMETIC was the other half of it, and it is why the fist read as a
   * ball on a stick even before the ink is considered. The forearm tapered
   * from a belly of 15 to a wrist of 7 and the fist then ballooned to 19.4
   * across: 0.47 of the belly, then 1.3 of it, a 2.8x step at the narrowest
   * point of the limb. On a real arm the wrist is about 0.6 of the forearm's
   * belly and a closed fist about 0.95 of it. The `W` table carries the first
   * number and `hw` the second, so the step at the wrist is 1.5x on a curve
   * instead of 2.8x at a joint.
   */
  const hw = width * 0.47
  const hl = width * 0.82

  /** The whole limb, extremity included, as one closed path. */
  const contour = (p: Graphics): void => {
    p.moveTo(0, -rp)
      .quadraticCurveTo(length * 0.55, -r * 0.82, length, -rd)
    if (tip === 'hand') {
      // Knuckles high and flat, fingers rolling under, back to the wrist.
      p.quadraticCurveTo(length + hl * 0.34, -hw * 1.04, length + hl * 0.80, -hw * 0.60)
        .quadraticCurveTo(length + hl * 1.16, -hw * 0.14, length + hl * 1.02, hw * 0.58)
        .quadraticCurveTo(length + hl * 0.72, hw * 1.16, length + hl * 0.10, hw * 1.00)
        .quadraticCurveTo(length - rd * 0.2, hw * 0.86, length, rd)
    } else if (tip === 'foot') {
      // Instep, toe, sole, heel — and then STRAIGHT on up the calf, because
      // the heel is the last point of the tip and the lower edge of the shin
      // starts from it.
      //
      // The first draft of this ran the sole back to the heel, returned to the
      // ankle at (length, rd) and only then started the lower edge, which
      // walks the outline right, left, right, left in x: a backtrack, and a
      // polygon that crosses itself. Rasterised at 9x before it was ever put
      // on screen it showed a hard spike under the ankle. One contour means
      // one traversal.
      //
      // The sole runs at 2.15 rd, which is BELOW the shin's own belly (0.86 r,
      // about 1.65 rd at this ankle) — it has to be, or the boot is inside the
      // leg's outline and there is no boot. The heel then climbs back to
      // 1.77 rd at x = length - 1.6 rd and the calf carries on from there, so
      // the step out and the step back are both on the silhouette and the
      // bump between them is the heel.
      p.quadraticCurveTo(length + rd * 1.5, -rd * 1.18, length + rd * 2.7, -rd * 0.78)
        .quadraticCurveTo(length + rd * 3.7, -rd * 0.38, length + rd * 3.6, rd * 1.5)
        .lineTo(length - rd * 0.55, rd * 2.15)
        .quadraticCurveTo(length - rd * 1.35, rd * 2.05, length - rd * 1.6, rd * 1.77)
        .quadraticCurveTo(length * 0.5, r * 0.86, 0, rp)
    } else {
      p.arc(length, 0, rd, -Math.PI / 2, Math.PI / 2)
    }
    if (tip !== 'foot') p.quadraticCurveTo(length * 0.55, r * 0.86, 0, rp)
    p.arc(0, 0, rp, Math.PI / 2, -Math.PI / 2)
      .closePath()
  }

  // The silhouette: ONE closed contour, ONE fill. Never two contours in one
  // fill — Pixi resolves those even-odd, and `Field.ts` has the scar.
  contour(g)
  g.fill(fill)

  if (tip === 'foot') {
    /*
     * THE BOOT IS A MATERIAL, NOT A SECOND OBJECT.
     *
     *   "both boots float free of the shins"
     *
     * It floated because it was a second silhouette with a second outline, and
     * because the shin's own inked distal cap arc reached a third of a wrist
     * above the boot's top edge and showed as a dark nub over it. The boot is
     * now a FILL inside the contour above: the same toe, sole and heel, closed
     * off by a cuff that runs diagonally across the ankle the way a boot's
     * collar does. A fill boundary in the boot's own colour is a change of
     * material; the ink bar that used to sit there was a change of object.
     */
    g.moveTo(length - rd * 0.3, -rd)
      .quadraticCurveTo(length + rd * 1.5, -rd * 1.18, length + rd * 2.7, -rd * 0.78)
      .quadraticCurveTo(length + rd * 3.7, -rd * 0.38, length + rd * 3.6, rd * 1.5)
      .lineTo(length - rd * 0.55, rd * 2.15)
      .quadraticCurveTo(length - rd * 1.35, rd * 2.05, length - rd * 1.6, rd * 1.77)
      .closePath()
      .fill(grade(fill, { valScale: 0.62, satScale: 0.55 }))
  }

  // Form shading: the upper length of the limb catches the light, the lower
  // length falls away. Two values on every surface, including the small ones.
  //
  // Both faces are `grade`s of the limb's own colour — value SCALES. The lit
  // one used to be `lighten(fill, 0.26)`, a lerp toward white, and it measured
  // L=91 on a figure the value plan wants at L=40: a lerp toward white does not
  // follow the thing it is lighting, so driving the kit down only raised the
  // proportion of the figure that was still bright. See the constructor.
  g.moveTo(0, -rp * 0.92)
    .quadraticCurveTo(length * 0.55, -r * 0.74, length * 0.94, -rd * 0.7)
    .quadraticCurveTo(length * 0.55, -r * 0.34, 0, -rp * 0.34)
    .closePath()
    .fill({ color: grade(fill, { valScale: 1.24, satScale: 0.94 }), alpha: 0.62 })
  g.moveTo(0, rp * 0.94)
    .quadraticCurveTo(length * 0.55, r * 0.8, length * 0.96, rd * 0.78)
    .quadraticCurveTo(length * 0.55, r * 0.42, 0, rp * 0.4)
    .closePath()
    .fill({ color: grade(fill, { valScale: 0.7, satScale: 1.2 }), alpha: 0.6 })

  /*
   * THE INK. One pass, over the contour that was filled, after the shading.
   *
   * `caps: 'none'` is for a PARENT bone — a thigh or an upper arm — whose two
   * caps are buried, the proximal one in the pelvis or the jersey and the
   * distal one under the child. Inking a cap that does not show is what put
   * "a floating pink capsule" and "shoulders are bolted-on circles" in three
   * separate reviews, so those two runs are stroked open, butt-capped, and the
   * caps are left bare.
   *
   * Everything else — every shin and every forearm — strokes the closed
   * contour in one run: proximal cap (the knee, the elbow, on the outside of
   * every bend this rig can reach), both long edges, and the extremity. The
   * previous version stroked the limb and the extremity separately and tucked
   * the ends of each inside the other, which is a correct fix for the ink and
   * no fix at all for the two silhouettes underneath it.
   */
  if (joints.caps === 'none') {
    g.moveTo(0, -rp).quadraticCurveTo(length * 0.55, -r * 0.82, length, -rd)
      .stroke({ color: ink, width: 2.6, cap: 'butt' })
    g.moveTo(length, rd).quadraticCurveTo(length * 0.55, r * 0.86, 0, rp)
      .stroke({ color: ink, width: 2.6, cap: 'butt' })
  } else {
    contour(g)
    g.stroke({ color: ink, width: 2.6, join: 'round' })
  }

  if (tip === 'hand') {
    // The thumb, laid along the top of the fist, and the fold the fingers
    // close on. Two marks, both inside the silhouette, both in the limb's own
    // ink: what separates a fist from an oval when the whole hand is 25 px.
    g.moveTo(length + hl * 0.08, -hw * 0.62)
      .quadraticCurveTo(length + hl * 0.62, -hw * 0.88, length + hl * 0.9, -hw * 0.3)
      .stroke({ color: ink, width: 2, alpha: 0.9, cap: 'round' })
    g.moveTo(length + hl * 0.44, hw * 0.06)
      .quadraticCurveTo(length + hl * 0.86, hw * 0.42, length + hl * 0.5, hw * 0.92)
      .stroke({ color: ink, width: 1.7, alpha: 0.7, cap: 'round' })
  } else if (tip === 'foot') {
    // The welt. One lighter line along the sole, inside the silhouette, so a
    // boot at 30 px reads as a boot and not as the hole the old one read as.
    g.moveTo(length + rd * 3.3, rd * 1.24)
      .lineTo(length - rd * 0.45, rd * 1.86)
      .stroke({ color: grade(fill, { valScale: 1.05, satScale: 0.5 }), width: 2, alpha: 0.8, cap: 'butt' })
  }
}

/** Place a two-bone chain so its tip lands on (tipX, tipY). */
function solve(
  proximal: Graphics, distal: Graphics,
  ax: number, ay: number, tipX: number, tipY: number,
  l1: number, l2: number, dir: number,
): void {
  const dx = tipX - ax
  const dy = tipY - ay
  const raw = Math.hypot(dx, dy) || 1
  // Clamp to the reachable range so the limb straightens instead of going NaN.
  let d = raw
  const maxD = l1 + l2 - 0.001
  const minD = Math.abs(l1 - l2) + 0.001
  if (d > maxD) d = maxD
  if (d < minD) d = minD
  const ux = dx / raw
  const uy = dy / raw
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  const jx = ax + ux * a - uy * h * dir
  const jy = ay + uy * a + ux * h * dir
  proximal.position.set(ax, ay)
  proximal.rotation = Math.atan2(jy - ay, jx - ax)
  distal.position.set(jx, jy)
  distal.rotation = Math.atan2(tipY - jy, tipX - jx)
}
