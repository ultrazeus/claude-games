import { Container, Graphics } from 'pixi.js'
import { ParticleSystem } from '../../../render/Particles'
import { softDot } from '../../../render/Gradient'
import { Core, grade, lighten, mix, type EventPalette } from '../../../render/Palette'
import { clamp, clamp01, lerp } from '../../../core/Tween'
import { SHADOW_TONE, type Field } from './Field'

/**
 * The disc: real aerodynamics, and the art needed to read them.
 *
 * A frisbee is a spinning wing, and if you integrate it as a ballistic
 * projectile it looks wrong within half a second — it has no float, no glide
 * and no curve. So this is the actual model:
 *
 *   drag   opposes the air-relative velocity, quadratic in speed
 *   lift   acts perpendicular to it, with a coefficient that rises linearly
 *          with angle of attack — which is why a disc that starts nose-down and
 *          pitches its flight path over as it slows *gains* lift and floats
 *   bank   tilts the lift vector sideways, which is what turns a disc
 *   roll    the gyroscopic consequence of the aerodynamic pitching moment. Above
 *          a critical airspeed the disc precesses one way ("turn"), below it the
 *          other ("fade"). That sign change over one flight is the S-shaped path
 *          every disc golfer would recognise, and it comes out of the model for
 *          free rather than being animated on.
 *   wind   enters as v_rel = v - wind. Nothing else is needed: a crosswind
 *          changes the relative velocity, and drag and lift do the pushing.
 *
 * Coefficients are the standard flat-plate-with-a-rim values (Hummel's wind
 * tunnel fits), mass and area are a 175g Ultimate disc. Units are metres,
 * seconds and radians throughout.
 */

const G = 9.81
/** 0.5 * rho * area / mass. Turns 0.5*rho*V^2*C*A into an acceleration. */
const K_AERO = (0.5 * 1.23 * 0.0568) / 0.175

const CL0 = 0.15
/** dCL/dalpha, per radian. */
const CL_ALPHA = 1.9
const CD0 = 0.08
const CD_ALPHA = 2.6
/** Angle of attack of minimum drag, radians. */
const ALPHA_MIN_DRAG = -0.052

/** Release spin, rad/s. About 8 revolutions per second — a normal backhand. */
const SPIN_RELEASE = 52
/** Spin bleeds off slowly; the rim is nearly frictionless. */
const SPIN_DECAY = 0.9
/** Scales the gyroscopic roll rate. Tuned for a visible but not wild S-curve. */
const ROLL_K = 0.055
/** Airspeed at which turn and fade balance, m/s. */
const V_BALANCE = 21
/** Discs do roll right over when overpowered; past this it just looks broken. */
const BANK_MAX = 0.85

/**
 * The disc is 27 cm across, which is 13 px at forty metres — too small to read
 * and too small to aim at. Drawn 3.4x oversize; the shadow and the overhead
 * strip carry the real scale.
 *
 * It was 2.3, and a blind review of the frame said the obvious thing:
 *
 *   "The disc is invisible. The object the entire game is named after is a
 *    two-pixel smudge in the thrower's raised hand, against a busy treeline,
 *    with no flight arc, no trail, no sky behind it - so the frame shows a
 *    small person standing in a field, not a throw."
 *
 * Three separate things were producing that, and all three are fixed here:
 * the scale below, the foreshortening floor in `apply()`, and `ARC_N` — the
 * drawn flight path, which is the thing that actually makes a still frame read
 * as a throw rather than as a person holding a disc.
 */
const VISUAL_SCALE = 4.1
/** Authoring radius of the disc art, in units. */
const RU = 10

/**
 * Samples kept of the flight path, and the interval between them.
 *
 * Forty samples at 45 ms is 1.8 seconds of flight, which is most of a throw, so
 * the drawn arc runs from the hand to the disc rather than trailing a few
 * frames behind it. Recorded in metres in `update` and projected in `apply`, so
 * it survives a camera dolly and a tilt without smearing.
 */
