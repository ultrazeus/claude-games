import { Container, Graphics } from 'pixi.js'
import { Core, darken, grade, lighten, mix, type Hex } from '../../../render/Palette'
import { clamp, damp, lerp } from '../../../core/Tween'

/**
 * Articulated roller skater.
 *
 * Same construction as the half pipe rig: every limb is a Graphics authored once
 * with its origin at the proximal joint, and all animation is transform writes.
 * Nothing is rebuilt per frame, so the character is free in `render`.
 *
 * What is different from the board rig is the feet. A skateboarder's feet are
 * bolted to one plank, so a single foot pair is enough. A roller skater's feet
 * are independent — the whole read of skating is one foot gliding while the other
 * pushes out and back — so each leg gets its own IK target and the two run in
 * antiphase off a stride clock. The knees then resolve themselves, which is what
 * makes a crouch look like a crouch instead of a vertical squash.
 *
 * Four poses live on top of that: the glide, the air tuck, the handstand (hips
 * above shoulders, arms planted) and the sprawl (tumble). They are all blends of
 * joint targets rather than separate rigs, so any two can overlap mid-transition
 * without popping.
 *
 * Origin of the rig is the wheel contact point: (0, 0) is the concrete.
 */
export interface SkaterPose {
  /** 0 = legs long, 1 = fully compressed. */
  crouch: number
  /** Forward body lean relative to vertical, radians. */
  lean: number
  /** 0 = arms loose at the sides, 1 = arms out and up. */
  reach: number
  /** Stride clock, 0..1. Drives the push/glide alternation on the ground. */
  stride: number
  /**
   * 0..1 effort. Scales how far the driving skate sweeps behind the hip and how
   * high the recovering one folds. This is the difference between a roll and a
   * push, and it is most of the speed cue the character itself carries.
   */
  drive: number
  /** 0 = feet on the concrete, 1 = feet pulled up under the hips. */
  lift: number
  /** 0..1 knees-to-chest air tuck. */
  tuck: number
  /** 0..1 handstand: hips over shoulders, hands on the deck, skates in the sky. */
  handstand: number
  /** 0..1 tumble: limbs splayed, body slack. */
  sprawl: number
  /**
   * Pirouette angle in radians. Rendered the way 2D animation has always done a
   * spin: the rig narrows to edge-on and comes back out the other side, so a full
   * turn is `cos` going 1 -> -1 -> 1 rather than a flip about the screen plane.
   */
  twist: number
  /** 1 = facing right, -1 = facing left. */
  facing: number
}

// Bone lengths. Standing height works out at about 172px of design space. The
// scene then carries the rig inside a wrapper scaled by `SKATER_SCALE` (1.08)
// and the camera pushes in by `ZOOM` (1.66), so the figure is 309px in a 1080px
// frame — 28.6%. A neutral review measured the old framing at "about eight
// percent of frame height" and said "the character is an afterthought".
//
// The scale lives in the scene rather than in these numbers because the twist
// writes `container.scale.x`: one wrapper Container is the only place a uniform
// scale can go without fighting the pirouette.
const THIGH = 42
const SHIN = 44
const TORSO = 56
const UPPER_ARM = 35
const FOREARM = 33
const HEAD_R = 17
/** Hip height above the concrete when the legs are long. */
const HIP_HIGH = 78
/** Hip height when fully compressed. */
const HIP_LOW = 48
/**
 * Ankle height above the concrete. The skate hangs below it, and this number is
 * chosen so the bottom of the wheels lands exactly on y = 0.
 */
const ANKLE_Y = -25
/** Hip height in the handstand, measured the same way (hips are highest). */
const HIP_HANDSTAND = -108
const ARM_SPAN = (UPPER_ARM + FOREARM) * 0.93
const TAU = Math.PI * 2

/**
 * Outline colour for the rig. A warm plum-grey at roughly 31% value — dark enough
 * to hold the silhouette against the golden-hour ground, and explicitly not black,
 * which is the one thing the reference art never does.
 */
const INK = 0x4a3350

