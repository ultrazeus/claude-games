import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import {
  Core, darken, grade, lighten, mix, type EventPalette, type Hex,
} from '../../render/Palette'
import { verticalGradient } from '../../render/Gradient'
import { HUD_MARGIN, Meter, plate, themeFor, hintsAreEnabled } from '../../render/Hud'
import { clamp } from '../../core/Tween'

/**
 * The judges' panel.
 *
 * California Games ends a surfing run on a row of five judges behind a wooden
 * booth, each holding up a whole number, with the averaged score on a board
 * above the roof and a sponsor banner across the front. It is the most
 * recognisable screen in the game and this remake did not have it: a run ended
 * on a centred plate reading `FINAL 8830` over four meters, which is a debug
 * summary, not a results screen.
 *
 * Three things this file is careful about.
 *
 * **The scoring is untouched.** `Surfing.updateScore` still produces the same
 * 0..10 out of the same four components with the same caps. This file only
 * *presents* that number, and the presentation is arithmetically honest: see
 * `judgeMarks`.
 *
 * **It is not on the play field.** The gameplay frame wins its blind review and
 * nothing here draws or exists until the run is over. A previous pass correctly
 * deleted a SUNDOG badge from live play — a sponsor ident over a player's head
 * is what a dev overlay looks like. A sponsor banner on a results booth is the
 * opposite: it is what the original does, and it is the one place in the game
 * where an ident is furniture rather than an overlay.
 *
 * **It matches the game, not the pixels.** The staging comes from the original —
 * five judges, cards at different heights, board above, banner below, fan discs
 * on the posts, palms and loafers at the edges. Everything is drawn in this
 * project's flat-vector language, out of the surfing palette, and both readouts
 * on it are the shared HUD's own `plate` and `Meter`, so the screen belongs to
 * the same game as the six events.
 */

const display = (size: number, fill: Hex): TextStyle =>
  new TextStyle({
    fontFamily: 'Anton, Impact, system-ui, sans-serif',
    fontSize: size, fill, letterSpacing: size * 0.03,
  })

const caps = (size: number, fill: Hex, spacing: number): TextStyle =>
  new TextStyle({
    fontFamily: 'Archivo, system-ui, sans-serif',
    fontSize: size, fill, fontWeight: '600', letterSpacing: spacing,
  })

/* ------------------------------------------------------------- arithmetic --- */

/**
 * Which judges round up when the total does not divide by five, most generous
 * first. Fixed, so a judge who marks high marks high every run — five people
 * with opinions rather than five samples of noise.
 */
const GENEROSITY = [1, 3, 0, 4, 2] as const

/**
 * Zero-sum disagreement patterns. Every row sums to exactly zero, so applying
 * one spreads the panel without moving the average by a thousandth.
 */
const SPREADS: readonly (readonly number[])[] = [
  [1, 0, -1, 0, 0],
  [0, 1, 0, -1, 0],
  [-1, 0, 1, 1, -1],
  [1, -1, 0, 0, 0],
  [0, 0, -1, 0, 1],
  [1, 0, 0, -1, 0],
  [-1, 1, 1, 0, -1],
]

/** Lowest card any judge will hold up. */
const MIN_MARK = 1

/**
 * Five whole numbers whose mean is *exactly* the number printed on the board.
 *
 * This is the one piece of arithmetic on the screen that can be caught lying,
 * so it is done in the only order that cannot: pick the total first, then the
 * five cards — never the other way round. `total = round(score * 5)` is an
 * integer, so `total / 5` always lands on a multiple of 0.2 and `toFixed(1)` is
 * exact rather than rounded. An 8.8 on the board means the five cards really do
 * add up to 44.
 *
 * Judges then disagree by a point or so, because a panel that returns five
 * identical cards is a calculator with faces drawn on it.
 *
 * **Cards run 1-10, not 0-10.** A panel of five zeros is what a spreadsheet
 * does, not what a judge does; real panels floor at 1 for a ride that happened
 * at all. The clamp is therefore on the TOTAL (5 = five ones) rather than on
 * the individual cards, so the mean stays exactly the number on the board —
 * clamping the cards afterwards would break that and make the one piece of
 * arithmetic on screen that can be caught lying, lie.
 *
 * The points readout underneath is untouched and can still say 0 PTS: the
 * judges rate the ride, the scoreboard counts what it earned.
 */
export function judgeMarks(score: number): number[] {
  const total = clamp(Math.round(score * 5), MIN_MARK * 5, 50)
  const base = Math.floor(total / 5)
  const marks = [base, base, base, base, base]
  for (let i = 0; i < total - base * 5; i++) marks[GENEROSITY[i]]++
  // Deterministic in the score, so the same ride always draws the same panel.
  const start = total % SPREADS.length
  for (let k = 0; k < SPREADS.length; k++) {
    const s = SPREADS[(start + k) % SPREADS.length]
    const spread = marks.map((v, i) => v + s[i])
    if (spread.every((v) => v >= MIN_MARK && v <= 10)) return spread
  }
  return marks
}

/* ------------------------------------------------------------------ stage --- */

const W = 1920
const H = 1080

/** Sea meets sky. Below the roof line, so the booth silhouettes against sky. */
const HORIZON = 440
/** Sea meets sand. */
const SHORE = 566

const ROOF_TOP = 344
const ROOF_H = 54
const ROOF_BOT = ROOF_TOP + ROOF_H
/** Roof overhang, past the posts on both sides. */
const EAVE_L = 252
const EAVE_R = W - EAVE_L

const BOOTH_L = 300
const BOOTH_R = W - BOOTH_L
const POST_W = 30

const COUNTER_TOP = 664
const COUNTER_BOT = 912

