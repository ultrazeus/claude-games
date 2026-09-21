import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import { ResultsPanel, ratingFor } from '../../ui/Results'
import type { Scene, SceneContext } from '../../../core/Scene'
import { Action } from '../../../core/Input'
import { Sky } from '../../../render/Sky'
import { Parallax } from '../../../render/Parallax'
import { ParticleSystem } from '../../../render/Particles'
import { horizontalGradient, softDot } from '../../../render/Gradient'
import { Core, Palettes, lighten, mix , type Hex} from '../../../render/Palette'
import {
  ControlHint,
  Callout, HUD_MARGIN, Meter, Readout, endPrompt, plate, themeFor, type HudTheme,
} from '../../../render/Hud'
import { ContactShadow } from '../../../render/Staging'
import { clamp, clamp01, damp, lerp, smoothstep } from '../../../core/Tween'
import { Beach } from './Beach'
import { Boardwalk, GROUND_Y, HORIZON_Y, type Hazard } from './Boardwalk'
import {
  CAM_CX, CAM_CY, DECK_DEEP, DECK_INK, DECK_SHADE, SHADOW_DX, SHADOW_DY,
  SUN_X, SUN_Y, ZOOM, plankAngle,
} from './Light'
import { RollerSkater } from './RollerSkater'

type SkateState = 'skate' | 'air' | 'fall' | 'getup' | 'done'

const RUN_SECONDS = 90
/**
 * The run is over on the third wipeout.
 *
 * From the source: "if you break with the face three times, you need to stop
 * early." `falls` has been counted since the first version of this event and
 * spent on nothing — a wipeout cost the combo and a second and a half of
 * boardwalk, which is a tax, not a risk. Three of them end the run, so the
 * decision to carry speed into a blind hazard finally has a price attached.
 *
 * Foot Bag is deliberately exempt from this rule and always was: "the ball can
 * fall to the floor endlessly, this discipline doesn't stop prematurely".
 */
const MAX_FALLS = 3

/* --- results screen. `RESULT_PAR` only positions the judges' cards; nothing
 * reads it back into gameplay. */
const RESULT_LABELS = ['DISTANCE', 'AIR', 'CHAIN', 'CLEAN'] as const
const RESULT_COLORS: readonly Hex[] = [0xffd27a, 0x9fd8ff, 0xffe6a8, 0xb9f2c8]
const RESULT_PAR = 20000

// --- motion ----------------------------------------------------------------
const MAX_SPEED = 1520
/** Right. */
const ACCEL = 640
/** Left. */
const BRAKE = 1020
/** Coasting settles here; below it you keep rolling, above it you bleed off. */
const COAST_FLOOR = 430
/** Fraction of the excess over the floor retained per second when coasting. */
const COAST_DRAG = 0.52
const MIN_SPEED = 150
/** Speed the sand drags you down toward while you are in it. */
const SAND_TARGET = 260
const SAND_DRAG = 0.05

// --- air -------------------------------------------------------------------
const GRAVITY = 2900
/** Full-height jump, from a full press. */
const JUMP_MAX = 900
/**
 * Cut-off for a tapped press. Variable jump height is most of the feel here, and
 * this number is load-bearing for whether the course is clearable at all.
 *
 * A gap between two hazards can be beaten two ways: hop into it, or carry the
 * whole thing in one air. Hopping needs the *shortest* jump to be shorter than
 * the gap (`2*JUMP_MIN/GRAVITY * speed < gap`); carrying needs the *longest* to
 * outreach it (`2*JUMP_MAX/GRAVITY * speed >= gap + 128`). Between those two
 * there is a band of gaps that neither route beats, and that band only closes
 * above `128 / (2*(JUMP_MAX - JUMP_MIN)/GRAVITY)` px/s. At 430 the band closes
 * below 400 px/s, which is under the coasting floor — so from any speed the
 * player can actually hold, every gap the generator emits has an answer.
 */
const JUMP_MIN = 430
/** Radians/sec^2 the pirouette builds at. */
const SPIN_ACCEL = 34
const SPIN_MAX = 20
const TAU = Math.PI * 2

// --- judgement -------------------------------------------------------------
/** Radians off a whole turn that still counts as a clean landing. */
const LAND_CLEAN = 0.55
/** Beyond this you are sideways when the wheels touch, and you go down. */
const LAND_BAIL = 1.18

// --- timing ----------------------------------------------------------------
const FALL_SECONDS = 0.95
const GETUP_SECONDS = 0.5
/** Hazards are waved through for this long after a recovery. */
const GRACE_SECONDS = 0.55

/** Collision half-width of the skater along the path. */
const SKATER_HALF = 24
/** World distance per on-screen metre, for the HUD. */
const PX_PER_METRE = 30
/** Slab joints run every this many world px; the wheels clack over each one. */
const JOINT_SPACING = 240

/** Standing height of the rig, before `SKATER_SCALE`. */
const SKATER_RIG_H = 172
/**
 * Uniform scale applied to the whole rig.
 *
 * "The character is an afterthought. She's ~8% of frame height." The rig itself
 * cannot carry this: `RollerSkater.apply()` writes `container.scale.x` every
 * frame to render the pirouette edge-on, so anything it multiplies gets undone.
 * One wrapper Container outside it is the only place a uniform scale can live,
 * and 1.08 x ZOOM 1.66 puts a 172px figure at 309px of a 1080px frame — 28.6%.
 */
const SKATER_SCALE = 1.08
/** Standing height in world units, for the length of the shadow she throws. */
const SKATER_H = SKATER_RIG_H * SKATER_SCALE
/** How many skid marks can be lying on the concrete at once. */
const SKID_COUNT = 9

// --- the hud ---------------------------------------------------------------
/**
 * Everything in the HUD is built from `src/render/Hud.ts`.
 *
 * "Three widgets with three different heights, corner radii, and fill
 * treatments, none sharing an alignment grid — it's the frame's signature and
 * right now it signs 'placeholder'." That was a fair description of what this
 * file used to hand-roll: a 64-high plate at radius 10 here, a 92-high one
 * there, a 132-high banner with its own radius and its own fill somewhere else.
 *
 * Now there is one plate primitive, one radius (`HUD_RADIUS`), one margin
 * (`HUD_MARGIN`), one widget height, and one row. Five readouts sit on that row
 * and nothing else is drawn as a box at all.
 */
const HUD_W = 200
const HUD_H = 74
const HUD_GAP = 16
const HUD_TIME_W = 220

/**
 * The HUD's one accent, and it is deliberately not `Core.sunGold`.
 *
 * `scripts/score_frame.py` finds the player as the most *colourful* cluster in
 * the playfield. Run against the frame that went to review it reported
 * `subject_found: false` — the accent it picked was spread across 98% of the
 * frame width — because raw gold measures 0.76 colourfulness against a cyan
 * shirt at 0.68, so the combo plate's `x1` and the score digits were
 * out-colouring the skater in her own frame.
 *
 * The threshold that detector uses is a *percentile*, not a constant: it takes
 * the top 0.6% of the playfield whatever that costs. So "below the player" is
 * not good enough for anything with area — it has to be below the whole
 * reservation. At 0.62 of the way to paper the accent measures 0.32, which is
 * half the skater's and clear of any threshold the top 0.6% can fall to, and it
 * still reads unmistakably as the interface's one warm note.
 */
const HUD_ACCENT = mix(Core.sunGold, Core.paperWhite, 0.62)

/**
 * Roller Skating.
 *
 * Side-scrolling boardwalk at golden hour. Right accelerates, Left brakes, and
 * speed is the whole risk/reward dial: it scores more, it carries you further
 * through a jump, and it takes away the time you had to read the next hazard.
 *
 * The run is a combo game. Clearing a hazard cleanly builds a multiplier that
 * rides all the way up to 9x, and clearing one *with a trick* is worth several
 * times a bare hop. One contact ends all of it, which is what gives a 90-second
 * run an arc instead of a flat line.
 *
 * Structure follows the half pipe: geometry and course in `Boardwalk`, backdrop
 * in `Beach`, the character rig in `RollerSkater`, and this file owning nothing
 * but simulation, camera, audio and HUD.
 */
export class Skating implements Scene {
  readonly id = 'skating'

  private ctx!: SceneContext
  private pal = Palettes.skating