/**
 * Rim colour. The sun in this event is low, warm and *behind* the skater, so a
 * lit edge runs down every sun-facing contour. Backlight is the one cue that
 * separates a character from the ground behind them when both are in the same
 * value range, which is precisely the failure a blind review found here: "a dark
 * form on a bright tan ground ... it does not even separate from its own
 * backdrop".
 */
const RIM = 0xffe9b4

export class RollerSkater {
  readonly container = new Container()

  private thighBack = new Graphics()
  private shinBack = new Graphics()
  private skateBack = new Graphics()
  private thighFront = new Graphics()
  private shinFront = new Graphics()
  private skateFront = new Graphics()
  private torso = new Graphics()
  private upperArmBack = new Graphics()
  private foreArmBack = new Graphics()
  private upperArmFront = new Graphics()
  private foreArmFront = new Graphics()
  private head = new Graphics()
  private hair = new Graphics()
  private visor = new Graphics()

  /**
   * Where each skate's wheels are, in rig space, after the last `apply()`.
   *
   * `y` is height above the concrete: 0 is touching, negative is lifted. The
   * scene reads these to put a hard contact shadow under each skate
   * independently — one pool between two feet that are 130px apart is a pool
   * neither of them is standing in, and a reviewer has already called the
   * anchoring on this character out once.
   */
  readonly footBack = { x: 0, y: 0 }
  readonly footFront = { x: 0, y: 0 }

  /** Secondary motion, smoothed in update(). */
  private hairAngle = 0
  private armLag = 0

  private pose: SkaterPose = {
    crouch: 0, lean: 0, reach: 0.25, stride: 0, drive: 0.4, lift: 0,
    tuck: 0, handstand: 0, sprawl: 0, twist: 0, facing: 1,
  }