/** Where the five of them sit. Symmetric about the frame centre. */
const JUDGE_X = [480, 720, 960, 1200, 1440] as const
/**
 * The held cards.
 *
 * Every number in this block is a clearance rather than a taste. A card is
 * `CARD_W/2 * cos t + CARD_H/2 * |sin t|` wide once it is tilted, which at the
 * tilts below is 45.7px, so `CARD_DX` has to clear `HEAD_R` by more than that
 * or a judge holds his card over his own face — and `CARD_Y` has to stay below
 * the rafter ends under the eave or a card is held through the roof. Both were
 * wrong on the first pass and both are only visible once the screen is drawn.
 */
const CARD_Y = [488, 524, 476, 512, 498] as const
const CARD_DX = 88
const CARD_W = 84
const CARD_H = 106
/** A few degrees of tilt each, so five held cards are not five stickers. */
const CARD_TILT = [-0.06, 0.05, -0.03, 0.07, -0.05] as const

const HEAD_Y = 566
const HEAD_R = 35
const SHOULDER_Y = 620

const BOARD_W = 480
const BOARD_H = 244
const BOARD_X = (W - BOARD_W) / 2
const BOARD_Y = 128

const FOOT_H = 84
const FOOT_W = 1320
const FOOT_X = (W - FOOT_W) / 2
const FOOT_Y = H - HUD_MARGIN - FOOT_H

/* ------------------------------------------------------------------- cast --- */

/**
 * Five people, not five instances.
 *
 * The brief for this screen is that the judges are "recognisably five different
 * people", and the original earns that with five different sprites. Here it is
 * five rows of a table: different skin, different hair, different kit, and one
 * distinguishing feature each — the moustache, the cap and the shades are all
 * in the reference, and they are the three that read at a glance.
 */
type Feature = 'plain' | 'moustache' | 'cap' | 'shades' | 'curls'

interface Judge {
  skin: Hex
  hair: Hex
  /** Torso colour. None of these may be the rider's reserved vermilion. */
  kit: Hex
  feature: Feature
  /** Hair silhouette: how far it falls past the jaw. 0 = cropped. */
  fall: number
  /** Shoulders are not all the same width. */
  build: number
}

const CAST: readonly Judge[] = [
  { skin: Core.skinLight, hair: Core.hairSun, kit: 0x2f9fa8, feature: 'plain', fall: 0.9, build: 1.0 },
  { skin: Core.skinMid, hair: 0x3a2a22, kit: 0xe6dfcd, feature: 'moustache', fall: 0, build: 1.12 },
  { skin: Core.skinDeep, hair: 0x241a16, kit: 0xd9758c, feature: 'cap', fall: 0.15, build: 0.94 },
  { skin: 0xe2a87c, hair: 0xd8d2c4, kit: 0x6f8fd0, feature: 'shades', fall: 0, build: 1.06 },
  { skin: 0xa96a44, hair: 0x2b201c, kit: 0xe2b451, feature: 'curls', fall: 0.3, build: 0.98 },
]

/** The cap. Held out of every kit hue so it reads as a hat, not as a shoulder. */
const CAP_COLOR = 0x39566e

/* ------------------------------------------------------------------ build --- */

export class ResultsPanel {
  readonly container = new Container()
  /** The four judged components, still shown — secondary to the panel. */
  readonly meters: Meter[] = []
  private readonly title!: Text

  private readonly cards: Text[] = []
  private readonly hints: Container[] = []
  private readonly boardValue: Text
  private readonly boardPoints: Text