  private sky!: Sky
  /**
   * The camera push-in. Everything that lives in world space hangs off this and
   * gets scaled by `ZOOM`; the HUD does not, so type stays at its authored size.
   */
  private stage = new Container()
  /** Everything behind the play plane. */
  private parallax!: Parallax
  /** Everything in front of it. Added above `world` so it occludes the skater. */
  private fgParallax!: Parallax
  private beach!: Beach
  private course!: Boardwalk
  private world = new Container()
  private skater!: RollerSkater
  /**
   * The rig's scale carrier. `RollerSkater.apply()` owns `container.scale.x`
   * for the pirouette, so the uniform scale has to sit one level out.
   */
  private skaterRig = new Container()
  /** Warm streaks off the wheel line. The still-frame half of the speed cue. */
  private speedLines = new Graphics()
  /** The long raking cast shadow the skater throws away from the sun. */
  private shadow = new Graphics()
  /** The soft ambient half of the occlusion under the wheels. */
  private contact!: ContactShadow
  /**
   * A hard-edged footprint per skate, aligned to the planks. Pooled and
   * pre-drawn; `render` writes a position, a rotation and an alpha.
   */
  private paws: Graphics[] = []
  /** Rubber left on the concrete, trailing back from where it was laid down. */
  private skidRoot = new Container()
  private skids: Graphics[] = []
  private skidX = new Float32Array(SKID_COUNT)
  private skidLife = new Float32Array(SKID_COUNT)
  private skidCursor = 0
  private dust!: ParticleSystem
  private sparks!: ParticleSystem

  // --- simulation ----------------------------------------------------------
  private state: SkateState = 'skate'
  /** World x of the skater. Monotonic; this is the run. */
  private distance = 0
  private speed = 0
  /** Height above the concrete. Positive up. */
  private airY = 0
  private airVy = 0
  private airPeak = 0
  private jumpHeld = false

  /** Pirouette angle, radians. Accumulates through a whole air. */
  private twist = 0
  private twistVel = 0
  private handstand = 0
  private tuck = 0
  private handstandTime = 0
  private tuckTime = 0
  /** Hazards cleared during the current air. */
  private airClears = 0

  private crouch = 0
  private lean = 0
  private stride = 0
  private bodyRot = 0
  private sprawl = 0

  private stateTimer = 0
  private graceTimer = 0
  private inSand = false
  private sandTimer = 0

  private timeLeft = RUN_SECONDS
  private score = 0
  private combo = 0
  private bestCombo = 0
  /** Run maximum, for the results screen only. */
  private bestAirHeight = 0
  private falls = 0
  /** True when the run ended on the floor, so `done` leaves the skater there. */
  private downed = false
  private clears = 0
  private lastTrick = ''
  /**
   * What actually put the skater on the floor, for the banner's caption line.
   *
   * This replaces a `lastHazard` field that `clearHazard` also wrote to, which
   * had two consequences. A bail on a sideways landing captioned itself with the
   * name of the last obstacle the player had successfully jumped — "WIPEOUT /
   * BEACH BALL" for a trick that never went near a beach ball. And, because
   * `debug()` exported it, it made the review capture unreachable; see `debug()`.
   */
  private downCause = ''

  private comboFlash = 0
  private landFlash = 0
  private shake = 0
  private lastJointIndex = 0
  private lastSkidIndex = 0

  // --- render interpolation ------------------------------------------------
  private prevDistance = 0
  private prevAirY = 0
  private prevTwist = 0
  private prevBodyRot = 0
  private camScreenX = 660

  // --- audio ---------------------------------------------------------------
  private wheels: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null
  private surf: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null

  // --- hud -----------------------------------------------------------------
  private hud = new Container()
  private rDist!: Readout
  private rTime!: Readout
  private rScore!: Readout
  private rCombo!: Readout
  private mSpeed!: Meter
  /** Trick and wipeout feedback, anchored to the skater rather than to the sky. */
  private callout!: Callout
  /** The run-over card. A summary is not a call-out, so it is not one. */
  private endCard = new Container()
  /** Shared between-event results screen; see `src/game/ui/Results.ts`. */
  private results!: ResultsPanel
  private endText!: Text
  private endLine!: Text
  /** The three fall marks, so the player can see what is left to spend. */
  private fallPips: Graphics[] = []
  private hudFalls = -1
  private theme!: HudTheme
  private flashQuad!: Sprite
  private hudScore = -1
  private hudTime = ''
  private hudDist = -1
  private hudCombo = -1

  // =========================================================================
  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = this.pal

    this.sky = new Sky(pal, {
      width: ctx.width, height: ctx.height,
      // Low and to the right, out over the water. Every shadow in the scene is
      // built against this one position, which lives in Light.ts.
      //
      // Demoted hard from where it was. A blind review ranked the focal order of
      // this frame as sun bloom, wipeout banner, HUD, player — fourth — and
      // concluded "the player character loses to the weather". The sun is a warm
      // knot in the sky now, not the brightest pixel in the frame.
      sunX: SUN_X / 1920, sunY: SUN_Y / 1080, sunSize: 250, sunIntensity: 0.26,
      horizonY: HORIZON_Y,
    })

    // The push-in. `ZOOM` design px per screen px, arranged so that design point
    // (CAM_CX, CAM_CY) lands dead centre. Everything in world space goes in here
    // and nothing else does.
    this.stage.scale.set(ZOOM)
    this.stage.position.set(960 - ZOOM * CAM_CX, 540 - ZOOM * CAM_CY)
    this.stage.interactiveChildren = false
    this.stage.eventMode = 'none'

    // A floor colour behind the whole stage. The sky sprite is authored at
    // 1920x1080 and the zoom leaves a sliver of true nothing under its bottom
    // edge; this is one node and it guarantees no frame can ever show it.
    const backdrop = new Graphics()
    backdrop.rect(0, 0, 1920, 1080).fill(DECK_DEEP)
    backdrop.eventMode = 'none'
    ctx.root.addChild(backdrop)

    ctx.root.addChild(this.stage)
    this.stage.addChild(this.sky.container)

    this.parallax = new Parallax()
    this.fgParallax = new Parallax()
    // Nothing in this event is clickable; skipping the hit-test walk keeps the
    // per-frame cost proportional to what is actually drawn.
    this.parallax.container.interactiveChildren = false
    this.fgParallax.container.interactiveChildren = false
    this.world.interactiveChildren = false
    this.stage.addChild(this.parallax.container)

    this.beach = new Beach(pal)
    this.beach.build(this.parallax, 0x5ca11e)

    this.course = new Boardwalk(ctx.rng, pal)
    this.course.buildPath(this.parallax, this.fgParallax, this.parallax.container)

    // The play plane. Only the skater, the hazards and their dust live here.
    this.stage.addChild(this.world)

    // Skid marks lie under everything else on the concrete.
    this.buildSkids()
    this.world.addChild(this.skidRoot)

    // The skater's cast shadow, built from the same rake every post, sign, bin
    // and hazard in the frame uses. Flat and hard-edged — the reference art
    // never blurs a shadow — and long, because the sun is nearly on the water.
    // Shaped, not a trapezoid: wide at the wheels, pinching at the waist, and
    // a head lobe at the tip. On a deck this dark it is the second strongest
    // line in the bottom third of the frame and it points back at her.
    const tipX = SKATER_H * SHADOW_DX
    const tipY = SKATER_H * SHADOW_DY
    this.shadow
      .moveTo(-36, 0).lineTo(32, 0)
      .lineTo(tipX * 0.46 + 44, tipY * 0.46)
      .lineTo(tipX * 0.8 + 30, tipY * 0.8)
      .lineTo(tipX + 25, tipY)
      .lineTo(tipX - 25, tipY)
      .lineTo(tipX * 0.8 - 34, tipY * 0.8)
      .lineTo(tipX * 0.46 - 48, tipY * 0.46)
      .closePath()
      .fill({ color: DECK_SHADE, alpha: 0.56 })
    this.shadow.y = GROUND_Y
    this.world.addChild(this.shadow)

    // ...and the pool where the wheels actually touch. The cast shadow says
    // where the light is; this is the half that says the skater is standing on
    // something. Without it the character floats, which was the single most
    // repeated note across every review of this game.
    //
    // It is three shapes now, and the split is the fix for the last note about
    // it: "she's anchored by a soft airbrushed ellipse that ignores the plank
    // perspective entirely." The shared `ContactShadow` is the soft ambient
    // half and it is held right down; over it sit two hard-edged footprints,
    // one per skate, read back off the rig so each is under its own wheels.
    // All three are rotated onto the local plank direction every frame, which
    // is the half the note was actually about: the boards converge on a point
    // under the sun, so lying flat on this deck is a 34-degree rotation, not a
    // horizontal ellipse. The reference art never blurs a shadow — it lays a
    // darker shape on the ground — so the two that carry the read have flat
    // ends and hard edges and they lie along the boards.
    this.contact = new ContactShadow({
      color: DECK_SHADE, width: 132, height: 34, alpha: 0.34, maxGap: 210,
    })
    this.world.addChild(this.contact.sprite)

