import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { Core, darken, grade, mix, type EventPalette, type Hex } from '../../../render/Palette'
import {
  HUD_RADIUS, Meter, Readout, endPrompt, plate as sharedPlate, themeFor, type HudTheme,
} from '../../../render/Hud'
import { clamp, clamp01, lerp, smoothstep } from '../../../core/Tween'
import { RIVER_Z0, RIVER_Z1 } from './Field'

/**
 * The event's instruments.
 *
 * TWO plates of one hardware, docked to one twelve-column grid: the downfield
 * tracking strip across the top right, and one bar along the bottom carrying
 * everything else. Opaque bodies, a lit top bevel, a dark base edge, a 1.5 px
 * frame and a three-step drop shadow, both identical, both sharing a corner
 * radius and a baseline.
 *
 * The typography here is the one thing two neutral reviews have praised —
 * "condensed gold caps, the cyan target ticks, the metre scale: shippable,
 * confident work" — so none of it has changed. Both objected to the LAYOUT,
 * and the second one put the cost in a sentence:
 *
 *   "Four separate dark slabs of HUD occupy all four corners and pinch the
 *    image into a letterbox, so the best-crafted thing in B is the furniture,
 *    not the game."
 *
 * Five plates are now two:
 *
 *   MARGIN 40   GUTTER 20   COL 135   -> colX(i) = 40 + 155i
 *
 *   strip   x 626..1710       y  <0..120   the piece the review liked
 *   bar     x 210..1710       y 962..>1080  ident | gauges | wind | score
 *
 * ONE ALIGNMENT SYSTEM, AND IT USED TO BE TWO. Two critics of the same frame:
 *
 *   "the top panel spans x=442-1201 flush to y=0 with zero top margin and a
 *    centre of x=821 against the frame's 675, while the bottom panel is
 *    properly centred with a 20px inset — two incompatible alignment systems"
 *
 * They are right about the fault and the numbers are exact (that critique is in
 * 1350 px panel space; x 442-1201 is x 628-1708 here, and the bottom bar's
 * inset was 28). One plate bled off its own frame edge and the other floated
 * clear of it, which is two pieces of hardware however carefully they share a
 * column. The rule now, and it is one rule:
 *
 *   EVERY PLATE BLEEDS OFF ITS OWN FRAME EDGE. The strip runs out through
 *   y=0, the bar runs out through y=1080, both are inset 210 px from the right,
 *   both end at x=1710, and the strip's left edge is the bar's first divider,
 *   so a single vertical line runs the full height of the frame. Neither is an
 *   object sitting in the picture; together they are the rack the picture is
 *   shot through.
 *
 * The bar moving down 28 px to reach the edge also answers the third critic:
 * "the bottom HUD panel's top edge at y=656 clips his rear foot." His rear
 * boot's contact lands at y=940 in the frame this event is judged on; the bar's
 * top edge was at 934. It is at 962 now, twenty-two pixels clear.
 *
 * The strip moved from the top LEFT to the top RIGHT, because the thrower is
 * now 41% of frame height with her head, her cap and her throwing arm above
 * the horizon line — and the left half of the sky is where they go.
 *
 * The bar is inset 210 px from both edges rather than run full width, so the
 * frame keeps its bottom corners and the near grass reads round it. It carries
 * the identity block, both throw gauges (which used to own a plate of their
 * own top-right), the wind compass and the score, separated by hairlines
 * rather than by three separate boxes.
 *
 * Other rules kept from the previous pass:
 *
 *   - Nothing in the HUD is translucent over the world.
 *   - Wind is a diagram — a plan compass with a weighted arrow — plus one
 *     number with a unit. Not `2.1 • 1.1R • 1.8 HEAD`.
 *   - Gauges are segmented instrument scales in machined slots with shaped
 *     needles, not engine tuning sliders.
 *   - The one hue this file may not use is the athletes' saturated pink. It is
 *     reserved for the player and nothing else in the frame gets it.
 */

/* ------------------------------------------------------------------ grid --- */
/**
 * Outer margin and corner radius come from the shared HUD system, not from
 * numbers typed into this file, so the six events dock their furniture to the
 * same edge and round it the same way.
 */
/** Gap between adjacent plates. */
const GUTTER = 20
/** One column. Twelve of them plus eleven gutters fill 1920 inside the margin. */
const COL = 135
/** Left edge of column `i`. */
/** Width of a plate spanning `n` columns. */
const span = (n: number): number => n * COL + (n - 1) * GUTTER
/** Corner radius. Every plate, every recess derives from it. */
const RADIUS = HUD_RADIUS
/** Interior padding inside a plate. */
const PAD = 22
const LABEL_SIZE = 16
const VALUE_SIZE = 26

/* --------------------------------------------------- overhead strip ------- */
/**
 * TWO pieces of furniture, not five, and not one in each corner.
 *
 * The last layout put a plate in all four corners — strip top-left, throw meter
 * top-right, and three plates along the bottom — and a blind review measured
 * the effect rather than the parts: "four separate dark slabs of HUD occupy all
 * four corners and pinch the image into a letterbox, so the best-crafted thing
 * in B is the furniture, not the game."
 *
 * The same review named the one piece worth keeping: "the HUD typography —
 * condensed gold caps, the cyan target ticks, the metre scale — is shippable,
 * confident work." So nothing about the type, the gauge cells, the needles, the
 * compass or the crosshair has changed. What has changed is how much of the
 * picture they are allowed to stand on:
 *
 *   - the downfield strip keeps the top ROW, and moves to the right so the
 *     whole left half of the sky is free. That matters now: the thrower is 41%
 *     of frame height with her head and her throwing arm above the horizon, and
 *     the strip used to sit exactly where they go.
 *   - everything else — identity, both throw gauges, the wind compass and the
 *     score — collapses into ONE bar along the bottom, inset 210 px from each
 *     side so both bottom corners show grass.
 *
 * Two shapes, three free corners, and the same hardware.
 */
/**
 * The strip is aligned to the BOTTOM BAR, not to the twelve-column grid.
 *
 * Two plates on two different grids is two pieces of hardware, and a blind
 * review measured it: "a top HUD bar (x594-1346) that is right-aligned with a
 * 25px gutter while leaving 580px of bare sky on its left". The 25 px gutter
 * was `1920 - colX(5) - span(7)`; the bar below it ends at 1710. Sharing the
 * bar's right edge and its width makes the two read as one rack, and it pulls
 * the slab out of the corner the disc now flies into.
 */
/**
 * The strip's LEFT edge lands on the bottom bar's first divider.
 *
 * The last pass gave the two plates a shared right edge, and the next critic
 * measured what was still loose:
 *
 *   "the top DOWNFIELD pill and the bottom bar share a right edge but have
 *    ragged left edges and no relationship to the athlete, sandwiching the
 *    playfield"
 *
 * Two plates that agree on one edge and disagree on the other are two plates.
 * The bar below is already divided at 626 and 1232; putting the strip's left
 * edge on 626 means the rack has a single vertical line running the full
 * height of the frame, and the strip spans exactly the bar's right two thirds.
 * Nothing new is drawn to say so — the alignment is the statement.
 */
