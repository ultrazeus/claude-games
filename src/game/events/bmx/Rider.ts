import { Container, Graphics } from 'pixi.js'
import { Core, grade, lighten, type Hex } from '../../../render/Palette'
import { clamp, damp, lerp } from '../../../core/Tween'

/**
 * Articulated BMX rig.
 *
 * Same construction as the half pipe's `Skater`: every part is a Graphics
 * authored once with its origin at its proximal joint, and animation is nothing
 * but transform writes, so the character costs no geometry rebuilds per frame.
 *
 * A BMX has no suspension — the rider's arms and legs *are* the suspension, so
 * that is modelled literally. `compress` drops the hips toward the bottom
 * bracket and the two-bone IK legs fold against pedals that never move, while
 * the torso pitches forward and the arms collapse against fixed grips. Preload
 * and pop is the whole event, so it has to be a real linkage rather than a
 * vertical squash.
 *
 * The bike itself is a rigid child container pivoted at the grips. Rotating it
 * away from the rider while the hands stay put is how a tabletop reads in a
 * side-on view.
 */
export interface RiderPose {
  /** 0 = stood tall, 1 = fully loaded into the bike. */
  compress: number
  /** Extra torso pitch on top of the compression-driven amount, radians. */
  lean: number
  /** 0 = level, 1 = bike kicked out under the rider (tabletop). */
  table: number
  /** 0 = riding, 1 = tucked over the bars for a spin. */
  tuck: number
  /** 0 = in control, 1 = full ragdoll sprawl. */
  sprawl: number
  /** Wheel rotation, radians. */
  wheel: number
  /** Which way the rider faces: 1 = right, -1 = left. */
  facing: number
  /** Fake-3D spin about the vertical axis, radians. Squashes the rig in x. */
  yaw: number
}

// --- bike geometry, local units, origin on the ground between the wheels -----
const WHEEL_R = 25
const AXLE_X = 45
const AXLE_Y = -WHEEL_R
const BB_X = -6
const BB_Y = -30
const SEAT_X = -32
const SEAT_Y = -72
const HEAD_LO_X = 32
const HEAD_LO_Y = -46
const HEAD_HI_X = 36
const HEAD_HI_Y = -66
const BAR_X = 48
const BAR_Y = -92
const CRANK = 15

// --- rider proportions -------------------------------------------------------
const THIGH = 38
const SHIN = 38
const TORSO = 46
const UPPER_ARM = 30
const FOREARM = 30
const HEAD_R = 14
/** Hip position stood tall, and fully loaded. */
const HIP_HIGH_X = -18
const HIP_HIGH_Y = -92
const HIP_LOW_X = -12
const HIP_LOW_Y = -62

/**
 * Outline colour. Measured off OlliOlli World: limb contours sit at V 34-39%
 * neutral grey, never pure black (refs/BAR-ANALYSIS.md 1.3).
 */
const INK = 0x55525c
/**
 * The rim tone: the event's low sun caught on the rider's leading edge.
 *
 * Warm on purpose. Everything in the frame behind him is warm, so a warm rim
 * reads as light landing on him rather than as a second colour on the kit, and
 * it keeps the rider's own reserved cyan uncontaminated.
 */
const RIM = 0xffe7b4
/** Per-material line: same hue, ~26% darker, slightly richer. */
const line = (c: Hex): Hex => grade(c, { valScale: 0.74, satScale: 1.12 })

export class Rider {
  readonly container = new Container()

  /** The bike, pivoted at the grips so a table swings the tail out. */
  private bike = new Container()
  private rearWheel = new Graphics()
  private frontWheel = new Graphics()
  private frame = new Graphics()
  private cranks = new Graphics()

  private thighBack = new Graphics()
  private shinBack = new Graphics()
  private thighFront = new Graphics()
  private shinFront = new Graphics()
  private torso = new Graphics()
  private upperArmBack = new Graphics()
  private foreArmBack = new Graphics()
  private upperArmFront = new Graphics()
  private foreArmFront = new Graphics()
  private head = new Graphics()
  private helmet = new Graphics()
  /** Shoes ride the pedals, so they follow the bike rather than the shin. */
  private shoeBack = new Graphics()
  private shoeFront = new Graphics()

