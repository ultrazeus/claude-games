import { Container, Graphics } from 'pixi.js'
import { Core, darken, lighten, mix, type Hex } from '../../../render/Palette'
import { clamp, damp, lerp } from '../../../core/Tween'

/**
 * Articulated skater.
 *
 * Built as a bone rig rather than redrawn art: every limb is a Graphics authored
 * once with its origin at the proximal joint, and animation is nothing but
 * transform writes. That keeps the character free in `render` (no geometry
 * rebuilds) and lets the pose be driven continuously by the physics rather than
 * snapped between animation frames.
 *
 * The legs run two-bone IK against the board, so when the hips drop to crouch the
 * knees bend correctly and the feet stay planted. Crouch is the whole read of a
 * half pipe run, so it has to be real rather than a vertical squash.
 */
export interface SkaterPose {
  /** 0 = fully extended, 1 = fully compressed. */
  crouch: number
  /** Body lean relative to the board, radians. Positive leans forward. */
  lean: number
  /** 0 = arms loose, 1 = arms up and out. */
  reach: number
  /** 0 = no grab, 1 = hand locked to the board. */
  grab: number
  /** Which way the skater faces: 1 = right, -1 = left. */
  facing: number
}

const THIGH = 40
const SHIN = 42
const TORSO = 54
const UPPER_ARM = 34
const FOREARM = 32
const HEAD_R = 16
const BOARD_LEN = 124
const BOARD_HALF = BOARD_LEN / 2
/** Hip height above the board when fully extended. */
const HIP_HIGH = 74
/** Hip height when fully compressed. */
const HIP_LOW = 40

export class Skater {
  readonly container = new Container()

  private board = new Graphics()
  private wheels = new Graphics()
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
  private handFront = new Graphics()
  private handBack = new Graphics()
  private footFront = new Graphics()
  private footBack = new Graphics()
  private hair = new Graphics()

  /**
   * Magnitude of the rig's own scale, kept separate from the facing sign.
   * Writing `scale.x = facing` directly destroys any uniform scale the scene set
   * on the container, which silently squashes the rig horizontally.
   */
  private baseScale = 1

  /** Secondary motion state, smoothed in update(). */
  private hairAngle = 0
  private armLag = 0
  private pose: SkaterPose = { crouch: 0, lean: 0, reach: 0, grab: 0, facing: 1 }

