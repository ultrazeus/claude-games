import { Container, Graphics } from 'pixi.js'
import { Core, darken, grade, mix, type Hex } from '../../../render/Palette'
import { keyFromRight, shadePair } from '../../../render/Staging'
import { clamp, damp, lerp } from '../../../core/Tween'

/**
 * Articulated surfer.
 *
 * Same construction as the half pipe's `Skater`: every limb is a Graphics
 * authored once with its origin at the proximal joint, and animation is nothing
 * but transform writes, so the character costs nothing in `render` and the pose
 * is driven continuously by the physics rather than snapped between frames.
 * Legs run two-bone IK against the board so the feet stay planted through a
 * compression, which is the whole read of a bottom turn.
 *
 * What is specific to surfing:
 *  - a **stance twist**, because a surfer stands across the board rather than
 *    along it, and the shoulders open and close as he carves;
 *  - a **drag hand**, the trailing arm reaching down and back into the face.
 *    That single pose is what makes a tube read as a tube rather than a man
 *    standing under a blue shape;
 *  - a longer board with a real rail line and a fin, sized so it never reads as
 *    a skateboard that has lost its wheels.
 *
 * Lighting: the whole rig is built against one `KeyLight` from the right, where
 * the dawn sun is. Every material is a `shadePair` — two values, never a flat
 * fill — and every sun-side silhouette edge carries a warm rim stroke. The rim
 * is baked into the authored geometry rather than computed, which costs nothing
 * per frame and is safe here because this event never flips `facing`: the
 * surfer always rides toward +x, so the lit side is always the same side.
 *
 * That package — near-black wetsuit, one reserved saturated hue on the shorts,
 * warm rim down the sun edge — is what makes the rider read as a rim-lit
 * near-silhouette against mid-value water instead of a cutout inside its range.
 */
export interface SurferPose {
  /** 0 = fully extended, 1 = fully compressed over the board. */
  crouch: number
  /** Fore/aft lean relative to the board, radians. Positive leans forward. */
  lean: number
  /** 0 = arms loose, 1 = arms thrown wide and up. */
  reach: number
  /** 0 = arms free, 1 = trailing hand buried in the face behind. */
  drag: number
  /** -1 = shoulders wound back (cutback), +1 = squared up and driving. */
  twist: number
  /** 0 = free, 1 = tucked into a grab. */
  grab: number
  /** Which way the surfer faces: 1 = right (down the line), -1 = left. */
  facing: number
}

const THIGH = 40
const SHIN = 42
const TORSO = 56
const UPPER_ARM = 35
const FOREARM = 33
const HEAD_R = 16
const BOARD_LEN = 196
const BOARD_HALF = BOARD_LEN / 2
/** Hip height above the waterline when fully extended. */
const HIP_HIGH = 90
/** Hip height when fully compressed into a bottom turn. */
const HIP_LOW = 50
/** Top of the deck. The feet stand here and the legs solve to it. */
const DECK_Y = -16

export class Surfer {
  readonly container = new Container()

  private board = new Graphics()
  private fin = new Graphics()
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
  private hair = new Graphics()
  private footBack = new Graphics()
  private footFront = new Graphics()

  /**
   * Uniform scale for the whole rig. It lives here rather than on the container
   * because `apply()` writes scale.x every frame to flip the facing, and an
   * outside `container.scale.set(s)` would be silently overwritten on x only —
   * leaving the rig stretched vertically.
   */
  private baseScale = 1

  /** Secondary motion, smoothed in update(). */
  private hairAngle = 0
  private armLag = 0
  private pose: SurferPose = {
    crouch: 0, lean: 0, reach: 0, drag: 0, twist: 0, grab: 0, facing: 1,
  }

