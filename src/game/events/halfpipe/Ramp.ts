/**
 * Half pipe geometry.
 *
 * The ramp is a single curve the skater travels along, parameterised by
 * arc length `s` running from the left lip (s = 0) through the flat bottom to
 * the right lip (s = length). Working in arc length rather than x means the
 * physics is one dimensional: gravity is a scalar along the tangent, speed is a
 * scalar, and there is no special case where the wall goes vertical and x stops
 * being a function of position.
 *
 * Profile, left to right: vertical wall, transition arc, flat bottom, transition
 * arc, vertical wall. The real thing, in cross-section.
 */
export interface RampSample {
  x: number
  y: number
  /** Tangent direction in radians, in the direction of increasing s. */
  angle: number
  /** dy/ds at this point. Positive means descending (screen y grows downward). */
  slope: number
}

export interface RampOptions {
  /** Half-width of the flat bottom. */
  flatHalf: number
  /** Transition radius. */
  radius: number
  /** World y of the flat bottom. */
  bottomY: number
  /** Height of the vertical section above the top of the transition. */
  vertHeight: number
}

const SAMPLES_PER_UNIT = 0.5

export class Ramp {
  readonly opts: RampOptions
  /** Total arc length from left lip to right lip. */
  readonly length: number
  /** Arc length at the bottom-most point. */
  readonly bottomS: number

  private xs: Float32Array
  private ys: Float32Array
  private angles: Float32Array
  private arc: Float32Array

  constructor(opts: RampOptions) {
    this.opts = opts
    const pts = buildProfile(opts)

    const n = pts.length
    this.xs = new Float32Array(n)
    this.ys = new Float32Array(n)
    this.angles = new Float32Array(n)
    this.arc = new Float32Array(n)

    let acc = 0
    for (let i = 0; i < n; i++) {
      this.xs[i] = pts[i].x
      this.ys[i] = pts[i].y
      if (i > 0) {
        acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      }
      this.arc[i] = acc
    }
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(n - 1, i + 1)]
      this.angles[i] = Math.atan2(b.y - a.y, b.x - a.x)
    }
    this.length = acc

    let bestI = 0
    for (let i = 1; i < n; i++) if (this.ys[i] > this.ys[bestI]) bestI = i
    this.bottomS = this.arc[bestI]
  }

  /** Arc length at which the left wall reaches the lip. */
  get leftLipS(): number { return 0 }
  get rightLipS(): number { return this.length }

  /** World position of the left and right lips. */
  get leftLip(): { x: number; y: number } { return { x: this.xs[0], y: this.ys[0] } }
  get rightLip(): { x: number; y: number } {
    const i = this.xs.length - 1
    return { x: this.xs[i], y: this.ys[i] }
  }

  /** Sample the curve at arc length `s`, clamped to the ramp. */
  sample(s: number): RampSample {
    const clamped = s < 0 ? 0 : s > this.length ? this.length : s
    const i = this.indexFor(clamped)
    const j = Math.min(i + 1, this.arc.length - 1)
    const span = this.arc[j] - this.arc[i]
    const t = span > 1e-6 ? (clamped - this.arc[i]) / span : 0
    const x = this.xs[i] + (this.xs[j] - this.xs[i]) * t
    const y = this.ys[i] + (this.ys[j] - this.ys[i]) * t
    const angle = lerpAngleLocal(this.angles[i], this.angles[j], t)
    return { x, y, angle, slope: Math.sin(angle) }
  }

  /** Height of the curve above the flat bottom at arc length `s`. */
  heightAt(s: number): number {
    return this.opts.bottomY - this.sample(s).y
  }

  /** Binary search for the sample index at or before `s`. */
  private indexFor(s: number): number {
    let lo = 0
    let hi = this.arc.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.arc[mid] <= s) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /**
   * Closest point on the ramp to a world position, for airborne re-entry.
   * Returns null when the point is outside the ramp's horizontal extent.
   *
   * Searches coarsely then refines, which is far cheaper than testing every
   * sample and is exact enough at the scale a skater lands.
   */
  closestS(px: number, py: number): { s: number; dist: number; signedY: number } | null {
    const n = this.arc.length
    let bestI = -1
    let bestD = Infinity
    const step = Math.max(1, Math.floor(n / 128))
    for (let i = 0; i < n; i += step) {
      const d = (this.xs[i] - px) ** 2 + (this.ys[i] - py) ** 2
      if (d < bestD) { bestD = d; bestI = i }
    }
    if (bestI < 0) return null
    const lo = Math.max(0, bestI - step)
    const hi = Math.min(n - 1, bestI + step)
    for (let i = lo; i <= hi; i++) {
      const d = (this.xs[i] - px) ** 2 + (this.ys[i] - py) ** 2
      if (d < bestD) { bestD = d; bestI = i }
    }
    const s = this.arc[bestI]
    const sample = this.sample(s)
    // Positive when the point is on the open (riding) side of the surface.
    const nx = Math.sin(sample.angle)
    const ny = -Math.cos(sample.angle)
    const signedY = (px - sample.x) * nx + (py - sample.y) * ny
    return { s, dist: Math.sqrt(bestD), signedY }
  }

  /** The polyline, for drawing. */
  outline(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = []
    for (let i = 0; i < this.xs.length; i++) out.push({ x: this.xs[i], y: this.ys[i] })
    return out
  }
}

function buildProfile(o: RampOptions): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = []
  const { flatHalf, radius, bottomY, vertHeight } = o
  const transitionTopY = bottomY - radius
  const wallX = flatHalf + radius

  const push = (x: number, y: number): void => {
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(x - last.x, y - last.y) > 1e-4) pts.push({ x, y })
  }

  // 1. Left vertical wall, top down.
  const vertSteps = Math.max(2, Math.ceil(vertHeight * SAMPLES_PER_UNIT))
  for (let i = 0; i <= vertSteps; i++) {
    const t = i / vertSteps
    push(-wallX, transitionTopY - vertHeight * (1 - t))
  }

  // 2. Left transition: phi sweeps 180deg -> 90deg around the left arc centre.
  const arcLen = (Math.PI / 2) * radius
  const arcSteps = Math.max(8, Math.ceil(arcLen * SAMPLES_PER_UNIT))
  const leftCx = -flatHalf
  for (let i = 0; i <= arcSteps; i++) {
    const phi = Math.PI - (Math.PI / 2) * (i / arcSteps)
    push(leftCx + radius * Math.cos(phi), transitionTopY + radius * Math.sin(phi))
  }

  // 3. Flat bottom.
  const flatSteps = Math.max(2, Math.ceil(flatHalf * 2 * SAMPLES_PER_UNIT))
  for (let i = 0; i <= flatSteps; i++) {
    push(-flatHalf + (flatHalf * 2 * i) / flatSteps, bottomY)
  }

  // 4. Right transition: phi sweeps 90deg -> 0deg.
  const rightCx = flatHalf
  for (let i = 0; i <= arcSteps; i++) {
    const phi = (Math.PI / 2) * (1 - i / arcSteps)
    push(rightCx + radius * Math.cos(phi), transitionTopY + radius * Math.sin(phi))
  }

  // 5. Right vertical wall, bottom up.
  for (let i = 0; i <= vertSteps; i++) {
    push(wallX, transitionTopY - vertHeight * (i / vertSteps))
  }

  return pts
}

function lerpAngleLocal(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