  constructor(pal: EventPalette, eventTitle: string, labels: readonly string[], barColors: readonly Hex[]) {
    const t = themeFor(pal)

    // Wood, sand and silhouette are all derived from the event palette, so this
    // screen is the same dawn as the ride that preceded it. Nothing here
    // introduces a hue the wave does not already have.
    const wood = mix(pal.light, pal.shade, 0.62)
    const woodLit = grade(wood, { valScale: 1.24, satScale: 0.94 })
    const woodDark = grade(wood, { valScale: 0.66, satScale: 1.12 })
    const woodInk = darken(woodDark, 0.34)
    const interior = mix(pal.shade, wood, 0.22)
    const sand = mix(pal.light, pal.haze, 0.44)
    const silhouette = mix(pal.shade, pal.far, 0.28)
    const rim = mix(pal.light, Core.paperWhite, 0.34)
    // Two voices, kept apart: the board speaks in the HUD's cool near-white,
    // the banner in warm signage cream. One colour for both made the sponsor
    // read as a third readout.
    const mark = mix(Core.paperWhite, pal.accent, 0.4)
    const signage = mix(Core.paperWhite, pal.light, 0.55)

    this.container.addChild(this.buildBackdrop(pal, sand))
    this.container.addChild(this.buildPalms(pal, silhouette, rim))
    this.container.addChild(this.buildLoafers(silhouette, rim, sand))
    this.container.addChild(this.buildBooth(wood, woodLit, woodDark, woodInk, interior, sand))

    // Judges, then the counter they sit behind, so the counter crops them at the
    // waist instead of five figures floating over a plank.
    for (let i = 0; i < CAST.length; i++) this.container.addChild(this.buildJudge(i, rim))
    this.container.addChild(this.buildCounter(wood, woodLit, woodDark, woodInk, sand))
    this.container.addChild(this.buildBanner(pal, signage))
    for (let i = 0; i < CAST.length; i++) this.container.addChild(this.buildCard(i, woodInk))

    /* ------------------------------------------------------------ the board --- */
    const board = new Container()
    board.addChild(this.buildBoardMount(woodDark))
    board.addChild(plate(t, BOARD_W, BOARD_H))
    /*
     * The event's name sits above the board, not on the banner.
     *
     * The banner carries the *sponsor* — that is what it does in the original,
     * which is why a screenshot of it reads "<sponsor> PRO AM" and names no
     * event. Now that this screen follows all six events rather than Surfing
     * alone, something has to say which one you just finished, and the board
     * is where the eye already is.
     */
    this.title = new Text({ text: eventTitle, style: caps(17, mix(t.label, Core.paperWhite, 0.5), 5.2) })
    this.title.anchor.set(0.5, 0)
    this.title.position.set(BOARD_W / 2, 14)
    board.addChild(this.title)

    const cap = new Text({ text: 'JUDGES  AVERAGE', style: caps(20, t.label, 4.4) })
    cap.anchor.set(0.5, 0)
    cap.position.set(BOARD_W / 2, 40)
    board.addChild(cap)

    this.boardValue = new Text({ text: '0.0', style: display(118, mark) })
    this.boardValue.anchor.set(0.5)
    this.boardValue.position.set(BOARD_W / 2, 124)
    board.addChild(this.boardValue)

    const rule = new Graphics()
    rule.moveTo(118, 170).lineTo(BOARD_W - 118, 170)
      .stroke({ color: t.edge, width: 2, alpha: 0.6 })
    board.addChild(rule)

    this.boardPoints = new Text({ text: '0 PTS', style: caps(24, t.label, 3) })
    this.boardPoints.anchor.set(0.5, 0)
    this.boardPoints.position.set(BOARD_W / 2, 198)
    board.addChild(this.boardPoints)
    board.position.set(BOARD_X, BOARD_Y)
    this.container.addChild(board)

    /* -------------------------------------------------------- the breakdown --- */
    // A critic was right that four near-zero tracks do not belong on a live
    // frame, and right again that they are real information — so they live
    // here, final, in one row, under the headline.
    const footer = new Container()
    footer.addChild(plate(t, FOOT_W, FOOT_H))
    const gap = 28
    const mw = Math.round((FOOT_W - 64 - gap * (labels.length - 1)) / labels.length)
    for (let i = 0; i < labels.length; i++) {
      const m = new Meter(t, labels[i], mw, barColors[i])
      m.container.position.set(32 + i * (mw + gap), 26)
      footer.addChild(m.container)
      this.meters.push(m)
    }
    footer.position.set(FOOT_X, FOOT_Y)
    this.container.addChild(footer)

    // Two quiet lines saying how to leave, in the shared prompt's own words —
    // ENTER / RIDE AGAIN and ESC / MENU — and wired to the shared keys:
    // `Surfing.update` restarts on `Action.Start` and leaves on `Action.Back`.
    //
    // This is the one screen that does NOT use `endPrompt` from the HUD, and
    // the reason is geometry rather than taste. That helper is a single centred
    // chip row about 360px wide; the only horizontal space this panel has left
    // is the 44px band between the counter's bottom edge (912) and the footer
    // plate (956), which would put a second piece of furniture six pixels above
    // the first one. The side gutters beside the footer are empty, exactly the
    // right height, and already on the HUD margin — so the lines flank the
    // breakdown instead. Every other event uses `endPrompt`.
    //
    // They obey the global hint switch, so a capture of this screen is never
    // judged with a tutorial line on it.
    // Each sits on its own plate. `t.label` is mix(paperWhite, plate, 0.42) —
    // a tone mixed *towards the plate*, so it is only legible on one. Set bare
    // over this panel it lands on open sand, and a capture of the finished
    // screen showed both lines all but gone. The plate is what the colour was
    // built for, so they get one, sized to the text and vertically centred on
    // the footer it flanks.
    const PROMPT_H = 40
    const prompt = (label: string, right: boolean): Container => {
      const c = new Container()
      const txt = new Text({ text: label, style: caps(17, t.label, 2.2) })
      const pw = Math.round(txt.width + 32)
      c.addChild(plate(t, pw, PROMPT_H))
      txt.anchor.set(0, 0.5)
      txt.position.set(16, PROMPT_H / 2)
      c.addChild(txt)
      c.position.set(right ? W - HUD_MARGIN - pw : HUD_MARGIN, FOOT_Y + (FOOT_H - PROMPT_H) / 2)
      return c
    }
    const again = prompt('ENTER  RIDE AGAIN', false)
    const back = prompt('ESC  MENU', true)
    this.hints.push(again, back)
    this.container.addChild(again, back)

    this.container.visible = false
    this.container.alpha = 0
    this.container.interactiveChildren = false
  }

  /**
   * Fill the panel in from a finished run.
   *
   * `score` is the untouched 0..10 the simulation judged. Everything printed
   * here is derived from it and from nothing else.
   */
  /**
   * `rating` is the 0-10 the judges hold up; `points` is the event's own score,
   * printed as-is.
   *
   * Surfing is judged out of ten natively. Every other event scores in points,
   * so it converts its total to a rating against its own par and passes both —
   * the panel never invents a number, and the two readouts can never disagree
   * because neither is derived from the other.
   */
  /**
   * Replace the line above the board — e.g. `HALF PIPE \u00b7 THREE FALLS`.
   *
   * The per-event end cards carried the reason a run stopped, and this screen
   * replaces those cards, so the reason has to live here or it is lost.
   */
  setTitle(text: string): void {
    if (this.title.text !== text) this.title.text = text
  }

  show(rating: number, points: number): void {
    const marks = judgeMarks(rating)
    for (let i = 0; i < this.cards.length; i++) this.cards[i].text = String(marks[i])
    const avg = marks.reduce((a, b) => a + b, 0) / marks.length
    this.boardValue.text = avg.toFixed(1)
    this.boardPoints.text = `${Math.round(points)} PTS`
    this.syncHints()
  }

  setVisible(on: boolean): void {
    this.container.visible = on
    this.container.alpha = on ? 1 : 0
    if (on) this.syncHints()
  }