  constructor(
    accent: Hex = Core.suitPrimary,
    boardBase: Hex = 0xbdd6d8,
    light: Hex = Core.sunWhite,
  ) {
    const ink = Core.deepInk
    // One key, from the right, because that is where the sun is. Two values per
    // material and nothing flat.
    const key = keyFromRight(light, 0.95)
    /**
     * The suit, derived by hand rather than through `shadePair`.
     *
     * `shadePair` moves chroma as well as value — it desaturates the lit plane
     * and saturates the shaded one — and that is wrong for the one material in
     * the frame whose whole job is to be the most chromatic thing in it. The
     * rider has to win the chroma contest against a frame that is entirely
     * water, so both planes are held at the suit's own saturation and only the
     * value moves between them. Two values, still; the same chroma.
     */
    const suit = {
      lit: mix(grade(accent, { valScale: 1.16, satScale: 0.97 }), key.tint, 0.06),
      shade: grade(accent, { valScale: 0.70 }),
    }
    const skin = shadePair(Core.skinMid, key)
    // The vest panel and the fin: the same suit, a step down again, so the
    // torso has an internal value break and still reads as one garment.
    const vest = {
      lit: grade(accent, { valScale: 0.92 }),
      shade: grade(accent, { valScale: 0.56 }),
    }
    const board = shadePair(boardBase, key)
    // The rim is hotter than the key itself: it is a specular edge on wet skin
    // and wet neoprene, not diffuse light.
    const rim = mix(light, 0xffffff, 0.3)

    // Limbs on the far side of the body take the shade value, so the silhouette
    // survives overlapping itself. Depth by value, which works against any
    // water colour. Near-side limbs take the lit value and a rim edge.
    // Thicker at the root and half that at the joint, so thigh reads as thigh
    // and calf reads as calf at thumbnail size. Both forearms carry a hand.
    // A full steamer, not boardshorts. Two reasons, and the second one is the
    // reason: it is dawn and the water is cold, and the reserved hue has to
    // cover enough of the silhouette to be findable as *the* chromatic cluster
    // in a frame that is otherwise entirely water. Bare forearms and hands keep
    // a second material in the read so he is not one flat shape.
    //
    // Six different values across the suit, near-side lit and far-side shaded,
    // so a garment that is one hue is still not one tone.
    bone(this.thighBack, THIGH, 20, darken(suit.shade, 0.18), ink)
    bone(this.shinBack, SHIN, 16, darken(suit.shade, 0.30), ink)
    bone(this.thighFront, THIGH, 22, suit.lit, ink, rim)
    bone(this.shinFront, SHIN, 18, grade(accent, { valScale: 0.98 }), ink, rim)
    bone(this.upperArmBack, UPPER_ARM, 15, darken(suit.shade, 0.24), ink)
    bone(this.foreArmBack, FOREARM, 12, darken(skin.shade, 0.18), ink, undefined, true)
    bone(this.upperArmFront, UPPER_ARM, 17, suit.lit, ink, rim)
    bone(this.foreArmFront, FOREARM, 14, skin.lit, ink, rim, true)

    foot(this.footBack, darken(skin.shade, 0.24), ink)
    foot(this.footFront, skin.lit, ink, rim)

    // Torso: origin at the hips, running up to the shoulders. Wider at the
    // chest than the skater's, because the surfer is seen more from the front.
    this.torso
      .moveTo(-14, 0)
      .bezierCurveTo(-19, -TORSO * 0.45, -17, -TORSO * 0.8, -14, -TORSO)
      .lineTo(14, -TORSO)
      .bezierCurveTo(17, -TORSO * 0.8, 19, -TORSO * 0.45, 14, 0)
      .closePath()
      .fill(vest.shade)
      .stroke({ color: ink, width: 3.5, join: 'round' })
    // The lit plane is the sun-side half of the chest, with a terminator down
    // the middle of the body — not a horizontal band across the top, which
    // is a highlight from a light that is not where the sun is.
    this.torso
      .moveTo(1, -1)
      .bezierCurveTo(4, -TORSO * 0.45, 3, -TORSO * 0.82, 1.5, -TORSO)
      .lineTo(14, -TORSO)
      .bezierCurveTo(17, -TORSO * 0.8, 19, -TORSO * 0.45, 14, 0)
      .closePath()
      .fill({ color: vest.lit, alpha: 0.95 })
    // Warm rim down the sun edge, and the reserved hue as a chest band so the
    // one saturated colour in the frame reads at the rider's centre of mass.
    this.torso
      .moveTo(-13, -TORSO * 0.30)
      .lineTo(14, -TORSO * 0.37)
      .lineTo(14, -TORSO * 0.52)
      .lineTo(-13.5, -TORSO * 0.45)
      .closePath()
      .fill({ color: accent, alpha: 0.95 })
    this.torso
      .moveTo(14, -1.5)
      .bezierCurveTo(17.4, -TORSO * 0.45, 15.6, -TORSO * 0.8, 13, -TORSO + 1)
      .stroke({ color: rim, width: 3.2, alpha: 0.92, cap: 'round' })

    this.head.circle(0, 0, HEAD_R).fill(skin.lit).stroke({ color: ink, width: 3.5 })
    // Core shadow on the away side of the skull, then the rim arc on the sun
    // side. A circle with neither is the thing that reads as a sticker.
    this.head
      .moveTo(-HEAD_R + 1, -HEAD_R * 0.5)
      .arc(0, 0, HEAD_R - 1.5, Math.PI * 0.72, Math.PI * 1.34)
      .stroke({ color: skin.shade, width: 5, alpha: 0.85, cap: 'round' })
    const rimR = HEAD_R - 1.4
    this.head
      .moveTo(Math.cos(-1.2) * rimR, Math.sin(-1.2) * rimR)
      .arc(0, 0, rimR, -1.2, 0.92)
      .stroke({ color: rim, width: 3, alpha: 0.9, cap: 'round' })
    // Wet hair swept back: one shape, so it still reads at 130px tall.
    this.hair
      .moveTo(-HEAD_R - 1, -4)
      .quadraticCurveTo(-4, -HEAD_R - 8, HEAD_R + 1, -7)
      .quadraticCurveTo(HEAD_R - 2, 1, HEAD_R - 6, 3)
      .quadraticCurveTo(0, -6, -HEAD_R - 3, 4)
      .closePath()
      .fill(darken(Core.hairSun, 0.62))
      .stroke({ color: ink, width: 2.5, join: 'round' })
    this.hair
      .moveTo(-2, -HEAD_R - 5.5)
      .quadraticCurveTo(8, -HEAD_R - 3, HEAD_R + 0.5, -7.5)
      .stroke({ color: rim, width: 2.4, alpha: 0.75, cap: 'round' })

    // The board, and it has to have **mass**. A neutral review of a sibling
    // event said the board there was "a hairline" and that the whole subject
    // read as a placeholder because of it. So: 196 long and 24 thick through
    // the middle, a squash tail you can see the end of, a pointed nose with
    // rocker in it, and three planes rather than one fill — deck catching the
    // sun, rail rolling under into shade, and a warm specular the length of the
    // sun edge. The reserved hue runs the rail as a pinline.
    // Held below the lit lip on purpose: a paper-white board at this size is
    // the brightest object in the frame and the eye lands on it before it
    // lands on the rider, which is the focal-order failure the whole rebuild
    // is about. It is a pale sea-glass instead, with one specular on the rail.
    const deckLit = board.lit
    const deckShade = mix(board.shade, Core.suitDark, 0.3)
    const railShade = mix(board.shade, Core.suitDark, 0.58)
    const deck = (g: Graphics): Graphics => g
      .moveTo(-BOARD_HALF, DECK_Y + 12)
      .quadraticCurveTo(-BOARD_HALF * 0.55, DECK_Y - 1, BOARD_HALF * 0.40, DECK_Y - 2)
      .quadraticCurveTo(BOARD_HALF * 0.88, DECK_Y - 1, BOARD_HALF, DECK_Y + 11)
    // Silhouette: deck line out to the nose, bottom back to the squash tail.
    deck(this.board)
      .quadraticCurveTo(BOARD_HALF * 0.88, DECK_Y + 19, BOARD_HALF * 0.40, DECK_Y + 22)
      .quadraticCurveTo(-BOARD_HALF * 0.55, DECK_Y + 25, -BOARD_HALF, DECK_Y + 23)
      .closePath()
      .fill(railShade)
      .stroke({ color: ink, width: 3.5, join: 'round' })
    // The deck: the plane the feet are on, turned up toward the sun.
    deck(this.board)
      .quadraticCurveTo(BOARD_HALF * 0.5, DECK_Y + 10.5, -BOARD_HALF * 0.45, DECK_Y + 12.5)
      .closePath()
      .fill(deckLit)
    // The rail below it, one step down in value: this is the turn of the edge,
    // and it is what a flat fill cannot give.
    this.board
      .moveTo(-BOARD_HALF * 0.97, DECK_Y + 14.5)
      .quadraticCurveTo(BOARD_HALF * 0.5, DECK_Y + 12, BOARD_HALF * 0.93, DECK_Y + 14)
      .quadraticCurveTo(BOARD_HALF * 0.5, DECK_Y + 18, -BOARD_HALF * 0.95, DECK_Y + 20)
      .closePath()
      .fill(deckShade)
    // The reserved hue as a pinline down the rail.
    this.board
      .moveTo(-BOARD_HALF * 0.9, DECK_Y + 17.5)
      .quadraticCurveTo(BOARD_HALF * 0.4, DECK_Y + 15, BOARD_HALF * 0.9, DECK_Y + 16)
      .stroke({ color: accent, width: 3.4, cap: 'round' })
    this.board
      .moveTo(-BOARD_HALF + 6, DECK_Y + 11.5)
      .quadraticCurveTo(-BOARD_HALF * 0.55, DECK_Y + 0.4, BOARD_HALF * 0.40, DECK_Y - 0.6)
      .quadraticCurveTo(BOARD_HALF * 0.86, DECK_Y + 0.4, BOARD_HALF - 5, DECK_Y + 9.6)
      .stroke({ color: rim, width: 2.8, alpha: 0.95, cap: 'round' })
    // A traction pad over the tail and a leash plug: at a third of the frame
    // height the deck is 450 screen pixels of one colour without them, and an
    // unbroken plane that size is where a reviewer starts saying "placeholder".
    this.board
      .moveTo(-BOARD_HALF * 0.92, DECK_Y + 9.5)
      .quadraticCurveTo(-BOARD_HALF * 0.66, DECK_Y + 6.4, -BOARD_HALF * 0.36, DECK_Y + 6.2)
      .lineTo(-BOARD_HALF * 0.34, DECK_Y + 11.4)
      .quadraticCurveTo(-BOARD_HALF * 0.66, DECK_Y + 11.6, -BOARD_HALF * 0.9, DECK_Y + 14.2)
      .closePath()
      .fill({ color: darken(vest.shade, 0.35), alpha: 0.9 })
    for (let i = 0; i < 3; i++) {
      const px = -BOARD_HALF * (0.86 - i * 0.18)
      this.board
        .moveTo(px, DECK_Y + 9.4)
        .lineTo(px + 1.4, DECK_Y + 13.2)
        .stroke({ color: ink, width: 1.4, alpha: 0.5 })
    }
    // The leash, running off the tail plug and trailing in the water behind.
    this.board
      .moveTo(-BOARD_HALF * 0.97, DECK_Y + 13)
      .quadraticCurveTo(-BOARD_HALF * 1.34, DECK_Y + 26, -BOARD_HALF * 1.52, DECK_Y + 46)
      .stroke({ color: ink, width: 2.6, alpha: 0.55, cap: 'round' })

    // A thruster's centre fin, long enough to read as a fin and not a burr.
    this.fin
      .moveTo(-BOARD_HALF * 0.80, DECK_Y + 22)
      .quadraticCurveTo(-BOARD_HALF * 0.90, DECK_Y + 46, -BOARD_HALF * 0.60, DECK_Y + 50)
      .quadraticCurveTo(-BOARD_HALF * 0.58, DECK_Y + 32, -BOARD_HALF * 0.56, DECK_Y + 22)
      .closePath()
      .fill(vest.shade)
      .stroke({ color: ink, width: 2.5, join: 'round' })

    // The feet never move, so they are placed once, here.
    this.footBack.position.set(-BOARD_HALF * 0.46, DECK_Y)
    this.footFront.position.set(BOARD_HALF * 0.3, DECK_Y)

    // Draw order is depth order: far limbs, board, near limbs, body, head. The
    // back foot goes down before the board so it reads as being on the far
    // rail; the front foot goes over it.
    this.container.addChild(
      this.thighBack, this.shinBack,
      this.upperArmBack, this.foreArmBack,
      this.footBack,
      this.fin, this.board,
      this.footFront,
      this.thighFront, this.shinFront,
      this.torso,
      this.head, this.hair,
      this.upperArmFront, this.foreArmFront,
    )
    this.container.interactiveChildren = false
  }

