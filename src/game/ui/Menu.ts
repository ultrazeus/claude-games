import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import type { Scene, SceneContext } from '../../core/Scene'
import { Action } from '../../core/Input'
import { radialGlow, verticalGradient } from '../../render/Gradient'
import { Core, Palettes, grade, mix, skyAt, type Hex } from '../../render/Palette'
import { EVENTS } from '../EventList'
import { clamp01, damp, Ease, lerp, smoothstep } from '../../core/Tween'

const HORIZON = 860
const LIST_TOP = 372
const ROW_H = 76
const ROW_W = 880

/** Outline colour for a fill: same hue, darker. Never black. */
const line = (c: Hex): Hex => grade(c, { valScale: 0.72, satScale: 1.12 })

/**
 * Title and event select.
 *
 * Staged like the original's sunset screens: a fat sun sitting on the horizon,
 * palms in silhouette, the logotype stacked over the water. The list sits
 * entirely above the horizon so no row is ever cut by it.
 */
export class Menu implements Scene {
  readonly id = 'menu'

  private ctx!: SceneContext
  private rows: { root: Container; plate: Graphics; name: Text; blurb: Text }[] = []
  private index = 0
  private highlight = 0
  private glitter!: Sprite
  private sunPhase = 0
  private enterT = 0

  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = Palettes.skating

    // --- sky -------------------------------------------------------------
    const sky = new Sprite(verticalGradient(pal.sky, 512))
    sky.width = ctx.width
    sky.height = HORIZON
    ctx.root.addChild(sky)

    // A flat sun disc on the horizon, with one soft bloom behind it. The disc
    // edge stays hard so it reads as a shape, not a light leak.
    const sunY = HORIZON - 96
    const bloom = new Sprite(radialGlow(Core.sunGold, 256, 2.1))
    bloom.anchor.set(0.5)
    bloom.width = 1180
    bloom.height = 1180
    bloom.position.set(ctx.width / 2, sunY)
    bloom.alpha = 0.34
    bloom.blendMode = 'add'
    ctx.root.addChild(bloom)

    const sun = new Graphics()
    sun.circle(0, 0, 182).fill(mix(Core.sunGold, Core.paperWhite, 0.28))
    sun.position.set(ctx.width / 2, sunY)
    ctx.root.addChild(sun)

    // Horizontal bands cut out of the sun, the way every 80s sunset logo does it.
    const bands = new Graphics()
    for (let i = 0; i < 5; i++) {
      const y = sunY - 40 + i * 34
      bands.rect(ctx.width / 2 - 200, y, 400, 8 + i * 2.5)
    }
    bands.fill({ color: skyAt(pal, (sunY - 60) / HORIZON), alpha: 0.85 })
    ctx.root.addChild(bands)

    // --- sea --------------------------------------------------------------
    const sea = new Sprite(verticalGradient(
      [
        { t: 0, c: mix(pal.mid, Core.sunGold, 0.3) },
        { t: 0.22, c: pal.mid },
        { t: 1, c: grade(pal.mid, { valScale: 0.52, satScale: 1.2 }) },
      ], 256,
    ))
    sea.position.set(0, HORIZON)
    sea.width = ctx.width
    sea.height = ctx.height - HORIZON
    ctx.root.addChild(sea)

    // Sun glitter: a narrowing column of broken light from the horizon forward.
    const glitter = new Graphics()
    for (let i = 0; i < 26; i++) {
      const t = i / 25
      const y = HORIZON + 6 + t * (ctx.height - HORIZON)
      const halfW = lerp(26, 210, Ease.inQuad(t))
      const h = lerp(3, 9, t)
      glitter.roundRect(ctx.width / 2 - halfW, y, halfW * 2, h, h / 2)
    }
    glitter.fill({ color: mix(Core.sunGold, Core.paperWhite, 0.4), alpha: 0.5 })
    ctx.root.addChild(glitter)
    this.glitter = new Sprite()
    ctx.root.addChild(this.glitter)

    // --- palms, full silhouette -------------------------------------------
    const palmInk = grade(pal.shade, { valScale: 0.42, satScale: 1.35 })
    for (const [x, scale, flip] of [[176, 1.32, 1], [1756, 1.46, -1]] as const) {
      const palm = this.buildPalm(palmInk)
      palm.position.set(x, HORIZON + 112)
      palm.scale.set(scale * flip, scale)
      ctx.root.addChild(palm)
    }

    // --- title ------------------------------------------------------------
    const titleStyle = (size: number, fill: Hex, spacing: number): TextStyle =>
      new TextStyle({
        fontFamily: 'Anton, Archivo, system-ui, sans-serif',
        fontSize: size, fill, letterSpacing: spacing,
        stroke: { color: line(fill), width: 5, join: 'round' },
      })

    const t1 = new Text({ text: 'CALIFORNIA', style: titleStyle(128, Core.paperWhite, 12) })
    t1.anchor.set(0.5, 0)
    t1.position.set(ctx.width / 2, 74)
    const t2 = new Text({ text: 'GAMES', style: titleStyle(128, Core.sunGold, 30) })
    t2.anchor.set(0.5, 0)
    t2.position.set(ctx.width / 2, 192)
    ctx.root.addChild(t1, t2)

