import { Texture } from 'pixi.js'
import { toCss, type Hex } from './Palette'

export interface GradientStop {
  t: number
  c: Hex
  /** Optional per-stop alpha, defaults to 1. */
  a?: number
}

/**
 * Build a 1-pixel-wide vertical gradient texture.
 *
 * Stretching a tiny texture is how every gradient in the game is drawn: bilinear
 * filtering gives a perfectly smooth ramp, it costs one draw call, and it avoids
 * hand-written GLSL in six parallel workstreams. Banding is not a risk at these
 * heights because the GPU interpolates in float.
 */
export function verticalGradient(stops: readonly GradientStop[], height = 512): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = height
  const ctx = canvas.getContext('2d')
  // EMPTY, not WHITE: a 1x1 white texture stretched over a sky, a river or a
  // shadow is an opaque white rectangle, so the one branch that exists to
  // survive a failure was the loudest possible way to fail. Nothing, visibly.
  if (!ctx) return Texture.EMPTY
  const grad = ctx.createLinearGradient(0, 0, 0, height)
  for (const s of stops) {
    grad.addColorStop(clampT(s.t), toCss(s.c, s.a ?? 1))
  }
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 1, height)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/** Horizontal counterpart, for edge fades and light shafts. */
export function horizontalGradient(stops: readonly GradientStop[], width = 512): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  // EMPTY, not WHITE: a 1x1 white texture stretched over a sky, a river or a
  // shadow is an opaque white rectangle, so the one branch that exists to
  // survive a failure was the loudest possible way to fail. Nothing, visibly.
  if (!ctx) return Texture.EMPTY
  const grad = ctx.createLinearGradient(0, 0, width, 0)
  for (const s of stops) grad.addColorStop(clampT(s.t), toCss(s.c, s.a ?? 1))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, 1)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/**
 * Radial glow texture, used for the sun, bloom blobs and soft light pools.
 * `falloff` above 1 tightens the core.
 */
export function radialGlow(color: Hex, size = 256, falloff = 2.2): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // EMPTY, not WHITE: a 1x1 white texture stretched over a sky, a river or a
  // shadow is an opaque white rectangle, so the one branch that exists to
  // survive a failure was the loudest possible way to fail. Nothing, visibly.
  if (!ctx) return Texture.EMPTY
  const img = ctx.createImageData(size, size)
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half
      const dy = (y - half) / half
      const d = Math.sqrt(dx * dx + dy * dy)
      const a = d >= 1 ? 0 : Math.pow(1 - d, falloff)
      const i = (y * size + x) * 4
      img.data[i] = r
      img.data[i + 1] = g
      img.data[i + 2] = b
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

/** A soft-edged circular dot, for particles. Cheaper than a glow, no falloff math. */
export function softDot(color: Hex, size = 64, hardness = 0.55): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // EMPTY, not WHITE: a 1x1 white texture stretched over a sky, a river or a
  // shadow is an opaque white rectangle, so the one branch that exists to
  // survive a failure was the loudest possible way to fail. Nothing, visibly.
  if (!ctx) return Texture.EMPTY
  const half = size / 2
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half)
  grad.addColorStop(0, toCss(color, 1))
  grad.addColorStop(clampT(hardness), toCss(color, 1))
  grad.addColorStop(1, toCss(color, 0))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  const tex = Texture.from(canvas)
  tex.source.scaleMode = 'linear'
  return tex
}

const clampT = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)