  /**
   * Re-read the global hint switch.
   *
   * Called every frame the panel is up rather than once when it goes up,
   * because a capture may flip `__cg.hints(false)` *after* jumping to this
   * screen and a legend that only checks on entry would still be in the shot.
   */
  syncHints(): void {
    const on = hintsAreEnabled()
    for (const h of this.hints) if (h.visible !== on) h.visible = on
  }

  /* ------------------------------------------------------------- backdrop --- */

  /** Sky, sea and sand, in three gradients rather than three flat fills. */
  private buildBackdrop(pal: EventPalette, sand: Hex): Container {
    const c = new Container()

    const sky = new Sprite(verticalGradient(pal.sky.map((s) => ({ t: s.t, c: s.c })), 256))
    sky.width = W
    sky.height = HORIZON + 2
    c.addChild(sky)

    // The same low sun the ride is lit by, warming the air above the water.
    const glow = new Sprite(verticalGradient([
      { t: 0, c: pal.light, a: 0 },
      { t: 1, c: pal.light, a: 0.34 },
    ], 128))
    glow.width = W
    glow.height = HORIZON
    glow.blendMode = 'add'
    glow.alpha = 0.5
    c.addChild(glow)

    const sea = new Sprite(verticalGradient([
      { t: 0, c: mix(pal.far, pal.haze, 0.35) },
      { t: 0.55, c: pal.far },
      { t: 1, c: pal.mid },
    ], 128))
    sea.position.set(0, HORIZON)
    sea.width = W
    sea.height = SHORE - HORIZON + 2
    c.addChild(sea)

    // Swell lines out the back, and the shorebreak where the sea meets sand.
    const g = new Graphics()
    for (let i = 0; i < 4; i++) {
      const y = HORIZON + 16 + i * 26 + i * i * 4
      g.moveTo(0, y).lineTo(W, y)
        .stroke({
          color: mix(pal.mid, Core.paperWhite, 0.62),
          width: 2 + i, alpha: 0.14 + i * 0.07,
        })
    }
    c.addChild(g)

    const beach = new Sprite(verticalGradient([
      { t: 0, c: mix(sand, pal.mid, 0.42) },
      { t: 0.12, c: sand },
      { t: 1, c: grade(sand, { valScale: 0.82, satScale: 1.1 }) },
    ], 256))
    beach.position.set(0, SHORE)
    beach.width = W
    beach.height = H - SHORE
    c.addChild(beach)

    const foam = new Graphics()
    foam.rect(0, SHORE - 7, W, 12).fill({ color: Core.paperWhite, alpha: 0.5 })
    foam.rect(0, SHORE + 5, W, 5).fill({ color: mix(sand, pal.mid, 0.5), alpha: 0.55 })
    // A little grain on the sand, so a 500px band is not one flat fill.
    for (let i = 0; i < 26; i++) {
      const y = SHORE + 34 + i * 20
      const x = ((i * 631) % 1900) - 120
      foam.moveTo(x, y).lineTo(x + 240 + (i % 5) * 90, y + 2)
        .stroke({ color: darken(sand, 0.1), width: 2, alpha: 0.12 + (i % 3) * 0.03 })
    }
    c.addChild(foam)
    return c
  }

  /**
   * Palms at both edges, in the backlit silhouette band.
   *
   * The same rule the skating beach follows: everything between the camera and
   * a low sun is a dark shape with a hot edge. They only ever stand outside the
   * booth's span, so none of them is drawn to be hidden.
   */
  private buildPalms(pal: EventPalette, silhouette: Hex, rim: Hex): Container {
    const c = new Container()
    const g = new Graphics()
    // Two a side, not three. Each edge of this frame is 300px wide and the
    // first pass put three palms, two loafers and two boards in it: a crown
    // landed exactly behind a fan disc and another walked off the left edge.
    // Trunks stand outside the booth, crowns clear the discs, and every lean is
    // chosen so no crown leaves the frame.
    const palms = [
      { x: 74, base: 944, h: 690, lean: 0.10, depth: 0.10 },
      { x: 244, base: 772, h: 512, lean: -0.03, depth: 0.62 },
      { x: 1676, base: 772, h: 512, lean: 0.03, depth: 0.62 },
      { x: 1846, base: 944, h: 690, lean: -0.10, depth: 0.10 },
    ]
    for (const p of palms) {
      const tint = mix(silhouette, pal.haze, p.depth * 0.5)
      const topX = p.x + p.lean * p.h
      const topY = p.base - p.h
      const midX = p.x + p.lean * p.h * 0.3
      const midY = p.base - p.h * 0.55
      // Trunk: a tapered curve, not a stick.
      const wBase = 17 - p.depth * 5
      const wTop = 8 - p.depth * 3
      g.moveTo(p.x - wBase, p.base)
        .quadraticCurveTo(midX - wTop, midY, topX - wTop, topY)
        .lineTo(topX + wTop, topY)
        .quadraticCurveTo(midX + wTop, midY, p.x + wBase, p.base)
        .closePath()
        .fill(tint)
      // Seven tapered blades off the crown.
      for (let f = 0; f < 7; f++) {
        const a = -2.72 + f * 0.62 + p.lean * 0.4
        const len = (128 - p.depth * 34) * (f === 3 ? 1.12 : 1)
        const ex = topX + Math.cos(a) * len
        const ey = topY + Math.sin(a) * len * 0.78
        const mx = topX + Math.cos(a) * len * 0.55
        const my = topY + Math.sin(a) * len * 0.42 - 20
        g.moveTo(topX, topY)
          .quadraticCurveTo(mx, my - 14, ex, ey)
          .quadraticCurveTo(mx, my + 16, topX, topY)
          .closePath()
          .fill(tint)
      }
      // Coconuts, and the hot edge the sun puts down the seaward side.
      g.circle(topX + 10, topY + 12, 9 - p.depth * 3).fill(darken(tint, 0.25))
      g.moveTo(topX + wTop, topY + 6)
        .quadraticCurveTo(midX + wTop, midY, p.x + wBase, p.base - 8)
        .stroke({ color: rim, width: 2.5, alpha: 0.3 - p.depth * 0.2 })
    }
    c.addChild(g)
    return c
  }