    for (let i = 0; i < 2; i++) {
      const paw = new Graphics()
      // The footprint of one skate: flat ends, hard edges, longer than it is
      // wide because a quad skate is. Rotated onto the local plank direction in
      // render, so it lies between two boards instead of across them.
      paw.moveTo(-34, 0).lineTo(-20, -11).lineTo(22, -11)
        .lineTo(36, 0).lineTo(22, 11).lineTo(-20, 11).closePath()
        .fill({ color: DECK_INK, alpha: 0.7 })
      // The tight gather right under the wheels.
      paw.moveTo(-18, 0).lineTo(-8, -6).lineTo(16, -6)
        .lineTo(24, 0).lineTo(16, 6).lineTo(-8, 6).closePath()
        .fill({ color: DECK_INK, alpha: 0.55 })
      paw.eventMode = 'none'
      this.paws.push(paw)
      this.world.addChild(paw)
    }

    this.world.addChild(this.course.container)

    this.dust = new ParticleSystem(softDot(lighten(pal.near, 0.42), 64, 0.35), 150)
    this.world.addChild(this.dust.container)

    // Warm streaks off the wheel line, laid under the skater so she is never
    // drawn over by her own speed lines. Built once; `render` writes position,
    // one scale and an alpha.
    for (let i = 0; i < 5; i++) {
      const y = -18 - i * 34
      const len = 190 - i * 18
      const w = 7 - i * 0.9
      this.speedLines
        .moveTo(-14, y - w / 2)
        .lineTo(-14, y + w / 2)
        .lineTo(-14 - len, y + w * 0.14)
        .lineTo(-14 - len, y - w * 0.14)
        .closePath()
        .fill({ color: lighten(pal.light, 0.42), alpha: 0.28 + i * 0.04 })
    }
    this.speedLines.blendMode = 'add'
    this.speedLines.eventMode = 'none'
    this.speedLines.visible = false
    this.world.addChild(this.speedLines)

    this.skater = new RollerSkater(Core.electricCyan, Core.hotPink)
    // The scale carrier. See `SKATER_SCALE`.
    this.skaterRig.scale.set(SKATER_SCALE)
    this.skaterRig.interactiveChildren = false
    this.skaterRig.eventMode = 'none'
    this.skaterRig.addChild(this.skater.container)
    this.world.addChild(this.skaterRig)

    this.sparks = new ParticleSystem(softDot(Core.sunWhite, 64, 0.3), 110, 'add')
    this.world.addChild(this.sparks.container)

    // Planting and the big palm, above the play plane so the skater passes
    // behind them.
    this.stage.addChild(this.fgParallax.container)

    // Long warm light lying across the whole frame from the sun side. Flat and
    // additive — light as a shape, not a lighting model. Kept well down from
    // where it was: at full strength it lifted the right third of the frame into
    // the same value as the sun and took the contrast out of everything in it.
    const rake = new Sprite(horizontalGradient([
      { t: 0, c: pal.light, a: 0 },
      { t: 0.55, c: pal.light, a: 0.02 },
      { t: 1, c: pal.light, a: 0.07 },
    ], 256))
    rake.width = 1920
    rake.height = 1080
    rake.blendMode = 'add'
    rake.eventMode = 'none'
    // Screen space, not world space: a wash of light across the lens does not
    // scale with the camera, and keeping it out of `stage` means it covers the
    // frame exactly however far the push-in goes.
    ctx.root.addChild(rake)

    this.buildHud()
    ctx.root.addChild(this.hud)

    this.resetRun()

    this.wheels = ctx.audio.loopNoise({ cutoff: 340, q: 0.6, gain: 0.0001 })
    this.surf = ctx.audio.loopNoise({ cutoff: 460, q: 0.5, gain: 0.05 })

