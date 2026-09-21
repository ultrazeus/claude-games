import { Container, Sprite, Texture } from 'pixi.js'
import { radialGlow, verticalGradient } from './Gradient'
import type { EventPalette } from './Palette'
import { clamp01, damp } from '../core/Tween'

export interface SkyOptions {
  width: number
  height: number
  /** Where the sun sits, in 0..1 of the design space. */
  sunX?: number
  sunY?: number
  sunSize?: number
  /** 0 disables the sun entirely. */
  sunIntensity?: number
  /** Adds a soft horizontal haze band at the horizon. */
  horizonY?: number
}

/**
 * The backdrop every event sits in front of: a full-bleed vertical gradient, an
 * optional sun with a soft bloom, and a horizon haze band that the far parallax
 * layers dissolve into.
 */
export class Sky {
  readonly container = new Container()

  private gradient: Sprite
  private sun: Sprite | null = null
  private sunCore: Sprite | null = null
  private haze: Sprite | null = null
  private width: number
  private height: number
  private sunPulse = 0
  private sunBaseW = 0
  private sunBaseH = 0
  private targetSunAlpha = 1
  private currentSunAlpha = 1

  constructor(palette: EventPalette, opts: SkyOptions) {
    this.width = opts.width
    this.height = opts.height

    const tex = verticalGradient(palette.sky, 512)
    this.gradient = new Sprite(tex)
    this.gradient.width = this.width
    this.gradient.height = this.height
    this.container.addChild(this.gradient)

    const intensity = opts.sunIntensity ?? 1
    if (intensity > 0) {
      const size = opts.sunSize ?? 520
      const glow = new Sprite(radialGlow(palette.light, 256, 2.6))
      glow.anchor.set(0.5)
      glow.width = size * 2.6
      glow.height = size * 2.6
      glow.alpha = 0.5 * intensity
      glow.blendMode = 'add'
      this.sun = glow
      this.sunBaseW = glow.width
      this.sunBaseH = glow.height

      const core = new Sprite(radialGlow(0xffffff, 128, 4.5))
      core.anchor.set(0.5)
      core.width = size * 0.62
      core.height = size * 0.62
      core.alpha = 0.85 * intensity
      core.blendMode = 'add'
      this.sunCore = core

      const sx = (opts.sunX ?? 0.76) * this.width
      const sy = (opts.sunY ?? 0.24) * this.height
      glow.position.set(sx, sy)
      core.position.set(sx, sy)
      this.container.addChild(glow, core)
    }

    if (opts.horizonY !== undefined) {
      const band = new Sprite(
        verticalGradient(
          [
            { t: 0, c: palette.haze, a: 0 },
            { t: 0.5, c: palette.haze, a: 0.55 },
            { t: 1, c: palette.haze, a: 0 },
          ],
          128,
        ),
      )
      band.width = this.width
      band.height = this.height * 0.22
      band.position.set(0, opts.horizonY - this.height * 0.11)
      this.haze = band
      this.container.addChild(band)
    }
  }

  /** Dim the sun, e.g. when the athlete passes in front of it or a cloud rolls in. */
  setSunIntensity(v: number): void {
    this.targetSunAlpha = clamp01(v)
  }

  update(dt: number): void {
    this.currentSunAlpha = damp(this.currentSunAlpha, this.targetSunAlpha, 0.02, dt)
    if (this.sun && this.sunCore) {
      // A barely-there breathe keeps the sun from looking like a pasted decal.
      this.sunPulse += dt
      const breathe = 1 + Math.sin(this.sunPulse * 0.9) * 0.018
      this.sun.width = this.sunBaseW * breathe
      this.sun.height = this.sunBaseH * breathe
      this.sun.alpha = 0.5 * this.currentSunAlpha
      this.sunCore.alpha = 0.85 * this.currentSunAlpha
    }
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.gradient.width = width
    this.gradient.height = height
    if (this.haze) this.haze.width = width
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }

  /** Swap the gradient without rebuilding the scene, for time-of-day shifts. */
  setGradient(palette: EventPalette): void {
    const old = this.gradient.texture
    this.gradient.texture = verticalGradient(palette.sky, 512)
    if (old !== Texture.WHITE) old.destroy(true)
  }
}