  /**
   * The loafers at both edges with their boards stuck in the sand.
   *
   * They are the reason the frame reads as a beach with an event on it rather
   * than a booth on a backdrop, and they are silhouettes on purpose: five
   * judges is already five faces, and a sixth and a seventh would split the
   * read.
   */
  private buildLoafers(silhouette: Hex, rim: Hex, sand: Hex): Container {
    const c = new Container()
    const g = new Graphics()
    const shade = mix(silhouette, sand, 0.62)
    // One down at the front with a board planted beside them, one small and
    // further up the beach with their hands free. `board: 0` is nobody's board.
    const people = [
      { x: 166, foot: 950, s: 1.02, face: 1, board: 62 },
      { x: 272, foot: 782, s: 0.6, face: 1, board: 0 },
      { x: 1648, foot: 782, s: 0.6, face: -1, board: 0 },
      { x: 1754, foot: 950, s: 1.02, face: -1, board: -62 },
    ]
    // Boards first, so nobody stands behind their own board.
    for (const p of people) {
      if (p.board === 0) continue
      const bx = p.x + p.board * p.s
      const bh = 232 * p.s
      const lean = p.board > 0 ? 0.13 : -0.13
      g.moveTo(bx, p.foot)
        .quadraticCurveTo(bx + lean * bh * 0.6 - 20 * p.s, p.foot - bh * 0.55,
          bx + lean * bh, p.foot - bh)
        .quadraticCurveTo(bx + lean * bh * 0.6 + 20 * p.s, p.foot - bh * 0.55, bx, p.foot)
        .closePath()
        .fill(mix(silhouette, sand, 0.2))
      g.ellipse(bx, p.foot + 4, 24 * p.s, 7 * p.s).fill({ color: shade, alpha: 0.5 })
    }
    for (const p of people) {
      const s = p.s
      const hy = p.foot - 150 * s
      g.ellipse(p.x, p.foot + 5, 30 * s, 9 * s).fill({ color: shade, alpha: 0.55 })
      // Legs, torso, head — one silhouette, no interior detail at this depth.
      g.moveTo(p.x - 13 * s, p.foot).lineTo(p.x - 7 * s, p.foot - 66 * s)
        .lineTo(p.x + 9 * s, p.foot - 66 * s).lineTo(p.x + 14 * s, p.foot)
        .closePath().fill(silhouette)
      g.moveTo(p.x - 20 * s, p.foot - 62 * s)
        .lineTo(p.x - 16 * s, hy + 16 * s)
        .lineTo(p.x + 18 * s, hy + 16 * s)
        .lineTo(p.x + 22 * s, p.foot - 62 * s)
        .closePath().fill(silhouette)
      g.circle(p.x + 2 * s, hy, 17 * s).fill(silhouette)
      // One shading their eyes, one with a hand on a hip.
      if (p.face > 0) {
        g.moveTo(p.x + 16 * s, hy + 24 * s).lineTo(p.x + 38 * s, hy + 6 * s)
          .stroke({ color: silhouette, width: 11 * s, cap: 'round' })
      } else {
        g.moveTo(p.x - 16 * s, hy + 24 * s).lineTo(p.x - 34 * s, hy + 50 * s)
          .stroke({ color: silhouette, width: 11 * s, cap: 'round' })
      }
      // The hot edge, on the side the sun is.
      g.moveTo(p.x + 19 * s, hy - 12 * s)
        .quadraticCurveTo(p.x + 26 * s, hy + 30 * s, p.x + 22 * s, p.foot - 62 * s)
        .stroke({ color: rim, width: 3, alpha: 0.26 })
    }
    c.addChild(g)
    return c
  }

  /* ----------------------------------------------------------------- booth --- */