  /** Overall size of the rig. Survives the per-frame facing flip. */
  setScale(s: number): void {
    this.baseScale = s
    this.container.scale.set(s)
  }

  setPose(pose: Partial<SurferPose>): void {
    Object.assign(this.pose, pose)
  }

  /** Secondary motion. Call once per simulation step. */
  update(dt: number, angularVelocity: number, speed: number): void {
    // Hair and arms lag behind rotation, and the hair also streams with speed —
    // offshore wind at dawn, which is why this wave is glassy in the first place.
    const target = clamp(-angularVelocity * 0.06 - speed * 0.00035, -0.7, 0.7)
    this.hairAngle = damp(this.hairAngle, target, 0.004, dt)
    this.armLag = damp(this.armLag, target * 0.7, 0.008, dt)
  }

  /** Recompute the rig from the current pose. Transform writes only. */
  apply(): void {
    const p = this.pose
    const f = p.facing >= 0 ? 1 : -1
    this.container.scale.set(f * this.baseScale, this.baseScale)

    const crouch = clamp(p.crouch, 0, 1)
    const hipY = -lerp(HIP_HIGH, HIP_LOW, crouch)
    // The hips move back over the tail as the surfer compresses; a surfer who
    // squats straight down is a surfer about to go over the front.
    const hipX = lerp(2, -16, crouch) + Math.sin(p.lean) * 10 + p.twist * 6

    // Feet stay bolted to the deck; the hips move and the knees resolve. The
    // ankle sits a little above the deck line, which is where the shin ends.
    const footBackX = -BOARD_HALF * 0.46
    const footFrontX = BOARD_HALF * 0.3
    const footY = DECK_Y - 8

    this.solveLeg(this.thighBack, this.shinBack, hipX - 6, hipY, footBackX, footY, -1)
    this.solveLeg(this.thighFront, this.shinFront, hipX + 6, hipY, footFrontX, footY, -1)

    this.torso.position.set(hipX, hipY)
    this.torso.rotation = p.lean * 0.8 + this.armLag * 0.15 - p.twist * 0.12
    // Shoulders shorten as the torso turns away, which is all the 3/4 rotation
    // a flat rig needs to sell a wound-up cutback.
    const openness = 1 - Math.abs(p.twist) * 0.34
    this.torso.scale.x = openness

    const shoulderX = hipX + Math.sin(this.torso.rotation) * -TORSO
    const shoulderY = hipY + Math.cos(this.torso.rotation) * -TORSO

    this.head.position.set(
      shoulderX + Math.sin(this.torso.rotation) * -(HEAD_R + 5),
      shoulderY + Math.cos(this.torso.rotation) * -(HEAD_R + 5),
    )
    this.head.rotation = this.torso.rotation * 0.55
    this.hair.position.copyFrom(this.head.position)
    this.hair.rotation = this.head.rotation + this.hairAngle * 0.4

    const reach = clamp(p.reach, 0, 1)
    const drag = clamp(p.drag, 0, 1)
    const grab = clamp(p.grab, 0, 1)

    const backShoulderX = shoulderX - 7 * openness
    const frontShoulderX = shoulderX + 7 * openness
    const armSpan = (UPPER_ARM + FOREARM) * 0.93

    // Trailing arm. Free, it counterbalances; dragging, it goes down and behind
    // into the wall of the wave.
    const backAngle = lerp(1.0, -0.3, reach) + this.armLag * 0.5 - p.twist * 0.5
    const freeBackX = backShoulderX + Math.cos(backAngle + Math.PI * 0.84) * armSpan
    const freeBackY = shoulderY + Math.sin(backAngle + Math.PI * 0.84) * armSpan
    const dragX = -BOARD_HALF * 0.92
    const dragY = 26
    this.solveArm(
      this.upperArmBack, this.foreArmBack, backShoulderX, shoulderY,
      lerp(freeBackX, dragX, drag), lerp(freeBackY, dragY, drag), 1,
    )

    // Leading arm: points down the line when trimming, up and open on a reach,
    // and locks to the rail on a grab.
    const grabX = BOARD_HALF * 0.14
    const grabY = DECK_Y + 4
    const frontAngle = lerp(0.5, -0.78, reach) + this.armLag * 0.6 + p.twist * 0.28
    const freeFrontX = frontShoulderX + Math.cos(frontAngle + Math.PI * 0.1) * armSpan
    const freeFrontY = shoulderY + Math.sin(frontAngle + Math.PI * 0.1) * armSpan
    this.solveArm(
      this.upperArmFront, this.foreArmFront, frontShoulderX, shoulderY,
      lerp(freeFrontX, grabX, grab), lerp(freeFrontY, grabY, grab), -1,
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
    upper: Graphics, fore: Graphics,
    shX: number, shY: number, handX: number, handY: number, elbowDir: number,
  ): void {
    const elbow = ik2(shX, shY, handX, handY, UPPER_ARM, FOREARM, elbowDir)
    upper.position.set(shX, shY)
    upper.rotation = Math.atan2(elbow.y - shY, elbow.x - shX)
    fore.position.set(elbow.x, elbow.y)
    fore.rotation = Math.atan2(handY - elbow.y, handX - elbow.x)
  }

  /** Where the tail of the board is, in the surfer's local frame. Spray origin. */
  get tailX(): number { return -BOARD_HALF }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}

/**
 * A limb drawn from its proximal joint along +X.
 *
 * Two things here are not decoration. The **taper** is hard — the distal end is
 * half the proximal one — because a neutral review looked at a sibling event's
 * rider at thumbnail size and called it "a jointless stick figure: limbs are
 * identical-width rounded rectangles". A capsule of constant width has no
 * elbow, no wrist and no direction; a wedge has all three.
 *
 * The optional **hand** is the other half of that note. A forearm that stops at
 * the wrist reads as an amputation at any size above a hundred pixels, and this
 * rig is drawn at two hundred.
 *
 * `rim`, when given, draws a warm specular along the limb's upper edge. On a
 * rig whose limbs rotate this is an approximation — but the near-side limbs
 * spend the whole ride between horizontal and up-and-forward, which is the
 * quadrant that faces the sun, so it holds.
 */
function bone(
  g: Graphics, length: number, width: number, fill: Hex, ink: Hex,
  rim?: Hex, hand = false,
): void {
  const r = width / 2
  const tip = r * 0.5
  g.moveTo(0, -r)
    .lineTo(length, -tip)
    .arc(length, 0, tip, -Math.PI / 2, Math.PI / 2)
    .lineTo(0, r)
    .arc(0, 0, r, Math.PI / 2, -Math.PI / 2)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 3, join: 'round' })
  if (hand) {
    // A closed fist, thumb side up, angled slightly off the forearm axis so it
    // never reads as one more segment of the same tube.
    g.moveTo(length - tip * 0.4, -tip * 1.05)
      .quadraticCurveTo(length + r * 1.5, -r * 1.5, length + r * 2.5, -r * 0.35)
      .quadraticCurveTo(length + r * 2.6, r * 1.1, length + r * 1.2, r * 1.5)
      .quadraticCurveTo(length + r * 0.2, r * 1.5, length - tip * 0.4, tip * 1.05)
      .closePath()
      .fill(fill)
      .stroke({ color: ink, width: 2.6, join: 'round' })
  }
  if (rim !== undefined) {
    g.moveTo(r * 0.5, -r + 0.7)
      .lineTo(length - r * 0.4, -tip + 0.7)
      .stroke({ color: rim, width: Math.max(1.7, width * 0.2), alpha: 0.8, cap: 'round' })
  }
}

/**
 * A foot on the deck, heel at -x and toes at +x.
 *
 * Drawn as its own object at a fixed place on the board rather than hung off
 * the end of the shin, because a surfer's feet do not move: they are bolted
 * across the stringer and everything above them articulates. That also means
 * they cost nothing — no transform is ever written to them.
 */
function foot(g: Graphics, fill: Hex, ink: Hex, rim?: Hex): void {
  g.moveTo(-10, -13)
    .lineTo(4, -13)
    .quadraticCurveTo(11, -12, 18, -4)
    .quadraticCurveTo(20.5, -0.5, 16, 1)
    .lineTo(-8, 1)
    .quadraticCurveTo(-13.5, 0.5, -10, -13)
    .closePath()
    .fill(fill)
    .stroke({ color: ink, width: 2.8, join: 'round' })
  if (rim !== undefined) {
    g.moveTo(3, -12).quadraticCurveTo(11, -10.6, 17.2, -3.4)
      .stroke({ color: rim, width: 2.2, alpha: 0.85, cap: 'round' })
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
  // Clamp to the reachable range so the limb straightens instead of NaN-ing.
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