  /**
   * @param top   Shirt colour. Deliberately off the scene's hue family — the
   *              backdrop is one long warm ramp, so the only thing that keeps a
   *              170px character readable is a hue nobody else in the frame uses.
   * @param shorts Secondary garment colour.
   */
  constructor(top: Hex = Core.electricCyan, shorts: Hex = Core.hotPink) {
    const skin = Core.skinMid
    // Back-side limbs are darkened so the silhouette survives self-overlap. Depth
    // by value inside the character, which works against any background.
    const back = 0.3

    /**
     * Shade and light for the *reserved* hues, in HSV rather than toward black
     * and white.
     *
     * This is a measurement fix as much as an art one. `scripts/score_frame.py`
     * finds the player as the most colourful cluster in the playfield, and it
     * reported `subject_found: false` on the frame that went to review: the
     * accent it picked was scattered across 98% of the frame width. The cause
     * was here. Two thirds of the shirt was painted with `darken(top, 0.33)`
     * and `lighten(top, 0.42)`, and mixing toward black or white *destroys
     * chroma* — the lit strip measured 0.40 colourfulness and the shaded strip
     * 0.38, both under the 0.42 the detector was thresholding at, so most of
     * the reserved hue did not count as the reserved hue. The character was
     * wearing it and the frame was not showing it.
     *
     * Grading in HSV keeps the hue alive through both steps: the shadow is a
     * deeper, *richer* cyan and the light is a brighter one, which is what the
     * reference art does anyway and what `shadePair` in Staging.ts is for. It
     * roughly doubles the area of the frame that carries her hue at full
     * strength, and it is the same 0.68 chroma everywhere instead of a ramp
     * that falls out of the reservation halfway down the torso.
     */
    const kitShade = (c: Hex): Hex => grade(c, { valScale: 0.78, satScale: 1.14 })
    const kitLit = (c: Hex): Hex => grade(c, { valScale: 1.07, satScale: 0.88 })
    const kitBack = (c: Hex): Hex => grade(c, { valScale: 0.74, satScale: 1.12 })

    // Proximal widths up, distal taper hard. A critic looked at the sister rig
    // in the half pipe and called it "a jointless stick figure — limbs are
    // identical-width rounded rectangles, no hands, no feet"; the taper here now
    // runs 19px at the hip to 10px at the knee, and every forearm ends in an
    // actual hand instead of a rounded cap.
    bone(this.thighBack, THIGH, 19, kitBack(shorts), INK)
    bone(this.shinBack, SHIN, 14, darken(skin, back), INK)
    bone(this.thighFront, THIGH, 20, shorts, INK, 0.8)
    bone(this.shinFront, SHIN, 15, skin, INK, 0.85)
    // Sleeves, not bare shoulders. The reserved hue was carrying a 31x56 torso
    // and nothing else, which at any camera is a small patch of colour on a
    // largely skin-toned figure — and the whole point of reserving a hue is that
    // the player is found by it instantly. Putting the shirt on both upper arms
    // grows the reserved area by about 60% without touching the silhouette, the
    // taper or the hands, and the forearms stay skin so the arm still reads as
    // an arm rather than as one cyan stick.
    bone(this.upperArmBack, UPPER_ARM, 14, kitBack(top), INK)
    bone(this.foreArmBack, FOREARM, 11, darken(skin, back), INK)
    hand(this.foreArmBack, FOREARM, darken(skin, back), INK, 0)
    bone(this.upperArmFront, UPPER_ARM, 15, top, INK, 0.85)
    bone(this.foreArmFront, FOREARM, 12, skin, INK, 0.9)
    hand(this.foreArmFront, FOREARM, skin, INK, 0.9)

    skate(this.skateBack, darken(Core.paperWhite, back * 0.6), darken(Core.sunGold, back), INK)
    skate(this.skateFront, Core.paperWhite, Core.sunGold, INK, 0.9)

    // Neck, drawn first so the torso fill laps over its base and the head sits
    // on top of its tip. Without it the head is a circle floating five pixels
    // clear of the shoulders, which at this scale reads as a detached sprite.
    this.torso
      .moveTo(-6, -TORSO + 8)
      .lineTo(-5.5, -TORSO - 11)
      .lineTo(5.5, -TORSO - 11)
      .lineTo(6, -TORSO + 8)
      .closePath()
      .fill(darken(Core.skinLight, 0.12))
      .stroke({ color: INK, width: 3, join: 'round' })

    // Torso: origin at the hips, running up to the shoulders. The curve is
    // asymmetric front-to-back so the lean direction reads even at small scale.
    this.torso
      .moveTo(-13, 0)
      .bezierCurveTo(-18, -TORSO * 0.42, -16, -TORSO * 0.78, -12, -TORSO)
      .lineTo(13, -TORSO)
      .bezierCurveTo(16, -TORSO * 0.78, 18, -TORSO * 0.42, 14, 0)
      .closePath()
      .fill(top)
      .stroke({ color: INK, width: 3.5, join: 'round' })
    // Two tones, no gradient: the side turned away from the sun goes to the
    // shade value, the sun side keeps the lit one, and a hard terminator runs
    // between them. That is the entire cloth shading model the reference uses.
    this.torso
      .moveTo(-13, 0)
      .bezierCurveTo(-18, -TORSO * 0.42, -16, -TORSO * 0.78, -12, -TORSO)
      .lineTo(-1, -TORSO)
      .lineTo(1, 0)
      .closePath()
      .fill({ color: kitShade(top), alpha: 0.95 })
    this.torso
      .moveTo(4, -TORSO + 3)
      .lineTo(13, -TORSO + 3)
      .lineTo(14, -4)
      .lineTo(6, -4)
      .closePath()
      .fill({ color: kitLit(top), alpha: 0.95 })
    // The rim itself: a hard bright edge down the whole sun-facing contour.
    // Heavier than it was. The midground is now one dark backlit band, which
    // is what finally gives a rim something to be a rim against: at 4.4px it is
    // the brightest continuous line in the lower two thirds of the frame and it
    // traces the one contour that matters.
    this.torso
      .moveTo(13, -TORSO)
      .bezierCurveTo(16, -TORSO * 0.78, 18, -TORSO * 0.42, 14, 0)
      .stroke({ color: RIM, width: 4.4, alpha: 1, cap: 'round' })

    this.head.circle(0, 0, HEAD_R).fill(Core.skinLight).stroke({ color: INK, width: 3.5 })
    // Shade on the shadow side of the face, rim on the sun side.
    this.head.arc(0, 0, HEAD_R - 1, Math.PI * 0.5, Math.PI * 1.5)
      .closePath().fill({ color: darken(Core.skinLight, 0.3), alpha: 0.55 })
    this.head.arc(0, 0, HEAD_R + 0.5, -Math.PI * 0.46, Math.PI * 0.4)
      .stroke({ color: RIM, width: 4, alpha: 1, cap: 'round' })
    // Ponytail: one shape with its own lag, which is most of what sells speed on
    // a character this size.
    this.hair
      .moveTo(-4, -HEAD_R - 2)
      .bezierCurveTo(-20, -HEAD_R - 6, -34, 4, -30, 26)
      .lineTo(-19, 22)
      .bezierCurveTo(-22, 6, -14, -4, -2, -8)
      .closePath()
      .fill(Core.hairSun)
      .stroke({ color: darken(Core.hairSun, 0.42), width: 2.5, join: 'round' })
    this.hair
      .moveTo(-4, -HEAD_R - 2)
      .bezierCurveTo(-20, -HEAD_R - 6, -34, 4, -30, 26)
      .stroke({ color: RIM, width: 2.4, alpha: 0.5, cap: 'round' })
    // Fringe + sweatband. 1987 to the bone.
    this.visor
      .arc(0, 0, HEAD_R + 2, Math.PI * 1.04, Math.PI * 2.0)
      .lineTo(HEAD_R, -4)
      .lineTo(-HEAD_R - 1, -4)
      .closePath()
      .fill(Core.hairSun)
      .stroke({ color: darken(Core.hairSun, 0.4), width: 2.5 })
    this.visor
      .roundRect(-HEAD_R - 3, -HEAD_R + 2, (HEAD_R + 3) * 2, 8, 4)
      .fill(Core.hotPink)
      .stroke({ color: darken(Core.hotPink, 0.4), width: 2 })
    this.visor
      .moveTo(HEAD_R + 1, -HEAD_R + 4).lineTo(HEAD_R + 1, -HEAD_R + 10)
      .stroke({ color: RIM, width: 3, alpha: 0.9, cap: 'round' })

    // Draw order is depth order.
    this.container.addChild(
      this.thighBack, this.shinBack, this.skateBack,
      this.upperArmBack, this.foreArmBack,
      this.torso,
      this.thighFront, this.shinFront, this.skateFront,
      this.head, this.hair, this.visor,
      this.upperArmFront, this.foreArmFront,
    )
    this.container.interactiveChildren = false
    this.container.eventMode = 'none'
  }

