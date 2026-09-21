import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { Core, fromHsv, grade, mix, toHsv, type EventPalette, type Hex } from './Palette'

/**
 * The shared HUD system.
 *
 * Three independent blind reviews of three different events named the interface
 * as the loudest amateur signal in the frame, in almost the same words:
 *
 *   "The HUD is placeholder art. Grey-brown rounded capsule bars on a flat
 *    translucent band, generic letterspaced caps, SCORE hard against the right
 *    edge with no margin. It shares no shape language, no colour, and no weight
 *    with the world beneath it."
 *
 *   "A flat band across the top 8% with a grey depleted meter is the ugliest
 *    colour in the frame and the only pure grey in a frame with no greys."
 *
 *   "Four empty meter bars with zero fill... nothing reads worse than
 *    instrumentation at rest."
 *
 * The failures are all the same failure: the HUD was authored per event, in
 * neutral greys, with no relationship to the scene behind it. This builds every
 * readout from the event's own palette so the interface belongs to the world,
 * and gives all six events one shape language.
 *
 * Rules this encodes, each from a review:
 *  - No pure greys. Every HUD colour is derived from the event palette.
 *  - No full-width bands. A band plus plates is two box treatments; plates win.
 *  - Everything sits on one margin and one corner radius.
 *  - Meters never render empty — an unfilled track reads as a broken widget.
 *  - The accent never out-colours the player. See `capChroma` below.
 */

/**
 * The HUD accent must lose the colourfulness contest to the athlete, always.
 *
 * This was wrong for the whole first wave, and four builders found it
 * independently before anyone found it here: `themeFor` handed every event
 * `Core.sunGold`, which measures **0.765** value-weighted chroma — higher than
 * any event's reserved player hue. One of them traced a frame's measured
 * "subject" to the combo plate and the score digits. The interface built to stop
 * competing with the scene was competing with the player instead.
 *
 * Note why "pick a quieter gold" would not have fixed it: the subject detector
 * thresholds on a *percentile*, so being merely below the player is not enough
 * for anything with area. The accent has to sit under the reserved band
 * outright, which is what this enforces.
 *
 * Value-weighted chroma is `(max-min) * (0.45 + 0.55*max)`; in HSV that is
 * `v*s * (0.45 + 0.55*v)`, so the saturation that lands exactly on a ceiling is
 * closed-form. Hue and value are untouched — the accent keeps the scene's
 * temperature and its weight in the value plan, and only gives up purity.
 */
export const ACCENT_CHROMA_CEILING = 0.32

export function capChroma(c: Hex, ceiling = ACCENT_CHROMA_CEILING): Hex {
  const hsv = toHsv(c)
  const k = hsv.v * (0.45 + 0.55 * hsv.v)
  if (k <= 0) return c
  const maxS = ceiling / k
  return hsv.s <= maxS ? c : fromHsv({ h: hsv.h, s: maxS, v: hsv.v })
}

export const HUD_MARGIN = 40
export const HUD_RADIUS = 12
const LABEL_SIZE = 16
const VALUE_SIZE = 34
/** Plate floor height, the top of the value band, and its bottom inset. */
const PLATE_H = 74
const VALUE_TOP = 30
const VALUE_PAD_BOTTOM = 10

export interface HudTheme {
  /** Plate body. Dark, and tinted with the scene, never neutral. */
  plate: Hex
  /** Plate edge, a step up from the body. */
  edge: Hex
  /** Label text. */
  label: Hex
  /** Value text. */
  value: Hex
  /** The single accent, used for one thing only. */
  accent: Hex
}

/**
 * Derive a HUD theme from the event's palette so the interface shares the
 * scene's temperature. A reviewer called a neutral grey meter "the only pure
 * grey in a frame with no greys"; deriving it makes that impossible.
 */