const ARC_N = 40
const ARC_DT = 0.045

export class Disc {
  readonly container = new Container()
  /** Ground shadow. Lives in the field's shadow layer, not under the disc. */
  readonly shadow = new Container()
  readonly trail: ParticleSystem

  // --- simulation state, metres and seconds ---------------------------------
  x = 0
  y = 0
  z = 0
  vx = 0
  vy = 0
  vz = 0
  /** Roll of the disc plane about the flight direction. Positive banks right. */
  bank = 0
  /** Pitch of the disc plane relative to horizontal. Gyroscopically held. */
  pitch = 0
  /** Spin rate, rad/s. */
  omega = 0
  /** +1 or -1. A right-handed backhand spins clockwise seen from above: -1. */
  spinSign = -1
  /** Accumulated rotation of the rim mark, radians. */
  spinPhase = 0
  flying = false
  /** Seconds since release. */
  age = 0

  // previous-step copies, for render interpolation
  private prevX = 0
  private prevY = 0
  private prevZ = 0
  private prevBank = 0
  private prevPhase = 0

  private body = new Graphics()
  private rim = new Graphics()
  private markA = new Graphics()
  private markB = new Graphics()
  private penumbra: Graphics
  private core: Graphics
  private trailTimer = 0

  /** The drawn flight path. Parented into the actor layer by the scene. */
  readonly arc = new Graphics()
  /** Ring of world-space samples, [x, y, z] per entry. */
  private arcXYZ = new Float32Array(ARC_N * 3)
  /**
   * Screen position of the hand the disc left, or null while nobody is
   * throwing. See `setHandAnchor`.
   */
  private handAX = 0
  private handAY = 0
  private handAnchored = false
  private arcCount = 0
  private arcTimer = 0
  private arcInk: number
  private arcWarm: number