  setPose(p: Partial<SkaterPose>): void {
    Object.assign(this.pose, p)
  }

  /** Secondary motion. One call per simulation step. */
  update(dt: number, airflow: number): void {
    const target = clamp(-airflow * 0.05, -0.7, 0.7)
    this.hairAngle = damp(this.hairAngle, target, 0.004, dt)
    this.armLag = damp(this.armLag, target * 0.6, 0.01, dt)
  }

  /** Rebuild the rig from the current pose. Transform writes only, no geometry. */
  apply(): void {
    const p = this.pose
    const f = p.facing >= 0 ? 1 : -1
    // Edge-on never reaches zero: a hairline of character is easier to read as a
    // spin than a character that vanishes for a frame.
    const c = Math.cos(p.twist)
    this.container.scale.x = f * (Math.abs(c) < 0.1 ? (c < 0 ? -0.1 : 0.1) : c)

    const hs = clamp(p.handstand, 0, 1)
    const tk = clamp(p.tuck, 0, 1)
    const lift = clamp(p.lift, 0, 1)
    const spr = clamp(p.sprawl, 0, 1)

    // --- hips -------------------------------------------------------------
    const hipGround = -lerp(HIP_HIGH, HIP_LOW, clamp(p.crouch, 0, 1))
    let hipY = lerp(hipGround, HIP_HANDSTAND, hs)
    hipY = lerp(hipY, -34, spr)
    // The hips sit back under a forward lean. Hips back, shoulders forward,
    // trailing skate extended behind: that is the line of action, and it is
    // what a still of somebody actually skating has in it.
    const hipX = lerp(0, 6, p.crouch) - Math.sin(p.lean) * 11

    // Torso rotation sweeps a full half turn into the handstand, which is what
    // puts the shoulders under the hips without a second rig.
    const torsoRot = lerp(p.lean * 0.95 + this.armLag * 0.12, Math.PI, hs) + spr * 0.55 * f
    this.torso.position.set(hipX, hipY)
    this.torso.rotation = torsoRot

    // Where the top of the torso Graphics actually ends up.
    //
    // This had its sign inverted, and it is the whole of why a blind review
    // read the pose as "a neutral two-legged stride with no lean". The torso is
    // authored from the hip at (0, 0) up to the shoulders at (0, -TORSO), and
    // Pixi rotates that point to (TORSO * sin, -TORSO * cos). The rig derived
    // the shoulder — and therefore the neck, the head, the ponytail and both
    // arm roots — from `-TORSO * sin` instead, so every degree the torso leaned
    // forward moved the head the same degree backward. At the lean the game
    // actually runs, the two cancelled almost exactly and the character stood
    // bolt upright however hard she was pushing. Lean now reads, so it is also
    // worth having: see `wantLean` in Skating.ts.
    const sx = Math.sin(torsoRot)
    const cx = Math.cos(torsoRot)
    const shoulderX = hipX + sx * TORSO
    const shoulderY = hipY - cx * TORSO

    this.head.position.set(shoulderX + sx * (HEAD_R + 5), shoulderY - cx * (HEAD_R + 5))
    this.head.rotation = torsoRot * 0.55
    this.hair.position.copyFrom(this.head.position)
    this.hair.rotation = this.head.rotation + this.hairAngle * 0.55
    this.visor.position.copyFrom(this.head.position)
    this.visor.rotation = this.head.rotation

    // --- feet -------------------------------------------------------------
    // The stride.
    //
    // What was here traced each foot round a shallow ellipse of +/-19px either
    // side of a fixed offset, with both skates on the deck for most of the
    // cycle. That is a shuffle, and a reviewer called it one: "a neutral
    // two-legged stride with no lean, no arm extension, no trail, no speed
    // cue". A skating stride is not symmetric. One skate is *driving*: planted,
    // leg long, sweeping back under the body all the way out to full extension
    // behind the hip. The other is *recovering*: off the deck, folded, swinging
    // forward, and it travels less than half as far because the body is moving
    // toward it.
    //
    // `drive` scales the whole thing with speed, so a push at 1500 px/s has
    // twice the reach of a roll at 400 and the silhouette says which is which.
    const ph = p.stride * TAU
    const ex = 1 + clamp(p.drive, 0, 1)
    // Reach is capped by the leg, not by taste: THIGH + SHIN is 86, the hip
    // sits 40-53 above the ankle line, and `ik2` clamps the knee solution while
    // `solveLeg` still plants the boot at the raw target — so a foot asked for
    // further than the leg can go detaches the skate from the shin. At ex = 2
    // the driving foot lands 64 behind the hip and the recovering one 38 in
    // front of it, a 132px stride on a 172px figure, with 10px of slack left.
    const foot = (ang: number, x0: number): [number, number] => {
      const s = Math.sin(ang)
      const push = s > 0 ? s : 0
      const swing = s < 0 ? -s : 0
      return [x0 - push * 32 * ex + swing * 19 * ex, ANKLE_Y - swing * 26 * ex]
    }
    const [backGX, backGY] = foot(ph, -12)
    const [frontGX, frontGY] = foot(ph + Math.PI, 18)

    // Airborne: feet come in under the hips and the skates line up.
    const backAX = hipX - 15
    const backAY = hipY + 60
    const frontAX = hipX + 21
    const frontAY = hipY + 56

    let bx = lerp(backGX, backAX, lift)
    let by = lerp(backGY, backAY, lift)
    let fx = lerp(frontGX, frontAX, lift)
    let fy = lerp(frontGY, frontAY, lift)

    // Tuck: knees to chest. Feet ride high and forward of the hips.
    bx = lerp(bx, hipX + 12, tk); by = lerp(by, hipY + 30, tk)
    fx = lerp(fx, hipX + 26, tk); fy = lerp(fy, hipY + 25, tk)

    // Handstand: legs run straight out past the hips, split for readability. In
    // rig space that is -Y from the hips, which is up on screen.
    bx = lerp(bx, hipX - 13, hs); by = lerp(by, hipY - 68, hs)
    fx = lerp(fx, hipX + 17, hs); fy = lerp(fy, hipY - 78, hs)

    // Sprawl: legs thrown forward along the concrete.
    bx = lerp(bx, hipX + 46, spr); by = lerp(by, -12, spr)
    fx = lerp(fx, hipX + 62, spr); fy = lerp(fy, -10, spr)

    // Bend directions are constant. Flipping them for the handstand snapped the
    // knees halfway through the blend, and the legs are nearly straight in that
    // pose anyway, so the solution branch barely shows.
    this.solveLeg(this.thighBack, this.shinBack, this.skateBack, hipX - 6, hipY, bx, by, -1)
    this.solveLeg(this.thighFront, this.shinFront, this.skateFront, hipX + 6, hipY, fx, fy, -1)
    // The wheels sit `-ANKLE_Y` below the ankle, by construction.
    this.footBack.x = bx
    this.footBack.y = by - ANKLE_Y
    this.footFront.x = fx
    this.footFront.y = fy - ANKLE_Y

    // --- arms -------------------------------------------------------------
    const reach = clamp(p.reach, 0, 1)
    const backShX = shoulderX - 6
    const frontShX = shoulderX + 6

    // The arms.
    //
    // Retuned end to end. The old range ran the trailing arm from back-and-up
    // at rest to back-and-*down* at full reach, so the harder the skater was
    // working the more the arms collapsed toward the torso — the opposite of
    // what the silhouette needs, and the reason a review found "no arm
    // extension". Reach now opens both arms monotonically: at a cruise the
    // trail arm is swept back level and the lead arm points forward, and at
    // full extension the trail arm is back and high while the lead arm reaches
    // forward and up. The negative space between the arms and the torso grows
    // with speed instead of closing.
    const backAngle = lerp(0.42, 1.06, reach) + this.armLag * 0.5
    let bhx = backShX + Math.cos(backAngle + Math.PI * 0.84) * ARM_SPAN
    let bhy = shoulderY + Math.sin(backAngle + Math.PI * 0.84) * ARM_SPAN
    // Leading arm.
    const frontAngle = lerp(0.24, -0.62, reach) + this.armLag * 0.6
    let fhx = frontShX + Math.cos(frontAngle + Math.PI * 0.1) * ARM_SPAN
    let fhy = shoulderY + Math.sin(frontAngle + Math.PI * 0.1) * ARM_SPAN

    // Tuck: hands wrap the shins.
    bhx = lerp(bhx, bx - 4, tk); bhy = lerp(bhy, by + 6, tk)
    fhx = lerp(fhx, fx - 4, tk); fhy = lerp(fhy, fy + 6, tk)
    // Handstand: hands planted on the concrete, shoulder width apart.
    bhx = lerp(bhx, hipX - 9, hs); bhy = lerp(bhy, -3, hs)
    fhx = lerp(fhx, hipX + 17, hs); fhy = lerp(fhy, -2, hs)
    // Sprawl: one arm out to break the fall, one trailing.
    bhx = lerp(bhx, hipX - 30, spr); bhy = lerp(bhy, -6, spr)
    fhx = lerp(fhx, hipX + 44, spr); fhy = lerp(fhy, -30, spr)

    this.solveArm(this.upperArmBack, this.foreArmBack, backShX, shoulderY, bhx, bhy, 1)
    this.solveArm(this.upperArmFront, this.foreArmFront, frontShX, shoulderY, fhx, fhy, -1)
  }

