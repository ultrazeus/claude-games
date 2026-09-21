import type { Scene, SceneContext } from '../../../core/Scene'
import { ResultsPanel, ratingFor } from '../../ui/Results'
import { Action } from '../../../core/Input'
import { Sky } from '../../../render/Sky'
import { ParticleSystem } from '../../../render/Particles'
import { softDot } from '../../../render/Gradient'
import { Core, Palettes, grade, lighten, mix , type Hex} from '../../../render/Palette'
import { clamp, clamp01, damp, lerp, smoothstep } from '../../../core/Tween'
import { CAM_H, CENTRE_X, Field, HORIZON_Y, RIVER_Z0 } from './Field'
import { Disc } from './Disc'
import { Athlete } from './Receiver'
import { Hud, type EndThrow } from './Hud'

/**
 * Flying Disc.
 *
 * The odd one out of the six: two phases per throw rather than one continuous
 * run. You set the throw against the wind, and then you become the person who
 * has to go and catch it.
 *
 *   Phase 1, throw.  An ANGLE gauge sweeps; A locks it. A SPEED gauge sweeps;
 *                    A locks it and the disc goes. Both gauges live on one
 *                    plate docked top-right, off the playfield. The wind is
 *                    shown — as a number, as a plan compass on the status rail,
 *                    and as a windsock on the far bank — before either gauge
 *                    starts, because a throw made blind into the wind is a coin
 *                    toss, not a decision.
 *
 *   Phase 2, catch.  Control moves downfield to the receiver. Left/Right runs
 *                    him across the field; he closes the downfield gap himself
 *                    at a capped sprint, so a long throw genuinely arrives
 *                    before he does. A jumps. B (or Down) lays him out full
 *                    length. The catch is scored on how far the disc went and
 *                    on how it was taken.
 *
 * The disc's flight is in `Disc.ts` and is a real aerodynamic model — lift,
 * drag, bank and gyroscopic turn/fade — integrated in metres and seconds.
 */

type Phase = 'ready' | 'angle' | 'power' | 'release' | 'flight' | 'result' | 'done'
type CatchKind = 'none' | 'clean' | 'leaping' | 'diving' | 'scrambling' | 'dropped'

// --- staging ----------------------------------------------------------------
/**
 * Where the thrower stands, metres.
 *
 * Far enough off the camera axis that the throw has somewhere to GO on screen.
 *
 * This is staging, not mechanics: the disc, the receiver and the camera are all
 * placed relative to this line, so moving it slides the whole event sideways in
 * the world and changes nothing about the throw. What it changes is the one
 * thing four blind reviews in a row could not get past.
 *
 * A disc launched straight downfield keeps the thrower's world x, and a pinhole
 * camera converges everything toward the axis with depth. The separation on
 * screen between the thrower at 4.5 m and his disc at twenty-odd is therefore
 * (THROWER_X - camX) * (ps_near - ps_far) — which at -3.2 is about fifty
 * pixels, and fifty pixels behind a figure drawn two and a half times life size
 * is *underneath him*. That is the whole of the "invisible disc" finding:
 *
 *   "an 80px ellipse ... pasted flat across the pink jersey at chest height,
 *    while the throwing arm the whole pose is built around extends empty"
 *   "it reads as a badge sewn onto #FF5285"
 *
 * At -5.4 the same arithmetic puts the disc about a hundred and ninety pixels
 * clear of the thrower's centre line, off his throwing hand and into open sky,
 * which is where every one of those reviews asked for it. It also moves the
 * figure himself onto the left third of the frame, so the throw reads left to
 * right across the picture instead of out of its middle.
 */
/* --- results screen. `RESULT_PAR` only positions the judges' cards. */
const RESULT_LABELS = ['DISTANCE', 'ACCURACY', 'CATCHES', 'STYLE'] as const
const RESULT_COLORS: readonly Hex[] = [0xffd27a, 0x9fd8ff, 0xffe6a8, 0xb9f2c8]
const RESULT_PAR = 2400

const THROWER_X = -5.4
const THROWER_Z = 4.5
/** Release point, metres. Hand height on a full-reach backhand. */
const RELEASE_Y = 1.35
const RECEIVER_START_Z = 20

// --- gauges -----------------------------------------------------------------
/** Launch elevation range the ANGLE gauge maps onto, degrees. */
const ANGLE_MIN = 5
/**
 * The top of the range is 30 rather than 45: past about 30 degrees a full-power
 * throw arcs above the frame entirely, and a disc you cannot see is not a shot
 * you can judge. It also keeps every gauge position a throw worth making.
 */
const ANGLE_MAX = 30
/** Release speed range the SPEED gauge maps onto, m/s. */
const SPEED_MIN = 13
const SPEED_MAX = 31
/** Sweeps per second. Power is faster than angle, because it hurts more. */
const ANGLE_RATE = 0.62
const POWER_RATE = 0.78

// --- receiver ---------------------------------------------------------------
/** Flat-out run, m/s. About a decent club sprinter, and the total speed cap. */
const RUN_SPEED = 9
/**
 * Downfield chase, m/s. Deliberately a shade under what a flat maximum-power
 * throw demands: a lofted throw lands short but the receiver strolls under it,
 * a flat huck goes far but he arrives a stride late and has to lay out. That
 * trade is the whole risk curve of the event, and it lives in this one number.
 */
const CHASE_SPEED = 7.9
const RECEIVER_ACCEL = 26
const JUMP_V = 5.2
const RECEIVER_G = 17
const DIVE_TIME = 0.95
const DIVE_RECOVER = 0.55
/** Forward-and-across launch speed of a dive, m/s. */
const DIVE_PUSH = 6.4

// --- camera -----------------------------------------------------------------
/** How far behind the disc the camera tries to sit, metres. */
/**
 * The hero stops growing.
 *
 * The camera dollies downfield behind the disc and ends up twenty metres PAST
 * the throw line, at which point the thrower's pixels-per-metre has quintupled:
 * he loomed seven hundred pixels tall with his trailing arm off the left edge,
 * and a review of the frame reported the left eighth of him cropped. The dolly
 * exists to keep the receiver readable, not to zoom the thrower, so his rig is
 * staged at a fixed apparent size — roughly what it is at the throw line — and
 * only his POSITION keeps obeying the camera. A foreground figure that holds
 * its size while the world moves behind it is how the references stage a hero;
 * a figure that grows to two thirds of frame height is a mistake.
 *
 * Pixels per metre for the rig, not for the field.
 */
const HERO_SCALE_MAX = 186
/**
 * Fallback for how far left of his own root the thrower's silhouette reaches,
 * in metres at the rig's scale. Used only on the first frame, before the rig
 * has been drawn once.
 *
 * It used to be the whole constraint, hand-estimated at 0.95 m as "the trailing
 * arm at full extension plus the torso", and the estimate was simply wrong. The
 * bound it produced held for the frame that was captured to check it and failed
 * on the next throw:
 *
 *   "the clipped thrower at x=0, throwing arm amputated by the frame edge,
 *    pointing left while the disc travels right"
 *
 * The pose is not constant — `throwSwing` runs -1 to +1 through the release and
 * the aim crouch sits at -0.62 — so the silhouette's leftmost point moves by
 * most of a metre across a throw, and a single authored number can only be
 * right at one instant of one throw. `HERO_MEASURE_CAP` bounds what the
 * measurement is allowed to claim so a degenerate frame cannot pan the camera
 * off the field.
 */
const HERO_REACH = 0.95
/** Ceiling on the measured reach, metres. Sanity, not staging. */
const HERO_MEASURE_CAP = 2.6
/**
 * Pixels of frame edge the thrower's silhouette must keep clear.
 *
 * The constraint below is BINDING for the whole of a long throw — simulated
 * offline across the capture driver's envelope (angle 0.45-0.62, power 0.88-1.0,
 * wind +/-3 by +/-2.6), the camera sits on this bound at every one of the thirty
 * outcomes — so this number is not a safety margin that is rarely reached, it
 * IS the gutter the frame is composed with. At 28 it was 1.5% of the width: not
 * an amputation any more, but a silhouette pressed against the edge, which is
 * what the previous review saw a worse version of. At 52 it is 2.7%, which
 * reads as the figure being placed near the edge rather than stopped by it. It
 * costs 0.2 m of lateral pan and nothing else.
 */