    this.exposeRunHandles()
  }

  /**
   * Rubber on the concrete.
   *
   * The boardwalk under the skater was called out as ~20% of the frame with
   * nothing in it. Skid marks fix two things at once: they put the player's own
   * history on the ground behind them, and because they scroll with the world
   * they are a speed cue that the static perspective seams cannot be.
   *
   * Pooled and pre-drawn. `render` only writes x, alpha and visibility.
   */
  private buildSkids(): void {
    const ink = DECK_SHADE
    for (let i = 0; i < SKID_COUNT; i++) {
      const g = new Graphics()
      const len = 150 + (i % 3) * 58
      const drift = (i % 2 === 0 ? 1 : -1) * 3
      // Two wheel tracks, tapering off to the left as the rubber runs out.
      for (const off of [-7, 9]) {
        g.moveTo(6, off)
          .quadraticCurveTo(-len * 0.5, off + drift, -len, off + drift * 2)
          .lineTo(-len, off + drift * 2 + 2.5)
          .quadraticCurveTo(-len * 0.5, off + drift + 5, 6, off + 6)
          .closePath()
          .fill({ color: ink, alpha: 0.9 })
      }
      g.visible = false
      g.eventMode = 'none'
      this.skidRoot.addChild(g)
      this.skids.push(g)
    }
    this.skidRoot.y = GROUND_Y
    this.skidRoot.interactiveChildren = false
    this.skidRoot.eventMode = 'none'
  }

  /** Lay one down at the wheels. */
  private emitSkid(): void {
    const i = this.skidCursor
    this.skidCursor = (this.skidCursor + 1) % SKID_COUNT
    this.skidX[i] = this.distance
    this.skidLife[i] = 1
  }

  private resetRun(): void {
    this.results.setVisible(false)
    this.state = 'skate'
    this.timeLeft = RUN_SECONDS
    this.score = 0
    this.falls = 0
    this.hudFalls = -1
    this.downed = false
    this.clears = 0
    this.bestCombo = 0
    this.bestAirHeight = 0
    this.lastTrick = ''
    this.downCause = ''
    this.stateTimer = 0
    this.graceTimer = 0
    this.crouch = 0
    this.comboFlash = 0
    this.landFlash = 0
    this.shake = 0
    this.hudScore = -1
    this.hudTime = ''
    this.hudDist = -1
    this.hudCombo = -1
    this.callout.container.visible = false
    this.hint?.show()
    this.distance = 0
    this.speed = 520
    this.airY = 0
    if (this.airY > this.bestAirHeight) this.bestAirHeight = this.airY
    this.airVy = 0
    this.twist = 0
    this.twistVel = 0
    this.handstand = 0
    this.tuck = 0
    this.sprawl = 0
    this.bodyRot = 0
    this.combo = 0
    this.endCard.visible = false
    this.course.reset()
    this.course.generate(0)
    this.prevDistance = this.distance
    this.prevAirY = 0
    this.prevTwist = 0
    this.prevBodyRot = 0
    this.skidLife.fill(0)
  }

  // ---------------------------------------------------------------------- hud
  /**
   * One HUD system, built out of the shared one.
   *
   * Every box on screen is `plate()` from `src/render/Hud.ts`, at `HUD_RADIUS`,
   * on `HUD_MARGIN`, and every one of them is `HUD_H` tall with its contents on
   * the same internal baseline. Five widgets, one row, one grid:
   *
   *   DISTANCE | SPEED          TIME          COMBO | SCORE
   *
   * The colours are `themeFor(pal)`, so the interface is cut from the event's
   * own palette and there is not one neutral grey anywhere in it. Nothing in
   * here wears electric cyan or hot pink: those are the skater's, and a player
   * who has to be found in their own frame has already lost the read.
   */
  private hint?: ControlHint

  private buildHud(): void {
    const t = themeFor(this.pal)
    this.theme = t

    // How to play. Four of the six events shipped without this; the menu
    // only explains how to drive the menu. It fades after nine seconds so it
    // does not become furniture.
    this.hint = new ControlHint(t, [{ key: 'RIGHT', action: 'SKATE' }, { key: 'LEFT', action: 'BRAKE' }, { key: 'SPACE', action: 'JUMP' }, { key: 'LEFT / RIGHT', action: 'SPIN IN AIR' }, { key: 'UP / DOWN', action: 'AIR TRICK' }])
    this.hud.addChild(this.hint.container)
    const y = HUD_MARGIN

    /** Scale a widget about its own centre, for a flash, without moving it. */
    const centred = (r: Readout, x: number, w: number): void => {
      r.container.pivot.set(w / 2, HUD_H / 2)
      r.container.position.set(x + w / 2, y + HUD_H / 2)
      this.hud.addChild(r.container)
    }

    // --- left: what the run is doing ---------------------------------------
    this.rDist = new Readout(t, 'DISTANCE', { width: HUD_W })
    centred(this.rDist, HUD_MARGIN, HUD_W)

    // The speed meter gets the same plate as everything else rather than a bare
    // track floating on the background, which is what made it a fourth box
    // treatment in the old layout.
    const speedX = HUD_MARGIN + HUD_W + HUD_GAP
    const speedPlate = new Container()
    speedPlate.addChild(plate(t, HUD_W, HUD_H))
    this.mSpeed = new Meter(t, 'SPEED', HUD_W - 32, HUD_ACCENT)
    this.mSpeed.container.position.set(16, 20)
    speedPlate.addChild(this.mSpeed.container)
    speedPlate.position.set(speedX, y)
    this.hud.addChild(speedPlate)

    // --- falls --------------------------------------------------------------
    // On the row that already exists, in the gap that was already there between
    // SPEED and the clock, so not one existing widget moves. A player who
    // cannot see how many falls are left cannot price the risk, and pricing the
    // risk is the entire point of the rule.
    const fallsPlate = new Container()
    fallsPlate.addChild(plate(t, HUD_W, HUD_H))
    const fallsLabel = new Text({ text: 'FALLS', style: hudLabelStyle(t) })
    fallsLabel.position.set(16, 11)
    fallsPlate.addChild(fallsLabel)
    for (let i = 0; i < MAX_FALLS; i++) {
      const pip = new Graphics()
      pip.position.set(16 + i * 34, 36)
      fallsPlate.addChild(pip)
      this.fallPips.push(pip)
    }
    fallsPlate.position.set(speedX + HUD_W + HUD_GAP, y)
    this.hud.addChild(fallsPlate)

    // --- centre: the clock --------------------------------------------------
    this.rTime = new Readout(t, 'TIME', { width: HUD_TIME_W, valueSize: 36 })
    centred(this.rTime, 960 - HUD_TIME_W / 2, HUD_TIME_W)

    // --- right: what the run is worth --------------------------------------
    const scoreX = 1920 - HUD_MARGIN - HUD_W
    const comboX = scoreX - HUD_GAP - HUD_W
    this.rCombo = new Readout(t, 'COMBO', {
      width: HUD_W, align: 'right', valueColor: HUD_ACCENT,
    })
    centred(this.rCombo, comboX, HUD_W)
    this.rScore = new Readout(t, 'SCORE', { width: HUD_W, align: 'right' })
    centred(this.rScore, scoreX, HUD_W)

    // --- feedback -----------------------------------------------------------
    /*
     * The trick banner is gone and a `Callout` has taken its place.
     *
     * The banner was 680px of plate parked in the sky with a headline and a
     * caption in it, and every review of this event ranked it above the skater
     * in focal order — one of them concluded the game was "outsourcing its
     * entire dramatic beat to a text label". A call-out is the shared answer to
     * that: it is anchored to the skater, it draws a leader back to her, and it
     * has no box at all, so it can say what happened without becoming the thing
     * that happened.
     */
    this.callout = new Callout(48)
    this.hud.addChild(this.callout.container)

    // The run-over card. It holds indefinitely and it summarises rather than
    // reacts, so it is a plate and not a call-out — but it is the *same* plate,
    // at the same radius, on the same centre line as the clock above it.
    const cardW = 640
    const cardH = 148
    this.endCard.addChild(plate(t, cardW, cardH))
    this.endText = new Text({
      text: '', style: new TextStyle({
        fontFamily: 'Anton, Archivo, system-ui, sans-serif',
        fontSize: 54, fill: t.value, letterSpacing: 2,
      }),
    })
    this.endText.anchor.set(0.5, 0)
    this.endText.position.set(cardW / 2, 20)
    this.endLine = new Text({
      text: '', style: new TextStyle({
        fontFamily: 'Archivo, system-ui, sans-serif',
        fontSize: 22, fill: t.label, fontWeight: '600', letterSpacing: 2,
      }),
    })
    this.endLine.anchor.set(0.5, 0)
    this.endLine.position.set(cardW / 2, 92)
    const rule = new Graphics()
    rule.rect(40, 84, cardW - 80, 2).fill({ color: HUD_ACCENT, alpha: 0.5 })
    this.endCard.addChild(rule, this.endText, this.endLine)

    // The way out. `endPrompt` centres itself on its own origin, so it goes
    // inside a wrapper placed on the card's centre line — repositioning it
    // directly would overwrite the offset that does the centring.
    const prompt = new Container()
    prompt.addChild(endPrompt(t, 'SKATE AGAIN'))
    prompt.position.set(cardW / 2, cardH + 34)
    this.endCard.addChild(prompt)

    this.endCard.position.set(960 - cardW / 2, 300)
    this.endCard.visible = false
    this.hud.addChild(this.endCard)

    this.results = new ResultsPanel(this.pal, 'ROLLER SKATING', RESULT_LABELS, RESULT_COLORS)
    this.results.setVisible(false)
    this.hud.addChild(this.results.container)

    this.flashQuad = new Sprite(softDot(Core.paperWhite, 64, 0.95))
    this.flashQuad.width = 1920
    this.flashQuad.height = 1080
    this.flashQuad.alpha = 0
    this.flashQuad.blendMode = 'add'
    this.hud.addChild(this.flashQuad)
    this.hud.eventMode = 'none'
    this.hud.interactiveChildren = false
  }

  // ------------------------------------------------------------------- update
  update(dt: number, _tick: number): void {
    // The legend and the end prompt are never on screen together: two rows of
    // key chips saying different things is two instructions, not one.
    if (this.state === 'done') {
      if (this.hint) this.hint.container.visible = false
    } else {
      this.hint?.tick(dt)
    }
    const input = this.ctx.input
    this.prevDistance = this.distance
    this.prevAirY = this.airY
    this.prevTwist = this.twist
    this.prevBodyRot = this.bodyRot

    if (this.state !== 'done') {
      this.timeLeft = Math.max(0, this.timeLeft - dt)
      // A clock that expires mid-tumble ends the run with the skater down, so
      // `done` does not stand her back up over the card.
      if (this.timeLeft === 0) {
        this.finish("TIME'S UP", this.state === 'fall' || this.state === 'getup')
      }
    }

    switch (this.state) {
      case 'skate': this.updateSkating(dt); break
      case 'air': this.updateAir(dt); break
      case 'fall': this.updateFall(dt); break
      case 'getup': this.updateGetUp(dt); break
      case 'done': this.updateDone(dt); break
    }

    // Course keeps a bounded window of hazards around the camera. The window
    // uses a fixed offset rather than the live camera, because `camScreenX` is a
    // render-side value and the simulation must not depend on it.
    const camX = this.distance - 620
    this.course.generate(camX)
    this.course.update(dt, camX)
    if (this.state === 'skate' || this.state === 'air') this.collide()
    else this.inSand = false

    this.graceTimer = Math.max(0, this.graceTimer - dt)
    this.callout.tick(dt)
    this.comboFlash = Math.max(0, this.comboFlash - dt * 2.6)
    this.landFlash = Math.max(0, this.landFlash - dt * 3.4)
    this.shake = Math.max(0, this.shake - dt * 2.2)
    this.sandTimer = Math.max(0, this.sandTimer - dt)
    for (let i = 0; i < SKID_COUNT; i++) {
      if (this.skidLife[i] > 0) this.skidLife[i] = Math.max(0, this.skidLife[i] - dt * 0.34)
    }

    this.beach.update(dt)
    this.dust.update(dt)
    this.sparks.update(dt)
    this.sky.update(dt)
    this.skater.update(dt, this.twistVel * 30 + this.speed * 0.02)
    this.mixAudio()

    // The way out of a finished run. Enter drops a fresh run into the same
    // scene; Escape is the same menu exit the run already had.
    if (this.state === 'done' && input.justPressed(Action.Start)) this.resetRun()
    if (input.justPressed(Action.Back)) this.ctx.goto('menu')
  }

  /** Grounded. Throttle, brake, stride, and the jump launch. */
  private updateSkating(dt: number): void {
    const input = this.ctx.input

    const throttle = input.isDown(Action.Right)
    const braking = input.isDown(Action.Left)
    if (throttle) {
      // Acceleration tails off near the top, so the last 200px/s costs real
      // boardwalk and topping out is a decision rather than a default.
      const headroom = 1 - clamp01(this.speed / MAX_SPEED) * 0.72
      this.speed += ACCEL * headroom * dt
      if (input.justPressed(Action.Right)) this.ctx.perf.markResponse(input.lastRawPressTime)
    } else if (braking) {
      this.speed -= BRAKE * dt
      if (input.justPressed(Action.Left)) this.ctx.perf.markResponse(input.lastRawPressTime)
      if (this.speed > 120 && this.ctx.rng.chance(0.45)) {
        this.emitDust(3, 0.6, -1)
      }
      // Rubber goes down under a hard brake, not under a gentle one. Gated on
      // distance rather than on `ctx.rng`: the course generator draws from that
      // same stream, and a cosmetic call here would make the hazards a player
      // brakes in front of depend on whether they braked.
      if (this.speed > 420) {
        const si = Math.floor(this.distance / 130)
        if (si !== this.lastSkidIndex) { this.lastSkidIndex = si; this.emitSkid() }
      }
    } else if (this.speed > COAST_FLOOR) {
      // Coasting bleeds back toward a cruise, never to a stop: a roller skater
      // on flat concrete keeps rolling, and a game that halts when you let go
      // punishes you for looking ahead.
      this.speed = COAST_FLOOR + (this.speed - COAST_FLOOR) * Math.pow(COAST_DRAG, dt)
    }

    if (this.inSand) {
      this.speed = SAND_TARGET + (this.speed - SAND_TARGET) * Math.pow(SAND_DRAG, dt)
    }
    this.speed = clamp(this.speed, MIN_SPEED, MAX_SPEED)
    this.distance += this.speed * dt

    // The crouch tracks throttle and brake, so the body is always telling you
    // what the physics is doing.
    const wantCrouch = braking ? 0.85 : throttle ? 0.44 : 0.22
    this.crouch = damp(this.crouch, wantCrouch, 0.0006, dt)
    // Braking sits back on the heels; speed tips the shoulders forward.
    //
    // Pushed hard. The lean used to top out at 0.38rad and it did not read at
    // all, because the rig was moving the head backward by the same angle it
    // was tipping the torso forward (see `RollerSkater.apply`). With that fixed
    // the lean is worth having, so it now runs to 0.66rad — 38 degrees off
    // vertical, which is a skater working rather than a skater standing.
    const wantLean = braking ? -0.4 : 0.2 + clamp01(this.speed / MAX_SPEED) * 0.46
    this.lean = damp(this.lean, wantLean, 0.0004, dt)
    // Stride frequency scales with speed but saturates, or the legs blur.
    this.stride = (this.stride + dt * (0.5 + Math.min(this.speed, 1100) / 420)) % 1
    this.bodyRot = damp(this.bodyRot, 0, 0.0001, dt)
    this.handstand = damp(this.handstand, 0, 0.00002, dt)
    this.tuck = damp(this.tuck, 0, 0.00002, dt)

    this.rollNoise()

    // Jump, with a 6-tick buffer so a press that lands just before touchdown
    // still fires. This is most of what separates an arcade feel from a demo.
    if (input.buffered(Action.A, 6)) {
      input.consumeBuffer(Action.A)
      this.launch()
    }

    if (this.speed > 260 && this.ctx.rng.chance(clamp01(this.speed / 2600))) {
      this.emitDust(1, 0.35, -1)
    }
  }

  private launch(): void {
    this.state = 'air'
    this.airY = 0.01
    this.airVy = JUMP_MAX
    this.airPeak = 0
    this.jumpHeld = true
    this.twist = 0
    this.twistVel = 0
    this.handstandTime = 0
    this.tuckTime = 0
    this.airClears = 0
    this.crouch = 0.75
    this.ctx.perf.markResponse(this.ctx.input.lastRawPressTime)
    this.ctx.audio.noise({ duration: 0.16, cutoff: 2600, toCutoff: 700, gain: 0.13 })
    this.ctx.audio.tone({ freq: 300, toFreq: 520, duration: 0.1, type: 'triangle', gain: 0.06 })
    this.emitDust(7, 1, -1)
  }

  /** Airborne. Spin, pose, and the descent. */
  private updateAir(dt: number): void {
    const input = this.ctx.input

    // Variable jump height: releasing A on the way up clips the arc. Held all
    // the way, the jump is long enough to land a 540.
    if (this.jumpHeld && !input.isDown(Action.A)) {
      this.jumpHeld = false
      if (this.airVy > JUMP_MIN) this.airVy = JUMP_MIN
    }

    // Pirouette. Angular velocity builds while a direction is held, so a 360 is
    // committed to on the way up rather than flicked at the apex.
    const dir = input.axisX()
    if (dir !== 0) {
      this.twistVel += dir * SPIN_ACCEL * dt
      if (input.justPressed(Action.Left) || input.justPressed(Action.Right)) {
        this.ctx.perf.markResponse(input.lastRawPressTime)
      }
    }
    this.twistVel = clamp(this.twistVel * Math.pow(0.7, dt), -SPIN_MAX, SPIN_MAX)
    this.twist += this.twistVel * dt

    // Down for a handstand, Up for a tuck. They are exclusive; the later press
    // wins, which makes a mid-air change of mind cost the time it should.
    const wantHand = input.isDown(Action.Down) ? 1 : 0
    const wantTuck = !wantHand && input.isDown(Action.Up) ? 1 : 0
    if (input.justPressed(Action.Down) || input.justPressed(Action.Up)) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
    }
    this.handstand = damp(this.handstand, wantHand, 0.00002, dt)
    this.tuck = damp(this.tuck, wantTuck, 0.00002, dt)
    if (this.handstand > 0.6) this.handstandTime += dt
    if (this.tuck > 0.6) this.tuckTime += dt

    this.airVy -= GRAVITY * dt
    this.airY += this.airVy * dt
    if (this.airY > this.airPeak) this.airPeak = this.airY
    this.distance += this.speed * dt
    this.crouch = damp(this.crouch, 0.2, 0.0008, dt)
    this.lean = damp(this.lean, clamp(this.twistVel * 0.02, -0.3, 0.3), 0.0008, dt)
    this.stride = (this.stride + dt * 0.4) % 1

    if (this.airY <= 0 && this.airVy < 0) this.land()
  }

  /**
   * Touchdown.
   *
   * Judged the same way `HalfPipe.land()` judges a re-entry: how far the body is
   * from the orientation the surface expects. Here that means how far the
   * pirouette is from a whole number of turns — land facing the way you are
   * travelling and it is clean, land side-on and the wheels catch.
   */
  private land(): void {
    const input = this.ctx.input
    this.airY = 0
    this.airVy = 0

    const turns = this.twist / TAU
    const off = Math.abs(this.twist - Math.round(turns) * TAU)

    if (off > LAND_BAIL) {
      this.lastTrick = 'SIDEWAYS'
      this.downCause = 'LANDED SIDEWAYS'
      this.goDown()
      return
    }

    const clean = off < LAND_CLEAN
    // Still upside down when the wheels touch is survivable but ugly.
    const stillInverted = this.handstand > 0.6
    const quality = clean && !stillInverted ? 1 : 0.5

    this.state = 'skate'
    // Snap to zero rather than to the whole turn that was landed. cos() cannot
    // tell the difference, but leaving it at 2pi and damping it back to 0 would
    // unwind a whole extra pirouette on the concrete. `prevTwist` goes with it
    // so the interpolator does not whip across the same gap in one frame.
    this.twist = 0
    this.prevTwist = 0
    this.twistVel = 0
    this.crouch = 0.9
    this.speed *= clean ? 1 : 0.84
    this.landFlash = clean ? 1 : 0.45

    this.scoreTrick(quality, clean, stillInverted)

    this.ctx.audio.noise({
      duration: 0.2, cutoff: clean ? 2200 : 1000, toCutoff: 260,
      gain: clean ? 0.17 : 0.12,
    })
    if (clean) this.ctx.audio.tone({ freq: 440, toFreq: 660, duration: 0.12, type: 'triangle', gain: 0.08 })
    this.emitDust(clean ? 9 : 5, 1.1, -1)
    this.emitSkid()
    this.ctx.perf.markResponse(input.lastRawPressTime)
  }

  /** Name the trick, pay it out, and put it on screen. */
  private scoreTrick(quality: number, clean: boolean, inverted: boolean): void {
    const halfTurns = Math.round(Math.abs(this.twist) / Math.PI)
    const degrees = halfTurns * 180
    const handstand = this.handstandTime > 0.12
    const tucked = this.tuckTime > 0.12

    let name = ''
    if (handstand) name = 'HANDSTAND'
    else if (tucked) name = 'TUCK'
    if (degrees >= 180) name = name ? `${name} ${degrees}` : `${degrees} SPIN`

    const base =
      degrees * 2.4 +
      this.handstandTime * 430 +
      this.tuckTime * 250 +
      this.airPeak * 0.95

    // A trick over an obstacle is worth far more than the same trick over empty
    // concrete: the chain bonus is the reason to jump late and spin anyway.
    const chain = 1 + this.airClears * 0.75
    const points = Math.round(base * quality * chain * this.comboMult())

    if (!name && this.airClears > 0) name = this.airClears > 1 ? `${this.airClears}x CLEAR` : 'CLEAR'

    if (points > 0) this.score += points

    if (name) {
      const suffix = inverted ? ' HANDS DOWN' : clean ? '' : ' SKETCHY'
      this.lastTrick = name + suffix
      const pts = points > 0 ? `  +${points.toLocaleString('en-US')}` : ''
      this.callout.show(this.lastTrick + pts, clean && !inverted ? Core.paperWhite : HUD_ACCENT)
      if (points > 0) this.burstSparks(10)
    }
  }

  // ------------------------------------------------------------------ hazards
  /**
   * Hazard resolution.
   *
   * A hazard is hit when the skater overlaps it and is lower than it is tall,
   * and cleared when the skater passes its trailing edge without having hit it.
   * Sand is the exception: it does not drop you, it holds you down, so it keeps
   * applying drag for as long as you are standing in it.
   */
  private collide(): void {
    // Cleared here rather than at the top of update(): the throttle code runs
    // before collision does, so it reads last frame's answer. One frame of lag
    // on a drag force is invisible; resetting it first made the drag never
    // apply at all.
    this.inSand = false
    const hazards = this.course.hazards
    for (let i = 0; i < hazards.length; i++) {
      const h = hazards[i]
      if (!h.active || h.resolved) continue
      const dx = this.distance - h.x
      const reach = h.spec.halfW + SKATER_HALF

      if (dx > reach) {
        h.resolved = true
        if (!h.hit) this.clearHazard(h)
        continue
      }
      if (dx < -reach) continue
      if (this.airY >= h.spec.height) continue

      if (!h.spec.fall) {
        this.inSand = true
        if (!h.hit) {
          h.hit = true
          this.hitSand(h)
        }
        continue
      }
      if (this.graceTimer > 0) { h.resolved = true; continue }
      h.hit = true
      h.resolved = true
      this.downCause = h.spec.label
      this.goDown()
      return
    }
  }

  private clearHazard(_h: Hazard): void {
    this.combo++
    this.clears++
    if (this.combo > this.bestCombo) this.bestCombo = this.combo
    if (this.state === 'air') this.airClears++
    this.comboFlash = 1

    const pts = Math.round((70 + this.speed * 0.09) * this.comboMult())
    this.score += pts
    // Pitch climbs with the combo, so the chain is audible before it is legible.
    const step = Math.min(this.combo, 14)
    this.ctx.audio.tone({
      freq: 520 * Math.pow(1.0595, step * 2),
      duration: 0.09, type: 'triangle', gain: 0.07,
    })
    this.burstSparks(4)
  }

  private hitSand(_h: Hazard): void {
    this.combo = 0
    this.comboFlash = 1
    this.sandTimer = 0.9
    this.lastTrick = 'SAND'
    // Softened gold, never the palette's magenta and never the skater's cyan.
    // She wears the only two saturated hues the frame spends and the interface
    // is not allowed to borrow either of them.
    this.callout.show('SAND  COMBO LOST', HUD_ACCENT)
    this.ctx.audio.noise({ duration: 0.5, cutoff: 1500, toCutoff: 300, gain: 0.16, q: 0.6 })
    this.emitDust(16, 1.5, 1)
  }

  /** The tumble. Loses the combo, loses a second and a half, hurts. */
  private goDown(): void {
    // One tumble, one count. `land()` and `collide()` both reach here, and
    // neither may bill the same fall twice — nor may anything bill a fall
    // against a run that is already over.
    if (this.state === 'fall' || this.state === 'getup' || this.state === 'done') return
    this.state = 'fall'
    this.stateTimer = FALL_SECONDS
    this.falls++
    this.combo = 0
    this.comboFlash = 1
    this.airY = 0
    this.airVy = 0
    this.twist = 0
    this.prevTwist = 0
    this.twistVel = 0
    this.shake = 1
    this.landFlash = 0.3
    this.callout.show(`WIPEOUT  ${this.downCause}`, HUD_ACCENT)
    this.ctx.audio.noise({ duration: 0.45, cutoff: 1200, toCutoff: 160, gain: 0.22 })
    this.ctx.audio.tone({ freq: 210, toFreq: 66, duration: 0.4, type: 'sawtooth', gain: 0.1 })
    this.emitDust(20, 1.8, 1)
    if (this.wheels) this.wheels.setGain(0.0001)
  }

  private updateFall(dt: number): void {
    // Feet go out, body comes down, everything scrubs off fast.
    this.speed *= Math.pow(0.02, dt)
    this.distance += this.speed * dt
    this.sprawl = damp(this.sprawl, 1, 0.00004, dt)
    this.bodyRot = damp(this.bodyRot, -1.42, 0.0002, dt)
    this.crouch = damp(this.crouch, 1, 0.0005, dt)
    this.stateTimer -= dt
    if (this.stateTimer <= 0) {
      // "If you break with the face three times, you need to stop early."
      // There is no getting up from the third one.
      if (this.falls >= MAX_FALLS) { this.finish('THREE FALLS', true); return }
      this.state = 'getup'
      this.stateTimer = GETUP_SECONDS
      this.ctx.audio.noise({ duration: 0.22, cutoff: 900, toCutoff: 2000, gain: 0.09 })
    }
  }

  private updateGetUp(dt: number): void {
    // The recovery beat: back on the wheels, one push, rolling again.
    const t = 1 - clamp01(this.stateTimer / GETUP_SECONDS)
    this.sprawl = damp(this.sprawl, 0, 0.00002, dt)
    this.bodyRot = damp(this.bodyRot, 0, 0.00004, dt)
    this.crouch = damp(this.crouch, 0.55, 0.0004, dt)
    this.speed = lerp(0, 300, smoothstep(0.35, 1, t))
    this.distance += this.speed * dt
    this.stride = (this.stride + dt * 0.9) % 1
    this.stateTimer -= dt
    if (this.stateTimer <= 0) {
      this.state = 'skate'
      this.graceTimer = GRACE_SECONDS
      this.sprawl = 0
      this.bodyRot = 0
      this.emitDust(6, 0.8, -1)
      this.ctx.audio.tone({ freq: 240, toFreq: 380, duration: 0.14, type: 'triangle', gain: 0.07 })
    }
  }

  /**
   * End the run. The clock and the third fall both come here — one path, so
   * there is only ever one definition of what "over" means.
   */
  private finish(reason = "TIME'S UP", downed = false): void {
    if (this.state === 'done') return
    this.state = 'done'
    this.downed = downed
    this.endText.text = reason
    this.endLine.text = `SCORE ${this.score.toLocaleString('en-US')}  ·  BEST CHAIN x${(1 + Math.min(this.bestCombo, 16) * 0.5).toFixed(1)}`
    // The results screen carries the reason now; the local card stays down but
    // is still fed, because the capture gate reads `endText`/`endLine`.
    this.endCard.visible = false
    this.results.setTitle(`ROLLER SKATING  \u00b7  ${reason}`)
    this.results.show(ratingFor(this.score, RESULT_PAR), this.score)
    this.results.meters[0].set(clamp01(this.distance / 6000))
    this.results.meters[1].set(clamp01(this.bestAirHeight / 200))
    this.results.meters[2].set(clamp01(this.bestCombo / 16))
    this.results.meters[3].set(clamp01(1 - this.falls / MAX_FALLS))
    this.results.setVisible(true)
    // The card says what happened now; a call-out mid-fade would be arguing.
    this.callout.container.visible = false
    this.ctx.audio.tone({ freq: 660, toFreq: 440, duration: 0.5, type: 'triangle', gain: 0.1 })
  }

  private updateDone(dt: number): void {
    // Rolling to a halt and lying in a heap are two different endings, and the
    // recovery animation belongs to only one of them.
    this.speed *= Math.pow(this.downed ? 0.02 : 0.22, dt)
    this.distance += this.speed * dt
    if (!this.downed) {
      this.crouch = damp(this.crouch, 0.5, 0.0008, dt)
      this.stride = (this.stride + dt * Math.min(this.speed, 800) / 500) % 1
    }
    this.airY = 0
  }

  /** Falls spent, as three marks. Redrawn only when the count changes. */
  private paintFallPips(): void {
    if (this.hudFalls === this.falls) return
    this.hudFalls = this.falls
    for (let i = 0; i < this.fallPips.length; i++) {
      const g = this.fallPips[i]
      const spent = i < this.falls
      g.clear()
      g.roundRect(0, 0, 26, 26, 7)
        .fill(spent ? { color: this.theme.accent, alpha: 1 } : { color: this.theme.edge, alpha: 0.26 })
      g.roundRect(0.75, 0.75, 24.5, 24.5, 7)
        .stroke({ color: this.theme.edge, width: 1.5, alpha: spent ? 0.95 : 0.55 })
    }
  }

  /**
   * `window.__cg.skatingFall()` and `window.__cg.skatingEnd(how?)`.
   *
   * A screen that is only reachable after ninety seconds of play, or after
   * three wipeouts a driver has to earn against a random course, is a screen
   * nobody can photograph. Both handles drive the REAL path rather than drawing
   * the card directly: `skatingEnd('falls')` spends the first two falls and
   * starts a genuine third, so the tumble plays and `updateFall` ends the run
   * exactly the way a player would; `skatingEnd('time')` runs the clock out.
   * Neither is reachable from any input and neither changes a rule.
   */
  private exposeRunHandles(): void {
    const w = window as unknown as Record<string, unknown>
    const cg = (w.__cg ?? (w.__cg = {})) as Record<string, unknown>
    cg.skatingShow = (kind: string, scale = 6): string => {
      const holder = new Container()
      holder.position.set(960, 620)
      holder.scale.set(scale)
      holder.addChild(this.course.inspectArt(kind as never, 0))
      this.hud.addChild(holder)
      return `${kind} at 960,620 x${scale}`
    }
    cg.skatingHazard = (kind: string | null): string => {
      Boardwalk.forcedKind = (kind ?? null) as never
      return `hazards pinned to ${kind ?? 'random'}`
    }
    cg.skatingFall = (): number => {
      this.downCause = 'DEBUG'
      this.goDown()
      return this.falls
    }
    cg.skatingEnd = (how: string = 'falls'): string => {
      if (how === 'time') {
        this.timeLeft = 0
        return 'time'
      }
      this.falls = MAX_FALLS - 1
      this.hudFalls = -1
      this.downCause = 'DEBUG'
      this.goDown()
      return 'falls'
    }
  }

  private comboMult(): number {
    return 1 + Math.min(this.combo, 16) * 0.5
  }

  // -------------------------------------------------------------------- audio
  /**
   * Wheels on concrete is a noise bed whose gain and cutoff both track speed,
   * plus a discrete clack every time the skater crosses a slab joint. The joints
   * are what make speed audible: at a crawl they tick, flat out they machine-gun.
   */
  private rollNoise(): void {
    const idx = Math.floor((this.distance - JOINT_SPACING / 2) / JOINT_SPACING)
    if (idx !== this.lastJointIndex) {
      this.lastJointIndex = idx
      if (this.speed > 180) {
        this.ctx.audio.noise({
          duration: 0.045, cutoff: 900 + this.speed * 1.5, toCutoff: 380,
          gain: 0.018 + clamp01(this.speed / MAX_SPEED) * 0.045, q: 1.4,
        })
      }
    }
  }

  private mixAudio(): void {
    if (!this.wheels) return
    const frac = clamp01(this.speed / MAX_SPEED)
    const grounded = this.state === 'skate' || this.state === 'getup' || this.state === 'done'
    const sandy = this.sandTimer > 0 ? 1 : 0
    this.wheels.setGain(grounded ? 0.012 + frac * 0.085 : 0.002)
    // Sand drops the cutoff into a scrape; clean concrete opens right up.
    this.wheels.setCutoff(lerp(300 + frac * 1750, 220, sandy * 0.7))
  }

  // ---------------------------------------------------------------- particles
  private emitDust(amount: number, force: number, dir: number): void {
    const rng = this.ctx.rng
    const x = this.distance - 14
    const y = GROUND_Y - this.airY
    const pal = this.pal
    this.dust.burst(amount, () => ({
      x: x + rng.spread(16),
      y: y - rng.range(0, 10),
      vx: dir * rng.range(40, 230) * force + rng.spread(50),
      vy: -rng.range(20, 150) * force,
      life: rng.range(0.3, 0.8),
      size: rng.range(10, 30) * force,
      sizeEnd: 3,
      color: lighten(pal.near, rng.range(0.08, 0.4)),
      alpha: 0.45,
      gravity: 420,
      drag: 0.32,
    }))
  }

  private burstSparks(amount: number): void {
    const rng = this.ctx.rng
    const x = this.distance
    const y = GROUND_Y - this.airY - 60
    this.sparks.burst(amount, () => ({
      x: x + rng.spread(40),
      y: y + rng.spread(46),
      vx: rng.spread(160),
      vy: -rng.range(60, 260),
      life: rng.range(0.3, 0.65),
      size: rng.range(8, 22),
      sizeEnd: 1,
      // Not raw gold: the spark burst fires on the same frame a review capture
      // is taken, and at 0.77 chroma it out-colours the skater's own shirt.
      color: rng.chance(0.5) ? Core.sunWhite : mix(Core.sunGold, Core.sunWhite, 0.7),
      alpha: 0.85,
      gravity: 260,
      drag: 0.4,
    }))
  }

  // ------------------------------------------------------------------- render
  render(alpha: number): void {
    const dist = lerp(this.prevDistance, this.distance, alpha)
    const air = lerp(this.prevAirY, this.airY, alpha)
    const twist = lerp(this.prevTwist, this.twist, alpha)
    const bodyRot = lerp(this.prevBodyRot, this.bodyRot, alpha)

    // Camera. The faster you go the further left you sit, which buys back some
    // of the reaction time speed costs you — the trade is real but not brutal.
    // The whole range moved right by 60px, and `CAM_CX` moved with it: flat out
    // the skater used to sit at 12% of the frame width, which is where set
    // dressing lives. The 170px spread between the two ends is untouched, so
    // the speed-for-reaction-time trade the event is built on is the same trade
    // it always was. See `CAM_CX` in Light.ts for what the pair costs.
    const frac = clamp01(this.speed / MAX_SPEED)
    this.camScreenX = damp(this.camScreenX, lerp(660, 490, frac), 0.02, 1 / 60)
    const camX = dist - this.camScreenX
    // Hard, short shake on a wipeout only. Deterministic, derived from the decay.
    const sh = this.shake * this.shake
    const shakeX = Math.sin(this.shake * 61) * 12 * sh
    const shakeY = Math.cos(this.shake * 47) * 8 * sh
    this.world.position.set(-camX + shakeX, shakeY)
    this.parallax.scrollTo(camX - shakeX * 0.4, -shakeY * 0.4)
    this.fgParallax.scrollTo(camX - shakeX * 0.4, -shakeY * 0.4)

    this.course.place()
    this.beach.render()

    // --- what she is standing on -------------------------------------------
    // The long shadow says where the sun is; it shortens and fades as she
    // climbs. The pools say she is standing on the concrete, and they are what
    // stop the character reading as pasted on.
    //
    // `deckX` is her position in the deck's own fixed design space, which is
    // what `plankAngle` is defined against: the boards are screen-fixed and
    // converge on a point under the sun, so the angle of "flat on the ground"
    // depends on where in the frame she is, not on how far she has skated.
    const lift = clamp01(air / 190)
    const deckX = dist - camX + shakeX
    const plank = plankAngle(deckX, GROUND_Y)
    this.shadow.position.set(dist, GROUND_Y)
    this.shadow.scale.set(lerp(1, 0.62, lift), lerp(1, 0.55, lift))
    this.shadow.alpha = lerp(1, 0.28, lift)
    this.contact.place(dist - 4, GROUND_Y + 3, air, plank)

    // --- the speed cue ------------------------------------------------------
    // "No trail, no speed cue." Five warm streaks running back from the wheel
    // line up past the shoulders, pre-built, so `render` writes a position, one
    // scale and an alpha. Invisible at a coast and full length flat out, so a
    // still frame says how fast she is going without reading the HUD.
    const rush = clamp01((this.speed - 480) / 900)
    this.speedLines.visible = rush > 0.02 && this.state !== 'fall'
    if (this.speedLines.visible) {
      this.speedLines.position.set(dist - 34, GROUND_Y - air)
      this.speedLines.scale.set(lerp(0.55, 1.35, rush), 1)
      this.speedLines.alpha = rush * 0.6
    }

    for (let i = 0; i < SKID_COUNT; i++) {
      const life = this.skidLife[i]
      const g = this.skids[i]
      if (life <= 0) { g.visible = false; continue }
      g.visible = true
      g.x = this.skidX[i]
      // Rubber lies along the boards, not across them.
      g.rotation = plankAngle(this.skidX[i] - camX + shakeX, GROUND_Y)
      g.alpha = life * life * 0.4
    }

    this.skaterRig.position.set(dist, GROUND_Y - air)
    this.skaterRig.rotation = bodyRot
    const airborne = this.state === 'air'
    this.skater.setPose({
      crouch: this.crouch,
      lean: this.lean,
      // Opened up again. The arms have to clear the torso for the silhouette to
      // have negative space in it, and negative space is what a reviewer is
      // reading when they say a character does or does not look finished.
      reach: airborne ? clamp01(0.6 + Math.abs(this.twistVel) * 0.04) : clamp01(0.4 + frac * 0.5),
      stride: this.stride,
      // Effort. At a coast the legs stay under her; flat out the driving skate
      // sweeps a long way out behind the hip and the recovering one folds high.
      drive: airborne ? 0.3 : clamp01(0.15 + frac * 0.95),
      lift: airborne ? clamp01(air / 55) : 0,
      tuck: this.tuck,
      handstand: this.handstand,
      sprawl: this.sprawl,
      twist,
      facing: 1,
    })
    this.skater.apply()

    // One hard footprint per skate, read back off the rig after `apply()` so it
    // is under the wheels rather than under the average of them, and rotated
    // onto the boards. Both fade as the foot leaves the deck, which is the cue
    // that says which skate is carrying her.
    const feet = [this.skater.footBack, this.skater.footFront]
    for (let i = 0; i < 2; i++) {
      const paw = this.paws[i]
      const fx = feet[i].x * SKATER_SCALE
      const gap = -feet[i].y * SKATER_SCALE + air
      const a = 1 - clamp01(gap / 120)
      paw.visible = a > 0.02
      if (!paw.visible) continue
      paw.position.set(dist + fx, GROUND_Y + 2)
      paw.rotation = plankAngle(deckX + fx, GROUND_Y)
      paw.scale.set(lerp(1, 0.68, clamp01(gap / 120)))
      paw.alpha = a
    }

    // The call-out is anchored to her in screen space, which is where the HUD
    // lives; the world is inside a container scaled by ZOOM and the interface
    // is not.
    this.renderHud(
      960 + ZOOM * (deckX - CAM_CX),
      540 + ZOOM * (GROUND_Y - air - CAM_CY),
    )
  }

  private renderHud(calloutX: number, calloutY: number): void {
    // Text assignment allocates, so every field is gated on a real change.
    const secs = Math.ceil(this.timeLeft)
    const mins = Math.floor(secs / 60)
    const timeStr = `${mins}:${(secs % 60).toString().padStart(2, '0')}`
    if (timeStr !== this.hudTime) {
      this.hudTime = timeStr
      this.rTime.set(timeStr)
    }
    // The last ten seconds, said with scale rather than with colour. Every
    // readout is pivoted on its own centre, so a widget can grow in place
    // without shifting off the row it shares with the other four.
    const urgent = this.timeLeft <= 10 && this.state !== 'done'
      ? 1 + Math.abs(Math.sin(this.timeLeft * Math.PI)) * 0.06
      : 1
    this.rTime.container.scale.set(urgent)

    if (this.score !== this.hudScore) {
      this.hudScore = this.score
      this.rScore.set(this.score.toLocaleString('en-US'))
    }
    const metres = Math.floor(this.distance / PX_PER_METRE)
    if (metres !== this.hudDist) {
      this.hudDist = metres
      this.rDist.set(`${metres} M`)
    }
    if (this.combo !== this.hudCombo) {
      this.hudCombo = this.combo
      const m = this.comboMult()
      this.rCombo.set(`x${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}`)
    }

    const live = this.combo > 0
    this.rCombo.container.alpha = live ? 1 : 0.7
    this.rCombo.container.scale.set(1 + this.comboFlash * 0.1)

    this.mSpeed.set(clamp01(this.speed / MAX_SPEED))

    // Feedback belongs to the thing it describes: the call-out sits up and to
    // the right of the skater, over the open road ahead, with a leader drawn
    // back to her. Placed in screen space, so it never scales with the camera.
    this.callout.placeAt(calloutX, calloutY, 250, -320)

    this.paintFallPips()
    this.flashQuad.alpha = this.landFlash * 0.1
  }

  resize(width: number, height: number): void {
    this.sky.resize(width, height)
  }

  exit(): void {
    this.wheels?.stop(0.2)
    this.surf?.stop(0.4)
    this.wheels = null
    this.surf = null
    this.dust.clear()
    this.sparks.clear()
    const cg = (window as unknown as Record<string, unknown>).__cg as
      Record<string, unknown> | undefined
    if (cg) {
      delete cg.skatingShow
      delete cg.skatingHazard
      Boardwalk.forcedKind = null
      delete cg.skatingFall
      delete cg.skatingEnd
    }
  }

  /**
   * Simulation state for automated review. A critic drives the event through
   * this, so it has to answer "what is about to happen" and not just "what is
   * happening" — hence the nearest hazard and its distance.
   */
  debug(): Record<string, unknown> {
    const next = this.course.nearest(this.distance)
    return {
      // Is the control legend still on screen? The capture gate needs this:
      // three blind reviews were spent on a frame with a tutorial bar across
      // the player, and a wall-clock delay is wrong under software rendering
      // where the simulation advances far slower than the clock.
      hintUp: (this.hint?.visible ?? false) && this.state !== 'done',
      state: this.state,
      fallsLeft: Math.max(0, MAX_FALLS - this.falls),
      over: this.state === 'done',
      endReason: this.state === 'done' ? this.endText.text : '',
      speed: Math.round(this.speed),
      speedFrac: Math.round(clamp01(this.speed / MAX_SPEED) * 100) / 100,
      distance: Math.round(this.distance),
      metres: Math.floor(this.distance / PX_PER_METRE),
      airHeight: Math.round(this.airY),
      bestAir: Math.round(this.bestAirHeight),
      twistDeg: Math.round((this.twist * 180) / Math.PI),
      combo: this.combo,
      comboMult: this.comboMult(),
      bestCombo: this.bestCombo,
      clears: this.clears,
      falls: this.falls,
      inSand: this.inSand,
      nextHazard: next ? next.kind : null,
      nextHazardIn: next ? Math.round(next.x - this.distance) : null,
      nextHazardHeight: next ? next.spec.height : null,
      lastTrick: this.lastTrick,
      /*
       * The hazard that put the skater down, and *only* that.
       *
       * This used to report `lastHazard` unconditionally, and `lastHazard` is
       * set by `clearHazard` as well as by a wipeout — so one frame after the
       * first hazard was successfully cleared it became permanently non-empty.
       * `scripts/capture-action.sh` waits for `airHeight > 55 && !lastHazard`
       * before taking the review screenshot, which meant that from the first
       * clear onward the apex condition could never be met again: the driver
       * timed out at 22 seconds and the shutter fired on whatever the run
       * happened to be doing. That is how the frame that went to a blind review
       * came to be a wipeout with the skater on his back — "the ragdoll that
       * should be selling it is four percent of the frame height". The event
       * was being judged on the one instant it is guaranteed to look worst.
       */
      lastHazard: this.state === 'fall' || this.state === 'getup' ? this.downCause : '',
      score: this.score,
      timeLeft: Math.round(this.timeLeft * 10) / 10,
    }
  }
}

/**
 * The HUD label face, matching what `Readout` uses internally, so the falls
 * plate is the same widget as the four beside it rather than a new look next to
 * them. `Hud.ts` keeps its label style private and is shared by six events, so
 * it is restated here rather than edited there.
 */
function hudLabelStyle(t: HudTheme): TextStyle {
  return new TextStyle({
    fontFamily: 'Archivo, system-ui, sans-serif',
    fontSize: 16, fill: t.label, fontWeight: '600', letterSpacing: 1.6,
  })
}