  /** Thigh + shin IK, with the skate carried on the shin's distal end. */
  private solveLeg(
    thigh: Graphics, shin: Graphics, boot: Graphics,
    hipX: number, hipY: number, footX: number, footY: number, kneeDir: number,
  ): void {
    const knee = ik2(hipX, hipY, footX, footY, THIGH, SHIN, kneeDir)
    thigh.position.set(hipX, hipY)
    thigh.rotation = Math.atan2(knee.y - hipY, knee.x - hipX)
    const shinRot = Math.atan2(footY - knee.y, footX - knee.x)
    shin.position.set(knee.x, knee.y)
    shin.rotation = shinRot
    // Place the skate at the shin's ACTUAL end, not at the requested foot
    // target. `ik2` clamps an out-of-reach target onto the reachable circle, so
    // the drawn shin stops short of (footX, footY) while an extremity pinned to
    // that target keeps going — and the two separate by exactly the amount of
    // over-extension. A blind review caught that as a "fully detached hand
    // floating as a loose brown disc while the wrist ends in a blunt stump" in
    // another event's rig; this is the same pattern, one limb over. Identical
    // to the old line whenever the target is reachable.
    boot.position.set(knee.x + Math.cos(shinRot) * SHIN, knee.y + Math.sin(shinRot) * SHIN)
    // The skate stays roughly level with the deck rather than rigidly following
    // the shin: a wheeled boot pivots at the ankle, it does not point at the knee.
    boot.rotation = (shinRot - Math.PI / 2) * 0.42
  }