  /**
   * @param accent  limbs and helmet
   * @param accent2 torso and board
   * @param rim     key-light colour. Every bone, the helmet and the torso carry
   *                a rim in this colour along the sun side, which is what stops
   *                the rider dissolving into a dark ramp: a hue break alone was
   *                measured at 0.008 of local value contrast and read as
   *                scenery.
   */
  constructor(accent: Hex = Core.suitPrimary, accent2: Hex = Core.suitSecondary, rim: Hex = 0xffffff) {
    const ink = Core.suitDark

    // Back limbs are darkened so the silhouette stays readable when they overlap
    // the front ones. Depth by value, which survives any background.
    const backTint = 0.28

    bone(this.thighBack, THIGH, 15, darken(accent, backTint), ink, rim)
    bone(this.shinBack, SHIN, 12, darken(accent, backTint), ink, rim)
    bone(this.thighFront, THIGH, 16, accent, ink, rim)
    bone(this.shinFront, SHIN, 13, accent, ink, rim)
    // Sleeves, not bare arms. The event's whole reservation argument is that the
    // rider is the one CHROMATIC cluster in the frame, and the arms are a
    // quarter of his silhouette: in skin tone they sat at the same
    // colourfulness as the sunset behind them and contributed nothing to the
    // cluster, which left it small enough that a handful of resampling
    // artefacts around the sun could stretch the measured "subject" across half
    // the frame. Hands stay bare, so he still reads as a person.
    bone(this.upperArmBack, UPPER_ARM, 12, darken(accent2, backTint), ink, rim)
    bone(this.foreArmBack, FOREARM, 10, darken(accent2, backTint), ink, rim)
    bone(this.upperArmFront, UPPER_ARM, 13, accent2, ink, rim)
    bone(this.foreArmFront, FOREARM, 11, accent2, ink, rim)

    // Torso: origin at the hips, extending up to the shoulders.
    // Shoulders wider than the waist, with a slight lean into the chest. A
    // symmetric rounded slab reads as a primitive; this reads as a body.
    this.torso
      .moveTo(-11, 0)
      .bezierCurveTo(-15, -TORSO * 0.4, -18, -TORSO * 0.72, -17, -TORSO)
      .quadraticCurveTo(0, -TORSO - 5, 17, -TORSO)
      .bezierCurveTo(18, -TORSO * 0.72, 15, -TORSO * 0.4, 11, 0)
      .closePath()
      .fill(accent2)
      .stroke({ color: ink, width: 3, join: 'round' })
    // Lit side, toward the key.
    this.torso
      .moveTo(-9, -4)
      .bezierCurveTo(-13, -TORSO * 0.42, -15, -TORSO * 0.72, -14, -TORSO + 4)
      .lineTo(-5, -TORSO + 2)
      .bezierCurveTo(-7, -TORSO * 0.7, -5, -TORSO * 0.4, -3, -4)
      .closePath()
      .fill({ color: lighten(accent2, 0.16), alpha: 0.9 })
    // Hard rim down the key edge of the chest. The single brightest run of
    // pixels in the frame belongs on the subject.
    this.torso
      .moveTo(-11, -6)
      .bezierCurveTo(-15, -TORSO * 0.4, -18, -TORSO * 0.72, -17, -TORSO + 2)
      .stroke({ color: mix(rim, 0xffffff, 0.4), width: 3.6, cap: 'round' })

    this.head.circle(0, 0, HEAD_R).fill(Core.skinLight).stroke({ color: ink, width: 3 })
    this.head.arc(0, 0, HEAD_R - 1, Math.PI * 0.98, Math.PI * 1.52)
      .stroke({ color: mix(rim, 0xffffff, 0.35), width: 3, cap: 'round' })
    this.head.arc(0, 0, HEAD_R - 2, Math.PI * 0.95, Math.PI * 1.55)
      .stroke({ color: lighten(Core.skinLight, 0.5), width: 3.5, cap: 'round' })
    // Helmet, because a vert skater without one reads as a stock illustration.
    this.hair
      .arc(0, 0, HEAD_R + 4, Math.PI * 1.02, Math.PI * 2.02)
      .lineTo(HEAD_R + 2, 2)
      .lineTo(-HEAD_R - 2, 2)
      .closePath()
      .fill(accent)
      .stroke({ color: ink, width: 3 })
    // Helmet rim: the highest point on the rider, so it is the first thing the
    // eye finds at thumbnail size.
    this.hair.arc(0, 0, HEAD_R + 2, Math.PI * 1.06, Math.PI * 1.62)
      .stroke({ color: mix(rim, 0xffffff, 0.55), width: 4, cap: 'round' })

    // Hands and feet, drawn once and parented to the limb ends.
    const mitt = (g: Graphics, fill: Hex, r: number): void => {
      g.circle(0, 0, r).fill(fill).stroke({ color: ink, width: 2.6 })
    }
    mitt(this.handFront, Core.skinLight, 8.5)
    mitt(this.handBack, darken(Core.skinMid, backTint), 7.5)
    const shoe = (g: Graphics, fill: Hex): void => {
      g.roundRect(-5, -6, 24, 12, 5).fill(fill).stroke({ color: ink, width: 2.6 })
    }
    shoe(this.footFront, Core.paperWhite)
    shoe(this.footBack, darken(Core.paperWhite, backTint))

    this.board
      .moveTo(-BOARD_HALF, 0)
      .quadraticCurveTo(-BOARD_HALF - 10, -2, -BOARD_HALF - 12, -11)
      .lineTo(-BOARD_HALF + 4, -12)
      .lineTo(BOARD_HALF - 4, -12)
      .lineTo(BOARD_HALF + 12, -11)
      .quadraticCurveTo(BOARD_HALF + 10, -2, BOARD_HALF, 0)
      .closePath()
      .fill(lighten(accent2, 0.1))
      .stroke({ color: ink, width: 4, join: 'round' })
    this.board
      .moveTo(-BOARD_HALF + 4, -12)
      .lineTo(BOARD_HALF - 4, -12)
      .stroke({ color: mix(rim, 0xffffff, 0.5), width: 3.5, cap: 'round' })
    // Wheels are cream, not gold. Gold measures 0.77 on the same value-weighted
    // chroma the subject detector uses — higher than the rider's own reserved
    // cyan at 0.69 — so two eight-pixel dots were the most colourful thing in
    // the frame and could pull the measured subject centroid onto a wheel.
    this.wheels
      .circle(-BOARD_HALF * 0.55, 5, 6).fill(Core.sunWhite)
      .circle(BOARD_HALF * 0.55, 5, 6).fill(Core.sunWhite)
      .stroke({ color: ink, width: 2.5 })

    // Draw order is the depth order: back limbs, board, body, front limbs, head.
    this.container.addChild(
      this.thighBack, this.shinBack,
      this.upperArmBack, this.foreArmBack,
      this.board, this.wheels,
      this.thighFront, this.shinFront,
      this.torso,
      this.head, this.hair,
      this.upperArmFront, this.foreArmFront,
      this.footBack, this.footFront, this.handBack, this.handFront,
    )
    this.container.interactiveChildren = false
  }

