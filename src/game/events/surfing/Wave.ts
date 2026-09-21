import { clamp01, lerp, smoothstep } from '../../../core/Tween'

/**
 * The wave: geometry, and the swell field it lives in.
 *
 * Two separate things live here and it matters that they are separate.
 *
 * 1. `WaveFace` is the cross-section the surfer actually rides — the curve from
 *    the trough up to the lip — parameterised by arc length exactly the way
 *    `Ramp` parameterises the half pipe. Working in arc length makes the riding
 *    physics one dimensional again: gravity is a scalar along the tangent, the
 *    surfer's speed up and down the face is a scalar, and a face that goes past
 *    vertical into an overhanging lip is not a special case. The difference from
 *    the half pipe is that this curve *changes shape* as the wave stands up, so
 *    it is baked once per pitch value and blended, rather than built once.
 *
 * 2. The swell field — `energyAt`, `heightAt`, `pitchAt`, `brokenAt` — is a pure
 *    function of world position along the line and a slow clock. That is what
 *    makes the run have rhythm instead of being a treadmill: sections stand up,
 *    pitch, throw a lip, peel, run out of energy and reform further down the
 *    line, and the surfer has to chase the pocket through all of it.
 *
 * Orientation, fixed everywhere in this event: the wave peels toward **+x**, the
 * surfer rides toward +x, whitewater is behind at -x, the clean wall ahead at +x.
 */

/** Baked face profiles across the pitch range, blended between. */
const PITCH_STEPS = 9
/** Arc-length samples per baked profile. */
const ARC_SAMPLES = 41
/** Raw samples taken before the arc-length resample. */
const RAW_SAMPLES = 160

export interface FaceSample {
  /**
   * Offset from the lip along the line, in units of wave height. Positive is
   * forward, the direction the wave peels. The foot of the face reaches well
   * forward of the lip on a mellow wave; on a barrelling one the lip throws out
   * past the trough and the sign flips.
   */
  fx: number
  /** Height above the trough, 0 at the trough, 1 at the lip. */
  fy: number
  /**
   * Screen-space angle of the surface, pointing *down* the face toward the
   * trough. A mellow face reads about 0.55 rad, a vertical wall PI/2, and an
   * overhanging lip goes past PI/2 — which is what makes the barrel possible.
   */
  angle: number
}

/** How far forward the foot of the face reaches. A steep wave has a tight foot. */
const footWidth = (p: number): number => lerp(0.98, 0.30, p)
/** How far the lip juts out past the crest. This is the roof of the barrel. */
const lipThrow = (p: number): number => lerp(0.015, 0.54, p)

/** Raw profile: forward offset as a function of height fraction `u`. */
function rawX(p: number, u: number): number {
  const foot = footWidth(p) * Math.pow(1 - u, 1.7)
  // The throw only engages in the top half, and with a high exponent, so the
  // middle of a steep face stays near-vertical instead of bowing out.
  const t = u < 0.5 ? 0 : (u - 0.5) * 2
  return foot + lipThrow(p) * Math.pow(t, 2.4)
}

/**
 * The family of face profiles, baked once and blended.
 *
 * Rebuilding a curve every frame would be the obvious thing and the wrong one:
 * the surfer needs a stable arc length to sit on, and the pitch moves slowly
 * enough that blending two neighbours is indistinguishable from re-solving.
 */
export class WaveFace {
  private fxs = new Float32Array(PITCH_STEPS * ARC_SAMPLES)
  private fys = new Float32Array(PITCH_STEPS * ARC_SAMPLES)
  private angs = new Float32Array(PITCH_STEPS * ARC_SAMPLES)
  private lens = new Float32Array(PITCH_STEPS)