const SAFE_EDGE = 52
const CAM_TRAIL = 34
/** The dolly is capped so the composition never drifts far from the original. */
const CAM_MAX_Z = 26
/**
 * Screen y the camera tries to keep the disc below: clear of the strip.
 *
 * The camera is now BELOW the disc's flight altitude, so a throw climbs off the
 * top of the frame far sooner than it used to and this constraint does real
 * work instead of almost never firing.
 */
const DISC_HEADROOM = 236
/** Hard cap on the tilt, px of horizon drop. */
const CAM_PITCH_MAX = 150
/** Screen y the receiver's feet must stay above: clear of the bottom rail. */
const RECEIVER_FLOOR = 918

/**
 * How much bigger than life the thrower is drawn.
 *
 * Two reviews in a row put the protagonist at the bottom of the focal order —
 * first "roughly 40px tall, and partly cut by the HUD bar", then "the thrower
 * is ~4% of frame height in mid-value pink on mid-value green, which is the
 * lowest-contrast pairing available".
 *
 * So she is staged as the subject she is. At 1.72 the rig stands about 315 px
 * at the throw line — 29% of frame height, against the ~20% the reference holds
 * its rider at, and still the largest thing in the picture by a long way.
 *
 * It was 2.55, which is 43%, and that is past the point where scale helps. Two
 * things broke there. `score_frame.py` flags any subject box taller than a
 * third of the frame `?no-subject` — the reading is then of an accent that is
 * not reserved, not of an athlete — so every `subject_break` quoted for this
 * event was invalid. And a figure that big covers the sky the disc has to fly
 * through: at 2.55 the torso alone spanned the entire band the disc crosses in
 * the first thirty metres of every throw.
 *
 * The number is chosen together with `CAM_H`, not independently of it. The two
 * of them decide where the horizon crosses the figure, and that is the whole
 * point of the pass: at 2.1 m of camera height and this scale the horizon runs
 * through her hips, so the pink torso — the only saturated hue anywhere in the
 * frame — is punched out of the pale sky band, while her legs stay on the dark
 * field. A measured 0.097 of local contrast came from staging her entirely on
 * the grass, mid value on mid value; this is what replaces it. The other half
 * of that note is answered in `Receiver.ts`: she is three-quarter backlit by
 * the low sun and carries a hot rim down her right edge, so the contrast is a
 * value break and not only a hue.
 *
 * It is a drawing scale only: the rig reports its reach in metres from its own
 * constants, so nothing in the simulation moves. The thrower has no catch
 * volume in any case.
 */
const THROWER_HERO = 1.72

/**
 * Pixels the hero is STAGED above his own projected feet.
 *
 *   "the bottom HUD's top edge at y=749 amputates his rear foot"
 *
 * Reported twice. Measured on `captures/flyingdisc.png`: the bar's top edge is
 * at y=962, his rear boot's sole at y=948 and his FRONT shin runs straight
 * into the bar with no boot on the end of it at all. The last pass raised the
 * bar and the bar is not the problem — the HUD is fixed furniture and this
 * file does not own it. What this file owns is where the hero is put.
 *
 * He is already staged rather than projected: `HERO_SCALE_MAX` freezes his
 * drawn size while the camera dollies past him, because a hero who grows to
 * two thirds of frame height is a mistake. This is the same decision applied
 * to the other axis, and it costs the picture nothing because his cast shadow
 * and his light pool are driven off the same number, so the man, the ground he
 * lights and the shadow he throws move as one piece. At 34 px his sole clears
 * the bar by twenty-eight and his shoulders come up into the sun rake band
 * that `Field.ts` now puts behind him, which is where the value break the
 * whole staging is built on wants them.
 */
const HERO_LIFT = 34

/**
 * The one saturated hue in this event, and it belongs to the athletes. Nothing
 * else in the frame may use it — not the windsock, not the disc, not the HUD.
 * Reserving a hue for the player is the cheapest way to win the focal contest
 * and it was the review's own prescription.
 */
/**
 * Darker and hotter than `Core.hotPink` itself, and that is the point.
 *
 * Three blind reviews asked for the same structure in this frame, in almost
 * the same words: "drive the athlete and the near field down into a dark
 * silhouette band", "collapse the playfield into two flat, quiet values, then
 * reserve the frame's genuine darkest dark and lightest light for the thrower
 * and the disc". At full value the kit measured luminance 0.47 with a pale sky
 * above the horizon and a mid field below it, so the athlete sat exactly
 * halfway between his own background and separated from neither: a measured
 * 0.081 of local contrast.
 *
 * At v 0.78 / s 1.28 that came down to luminance 0.30, which fixed the sky
 * half of the problem and not the ground half: the mid field the athlete's
 * legs stand on measures 0.35-0.43, so his lower body was still mid on mid and
 * the measured break swung between 0.18 and 0.45 purely on how much sky
 * happened to fall inside the detector's ring.
 *
 * At v 0.60 / s 1.40 the kit is luminance ~0.19 and colourfulness ~0.45. That
 * is below every surface in the frame — the near field included — so he
 * separates the same amount wherever he is standing and whatever the camera
 * tilt is doing, which is the difference between a value plan and a lucky
 * frame. The lightest light is the sun rim down his right edge; the darkest
 * dark is the rest of him.
 */
const KIT = grade(Core.hotPink, { valScale: 0.6, satScale: 1.4 })
/**
 * The shorts were the half of the kit nobody measured.
 *
 * The jersey has been at luminance 39.5 for three passes and the paragraph
 * above is about the jersey. `mix(suitDark, paperWhite, 0.12)` came out at
 * 65.2 — a mid value, on the second-largest surface on the figure, and the
 * chest bib derived from it landed at 99.7, which is the field's own colour to
 * within two points. So the figure the value plan described as "below every
 * surface in the frame" had a third of its pixels sitting on top of one.
 *
 * Graded rather than lerped toward paper, so the shorts read as the dark half
 * of a two-piece kit instead of as a light one: luminance 42.4, close enough to
 * the jersey that the athlete is one silhouette and far enough from the ink
 * (18.9) that the outline still draws.
 */
const KIT_SHORTS = grade(mix(Core.suitDark, Core.paperWhite, 0.2), {
  valScale: 0.56, satScale: 1.3,
})

// Three, per the C64 original: "every player has three shots, which are
// summed up". This had been five.
const THROWS = 3

export class FlyingDisc implements Scene {
  readonly id = 'flyingdisc'

  private ctx!: SceneContext
  private pal = Palettes.flyingdisc

  private sky!: Sky
  private field!: Field
  private disc!: Disc
  private receiver!: Athlete
  private thrower!: Athlete
  /** Scratch: the thrower's hand in screen space. Read immediately. */
  private handAnchor = { x: 0, y: 0 }
  private hud!: Hud
  /** Shared between-event results screen; see `src/game/ui/Results.ts`. */
  private results!: ResultsPanel
  private scuff!: ParticleSystem

  // --- phase ----------------------------------------------------------------
  private phase: Phase = 'ready'
  private phaseTime = 0
  private promptPulse = 0

  // --- gauges ---------------------------------------------------------------
  private angleT = 0
  private angleDir = 1
  private angleLocked = false
  private powerT = 0
  private powerDir = 1
  private powerLocked = false
  /** True once the disc has left the hand this throw. */
  private released = false
  private lockedAngle = 0
  private lockedSpeed = 0

  // --- wind -----------------------------------------------------------------
  private windX = 0
  private windZ = 0

  // --- receiver state, metres ----------------------------------------------
  private rx = THROWER_X
  private rz = RECEIVER_START_Z
  private ry = 0
  private rvx = 0
  private rvz = 0
  private rvy = 0
  private runPhase = 0
  private diveTimer = 0
  private recoverTimer = 0
  private diveDirX = 0
  private diveDirZ = 1
  private airborne = false