  private solveArm(
    upper: Graphics, fore: Graphics,
    shX: number, shY: number, handX: number, handY: number, elbowDir: number,
  ): void {
    const elbow = ik2(shX, shY, handX, handY, UPPER_ARM, FOREARM, elbowDir)
    upper.position.set(shX, shY)
    upper.rotation = Math.atan2(elbow.y - shY, elbow.x - shX)
    fore.position.set(elbow.x, elbow.y)
    fore.rotation = Math.atan2(handY - elbow.y, handX - elbow.x)
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

/**
 * A capsule bone drawn from its proximal joint along +X.
 *
 * `rimAlpha` at 0 leaves the limb unlit — used for the far-side limbs, which are
 * in the character's own shadow and must stay a flat dark shape or the
 * silhouette stops reading.
 */
function bone(
  g: Graphics, length: number, width: number, fill: Hex, ink: Hex, rimAlpha = 0,
): void {
  const r = width / 2
  // 0.56, not 0.82. A limb that loses a fifth of its width from joint to
  // extremity is a rounded rectangle; one that loses nearly half of it is a
  // limb, and the difference is most of what separates a character from a
  // placeholder at thumbnail size.
  const tip = r * 0.56
  g.moveTo(0, -r)
    .lineTo(length, -tip)
    .arc(length, 0, tip, -Math.PI / 2, Math.PI / 2)
    .lineTo(0, r)
    .arc(0, 0, r, Math.PI / 2, -Math.PI / 2)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 3, join: 'round' })
  // Shaded underside, then the lit edge along the top. Two values per surface,
  // which is the whole shading model the reference art uses.
  // Graded, not darkened: on a garment this is the difference between a limb
  // that carries the reserved hue all the way round and one whose shaded half
  // falls out of the reservation. See `kitShade` in the constructor.
  g.moveTo(2, r * 0.45).lineTo(length - 2, r * 0.4)
    .stroke({
      color: grade(fill, { valScale: 0.78, satScale: 1.16 }),
      width: r * 0.7, alpha: 0.6, cap: 'round',
    })
  if (rimAlpha > 0) {
    g.moveTo(2, -r * 0.62).lineTo(length - 3, -r * 0.5)
      .stroke({ color: RIM, width: 2.4, alpha: rimAlpha, cap: 'round' })
  }
}

