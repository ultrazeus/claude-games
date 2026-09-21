import { Container, Graphics, Sprite, Texture } from 'pixi.js'
import { softDot, verticalGradient } from './Gradient'
import { grade, mix, type Hex } from './Palette'
import { clamp01, lerp } from '../core/Tween'

/**
 * Staging: the things that make a frame read as a lit scene rather than a
 * stack of coloured shapes.
 *
 * Every blind review of this game so far has named the same three failures, in
 * every event, independently:
 *
 *   1. Objects float. No contact shadow, so the rider is pasted onto the ground
 *      instead of standing on it.
 *   2. The largest object in the frame is a flat fill. A light source is drawn
 *      in the sky and then nothing obeys it — no lit plane, no terminator, no
 *      occlusion pool, no cast shadow.
 *   3. Background furniture out-ranks the player. Signage, HUD text or a sun
 *      bloom carries the highest contrast in the frame, so the eye never lands
 *      on the thing the player controls.
 *
 * These are one class of problem and this module is the shared answer, so an
 * event fixes them by calling three functions rather than by rediscovering the
 * technique.
 */

/** Which way the key light comes from. Everything shades against this. */
export interface KeyLight {
  /** -1 = from the left, +1 = from the right. */
  readonly dirX: number
  /** Colour of the light, for warm bounce and rim. */
  readonly tint: Hex
  /** 0..1. How hard the shading is. */
  readonly strength: number
}

export const keyFromLeft = (tint: Hex, strength = 1): KeyLight =>
  ({ dirX: -1, tint, strength })
export const keyFromRight = (tint: Hex, strength = 1): KeyLight =>
  ({ dirX: 1, tint, strength })

/**
 * The lit and shaded pair for one material under a key light.
 *
 * Two values per surface is the entire shading model the reference uses. A
 * single flat fill is what reads as unfinished.
 */
export function shadePair(base: Hex, key: KeyLight): { lit: Hex; shade: Hex } {
  const s = clamp01(key.strength)
  return {
    lit: mix(grade(base, { valScale: 1 + 0.1 * s, satScale: 1 - 0.06 * s }), key.tint, 0.12 * s),
    shade: grade(base, { valScale: 1 - 0.26 * s, satScale: 1 + 0.18 * s }),
  }
}

/**
 * A contact shadow that anchors a moving object to a surface.
 *
 * Call `place()` every frame with the object's position and how far it is above
 * the surface. It writes transforms only, never geometry, so it is free in
 * `render`. This is the cheapest single fix for "the character is floating",
 * which is the most repeated note in every review.
 */
export class ContactShadow {
  readonly sprite: Sprite

  private readonly nearWidth: number
  private readonly nearHeight: number
  private readonly nearAlpha: number
  private readonly maxGap: number

  constructor(opts: {
    color: Hex
    /** Width when the object is touching down. */
    width?: number
    height?: number
    /** Opacity when touching down. Keep it high; a faint smudge reads as dirt. */
    alpha?: number
    /** Distance at which the shadow has fully dissipated. */
    maxGap?: number
  }) {
    this.nearWidth = opts.width ?? 130
    this.nearHeight = opts.height ?? 36
    this.nearAlpha = opts.alpha ?? 0.72
    this.maxGap = opts.maxGap ?? 420
    this.sprite = new Sprite(softDot(opts.color, 96, 0.2))
    this.sprite.anchor.set(0.5)
    this.sprite.eventMode = 'none'
  }

  /**
   * @param x        surface point under the object
   * @param y        surface point under the object
   * @param gap      distance from the object to that surface
   * @param rotation surface angle, so the shadow lies along the ground
   */
  place(x: number, y: number, gap: number, rotation = 0): void {
    const t = clamp01(Math.abs(gap) / this.maxGap)
    this.sprite.visible = true
    this.sprite.position.set(x, y)
    this.sprite.rotation = rotation
    // Further away: wider, flatter, fainter. That spread is the height cue.
    this.sprite.width = lerp(this.nearWidth, this.nearWidth * 1.7, t)
    this.sprite.height = lerp(this.nearHeight, this.nearHeight * 1.5, t)
    this.sprite.alpha = lerp(this.nearAlpha, 0.04, t)
  }