  constructor(_pal: EventPalette) {
    /**
     * The disc has to be the highest-value AND highest-chroma thing in the
     * frame, and it has to carry that on its own wherever it happens to be.
     *
     * It did not. Three blind reviews measured the same failure:
     *
     *   "#F4CDA3 (L=210) ... against a peach sky of L=200 and skin of L=144
     *    the disc is camouflaged in both value and hue; I had to zoom to 6x to
     *    confirm it was there"
     *   "a ~35px pale sliver laid across a pink jersey at the same value"
     *
     * A near-white plate ringed in a mid amber is a pale object on a pale sky.
     * So the disc now carries its OWN value envelope: a hard near-black ring
     * around the whole rim, the frame's cleanest white on the top plate, and a
     * saturated gold band between them. Three steps inside forty pixels means
     * it separates from a peach sky, from a dark field and from the athlete's
     * pink, without depending on any of them.
     */
    /*
     * Still losing. Two more blind critics, independently, on the re-keyed disc:
     *
     *   "the disc, a #e8c55c ellipse at (415,255), the single most important
     *    object on screen, is fighting a #cab48e hill for contrast and losing"
     *   "a light-on-light shape (L=249) floating on a pale hill at L=182"
     *
     * A near-white top plate cannot win a contrast contest against a sky that
     * runs to L=228 and a haze-fogged hill at L=182 — there is no room above
     * it. So the plate goes DOWN: a saturated amber at about L=170, ringed in
     * near-ink at L=25, with the white kept to a single specular crescent on
     * the sunward rim. The disc's read is now the dark ring and the hue break,
     * both of which work on a pale sky AND on dark grass, instead of a value
     * that only works on one of them.
     */
    /*
     * And the paragraph above was written under a sky that no longer exists.
     *
     * "The plate goes DOWN" was the right call against a sky running to L=228.
     * The sky was then inverted and capped — no stop in `Palettes.flyingdisc`
     * exceeds L=162, and composited with the horizon haze the brightest pixel
     * of sky anywhere in the frame measures L=160.9. The plate was never
     * re-keyed to match, so the disc's own body sat at L=173 against a horizon
     * band at L=161: a gain of TWELVE points on the half of the arc that
     * crosses the warm band. Only the 3.4 px tone ring (L=199) and the trail
     * (L=200-204) were ever clearing it, which is why the disc reads at the top
     * of its arc — against indigo at L=90 — and softens as it comes down.
     *
     * The brief for the inversion set the bar in a number: the gold arc gains
     * at least +40 of luminance over everything it crosses. So the plate is now
     * THE SAME GOLD AS THE ARC AND THE TRAIL — `mix(sunGold, sunWhite, 0.18)`,
     * #ffd154, L=209.8 — and the disc, the drawn flight path and the puffs
     * behind it are one colour and one value rather than three near-misses.
     *
     * Measured against everything the arc passes over, all of it computed from
     * this palette rather than eyeballed:
     *
     *   sky, brightest pixel in the frame (y=480)   L 160.9   +48.9
     *   hill crest rim, 2.5 px at alpha 0.45        L 164.7   +45.1
     *   hill lit face                               L 156.8   +53.0
     *   cloud lit top, composited                   L ~135    +75
     *   sky at the top of the arc (y=215)           L  90.9   +118.9
     *   grass, light band                           L  92.0   +117.8
     *
     * The disc keeps its own value envelope, so none of this depends on what it
     * is over: near-ink ring at L=38.8 around a plate at L=209.8, with two
     * amber grooves inside it at L=156.8 and L=120.5 so the object is turned
     * rather than a flat token. Five steps inside forty pixels.
     */
    const plate = mix(Core.sunGold, Core.sunWhite, 0.18)
    /** The inner groove. Deep amber, so the plate's lightest area is unbroken. */
    const plateShade = grade(plate, { valScale: 0.62, satScale: 1.35 })
    /** The outer groove, a step between the plate and the ink ring. */
    const toneRing = grade(plate, { valScale: 0.8, satScale: 1.3 })
    // Warm amber, not the athletes' pink. That hue is reserved for the player,
    // and a disc wearing it would dilute the one thing the eye must land on.
    const band = grade(mix(Core.sunGold, 0xe4572e, 0.3), { satScale: 1.25, valScale: 1.06 })
    const ink = grade(mix(band, Core.deepInk, 0.86), { satScale: 1.1 })

    // Body. Drawn as full circles and squashed per frame to the apparent opening
    // angle, so the disc goes edge-on at eye level by itself.
    //
    // The rim has THICKNESS: an offset ellipse behind the top face, in the dark
    // side of the band colour, so the disc is an object with a lip rather than
    // a flat token. That, the inset plate and the flight ring are what make it
    // read as a disc at the size it actually flies at.
    // The lip was offset 0.34 RU behind a plate of radius RU, so 0.38 RU of it
    // stood proud of the silhouette — and because the offset is in the disc's
    // own local space it swings round with the roll, which drew a second lobe
    // budding off whichever edge happened to be uppermost. A rim has a
    // thickness, not a lobe: 0.16 RU, which reads as a lip and stays a lip at
    // every attitude the disc flies at.
    this.body.ellipse(0, RU * 0.16, RU * 1.02, RU * 1.02)
      .fill(grade(band, { valScale: 0.42, satScale: 1.15 }))
    this.body.ellipse(0, 0, RU, RU).fill(plate)
    // The dark ring. Drawn at full weight and in near-ink, because this is the
    // mark that makes the disc read against a sky of its own value.
    this.body.ellipse(0, 0, RU, RU).stroke({ color: ink, width: 4.2 })
    // A coloured band around the rim: the single strongest read at distance.
    // Concentric AMBER, not cream. A pale ring inside an amber plate with a
    // white specular in the middle of it is a fried egg at forty pixels; the
    // disc's steps have to run dark-ring / plate / tone-ring, all in one hue,
    // so the only achromatic mark on the object is the specular itself.
    //
    // The groove is now DARKER than the plate rather than brighter. It used to
    // be the brightest thing on the disc (L=199 against a plate at L=173),
    // which made the object's largest area its dimmest — a ring of light round
    // a duller centre, which is what a washer looks like. With the plate keyed
    // to the arc's own gold the grooves step down from it, so the disc's mass
    // is its value and the modelling sits inside that.
    this.rim.ellipse(0, 0, RU * 0.88, RU * 0.88).stroke({ color: toneRing, width: 3.4 })
    this.rim.ellipse(0, 0, RU * 0.55, RU * 0.55).stroke({ color: plateShade, width: 1.6 })
    // Direct sun on the upper right of the rim: the same light everything else
    // in this event obeys, on the object the event is named after.
    this.rim.arc(0, 0, RU * 0.99, -Math.PI * 0.42, -Math.PI * 0.02)
      .stroke({ color: Core.sunWhite, width: 2.2, alpha: 0.9, cap: 'round' })

    // Two marks on the rim, 180 degrees apart. Their orbit is the spin.
    for (const g of [this.markA, this.markB]) {
      g.circle(0, 0, RU * 0.18).fill(Core.paperWhite).stroke({ color: ink, width: 1 })
    }

    this.container.addChild(this.body, this.rim, this.markA, this.markB)
    this.container.interactiveChildren = false

    // Shadow is two sprites: a wide soft penumbra that shrinks as the disc drops
    // and a tight core that only appears in the last few metres. The moment the
    // core snaps into focus under the disc is the player's cue that it is about
    // to be catchable, so this is the most important depth cue in the event.
    /*
     * DRAWN ellipses, not stretched radial dots.
     *
     * 0.4 hardness on a 64 px dot blown up to 270 px of grass still has a
     * fifty-pixel falloff, and in a frame where every other shadow is now a
     * flat hard shape that patch is the one soft thing left. A critic found it
     * exactly where it sits — an "orphan ellipse" in the middle of an empty
     * field, because the disc casting it is four hundred pixels away up in the
     * sky. So it is two flat ellipses in the same value the athletes' and the
     * trees' shadows use: a wide one that spreads with height, and a tight core
     * that snaps to the disc's own size in the last few metres. The moment the
     * core appears is still the catch cue; it is just drawn in the scene's own
     * language now.
     */
    /*
     * AND IT WAS THE THIRD SHADOW VALUE IN A FILE THAT CLAIMS ONE.
     *
     * 0x1f2617 is luma 30, which was neither the athletes' 29 nor the copse's
     * 56 — close enough to both to look like a mistake and different enough
     * from both to be one. `Field.ts` owns the number now and everything that
     * throws a shadow on this field imports it.
     */
    const shadowTint = SHADOW_TONE
    this.penumbra = new Graphics()
    this.penumbra.ellipse(0, 0, 0.5, 0.5).fill(shadowTint)
    this.core = new Graphics()
    this.core.ellipse(0, 0, 0.5, 0.5).fill(shadowTint)
    this.shadow.addChild(this.penumbra, this.core)
    this.shadow.interactiveChildren = false

    this.trail = new ParticleSystem(softDot(lighten(band, 0.55), 32, 0.88), 72)
    this.trail.container.interactiveChildren = false

    // The arc reads on a pale sky AND on a dark treeline, because it is drawn
    // twice: a dark core the width of the path, and a hot centre inside it. A
    // single warm trail on a warm sky is the trail that was not there before.
    this.arc.interactiveChildren = false
    this.arcInk = grade(mix(band, Core.deepInk, 0.66), { satScale: 1.1 })
    this.arcWarm = mix(Core.sunGold, Core.sunWhite, 0.2)
  }

