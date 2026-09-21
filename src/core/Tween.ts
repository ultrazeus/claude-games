/** Easing curves. All map 0..1 to 0..1 (except back/elastic which overshoot). */
export const Ease = {
  linear: (t: number): number => t,
  inQuad: (t: number): number => t * t,
  outQuad: (t: number): number => t * (2 - t),
  inOutQuad: (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t: number): number => t * t * t,
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outQuart: (t: number): number => 1 - Math.pow(1 - t, 4),
  outQuint: (t: number): number => 1 - Math.pow(1 - t, 5),
  inExpo: (t: number): number => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t: number): number =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5
      ? Math.pow(2, 20 * t - 10) / 2
      : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outBack: (t: number): number => {
    const c1 = 1.70158, c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  outElastic: (t: number): number => {
    const c4 = (2 * Math.PI) / 3
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  },
  outBounce: (t: number): number => {
    const n1 = 7.5625, d1 = 2.75
    if (t < 1 / d1) return n1 * t * t
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
    return n1 * (t -= 2.625 / d1) * t + 0.984375
  },
  inSine: (t: number): number => 1 - Math.cos((t * Math.PI) / 2),
  outSine: (t: number): number => Math.sin((t * Math.PI) / 2),
  inOutSine: (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2,
} as const

export type EaseFn = (t: number) => number

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** Map v from [aLo,aHi] into [bLo,bHi], clamped. */
export const remap = (v: number, aLo: number, aHi: number, bLo: number, bHi: number): number =>
  bLo + (bHi - bLo) * clamp01((v - aLo) / (aHi - aLo))

/** Shortest-path angular lerp, radians. */
export const lerpAngle = (a: number, b: number, t: number): number => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/**
 * Framerate-independent exponential smoothing.
 * `smoothing` is the fraction remaining after 1 second. Lower = snappier.
 */
export const damp = (a: number, b: number, smoothing: number, dt: number): number =>
  lerp(a, b, 1 - Math.pow(smoothing, dt))

/** Smoothstep between two edges. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
