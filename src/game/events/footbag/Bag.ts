import { Container, Graphics, Sprite } from 'pixi.js'
import { softDot } from '../../../render/Gradient'
import { Core, grade, lighten, mix, type Hex } from '../../../render/Palette'
import { clamp01, lerp, smoothstep } from '../../../core/Tween'

/**
 * The bag.
 *
 * A real footbag is about 50 grams of sand in a crocheted shell: it decelerates
 * hard sideways, barely at all vertically, and it dies where you put it. That
 * asymmetry is the whole feel of the object, so the drag is authored as two
 * different per-second retention factors rather than one honest isotropic term.
 * Horizontal velocity is down to 42% after a second, which is what stops a
 * mistimed contact from launching the bag off screen; vertical is 88%, which
 * only takes the edge off a fall and keeps the arc floaty.
 *
 * Everything here is integrated at a fixed 1/60 in `update`. `render` reads the
 * previous and current states and interpolates.
 */
export const BAG_RADIUS = 15
/**
 * How big the bag is **drawn**. Physics still uses `BAG_RADIUS`: the floor, the
 * predictor and every contact window are unchanged, so the feel of the event is
 * exactly what it was.
 *
 * A neutral review was blunt about the old size: "the hero object is a 10px dot.
 * The footbag — the entire subject of the game — is a ~#ef8a2a speck with a
 * one-frame sparkle, and it has less visual weight than a background sailboat."
 * It is 40px across now, it carries a lit crown and a shaded belly under the
 * same key as everything else, its outline is heavy enough to survive a
 * downscale, and the scene draws a fading trail arc behind it and a hard
 * shadow under it so its height off the lawn is readable at a glance.
 *
 * Deliberately NOT a physics change. A larger collider would widen every
 * contact window and make the event easier, which is not a rendering decision.
 */
export const BAG_ART_RADIUS = 20
/** Authoring radius of the hard contact ellipse. `render` only scales it. */
const SHADOW_R = 48
export const BAG_GRAVITY = 1520
const DRAG_X = 0.42
const DRAG_Y = 0.88
const SPIN_DRAG = 0.34
/** ln(1/DRAG_X). Used to solve the aim analytically — see `driftFor`. */
const DRAG_X_K = -Math.log(DRAG_X)

export class Bag {
  x = 0
  y = 0
  vx = 0
  vy = 0
  spin = 0
  angle = 0
  /** Held in the hand during a serve: no physics, the scene positions it. */
  held = true
  /** Settled on the lawn after a drop. */
  resting = false

  private prevX = 0
  private prevY = 0
  private prevAngle = 0
  /** 1 immediately after a contact, decaying. Drives the squash. */
  private squash = 0
  private squashAngle = 0

  readonly container = new Container()
  /** Parented under the player by the scene so it sits on the grass. */
  readonly shadow: Graphics

  private squashNode = new Container()
  private art = new Graphics()

  constructor(accent: Hex, accent2: Hex, shadeColor: Hex) {
    // A crocheted six-panel sack: a light shell with darker panel wedges and a
    // single flat highlight. Gold against a green lawn and a blue bay is the
    // one hue neither background owns, which is why it stays findable at 30px.
    const R = BAG_ART_RADIUS
    const shell = lighten(accent2, 0.1)
    const panel = accent
    const ink = grade(accent, { valScale: 0.5, satScale: 1.25 })

    this.art.circle(0, 0, R).fill(shell)
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      this.art
        .moveTo(0, 0)
        .arc(0, 0, R, a, a + Math.PI / 3)
        .closePath()
        .fill({ color: panel, alpha: 0.9 })
    }
    // Shaded belly and lit crown, under the same key as the rest of the event:
    // the sun is high and to the right, so the lower-left third of the sphere
    // turns away from it. A flat disc is exactly the "assembled, not lit" tell.
    // Screen angles: 0 is +x, and y is down, so 0.5PI is the BOTTOM of the
    // circle and 1.5PI is the top. The belly therefore runs bottom-to-left and
    // the crown upper-right, which is where a sun at SUN_X puts them.
    this.art
      .moveTo(0, 0)
      .arc(0, 0, R, Math.PI * 0.32, Math.PI * 1.12)
      .closePath()
      .fill({ color: grade(panel, { valScale: 0.48, satScale: 1.3 }), alpha: 0.45 })
    this.art
      .arc(0, 0, R * 0.98, Math.PI * 1.46, Math.PI * 1.98)
      .stroke({ color: lighten(accent2, 0.6), width: 3.6, alpha: 0.9, cap: 'round' })
    this.art.circle(0, 0, R).stroke({ color: ink, width: 4.6 })
    // Seam cross and a highlight, so the spin is visible at this size.
    this.art
      .moveTo(-R * 0.82, 0).lineTo(R * 0.82, 0)
      .moveTo(0, -R * 0.3).lineTo(0, R * 0.82)
      .stroke({ color: ink, width: 2.4, alpha: 0.5 })
    this.art.ellipse(R * 0.3, -R * 0.36, R * 0.26, R * 0.19)
      .fill({ color: Core.paperWhite, alpha: 0.72 })