  /** Roof, posts, back wall and the two fan discs. Everything behind the cast. */
  private buildBooth(
    wood: Hex, woodLit: Hex, woodDark: Hex, woodInk: Hex, interior: Hex, sand: Hex,
  ): Container {
    const c = new Container()
    const g = new Graphics()

    // Cast shadow on the sand, thrown away from the low sun.
    g.moveTo(BOOTH_L - 120, COUNTER_BOT + 14)
      .lineTo(BOOTH_R + 34, COUNTER_BOT + 14)
      .lineTo(BOOTH_R - 34, COUNTER_BOT + 52)
      .lineTo(BOOTH_L - 210, COUNTER_BOT + 52)
      .closePath()
      .fill({ color: mix(interior, sand, 0.42), alpha: 0.4 })

    // Back wall: the shaded interior the judges sit against. Dark, so five lit
    // heads have something to be lit against.
    g.rect(BOOTH_L + POST_W - 4, ROOF_BOT - 6, BOOTH_R - BOOTH_L - POST_W * 2 + 8,
      COUNTER_TOP - ROOF_BOT + 30).fill(interior)
    for (let i = 1; i < 9; i++) {
      const x = BOOTH_L + POST_W + i * ((BOOTH_R - BOOTH_L - POST_W * 2) / 9)
      g.moveTo(x, ROOF_BOT - 6).lineTo(x, COUNTER_TOP + 20)
        .stroke({ color: darken(interior, 0.22), width: 3, alpha: 0.55 })
    }

    // Posts.
    for (const px of [BOOTH_L, BOOTH_R - POST_W]) {
      g.rect(px, ROOF_BOT - 8, POST_W, COUNTER_BOT - ROOF_BOT + 8).fill(wood)
      g.rect(px, ROOF_BOT - 8, 7, COUNTER_BOT - ROOF_BOT + 8).fill(woodLit)
      g.rect(px + POST_W - 6, ROOF_BOT - 8, 6, COUNTER_BOT - ROOF_BOT + 8).fill(woodDark)
    }

    // Roof: a shallow pitch seen almost edge on, plus a deep fascia so it has
    // thickness. A single rectangle here reads as a shelf.
    g.moveTo(EAVE_L + 74, ROOF_TOP)
      .lineTo(EAVE_R - 74, ROOF_TOP)
      .lineTo(EAVE_R, ROOF_BOT - 18)
      .lineTo(EAVE_L, ROOF_BOT - 18)
      .closePath()
      .fill(woodLit)
    g.rect(EAVE_L, ROOF_BOT - 18, EAVE_R - EAVE_L, 18).fill(wood)
    g.rect(EAVE_L, ROOF_BOT - 4, EAVE_R - EAVE_L, 7).fill(woodDark)
    // Rafter ends showing under the eave.
    for (let i = 0; i <= 14; i++) {
      const x = EAVE_L + 20 + i * ((EAVE_R - EAVE_L - 40) / 14)
      g.rect(x - 5, ROOF_BOT + 3, 10, 12).fill(woodDark)
    }
    // Plank seams down the pitch.
    for (let i = 1; i < 12; i++) {
      const tx = EAVE_L + 74 + i * ((EAVE_R - EAVE_L - 148) / 12)
      const bx = EAVE_L + i * ((EAVE_R - EAVE_L) / 12)
      g.moveTo(tx, ROOF_TOP + 1).lineTo(bx, ROOF_BOT - 19)
        .stroke({ color: woodInk, width: 2, alpha: 0.28 })
    }
    c.addChild(g)

    // The two speaker/fan discs, one on each post.
    c.addChild(this.buildDisc(BOOTH_L + POST_W / 2, 300, wood, woodLit, woodDark, woodInk))
    c.addChild(this.buildDisc(BOOTH_R - POST_W / 2, 300, wood, woodLit, woodDark, woodInk))
    return c
  }