  constructor() {
    const rx = new Float64Array(RAW_SAMPLES)
    const ry = new Float64Array(RAW_SAMPLES)
    const arc = new Float64Array(RAW_SAMPLES)

    for (let k = 0; k < PITCH_STEPS; k++) {
      const p = k / (PITCH_STEPS - 1)
      // Everything is stored relative to the lip, so a surfer at the lip sits
      // exactly on his line position and the camera does not lurch.
      const lipX = rawX(p, 1)
      let acc = 0
      for (let i = 0; i < RAW_SAMPLES; i++) {
        const u = i / (RAW_SAMPLES - 1)
        rx[i] = rawX(p, u) - lipX
        ry[i] = u
        if (i > 0) acc += Math.hypot(rx[i] - rx[i - 1], ry[i] - ry[i - 1])
        arc[i] = acc
      }
      this.lens[k] = acc

      // Resample uniformly in arc length so `a` is a real distance along the
      // surface and the physics does not speed up where the curve bunches.
      let j = 0
      for (let i = 0; i < ARC_SAMPLES; i++) {
        const target = (i / (ARC_SAMPLES - 1)) * acc
        while (j < RAW_SAMPLES - 2 && arc[j + 1] < target) j++
        const span = arc[j + 1] - arc[j]
        const t = span > 1e-9 ? (target - arc[j]) / span : 0
        const o = k * ARC_SAMPLES + i
        this.fxs[o] = rx[j] + (rx[j + 1] - rx[j]) * t
        this.fys[o] = ry[j] + (ry[j + 1] - ry[j]) * t
      }
      for (let i = 0; i < ARC_SAMPLES; i++) {
        const lo = k * ARC_SAMPLES + Math.max(0, i - 1)
        const hi = k * ARC_SAMPLES + Math.min(ARC_SAMPLES - 1, i + 1)
        // Direction of travel *down* the face, in screen coordinates: x runs
        // from the higher sample to the lower one, y grows downward.
        const dx = this.fxs[lo] - this.fxs[hi]
        const dy = this.fys[hi] - this.fys[lo]
        this.angs[k * ARC_SAMPLES + i] = Math.atan2(dy, dx)
      }
    }
  }

  /** Arc length of the face at this pitch, in units of wave height. */
  arcLength(pitch: number): number {
    const pf = clamp01(pitch) * (PITCH_STEPS - 1)
    const k = Math.min(PITCH_STEPS - 2, Math.floor(pf))
    return lerp(this.lens[k], this.lens[k + 1], pf - k)
  }

  /**
   * Sample the face. `a` is normalised arc position: 0 at the trough, 1 at the
   * lip. Writes into `out` so this can be called freely without allocating.
   */
  sample(pitch: number, a: number, out: FaceSample): FaceSample {
    const pf = clamp01(pitch) * (PITCH_STEPS - 1)
    const k0 = Math.min(PITCH_STEPS - 2, Math.floor(pf))
    const kt = pf - k0
    const af = clamp01(a) * (ARC_SAMPLES - 1)
    const i0 = Math.min(ARC_SAMPLES - 2, Math.floor(af))
    const at = af - i0

    const oA = k0 * ARC_SAMPLES + i0
    const oB = (k0 + 1) * ARC_SAMPLES + i0
    out.fx = lerp(lerp(this.fxs[oA], this.fxs[oA + 1], at), lerp(this.fxs[oB], this.fxs[oB + 1], at), kt)
    out.fy = lerp(lerp(this.fys[oA], this.fys[oA + 1], at), lerp(this.fys[oB], this.fys[oB + 1], at), kt)
    out.angle = lerp(lerp(this.angs[oA], this.angs[oA + 1], at), lerp(this.angs[oB], this.angs[oB + 1], at), kt)
    return out
  }
}

export interface WaveOptions {
  /** Screen y of the flat water the wave stands up out of. */
  stillY: number
  minHeight: number
  maxHeight: number
}

/**
 * The swell.
 *
 * `breakX` is the peel: the point where the lip has thrown and the wave has
 * gone to whitewater. It marches forward at a speed set by how much energy the
 * water under it carries, stalls out when it runs into a soft spot, and the next
 * steep section stands up ahead. That cycle is the rhythm of a run.
 */
export class Wave {
  readonly face = new WaveFace()
  readonly opts: WaveOptions

  /** World x of the peel. Everything behind this is whitewater. */
  breakX = 0
  /** How far the whitewater tail reaches behind the peel. Shrinks on reform. */
  foamLength = 820
  /** > 0 while the wave is backing off and the next section is standing up. */
  reformT = 0
  /** Where the rider is, so a reforming section never stands up past him. */
  private riderX = 0
  /** Minimum time a fresh section holds before it is allowed to back off again. */
  private holdT = 0

  private clock = 0

  constructor(opts: WaveOptions) {
    this.opts = opts
  }

  get time(): number { return this.clock }

  /**
   * How much power the swell carries at this point along the line, 0..1.
   * Three sines at incommensurable wavelengths: long sets, sections inside a
   * set, and chop. The slow negative time terms march the whole swell shoreward
   * so a stationary surfer still sees the wave change under him.
   */
  energyAt(wx: number): number {
    const t = this.clock
    return clamp01(
      0.5
      + 0.34 * Math.sin(wx * 0.00068 - t * 0.13)
      + 0.19 * Math.sin(wx * 0.00187 + 1.7 - t * 0.21)
      + 0.08 * Math.sin(wx * 0.00431 + 4.1),
    )
  }