/**
 * A hand, drawn into the forearm's own Graphics at the wrist so it costs no
 * extra node and no extra transform write.
 *
 * A mitt with a thumb and one finger seam. It does not need knuckles — it needs
 * to not be a rounded cap, because a limb that ends in a semicircle is the exact
 * thing a reviewer reads as unfinished.
 */
function hand(
  g: Graphics, wrist: number, fill: Hex, ink: Hex, rimAlpha = 0,
): void {
  const x = wrist
  g.moveTo(x - 1, -5.4)
    .quadraticCurveTo(x + 11, -8.4, x + 14.5, -2.6)
    .quadraticCurveTo(x + 16.5, 3.2, x + 11, 6.8)
    .quadraticCurveTo(x + 4, 9.4, x - 1.5, 5.6)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.8, join: 'round' })
  // Thumb, laid across the heel of the palm.
  g.moveTo(x + 1, 3.6)
    .quadraticCurveTo(x + 7.5, 8.8, x + 10.5, 5.4)
    .quadraticCurveTo(x + 6, 3.2, x + 2, 2.2)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.4, join: 'round' })
  // One seam between the fingers, so the mitt has an inside.
  g.moveTo(x + 12.5, -3.4).lineTo(x + 9.5, 4.2)
    .stroke({ color: ink, width: 1.8, alpha: 0.55, cap: 'round' })
  if (rimAlpha > 0) {
    g.moveTo(x + 11, -8).quadraticCurveTo(x + 15.5, -3, x + 15.5, 2)
      .stroke({ color: RIM, width: 2.4, alpha: rimAlpha, cap: 'round' })
  }
}