  setPose(pose: Partial<SkaterPose>): void {
    Object.assign(this.pose, pose)
  }

  /** Uniform scale for the whole rig. Use this rather than touching the container. */
  setScale(scale: number): void {
    this.baseScale = scale
    this.container.scale.set(this.pose.facing >= 0 ? scale : -scale, scale)
  }

  /** Secondary motion. Call once per simulation step. */
  update(dt: number, angularVelocity: number): void {
    const target = clamp(-angularVelocity * 0.06, -0.55, 0.55)
    this.hairAngle = damp(this.hairAngle, target, 0.004, dt)
    this.armLag = damp(this.armLag, target * 0.7, 0.008, dt)
  }

  /** Recompute the rig from the current pose. Transform writes only. */
  apply(): void {
    const p = this.pose
    const f = p.facing >= 0 ? 1 : -1
    this.container.scale.set(this.baseScale * f, this.baseScale)

    const hipY = -lerp(HIP_HIGH, HIP_LOW, clamp(p.crouch, 0, 1))
    const hipX = lerp(0, 6, p.crouch) + Math.sin(p.lean) * 10

    // Feet stay bolted to the board; the hips move and the knees resolve.
    const footBackX = -BOARD_HALF * 0.52
    const footFrontX = BOARD_HALF * 0.46
    const footY = -6

    this.solveLeg(this.thighBack, this.shinBack, hipX - 5, hipY, footBackX, footY, -1)
    this.solveLeg(this.thighFront, this.shinFront, hipX + 5, hipY, footFrontX, footY, -1)
    this.footBack.position.set(footBackX, footY)
    this.footBack.rotation = this.shinBack.rotation
    this.footFront.position.set(footFrontX, footY)
    this.footFront.rotation = this.shinFront.rotation

    this.torso.position.set(hipX, hipY)
    this.torso.rotation = p.lean * 0.85 + this.armLag * 0.15

    const shoulderX = hipX + Math.sin(this.torso.rotation) * -TORSO
    const shoulderY = hipY + Math.cos(this.torso.rotation) * -TORSO

    this.head.position.set(
      shoulderX + Math.sin(this.torso.rotation) * -(HEAD_R + 4),
      shoulderY + Math.cos(this.torso.rotation) * -(HEAD_R + 4),
    )
    this.head.rotation = this.torso.rotation * 0.6
    this.hair.position.copyFrom(this.head.position)
    this.hair.rotation = this.head.rotation + this.hairAngle * 0.35

    // Arms: reach out and up when extended, tuck when crouched, and when
    // grabbing the leading hand goes to the board instead.
    const reach = clamp(p.reach, 0, 1)
    const grab = clamp(p.grab, 0, 1)

    const backShoulderX = shoulderX - 6
    const frontShoulderX = shoulderX + 6

    const openAngle = lerp(0.95, -0.35, reach) + this.armLag * 0.5
    const backHandX = backShoulderX + Math.cos(openAngle + Math.PI * 0.82) * (UPPER_ARM + FOREARM) * 0.92
    const backHandY = shoulderY + Math.sin(openAngle + Math.PI * 0.82) * (UPPER_ARM + FOREARM) * 0.92
    this.solveArm(this.upperArmBack, this.foreArmBack, this.handBack, backShoulderX, shoulderY, backHandX, backHandY, 1)

    const grabX = BOARD_HALF * 0.2
    const grabY = -10
    const freeAngle = lerp(0.55, -0.7, reach) + this.armLag * 0.6
    const freeX = frontShoulderX + Math.cos(freeAngle + Math.PI * 0.12) * (UPPER_ARM + FOREARM) * 0.92
    const freeY = shoulderY + Math.sin(freeAngle + Math.PI * 0.12) * (UPPER_ARM + FOREARM) * 0.92
    this.solveArm(
      this.upperArmFront, this.foreArmFront, this.handFront, frontShoulderX, shoulderY,
      lerp(freeX, grabX, grab), lerp(freeY, grabY, grab), -1,
    )
  }