  // previous-step copies for render interpolation
  private prevRx = THROWER_X
  private prevRz = RECEIVER_START_Z
  private prevRy = 0

  // --- run ------------------------------------------------------------------
  private throwIndex = 1
  private score = 0
  /**
   * What each throw of the run was worth, in the order they were thrown.
   *
   * The original sums three shots and this had nowhere to put the summands:
   * each throw's distance and points lived for two seconds in the result
   * banner and then were gone, so the total at the end was a number with no
   * working shown. The run-end card prints the three of them.
   */
  private readonly throwLog: EndThrow[] = []
  private distance = 0
  private lastDistance = 0
  private catchKind: CatchKind = 'none'
  private resultTimer = 0
  private resultTitle = ''
  private resultSub = ''
  private resultTint: number = Core.paperWhite

  /** Predicted landing point, [x, z]. Refreshed a few times a second. */
  private landing = new Float32Array(2)
  private landingValid = false
  private predictTimer = 0

  private camXTarget = 0
  private camZTarget = 0
  /**
   * Measured leftward reach of the thrower's silhouette from his own root, in
   * metres at the rig's scale. Written in `render()` from the rig's real local
   * bounds and read by `updateCamera()` one frame later, which is invisible at
   * 60 Hz and is the only way to get a number that is true for the pose that is
   * actually on screen.
   */
  private heroReachM = HERO_REACH

  private windBed: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null
  private whirr: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null

  // ------------------------------------------------------------------- enter
  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = this.pal

    this.sky = new Sky(pal, {
      width: ctx.width, height: ctx.height,
      // An hour before it goes: low, far right, sitting just above the treeline
      // on the far bank. That is where every shadow in this event points from,
      // and why they are long and rake down and to the left.
      //
      // It is kept small and dim on purpose. A big bloom low in the frame is
      // the brightest thing on screen and out-ranks the athlete, which is the
      // failure `ENGINE.md` names first; the sun's job here is to justify the
      // light, not to win the focal contest.
      // No bloom. `Sky`'s sun is a `radialGlow` sprite plus a white core, and
      // a blind review named the mixture as the clearest amateur tell in the
      // frame: "crisp vector trees, airbrushed gradient hills with a canned
      // white radial bloom, and a depth-of-field-blurred photographic grass
      // foreground - three incompatible rendering languages in one frame."
      // The event commits to flat vector, so the sun is drawn in `Field` as a
      // hard-edged disc with two hard rings, like everything else here.
      sunIntensity: 0,
      horizonY: HORIZON_Y,
    })
    ctx.root.addChild(this.sky.container)

    this.field = new Field(pal, ctx.rng)
    ctx.root.addChild(this.field.container)

    this.disc = new Disc(pal)
    // Same kit on both, but the receiver's is pre-graded for the distance he
    // lives at — twenty to seventy metres out — so aerial perspective, not a
    // different colour, is what keeps the near figure owning the chroma.
    this.receiver = new Athlete(
      pal,
      // Pushed further down the chroma scale than it was. The thrower is the
      // subject of the frame this event is judged on, and two figures in the
      // same reserved hue split the one thing the eye is supposed to land on.
      // Two blind reviews independently reported this figure as a BUG in the
      // hero rather than as a second athlete — "a quarter-scale duplicate
      // player in the identical pink/navy kit", "an orphaned sprite". He was
      // rendered at the thrower's exact world x (the receiver's start is the
      // throw line), so from twenty metres back he projected about fifty pixels
      // off the hero's hip in the hero's exact colours. The throw line moving
      // out to -5.4 separates them on screen; twice the aerial perspective
      // stops the near figure and the far one reading as the same material.
      // Chroma at 0.3 with 0.32 of haze over it is grey, and grey is what the
      // next round of reviews called it: "a featureless grey rectangle for a
      // torso". A downfield figure should read as the same team in the same
      // kit seen through forty metres of warm air, which is a DARKER, softer
      // version of the hero's hue — not the absence of one. Value carries the
      // separation now (0.66 against the hero's 1.0), so he still cannot
      // out-rank her.
      // valScale 0.66 -> 0.40, and the fog with it. A blind review measured
      // this figure's break at 6.5 luminance points; his kit rendered at 75
      // against a mid wood at 82 and a field at 92, so he had neither end of
      // the ladder. He stands ON the horizon — head and torso against the mid
      // wood, legs on the light strip — so he needs to be under BOTH, and the
      // mid wood came down to 71 in the same pass. At 0.40 he reads 52: nineteen
      // under the wood his torso crosses, sixty under the strip his legs stand
      // on, and still thirteen above the hero's own 39.5, which is what keeps
      // the near figure owning the kit.
      //
      // The fogAmount comes down too. Fog is a lerp toward the haze (L=161), so
      // past a point it is a FLOOR on how dark a distant thing can be: at 0.2,
      // valScale 0.36 still could not get this figure below 55.
      grade(KIT, { satScale: 0.62, valScale: 0.40, fog: pal.haze, fogAmount: 0.16 }),
      grade(KIT_SHORTS, { satScale: 0.7, valScale: 0.55, fog: pal.haze, fogAmount: 0.12 }),
    )
    this.thrower = new Athlete(pal, KIT, KIT_SHORTS)

    // Shadows go on the grass, actors above them, the trail above the actors —
    // and the whole stack sits behind the foreground blades, which is what makes
    // the near grass read as foreground rather than wallpaper.
    this.field.shadowLayer.addChild(this.receiver.shadow, this.thrower.shadow, this.disc.shadow)
    this.field.actorLayer.addChild(
      // The drawn flight path goes in first, so it runs behind both athletes
      // and the disc rides on top of its own arc.
      this.disc.arc,
      this.receiver.container, this.thrower.container,
      this.disc.container, this.disc.trail.container,
    )

    // Torn grass, kicked up by a dive or a hard plant. Sits under the actors so
    // it reads as coming off the ground rather than out of the athlete.
    this.scuff = new ParticleSystem(softDot(lighten(pal.near, 0.24), 32, 0.9), 96)
    this.field.shadowLayer.addChild(this.scuff.container)

    this.hud = new Hud(pal)
    ctx.root.addChild(this.hud.container)

    this.results = new ResultsPanel(pal, 'FLYING DISC', RESULT_LABELS, RESULT_COLORS)
    this.results.setVisible(false)
    ctx.root.addChild(this.results.container)

    // A wind bed that actually tracks the wind the player is throwing into.
    this.windBed = ctx.audio.loopNoise({ cutoff: 320, q: 0.6, gain: 0.03 })
    // The disc's whirr. Held open at zero gain rather than started and stopped
    // per throw, so there is never a click on release.
    this.whirr = ctx.audio.loopNoise({ cutoff: 900, q: 4, gain: 0.0001 })