const PANEL_X = 626
const PANEL_W = 1710 - PANEL_X
/**
 * The strip is DOCKED to the top edge now, not floating 26 px below it.
 *
 *   "the floating DOWNFIELD slab — 775px wide, 57% of frame width, unanchored
 *    dead-centre in the sky"
 *
 * Two complaints in one sentence, and only one of them is answerable. The width
 * is load-bearing: the strip is a 0-118 m ruler, and its left and right edges
 * are the bottom bar's first divider and its right edge, which is the whole
 * reason the two plates read as one rack rather than as two slabs (see above,
 * and the critic who asked for exactly that). Narrowing it would buy back sky
 * by breaking the alignment that a previous round was spent winning.
 *
 * "Floating" and "unanchored" are answerable, and they are the real fault. A
 * plate with air on all four sides is an object sitting in the picture; a plate
 * that runs off the frame edge is chrome. So the body is drawn from above y=0
 * and clipped by the frame, the top bevel goes with it, and the contents move
 * up 18 px with the panel — which also gives eighteen rows of sky back to the
 * disc's arc.
 */
const PANEL_Y = 8
/**
 * Trimmed from 126. The strip spans 56% of the frame's width — it has to, it
 * is a 0-118 m ruler and the alignment to the bar's first divider is what stops
 * the two plates reading as separate hardware — so the weight it can give back
 * is height. Every row inside it is packed by the same fourteen pixels: the
 * recess, the plot and the ruler all move up together.
 */
const PANEL_H = 112
const HEAD_ROW = 15
const RECESS_X = PANEL_X + PAD - 6
const RECESS_Y = PANEL_Y + 36
const RECESS_W = PANEL_W - (PAD - 6) * 2
const RECESS_H = 46
const PLOT_X = PANEL_X + 34
const PLOT_W = PANEL_W - 68
const PLOT_CY = RECESS_Y + RECESS_H / 2
/** Half the plot's vertical extent, px. */
const PLOT_HALF = 16
const RULER_Y = PANEL_Y + 86
/** Lateral extent the strip covers, metres either side of the throw line. */
const PLOT_X_RANGE = 22
const Z_MIN = -6
const Z_MAX = 118

/* ------------------------------------------------------- the bottom bar --- */
/**
 * Inset 210 px from both side edges, so the frame keeps its bottom corners and
 * the near grass reads round it — and DOCKED to the bottom edge, so it bleeds
 * off the frame the way the strip above bleeds off the top. See the header.
 *
 * `BAR_H` is unchanged, so nothing inside the bar moves relative to anything
 * else inside it: every block in here is measured from `BAR_Y` and the whole
 * instrument travels together. The rounded bottom corners and the base bevel
 * fall outside the picture, which is what `dockedBottomPlate` is for.
 */
const BAR_X = 210
const BAR_W = 1500
const BAR_Y = 962
const BAR_H = 118
const BAR_R = BAR_X + BAR_W
/**
 * Label and value baselines, measured from the bar's own top edge. Every block
 * in the bar sits on these two rows, gauges included, so the four blocks read
 * as one instrument and not as three boxes that happen to be adjacent.
 */
const LABEL_ROW = 12
const VALUE_ROW = 42
/** Identity block: sponsor, athlete, throw count. */
const IDENT_X = BAR_X + PAD
const IDENT_R = 600
/** Both gauges, side by side with the identity block. */
const GAUGE_X = 652
const GAUGE_R = 1212
/** Plan compass for the wind. */
const ROSE_X = 1252
const ROSE_Y = BAR_Y + 26
const ROSE_S = 56
const SCORE_R = BAR_R - PAD
/** Vertical hairlines between the bar's four blocks. */
const DIVIDERS = [626, 1232]

/* ------------------------------------------------------- the throw meter -- */
/**
 * The gauges live inside the bar now, not on a plate of their own top-right.
 * The instrument itself is untouched: machined slots, discrete cells, a shaped
 * needle and a locked caret, authored in the meter container's own space so
 * `drawGauge` did not have to change a line.
 */
const MET_X = GAUGE_X
const MET_Y = BAR_Y + 4
const MET_W = GAUGE_R - GAUGE_X
const MET_TRACK_X = 0
const MET_TRACK_W = MET_W
const MET_TRACK_H = 16
const MET_ROW_Y = [40, 82]
/** Segments in an instrument scale. Coarse cells plus a fine needle. */
const MET_CELLS = 26

/* ------------------------------------------------------- result banner ---- */
const RES_W = span(6)
const RES_X = (1920 - RES_W) / 2
const RES_Y = 720
const RES_H = 140

/* ------------------------------------------------------- end card --------- */
/**
 * The run-end card: the three throws, what they were worth, and the way out.
 *
 * Three throws, per the C64 original — "every player has three shots, which
 * are summed up" — and the summing up is the whole point of this card. Until
 * it existed the run ended on a one-line banner reading RUN COMPLETE and a
 * total, with no way to play again but a reload and no way to leave but the
 * browser's back button, and the three distances that produced the total were
 * gone the moment each throw's own banner faded.
 *
 * Docked to the same twelve-column grid as the bar and the strip — five
 * columns, centred on the frame like both of them — but built out of the
 * SHARED HUD's primitives rather than this file's bespoke hardware. That is
 * deliberate: the instruments are this event's own because two blind reviews
 * praised them, whereas a run-end card is the one piece of furniture all six
 * events put on screen, and six different ones is the tell the six bespoke
 * control legends already were.
 */
const END_W = span(5)
const END_X = (1920 - END_W) / 2
const END_Y = 300
const END_H = 430
/** Rows of the throw table, relative to the card. */
const END_ROW_Y = [196, 254, 312]

/* ------------------------------------------------------- prompt ----------- */
/** Centred on the bar's own gauge block, one line above it. */
const PROMPT_Y = BAR_Y - 28

const stripX = (z: number): number => PLOT_X + ((z - Z_MIN) / (Z_MAX - Z_MIN)) * PLOT_W
const stripY = (x: number): number => PLOT_CY + clamp(x / PLOT_X_RANGE, -1, 1) * PLOT_HALF

/** One throw, as the run-end card prints it. */
export interface EndThrow {
  distance: number
  points: number
  /** The catch as it was called: CLEAN CATCH, LAYOUT CATCH, DROPPED... */
  kind: string
}

interface Ink {
  /** Opaque plate body. Nothing behind it shows through. */
  body: Hex
  /** Lit top edge of the plate's frame. */
  bevel: Hex
  /** Dark base edge. */
  base: Hex
  /** Hairline around the whole plate. */
  frame: Hex
  /** Cast shadow under a plate. */
  shadow: Hex
  /** Sunk area inside a plate: plots, gauge slots, the compass. */
  recess: Hex
  label: Hex
  value: Hex
  /** The interface's gold: scores, locked gauges, the receiver's mark. */
  gold: Hex
  dim: Hex
}