  private solveLeg(
    thigh: Graphics, shin: Graphics,
    hipX: number, hipY: number, footX: number, footY: number, kneeDir: number,
  ): void {
    const knee = ik2(hipX, hipY, footX, footY, THIGH, SHIN, kneeDir)
    thigh.position.set(hipX, hipY)
    thigh.rotation = Math.atan2(knee.y - hipY, knee.x - hipX)
    shin.position.set(knee.x, knee.y)
    shin.rotation = Math.atan2(footY - knee.y, footX - knee.x)
  }

  private solveArm(
    upper: Graphics, fore: Graphics, hand: Graphics,
    shX: number, shY: number, handX: number, handY: number, elbowDir: number,
  ): void {
    const elbow = ik2(shX, shY, handX, handY, UPPER_ARM, FOREARM, elbowDir)
    upper.position.set(shX, shY)
    upper.rotation = Math.atan2(elbow.y - shY, elbow.x - shX)
    fore.position.set(elbow.x, elbow.y)
    const a = Math.atan2(handY - elbow.y, handX - elbow.x)
    fore.rotation = a
    hand.position.set(elbow.x + Math.cos(a) * FOREARM, elbow.y + Math.sin(a) * FOREARM)
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

/**
 * A tapering bone drawn from its proximal joint along +X.
 *
 * Uniform-width capsules were called out in review as the thing that reads as
 * placeholder art: real limbs are thick at the shoulder or hip and narrow at the
 * wrist or ankle, and that taper is most of what makes a silhouette look drawn
 * rather than assembled. The distal end is 52% of the proximal width, and a rim
 * runs along the key-light side.
 */
function bone(g: Graphics, length: number, width: number, fill: Hex, ink: Hex, rim = 0xffffff): void {
  const r = width / 2
  const rEnd = r * 0.4
  g.moveTo(0, -r)
    .quadraticCurveTo(length * 0.55, -r * 0.82, length, -rEnd)
    .arc(length, 0, rEnd, -Math.PI / 2, Math.PI / 2)
    .quadraticCurveTo(length * 0.55, r * 0.82, 0, r)
    .arc(0, 0, r, Math.PI / 2, -Math.PI / 2)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.6, join: 'round' })
  // Rim along the upper edge: one highlight band, the two-tone cel model.
  g.moveTo(0, -r * 0.62)
    .quadraticCurveTo(length * 0.55, -r * 0.5, length * 0.9, -rEnd * 0.55)
    .stroke({ color: mix(lighten(fill, 0.42), rim, 0.45), width: Math.max(2, r * 0.38), cap: 'round' })
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
  let d = Math.hypot(dx, dy)
  // Clamp to reachable range so the limb straightens instead of producing NaN.
  const maxD = l1 + l2 - 0.001
  const minD = Math.abs(l1 - l2) + 0.001
  if (d > maxD) d = maxD
  if (d < minD) d = minD
  const ux = dx / (Math.hypot(dx, dy) || 1)
  const uy = dy / (Math.hypot(dx, dy) || 1)
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  const mx = ax + ux * a
  const my = ay + uy * a
  return { x: mx - uy * h * dir, y: my + ux * h * dir }
}