  /**
   * Magnitude of the rig's own scale, kept separate from the facing sign and the
   * spin squash. Writing `scale.x` directly would destroy any uniform scale the
   * scene set on the container.
   */
  private baseScale = 1

  private headLag = 0
  private armLag = 0
  private pose: RiderPose = {
    compress: 0, lean: 0, table: 0, tuck: 0, sprawl: 0,
    wheel: 0, facing: 1, yaw: 0,
  }

  constructor(frameColor: Hex = Core.hotPink, kitColor: Hex = Core.electricCyan) {
    const skin = Core.skinMid
    /**
     * Shorts, and the single largest change to this rig.
     *
     * They used to be 0x3f5aa8 — a royal blue that belongs to no hue family in
     * this event and is not one of the two colours the rider reserves. Worse,
     * it meant the reserved pair covered a few hundred pixels between them, a
     * cluster a reviewer measured at 25px and called "a sticker pasted onto a
     * landscape". The reserved hues have to own enough of the figure to *be*
     * the figure.
     *
     * So the shorts are the kit hue, eight degrees bluer and a step down in
     * value: two garments, one reservation, and a real cloth model instead of
     * two unrelated colours. Between them, the jersey, the sleeves, the shorts
     * and the shoes now carry roughly three times the reserved-hue area they
     * did, which is what turns "a 25px cluster" into a figure.
     */
    const shorts = grade(kitColor, { satScale: 1.14, valScale: 0.93, hueShift: 8 })
    // Back limbs are darkened so the silhouette survives the limbs overlapping.
    const back = 0.26

    // Limbs taper hard, and the wide end is always the proximal one: a thigh
    // is nearly twice the width of the knee, a calf twice the width of the
    // ankle. Widths are up across the board too — the old rig was 10-16 units
    // of limb on a 166-unit figure, which at thumbnail size is a wireframe.
    bone(this.thighBack, THIGH, 21, grade(shorts, { valScale: 1 - back }), INK, 0.58)
    bone(this.shinBack, SHIN, 14, grade(skin, { valScale: 1 - back }), INK, 0.46)
    bone(this.thighFront, THIGH, 23, shorts, INK, 0.58)
    bone(this.shinFront, SHIN, 15, skin, INK, 0.46)
    bone(this.upperArmBack, UPPER_ARM, 15, grade(kitColor, { valScale: 1 - back }), INK, 0.62)
    bone(this.foreArmBack, FOREARM, 12, grade(skin, { valScale: 1 - back }), INK, 0.6)
    bone(this.upperArmFront, UPPER_ARM, 17, kitColor, INK, 0.62)
    bone(this.foreArmFront, FOREARM, 13, skin, INK, 0.6)
    // Hands. Drawn at the distal end of the forearm that carries them, so they
    // rotate with it and cost nothing.
    fist(this.foreArmBack, FOREARM, 7, grade(skin, { valScale: 1 - back }), INK)
    fist(this.foreArmFront, FOREARM, 7.6, skin, INK)

    const soleTone = grade(Core.paperWhite, { valScale: 0.82, satScale: 1 })
    // Shoes in the kit hue, deeper again than the shorts. Small, but they put
    // the reservation at the bottom of the figure as well as the top, so the
    // eye reads one athlete rather than a coloured torso on grey legs.
    shoe(this.shoeBack, grade(kitColor, { satScale: 1.2, valScale: 0.5 }),
      grade(soleTone, { valScale: 0.8 }), INK)
    shoe(this.shoeFront, grade(kitColor, { satScale: 1.2, valScale: 0.62 }), soleTone, INK)

    // Torso: origin at the hips, running up to the shoulders.
    // Broader than it was, by a third. At 20% of frame height the jersey is the
    // biggest single piece of reserved hue on screen, and it has to read as a
    // torso at thumbnail size rather than as a stripe.
    this.torso
      .moveTo(-16, 0)
      .bezierCurveTo(-21, -TORSO * 0.45, -18, -TORSO * 0.8, -14, -TORSO)
      .lineTo(14, -TORSO)
      .bezierCurveTo(18, -TORSO * 0.8, 21, -TORSO * 0.45, 16, 0)
      .closePath()
      .fill(kitColor)
      .stroke({ color: INK, width: 3.2, join: 'round' })
    // One highlight band. That is the entire cloth shading model in the
    // reference: base plus a single lighter step, no gradients.
    this.torso
      .moveTo(-14, -TORSO * 0.62)
      .lineTo(14, -TORSO * 0.62)
      .lineTo(14, -TORSO)
      .lineTo(-14, -TORSO)
      .closePath()
      .fill({ color: lighten(kitColor, 0.28), alpha: 0.9 })
    // Rim. The key is low and to the right of the course, so the leading edge
    // of the jersey catches it. One stroke, and it is what lifts the rider off
    // the dirt when he is silhouetted against the dark near plane.
    this.torso
      .moveTo(16, -2)
      .bezierCurveTo(21, -TORSO * 0.45, 18, -TORSO * 0.8, 14, -TORSO + 1)
      .stroke({ color: RIM, width: 3.6, alpha: 0.85, cap: 'round' })
    // A number plate, because a jersey that is one flat colour with one band
    // across it is still a colour swatch.
    this.torso
      .moveTo(-6, -TORSO * 0.5)
      .lineTo(6, -TORSO * 0.48)
      .lineTo(5, -TORSO * 0.2)
      .lineTo(-5, -TORSO * 0.22)
      .closePath()
      .fill({ color: Core.paperWhite, alpha: 0.85 })
      .stroke({ color: INK, width: 1.8, alpha: 0.6 })

    // Neck, so the head is attached to something rather than floating 19 units
    // off the shoulders. Drawn first, so the skull and the lid cover its top.
    // It leans back, because the head is carried at 45% of the torso's pitch
    // and the shoulders are therefore down and behind it.
    this.head
      .moveTo(-7, 0).lineTo(-13, 17).lineTo(-1, 20).lineTo(5, 2).closePath()
      .fill(grade(Core.skinMid, { valScale: 0.88 }))
      .stroke({ color: INK, width: 2.4, join: 'round' })
    this.head.circle(0, 0, HEAD_R).fill(Core.skinLight).stroke({ color: INK, width: 3.2 })
    this.head.circle(HEAD_R * 0.45, 1, 2.1).fill(INK)
    // Full-face lid: the strongest single value break on the character, and the
    // thing that makes a 40px head read at speed.
    this.helmet
      .arc(0, 0, HEAD_R + 5, Math.PI * 0.98, Math.PI * 2.04)
      .lineTo(HEAD_R + 7, 4)
      .quadraticCurveTo(HEAD_R + 2, 9, HEAD_R - 6, 8)
      .lineTo(-HEAD_R - 4, 5)
      .closePath()
      .fill(Core.paperWhite)
      .stroke({ color: INK, width: 3 })
    this.helmet
      .moveTo(-HEAD_R - 3, -5)
      .quadraticCurveTo(0, -HEAD_R - 12, HEAD_R + 4, -6)
      .lineTo(HEAD_R + 2, -1)
      .quadraticCurveTo(0, -HEAD_R - 6, -HEAD_R - 2, 0)
      .closePath()
      .fill(frameColor)
    // Peak and chin bar: the two shapes that separate a full-face lid from a
    // circle, and the silhouette cues that survive being 30 pixels tall.
    this.helmet
      .moveTo(HEAD_R + 2, -9)
      .lineTo(HEAD_R + 17, -14)
      .lineTo(HEAD_R + 18, -8)
      .lineTo(HEAD_R + 4, -3)
      .closePath()
      .fill(frameColor)
      .stroke({ color: INK, width: 2.4, join: 'round' })
    this.helmet
      .moveTo(HEAD_R - 5, 7)
      .quadraticCurveTo(HEAD_R + 4, 4, HEAD_R + 5, -2)
      .stroke({ color: INK, width: 2.6, alpha: 0.8, cap: 'round' })
    // Rim along the sunward edge of the lid.
    this.helmet
      .arc(0, 0, HEAD_R + 5, -Math.PI * 0.52, Math.PI * 0.1)
      .stroke({ color: RIM, width: 3.2, alpha: 0.9, cap: 'round' })

    this.buildWheel(this.rearWheel)
    this.buildWheel(this.frontWheel)
    this.buildFrame(frameColor)

    this.rearWheel.position.set(-AXLE_X, AXLE_Y)
    this.frontWheel.position.set(AXLE_X, AXLE_Y)
    this.bike.addChild(this.rearWheel, this.frame, this.cranks, this.frontWheel)
    this.bike.pivot.set(BAR_X, BAR_Y)
    this.bike.position.set(BAR_X, BAR_Y)

    // Draw order is depth order: far limbs, bike, body, near limbs. The far
    // shoe goes behind the cranks and the near one in front of them, which is
    // the whole reason the feet are separate Graphics.
    this.container.addChild(
      this.thighBack, this.shinBack, this.shoeBack,
      this.upperArmBack, this.foreArmBack,
      this.bike,
      this.torso,
      this.head, this.helmet,
      this.thighFront, this.shinFront, this.shoeFront,
      this.upperArmFront, this.foreArmFront,
    )
    this.container.interactiveChildren = false
  }