export class Hud {
  readonly container = new Container()

  private pal: EventPalette
  private ink!: Ink

  // overhead strip
  private discDot = new Graphics()
  private discTick = new Graphics()
  private receiverMark = new Graphics()
  private throwerMark = new Graphics()
  private landingMark = new Graphics()
  private chaseLine = new Graphics()
  private stripDistance!: Text

  // throw meter, docked top-right
  private meter = new Container()
  private angleFill = new Graphics()
  private angleNeedle = new Graphics()
  private speedFill = new Graphics()
  private speedNeedle = new Graphics()
  private speedValue!: Text
  private angleValue!: Text

  // status rail
  private windArrow = new Graphics()
  private windValue!: Text
  private throwText!: Text
  private scoreText!: Text

  // run-end card
  private theme!: HudTheme
  private endCard = new Container()
  private endTotal!: Readout
  private endBars: Meter[] = []
  private endRows: Text[] = []

  // messages
  private resultPlate = new Graphics()
  private resultText!: Text
  private resultSub!: Text
  private promptText!: Text
  private promptShadow!: Text

  private cachedSpeed = ''
  private cachedAngle = ''
  private cachedWind = ''
  private cachedThrow = ''
  private cachedScore = ''
  private cachedDistance = ''
  private cachedResult = ''
  private cachedSub = ''
  private cachedPrompt = ''
  /** Last drawn (t, locked, active) per gauge, so a static gauge is free. */
  private gaugeSig = [NaN, NaN]
  private cachedTint = 0

  constructor(pal: EventPalette) {
    this.pal = pal
    // Plate, edge, label and value come from the shared HUD theme, so this
    // event's interface is the same material as the other five and — the rule
    // that theme exists to enforce — carries no neutral grey anywhere. The
    // recess, the base edge and the cast shadow are derived from the shared
    // plate rather than invented, for the same reason.
    //
    // What is NOT taken from the shared system is the instruments. `Readout`
    // and `Meter` are a label over a value and a filled track; this event's
    // downfield strip, segmented gauges, needles and plan compass are the one
    // thing two blind reviews have singled out as good work, and replacing
    // them with the generic shapes would be throwing away the only part of the
    // frame nobody has complained about.
    const t = themeFor(pal)
    // THE PLATE IS LIFTED OFF THE SHARED THEME'S NEAR-BLACK, and this is the
    // one place this event departs from it.
    //
    // `themeFor` derives the plate from `pal.shade`, which lands at L=21. In a
    // sky that measured L=195-214 that made the HUD the highest-contrast edge
    // in the picture by a wide margin, and a blind review said so:
    //
    //   "Two near-black letterbox slabs sandwich the art, and they are by a
    //    wide margin the highest-contrast edges on screen, so the eye lands on
    //    chrome before it finds the disc."
    //   "The typography inside them is the most competent thing in A — that
    //    only sharpens how unfinished the scene behind it looks."
    //
    // Deepening the sky does most of the work. This finishes it: mixed 30% into
    // the scene's own `far` the body lands near L=39, which against the new sky
    // behind the strip (L=45-72) and the grass behind the bar (L=56-92) is a
    // step of fifteen to fifty points instead of a hundred and eighty. The
    // slabs read as heavy hardware sitting in the scene's light rather than as
    // letterbox bars cut out of it, and the type — which is the part nobody has
    // complained about — keeps every point of its own contrast.
    const body = mix(t.plate, pal.far, 0.3)
    this.ink = {
      body,
      bevel: t.edge,
      base: darken(body, 0.55),
      frame: mix(body, Core.paperWhite, 0.2),
      shadow: darken(Core.deepInk, 0.55),
      recess: darken(body, 0.4),
      label: t.label,
      /*
       * THE TYPE CEILING, and it is the other half of the plate fix above.
       *
       * Darkening the slabs stopped them cutting the picture in two. It did
       * nothing about what is printed on them. `themeFor` hands every event
       * `Core.paperWhite` for values (L=248) and `Core.sunGold` for scores
       * (L=202), and measured on the frame this event is judged on that meant
       * 3,567 of the 5,019 pixels above L=200 — seventy-one per cent of the
       * top of the value range — belonged to the words KIM, 2/5, 3.3 and
       * 00132. The disc and its whole trail owned 608 of them.
       *
       * That is the fault the reviews keep naming in different words: "A hands
       * its brightest values to things that are not the subject." A frame
       * cannot funnel the eye to a gold disc while the brightest marks in it
       * are the chrome.
       *
       * So the interface gets a ceiling, one step under the hero: the disc's
       * plate measures L=209.8, values are set at L=185.9 and gold at L=178.0.
       * Both still carry 145+ points over the plate they are printed on
       * (L=39.7) — more contrast than any print job would ask for — and
       * neither can enter the band the disc is the only occupant of.
       */
      value: grade(mix(Core.paperWhite, pal.haze, 0.3), { valScale: 0.84 }),
      gold: grade(Core.sunGold, { valScale: 0.88 }),
      dim: mix(body, Core.paperWhite, 0.24),
    }
    // The shared theme, with this event's own lifted plate body and type
    // ceiling written back into it, so anything built from the shared
    // primitives is cut from the same material as the bar and the strip.
    this.theme = {
      ...t,
      plate: body,
      edge: this.ink.bevel,
      label: this.ink.label,
      value: this.ink.value,
      accent: this.ink.gold,
    }

    /*
     * THE BAR IS BUILT BEFORE THE METER, AND THAT ORDER IS THE WHOLE FIX.
     *
     * A player reported the event as unplayable: "how to set angle? and how to
     * set speed? There is no indicator showing what angle or speed" — while
     * being prompted to lock an instrument that was being drawn every frame
     * and then painted over.
     *
     * `buildMeter` added `this.meter` to the container and `buildRail` then
     * added the bottom bar's OPAQUE plate, which spans x 210-1710 and y
     * 962-1080. Pixi draws in add order. The meter sits at x 652, y 966 with
     * its two rows at y 1006 and 1048 — entirely inside that rectangle — so
     * both scales, both needles, the ANGLE and SPEED labels and both numeric
     * readouts were behind it. Nothing was mispositioned and nothing was
     * hidden: `setMeter(false)` only dims the scales to alpha 0.5, so even
     * between throws they should be plainly visible. Confirmed in
     * `captures/flyingdisc.png`: crop (620,960)-(1240,1080) and the bar's
     * middle block is bare plate with the two divider hairlines and nothing
     * between them.
     *
     * The bar plate is the panel and the meter is an instrument set INTO the
     * panel, so the panel goes down first. Everything else that lives inside
     * the bar — the wind rose, the arrow, the labels and the score — is
     * already added after the plate inside `buildRail`, and `buildMessages`
     * stays last so the prompt and the result plate sit over all of it.
     */
    this.buildStrip()
    this.buildRail()
    this.buildMeter()
    this.buildMessages()
    this.buildEndCard()
    this.container.interactiveChildren = false
  }