export function themeFor(pal: EventPalette): HudTheme {
  const plate = grade(mix(pal.shade, Core.deepInk, 0.45), { valScale: 0.8, satScale: 0.9 })
  return {
    plate,
    edge: grade(plate, { valScale: 1.7, satScale: 0.8 }),
    label: mix(Core.paperWhite, plate, 0.42),
    value: Core.paperWhite,
    // Derived from the scene, then held under the reserved-hue band. Falls back
    // to gold's hue only when the palette has no accent of its own.
    accent: capChroma(grade(pal.accent ?? Core.sunGold, { valScale: 1.12 })),
  }
}

const labelStyle = (t: HudTheme, size = LABEL_SIZE): TextStyle =>
  new TextStyle({
    fontFamily: 'Archivo, system-ui, sans-serif',
    fontSize: size, fill: t.label, fontWeight: '600', letterSpacing: 1.6,
  })

const valueStyle = (size: number, fill: Hex): TextStyle =>
  new TextStyle({
    fontFamily: 'Anton, Archivo, system-ui, sans-serif',
    fontSize: size, fill, letterSpacing: 1,
  })

/** A plate: opaque body, lit top edge, dark base, one radius. */
export function plate(t: HudTheme, w: number, h: number): Graphics {
  const g = new Graphics()
  g.roundRect(0, 3, w, h, HUD_RADIUS).fill({ color: Core.deepInk, alpha: 0.35 })
  g.roundRect(0, 0, w, h, HUD_RADIUS).fill(t.plate)
  g.roundRect(0.5, 0.5, w - 1, h - 1, HUD_RADIUS).stroke({ color: t.edge, width: 1.5, alpha: 0.7 })
  g.moveTo(HUD_RADIUS, 1.5).lineTo(w - HUD_RADIUS, 1.5)
    .stroke({ color: t.edge, width: 2, alpha: 0.5 })
  return g
}

/**
 * A label-over-value readout on a plate. The shape every event uses, so the six
 * of them stop each inventing their own.
 */
export class Readout {
  readonly container = new Container()
  private readonly text: Text

  constructor(t: HudTheme, label: string, opts: {
    width?: number
    valueSize?: number
    valueColor?: Hex
    align?: 'left' | 'right'
  } = {}) {
    const w = opts.width ?? 190
    const vs = opts.valueSize ?? VALUE_SIZE
    /*
     * Height follows the value size instead of being a fixed 74.
     *
     * The value used to be top-anchored at a hard y of 30 in a 74px plate,
     * which is fine at the 34 default and overflows the bottom edge at the 36
     * and 40 that four events ask for — the digits sat on the border. A player
     * caught it across two events at once: "check in every game if the dynamic
     * numbers are placed into the boxes."
     *
     * So: bottom-anchored with a fixed inset, which cannot overflow whatever
     * the size, and a plate tall enough that the ascenders still clear the
     * label. 74 stays the floor so no existing layout moves.
     */
    const h = Math.max(PLATE_H, VALUE_TOP + Math.round(vs * 1.16) + VALUE_PAD_BOTTOM)
    const align = opts.align ?? 'left'
    this.container.addChild(plate(t, w, h))

    const lab = new Text({ text: label, style: labelStyle(t) })
    lab.position.set(align === 'left' ? 16 : w - 16, 11)
    lab.anchor.set(align === 'left' ? 0 : 1, 0)
    this.container.addChild(lab)

    this.text = new Text({
      text: '',
      style: valueStyle(vs, opts.valueColor ?? t.value),
    })
    this.text.position.set(align === 'left' ? 16 : w - 16, h - VALUE_PAD_BOTTOM)
    this.text.anchor.set(align === 'left' ? 0 : 1, 1)
    this.container.addChild(this.text)
    // Marks this subtree for `__cg.hudAudit()`, which checks every live readout's
    // value actually sits inside its plate.
    this.container.label = 'readout'
  }

  /** Only touches the Text when the string actually changes. */
  set(value: string): void {
    if (this.text.text !== value) this.text.text = value
  }

  get width(): number {
    return (this.container.children[0] as Graphics).width
  }
}