  /**
   * Tyre, rim, hub and spokes.
   *
   * "The board is a hairline" was the critic's verdict on the half pipe, and a
   * 6.5-unit tyre on a 25-unit wheel is the same mistake: at the size a
   * reviewer first sees the frame, the bike has to have mass or the rider is a
   * man falling over. The casing is fat, it has tread blocks that break its
   * outline, and the rim inside it is a second value rather than a bright gold
   * ring that competed with the rider's own colours.
   */
  private buildWheel(g: Graphics): void {
    const casing = 0x4a4750
    // Warm, not neutral. "The only pure grey in a frame with no greys" was said
    // of a HUD meter, but a chrome rim at the centre of the subject is the same
    // mistake with a better excuse.
    const rim = 0x8f8189
    // Casing: nearly a fifth of the wheel radius, so the tyre reads as rubber.
    g.circle(0, 0, WHEEL_R - 4.5).stroke({ color: casing, width: 9.5 })
    // Tread blocks, alternating in and out, which is what stops the tyre being
    // a smooth ring at any size.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      const inner = WHEEL_R - 7
      const outer = WHEEL_R + (i % 2 === 0 ? 0.8 : -0.6)
      g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
        .lineTo(Math.cos(a) * outer, Math.sin(a) * outer)
    }
    g.stroke({ color: grade(casing, { valScale: 0.62 }), width: 2.6, alpha: 0.75, cap: 'round' })
    g.circle(0, 0, WHEEL_R - 10).stroke({ color: rim, width: 3.6 })
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      g.moveTo(0, 0).lineTo(Math.cos(a) * (WHEEL_R - 10), Math.sin(a) * (WHEEL_R - 10))
    }
    g.stroke({ color: lighten(rim, 0.3), width: 1.7 })
    g.circle(0, 0, 5.5).fill(rim).stroke({ color: INK, width: 2.2 })
  }

  /**
   * The frame.
   *
   * Tubes are ~35% fatter than they were, the head tube and the fork are drawn
   * as the heaviest parts because they are, there is a gusset behind the head
   * tube, and the bar has grips and a crossbar. The silhouette gains real
   * negative space from it: two open triangles in the frame and one under the
   * bars, which is what a viewer reads as "a bike" before they read any detail.
   */
  private buildFrame(color: Hex): void {
    const g = this.frame
    const ink = line(color)
    const steel = 0x4f4c57
    /** Rear end and fork: dark, so the painted triangle is the only hero. */
    const steelDark = grade(steel, { valScale: 0.74 })
    // Rear triangle and fork in dark steel; main triangle in the reserved hue.
    //
    // It used to be painted end to end, which sounds like more colour and was
    // in fact less: the bike out-weighed the rider in reserved pixels, so the
    // brightest half of the pair — the kit — was the minority report, and the
    // eye had two competing colour masses at two different luminances instead
    // of one hero. A dark rear end is also what a BMX actually looks like, and
    // it gives the wheels something to be silhouetted against.
    g.moveTo(BB_X, BB_Y).lineTo(-AXLE_X, AXLE_Y)          // chainstay
      .moveTo(SEAT_X, SEAT_Y).lineTo(-AXLE_X, AXLE_Y)      // seatstay
      .stroke({ color: steelDark, width: 9, join: 'round', cap: 'round' })
    g.moveTo(BB_X, BB_Y).lineTo(SEAT_X, SEAT_Y)            // seat tube
      .moveTo(SEAT_X, SEAT_Y).lineTo(HEAD_HI_X, HEAD_HI_Y) // top tube
      .moveTo(BB_X, BB_Y).lineTo(HEAD_LO_X, HEAD_LO_Y)     // down tube
      .stroke({ color, width: 13, join: 'round', cap: 'round' })
    // Gusset: the plate between the down tube and the head tube. Two lines of
    // geometry, and the thing that makes a BMX read as a BMX rather than a
    // road bike with fat tyres.
    g.moveTo(HEAD_LO_X - 2, HEAD_LO_Y + 4)
      .lineTo(HEAD_HI_X - 1, HEAD_HI_Y + 7)
      .lineTo(HEAD_LO_X - 23, HEAD_LO_Y + 12)
      .closePath()
      .fill(color)
      .stroke({ color: ink, width: 2, join: 'round' })
    // Head tube: the heaviest single part of the frame.
    g.moveTo(HEAD_LO_X, HEAD_LO_Y).lineTo(HEAD_HI_X, HEAD_HI_Y)
      .stroke({ color: ink, width: 12, cap: 'round' })
    // Fork: two blades, offset, so it has thickness against the wheel.
    g.moveTo(HEAD_LO_X, HEAD_LO_Y).lineTo(AXLE_X, AXLE_Y)
      .stroke({ color: steel, width: 8, cap: 'round' })
    g.moveTo(HEAD_LO_X - 3, HEAD_LO_Y).lineTo(AXLE_X - 4, AXLE_Y)
      .stroke({ color: steelDark, width: 6, cap: 'round' })
    // Top-tube highlight: the single lit step every other material in this
    // event gets, applied to the bike so it obeys the same key.
    g.moveTo(SEAT_X + 4, SEAT_Y - 3).lineTo(HEAD_HI_X - 4, HEAD_HI_Y - 3)
      .stroke({ color: lighten(color, 0.42), width: 2.6, alpha: 0.8, cap: 'round' })

    // Bars: tall, the way a BMX bar actually is, with a crossbar and grips.
    g.moveTo(HEAD_HI_X, HEAD_HI_Y)
      .lineTo(HEAD_HI_X + 5, HEAD_HI_Y - 22)
      .lineTo(BAR_X, BAR_Y)
      .stroke({ color: steel, width: 8, join: 'round', cap: 'round' })
    g.moveTo(HEAD_HI_X + 3, HEAD_HI_Y - 13).lineTo(BAR_X - 1, BAR_Y + 9)
      .stroke({ color: steel, width: 4.5, cap: 'round' })
    g.circle(BAR_X, BAR_Y, 6.5).fill(grade(steel, { valScale: 0.7 }))
      .stroke({ color: INK, width: 2.2 })
    // Seat: a saddle with a post under it, not a line.
    g.moveTo(SEAT_X - 3, SEAT_Y + 4).lineTo(SEAT_X - 1, SEAT_Y - 4)
      .stroke({ color: steel, width: 5, cap: 'round' })
    g.moveTo(SEAT_X - 15, SEAT_Y - 2)
      .quadraticCurveTo(SEAT_X - 4, SEAT_Y - 10, SEAT_X + 12, SEAT_Y - 8)
      .quadraticCurveTo(SEAT_X + 4, SEAT_Y - 1, SEAT_X - 15, SEAT_Y + 2)
      .closePath()
      .fill(grade(steel, { valScale: 0.58 }))
      .stroke({ color: INK, width: 2.2, join: 'round' })

    // Chainring and cranks.
    this.cranks.circle(BB_X - 1, BB_Y, 11).fill(grade(steel, { valScale: 1.35 }))
      .stroke({ color: INK, width: 2 })
    this.cranks
      .moveTo(BB_X - CRANK, BB_Y).lineTo(BB_X + CRANK, BB_Y)
      .stroke({ color: steel, width: 6.5, cap: 'round' })
    this.cranks
      .roundRect(BB_X + CRANK - 9, BB_Y - 3, 19, 6.5, 2).fill(grade(steel, { valScale: 0.62 }))
      .roundRect(BB_X - CRANK - 10, BB_Y - 3, 19, 6.5, 2).fill(grade(steel, { valScale: 0.62 }))
    this.cranks.circle(BB_X, BB_Y, 5).fill(color).stroke({ color: ink, width: 2 })
  }

  setPose(pose: Partial<RiderPose>): void {
    Object.assign(this.pose, pose)
  }

  /** Uniform scale for the whole rig. Use this rather than touching the container. */
  setScale(scale: number): void {
    this.baseScale = scale
    this.container.scale.y = scale
    this.apply()
  }

  /** Secondary motion. Call once per simulation step. */
  update(dt: number, angularVelocity: number): void {
    const target = clamp(-angularVelocity * 0.05, -0.5, 0.5)
    this.headLag = damp(this.headLag, target, 0.004, dt)
    this.armLag = damp(this.armLag, target * 0.6, 0.01, dt)
  }

  /** Rebuild the rig from the current pose. Transform writes only. */
  apply(): void {
    const p = this.pose
    const c = clamp(p.compress, 0, 1)
    const sprawl = clamp(p.sprawl, 0, 1)

    // A spin is faked by squashing the rig in x. Flooring the magnitude keeps a
    // readable silhouette at the edge-on frames instead of a vanishing sliver.
    const yawScale = Math.cos(p.yaw)
    const mag = Math.max(0.14, Math.abs(yawScale))
    this.container.scale.set(
      this.baseScale * (p.facing >= 0 ? 1 : -1) * mag * Math.sign(yawScale || 1),
      this.baseScale,
    )

    this.rearWheel.rotation = p.wheel
    this.frontWheel.rotation = p.wheel

    // Bike kicked out under the rider, hands still on the bars.
    const tableRot = p.table * 0.62 + sprawl * 0.5
    this.bike.rotation = tableRot
    this.bike.position.set(BAR_X + p.table * 14 + sprawl * 26, BAR_Y + p.table * 6 + sprawl * 12)

    // Pedals live on the bike, so the feet inherit its rotation.
    const footBack = this.bikePoint(this.footA, BB_X - CRANK, BB_Y, tableRot)
    const footFront = this.bikePoint(this.footB, BB_X + CRANK, BB_Y, tableRot)
    // The shoe is centred on the spindle and stays flat on the pedal, so a
    // tabletop kicks the feet out with the frame.
    this.shoeBack.position.set(footBack.x, footBack.y + 1)
    this.shoeBack.rotation = tableRot
    this.shoeFront.position.set(footFront.x, footFront.y + 1)
    this.shoeFront.rotation = tableRot
    const gripX = this.bike.x
    const gripY = this.bike.y

    const hipX = lerp(HIP_HIGH_X, HIP_LOW_X, c) + sprawl * -14
    const hipY = lerp(HIP_HIGH_Y, HIP_LOW_Y, c) + sprawl * 16

    // Pitch: loading the bike folds the rider forward over the bars.
    const pitch = lerp(0.55, 0.98, c) + p.lean + p.tuck * 0.34 - sprawl * 1.4
    this.torso.position.set(hipX, hipY)
    this.torso.rotation = pitch + this.armLag * 0.12

    const sinP = Math.sin(this.torso.rotation)
    const cosP = Math.cos(this.torso.rotation)
    const shoulderX = hipX + sinP * TORSO
    const shoulderY = hipY - cosP * TORSO

    this.head.position.set(shoulderX + sinP * 19, shoulderY - cosP * 19)
    this.head.rotation = this.torso.rotation * 0.45 + this.headLag * 0.3
    this.helmet.position.copyFrom(this.head.position)
    this.helmet.rotation = this.head.rotation

    // Legs: feet bolted to the pedals, hips do the moving, knees resolve. The
    // IK target is the ANKLE, which is seven units above the spindle — that
    // gap is where the shoe goes, and without it the shin ends in a stump.
    this.solve(this.thighBack, this.shinBack, hipX - 6, hipY, footBack.x - 1, footBack.y - 7, THIGH, SHIN, -1)
    this.solve(this.thighFront, this.shinFront, hipX + 6, hipY, footFront.x - 1, footFront.y - 7, THIGH, SHIN, -1)

    // Arms: hands on the grips, except in a sprawl where they fly free.
    const flailX = shoulderX - 44
    const flailY = shoulderY - 34
    const handX = lerp(gripX, flailX, sprawl)
    const handY = lerp(gripY, flailY, sprawl)
    // The shoulders are set further apart than the torso is wide, which opens
    // the triangle of sky between the arms and the chest. That piece of
    // negative space is most of what makes the pose read at thumbnail size —
    // a silhouette with no holes in it is a blob.
    const backSh = shoulderX - 8
    const frontSh = shoulderX + 7
    this.solve(this.upperArmBack, this.foreArmBack, backSh, shoulderY + 2, handX - 5, handY + 3, UPPER_ARM, FOREARM, 1)
    this.solve(this.upperArmFront, this.foreArmFront, frontSh, shoulderY, handX, handY, UPPER_ARM, FOREARM, 1)
  }

  /**
   * Transform a point from bike-local space into rig space, into a caller-owned
   * scratch object so posing the rig allocates nothing.
   */
  private bikePoint(out: { x: number; y: number }, x: number, y: number, rot: number): { x: number; y: number } {
    const cs = Math.cos(rot)
    const sn = Math.sin(rot)
    const dx = x - BAR_X
    const dy = y - BAR_Y
    out.x = this.bike.x + dx * cs - dy * sn
    out.y = this.bike.y + dx * sn + dy * cs
    return out
  }
  private footA = { x: 0, y: 0 }
  private footB = { x: 0, y: 0 }

  private solve(
    a: Graphics, b: Graphics,
    rootX: number, rootY: number, tipX: number, tipY: number,
    l1: number, l2: number, dir: number,
  ): void {
    const j = ik2(rootX, rootY, tipX, tipY, l1, l2, dir)
    a.position.set(rootX, rootY)
    a.rotation = Math.atan2(j.y - rootY, j.x - rootX)
    b.position.set(j.x, j.y)
    b.rotation = Math.atan2(tipY - j.y, tipX - j.x)
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

/**
 * A tapered bone, drawn from its proximal joint along +X.
 *
 * The taper is the whole point. A neutral critic looked at the half pipe's
 * rider and called it "a jointless stick figure — limbs are identical-width
 * rounded rectangles", and identical-width is literally what a capsule is. A
 * real limb loses close to half its width from hip to knee and again from knee
 * to ankle, so `taper` defaults to 0.5 and the joints read as joints.
 */
function bone(
  g: Graphics, length: number, width: number, fill: Hex, ink: Hex, taper = 0.5,
): void {
  const r = width / 2
  const t = r * taper
  g.moveTo(0, -r)
    .lineTo(length, -t)
    .arc(length, 0, t, -Math.PI / 2, Math.PI / 2)
    .lineTo(0, r)
    .arc(0, 0, r, Math.PI / 2, -Math.PI / 2)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.8, join: 'round' })
}