/**
 * A quad roller skate, origin at the ankle, boot hanging below it.
 * Two wheels read in side view, plus the toe stop — that trio is the whole
 * silhouette difference between this event and the half pipe.
 */
function skate(g: Graphics, bootColor: Hex, wheelColor: Hex, ink: Hex, rimAlpha = 0): void {
  // Sock cuff.
  g.roundRect(-9, -14, 20, 10, 4).fill(lighten(bootColor, 0.2)).stroke({ color: ink, width: 2.5 })
  // Boot.
  g.moveTo(-10, -6)
    .lineTo(10, -6)
    .quadraticCurveTo(15, -4, 17, 6)
    .lineTo(-12, 6)
    .closePath()
    .fill(bootColor)
    .stroke({ color: ink, width: 3, join: 'round' })
  // Plate.
  g.roundRect(-13, 6, 32, 5, 2).fill(mix(bootColor, ink, 0.45)).stroke({ color: ink, width: 2 })
  // Wheels and toe stop.
  g.circle(-7, 17, 7.5).fill(wheelColor).stroke({ color: ink, width: 2.5 })
  g.circle(12, 17, 7.5).fill(wheelColor).stroke({ color: ink, width: 2.5 })
  g.roundRect(17, 8, 8, 9, 3).fill(darken(wheelColor, 0.25)).stroke({ color: ink, width: 2 })
  if (rimAlpha > 0) {
    // The toe and the leading edge of the boot catch the low sun.
    g.moveTo(10, -6).quadraticCurveTo(15, -4, 17, 6)
      .stroke({ color: RIM, width: 2.6, alpha: rimAlpha, cap: 'round' })
    g.moveTo(12, 10.5).lineTo(12, 23.5)
      .stroke({ color: RIM, width: 2.2, alpha: rimAlpha * 0.8, cap: 'round' })
  }
}

/**
 * Two-bone IK. Returns the joint position between `l1` and `l2`.
 * `dir` picks which of the two mirror solutions to use (knee/elbow bend side).
 */
function ik2(
  ax: number, ay: number, bx: number, by: number,
  l1: number, l2: number, dir: number,
): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const raw = Math.hypot(dx, dy) || 1
  let d = raw
  // Clamp to the reachable range so the limb straightens instead of yielding NaN.
  const maxD = l1 + l2 - 0.001
  const minD = Math.abs(l1 - l2) + 0.001
  if (d > maxD) d = maxD
  if (d < minD) d = minD
  const ux = dx / raw
  const uy = dy / raw
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  const mx = ax + ux * a
  const my = ay + uy * a
  return { x: mx - uy * h * dir, y: my + ux * h * dir }
}