/**
 * A meter that never reads as a broken widget.
 *
 * "Nothing reads worse than instrumentation at rest." An empty track is what an
 * unfinished UI looks like, so the track carries a visible floor and the fill
 * keeps a minimum presence even at zero.
 */
export class Meter {
  readonly container = new Container()
  private readonly fill: Graphics
  private readonly w: number

  constructor(t: HudTheme, label: string, width = 190, color?: Hex) {
    this.w = width
    void this.w
    const lab = new Text({ text: label, style: labelStyle(t, 14) })
    lab.position.set(0, 0)
    this.container.addChild(lab)

    const track = new Graphics()
    track.roundRect(0, 22, width, 9, 4.5).fill(grade(t.plate, { valScale: 1.5 }))
    this.container.addChild(track)

    this.fill = new Graphics()
    this.fill.roundRect(0, 22, width, 9, 4.5).fill(color ?? t.accent)
    this.container.addChild(this.fill)
    this.set(0)
  }

  /** @param frac 0..1 */
  set(frac: number): void {
    const f = frac < 0 ? 0 : frac > 1 ? 1 : frac
    // Never fully empty: a zero-width fill is indistinguishable from a bug.
    this.fill.scale.x = 0.035 + f * 0.965
  }
}

/**
 * A call-out anchored to a world point, with a hard offset shadow and a leader.
 *
 * Reviews repeatedly found trick and failure text "floating in empty sky,
 * nowhere near the event, in a colour a step off the sky it is printed on".
 * Feedback belongs to the thing it describes.
 */
export class Callout {
  readonly container = new Container()
  private readonly shadow: Text
  private readonly face: Text
  private readonly leader = new Graphics()
  private life = 0

  constructor(size = 54) {
    this.container.addChild(this.leader)
    this.shadow = new Text({ text: '', style: valueStyle(size, Core.deepInk) })
    this.shadow.anchor.set(0.5)
    this.shadow.position.set(4, 5)
    this.face = new Text({ text: '', style: valueStyle(size, Core.paperWhite) })
    this.face.anchor.set(0.5)
    this.container.addChild(this.shadow, this.face)
    this.container.visible = false
  }

  show(text: string, color: Hex): void {
    this.shadow.text = text
    this.face.text = text
    this.face.style.fill = color
    this.life = 1.4
    this.container.visible = true
  }

  /** Call from update(); `dt` is the fixed step. */
  tick(dt: number): void {
    if (this.life <= 0) return
    this.life -= dt
    if (this.life <= 0) this.container.visible = false
  }

  /**
   * Place it relative to the subject, with a leader drawn back toward them so
   * the text is tied to the event rather than floating.
   */
  placeAt(x: number, y: number, offsetX = 0, offsetY = -120): void {
    if (!this.container.visible) return
    this.container.position.set(x + offsetX, y + offsetY)
    this.container.alpha = Math.min(1, this.life * 2.6)
    this.leader.clear()
    this.leader.moveTo(-offsetX * 0.2, -offsetY * 0.28)
      .lineTo(-offsetX * 0.62, -offsetY * 0.82)
      .stroke({ color: Core.deepInk, width: 4, alpha: 0.5, cap: 'round' })
  }

  get active(): boolean {
    return this.life > 0
  }
}

/* --------------------------------------------------------- control hint --- */

/** One key and what it does. `key` is the glyph shown, not a KeyboardEvent code. */
export interface ControlBinding {
  key: string
  action: string
}

/**
 * The row of key chips that tells a player how to play.
 *
 * This existed in exactly one event out of six. Four of the others — including
 * every event that wins its blind review — shipped with **no on-screen controls
 * at all**, and the menu only explains how to drive the menu. The reason is
 * worth recording: this project was judged for months by critics asked about
 * art direction, and not one was ever asked whether a player could work out how
 * to start. What is never measured is never built.
 *
 * It does NOT disappear. It fades from full strength to a quiet resting alpha
 * and stays there, because a legend that vanishes after a few seconds is
 * useless to a player who is still learning the game — you cannot look
 * something up once it has gone. The first version auto-hid after nine seconds
 * and the very first person to play it said so immediately.
 *
 * The critic's objection to permanent furniture is real but it is not the
 * player's problem: the resting state is quiet enough to sit under the action,
 * and captures hide it outright via `setHintsEnabled(false)` rather than
 * relying on it having faded. That is also more reliable than the old gate —
 * three blind reviews were spent on a frame with a tutorial bar across the
 * player's feet because a wall-clock wait bought less game time than it looked.
 */