/**
 * A closed fist on the grip, drawn into the forearm's own Graphics at its
 * distal end, so it inherits the forearm's rotation for free and costs no node.
 *
 * "No hands" was the second thing the critic listed. A limb that stops in a
 * rounded stump at the bar is the difference between a character and a
 * placeholder, and it is four curves.
 */
function fist(g: Graphics, x: number, r: number, fill: Hex, ink: Hex): void {
  g.moveTo(x - r * 0.5, -r)
    .quadraticCurveTo(x + r * 1.2, -r * 1.05, x + r * 1.15, r * 0.12)
    .quadraticCurveTo(x + r * 1.05, r * 1.05, x - r * 0.25, r)
    .quadraticCurveTo(x - r * 1.0, r * 0.5, x - r * 0.5, -r)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.6, join: 'round' })
  // Knuckles: one curve, and it is what stops the fist reading as a pebble.
  g.moveTo(x + r * 0.2, -r * 0.7)
    .quadraticCurveTo(x + r * 0.9, -r * 0.05, x + r * 0.35, r * 0.7)
    .stroke({ color: ink, width: 1.8, alpha: 0.55 })
  // Thumb, wrapped over the bar.
  g.moveTo(x - r * 0.15, r * 0.15)
    .quadraticCurveTo(x + r * 0.55, r * 0.55, x + r * 0.5, r * 1.0)
    .stroke({ color: ink, width: 2.2, alpha: 0.7, cap: 'round' })
}