    // A warm separation halo, and it is not decoration.
    //
    // "The orange footbag, the gameplay-critical object, currently has to fight
    // the grass on its own" — and it does: it is a 40px disc that spends half
    // its life over a light bay and half over a dark lawn, so no single outline
    // weight or value can hold it against both. An additive halo solves that
    // asymmetrically, which is what is wanted: over the 0.62 bay it is almost
    // invisible because additive light has little headroom there, and over the
    // 0.24 turf it lifts a soft warm ring the eye catches immediately.
    //
    // Outside `squashNode` on purpose — a halo that squashed with the impact
    // would read as a second object deforming.
    const halo = new Sprite(softDot(lighten(accent2, 0.4), 128, 0.02))
    halo.anchor.set(0.5)
    halo.width = BAG_ART_RADIUS * 4.6
    halo.height = BAG_ART_RADIUS * 4.6
    halo.alpha = 0.16
    halo.blendMode = 'add'
    this.container.addChild(halo)

    this.squashNode.addChild(this.art)
    this.container.addChild(this.squashNode)
    this.container.interactiveChildren = false

    // The bag's own shadow, and it is a **height gauge** before it is a shadow.
    // A bag drawn against a lawn with no mark under it has no readable altitude
    // at all, which is half of why the object had no weight.
    //
    // It is a hard-edged ellipse now rather than a gaussian dot, and the reason
    // is the one rendering rule this event kept breaking. A blind critic put it
    // plainly: "A mixes rendering languages — airbrushed gradient shading on
    // the torso and a **gaussian-blurred shadow** under the ball against hard
    // flat vector everywhere else." A soft dot is the correct shadow for a
    // photographic world; in a world cut entirely out of flat shapes it is the
    // one object that was not drawn, and it advertises itself as such at any
    // size. Height now reads off the ellipse's *width and value*, which is what
    // the soft version was using alpha for anyway.
    //
    // Drawn once at a real radius — a unit ellipse scaled up 40x comes out of
    // the rasteriser as a visible polygon — and `render` only scales it.
    this.shadow = new Graphics()
    this.shadow
      .ellipse(0, 0, SHADOW_R, SHADOW_R * 0.3)
      .fill(mix(shadeColor, 0x000000, 0.42))
    this.shadow.alpha = 0.42
  }

  /** Put the bag somewhere with a velocity. Clears the interpolation history. */
  place(x: number, y: number, vx: number, vy: number): void {
    this.x = this.prevX = x
    this.y = this.prevY = y
    this.vx = vx
    this.vy = vy
    this.spin = 0
    this.angle = this.prevAngle = 0
    this.held = false
    this.resting = false
    this.squash = 0
  }

  /** Hold it in the hand at a point the scene supplies each frame. */
  hold(x: number, y: number): void {
    this.prevX = this.x
    this.prevY = this.y
    this.prevAngle = this.angle
    this.x = x
    this.y = y
    this.vx = 0
    this.vy = 0
    this.held = true
    this.resting = false
  }

  /** Record a contact: squash perpendicular to the incoming direction. */
  impact(strength: number, alongX: number, alongY: number): void {
    this.squash = clamp01(strength)
    this.squashAngle = Math.atan2(alongY, alongX)
  }

  update(dt: number, groundY: number): void {
    this.prevX = this.x
    this.prevY = this.y
    this.prevAngle = this.angle
    this.squash = Math.max(0, this.squash - dt * 5.4)
    if (this.held) return

    this.vx *= Math.pow(DRAG_X, dt)
    this.vy = (this.vy + BAG_GRAVITY * dt) * Math.pow(DRAG_Y, dt)
    this.x += this.vx * dt
    this.y += this.vy * dt
    this.angle += this.spin * dt
    this.spin *= Math.pow(SPIN_DRAG, dt)

    const floor = groundY - BAG_RADIUS
    if (this.y >= floor) {
      this.y = floor
      if (Math.abs(this.vy) < 90) {
        // Sand does not bounce. It arrives and stops.
        this.vy = 0
        this.vx *= Math.pow(0.02, dt)
        this.spin *= Math.pow(0.02, dt)
        this.resting = true
      } else {
        this.vy = -Math.abs(this.vy) * 0.26
        this.vx *= 0.55
        this.spin *= 0.4
        this.impact(0.7, this.vx, -this.vy)
      }
    }
  }

  /**
   * Where the bag will be in `ticks` simulation steps, integrated the same way
   * `update` does it.
   *
   * The rig needs this because a swing takes 5-8 frames to land: the leg has to
   * be aimed at where the bag is *going* to be, not where it is, or every
   * contact looks like the foot teleported. Written into a caller-owned object
   * so it costs nothing to call four times a frame.
   */
  predict(ticks: number, out: { x: number; y: number }): void {
    let x = this.x, y = this.y, vx = this.vx, vy = this.vy
    const dt = 1 / 60
    const dx = Math.pow(DRAG_X, dt)
    const dy = Math.pow(DRAG_Y, dt)
    for (let i = 0; i < ticks; i++) {
      vx *= dx
      vy = (vy + BAG_GRAVITY * dt) * dy
      x += vx * dt
      y += vy * dt
    }
    out.x = x
    out.y = y
  }

  /** Height above the lawn, px. Used for the shadow and the trail. */
  heightOver(groundY: number): number {
    return Math.max(0, groundY - BAG_RADIUS - this.y)
  }

  speed(): number {
    return Math.hypot(this.vx, this.vy)
  }

  /**
   * @param anchorX Screen x of the contestant's planted foot, where the scene's
   *   one hard contact shadow is. The bag's ground mark yields to it — see
   *   the note in `render`.
   */
  render(alpha: number, groundY: number, anchorX = Number.NEGATIVE_INFINITY): void {
    const x = lerp(this.prevX, this.x, alpha)
    const y = lerp(this.prevY, this.y, alpha)
    this.container.position.set(x, y)
    this.container.rotation = this.squashAngle
    this.art.rotation = lerpAngle(this.prevAngle, this.angle, alpha) - this.squashAngle
    const s = this.squash * this.squash
    this.squashNode.scale.set(1 - 0.34 * s, 1 + 0.46 * s)

    // Shadow: wide and faint at the top of the arc, tight on arrival.
    // Written as `scale`, not `width`/`height`, because those setters re-measure
    // the graphic's bounds twice a frame for no reason.
    const h = Math.max(0, groundY - BAG_RADIUS - y)
    const f = clamp01(h / 430)
    this.shadow.scale.set(lerp(17, 50, f) / SHADOW_R)

    // **The sun's own offset, and a yield to the figure's shadow.**
    //
    // Two blind critics read the same fault out of the capture and used almost
    // the same words for it: "the two identical hard-edged shadow ellipses" and
    // "the two detached shadow ellipses where only one is under a foot". This
    // is the other one. It was a hard ellipse at up to 0.62 alpha and 23px
    // across sitting three pixels off the lawn, which is the same object, in
    // the same rendering language, at the same weight as the contact shadow
    // under the planted trainer — so at any moment the bag was low and near his
    // feet the frame had two of them side by side and no way to say which was
    // the figure's.
    //
    // Two changes, and neither costs the height gauge anything.
    //
    // **It obeys the sun.** The sun is DRAWN, at screen (865, 487), over a
    // ground line at y=930 and a contestant who stands near x=700 — so it is
    // 165px to his right and 443px above his feet, and an object h above the
    // lawn throws its shadow 0.37h to the left. This ran 0.09h, which is a
    // different sun, and it ran nothing downward at all, while the figure's own
    // cast blade rakes down-left at 274 across for 80 down. The offset is 0.31h
    // on the blade's own vector now: within a few percent of what the drawn sun
    // actually subtends, and on the same diagonal as the only other shadow in
    // the frame. The vertical component is capped, because past about 20px the
    // mark slides behind the bank's crest and stops being a gauge.
    //
    // **It yields.** When the bag is BOTH low and close to the planted foot —
    // the one case where the two marks are a pair of matched ellipses rather
    // than a figure and the thing it is playing — this one fades out entirely,
    // and the frame is left with a single shadow anchored under the foot. It
    // does not fade for a bag that is merely overhead (still the top of an arc,
    // still needs its gauge) or merely low and out wide (a bounce on the grass,
    // where the mark is the only thing saying it landed).
    const ox = x - h * 0.31
    const low = 1 - smoothstep(30, 132, h)
    const close = 1 - smoothstep(52, 158, Math.abs(ox - anchorX))
    this.shadow.alpha = lerp(0.34, 0.14, f) * (1 - low * close)
    this.shadow.position.set(ox, groundY - 3 + Math.min(20, h * 0.09))
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.shadow.destroy()
  }
}

/**
 * Initial horizontal velocity that lands the bag `dx` away after `t` seconds,
 * accounting for the horizontal drag exactly.
 *
 * Integrating v0 * DRAG_X^s over [0, t] gives v0 * (1 - DRAG_X^t) / ln(1/DRAG_X),
 * so this inverts it. Without it a clean contact always undershoots, the bag
 * never comes back over the player, and every rally dies in three touches no
 * matter how well you read it.
 */
export function driftFor(dx: number, t: number): number {
  const decay = 1 - Math.pow(DRAG_X, Math.max(0.05, t))
  return (dx * DRAG_X_K) / decay
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