/**
 * Global switch for every control legend. Captures turn them off so a critic
 * never judges a frame with a tutorial bar in it; players never see this.
 * Reached from outside as `window.__cg.hints(false)`.
 */
let hintsEnabled = true
export function setHintsEnabled(on: boolean): void { hintsEnabled = on }
export function hintsAreEnabled(): boolean { return hintsEnabled }

/** Resting opacity once the legend has settled. Readable, but under the action. */
const HINT_REST_ALPHA = 0.58

export class ControlHint {
  readonly container = new Container()
  private life: number
  private readonly fade: number

  constructor(t: HudTheme, bindings: ControlBinding[], seconds = 6, fade = 1.5) {
    this.life = seconds + fade
    this.fade = fade

    const PAD_X = 22
    const GAP = 26
    const CHIP_H = 34
    const H = 68

    // Measure first so the plate fits the content rather than a guessed width.
    const chips: { chip: Graphics; key: Text; label: Text; w: number }[] = []
    for (const b of bindings) {
      const key = new Text({ text: b.key, style: labelStyle(t, 17) })
      key.style.fill = t.value
      const label = new Text({ text: b.action, style: labelStyle(t, 17) })
      const chipW = Math.max(CHIP_H, key.width + 20)
      const chip = new Graphics()
        .roundRect(0, 0, chipW, CHIP_H, 7)
        .fill({ color: t.edge, alpha: 0.5 })
        .stroke({ color: t.edge, width: 1.5, alpha: 0.9 })
      chips.push({ chip, key, label, w: chipW + 10 + label.width })
    }

    const inner = chips.reduce((a, c) => a + c.w, 0) + GAP * (chips.length - 1)
    const w = inner + PAD_X * 2
    this.container.addChild(plate(t, w, H))

    let x = PAD_X
    for (const c of chips) {
      c.chip.position.set(x, (H - CHIP_H) / 2)
      c.key.position.set(x + (c.chip.width - c.key.width) / 2, (H - c.key.height) / 2)
      c.label.position.set(x + c.chip.width + 10, (H - c.label.height) / 2)
      this.container.addChild(c.chip, c.key, c.label)
      x += c.w + GAP
    }

    // Bottom centre, on the shared margin.
    this.container.position.set(Math.round((1920 - w) / 2), 1080 - HUD_MARGIN - H)
  }

  /** Call from update(); `dt` is the fixed step. */
  tick(dt: number): void {
    if (!hintsEnabled) {
      this.container.visible = false
      return
    }
    this.container.visible = true
    if (this.life > 0) this.life -= dt
    // Full strength while it is new, then settle to the resting alpha and STAY.
    const t = Math.min(1, Math.max(0, this.life / this.fade))
    this.container.alpha = HINT_REST_ALPHA + (1 - HINT_REST_ALPHA) * t
  }

  /** Bring it back to full strength — a toggle, or a pause screen. */
  show(seconds = 6): void {
    this.life = seconds + this.fade
    this.container.visible = true
    this.container.alpha = 1
  }

  /** True while the legend is at more than its resting strength. */
  get visible(): boolean {
    return hintsEnabled
  }
}

/* ------------------------------------------------------- run end prompt --- */

/**
 * The two lines every event shows once a run is over: play again, or leave.
 *
 * Until now no event offered either — the only way out of a finished run was
 * the browser's back button, and the only way to replay it was to reload. The
 * original ends a run in two ways (the clock, or the third fall) and both drop
 * you somewhere you can choose.
 *
 * One helper so the six events phrase it identically. Keys are `Action.Start`
 * (Enter) and `Action.Back` (Escape), which `Input` already maps.
 */