  /** Face height in pixels. Broken water collapses toward half height. */
  heightAt(wx: number): number {
    const e = this.energyAt(wx)
    const shaped = e * e * 0.58 + e * 0.42
    const h = lerp(this.opts.minHeight, this.opts.maxHeight, shaped)
    return h * (1 - 0.48 * this.brokenAt(wx))
  }

  /**
   * How hollow the face is, 0 (a mellow shoulder) to 1 (throwing a barrel).
   * The pocket — the few hundred pixels just ahead of the peel — always stands
   * up harder than the open wall, because that is where the wave is breaking.
   */
  pitchAt(wx: number): number {
    const e = this.energyAt(wx)
    const d = (wx - this.breakX) / 300
    const pocket = d > -1.2 ? Math.exp(-d * d) * 0.38 : 0
    return clamp01(smoothstep(0.33, 0.84, e) + pocket) * (1 - this.brokenAt(wx))
  }

  /** 0 ahead of the peel, rising to 1 in the whitewater, fading out behind it. */
  brokenAt(wx: number): number {
    const d = this.breakX - wx
    if (d <= 0) return 0
    return smoothstep(0, 150, d) * (1 - smoothstep(this.foamLength * 0.58, this.foamLength, d))
  }

  /** Screen y of the flat water in front of the wave, with a slow breathe. */
  troughYAt(wx: number): number {
    return this.opts.stillY + Math.sin(wx * 0.0021 + this.clock * 0.8) * 7
  }

  crestYAt(wx: number): number {
    return this.troughYAt(wx) - this.heightAt(wx)
  }

  /** Advance the peel. Simulation only. */
  update(dt: number): void {
    this.clock += dt

    if (this.reformT > 0) {
      // Backing off: the whitewater dissipates and the wave reassembles.
      this.reformT -= dt
      this.foamLength = Math.max(170, this.foamLength - 940 * dt)
      if (this.reformT <= 0) {
        // The next steep water down the line, but never *ahead* of the rider: a
        // section that stands up past him puts him behind the peel through no
        // fault of his own, and the first he knows about it is a wipeout he
        // could not have avoided. Clamping the result rather than the search
        // start keeps the natural spacing of the sections intact.
        const limit = this.riderX - 80
        let next = this.nextSteep(this.breakX + 420)
        // Overshooting the rider means taking the nearest steep water *behind*
        // him instead. Clamping to the limit itself would drop the peel into
        // whatever water happened to be there — usually soft, which makes it
        // back off again a second later and the wave never settles.
        if (next > limit) next = this.prevSteep(limit)
        if (next < this.breakX + 200) next = this.breakX + 200
        this.breakX = next
        this.foamLength = 300
        this.holdT = 2.0
      }
      return
    }

    if (this.holdT > 0) this.holdT -= dt
    const e = this.energyAt(this.breakX)
    this.breakX += lerp(230, 760, e) * dt
    this.foamLength = Math.min(840, this.foamLength + 460 * dt)
    // Run out of energy and the break cannot hold: it fades and reforms ahead.
    if (e < 0.30 && this.holdT <= 0) this.reformT = 1.0
  }

  /**
   * Keep a pocket within reach, in both directions.
   *
   * Outrunning a section is a reward, but an empty shoulder with no break
   * anywhere is a flat treadmill, so a new section stands up behind a surfer who
   * has got too far in front. The other direction is a fairness rule rather than
   * a pacing one: if the peel has somehow ended up a long way in front of him,
   * it is pulled back rather than leaving him stranded behind the wave.
   */
  follow(riderX: number): void {
    this.riderX = riderX
    if (riderX - this.breakX > 1500) {
      this.breakX = riderX - 760
      this.foamLength = 420
      this.reformT = 0
    } else if (this.breakX - riderX > 900) {
      this.breakX = riderX - 300
      this.foamLength = 260
    }
  }

  /** First point at or after `from` where the swell is steep enough to break. */
  private nextSteep(from: number): number {
    for (let i = 0; i < 64; i++) {
      const x = from + i * 70
      if (this.energyAt(x) > 0.60) return x
    }
    return from + 1400
  }

  /** Nearest point at or before `from` with enough energy to hold a break. */
  private prevSteep(from: number): number {
    for (let i = 0; i < 40; i++) {
      const x = from - i * 70
      if (this.energyAt(x) > 0.52) return x
    }
    return from
  }
}