    this.rollWind()
    this.resetThrow()
    this.exposeEndHandle()
  }

  /**
   * `window.__cg.discEnd(score?)` — jump straight to the run-end card.
   *
   * Three throws is a couple of minutes of play to reach a screen somebody has
   * to photograph, and a capture script that has to *land* three catches to
   * check the card's table is a capture script testing the flight model. This
   * ends the run where it stands, filling any throws that have not been made
   * with plausible ones so the table is not half empty, and optionally pinning
   * the total first.
   *
   * A debug affordance and nothing else: no input reaches it, it changes no
   * rule, and `finishThrow` is not involved. `App` puts `__cg` on the window
   * before any scene enters, so this extends that object rather than replacing
   * it. Precedent: `__cg.surfResults`.
   */
  private exposeEndHandle(): void {
    const w = window as unknown as Record<string, unknown>
    const cg = (w.__cg ?? (w.__cg = {})) as Record<string, unknown>
    cg.discEnd = (score?: number): number => {
      const filler: EndThrow[] = [
        { distance: 38, points: 393, kind: 'CLEAN CATCH' },
        { distance: 51, points: 1119, kind: 'LAYOUT CATCH' },
        { distance: 44, points: 0, kind: 'DROPPED' },
      ]
      while (this.throwLog.length < THROWS) this.throwLog.push(filler[this.throwLog.length % 3])
      this.throwLog.length = THROWS
      if (typeof score === 'number') this.score = Math.max(0, Math.round(score))
      else if (this.score === 0) {
        this.score = this.throwLog.reduce((a, t) => a + t.points, 0)
      }
      this.throwIndex = THROWS
      this.disc.flying = false
      this.phase = 'done'
      this.phaseTime = 0
      this.hud.setEnd(this.score, this.throwLog)
      // The shared results screen. `hud.setEnd` still runs because `endCardUp`
      // in `debug()` is what the capture gate reads for a finished run.
      const caught = this.throwLog.filter((t) => t.points > 0).length
      const far = Math.max(0, ...this.throwLog.map((t) => t.distance))
      this.results.setTitle('FLYING DISC  \u00b7  3 THROWS')
      this.results.show(ratingFor(this.score, RESULT_PAR), this.score)
      this.results.meters[0].set(clamp01(far / 120))
      this.results.meters[1].set(clamp01(this.score / RESULT_PAR))
      this.results.meters[2].set(clamp01(caught / THROWS))
      this.results.meters[3].set(clamp01(this.score / (RESULT_PAR * 1.2)))
      this.results.setVisible(true)
      return this.score
    }
  }

  // ------------------------------------------------------------- throw setup
  private rollWind(): void {
    const rng = this.ctx.rng
    // Cross wind dominates: it is the component the player has to counter by
    // aiming, and the one the receiver has to chase.
    this.windX = rng.range(-3, 3)
    this.windZ = rng.range(-2.6, 2.6)
    this.field.setWind(this.windX, this.windZ)
  }

  private resetThrow(): void {
    this.results?.setVisible(false)
    this.phase = 'ready'
    this.phaseTime = 0
    this.angleT = 0
    this.angleDir = 1
    this.angleLocked = false
    this.powerT = 0
    this.powerDir = 1
    this.powerLocked = false
    this.released = false
    this.lockedAngle = 0
    this.lockedSpeed = 0
    this.catchKind = 'none'
    this.distance = 0
    this.landingValid = false
    this.predictTimer = 0

    this.disc.flying = false
    this.disc.x = THROWER_X
    this.disc.y = RELEASE_Y
    this.disc.z = THROWER_Z
    this.disc.vx = this.disc.vy = this.disc.vz = 0
    this.disc.trail.clear()
    this.disc.clearArc()

    this.rx = this.prevRx = THROWER_X
    this.rz = this.prevRz = RECEIVER_START_Z
    this.ry = this.prevRy = 0
    this.rvx = this.rvz = this.rvy = 0
    this.diveTimer = 0
    this.recoverTimer = 0
    this.airborne = false

    this.field.camX = 0
    this.field.camZ = 0
    this.camXTarget = 0
    this.camZTarget = 0
  }

  private get angleRad(): number {
    const deg = lerp(ANGLE_MIN, ANGLE_MAX, this.angleLocked ? this.lockedAngle : this.angleT)
    return (deg * Math.PI) / 180
  }

  private get angleDeg(): number {
    return lerp(ANGLE_MIN, ANGLE_MAX, this.angleLocked ? this.lockedAngle : this.angleT)
  }

  private get speedValue(): number {
    return lerp(SPEED_MIN, SPEED_MAX, this.powerLocked ? this.lockedSpeed : this.powerT)
  }

  // ------------------------------------------------------------------ update
  update(dt: number): void {
    const input = this.ctx.input
    this.phaseTime += dt
    this.promptPulse += dt
    this.prevRx = this.rx
    this.prevRz = this.rz
    this.prevRy = this.ry
    this.scuff.update(dt)
    // Nobody stands perfectly still waiting for a throw. Keep the gait cycle
    // turning slowly through the aim so the receiver idles rather than freezes.
    if (this.phase === 'ready' || this.phase === 'angle' || this.phase === 'power') {
      this.runPhase += dt * 2.6
    }

    switch (this.phase) {
      case 'ready': this.updateReady(); break
      case 'angle': this.updateAngle(dt); break
      case 'power': this.updatePower(dt); break
      case 'release': this.updateRelease(dt); break
      case 'flight': this.updateFlight(dt); break
      case 'result': this.updateResult(dt); break
      case 'done': this.updateDone(); break
    }

    this.updateCamera(dt)
    this.field.update(dt)
    this.disc.updateTrail(dt, this.field)
    this.receiver.update(dt)
    this.thrower.update(dt)
    this.updateAudio()

    if (input.justPressed(Action.Back)) this.ctx.goto('menu')
  }

  private updateReady(): void {
    const input = this.ctx.input
    // A short beat so the wind readout and the windsock are legible before the
    // gauge starts. Buffered, so an impatient press still opens the sweep.
    if (this.phaseTime > 0.55 && input.buffered(Action.A, 8)) {
      input.consumeBuffer(Action.A)
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.phase = 'angle'
      this.phaseTime = 0
      this.ctx.audio.tone({ freq: 420, toFreq: 560, duration: 0.07, type: 'triangle', gain: 0.1 })
    }
  }

  /**
   * Advance a gauge needle, bouncing it off both ends and ticking as it turns.
   * Writes `sweptT` and `sweptDir` instead of returning a pair, so the hot path
   * of the aiming phase allocates nothing.
   */
  private sweptT = 0
  private sweptDir = 1

  private sweep(t: number, dir: number, rate: number, dt: number): void {
    let nt = t + dir * rate * dt
    let nd = dir
    if (nt >= 1) { nt = 1 - (nt - 1); nd = -1; this.tick() }
    if (nt <= 0) { nt = -nt; nd = 1; this.tick() }
    this.sweptT = clamp01(nt)
    this.sweptDir = nd
  }

  private tick(): void {
    this.ctx.audio.tone({ freq: 300, duration: 0.035, type: 'square', gain: 0.035 })
  }

  private updateAngle(dt: number): void {
    const input = this.ctx.input
    this.sweep(this.angleT, this.angleDir, ANGLE_RATE, dt)
    this.angleT = this.sweptT
    this.angleDir = this.sweptDir

    if (input.buffered(Action.A, 6)) {
      input.consumeBuffer(Action.A)
      this.lockedAngle = this.angleT
      this.angleLocked = true
      // The lock is the single most latency-sensitive moment in the event.
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.tone({ freq: 620, toFreq: 880, duration: 0.11, type: 'triangle', gain: 0.15 })
      this.ctx.audio.noise({ duration: 0.07, cutoff: 3200, toCutoff: 900, gain: 0.08 })
      this.phase = 'power'
      this.phaseTime = 0
    }
  }

  private updatePower(dt: number): void {
    const input = this.ctx.input
    this.sweep(this.powerT, this.powerDir, POWER_RATE, dt)
    this.powerT = this.sweptT
    this.powerDir = this.sweptDir

    if (input.buffered(Action.A, 6)) {
      input.consumeBuffer(Action.A)
      this.lockedSpeed = this.powerT
      this.powerLocked = true
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.tone({ freq: 700, toFreq: 1040, duration: 0.12, type: 'triangle', gain: 0.16 })
      this.phase = 'release'
      this.phaseTime = 0
    }
  }

  /**
   * The wind-up and throw. The disc leaves the hand a quarter of a second into
   * the sweep and keeps integrating through the rest of the follow-through, so
   * there is no frame where it hangs in the air waiting for an animation.
   */
  private updateRelease(dt: number): void {
    if (!this.released && this.phaseTime >= 0.24) {
      this.released = true
      this.disc.launch(THROWER_X, RELEASE_Y, THROWER_Z + 0.2, this.speedValue, this.angleRad, -1)
      this.ctx.audio.noise({ duration: 0.24, cutoff: 4600, toCutoff: 620, gain: 0.2 })
      this.ctx.audio.tone({ freq: 190, toFreq: 88, duration: 0.2, type: 'sawtooth', gain: 0.08 })
    }
    if (this.released) {
      this.disc.update(dt, this.windX, this.windZ)
      this.distance = Math.max(0, this.disc.z - THROWER_Z)
      // He breaks on the throw, not on the animation finishing.
      this.updateReceiver(dt)
    }
    if (this.phaseTime >= 0.42) {
      this.phase = 'flight'
      this.phaseTime = 0
    }
  }

  private updateFlight(dt: number): void {
    this.disc.update(dt, this.windX, this.windZ)
    this.distance = Math.max(0, this.disc.z - THROWER_Z)

    // Landing prediction, refreshed 8 times a second. Integrating the same
    // model forward is cheap; recomputing it every frame is waste.
    this.predictTimer -= dt
    if (this.disc.flying && this.predictTimer <= 0) {
      this.predictTimer = 0.125
      this.disc.predictLanding(this.windX, this.windZ, this.landing)
      this.landingValid = this.disc.age > 0.35
    }

    this.updateReceiver(dt)

    if (this.disc.flying && this.tryCatch()) return

    if (!this.disc.flying) {
      // Hit the ground. Only the far bank is out of reach, and only just.
      this.finishThrow('dropped')
    }
  }

  /**
   * The receiver.
   *
   * Left/Right is lateral only; the downfield chase is automatic and capped.
   * That split is deliberate: the throw decides how far he has to go, and the
   * player decides the line. It also means a huck genuinely arrives before he
   * does, which is what makes the dive a real decision rather than a flourish.
   */
  private updateReceiver(dt: number): void {
    const input = this.ctx.input

    if (this.diveTimer > 0) {
      // Committed. No steering mid-dive — that is the cost of laying out.
      this.diveTimer -= dt
      this.rvx = damp(this.rvx, 0, 0.28, dt)
      this.rvz = damp(this.rvz, 0, 0.28, dt)
      this.ry = Math.max(0, this.ry + this.rvy * dt)
      this.rvy -= RECEIVER_G * 0.55 * dt
      if (this.diveTimer <= 0) {
        this.recoverTimer = DIVE_RECOVER
        this.ry = 0
        this.rvy = 0
        // Landing on your chest tears up a lot more grass than landing on your feet.
        this.emitScuff(16, 1.8)
        this.ctx.audio.noise({ duration: 0.2, cutoff: 1100, toCutoff: 180, gain: 0.16 })
      }
    } else if (this.recoverTimer > 0) {
      this.recoverTimer -= dt
      this.rvx = damp(this.rvx, 0, 0.05, dt)
      this.rvz = damp(this.rvz, 0, 0.05, dt)
    } else {
      const axis = input.axisX()
      if (axis !== 0) this.ctx.perf.markResponse(input.lastRawPressTime)

      // Downfield first. The chase has first call on the speed budget, and only
      // what is left over goes sideways. Doing it the other way round means
      // holding a direction quietly stops the receiver running downfield at all,
      // which is both unfair and invisible — the player never sees why the disc
      // landed five metres in front of them.
      const targetZ = this.landingValid ? this.landing[1] : this.disc.z
      const gap = targetZ - this.rz
      const wantVz = clamp(gap * 3.2, -CHASE_SPEED * 0.6, CHASE_SPEED)
      this.rvz += clamp(wantVz - this.rvz, -RECEIVER_ACCEL * dt, RECEIVER_ACCEL * dt)

      // Lateral: player-driven, inside whatever the sprint leaves. At a flat-out
      // chase that is a sideways shuffle; once he has arrived it is a full
      // sprint across. One body, one engine.
      const budget = Math.sqrt(Math.max(1, RUN_SPEED * RUN_SPEED - this.rvz * this.rvz))
      const wantVx = axis * budget
      this.rvx += clamp(wantVx - this.rvx, -RECEIVER_ACCEL * dt, RECEIVER_ACCEL * dt)
      this.rvx = clamp(this.rvx, -budget, budget)

      // Jump.
      if (!this.airborne && input.buffered(Action.A, 6)) {
        input.consumeBuffer(Action.A)
        this.rvy = JUMP_V
        this.airborne = true
        this.ctx.perf.markResponse(input.lastRawPressTime)
        this.ctx.audio.noise({ duration: 0.12, cutoff: 1600, toCutoff: 420, gain: 0.08 })
      }

      // Dive. Down is a second binding because a thumb on the d-pad is already
      // there, and the one-handed keyboard player should not have to stretch.
      const wantDive = input.buffered(Action.B, 6) || input.buffered(Action.Down, 6)
      if (!this.airborne && wantDive) {
        input.consumeBuffer(Action.B)
        input.consumeBuffer(Action.Down)
        this.startDive()
      }
    }

    if (this.airborne) {
      this.rvy -= RECEIVER_G * dt
      this.ry += this.rvy * dt
      if (this.ry <= 0) {
        this.ry = 0
        this.rvy = 0
        this.airborne = false
        this.emitScuff(7, 1)
      }
    }

    this.rx += this.rvx * dt
    this.rz += this.rvz * dt
    this.rx = clamp(this.rx, -34, 34)
    // He is not allowed to swim.
    this.rz = clamp(this.rz, 2, RIVER_Z0 - 1.5)

    const speed = Math.hypot(this.rvx, this.rvz)
    this.runPhase += speed * 1.55 * dt
  }

  private startDive(): void {
    const speed = Math.hypot(this.rvx, this.rvz)
    // Dive toward where the disc is, biased by the run already underway.
    let dx = this.disc.x - this.rx
    let dz = this.disc.z - this.rz
    const d = Math.hypot(dx, dz) || 1
    dx /= d
    dz /= d
    if (speed > 1) {
      dx = dx * 0.55 + (this.rvx / speed) * 0.45
      dz = dz * 0.55 + (this.rvz / speed) * 0.45
      const n = Math.hypot(dx, dz) || 1
      dx /= n
      dz /= n
    }
    this.diveDirX = dx
    this.diveDirZ = dz
    this.diveTimer = DIVE_TIME
    this.rvx = dx * DIVE_PUSH
    this.rvz = dz * DIVE_PUSH
    this.rvy = 2.1
    this.ry = 0.05
    this.ctx.perf.markResponse(this.ctx.input.lastRawPressTime)
    this.ctx.audio.noise({ duration: 0.3, cutoff: 2600, toCutoff: 300, gain: 0.14 })
    this.emitScuff(9, 1.2)
  }

  /**
   * Kick grass up at the receiver's feet. Emitted in screen space because the
   * particle pool is a screen-space system and the camera barely moves during
   * the fraction of a second these live for.
   */
  private emitScuff(count: number, force: number): void {
    const field = this.field
    field.project(this.rx, 0, this.rz)
    if (!field.pVisible) return
    const px = field.px
    const py = field.py
    const s = field.ps
    const rng = this.ctx.rng
    this.scuff.burst(count, () => ({
      x: px + rng.spread(0.35 * s),
      y: py + rng.spread(0.08 * s),
      vx: rng.spread(1.9 * s * force) - this.rvx * s * 0.08,
      vy: -rng.range(0.4, 2.1) * s * force * 0.5,
      life: rng.range(0.3, 0.72),
      size: rng.range(0.035, 0.1) * s,
      sizeEnd: rng.range(0.01, 0.04) * s,
      color: grade(this.pal.near, { valScale: rng.range(0.8, 1.25), satScale: 1.1 }),
      alpha: 0.75,
      gravity: 3.4 * s,
      drag: 0.32,
      rotation: rng.range(0, 6.28),
      spin: rng.spread(9),
    }))
  }

  /**
   * Catch test.
   *
   * The catchable volume is an ellipsoid centred on the hands, and its size is
   * read off the rig rather than hard-coded — so a jump really does add the
   * height it looks like it adds, and a dive really does add the reach. That
   * keeps what the player sees and what the simulation does in agreement.
   */
  private tryCatch(): boolean {
    const dive = this.diveTimer > 0 ? clamp01(this.diveTimer / (DIVE_TIME * 0.7)) : 0
    const reachUp = this.airborne || this.disc.y > 1.9 ? 1 : 0
    this.receiver.setPose({ dive, reach: reachUp, airborne: this.airborne ? 1 : 0 })

    // The hands go wherever the disc is, inside what the body can actually
    // reach — so vertical failure means the disc was genuinely over his head or
    // under his feet, not that he happened to be posed wrong on that frame.
    const low = this.ry + lerp(0.34, 0.06, dive)
    const high = this.ry + this.receiver.reachHeight()
    const handY = clamp(this.disc.y, low, high)
    const forward = this.receiver.reachForward()

    // Centre of the catch volume: at the hands, pushed out along the dive.
    const cx = this.rx + this.diveDirX * forward * 0.72 * dive
    const cz = this.rz + this.diveDirZ * forward * 0.72 * dive

    const hx = 0.7 + dive * 1.1
    const hz = 0.82 + dive * 1.3
    const hy = 0.42 + reachUp * 0.12

    const nx = (this.disc.x - cx) / hx
    const ny = (this.disc.y - handY) / hy
    const nz = (this.disc.z - cz) / hz
    if (nx * nx + ny * ny + nz * nz > 1) return false

    // Two gates that stop the receiver plucking a throw out of the air on its
    // way up. A flat huck passes over his head at chest height fifteen metres
    // out doing ninety kilometres an hour; nobody catches that, and letting him
    // would make the whole second phase skippable.
    if (this.disc.vy > 0.6) return false
    if (this.disc.groundSpeed > 26) return false

    let kind: CatchKind
    if (dive > 0.2) kind = 'diving'
    else if (this.airborne) kind = 'leaping'
    else if (Math.abs(this.disc.x - this.rx) < 0.42 && Math.abs(this.rvx) < 3.2) kind = 'clean'
    else kind = 'scrambling'
    this.finishThrow(kind)
    return true
  }

  private finishThrow(kind: CatchKind): void {
    this.catchKind = kind
    this.disc.flying = false
    this.lastDistance = this.distance
    this.phase = 'result'
    this.phaseTime = 0
    this.resultTimer = 1

    const caught = kind !== 'dropped'
    const mult = kind === 'diving' ? 1.6
      : kind === 'leaping' ? 1.35
      : kind === 'clean' ? 1.15
      : kind === 'scrambling' ? 1 : 0.2
    // Distance is the base, style is the multiplier, and a long throw pays a
    // bonus on top so hucking is worth the risk of not getting there.
    const base = this.distance * 9 + Math.max(0, this.distance - 40) * 6
    const points = Math.round(base * mult)
    this.score += points

    const inRiver = kind === 'dropped' && this.disc.z >= RIVER_Z0
    this.resultTitle = kind === 'diving' ? 'LAYOUT CATCH'
      : kind === 'leaping' ? 'SKY CATCH'
      : kind === 'clean' ? 'CLEAN CATCH'
      : kind === 'scrambling' ? 'CAUGHT'
      : inRiver ? 'IN THE RIVER'
      : 'DROPPED'
    this.resultSub = `${this.distance.toFixed(0)} M  ·  +${points}`
    this.throwLog.push({ distance: this.distance, points, kind: this.resultTitle })
    // Not the athletes' pink: that hue is reserved for the player.
    this.resultTint = caught ? Core.paperWhite : mix(Core.sunGold, 0xe4572e, 0.65)

    if (caught) {
      this.receiver.setPose({ hold: 1 })
      this.ctx.audio.noise({ duration: 0.08, cutoff: 5200, toCutoff: 1200, gain: 0.26, q: 1.4 })
      this.ctx.audio.tone({ freq: 520, toFreq: 840, duration: 0.14, type: 'triangle', gain: 0.14 })
      if (kind === 'diving' || kind === 'leaping') {
        this.ctx.audio.tone({ freq: 700, toFreq: 1180, duration: 0.2, type: 'sine', gain: 0.1, delay: 0.09 })
      }
    } else if (inRiver) {
      // A plop, then the ring of water closing over a 175g disc.
      this.ctx.audio.noise({ duration: 0.09, cutoff: 900, toCutoff: 2600, gain: 0.2 })
      this.ctx.audio.tone({ freq: 240, toFreq: 620, duration: 0.14, type: 'sine', gain: 0.1 })
      this.ctx.audio.noise({ duration: 0.5, cutoff: 3000, toCutoff: 300, gain: 0.08, delay: 0.06 })
    } else {
      this.ctx.audio.noise({ duration: 0.34, cutoff: 760, toCutoff: 140, gain: 0.18 })
      this.ctx.audio.tone({ freq: 170, toFreq: 80, duration: 0.3, type: 'sawtooth', gain: 0.08 })
    }
  }

  private updateResult(dt: number): void {
    this.resultTimer = Math.max(0, this.resultTimer - dt / 2.1)
    // Let the receiver settle rather than freezing him mid-stride.
    this.rvx = damp(this.rvx, 0, 0.02, dt)
    this.rvz = damp(this.rvz, 0, 0.02, dt)
    this.rx += this.rvx * dt
    this.rz += this.rvz * dt
    if (this.diveTimer > 0) this.diveTimer = Math.max(0, this.diveTimer - dt)
    if (this.airborne) {
      this.rvy -= RECEIVER_G * dt
      this.ry = Math.max(0, this.ry + this.rvy * dt)
      if (this.ry === 0) this.airborne = false
    }
    this.runPhase += Math.hypot(this.rvx, this.rvz) * 1.55 * dt

    if (this.resultTimer <= 0) {
      this.receiver.setPose({ hold: 0 })
      if (this.throwIndex >= THROWS) {
        this.phase = 'done'
        this.phaseTime = 0
        this.hud.setEnd(this.score, this.throwLog)
        // The shared results screen. `hud.setEnd` still runs because `endCardUp`
        // in `debug()` is what the capture gate reads for a finished run.
        const caught = this.throwLog.filter((t) => t.points > 0).length
        const far = Math.max(0, ...this.throwLog.map((t) => t.distance))
        this.results.setTitle('FLYING DISC  \u00b7  3 THROWS')
        this.results.show(ratingFor(this.score, RESULT_PAR), this.score)
        this.results.meters[0].set(clamp01(far / 120))
        this.results.meters[1].set(clamp01(this.score / RESULT_PAR))
        this.results.meters[2].set(clamp01(caught / THROWS))
        this.results.meters[3].set(clamp01(this.score / (RESULT_PAR * 1.2)))
        this.results.setVisible(true)
      } else {
        this.throwIndex++
        this.rollWind()
        this.resetThrow()
      }
    }
  }

  /**
   * The run is over: play it again, or leave.
   *
   * ENTER is the shared restart the other five events take — `endPrompt` says
   * so on the card — and A is kept alongside it because A is the key this
   * event has used for every decision in the run and a player's hand is
   * already on it. ESC is handled once for the whole scene in `update`.
   */
  private updateDone(): void {
    const input = this.ctx.input
    if (this.phaseTime <= 0.8) return
    const again = input.buffered(Action.A, 8) || input.justPressed(Action.Start)
    if (!again) return
    input.consumeBuffer(Action.A)
    this.ctx.perf.markResponse(input.lastRawPressTime)
    this.restartRun()
  }

  /** Back to throw one with a clean slate. Also the card's ENTER. */
  private restartRun(): void {
    this.throwIndex = 1
    this.score = 0
    this.throwLog.length = 0
    this.hud.hideEnd()
    this.rollWind()
    this.resetThrow()
  }

  /**
   * Camera. It dollies downfield behind the disc so the receiver never shrinks
   * to a speck, but the dolly is capped — past a point the overhead strip is a
   * better instrument than moving the camera, and holding the composition still
   * is what keeps the frame recognisable as the original's.
   */
  private updateCamera(dt: number): void {
    const field = this.field
    if (this.phase === 'flight' || this.phase === 'result') {
      this.camZTarget = clamp(this.disc.z - CAM_TRAIL, 0, CAM_MAX_Z)
      // Measured from the THROW LINE, not from the world origin. Absolute x
      // put camX at -3.6 the moment the throw line moved, which panned the
      // camera straight back onto the thrower and undid the separation between
      // him and his disc that the staging exists to create.
      this.camXTarget = clamp(
        ((this.rx - THROWER_X) + (this.disc.x - THROWER_X)) * 0.26, -6, 6,
      )
    } else {
      this.camZTarget = 0
      this.camXTarget = 0
    }

    /*
     * Keep the hero inside the frame.
     *
     * The camera dollies downfield behind the disc, which means it passes the
     * throw line and the thrower's own pixels-per-metre goes UP as he falls
     * behind the lens — he gets bigger and further from centre at the same
     * time. With the throw line out at -5.4 m (where it was moved to separate
     * him from the receiver) that walked him off the left edge: a review of the
     * frame found his trailing arm and the left eighth of his body cropped.
     *
     * Rather than give the lateral offset back and re-open the separation this
     * staging exists to create, the camera is given a framing constraint, which
     * is what an operator would do: pan left far enough that his silhouette —
     * root, plus HERO_REACH metres of trailing arm at the rig's own capped
     * scale — clears the edge.
     *
     *   px = CENTRE_X + (THROWER_X - camX) * ps  >=  safeLeft
     *   camX <= THROWER_X + (CENTRE_X - safeLeft) / ps
     *
     * It costs nothing while he is small (the bound is slack at the throw
     * line) and takes over exactly when the dolly would have cropped him.
     *
     * TWO THINGS MADE IT FAIL ON THE SECOND THROW, and both are fixed here.
     *
     *   1. `HERO_REACH` was a guess. It is measured now — see `heroReachM` —
     *      from the rig's own bounds in the pose that is on screen, so it is
     *      right for a wind-up, a release and a follow-through rather than for
     *      whichever one happened to be captured.
     *
     *   2. The bound was applied to the TARGET and the camera only damped
     *      toward it. `camZ` rises through the flight, which raises `ps`, which
     *      lowers the bound — so the constraint moves toward the camera while
     *      the camera is still chasing a target set against an older, looser
     *      value. On a long throw that lag is most of a second, which is
     *      exactly the window the capture driver now shoots in (it waits two
     *      seconds after release on throw 3 or later). The bound is applied to
     *      the camera's actual x as well, AFTER `camZ` has been advanced, so it
     *      is a hard constraint at the instant it is evaluated rather than an
     *      aspiration.
     */
    const psTarget = field.scaleAt(THROWER_Z)
    if (psTarget > 0) {
      this.camXTarget = clamp(Math.min(this.camXTarget, this.camXLimit(psTarget)), -6, 6)
    }
    field.camZ = damp(field.camZ, this.camZTarget, 0.06, dt)
    field.camX = damp(field.camX, this.camXTarget, 0.25, dt)
    const ps = field.scaleAt(THROWER_Z)
    if (ps > 0) field.camX = clamp(Math.min(field.camX, this.camXLimit(ps)), -6, 6)

    // Tilt: look up far enough to keep the disc clear of the overhead strip,
    // but never so far that the receiver slides behind the bottom HUD band.
    // Two constraints, and the tighter one wins.
    let pitch = 0
    if (this.disc.flying) {
      const s = field.scaleAt(this.disc.z)
      const level = HORIZON_Y + (CAM_H - this.disc.y) * s
      const want = clamp(DISC_HEADROOM - level, 0, CAM_PITCH_MAX)
      const room = Math.max(0, RECEIVER_FLOOR - field.groundYLevel(this.rz))
      pitch = Math.min(want, room)
    }
    field.camPitch = damp(field.camPitch, pitch, 0.1, dt)
  }

  /**
   * The largest camX at which the thrower's silhouette still clears the left
   * edge, given the field scale at his depth.
   *
   *   px = CENTRE_X + (THROWER_X - camX) * ps  >=  SAFE_EDGE + reachPx
   */
  private camXLimit(ps: number): number {
    const rigScale = Math.min(ps * THROWER_HERO, HERO_SCALE_MAX)
    return THROWER_X + (CENTRE_X - (SAFE_EDGE + this.heroReachM * rigScale)) / ps
  }

  private updateAudio(): void {
    const windSpeed = Math.hypot(this.windX, this.windZ)
    this.windBed?.setGain(0.022 + windSpeed * 0.013)
    this.windBed?.setCutoff(260 + windSpeed * 130)

    if (this.disc.flying) {
      const v = this.disc.speed
      // Near and fast is loud; far and slow is a whisper. The whirr is also the
      // player's audio cue that the disc is still in the air behind them.
      const near = clamp01(1 - (this.disc.z - this.field.camZ) / 70)
      this.whirr?.setGain(0.0001 + clamp01(v / 30) * near * 0.06)
      this.whirr?.setCutoff(500 + v * 42)
    } else {
      this.whirr?.setGain(0.0001)
    }
  }

  // ------------------------------------------------------------------ render
  render(alpha: number): void {
    const camH = CAM_H
    const field = this.field
    const aimPhase = this.phase === 'ready' || this.phase === 'angle' || this.phase === 'power'
    field.apply()

    // --- thrower -------------------------------------------------------------
    // A wind-up that starts behind the body and sweeps through: throwSwing goes
    // -1 to +1 across the release beat, and the disc leaves at about a third.
    const throwing = this.phase === 'release'
    const swing = throwing ? clamp(this.phaseTime / 0.42, 0, 1) * 2 - 1 : aimPhase ? -0.62 : 1
    field.project(THROWER_X, 0, THROWER_Z)
    this.thrower.container.visible = field.pVisible
    this.thrower.shadow.visible = field.pVisible
    // The lit pocket he stands in. Driven off the same projected feet and the
    // same capped hero scale as his cast shadow, so the light, the man and the
    // shadow he throws are one piece of staging at every camera tilt. See
    // `KEY_POOL` in Field.ts.
    const heroFootY = field.py - HERO_LIFT
    field.applyLightPool(
      field.px, heroFootY, Math.min(field.ps * THROWER_HERO, HERO_SCALE_MAX), field.pVisible,
    )
    if (field.pVisible) {
      this.thrower.container.position.set(field.px, heroFootY)
      this.thrower.setWorldScale(Math.min(field.ps * THROWER_HERO, HERO_SCALE_MAX))
      this.thrower.setPose({
        runPhase: 0, runAmount: 0,
        // A slow settle on the back foot while the gauges run, so the thrower
        // is loading up rather than standing frozen.
        crouch: throwing ? 0.28 * (1 - Math.abs(swing))
          : 0.12 + Math.sin(this.promptPulse * 1.5) * 0.045,
        airborne: 0, dive: 0, reach: 0,
        hold: this.disc.flying || this.phase === 'result' || this.phase === 'done' ? 0 : 1,
        // Three-quarter, not side-on: we are standing behind his right shoulder
        // and he is throwing away from us, so a full profile reads as a throw
        // across the screen rather than down the field.
        facing: 0.55,
        throwSwing: swing,
      })
      this.thrower.apply()
      // Measure what was just posed, for next frame's framing constraint. The
      // local bounds are the whole silhouette — trailing arm, disc in hand,
      // outline widths — and `container.scale.x` carries both the rig scale and
      // the three-quarter profile squash, so dividing the two back out gives
      // the reach in metres at the rig's own scale. A guessed constant was
      // right for one pose and cropped him on the next throw.
      //
      // The sign of `scale.x` is the rig's facing. It is positive for this
      // pose, but reading the correct edge rather than assuming it costs
      // nothing and stops the constraint inverting if the staging ever flips.
      const lb = this.thrower.container.getLocalBounds()
      const sx = this.thrower.container.scale.x
      const rigScale = Math.min(field.ps * THROWER_HERO, HERO_SCALE_MAX)
      const leftPx = (sx >= 0 ? -lb.x : lb.x + lb.width) * Math.abs(sx)
      this.heroReachM = rigScale > 0
        ? clamp(leftPx / rigScale, HERO_REACH, HERO_MEASURE_CAP)
        : HERO_REACH
      this.thrower.applyShadow(field.px, heroFootY, Math.min(field.ps * THROWER_HERO, HERO_SCALE_MAX), 0)
      // The drawn flight path starts at the hand the viewer can see, not at
      // the simulation's release point — the two are a metre and a half apart
      // on screen because the hero is drawn over life size. See
      // `Disc.setHandAnchor`.
      this.thrower.throwHandAt(this.handAnchor)
      this.disc.setHandAnchor(this.handAnchor.x, this.handAnchor.y)
    } else {
      this.disc.clearHandAnchor()
    }

    // --- receiver ------------------------------------------------------------
    const rx = lerp(this.prevRx, this.rx, alpha)
    const rz = lerp(this.prevRz, this.rz, alpha)
    const ry = lerp(this.prevRy, this.ry, alpha)
    field.project(rx, ry, rz)
    this.receiver.container.visible = field.pVisible
    this.receiver.shadow.visible = field.pVisible
    if (field.pVisible) {
      const dive = this.diveTimer > 0 ? clamp01(this.diveTimer / (DIVE_TIME * 0.7)) : 0
      const recover = this.recoverTimer > 0 ? clamp01(this.recoverTimer / DIVE_RECOVER) : 0
      const speed = Math.hypot(this.rvx, this.rvz)
      this.receiver.container.position.set(field.px, field.py)
      this.receiver.setWorldScale(field.ps)
      this.receiver.setPose({
        runPhase: this.runPhase,
        runAmount: aimPhase ? 0.16 : clamp01(speed / RUN_SPEED) * (1 - dive) * (1 - recover),
        crouch: recover * 0.8 + (this.airborne ? 0 : clamp01(-this.rvy / 6)),
        airborne: this.airborne ? 1 : 0,
        dive,
        reach: this.phase === 'flight' && (this.airborne || this.disc.y > 1.9) ? 1 : 0,
        hold: this.catchKind !== 'none' && this.catchKind !== 'dropped' && this.phase !== 'flight' ? 1 : 0,
        facing: clamp(this.rvx / 4.5, -1, 1),
        throwSwing: 0,
      })
      this.receiver.apply()
      // The shadow stays on the grass while he is in the air, which is the only
      // thing that tells you how high a 70 px figure actually got.
      field.project(rx, 0, rz)
      this.receiver.applyShadow(field.px, field.py, field.ps, ry)
    }

    // --- disc ----------------------------------------------------------------
    // Once it is caught the disc is in the receiver's hands (his rig draws it),
    // so the flying disc goes away. A dropped one stays where it came down.
    const discLive = this.disc.flying || this.phase === 'flight'
      || (this.phase === 'result' && this.catchKind === 'dropped')
    this.disc.container.visible = discLive
    this.disc.arc.visible = discLive
    this.disc.shadow.visible = discLive
    if (discLive) this.disc.apply(alpha, field, camH)

    this.renderHud(aimPhase)
  }

  private renderHud(aimPhase: boolean): void {
    const hud = this.hud

    // The throw meter is docked top-right, on the grid, mirroring the tracking
    // strip. It used to hang in the world beside the thrower — the original's
    // staging — but that parks an opaque plate on the playfield during the only
    // phase where the player is reading the field.
    hud.setMeter(aimPhase || this.phase === 'release')

    hud.setAngleGauge(
      this.angleLocked ? this.lockedAngle : this.angleT,
      this.angleLocked, this.phase === 'angle', this.angleDeg,
    )
    hud.setSpeedGauge(
      this.powerLocked ? this.lockedSpeed : this.powerT,
      this.powerLocked, this.phase === 'power', this.speedValue,
    )
    hud.setWind(this.windX, this.windZ)
    hud.setThrow(this.throwIndex, THROWS)
    hud.setScore(this.score)

    hud.setStrip(
      THROWER_X, THROWER_Z,
      this.rx, this.rz,
      this.disc.x, this.disc.y, this.disc.z, this.disc.flying,
      this.landing[0], this.landing[1], this.landingValid && this.disc.flying,
      this.phase === 'result' ? this.lastDistance : this.disc.flying ? this.distance : 0,
    )

    const pulse = 0.62 + 0.38 * Math.sin(this.promptPulse * 3.4)
    // "START", not "SET": both gauges are ping-pong timing bars — `sweep()`
    // reverses at each end and the player taps to stop the needle — so the
    // first press does not choose a value, it starts the needle moving. The
    // next two prompts already say LOCK; this one used to say SET, which
    // promised a control the throw does not have.
    if (this.phase === 'ready') hud.setPrompt('A  ·  START ANGLE', pulse)
    else if (this.phase === 'angle') hud.setPrompt('A  ·  LOCK ANGLE', 1)
    else if (this.phase === 'power') hud.setPrompt('A  ·  LOCK SPEED', 1)
    else if (this.phase === 'flight') {
      // Short enough to sit inside the rail's centre plate, which is three
      // columns wide like every other plate on the grid.
      hud.setPrompt('← →  RUN · A JUMP · B DIVE', clamp01(1.6 - this.phaseTime) * 0.8)
    }
    // Nothing on the bar once the run is over: the card carries both keys,
    // and a caption reading A · THROW AGAIN under a card that says ENTER
    // THROW AGAIN is the legend and the end prompt on screen at once.
    else hud.setPrompt('', 0)

    if (this.phase === 'result') {
      hud.setResult(this.resultTitle, this.resultSub, this.resultTimer, this.resultTint)
    } else if (this.phase === 'done') {
      // The per-throw banner is retired by the card that replaces it.
      hud.setResult('', '', 1, Core.paperWhite)
      hud.setEndFade(smoothstep(0, 0.45, this.phaseTime))
    } else if (aimPhase) {
      hud.setResult('', '', 1, Core.paperWhite)
    }
  }

  resize(width: number, height: number): void {
    this.sky.resize(width, height)
  }

  exit(): void {
    const cg = (window as unknown as Record<string, unknown>).__cg as
      Record<string, unknown> | undefined
    if (cg) delete cg.discEnd
    this.windBed?.stop(0.3)
    this.whirr?.stop(0.15)
    this.windBed = null
    this.whirr = null
    this.disc.trail.clear()
    this.disc.clearArc()
    this.scuff.clear()
  }

  /**
   * Simulation state for automated review. Everything a critic needs to drive
   * the event from outside and assert on what it actually did, rather than
   * inferring it from pixels.
   */
  debug(): Record<string, unknown> {
    const r2 = (v: number): number => Math.round(v * 100) / 100
    return {
      phase: this.phase,
      // Seconds spent in the current phase. The capture gate needs this: the
      // receive prompt fades over `clamp01(1.6 - phaseTime)`, and gating that
      // on a wall-clock delay is wrong under software rendering, where the
      // simulation advances far slower than the clock.
      phaseTime: Math.round(this.phaseTime * 100) / 100,
      throwIndex: this.throwIndex,
      throws: THROWS,
      score: this.score,
      // The run-end card: up, and readable. A capture gate needs the second
      // half — it fades in over 0.45s of simulation time, and under software
      // rendering a wall-clock wait is not the same thing.
      endCardUp: this.phase === 'done' && this.phaseTime >= 0.45,
      throwLog: this.throwLog.map((t) => `${t.distance.toFixed(0)}m/+${t.points}/${t.kind}`),
      angleGauge: r2(this.angleT),
      powerGauge: r2(this.powerT),
      angleLocked: this.angleLocked,
      powerLocked: this.powerLocked,
      lockedAngleDeg: this.angleLocked ? r2(this.angleDeg) : null,
      lockedSpeed: this.powerLocked ? r2(this.speedValue) : null,
      windX: r2(this.windX),
      windZ: r2(this.windZ),
      disc: {
        x: r2(this.disc.x), y: r2(this.disc.y), z: r2(this.disc.z),
        vx: r2(this.disc.vx), vy: r2(this.disc.vy), vz: r2(this.disc.vz),
        bankDeg: r2((this.disc.bank * 180) / Math.PI),
        spin: r2(this.disc.omega),
        flying: this.disc.flying,
      },
      receiver: {
        x: r2(this.rx), z: r2(this.rz), y: r2(this.ry),
        vx: r2(this.rvx), vz: r2(this.rvz),
        airborne: this.airborne,
        diving: this.diveTimer > 0,
      },
      predictedLanding: this.landingValid ? { x: r2(this.landing[0]), z: r2(this.landing[1]) } : null,
      distance: r2(this.distance),
      lastDistance: r2(this.lastDistance),
      catchResult: this.catchKind,
      camZ: r2(this.field.camZ),
      camX: r2(this.field.camX),
    }
  }
}