export function endPrompt(t: HudTheme, again = 'PLAY AGAIN'): Container {
  const c = new Container()
  const rows: [string, string][] = [['ENTER', again], ['ESC', 'MENU']]
  const GAP = 54
  let x = 0
  const built: { chip: Graphics; key: Text; label: Text; w: number }[] = []
  for (const [key, action] of rows) {
    const k = new Text({ text: key, style: labelStyle(t, 17) })
    k.style.fill = t.value
    const l = new Text({ text: action, style: labelStyle(t, 17) })
    const cw = Math.max(34, k.width + 20)
    const chip = new Graphics()
      .roundRect(0, 0, cw, 34, 7)
      .fill({ color: t.edge, alpha: 0.5 })
      .stroke({ color: t.edge, width: 1.5, alpha: 0.9 })
    built.push({ chip, key: k, label: l, w: cw + 10 + l.width })
  }
  const total = built.reduce((a, b) => a + b.w, 0) + GAP * (built.length - 1)
  for (const b of built) {
    b.chip.position.set(x, 0)
    b.key.position.set(x + (b.chip.width - b.key.width) / 2, (34 - b.key.height) / 2)
    b.label.position.set(x + b.chip.width + 10, (34 - b.label.height) / 2)
    c.addChild(b.chip, b.key, b.label)
    x += b.w + GAP
  }
  c.position.x = Math.round(-total / 2)
  return c
}

/* --------------------------------------------------------------- toasts --- */

/**
 * A short confirmation, centred near the top of the design space.
 *
 * This lives outside the scene graph on purpose. Audio switches are global —
 * they work on the menu, mid-run and on an end card — so their feedback cannot
 * belong to any one scene's HUD, and it has to survive the scene being
 * destroyed underneath it. `App` owns the layer; this owns what goes in it.
 */
/* The design width. Not imported from `App` — `App` imports this module,
 * and a cycle between the two would be a needless hazard for one number. */
const TOAST_STAGE_W = 1920

let toastLayer: Container | null = null
let toastNode: { c: Container; text: Text; until: number } | null = null

export function setToastLayer(c: Container | null): void {
  toastLayer = c
}

export function showToast(message: string, seconds = 1.8): void {
  if (!toastLayer) return
  if (!toastNode) {
    const c = new Container()
    const t = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: 'Archivo, system-ui, sans-serif',
        fontSize: 20,
        fontWeight: '700',
        letterSpacing: 3,
        fill: Core.paperWhite,
      }),
    })
    const bg = new Graphics()
    c.addChild(bg, t)
    c.eventMode = 'none'
    toastLayer.addChild(c)
    toastNode = { c, text: t, until: 0 }
  }
  const n = toastNode
  n.text.text = message
  const w = Math.round(n.text.width + 44)
  const h = 44
  const bg = n.c.children[0] as Graphics
  bg.clear()
  bg.roundRect(0, 0, w, h, HUD_RADIUS).fill({ color: Core.deepInk, alpha: 0.82 })
  bg.roundRect(0.5, 0.5, w - 1, h - 1, HUD_RADIUS).stroke({ color: Core.paperWhite, width: 1.5, alpha: 0.3 })
  n.text.position.set(22, (h - n.text.height) / 2)
  n.c.position.set(Math.round((TOAST_STAGE_W - w) / 2), 34)
  n.c.alpha = 1
  n.until = seconds
}

/** Called once per frame by `App`; `dt` in seconds. */
export function updateToast(dt: number): void {
  const n = toastNode
  if (!n || n.until <= 0) return
  n.until -= dt
  // Hold, then a short fade. A toast that fades from the first frame reads as
  // already leaving.
  n.c.alpha = n.until > 0.45 ? 1 : Math.max(0, n.until / 0.45)
  if (n.until <= 0) n.c.alpha = 0
}