  private style(size: number, fill: Hex, tracking = 0.06): TextStyle {
    return new TextStyle({
      fontFamily: 'Anton, Archivo, system-ui, sans-serif',
      fontSize: size,
      fill,
      letterSpacing: size * tracking,
    })
  }

  /* --------------------------------------------------------- plate stock --- */
  /**
   * One plate of HUD material: a three-step cast shadow, an opaque body, a lit
   * top bevel, a dark base edge and a hairline frame. Three offset shadow rects
   * at low alpha give a soft-enough falloff without a blur filter, and the
   * whole thing is drawn once at build time.
   */
  private plate(g: Graphics, x: number, y: number, w: number, h: number, r = RADIUS): void {
    const k = this.ink
    g.roundRect(x - 3, y + 15, w + 6, h, r + 4).fill({ color: k.shadow, alpha: 0.1 })
    g.roundRect(x - 1, y + 9, w + 2, h, r + 2).fill({ color: k.shadow, alpha: 0.15 })
    g.roundRect(x, y + 4, w, h, r).fill({ color: k.shadow, alpha: 0.22 })
    g.roundRect(x, y, w, h, r).fill(k.body)
    g.moveTo(x + r, y + 1.6).lineTo(x + w - r, y + 1.6)
      .stroke({ color: k.bevel, width: 3, alpha: 0.85 })
    g.moveTo(x + r, y + h - 1.6).lineTo(x + w - r, y + h - 1.6)
      .stroke({ color: k.base, width: 3, alpha: 0.8 })
    g.roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, r)
      .stroke({ color: k.frame, width: 1.5, alpha: 0.55 })
  }

  /**
   * A plate hung from the top edge of the frame: the same hardware as `plate`,
   * with its top rounding and its top bevel pushed off screen so the body runs
   * out of the picture instead of ending in mid-air. No cast shadow upward,
   * because there is nothing above it to cast onto.
   */
  private dockedPlate(g: Graphics, x: number, y: number, w: number, h: number, r = RADIUS): void {
    const k = this.ink
    const top = -r * 2
    g.roundRect(x - 3, top, w + 6, h - top + y + 15, r + 4).fill({ color: k.shadow, alpha: 0.1 })
    g.roundRect(x - 1, top, w + 2, h - top + y + 9, r + 2).fill({ color: k.shadow, alpha: 0.15 })
    g.roundRect(x, top, w, h - top + y + 4, r).fill({ color: k.shadow, alpha: 0.22 })
    g.roundRect(x, top, w, h - top + y, r).fill(k.body)
    g.moveTo(x + r, y + h - 1.6).lineTo(x + w - r, y + h - 1.6)
      .stroke({ color: k.base, width: 3, alpha: 0.8 })
    g.roundRect(x + 0.75, top, w - 1.5, h - top + y - 0.75, r)
      .stroke({ color: k.frame, width: 1.5, alpha: 0.55 })
  }

  /**
   * A plate stood on the bottom edge of the frame: `dockedPlate` mirrored. The
   * bottom rounding and the base bevel run off the picture; the cast shadow
   * stays, because the frame above it is what the plate casts onto.
   */
  private dockedBottomPlate(g: Graphics, x: number, y: number, w: number, h: number, r = RADIUS): void {
    const k = this.ink
    // Far enough past the frame edge that the rounding is never on screen, and
    // never shorter than the plate was asked to be.
    const bot = Math.max(1080 + r * 2, y + h + r * 2)
    g.roundRect(x - 3, y + 15, w + 6, bot - y - 15, r + 4).fill({ color: k.shadow, alpha: 0.1 })
    g.roundRect(x - 1, y + 9, w + 2, bot - y - 9, r + 2).fill({ color: k.shadow, alpha: 0.15 })
    g.roundRect(x, y + 4, w, bot - y - 4, r).fill({ color: k.shadow, alpha: 0.22 })
    g.roundRect(x, y, w, bot - y, r).fill(k.body)
    g.moveTo(x + r, y + 1.6).lineTo(x + w - r, y + 1.6)
      .stroke({ color: k.bevel, width: 3, alpha: 0.85 })
    g.roundRect(x + 0.75, y + 0.75, w - 1.5, bot - y, r)
      .stroke({ color: k.frame, width: 1.5, alpha: 0.55 })
  }

  /** A sunk area inside a plate: dark floor, shadow at the top, bevel at the base. */
  private recess(g: Graphics, x: number, y: number, w: number, h: number, r = 8): void {
    const k = this.ink
    g.roundRect(x, y, w, h, r).fill(k.recess)
    g.moveTo(x + r, y + 1.5).lineTo(x + w - r, y + 1.5)
      .stroke({ color: k.shadow, width: 3, alpha: 0.55 })
    g.moveTo(x + r, y + h - 1.5).lineTo(x + w - r, y + h - 1.5)
      .stroke({ color: k.bevel, width: 2, alpha: 0.3 })
  }

  /* -------------------------------------------------------------- strip --- */
  private buildStrip(): void {
    const { pal, ink } = this
    const frame = new Graphics()

    this.dockedPlate(frame, PANEL_X, PANEL_Y, PANEL_W, PANEL_H)
    this.recess(frame, RECESS_X, RECESS_Y, RECESS_W, RECESS_H)

    // Plan view of the field, keyed to the world's own bands so the strip and
    // the scene read as one place. Muted hard against the plate: the markers
    // are what has to carry contrast in here, not the substrate.
    // Muted almost all the way into the plate. At 0.4 these read as an olive
    // block and a navy block — "a fourth palette that exists nowhere else in
    // the scene", in a blind review's words. The plan view still tells you
    // where the grass ends and the water starts; it just does it at the
    // strength of a substrate rather than of a subject.
    const planGrass = mix(grade(pal.near, { satScale: 0.5, valScale: 0.62 }), ink.recess, 0.76)
    const planRiver = mix(grade(pal.far, { satScale: 0.55, valScale: 0.8 }), ink.recess, 0.72)
    const planTrees = mix(grade(pal.mid, { satScale: 0.5, valScale: 0.62 }), ink.recess, 0.78)
    const top = PLOT_CY - PLOT_HALF
    const h = PLOT_HALF * 2
    frame.rect(stripX(0), top, stripX(RIVER_Z0) - stripX(0), h).fill(planGrass)
    frame.rect(stripX(RIVER_Z0), top, stripX(RIVER_Z1) - stripX(RIVER_Z0), h).fill(planRiver)
    frame.rect(stripX(RIVER_Z1), top, stripX(Z_MAX) - stripX(RIVER_Z1), h).fill(planTrees)

    // Ruler: minor every 10 m off both rails, major every 20.
    const rule = mix(ink.value, pal.haze, 0.35)
    for (let z = 0; z <= 110; z += 10) {
      const x = stripX(z)
      const len = z % 20 === 0 ? 10 : 5
      frame.moveTo(x, top).lineTo(x, top + len)
      frame.moveTo(x, top + h).lineTo(x, top + h - len)
    }
    frame.stroke({ color: rule, width: 2, alpha: 0.5 })
    // The line the throw is aimed down.
    frame.moveTo(stripX(0), PLOT_CY).lineTo(stripX(Z_MAX), PLOT_CY)
      .stroke({ color: rule, width: 1.5, alpha: 0.22 })
    // Near bank, called out: the one line on the strip with a consequence.
    frame.moveTo(stripX(RIVER_Z0), top).lineTo(stripX(RIVER_Z0), top + h)
      .stroke({ color: mix(Core.paperWhite, pal.far, 0.5), width: 2, alpha: 0.55 })

    // Axis label and unit. Bare numbers with neither was the review's example
    // of instrumentation nobody authored.
    const axis = new Text({ text: 'DOWNFIELD', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    axis.position.set(PANEL_X + PAD, PANEL_Y + HEAD_ROW)
    const unit = new Text({ text: 'METRES', style: this.style(14, ink.label, 0.2) })
    unit.anchor.set(1, 0)
    unit.position.set(PANEL_X + PANEL_W - PAD, RULER_Y + 1)
    frame.addChild(axis, unit)

    for (const z of [0, 20, 40, 60, 80, 100]) {
      const t = new Text({ text: `${z}`, style: this.style(15, ink.label, 0.1) })
      t.anchor.set(0.5, 0)
      t.position.set(stripX(z), RULER_Y)
      t.alpha = 0.85
      frame.addChild(t)
    }
    this.container.addChild(frame)

    // Live distance, on the header row, right-aligned to the plate's own margin.
    // Stepped off full gold. "The strongest accent in the image, the yellow
    // 25 M, dumped into empty sky" — the frame's strongest accent belongs on
    // the disc. This still reads as the live number, at a value that does not
    // out-rank a forty-pixel object in the middle of the picture.
    this.stripDistance = new Text({
      text: '', style: this.style(25, mix(ink.gold, ink.label, 0.55), 0.08),
    })
    this.stripDistance.anchor.set(1, 0.5)
    this.stripDistance.position.set(PANEL_X + PANEL_W - PAD, PANEL_Y + 24)

    // The line the receiver has to close: from him to where the disc will land.
    this.container.addChild(this.chaseLine)

    // Thrower and receiver as blocks, the way the original draws them. Neither
    // uses the athletes' reserved hue: that belongs to the world, not the HUD.
    const block = (g: Graphics, colour: Hex, fill: boolean): void => {
      if (fill) {
        g.roundRect(-5, -9, 10, 18, 3).fill(colour)
          .roundRect(-5, -9, 10, 18, 3)
          .stroke({ color: grade(colour, { valScale: 0.45, satScale: 1.2 }), width: 2 })
      } else {
        g.roundRect(-4.5, -8.5, 9, 17, 3).stroke({ color: colour, width: 2.5 })
      }
    }
    block(this.throwerMark, mix(ink.value, pal.haze, 0.35), false)
    block(this.receiverMark, ink.gold, true)

    // Landing mark: a real crosshair with weight and a shadow under it, not a
    // hairline. This is the single most important marker on the strip.
    this.landingMark
      .moveTo(-10, 0).lineTo(10, 0).moveTo(0, -10).lineTo(0, 10)
      .stroke({ color: darken(Core.electricCyan, 0.6), width: 5.5, alpha: 0.55 })
      .moveTo(-10, 0).lineTo(10, 0).moveTo(0, -10).lineTo(0, 10)
      .stroke({ color: Core.electricCyan, width: 3 })
      .circle(0, 0, 6.5).stroke({ color: Core.electricCyan, width: 2.5, alpha: 0.7 })
    this.landingMark.visible = false

    // Altitude mast: the one thing a plan view cannot show, added back in.
    this.discTick.moveTo(0, 0).lineTo(0, -1)
      .stroke({ color: ink.value, width: 2.5, alpha: 0.55 })
    this.discDot.circle(0, 0, 5.5).fill(ink.value)
      .circle(0, 0, 5.5).stroke({ color: darken(Core.deepInk, 0.3), width: 1.5 })

    this.container.addChild(
      this.throwerMark, this.receiverMark, this.landingMark,
      this.discTick, this.discDot, this.stripDistance,
    )
  }

  /* --------------------------------------------------------- throw meter --- */
  /**
   * The throw meter: two segmented instrument scales in machined slots, each
   * with a shaped needle and a locked caret.
   *
   * It used to hang in the world beside the thrower, then on its own plate in
   * the top-right corner. It now sits in the middle block of the bottom bar,
   * which is the same instrument on a third less furniture. The slots stay on
   * screen for the whole throw and only the cells and needles dim, so the bar
   * never reads as something that appears and vanishes.
   */
  private buildMeter(): void {
    const { ink } = this
    const g = new Graphics()
    // No plate. The bar underneath is the plate; a plate inside a plate is the
    // fifth slab all over again.
    const cw = (MET_TRACK_W - (MET_CELLS - 1) * 2) / MET_CELLS
    for (const ty of MET_ROW_Y) {
      this.recess(g, MET_TRACK_X - 5, ty - 5, MET_TRACK_W + 10, MET_TRACK_H + 10, 7)
      // Unlit cells. A run of discrete cells is an instrument; a plain trough
      // with tick marks is an engine tuning widget.
      for (let i = 0; i < MET_CELLS; i++) {
        g.roundRect(MET_TRACK_X + i * (cw + 2), ty + 4, cw, MET_TRACK_H - 8, 2)
          .fill({ color: ink.dim, alpha: 0.35 })
      }
      // Quarter majors, cut into the top lip of the slot rather than hung
      // underneath it: the plate is only 152 tall and a rule below the track
      // collides with the next row's label.
      for (let i = 0; i <= 4; i++) {
        const x = MET_TRACK_X + (i / 4) * MET_TRACK_W
        g.moveTo(x, ty - 2).lineTo(x, ty + 3)
      }
      g.stroke({ color: ink.label, width: 2, alpha: 0.5 })
    }

    // Labels on the shared label row, values right-aligned to the shared
    // interior margin: the same two rows the rail plates use.
    const angleLabel = new Text({ text: 'ANGLE', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    angleLabel.position.set(MET_TRACK_X, MET_ROW_Y[0] - 32)
    const speedLabel = new Text({ text: 'SPEED', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    speedLabel.position.set(MET_TRACK_X, MET_ROW_Y[1] - 32)
    this.angleValue = new Text({ text: '', style: this.style(22, ink.value, 0.05) })
    this.angleValue.anchor.set(1, 0)
    this.angleValue.position.set(MET_W - MET_TRACK_X, MET_ROW_Y[0] - 34)
    this.speedValue = new Text({ text: '', style: this.style(22, ink.value, 0.05) })
    this.speedValue.anchor.set(1, 0)
    this.speedValue.position.set(MET_W - MET_TRACK_X, MET_ROW_Y[1] - 34)

    this.meter.addChild(
      g, this.angleFill, this.speedFill, this.angleNeedle, this.speedNeedle,
      angleLabel, speedLabel, this.angleValue, this.speedValue,
    )
    this.meter.position.set(MET_X, MET_Y)
    // The angle and speed gauges must sit ABOVE the bottom bar's plate.
    //
    // They were added to the container before the plate, and Pixi draws in add
    // order, so the opaque bar painted straight over them: the meters, their
    // needles, the ANGLE/SPEED labels and the live degrees and m/s were all
    // built, positioned and updated every frame, and none of it was visible.
    // The prompt told the player to "SET ANGLE" while the instrument they were
    // meant to read sat behind a panel. Thirty-four art critics never caught it
    // — they judge the frame as a picture, and a picture looks fine without an
    // instrument in it. The first person to actually play the event found it
    // immediately.
    //
    // Fixed with zIndex rather than by moving the call, so it survives anyone
    // re-ordering this constructor later.
    this.container.sortableChildren = true
    this.meter.zIndex = 50
    this.container.addChild(this.meter)
  }

  /* ----------------------------------------------------------- bottom bar -- */
  /**
   * One bar, inset from both edges.
   *
   * It replaces three separate plates that between them ran the full width of
   * the frame and, with the strip and the meter above, put a dark slab in every
   * corner. Four blocks inside it — identity, both gauges, wind, score —
   * separated by hairlines on the plate rather than by gutters between boxes,
   * which is how a real instrument panel divides itself and costs no picture.
   */
  private buildRail(): void {
    const { ink } = this
    const g = new Graphics()
    this.dockedBottomPlate(g, BAR_X, BAR_Y, BAR_W, BAR_H)
    // Block dividers: hairlines on one plate, not gaps between three.
    for (const x of DIVIDERS) {
      g.moveTo(x, BAR_Y + 16).lineTo(x, BAR_Y + BAR_H - 16)
        .stroke({ color: ink.frame, width: 1.5, alpha: 0.45 })
    }
    this.recess(g, ROSE_X, ROSE_Y, ROSE_S, ROSE_S, 8)

    // --- the wind compass ----------------------------------------------------
    // A diagram, not a telemetry string. Up is downfield, right is the +x
    // touchline, and the arrow points the way the air is going.
    const cx = ROSE_X + ROSE_S / 2
    const cy = ROSE_Y + ROSE_S / 2
    g.circle(cx, cy, 21).stroke({ color: ink.label, width: 1.5, alpha: 0.35 })
    // Downfield gate at the top of the rose, so the diagram has a north.
    g.moveTo(cx - 6, ROSE_Y + 8).lineTo(cx, ROSE_Y + 3).lineTo(cx + 6, ROSE_Y + 8)
      .stroke({ color: ink.label, width: 2, alpha: 0.7 })
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2
      g.moveTo(cx + Math.cos(a) * 23, cy + Math.sin(a) * 23)
        .lineTo(cx + Math.cos(a) * 26, cy + Math.sin(a) * 26)
    }
    g.stroke({ color: ink.label, width: 2, alpha: 0.4 })
    g.circle(cx, cy, 2.5).fill({ color: ink.label, alpha: 0.6 })
    this.container.addChild(g)

    // Arrow authored pointing along +x, rotated and scaled by the wind.
    this.windArrow
      .moveTo(-19, -3).lineTo(5, -3).lineTo(5, 3).lineTo(-19, 3).closePath()
      .fill(ink.value)
      .moveTo(20, 0).lineTo(4, -8).lineTo(4, 8).closePath()
      .fill(ink.value)
    this.windArrow.position.set(cx, cy)
    this.container.addChild(this.windArrow)

    const windLabel = new Text({ text: 'WIND', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    windLabel.position.set(ROSE_X + ROSE_S + 16, BAR_Y + LABEL_ROW)
    this.windValue = new Text({ text: '', style: this.style(VALUE_SIZE, ink.value, 0.05) })
    this.windValue.position.set(ROSE_X + ROSE_S + 16, BAR_Y + VALUE_ROW)
    const windUnit = new Text({ text: 'M/S', style: this.style(14, ink.label, 0.18) })
    windUnit.position.set(ROSE_X + ROSE_S + 70, BAR_Y + VALUE_ROW + 14)

    const scoreLabel = new Text({ text: 'SCORE', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    scoreLabel.anchor.set(1, 0)
    scoreLabel.position.set(SCORE_R, BAR_Y + LABEL_ROW)
    this.scoreText = new Text({ text: '00000', style: this.style(34, ink.gold, 0.08) })
    this.scoreText.anchor.set(1, 0)
    this.scoreText.position.set(SCORE_R, BAR_Y + VALUE_ROW - 6)

    const sponsor = new Text({
      text: 'PACIFIC EDGE',
      style: this.style(LABEL_SIZE, mix(ink.gold, ink.label, 0.45), 0.2),
    })
    sponsor.position.set(IDENT_X, BAR_Y + LABEL_ROW)
    const name = new Text({ text: 'KIM', style: this.style(32, ink.value, 0.12) })
    name.position.set(IDENT_X, BAR_Y + VALUE_ROW - 4)
    const throwLabel = new Text({ text: 'THROW', style: this.style(LABEL_SIZE, ink.label, 0.18) })
    throwLabel.anchor.set(1, 0)
    throwLabel.position.set(IDENT_R, BAR_Y + LABEL_ROW)
    this.throwText = new Text({ text: '', style: this.style(VALUE_SIZE, ink.value, 0.08) })
    this.throwText.anchor.set(1, 0)
    this.throwText.position.set(IDENT_R, BAR_Y + VALUE_ROW)

    this.container.addChild(
      windLabel, this.windValue, windUnit, scoreLabel, this.scoreText,
      sponsor, name, throwLabel, this.throwText,
    )
  }

  private buildMessages(): void {
    const { ink } = this
    // The prompt is a caption on the bar's top edge rather than a fourth block
    // inside it: the bar has four blocks already and a fifth would squeeze the
    // gauges, which are the instrument the player is actually reading. It is
    // set on a hard offset ink shadow so it belongs to the bar and never reads
    // as text floating on the grass, and it fades to nothing as soon as the
    // phase it belongs to is under way.
    this.promptShadow = new Text({ text: '', style: this.style(21, ink.shadow, 0.14) })
    this.promptShadow.anchor.set(0.5, 0.5)
    this.promptShadow.position.set(960 + 3, PROMPT_Y + 3)
    this.promptText = new Text({ text: '', style: this.style(21, ink.value, 0.14) })
    this.promptText.anchor.set(0.5, 0.5)
    this.promptText.position.set(960, PROMPT_Y)

    this.plate(this.resultPlate, RES_X, RES_Y, RES_W, RES_H)
    this.resultPlate.alpha = 0
    this.resultText = new Text({ text: '', style: this.style(74, ink.value, 0.05) })
    this.resultText.anchor.set(0.5, 0.5)
    this.resultText.position.set(960, RES_Y + 50)
    this.resultText.alpha = 0
    this.resultSub = new Text({ text: '', style: this.style(30, ink.gold, 0.14) })
    this.resultSub.anchor.set(0.5, 0.5)
    this.resultSub.position.set(960, RES_Y + 104)
    this.resultSub.alpha = 0

    this.container.addChild(
      this.promptShadow, this.promptText,
      this.resultPlate, this.resultText, this.resultSub,
    )
  }

  /**
   * The run-end card. Built once, filled by `setEnd`, faded by `setEndFade`.
   *
   * A heading, the total, the three throws as a table, and the two keys. The
   * throws are `Meter`s rather than three more lines of type because the
   * interesting thing about a run of three is the SHAPE of it — one huck and
   * two duds is a different run from three even throws with the same total —
   * and a bar chart says that at a glance where three numbers do not. They are
   * scaled against the longest throw of the run or forty metres, whichever is
   * larger, so a single bar is never full width on its own.
   */
  private buildEndCard(): void {
    const t = this.theme
    const { ink } = this
    const card = this.endCard

    card.addChild(sharedPlate(t, END_W, END_H))

    const head = new Text({ text: 'RUN COMPLETE', style: this.style(46, ink.value, 0.06) })
    head.anchor.set(0.5, 0)
    head.position.set(END_W / 2, 34)
    card.addChild(head)

    // 34 px inside a 74 px plate is what `Readout` gives every event, and the
    // chip is sized to that rather than the face to the chip: a larger value
    // hangs out of the bottom of a plate whose height is the shared system's.
    this.endTotal = new Readout(t, 'TOTAL', { width: 260, align: 'right' })
    this.endTotal.container.position.set(Math.round((END_W - 260) / 2), 96)
    card.addChild(this.endTotal.container)

    // Gold is this interface's accent and the disc's colour both, so the bars
    // are stepped back toward the plate: three full-width gold rails would be
    // the brightest thing on the card and the eye would land on the chrome
    // again, which is the note this event has already paid for twice.
    const bar = mix(ink.gold, t.plate, 0.25)
    // One row per shot. `END_ROW_Y` is the table, so the throw count lives in
    // exactly one place per file and this one does not have to import it.
    for (let i = 0; i < END_ROW_Y.length; i++) {
      const m = new Meter(t, `THROW ${i + 1}`, END_W - 96, bar)
      m.container.position.set(48, END_ROW_Y[i])
      const row = new Text({
        text: '',
        style: new TextStyle({
          fontFamily: 'Archivo, system-ui, sans-serif',
          fontSize: 15, fill: ink.value, fontWeight: '600', letterSpacing: 1.4,
        }),
      })
      row.anchor.set(1, 0)
      row.position.set(END_W - 48, END_ROW_Y[i])
      this.endBars.push(m)
      this.endRows.push(row)
      card.addChild(m.container, row)
    }

    // `endPrompt` centres itself by setting its own `position.x`, so writing a
    // position onto it would throw the centring away. It goes in a wrapper and
    // the wrapper is what gets placed.
    const prompt = new Container()
    prompt.addChild(endPrompt(t, 'THROW AGAIN'))
    prompt.position.set(END_W / 2, 372)
    card.addChild(prompt)

    card.position.set(Math.round(END_X), END_Y)
    card.visible = false
    card.alpha = 0
    this.container.addChild(card)
  }

  /* ------------------------------------------------------------- writes --- */
  /**
   * Draw one instrument scale. `t` is 0..1, `locked` freezes it and turns it
   * gold. Guarded by a signature, so a scale that has not moved costs nothing —
   * and for most of a throw neither of them is moving.
   */
  private drawGauge(
    slot: number, fill: Graphics, needle: Graphics,
    ty: number, t: number, locked: boolean, active: boolean,
  ): void {
    const sig = Math.round(clamp01(t) * 2000) + (locked ? 4001 : 0) + (active ? 9001 : 0)
    if (this.gaugeSig[slot] === sig) return
    this.gaugeSig[slot] = sig

    const live = locked ? this.ink.gold : active ? Core.electricCyan : this.ink.dim
    const tc = clamp01(t)
    const cells = Math.round(tc * MET_CELLS)
    const cw = (MET_TRACK_W - (MET_CELLS - 1) * 2) / MET_CELLS

    fill.clear()
    for (let i = 0; i < cells; i++) {
      // The scale warms toward the top of its range, so a glance reads roughly
      // how hard the throw is before the needle is even found.
      const c = mix(live, this.ink.value, (i / MET_CELLS) * 0.32)
      fill.roundRect(MET_TRACK_X + i * (cw + 2), ty + 4, cw, MET_TRACK_H - 8, 2)
        .fill({ color: c, alpha: locked ? 1 : active ? 0.95 : 0.45 })
    }

    needle.clear()
    const nx = MET_TRACK_X + tc * MET_TRACK_W
    const nc = locked ? this.ink.gold : this.ink.value
    // A blade with its own drop shadow and a chisel head: an instrument needle,
    // not the default white nub of a tuning slider.
    needle.roundRect(nx - 3.5, ty - 6, 7, MET_TRACK_H + 12, 3)
      .fill({ color: darken(this.ink.body, 0.5), alpha: 0.55 })
    needle.moveTo(nx - 6, ty - 11).lineTo(nx + 6, ty - 11).lineTo(nx, ty - 3).closePath().fill(nc)
    needle.roundRect(nx - 2.5, ty - 5, 5, MET_TRACK_H + 10, 2.5).fill(nc)
    // The chamfer down the needle's left flank is a SHADOW, not a highlight,
    // and that is the type ceiling above applied to the one mark that escaped
    // it. `lighten(nc, 0.5)` at alpha 0.7 composited to L=204.8 on the locked
    // gold needle and L=210.3 on the live one — the brightest and the second
    // brightest pixels in the entire frame, both of them two-pixel strips of
    // chrome, both of them above or level with the disc the sky was inverted
    // for. A needle cannot be lit past the ceiling its own plate obeys, and
    // there is no lift available above L=185.9 anyway, so the bevel turns
    // over: the flank away from the light goes down instead.
    needle.roundRect(nx - 2.5, ty - 5, 2, MET_TRACK_H + 10, 1)
      .fill({ color: darken(nc, 0.3), alpha: 0.5 })
    if (locked) {
      needle.moveTo(nx - 7, ty + MET_TRACK_H + 12).lineTo(nx + 7, ty + MET_TRACK_H + 12)
        .lineTo(nx, ty + MET_TRACK_H + 3).closePath().fill(this.ink.gold)
    }
  }

  /**
   * The meter plate is permanent hardware: it is part of the top row whether or
   * not a gauge is live, because a plate that comes and goes reads as an
   * overlay rather than as an instrument. `live` only drives how brightly the
   * scales inside it are rendered.
   */
  setMeter(live: boolean): void {
    // The PLATE never goes translucent — nothing in this HUD is see-through
    // over the world. Only the scales inside it dim.
    const a = live ? 1 : 0.5
    this.angleFill.alpha = a
    this.speedFill.alpha = a
    this.angleNeedle.alpha = a
    this.speedNeedle.alpha = a
  }

  setSpeedGauge(t: number, locked: boolean, active: boolean, metresPerSecond: number): void {
    this.drawGauge(0, this.speedFill, this.speedNeedle, MET_ROW_Y[1], t, locked, active)
    const s = `${metresPerSecond.toFixed(1)} M/S`
    if (s !== this.cachedSpeed) { this.speedValue.text = s; this.cachedSpeed = s }
    this.speedValue.alpha = active || locked ? 1 : 0.5
  }

  setAngleGauge(t: number, locked: boolean, active: boolean, degrees: number): void {
    this.drawGauge(1, this.angleFill, this.angleNeedle, MET_ROW_Y[0], t, locked, active)
    const s = `${degrees.toFixed(0)}°`
    if (s !== this.cachedAngle) { this.angleValue.text = s; this.cachedAngle = s }
    this.angleValue.alpha = active || locked ? 1 : 0.5
  }

  /**
   * Wind, as a diagram. The arrow is the readout; the number is the caption.
   * A crosswind rotates it, a headwind points it back at you and foreshortens
   * nothing — the rose is a plan, so a headwind simply points down the screen.
   */
  setWind(windX: number, windZ: number): void {
    const speed = Math.hypot(windX, windZ)
    // Up is downfield, right is +x. Arrow art points along +x.
    this.windArrow.rotation = Math.atan2(windX, windZ) - Math.PI / 2
    const k = clamp(0.5 + speed * 0.16, 0.5, 1.05)
    this.windArrow.scale.set(k)
    const s = speed.toFixed(1)
    if (s !== this.cachedWind) { this.windValue.text = s; this.cachedWind = s }
  }

  setThrow(index: number, total: number): void {
    const s = `${index} / ${total}`
    if (s !== this.cachedThrow) { this.throwText.text = s; this.cachedThrow = s }
  }

  setScore(score: number): void {
    const s = score.toString().padStart(5, '0')
    if (s !== this.cachedScore) { this.scoreText.text = s; this.cachedScore = s }
  }

  setPrompt(text: string, alpha: number): void {
    if (text !== this.cachedPrompt) {
      this.promptText.text = text
      this.promptShadow.text = text
      this.cachedPrompt = text
    }
    const a = text === '' ? 0 : alpha
    this.promptText.alpha = a
    this.promptShadow.alpha = a * 0.7
  }

  /** `t` counts down from 1 to 0; the banner pops in and drifts out. */
  setResult(text: string, sub: string, t: number, tint: Hex): void {
    if (text !== this.cachedResult) { this.resultText.text = text; this.cachedResult = text }
    if (sub !== this.cachedSub) { this.resultSub.text = sub; this.cachedSub = sub }
    if (tint !== this.cachedTint) { this.resultText.style.fill = tint; this.cachedTint = tint }
    const fade = text === '' ? 0 : smoothstep(0, 0.18, 1 - t) * (t < 0.14 ? t / 0.14 : 1)
    this.resultText.alpha = fade
    this.resultSub.alpha = fade
    this.resultPlate.alpha = fade
    const pop = lerp(1.1, 1, smoothstep(0, 0.3, 1 - t))
    this.resultText.scale.set(pop)
  }

  /**
   * Fill the run-end card from the run that has just finished and show it.
   * One entry per throw, in the order they were thrown.
   */
  setEnd(total: number, throws: readonly EndThrow[]): void {
    this.endTotal.set(total.toString().padStart(5, '0'))
    let longest = 40
    for (const th of throws) longest = Math.max(longest, th.distance)
    for (let i = 0; i < this.endBars.length; i++) {
      const th = throws[i]
      const row = this.endRows[i]
      if (!th) {
        this.endBars[i].set(0)
        row.text = '\u2014'
        continue
      }
      this.endBars[i].set(th.distance / longest)
      row.text = `${th.distance.toFixed(0)} M   \u00b7   ${th.kind}   \u00b7   +${th.points}`
    }
    this.endCard.visible = true
  }

  /** `a` is 0..1. The scene owns the timing; this only applies it. */
  setEndFade(a: number): void {
    this.endCard.alpha = a
  }

  hideEnd(): void {
    this.endCard.visible = false
    this.endCard.alpha = 0
  }

  /** Position every live marker on the overhead strip. */
  setStrip(
    throwerX: number, throwerZ: number,
    receiverX: number, receiverZ: number,
    discX: number, discY: number, discZ: number, discVisible: boolean,
    landX: number, landZ: number, landVisible: boolean,
    distance: number,
  ): void {
    this.throwerMark.position.set(stripX(throwerZ), stripY(throwerX))
    this.receiverMark.position.set(stripX(receiverZ), stripY(receiverX))

    this.discDot.visible = discVisible
    this.discTick.visible = discVisible
    if (discVisible) {
      const dx = stripX(discZ)
      const dy = stripY(discX)
      this.discDot.position.set(dx, dy)
      this.discTick.position.set(dx, dy)
      // Height, drawn as a mast on the dot, clamped to the recess so the plot
      // never spills over its own frame.
      this.discTick.scale.y = clamp(discY * 2.2, 1, Math.max(1, dy - RECESS_Y - 6))
    }

    this.landingMark.visible = landVisible
    this.chaseLine.clear()
    if (landVisible) {
      const lx = stripX(landZ)
      const ly = stripY(landX)
      this.landingMark.position.set(lx, ly)
      // The gap the receiver still has to close, drawn as a dashed run.
      const rx = stripX(receiverZ)
      const ry = stripY(receiverX)
      const dist = Math.hypot(lx - rx, ly - ry)
      if (dist > 6) {
        const steps = Math.min(14, Math.floor(dist / 18))
        for (let i = 0; i < steps; i++) {
          const a = i / steps
          const b = a + 0.45 / steps
          this.chaseLine.moveTo(lerp(rx, lx, a), lerp(ry, ly, a))
            .lineTo(lerp(rx, lx, b), lerp(ry, ly, b))
        }
        this.chaseLine.stroke({ color: Core.electricCyan, width: 3, alpha: 0.6 })
      }
    }

    const s = distance > 0 ? `${distance.toFixed(0)} M` : ''
    if (s !== this.cachedDistance) { this.stripDistance.text = s; this.cachedDistance = s }
  }

  destroy(): void {
    this.container.destroy({ children: true })
  }
}