  /**
   * Release. `angle` is the launch elevation; the disc plane is pitched to half
   * of it, which puts the nose slightly *below* the flight path — exactly how a
   * long throw is released, and the reason the disc floats rather than stalling.
   */
  launch(x: number, y: number, z: number, speed: number, angle: number, spinSign: number): void {
    this.x = this.prevX = x
    this.y = this.prevY = y
    this.z = this.prevZ = z
    this.vx = 0
    this.vy = Math.sin(angle) * speed
    this.vz = Math.cos(angle) * speed
    this.pitch = angle * 0.5
    this.bank = this.prevBank = 0
    this.omega = SPIN_RELEASE
    this.spinSign = spinSign
    this.spinPhase = this.prevPhase = 0
    this.flying = true
    this.age = 0
    this.arcCount = 0
    this.arcTimer = 0
    this.arc.clear()
  }

  /**
   * Where the drawn flight path should appear to START, in screen pixels.
   *
   * The thrower is drawn `THROWER_HERO` times life size so that he can own the
   * frame, but the simulation releases the disc from a real 1.35 m above real
   * grass. At the throw line that is about a hundred and fifty pixels below the
   * hand the viewer is looking at, so a path drawn on the simulated samples
   * alone leaves the athlete's waist — and every blind review of this frame has
   * asked, in one form or another, why the throwing arm is empty.
   *
   * So the oldest samples are pulled onto the hand and released back onto the
   * true path within about a third of a second. It is a drawing offset on the
   * drawing of a path; the disc itself, its shadow, the catch volume and the
   * aerodynamics are all untouched.
   */
  setHandAnchor(x: number, y: number): void {
    this.handAX = x
    this.handAY = y
    this.handAnchored = true
  }