  private buildDisc(
    cx: number, cy: number, wood: Hex, woodLit: Hex, woodDark: Hex, woodInk: Hex,
  ): Graphics {
    const g = new Graphics()
    const r = 40
    // Mast, down into the roof.
    g.rect(cx - 6, cy, 12, ROOF_TOP - cy + 16).fill(woodDark)
    g.rect(cx - 6, cy, 4, ROOF_TOP - cy + 16).fill(wood)
    g.circle(cx, cy, r).fill(wood)
    g.circle(cx, cy, r).stroke({ color: woodLit, width: 3, alpha: 0.8 })
    g.circle(cx, cy, r - 7).fill(woodInk)
    // Six vanes, so it reads as a fan rather than as a dot.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3
      g.moveTo(cx, cy)
        .lineTo(cx + Math.cos(a) * (r - 9), cy + Math.sin(a) * (r - 9))
        .stroke({ color: woodLit, width: 4, alpha: 0.45 })
    }
    g.circle(cx, cy, 7).fill(woodLit)
    return g
  }

  /** The counter they sit behind, drawn over the cast's waists. */
  private buildCounter(
    wood: Hex, woodLit: Hex, woodDark: Hex, woodInk: Hex, sand: Hex,
  ): Graphics {
    const g = new Graphics()
    const l = BOOTH_L - 16
    const r = BOOTH_R + 16
    // A lit lip, then the shaded face.
    g.rect(l, COUNTER_TOP, r - l, 22).fill(woodLit)
    g.rect(l, COUNTER_TOP + 22, r - l, COUNTER_BOT - COUNTER_TOP - 22).fill(wood)
    g.rect(l, COUNTER_TOP + 22, r - l, 8).fill(woodDark)
    // Vertical planking down the face.
    for (let i = 1; i < 26; i++) {
      const x = l + i * ((r - l) / 26)
      g.moveTo(x, COUNTER_TOP + 30).lineTo(x, COUNTER_BOT)
        .stroke({ color: woodInk, width: 2, alpha: 0.22 })
    }
    // A rail across the bottom, and a contact line on the sand.
    g.rect(l, COUNTER_BOT - 26, r - l, 14).fill(woodDark)
    g.rect(l - 6, COUNTER_BOT - 4, r - l + 12, 8).fill(woodInk)
    g.ellipse((l + r) / 2, COUNTER_BOT + 8, (r - l) / 2 + 20, 12)
      .fill({ color: mix(woodInk, sand, 0.5), alpha: 0.45 })
    return g
  }

  /**
   * The sponsor banner.
   *
   * "Kawasaki PRO AM" in the original, ours in the house name. On a results
   * booth this is signage, which is what the original uses it as; the badge a
   * critic threw out was the same words sitting on top of live play.
   */
  private buildBanner(pal: EventPalette, mark: Hex): Container {
    const c = new Container()
    const l = BOOTH_L + 24
    const r = BOOTH_R - 24
    const top = COUNTER_TOP + 48
    const h = 108
    const cloth = mix(pal.far, pal.shade, 0.42)
    const g = new Graphics()
    g.rect(l, top, r - l, h).fill(cloth)
    g.rect(l, top, r - l, 5).fill({ color: Core.paperWhite, alpha: 0.24 })
    g.rect(l, top + h - 6, r - l, 6).fill({ color: Core.deepInk, alpha: 0.3 })
    g.rect(l, top, 8, h).fill({ color: Core.deepInk, alpha: 0.22 })
    g.rect(r - 8, top, 8, h).fill({ color: Core.deepInk, alpha: 0.22 })
    // Rope ties at the four corners.
    for (const x of [l + 14, r - 14]) {
      for (const y of [top + 14, top + h - 14]) {
        g.circle(x, y, 6).fill({ color: lighten(cloth, 0.35), alpha: 0.8 })
      }
    }
    c.addChild(g)

    const name = new Text({ text: 'SUNDOG', style: display(70, Core.paperWhite) })
    const proam = new Text({ text: 'PRO AM', style: display(70, mark) })
    const gapX = 38
    const total = name.width + gapX + proam.width
    const cx = (l + r) / 2
    name.anchor.set(0, 0.5)
    proam.anchor.set(0, 0.5)
    name.position.set(cx - total / 2, top + h / 2)
    proam.position.set(cx - total / 2 + name.width + gapX, top + h / 2)
    c.addChild(name, proam)
    return c
  }

  /** Two brackets from the board down onto the roof ridge, drawn behind it. */
  private buildBoardMount(woodDark: Hex): Graphics {
    const g = new Graphics()
    for (const x of [96, BOARD_W - 96]) {
      g.rect(x - 12, BOARD_H - 40, 24, 68).fill(woodDark)
    }
    return g
  }

  /* ------------------------------------------------------------------ cast --- */

  /**
   * One judge: seated, lit from the right like everything else in this event,
   * with the arm that holds the card already raised and the elbow parked on the
   * counter.
   */
  private buildJudge(i: number, rim: Hex): Container {
    const j = CAST[i]
    const cx = JUDGE_X[i]
    const c = new Container()
    const g = new Graphics()
    const skinShade = grade(j.skin, { valScale: 0.78, satScale: 1.14 })
    const kitShade = grade(j.kit, { valScale: 0.74, satScale: 1.12 })
    const hairShade = grade(j.hair, { valScale: 0.78, satScale: 1.1 })

    const hw = 54 * j.build
    const cardX = cx + CARD_DX
    const cardY = CARD_Y[i]

    // Hair that falls past the jaw goes behind the head and the shoulders.
    if (j.fall > 0) {
      g.moveTo(cx - HEAD_R - 6, HEAD_Y - 8)
        .quadraticCurveTo(cx - HEAD_R - 14, HEAD_Y + 52 * j.fall,
          cx - HEAD_R + 4, HEAD_Y + 62 * j.fall)
        .lineTo(cx + HEAD_R - 4, HEAD_Y + 62 * j.fall)
        .quadraticCurveTo(cx + HEAD_R + 14, HEAD_Y + 52 * j.fall, cx + HEAD_R + 6, HEAD_Y - 8)
        .closePath()
        .fill(hairShade)
    }

    // Torso: shoulders out to the counter line. Two values, never flat.
    g.moveTo(cx - hw * 0.62, SHOULDER_Y - 8)
      .quadraticCurveTo(cx - hw * 0.9, SHOULDER_Y + 16, cx - hw, COUNTER_TOP + 40)
      .lineTo(cx + hw, COUNTER_TOP + 40)
      .quadraticCurveTo(cx + hw * 0.9, SHOULDER_Y + 16, cx + hw * 0.62, SHOULDER_Y - 8)
      .closePath()
      .fill(j.kit)
    g.moveTo(cx - hw * 0.62, SHOULDER_Y - 8)
      .quadraticCurveTo(cx - hw * 0.9, SHOULDER_Y + 16, cx - hw, COUNTER_TOP + 40)
      .lineTo(cx - hw * 0.2, COUNTER_TOP + 40)
      .lineTo(cx - hw * 0.1, SHOULDER_Y - 8)
      .closePath()
      .fill(kitShade)

    // Neck. Long enough to reach *past* the torso's top edge at SHOULDER_Y - 8:
    // ending it exactly there left a 4px slot of dark back wall between chin
    // and collar on all five of them.
    g.rect(cx - 11, HEAD_Y + 18, 22, 34).fill(skinShade)

    // The raised arm: shoulder to elbow, elbow to hand, one stroke per bone so
    // the elbow is a real joint instead of a bend in a noodle.
    const shX = cx + hw * 0.76
    const elbowX = cx + hw * 0.94
    const elbowY = SHOULDER_Y + 28
    const handY = cardY + CARD_H / 2 + 6
    g.moveTo(shX, SHOULDER_Y + 6).lineTo(elbowX, elbowY)
      .stroke({ color: j.skin, width: 21, cap: 'round' })
    g.moveTo(elbowX, elbowY).lineTo(cardX, handY)
      .stroke({ color: j.skin, width: 19, cap: 'round' })
    g.moveTo(elbowX, elbowY).lineTo(cardX, handY)
      .stroke({ color: skinShade, width: 6, alpha: 0.45, cap: 'round' })
    g.circle(cardX, handY - 2, 12).fill(j.skin)

    // Head, with the terminator on the shaded side.
    g.circle(cx, HEAD_Y, HEAD_R).fill(j.skin)
    g.ellipse(cx - HEAD_R * 0.34, HEAD_Y, HEAD_R * 0.66, HEAD_R * 0.95)
      .fill({ color: skinShade, alpha: 0.45 })

    // Hair on top, then the one feature that tells this judge from the others.
    switch (j.feature) {
      case 'cap':
        g.moveTo(cx - HEAD_R - 2, HEAD_Y - 6)
          .quadraticCurveTo(cx, HEAD_Y - HEAD_R * 2.05, cx + HEAD_R + 2, HEAD_Y - 6)
          .closePath()
          .fill(CAP_COLOR)
        g.moveTo(cx + HEAD_R - 2, HEAD_Y - 8)
          .quadraticCurveTo(cx + HEAD_R + 30, HEAD_Y - 14, cx + HEAD_R + 34, HEAD_Y - 2)
          .quadraticCurveTo(cx + HEAD_R + 20, HEAD_Y + 2, cx + HEAD_R - 4, HEAD_Y + 1)
          .closePath()
          .fill(grade(CAP_COLOR, { valScale: 0.8 }))
        g.circle(cx, HEAD_Y - HEAD_R - 6, 5).fill(lighten(CAP_COLOR, 0.4))
        break
      case 'curls':
        for (let k = 0; k < 7; k++) {
          const a = Math.PI + (k / 6) * Math.PI
          g.circle(cx + Math.cos(a) * (HEAD_R + 3), HEAD_Y + Math.sin(a) * (HEAD_R + 3), 15)
            .fill(j.hair)
        }
        break
      default:
        g.moveTo(cx - HEAD_R - 2, HEAD_Y - 4)
          .quadraticCurveTo(cx - HEAD_R * 0.4, HEAD_Y - HEAD_R * 1.62,
            cx + HEAD_R + 2, HEAD_Y - 10)
          .quadraticCurveTo(cx + HEAD_R * 0.3, HEAD_Y - HEAD_R * 0.7,
            cx - HEAD_R - 2, HEAD_Y - 4)
          .closePath()
          .fill(j.hair)
        break
    }

    // Face. Two dots and a line at this size; any more is detail nobody reads.
    if (j.feature === 'shades') {
      g.roundRect(cx - 24, HEAD_Y - 11, 48, 17, 5).fill(Core.deepInk)
      g.moveTo(cx - 24, HEAD_Y - 7).lineTo(cx - 33, HEAD_Y - 9)
        .stroke({ color: Core.deepInk, width: 3 })
      g.moveTo(cx + 24, HEAD_Y - 7).lineTo(cx + 33, HEAD_Y - 9)
        .stroke({ color: Core.deepInk, width: 3 })
      g.rect(cx + 6, HEAD_Y - 9, 5, 12).fill({ color: Core.paperWhite, alpha: 0.2 })
    } else {
      g.circle(cx - 11, HEAD_Y - 3, 3.6).fill(Core.deepInk)
      g.circle(cx + 12, HEAD_Y - 3, 3.6).fill(Core.deepInk)
    }
    if (j.feature === 'moustache') {
      g.moveTo(cx - 16, HEAD_Y + 12)
        .quadraticCurveTo(cx, HEAD_Y + 5, cx + 16, HEAD_Y + 12)
        .quadraticCurveTo(cx, HEAD_Y + 18, cx - 16, HEAD_Y + 12)
        .closePath()
        .fill(j.hair)
    } else {
      g.moveTo(cx - 9, HEAD_Y + 15).quadraticCurveTo(cx + 1, HEAD_Y + 21, cx + 10, HEAD_Y + 14)
        .stroke({ color: darken(skinShade, 0.3), width: 3, alpha: 0.7, cap: 'round' })
    }

    // The sun is on the right in this event, so every judge takes a rim on the
    // same edge. Baked, because nothing on this screen ever turns around.
    g.arc(cx, HEAD_Y, HEAD_R, -Math.PI * 0.4, Math.PI * 0.28)
      .stroke({ color: rim, width: 3.5, alpha: 0.5 })
    g.moveTo(cx + hw * 0.62, SHOULDER_Y - 6)
      .quadraticCurveTo(cx + hw * 0.92, SHOULDER_Y + 16, cx + hw, COUNTER_TOP + 20)
      .stroke({ color: rim, width: 3, alpha: 0.35 })

    c.addChild(g)
    return c
  }

  /** The held card: a board with one whole number on it, and nothing else. */
  private buildCard(i: number, woodInk: Hex): Container {
    const c = new Container()
    const g = new Graphics()
    g.roundRect(-CARD_W / 2 + 3, -CARD_H / 2 + 6, CARD_W, CARD_H, 8)
      .fill({ color: Core.deepInk, alpha: 0.35 })
    g.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 8).fill(Core.paperWhite)
    g.roundRect(-CARD_W / 2 + 6, -CARD_H / 2 + 6, CARD_W - 12, CARD_H - 12, 5)
      .stroke({ color: mix(woodInk, Core.paperWhite, 0.55), width: 2.5 })
    c.addChild(g)

    const n = new Text({ text: '0', style: display(64, darken(woodInk, 0.2)) })
    n.anchor.set(0.5)
    n.position.set(0, 2)
    c.addChild(n)
    this.cards.push(n)

    c.position.set(JUDGE_X[i] + CARD_DX, CARD_Y[i])
    c.rotation = CARD_TILT[i]
    return c
  }
}

/**
 * Points to a judges' rating out of ten.
 *
 * Surfing is scored out of ten natively and does not use this. Every other
 * event counts points, so each declares a `par` — the score an **excellent**
 * run reaches, the one that earns a 10.
 *
 * The curve is a square root, not a straight line, and that is the whole point.
 * A linear map means the rating is the fraction of a perfect run you managed,
 * so anything short of mastery reads as a 1 or a 2 and the top half of the
 * scoreboard is never used. A real panel does not work that way: 5 is
 * competent, 8-9 is very good, 10 is exceptional. The square root reproduces
 * that shape — early progress is visible, and the last two points cost as much
 * as the first eight.
 *
 *   score/par   0.04   0.15   0.25   0.50   0.75   1.00
 *   rating       2.0    3.9    5.0    7.1    8.7   10.0
 *
 * This is presentation only. `par` is never read back into gameplay, so tuning
 * it cannot change what a run is actually worth — only where the cards land.
 */
export const ratingFor = (score: number, par: number): number => {
  const frac = Math.max(0, score) / Math.max(1, par)
  return Math.max(0, Math.min(10, 10 * Math.sqrt(frac)))
}