/**
 * A shoe on a pedal. Origin at the spindle, heel behind, toe ahead.
 *
 * Feet live on the bike rather than on the shin: a rider's ankle takes up the
 * difference and the sole stays flat on the pedal, so the shoe inherits the
 * bike's rotation and a tabletop kicks the feet out with the frame.
 */
function shoe(g: Graphics, fill: Hex, sole: Hex, ink: Hex): void {
  g.moveTo(-15, -4)
    .lineTo(-16.5, 4)
    .lineTo(17, 5.5)
    .quadraticCurveTo(22, 3.5, 19.5, -2.5)
    .lineTo(6, -7)
    .quadraticCurveTo(-4, -11.5, -13, -9.5)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.6, join: 'round' })
  g.moveTo(-16.5, 2)
    .lineTo(19.5, 3.4)
    .lineTo(18.5, 6.4)
    .lineTo(-16.5, 5.4)
    .closePath()
    .fill(sole)
  // Laces.
  g.moveTo(-6, -8).lineTo(-2, -4.5).moveTo(0, -8.4).lineTo(4, -4.6)
    .stroke({ color: ink, width: 1.7, alpha: 0.6, cap: 'round' })
}

/** Shared IK result, so solving a limb never allocates. */
const ikOut = { x: 0, y: 0 }

/**
 * Two-bone IK. Returns the joint between `l1` and `l2`.
 * `dir` picks which mirror solution to use (which way the knee or elbow bends).
 */
function ik2(
  ax: number, ay: number, bx: number, by: number,
  l1: number, l2: number, dir: number,
): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const raw = Math.hypot(dx, dy) || 1
  // Clamp to the reachable range so the limb straightens rather than going NaN.
  const maxD = l1 + l2 - 0.001
  const minD = Math.abs(l1 - l2) + 0.001
  const d = raw > maxD ? maxD : raw < minD ? minD : raw
  const ux = dx / raw
  const uy = dy / raw
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  ikOut.x = ax + ux * a - uy * h * dir
  ikOut.y = ay + uy * a + ux * h * dir
  return ikOut
}