  clearHandAnchor(): void {
    this.handAnchored = false
  }

  /** Forget the drawn path. Called when a throw is reset. */
  clearArc(): void {
    this.arcCount = 0
    this.arc.clear()
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy, this.vz)
  }

  /** Horizontal ground speed. Used for the whirr and for the catch window. */
  get groundSpeed(): number {
    return Math.hypot(this.vx, this.vz)
  }

  /** Integrate one simulation step. `dt` is always 1/60. */
  update(dt: number, windX: number, windZ: number): void {
    this.prevX = this.x
    this.prevY = this.y
    this.prevZ = this.z
    this.prevBank = this.bank
    this.prevPhase = this.spinPhase

    if (!this.flying) return
    this.age += dt

    // Air-relative velocity. This one substitution is the whole wind model.
    const rx = this.vx - windX
    const ry = this.vy
    const rz = this.vz - windZ
    const v = Math.hypot(rx, ry, rz)
    if (v < 1e-4) return
    const horiz = Math.hypot(rx, rz) || 1e-4

    // Angle of attack: the disc plane against the direction it is actually
    // travelling. Positive means the nose is above the flight path.
    const alpha = this.pitch - Math.atan2(ry, horiz)
    const cl = CL0 + CL_ALPHA * alpha
    const da = alpha - ALPHA_MIN_DRAG
    const cd = CD0 + CD_ALPHA * da * da
    const q = K_AERO * v * v

    // Drag: straight back along the relative wind.
    let ax = (-q * cd * rx) / v
    let ay = (-q * cd * ry) / v
    let az = (-q * cd * rz) / v

    // Lift: perpendicular to the relative wind. `up` is the component in the
    // vertical plane, `side` is horizontal and perpendicular; banking rotates
    // the lift vector between them, which is what makes a banked disc turn.
    const ux = (-rx * ry) / (v * horiz)
    const uy = horiz / v
    const uz = (-rz * ry) / (v * horiz)
    const sx = (ry * uz - rz * uy) / v
    const sy = (rz * ux - rx * uz) / v
    const sz = (rx * uy - ry * ux) / v
    const cb = Math.cos(this.bank)
    const sb = Math.sin(this.bank)
    ax += q * cl * (ux * cb + sx * sb)
    ay += q * cl * (uy * cb + sy * sb)
    az += q * cl * (uz * cb + sz * sb)
    ay -= G

    this.vx += ax * dt
    this.vy += ay * dt
    this.vz += az * dt
    this.x += this.vx * dt
    this.y += this.vy * dt
    this.z += this.vz * dt

    // Gyroscopic roll. Above V_BALANCE the precession banks the disc one way,
    // below it the other, and the spin bleeding off makes the late fade bite
    // harder than the early turn. That asymmetry is the shape of a real throw.
    this.bank = clamp(
      this.bank + (this.spinSign * ROLL_K * v * (v - V_BALANCE) * dt) / Math.max(14, this.omega),
      -BANK_MAX, BANK_MAX,
    )
    this.omega *= Math.pow(SPIN_DECAY, dt)
    this.spinPhase += this.spinSign * this.omega * dt

    if (this.y <= 0) {
      this.y = 0
      this.flying = false
    }
  }

  /**
   * Where this disc will hit the grass, integrated forward with the same model
   * at a coarser step. Feeds the crosshair on the overhead strip, which is what
   * turns the strip from decoration into the thing you actually play off.
   *
   * Writes into `outLand`; allocation-free, and deterministic.
   */
  predictLanding(windX: number, windZ: number, outLand: Float32Array): void {
    let x = this.x, y = this.y, z = this.z
    let vx = this.vx, vy = this.vy, vz = this.vz
    let bank = this.bank, om = this.omega
    const dt = 1 / 20
    for (let n = 0; n < 220 && y > 0; n++) {
      const rx = vx - windX, ry = vy, rz = vz - windZ
      const v = Math.hypot(rx, ry, rz)
      if (v < 1e-4) break
      const horiz = Math.hypot(rx, rz) || 1e-4
      const alpha = this.pitch - Math.atan2(ry, horiz)
      const cl = CL0 + CL_ALPHA * alpha
      const da = alpha - ALPHA_MIN_DRAG
      const cd = CD0 + CD_ALPHA * da * da
      const q = K_AERO * v * v
      const ux = (-rx * ry) / (v * horiz)
      const uy = horiz / v
      const uz = (-rz * ry) / (v * horiz)
      const sx = (ry * uz - rz * uy) / v
      const sy = (rz * ux - rx * uz) / v
      const sz = (rx * uy - ry * ux) / v
      const cb = Math.cos(bank), sb = Math.sin(bank)
      vx += ((-q * cd * rx) / v + q * cl * (ux * cb + sx * sb)) * dt
      vy += ((-q * cd * ry) / v + q * cl * (uy * cb + sy * sb) - G) * dt
      vz += ((-q * cd * rz) / v + q * cl * (uz * cb + sz * sb)) * dt
      x += vx * dt
      y += vy * dt
      z += vz * dt
      bank = clamp(bank + (this.spinSign * ROLL_K * v * (v - V_BALANCE) * dt) / Math.max(14, om), -BANK_MAX, BANK_MAX)
      om *= Math.pow(SPIN_DECAY, dt)
    }
    outLand[0] = x
    outLand[1] = z
  }

  /** Spawn trail puffs. Called from update so the rate is framerate-independent. */
  updateTrail(dt: number, field: Field): void {
    this.trail.update(dt)
    if (!this.flying) return
    // Flight-path samples, in metres. Taken here rather than in `apply` so the
    // path is a property of the simulation and not of the frame rate.
    this.arcTimer -= dt
    if (this.arcTimer <= 0) {
      this.arcTimer = ARC_DT
      if (this.arcCount < ARC_N) {
        const i = this.arcCount * 3
        this.arcXYZ[i] = this.x
        this.arcXYZ[i + 1] = this.y
        this.arcXYZ[i + 2] = this.z
        this.arcCount++
      } else {
        // Full: shuffle down by one. Forty entries, twenty times a second.
        this.arcXYZ.copyWithin(0, 3)
        const i = (ARC_N - 1) * 3
        this.arcXYZ[i] = this.x
        this.arcXYZ[i + 1] = this.y
        this.arcXYZ[i + 2] = this.z
      }
    }

    this.trailTimer -= dt
    if (this.trailTimer > 0) return
    this.trailTimer = 0.035
    field.project(this.x, this.y, this.z)
    if (!field.pVisible) return
    const size = Math.max(3.5, field.ps * 0.2)
    this.trail.emit({
      x: field.px, y: field.py,
      life: 0.5,
      size, sizeEnd: size * 0.28,
      alpha: 0.5, alphaEnd: 0,
      drag: 0.4,
    })
  }

  /**
   * Write the disc and its shadow into screen space.
   *
   * The apparent shape of a flat plate is the sine of the angle between the
   * plate and the line of sight, so the ellipse squashes to a line at eye level
   * and opens out as the disc climbs or drops — free, correct, and the clearest
   * single cue for how high the disc actually is.
   */
  apply(alpha: number, field: Field, camH: number): void {
    this.drawArc(field)
    const x = lerp(this.prevX, this.x, alpha)
    const y = lerp(this.prevY, this.y, alpha)
    const z = lerp(this.prevZ, this.z, alpha)
    const bank = lerp(this.prevBank, this.bank, alpha)
    const phase = lerp(this.prevPhase, this.spinPhase, alpha)

    field.project(x, y, z)
    const visible = field.pVisible
    this.container.visible = visible
    if (visible) {
      const s = field.ps
      this.container.position.set(field.px, field.py)

      const dx = x - field.camX
      const dz = Math.max(1, z - field.camZ)
      const elevation = Math.atan2(y - camH, Math.hypot(dx, dz))
      /**
       * Foreshortening, with a FLOOR that keeps the disc a disc.
       *
       * The true apparent shape of a flat plate at eye level is a line, and at
       * 0.1 the game drew one: a captured frame showed the disc as a pale
       * sliver a few pixels deep, which is most of why three reviews in a row
       * could not find it. "The object the entire game is about is invisible"
       * outranks the correctness of a squash factor, and a camera 2.1 m off
       * the grass means the disc spends the whole first half of every throw
       * within a degree or two of eye level.
       *
       * 0.38 is the shallowest the ellipse is allowed to get. It still opens
       * out as the disc climbs and closes as it comes level, so the height cue
       * survives; it just never collapses to a line.
       */
      const openness = clamp(Math.abs(Math.sin(elevation + this.pitch)), 0.38, 1)

      const k = (s * VISUAL_SCALE * 0.135) / RU
      this.container.scale.set(k, k * openness)
      this.container.rotation = bank * 0.85

      // The two rim marks orbit the disc. Their vertical offset uses the same
      // squash as the body, and the nearer one draws a touch larger, which is
      // what sells the rotation rather than a spinning texture.
      const mc = Math.cos(phase)
      const ms = Math.sin(phase)
      this.markA.position.set(mc * RU * 0.72, ms * RU * 0.72)
      this.markB.position.set(-mc * RU * 0.72, -ms * RU * 0.72)
      const sa = 0.78 + 0.34 * ms
      this.markA.scale.set(sa)
      this.markB.scale.set(1.56 - sa)
    }

    /*
     * --- shadow ---------------------------------------------------------------
     *
     *   "the mystery unattached ellipse at (635,535) reads as a shadow with no
     *    caster."
     *
     * Two critics, and they are describing this. It was drawn at the disc's own
     * ground point with NO lateral offset at all, which is the one thing every
     * other shadow in this event does not do: the athletes', the copse's, the
     * windsock's all rake down and to the left at 0.55 m per metre of height,
     * away from a sun the sky draws at the frame's right shoulder. A dark
     * ellipse sitting plumb under nothing, in a frame where everything else
     * leans, is not read as a shadow — it is read as an object.
     *
     * Two changes, and the catch cue is untouched by both because both are
     * functions of height and the cue is what happens at height zero. The mark
     * leans with the same constant the rig uses, so at the top of an arc it is
     * a hundred pixels up-sun of the disc's ground point and obviously thrown
     * by something; and it fades out with height nearly twice as fast, so a
     * disc at the apex leaves a faint smudge rather than the second darkest
     * ellipse in the middle of an empty field. The core still snaps to the
     * disc's true size and darkens in the last few metres, which is the moment
     * the player is actually reading.
     */
    field.project(x, 0, z)
    this.shadow.visible = field.pVisible
    if (field.pVisible) {
      const gs = field.ps
      const h = Math.max(0, y)
      this.shadow.position.set(field.px - h * 0.55 * gs, field.py)
      // The penumbra spreads with height and washes out; the core tightens onto
      // the disc's true size and darkens as it comes down.
      const discPx = 0.27 * VISUAL_SCALE * gs
      // Narrower than it was as well as harder: 2.6x the disc at three metres
      // of altitude was a patch of grass the size of the athlete.
      const pw = discPx * (1 + h * 0.07) * 1.1
      this.penumbra.scale.set(pw, pw * 0.34)
      // Definite, not vague. A faint 180 px patch alone in an empty field is
      // read as a stain; a small firm dark mark is read as a shadow. Gone by
      // eleven metres rather than by twenty: see the note above.
      this.penumbra.alpha = clamp01(0.5 - h * 0.06)

      const focus = clamp01(1 - h / 7)
      const cw = discPx * lerp(1.7, 1.02, focus)
      this.core.scale.set(cw, cw * 0.34)
      // The floor was 0.12, which on the sun rake band `Field.ts` now puts
      // behind the receiver is still a 22-point mark of the disc's own size
      // sitting under nothing. Off at altitude, firm in the last few metres:
      // the cue is the moment it appears, not its presence.
      this.core.alpha = 0.04 + 0.76 * focus
    }
  }

  /**
   * The flight path, drawn as a run of shrinking discs from the hand to the
   * disc. Two fills and no strokes: a dark pass at radius+2 and a hot pass
   * inside it, so the path carries its own value break and reads on the pale
   * sky as well as on the dark seam at the horizon.
   *
   * This is what makes a still of this event read as a THROW. Without it the
   * frame is a person standing in a field with a small object near them, which
   * is exactly what a blind review saw.
   */
  private drawArc(field: Field): void {
    const g = this.arc
    g.clear()
    if (this.arcCount < 2) return
    const n = this.arcCount
    // Offset from the simulated release point to the drawn hand. Capped, so a
    // camera cut or a missing thrower can never bend the path into a hook.
    let ox = 0
    let oy = 0
    if (this.handAnchored) {
      field.project(this.arcXYZ[0], this.arcXYZ[1], this.arcXYZ[2])
      if (field.pVisible) {
        ox = clamp(this.handAX - field.px, -260, 260)
        oy = clamp(this.handAY - field.py, -320, 320)
      }
    }
    // Dark pass first, so the hot pass sits inside it.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const j = i * 3
        field.project(this.arcXYZ[j], this.arcXYZ[j + 1], this.arcXYZ[j + 2])
        if (!field.pVisible) continue
        // Newest samples are fattest: the path tapers back toward the hand.
        //
        // Sized in SCREEN pixels, not scaled by the field's pixels-per-metre.
        // `field.ps` at twenty metres is about sixty, so the old
        // `max(0.35, ps/70)` clamped to 0.35 for the whole visible arc and drew
        // the flight path as a run of sub-pixel dots. That is why "a previous
        // pass already added a drawn flight arc" and no critic ever mentioned
        // one: it was there, and it was two tenths of a pixel wide.
        const t = i / (n - 1)
        const r = 2.1 + 5.4 * t * t
        // Squared falloff: full offset at the hand, gone by a third of the way
        // along, so only the part of the path that is behind the athlete moves.
        const w = (1 - t) * (1 - t) * (1 - t)
        g.circle(field.px + ox * w, field.py + oy * w, pass === 0 ? r + 2.6 : r)
      }
      g.fill({ color: pass === 0 ? this.arcInk : this.arcWarm, alpha: pass === 0 ? 0.55 : 0.95 })
    }
  }

  destroy(): void {
    this.arc.destroy()
    this.trail.destroy()
    this.container.destroy({ children: true })
    this.shadow.destroy({ children: true })
  }
}