    // --- event list -------------------------------------------------------
    const list = new Container()
    list.position.set(ctx.width / 2 - ROW_W / 2, LIST_TOP)
    ctx.root.addChild(list)

    EVENTS.forEach((ev, i) => {
      const root = new Container()
      root.position.set(0, i * ROW_H)
      const plate = new Graphics()
      // Solid, not translucent. The old translucent plates let a warm gradient
      // through and the blurb text became unreadable on every unselected row.
      plate.roundRect(0, 0, ROW_W, ROW_H - 10, 10).fill(Core.deepInk)
      plate.roundRect(0, 0, ROW_W, ROW_H - 10, 10).stroke({ color: Core.softInk, width: 2 })

      const name = new Text({
        text: ev.name.toUpperCase(),
        style: new TextStyle({
          fontFamily: 'Anton, Archivo, system-ui, sans-serif',
          fontSize: 38, fill: Core.paperWhite, letterSpacing: 2,
        }),
      })
      name.anchor.set(0, 0.5)
      name.position.set(28, (ROW_H - 10) / 2)

      const blurb = new Text({
        text: ev.blurb,
        style: new TextStyle({
          fontFamily: 'Archivo, system-ui, sans-serif',
          fontSize: 19, fill: Core.electricCyan, fontWeight: '600',
        }),
      })
      blurb.anchor.set(1, 0.5)
      blurb.position.set(ROW_W - 28, (ROW_H - 10) / 2)

      root.addChild(plate, name, blurb)
      list.addChild(root)
      this.rows.push({ root, plate, name, blurb })
    })

    // The audio keys are advertised here and nowhere else. They are global, so
    // they work in every event too, but the per-event legends are already four
    // and five items long and a sixth would push them past being read at all.
    // The menu is where a player looks for settings.
    const hint = new Text({
      text: 'ARROWS  SELECT     SPACE  START     M  MUSIC     N  AMBIENCE',
      style: new TextStyle({
        fontFamily: 'Archivo, system-ui, sans-serif',
        fontSize: 20, fill: Core.paperWhite, letterSpacing: 3, fontWeight: '600',
      }),
    })
    hint.anchor.set(0.5)
    hint.alpha = 0.78
    hint.position.set(ctx.width / 2, 1012)
    ctx.root.addChild(hint)
  }

  private buildPalm(ink: Hex): Container {
    const c = new Container()
    const g = new Graphics()
    const trunkH = 280
    g.moveTo(-11, 0)
      .quadraticCurveTo(6, -trunkH * 0.5, 26, -trunkH)
      .lineTo(42, -trunkH + 8)
      .quadraticCurveTo(22, -trunkH * 0.5, 9, 0)
      .closePath()
      .fill(ink)
    const cx = 32
    const cy = -trunkH + 4
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI * 0.97 + (i / 8) * Math.PI * 0.94
      const len = 96 + (i % 3) * 26
      const droop = 38 + (i % 2) * 18
      const nx = -Math.sin(a) * 23
      const ny = Math.cos(a) * 23
      g.moveTo(cx, cy)
        .quadraticCurveTo(cx + Math.cos(a) * len * 0.55 + nx, cy + Math.sin(a) * len * 0.55 + ny - 12,
                          cx + Math.cos(a) * len, cy + Math.sin(a) * len + droop)
        .quadraticCurveTo(cx + Math.cos(a) * len * 0.55 - nx, cy + Math.sin(a) * len * 0.55 - ny + 10, cx, cy)
        .fill(ink)
    }
    c.addChild(g)
    return c
  }

  update(dt: number): void {
    const input = this.ctx.input
    this.enterT = Math.min(1, this.enterT + dt * 1.6)
    this.sunPhase += dt

    if (input.justPressed(Action.Down)) {
      this.index = (this.index + 1) % EVENTS.length
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.tone({ freq: 340, duration: 0.06, type: 'square', gain: 0.06 })
    }
    if (input.justPressed(Action.Up)) {
      this.index = (this.index - 1 + EVENTS.length) % EVENTS.length
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.tone({ freq: 340, duration: 0.06, type: 'square', gain: 0.06 })
    }
    if (input.justPressed(Action.A) || input.justPressed(Action.Start)) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.tone({ freq: 520, toFreq: 900, duration: 0.2, type: 'triangle', gain: 0.12 })
      this.ctx.goto(EVENTS[this.index].id)
    }
    this.highlight = damp(this.highlight, this.index, 0.00008, dt)
  }

  render(): void {
    this.rows.forEach((row, i) => {
      const on = clamp01(1 - Math.abs(this.highlight - i))
      const e = smoothstep(0, 1, on)
      row.root.x = e * 30
      row.plate.alpha = 0.72 + e * 0.28
      row.plate.tint = on > 0.5 ? mix(Core.deepInk, Core.hotPink, 0.16 * e) : 0xffffff
      row.name.style.fill = on > 0.5 ? Core.sunGold : Core.paperWhite
      // Unselected blurbs stay readable: they dim, they do not disappear.
      row.blurb.alpha = 0.6 + e * 0.4
      // A short stagger on entry so the list assembles instead of popping.
      const stagger = clamp01((this.enterT - i * 0.06) * 2.4)
      row.root.alpha = stagger
    })
  }

  resize(): void {}
  exit(): void {}

  debug(): Record<string, unknown> {
    return { index: this.index, selected: EVENTS[this.index].id }
  }
}