  hide(): void {
    this.sprite.visible = false
  }

  destroy(): void {
    this.sprite.destroy()
  }
}

/**
 * An occlusion pool: the darkening that gathers where a surface turns away from
 * the light, or where two surfaces meet. Returns a sprite to position over the
 * region; it is a gradient, not a hard edge, so it reads as light falloff.
 */
export function occlusionPool(opts: {
  color: Hex
  width: number
  height: number
  /** Strength at the deep end. */
  strength?: number
  /** 'down' darkens toward the bottom, 'up' toward the top. */
  direction?: 'down' | 'up'
}): Sprite {
  const deep = grade(opts.color, { valScale: 0.42, satScale: 1.5 })
  const a = opts.strength ?? 0.7
  const stops = opts.direction === 'up'
    ? [{ t: 0, c: deep, a }, { t: 0.5, c: deep, a: a * 0.3 }, { t: 1, c: deep, a: 0 }]
    : [{ t: 0, c: deep, a: 0 }, { t: 0.5, c: deep, a: a * 0.3 }, { t: 1, c: deep, a }]
  const s = new Sprite(verticalGradient(stops, 128))
  s.width = opts.width
  s.height = opts.height
  s.eventMode = 'none'
  return s
}

/**
 * Outline weight and opacity for a given depth.
 *
 * Uniform outline weight at every depth was called out by name as the thing
 * that reads as a vector-app default. Lines thin and fade with distance, and
 * past the far band they stop entirely.
 */
export function depthOutline(depth: number): { width: number; alpha: number } {
  const d = clamp01(depth)
  return { width: lerp(3.5, 1, d), alpha: d > 0.82 ? 0 : lerp(1, 0.35, d) }
}

/**
 * Scatter helper for populating a band without the copy-paste tell.
 *
 * Returns a deterministic but irregular sequence of placements: position, scale
 * and a variant index, so a crowd or a treeline varies in height, spacing and
 * silhouette instead of stamping one symbol at one pitch.
 */
export function scatter(opts: {
  count: number
  from: number
  to: number
  /** Integer seed; the same seed always gives the same arrangement. */
  seed: number
  scaleRange?: [number, number]
  variants?: number
}): { x: number; scale: number; variant: number; jitter: number }[] {
  const out: { x: number; scale: number; variant: number; jitter: number }[] = []
  const [lo, hi] = opts.scaleRange ?? [0.8, 1.2]
  const variants = opts.variants ?? 3
  let h = opts.seed >>> 0
  const next = (): number => {
    h = (h + 0x6d2b79f5) >>> 0
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const span = opts.to - opts.from
  for (let i = 0; i < opts.count; i++) {
    // Uneven pitch: an even step is the thing that reads as an array.
    const base = opts.from + (span * (i + 0.5)) / opts.count
    const wobble = (next() - 0.5) * (span / opts.count) * 0.85
    out.push({
      x: base + wobble,
      scale: lo + next() * (hi - lo),
      variant: Math.floor(next() * variants),
      jitter: next(),
    })
  }
  return out
}

/** A near-plane band that crops the frame and gives the composition a floor. */
export function foregroundBand(opts: {
  color: Hex
  width: number
  height: number
  y: number
  /** Adds a lit top edge so the band is a surface, not a bar. */
  rimColor?: Hex
}): Container {
  const c = new Container()
  const g = new Graphics()
  g.rect(-40, opts.y, opts.width + 80, opts.height).fill(opts.color)
  if (opts.rimColor !== undefined) {
    g.moveTo(-40, opts.y).lineTo(opts.width + 40, opts.y)
      .stroke({ color: opts.rimColor, width: 4 })
  }
  c.addChild(g)
  c.eventMode = 'none'
  return c
}

/** A soft radial glow texture, cached per colour for reuse across events. */
const glowCache = new Map<number, Texture>()
export function cachedGlow(color: Hex): Texture {
  let t = glowCache.get(color)
  if (!t) {
    t = softDot(color, 128, 0.25)
    glowCache.set(color, t)
  }
  return t
}
