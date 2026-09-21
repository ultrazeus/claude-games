import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import { ResultsPanel, ratingFor } from '../../ui/Results'
import type { Scene, SceneContext } from '../../../core/Scene'
import { Action } from '../../../core/Input'
import { Sky } from '../../../render/Sky'
import { Parallax } from '../../../render/Parallax'
import { ParticleSystem } from '../../../render/Particles'
import { horizontalGradient, softDot, verticalGradient } from '../../../render/Gradient'
import {
  Core, Palettes, fromHsv, grade, mix, skyAt, toHsv, type EventPalette, type Hex,
} from '../../../render/Palette'
import {
  ContactShadow, depthOutline, keyFromRight, occlusionPool, scatter, shadePair,
  type KeyLight,
} from '../../../render/Staging'
import {
  ControlHint, Callout, HUD_MARGIN, Meter, Readout, endPrompt, plate,
  themeFor } from '../../../render/Hud'
import { clamp, clamp01, damp, lerp } from '../../../core/Tween'
import { Course, FEATURE_NAMES, FLAG_DECK, FLAG_STEEP, STEP } from './Course'
import { Rider, type RiderPose } from './Rider'

type RideState = 'ride' | 'air' | 'crash'

/* --- results screen. `RESULT_PAR` only positions the judges' cards. */
const RESULT_LABELS = ['AIR', 'SPIN', 'DISTANCE', 'CLEAN'] as const
const RESULT_COLORS: readonly Hex[] = [0xffd27a, 0x9fd8ff, 0xffe6a8, 0xb9f2c8]
const RESULT_PAR = 16000

const TAU = Math.PI * 2
/**
 * Lighter than the half pipe's 2150. A dirt jumper needs hang time: a full back
 * flip takes about nine tenths of a second to throw and check, so the biggest
 * pop on the course has to buy noticeably more than that.
 */
const GRAVITY = 1750
/** Fraction of speed kept per second to rolling resistance. */
const ROLL_FRICTION = 0.90
const PEDAL_ACCEL = 900
const BRAKE_DECEL = 1500
const MAX_SPEED = 1420
/** How hard a fully-loaded, perfectly-timed pop throws the bike off a lip. */
const POP_IMPULSE = 700
/**
 * How much of a pop goes straight up rather than along the surface normal.
 * A rider extends through their legs, which stay near world-vertical in the
 * attack position; a purely normal impulse would fire them backwards off a
 * 40-degree lip and scrub every bit of speed they arrived with.
 */
const POP_UP = 0.72
/** Ticks a pop stays armed after the button comes up, waiting for a lip. */
const POP_WINDOW = 10
const PRELOAD_RATE = 3.6
/** Instant angular velocity a rotation starts with, rad/s. */
const FLIP_KICK = 7
/** Torque while building a rotation you have already started, rad/s^2. */
const FLIP_GAIN = 16
/**
 * Torque when you push *against* your own rotation. Deliberately three times
 * stronger: spotting the landing and checking the bike is what a rider actually
 * does, and a symmetric model makes a full flip physically impossible inside a
 * one-second air.
 */
const FLIP_CHECK = 44
const FLIP_CAP = 13
const RUN_SECONDS = 90

/**
 * The third fall ends the run.
 *
 * Straight from the original: "the fun is over after the third 'normal' fall."
 * Without it a crash costs a couple of seconds and nothing else, so there is
 * never a reason not to throw the biggest trick on every lip — which is
 * exactly how this event played until now. Three is the whole difficulty
 * curve of the event and it was missing.
 *
 * The head landing that "instantly ends the game" in the original is NOT
 * implemented; see `crash`.
 */
const MAX_FALLS = 3

/**
 * Camera push-in.
 *
 * The rider rig is ~176 local units from tyre contact to the top of the lid.
 * At 1:1 that is 16% of the 1080 frame; through ZOOM and the stage scale below
 * it lands at 19-20%, which is where the reference holds its rider. The world
 * container is scaled rather than the rig, so the berm, its shadows and its
 * surface dressing all grow with him.
 */
const ZOOM = 1.16
/**
 * Camera roll.
 *
 * The neutral review's first sentence about this event was that everything in
 * it is "a horizontal band stacked on another horizontal band, cut by a
 * dead-flat horizon at the exact vertical midpoint". The single fix that
 * removes the whole class of complaint is to stop the frame being axis-aligned:
 * the backdrop, the course and the near plane are all children of one `stage`
 * container that is rolled a few degrees, so the horizon, the berm crest and
 * the bottom edge of the frame are diagonals, not bands. Negative = the right
 * of the frame lifts, which runs the horizon parallel to the raking key light
 * instead of across it.
 *
 * The HUD is NOT in the stage, so readouts stay level.
 */
const STAGE_TILT = -0.072
/**
 * Overscan, so rolling the stage never exposes a corner of empty canvas.
 *
 * The floor is cos|t| + (w/h) * sin|t| = 1.1253 for a 16:9 frame at this angle,
 * which is not a number to eyeball — 1.09 looks fine in the middle of the frame
 * and leaves a wedge of nothing in two opposite corners. 1.15 clears it with
 * about 11px of margin at the tightest corner.
 */
const STAGE_SCALE = 1.15
const STAGE_CX = 960
const STAGE_CY = 540
/** The roll, resolved once, so world-to-screen costs four multiplies. */
const STAGE_COS = Math.cos(STAGE_TILT)
const STAGE_SIN = Math.sin(STAGE_TILT)
/**
 * Where the rider sits in stage space.
 *
 * He used to land at screen (690, 592), which is 55% of frame height — and a
 * neutral review put it bluntly: "B's rider sits on the horizon line, the
 * single worst place to put a subject." It was literally true. The desert
 * floor line ran at screen y 455 and the near ridge at 420, so with a 216px
 * rig his head and shoulders were cut by two background contours and his
 * centroid was within forty pixels of the strongest horizontal step in the
 * picture.
 *
 * He now lands at screen (690, 700). The whole rig — tyres at 700, lid at
 * 484 — sits clear below every backdrop contour, against the near slope and
 * the berm, which are the two darkest masses above the foreground silhouette.
 * Nothing about the ride changed; the camera moved.
 *
 * Inverse of the stage transform (see `buildStage`) at S = (690, 700):
 * p = C + R(+0.072) * (S - C) / 1.15 = (716, 662).
 */
const CAM_X = 716
const RIDER_SCREEN_Y = 662
const CAM_Y = RIDER_SCREEN_Y / ZOOM
/**
 * The ground is never allowed above or below these stage heights. They are
 * stage units, not screen units: the overscan multiplies them by STAGE_SCALE,
 * so 1070 here is the 1150 of screen the framing was originally tuned against.
 */
const GROUND_SCREEN_HIGH = 560
const GROUND_SCREEN_LOW = 1070
/**
 * Camera y the backdrop is authored against.
 *
 * Bound to `CAM_Y`: dropping the rider 94 stage units down the frame must not
 * drag the horizon down with him, or the framing gains nothing. Keeping the
 * difference `CAM_Y - NOMINAL_CAM_Y` at the value the backdrop was drawn for
 * (150) holds every parallax band exactly where it was authored while the play
 * plane slides to the lower third.
 */
const NOMINAL_CAM_Y = CAM_Y - 150

/**
 * The key light.
 *
 * The sun is low and to the right — an hour off the horizon, seen through
 * desert dust. The surface-to-sun direction is (+0.93, -0.37), so the light
 * travels down-left at about 22 degrees off horizontal and every shadow in the
 * event is long. That is not a detail: a low sun is what turns a field of
 * cacti, boulders, tufts, hoardings and one rider into a field of parallel
 * diagonals, which is the compositional spine the flat-band version had none of.
 *
 * Every lit plane, terminator and cast shadow in this file derives from these
 * four numbers and nothing else.
 */
const LIGHT_X = 0.93
const LIGHT_Y = 0.37
/** How far a cast shadow rakes per unit of object height. Negative = leftwards. */
const RAKE_X = -2.45
/** How far a cast shadow drops down the ground plane per unit of height. */
const RAKE_Y = 0.42

const WHEEL_R = 25
/** Width of one recycled terrain tile. */
const TILE_W = 480
const TILE_COUNT = 6
/**
 * Depth of the flat riding deck between the tyres and the top of the logs.
 *
 * The C64 original is a *banked track*: the log revetment is a short retaining
 * wall at its edge, and above it you see a wide dirt surface in perspective —
 * the thing you ride on. Ours started the revetment at the riding line itself,
 * so the logs began under the tyres and ran 124px down, and a player put it
 * exactly right: "why does BMX ride over a seemingly narrow trail?" There was
 * no trail. There was a fence, and the rider was balanced on top of it.
 *
 * This is carved out of the existing band rather than added to it, so the berm
 * does not get taller and nothing below it moves.
 */
const DECK = 84
/**
 * Bottom of the log band, measured from the riding line. The logs themselves
 * are `BAND - DECK` tall — raised with the deck so the revetment stays a
 * substantial wall rather than a trim strip, which is the event's strongest
 * identity cue and the only texture in the bottom third of the frame.
 */
const BAND = 186
const POST_W = 19
/** World y the dirt body is extruded down to. Always below the frame. */
const COURSE_FLOOR = 2400
/**
 * The dark end of the value range, and the one number a review asked for by
 * name: "give it a true near-black foreground silhouette layer (#14100E)
 * cutting across the bottom... a haze style without an anchoring silhouette is
 * just fog." L 0.066. Nothing else in the event is allowed below L 0.14.
 */
const NEAR_BLACK = 0x14100e

interface Tile {
  dirt: Graphics
  props: Graphics
  span: number
}

/**
 * BMX — a desert dirt-jump course that never ends.
 *
 * The event is the half pipe turned on its side: a bead on a wire with an
 * energy-transfer mechanic (preload and pop instead of pump), an air state with
 * rotation and a grab, and a landing judged on the angle between the bike and
 * the ground it is meeting. What is new is that the wire is generated ahead of
 * the camera and recycled behind it — see `Course.ts` — and that the geometry
 * drawing it is a fixed ring of six tiles that are redrawn, never added to, so
 * an infinite course costs a bounded scene graph.
 *
 * The look is built on three decisions, in this order, and every colour in the
 * file is downstream of them:
 *
 *   1. ONE HUE FAMILY. An hour before sunset, seen through hanging dust: the
 *      sky, the ridges, the desert and the dirt all sit between hue 15 and 45
 *      degrees. There is no blue sky and no green cactus, because "blue over
 *      green" is the pair that arrives free with any engine and reads as a
 *      default rather than a decision. The only cool note in the frame is the
 *      rider, and he owns it outright.
 *   2. A FOUR-STEP VALUE LADDER with a TRUE DARK END, assigned before any hue
 *      was picked. It used to be three masses and no floor, and a neutral
 *      review measured exactly that: "B lives inside roughly 30 degrees of
 *      orange and about a 30% value band... nothing separates, so the eye has
 *      no route and lands nowhere," and then "B has no dark end." Squinted down
 *      to luminance it is now:
 *
 *        light  sky            L 0.53 at the zenith to 0.96 at the horizon
 *        mid    open desert    L 0.61 falling to 0.33 down the near shoulder
 *        dark   the berm       L 0.33 at the crown to 0.16 in the revetment
 *        black  the near plane L 0.084, and 0.066 at the frame edge
 *
 *      The rider is the only thing that crosses three of those four. Contrast
 *      inside a mass stays rationed: sunlit lips, pebble caps, the crest line,
 *      and the one hot rim on the silhouette.
 *   3. ONE DOMINANT DIAGONAL. The stage is rolled (`STAGE_TILT`), the sun is
 *      low and right so every cast shadow rakes down-left, light shafts run
 *      corner to corner along the same vector, erosion rills rake the same way
 *      down both the desert shoulder and the berm face, and the near plane is
 *      cropped by a bank whose edge is a ramp. Nothing in the frame is a
 *      horizontal band on top of another horizontal band.
 *   4. TWO RESERVED HUES, AND TWO ECHOES. The rider owns cyan and magenta and
 *      nothing else in the event may carry them above a third of their chroma.
 *      Two things in the world carry them at exactly that: a line of cyan
 *      course flags along the berm, and one sun-bleached pink panel on a
 *      roadside hoarding. A review found the rider's saturated pixels "a 25px
 *      cluster with no echo anywhere else, so they read as a sticker pasted
 *      onto a landscape rather than a rider in one" — two echoes is the answer,
 *      and two is the limit.
 *
 * Band separation still follows the measured reference (refs/BAR-ANALYSIS.md):
 * bands differ by *rendering mode* as well as by value — bare linework far
 * away, one flat tint in the middle, full colour and outlines up close.
 *
 * The interface is `src/render/Hud.ts`, not this file. See `buildHud`.
 */
export class Bmx implements Scene {
  readonly id = 'bmx'

  private ctx!: SceneContext
  private pal = Palettes.bmx
  private course!: Course

  private sky!: Sky
  private parallax!: Parallax
  private foreground!: Parallax
  /**
   * Everything that belongs to the world rather than to the screen. Rolled and
   * overscanned as one, so the whole picture is on a diagonal and the HUD is not.
   */
  private stage = new Container()
  private world = new Container()
  private tiles: Tile[] = []
  private rider!: Rider
  /** Soft occlusion pool that spreads as the bike leaves the ground. */
  private contact!: ContactShadow
  /** The hard-edged tyre shadow that actually pins the bike to the dirt. */
  private tyreShadow!: Graphics
  private key!: KeyLight
  /** Every dirt tone the berm is built from, resolved once from the key light. */
  private dirt!: DirtTones
  private dust!: ParticleSystem
  private grit!: ParticleSystem
  private haze!: ParticleSystem

  // --- simulation state -----------------------------------------------------
  private state: RideState = 'ride'
  private x = 0
  private y = 0
  private v = 0
  /** Airborne velocity, world px/s. */
  private vx = 0
  private vy = 0
  private rot = 0
  private rotVel = 0
  private yaw = 0
  private yawVel = 0
  /** Signed radians of in-plane rotation accumulated this air. */
  private flip = 0
  /** Whether this air has already had its opening kick, per axis. */
  private rotKicked = false
  private yawKicked = false
  private wheelAngle = 0

  private preload = 0
  private popArmed = 0
  private popCharge = 0
  private lastPopQuality = 0
  private compress = 0
  private landSquash = 0
  private grabHeld = 0
  private tableTime = 0
  private braking = false
  private pedalling = false

  private airTicks = 0
  private launchY = 0
  private peakY = 0
  private launchKind = 0
  private lastAirHeight = 0

  private crashTimer = 0
  /** Falls this run. `MAX_FALLS` of them ends it. */
  private crashes = 0
  private sprawl = 0

  private timeLeft = RUN_SECONDS
  private over = false
  /** Why the run stopped, which is all the end panel's headline says. */
  private endedBy: 'time' | 'falls' = 'time'
  private score = 0
  private bestTrick = 0
  private trickName = ''
  private trickTimer = 0
  private trickClean = true
  private landingFlash = 0
  private startX = 0
  private hazeClock = 0
  /** Last values the HUD text was built from, so render allocates no strings. */
  private shownSecond = -1
  private shownScore = -1
  private shownMetres = -1
  private shownFalls = -1

  // previous-state copies for render interpolation
  private prevX = 0
  private prevY = 0
  private prevRot = 0
  private prevCamY = 0
  private camY = 0
  /** Reused pose object, so positioning the rig in render allocates nothing. */
  private pose: RiderPose = {
    compress: 0, lean: 0, table: 0, tuck: 0, sprawl: 0, wheel: 0, facing: 1, yaw: 0,
  }

  // --- audio ----------------------------------------------------------------
  private tyre: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null
  private wind: { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } | null = null
  private audioClock = 0

  // --- hud ------------------------------------------------------------------
  private hud = new Container()
  private timeOut!: Readout
  private scoreOut!: Readout
  private distOut!: Readout
  /** The falls count. Three of them and the run is over. */
  private fallsOut!: Readout
  private speedMeter!: Meter
  private popMeter!: Meter
  /**
   * Trick and crash feedback, anchored to the rider rather than centred in
   * empty sky. See `placeCallout`.
   */
  private callout!: Callout
  private flashQuad!: Sprite
  private overPanel = new Container()
  /** Shared between-event results screen; see `src/game/ui/Results.ts`. */
  private results!: ResultsPanel
  /** Run maxima, for the results screen only. */
  private bestAirH = 0
  private bestSpinD = 0
  private overTitle!: Text
  private overScore!: Text

  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = this.pal
    this.course = new Course(ctx.rng)
    // A low sun off to the right, so the light rakes down and to the left
    // across the course the rider is travelling into. Everything that shades,
    // casts or rims in this file reads its direction from here.
    this.key = keyFromRight(pal.light, 1)
    this.dirt = dirtTones(pal, this.key)

    this.buildStage()

    // A low sun, an hour off the horizon, sitting just above the far ridge so
    // the mesas bite into it. It is large and soft rather than small and hard,
    // because it is being read through dust — and it is held at low intensity
    // on purpose: a bloom that out-ranks the rider is the exact failure the
    // first review named, and the sun's job is to explain the shadows.
    this.sky = new Sky(pal, {
      width: ctx.width, height: ctx.height,
      sunX: 0.845, sunY: 0.25, sunSize: 172, sunIntensity: 0.3,
      horizonY: 331,
    })
    this.stage.addChild(this.sky.container)

    this.parallax = new Parallax()
    this.stage.addChild(this.parallax.container)
    this.buildBackdrop()

    // Light shafts. They sit in front of the backdrop and behind the play
    // plane, so they carry the dominant diagonal across the sky and the open
    // desert without washing a single pixel of the rider.
    this.stage.addChild(this.buildShafts())

    this.stage.addChild(this.world)
    this.buildTiles()

    // Two shadows, because they do two different jobs. The soft pool spreads
    // and fades with height and reads as the bike's mass; the hard ellipses are
    // the actual tyre contact, and without them the bike floats.
    // Both shadow tones are pushed below every dirt tone in the event, so the
    // bike is pinned to a surface rather than hovering over one the same value.
    this.contact = new ContactShadow({
      color: mix(pal.shade, NEAR_BLACK, 0.55), width: 132, height: 34, alpha: 0.55, maxGap: 460,
    })
    this.world.addChild(this.contact.sprite)

    this.tyreShadow = new Graphics()
    this.tyreShadow.ellipse(-44, 0, 26, 8).ellipse(44, 0, 26, 8)
      .fill(grade(mix(pal.shade, NEAR_BLACK, 0.68), { satScale: 1.2 }))
    this.world.addChild(this.tyreShadow)

    this.dust = new ParticleSystem(softDot(mix(pal.near, pal.light, 0.62), 64, 0.36), 150)
    this.world.addChild(this.dust.container)

    // The reserved hues. Every other colour in this event lives between hue 15
    // and 45 degrees; the rider is the only cyan and the only magenta in the
    // frame, and the HUD is forbidden both (see `buildHud`). Hue alone is not
    // the whole break — the lid is the lightest thing below the sky and the
    // rig's ink is among the darkest — but it is what makes him findable in a
    // thumbnail.
    this.rider = new Rider(Core.hotPink, Core.electricCyan)
    this.world.addChild(this.rider.container)

    this.grit = new ParticleSystem(softDot(grade(pal.shade, { valScale: 1.35, satScale: 0.9 }), 32, 0.9), 70)
    this.world.addChild(this.grit.container)
    this.world.scale.set(ZOOM)

    // The berm falls away from the light into an occlusion pool rather than
    // stopping at a flat fill. Sized past every edge, because the stage is
    // rolled and a 1920-wide sprite would leave a lit triangle in a corner.
    //
    // It now sits BEHIND the near plane and at half its old strength. Laid over
    // the foreground it washed the silhouette's rim out along with everything
    // else, which is how a near plane stops being a shape and starts being
    // fog — the exact note the last review closed on.
    const floorPool = occlusionPool({
      color: pal.shade, width: 2400, height: 500, strength: 0.38, direction: 'down',
    })
    floorPool.position.set(-240, 760)
    this.stage.addChild(floorPool)

    this.foreground = new Parallax()
    this.stage.addChild(this.foreground.container)
    this.buildForeground()

    // Drifting haze, in screen space, so the heat sits over the whole frame.
    this.haze = new ParticleSystem(softDot(pal.light, 64, 0.22), 36, 'add')
    ctx.root.addChild(this.haze.container)

    this.buildHud()
    ctx.root.addChild(this.hud)

    this.tyre = ctx.audio.loopNoise({ cutoff: 300, gain: 0.0001, q: 0.7 })
    this.wind = ctx.audio.loopNoise({ cutoff: 220, gain: 0.018, q: 0.5 })

    this.resetRun()
    this.exposeEndHandles()
  }

  /**
   * `window.__cg.bmxFalls(n?)` and `window.__cg.bmxResults(score?)` — put the
   * run on its end screen without playing ninety seconds of it first.
   *
   * The surfing event already needed this for the judges' panel and the reason
   * is the same here: an end screen that costs a full run to reach is a screen
   * nobody can photograph, and a capture that has to *earn* three crashes is a
   * capture testing the landing model instead of the panel. `bmxFalls` takes
   * the falls path and prints THREE FALLS; `bmxResults` takes the clock.
   *
   * Debug affordances only: no input reaches them, they change no rule, and
   * both end the run through `endRun` like everything else.
   */
  private exposeEndHandles(): void {
    const w = window as unknown as Record<string, unknown>
    const cg = (w.__cg ?? (w.__cg = {})) as Record<string, unknown>
    cg.bmxFalls = (n = MAX_FALLS): number => {
      this.crashes = Math.max(0, Math.round(n))
      if (this.crashes >= MAX_FALLS) this.endRun('falls')
      return this.crashes
    }
    cg.bmxResults = (score?: number): number => {
      if (typeof score === 'number') this.score = Math.max(0, Math.round(score))
      this.timeLeft = 0
      this.endRun('time')
      return this.score
    }
  }

  /**
   * The rolled stage.
   *
   * Sky, backdrop, light shafts, course and near plane all live in here, so one
   * rotation puts the entire picture on a diagonal. The HUD deliberately does
   * not, because a rolled readout is a gimmick and a rolled horizon is staging.
   *
   * The roll is about the frame centre, so a stage-space point `p` lands on
   * screen at `S = C + s * R(t) * (p - C)`. The rider is anchored in stage
   * space, so his screen position is fixed by inverting that once, on paper:
   *
   *     p = C + R(-t) * (S - C) / s
   *
   * With S = (690, 700), C = (960, 540), t = -0.072 and s = 1.15 that gives
   * p = (716, 662), which is where CAM_X and RIDER_SCREEN_Y come from. Change
   * either constant and the rider slides off his third. Through ZOOM and the
   * overscan he stands 216px tall there, which is 20.0% of the frame.
   */
  private buildStage(): void {
    this.stage.pivot.set(STAGE_CX, STAGE_CY)
    this.stage.position.set(STAGE_CX, STAGE_CY)
    this.stage.rotation = STAGE_TILT
    this.stage.scale.set(STAGE_SCALE)
    this.stage.eventMode = 'none'
    this.ctx.root.addChild(this.stage)
  }

  /**
   * Shafts of dust-light, thrown along the key vector.
   *
   * Three soft parallelograms fanned out of the sun and running to the opposite
   * corner. They are the loudest statement of the dominant diagonal in the
   * frame and they cost three sprites: the value ramp, the hue and the line all
   * travel the same way the cast shadows do, which is what makes a composition
   * converge rather than merely contain things.
   *
   * They sit behind the play plane, so the rider is never washed by them.
   */
  private buildShafts(): Container {
    const c = new Container()
    const pal = this.pal
    const sunX = 0.845 * 1920
    const sunY = 0.25 * 1080
    // Direction the light travels: down and to the left, 22 degrees below
    // horizontal. Identical to the vector every cast shadow is raked along.
    const angle = Math.atan2(LIGHT_Y, -LIGHT_X)
    const px = -Math.sin(angle)
    const py = Math.cos(angle)
    const tex = horizontalGradient([
      { t: 0, c: pal.light, a: 0 },
      { t: 0.16, c: pal.light, a: 1 },
      { t: 0.68, c: pal.light, a: 0.5 },
      { t: 1, c: pal.light, a: 0 },
    ], 256)
    for (const [offset, height, alpha] of [
      [-320, 170, 0.085], [40, 280, 0.06], [400, 120, 0.05],
    ] as const) {
      const s = new Sprite(tex)
      s.anchor.set(0, 0.5)
      s.width = 3000
      s.height = height
      s.rotation = angle
      s.alpha = alpha
      s.blendMode = 'add'
      s.eventMode = 'none'
      s.position.set(sunX + px * offset, sunY + py * offset)
      c.addChild(s)
    }
    c.eventMode = 'none'
    return c
  }

  // ---------------------------------------------------------------- backdrop
  //
  // Four bands, separated by rendering mode AND by chroma, in that order:
  //
  //   far A - bare contour on the sky. No fill at all.
  //   far B - filled, but within a few percent of the sky it sits against.
  //   mid   - filled, every element collapsed to ONE tint. Silhouettes only.
  //   near  - full colour, lit and shaded, a little interior detail.
  //
  // Every band goes through `this.band()`, which drops saturation monotonically
  // with distance and rotates hue toward the sky rather than only lifting
  // value. The previous version washed by value alone and let the mid-ground
  // scrub out-chroma everything in front of it, which inverted depth at
  // exactly the point the eye was being asked to read it.
  //
  // Outline weight comes from `depthOutline(depth)` everywhere, so line weight
  // falls off with distance instead of sitting at a uniform 2px.
  //
  private buildBackdrop(): void {
    const { pal } = this
    const W = 1920

    // --- far A: linework only ----------------------------------------------
    const farADepth = 0.8
    const farALine = depthOutline(farADepth)
    const lineTint = this.band(mix(pal.far, Core.deepInk, 0.22), farADepth, 0.42)
    this.parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      g.moveTo(0, farRidge(0))
      for (let x = 12; x <= W; x += 12) g.lineTo(x, farRidge(x))
      g.stroke({ color: lineTint, width: farALine.width, alpha: farALine.alpha })
      // A second, higher chain of peaks, drawn with no fill behind it. This is
      // the trick the reference uses for distant skylines and it is what stops
      // the horizon reading as two flat cut-outs.
      const spurs = new Graphics()
      for (let i = 0; i < 9; i++) {
        const px = 70 + i * 212
        const h = 54 + ((i * 47) % 46)
        spurs.moveTo(px - 92, farRidge(px) + 8)
          .lineTo(px - 30, farRidge(px) - h)
          .lineTo(px + 16, farRidge(px) - h * 0.55)
          .lineTo(px + 74, farRidge(px) - h * 0.92)
          .lineTo(px + 150, farRidge(px) + 8)
      }
      spurs.stroke({ color: lineTint, width: farALine.width, alpha: farALine.alpha * 0.8 })
      c.addChild(g, spurs)
      return c
    }, { factorX: 0.035, factorY: 0.028, wrapWidth: W, copies: 3 })

    // --- far B: the dust-rose ridges, all but dissolved ---------------------
    const farBDepth = 0.66
    const farBLine = depthOutline(farBDepth)
    const farTint = this.band(pal.far, farBDepth, 0.46)
    // Even at this distance the sun side of a ridge is lighter than the shadow
    // side. It is a two-value split on a shape a hundred pixels tall and it is
    // what stops the far band reading as cut paper.
    const farLit = mix(farTint, pal.light, 0.24)
    this.parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      g.moveTo(0, 1180)
      for (let x = 0; x <= W; x += 14) g.lineTo(x, midRidge(x))
      g.lineTo(W, 1180).closePath().fill(farTint)
      // Sunlit crests: wherever the ridge falls away to the right it is facing
      // the light, so it takes the lit tone.
      const lit = new Graphics()
      ridgeLitRuns(lit, midRidge, 14, 34)
      lit.fill({ color: farLit, alpha: 0.85 })
      const crest = new Graphics()
      crest.moveTo(0, midRidge(0))
      for (let x = 14; x <= W; x += 14) crest.lineTo(x, midRidge(x))
      crest.stroke({
        color: grade(farTint, { valScale: 0.9, satScale: 1.1 }),
        width: farBLine.width, alpha: farBLine.alpha,
      })
      c.addChild(g, lit, crest)
      return c
    }, { factorX: 0.075, factorY: 0.055, wrapWidth: W, copies: 3 })

    // --- mid: mesas and saguaro, one tint ----------------------------------
    // The whole middle distance is a single hue, held well below the chroma of
    // anything in front of it, and everything standing on it casts.
    const midDepth = 0.5
    const midLineW = depthOutline(midDepth)
    const midTint = this.band(pal.mid, midDepth, 0.5)
    const midLine = grade(midTint, { valScale: 0.93, satScale: 1.06 })
    const midLit = mix(midTint, pal.light, 0.3)
    const midCast = mix(midTint, pal.shade, 0.4)
    const midPlant = this.band(pal.accent, midDepth + 0.22, 0.5)
    // Scattered, not stamped: varied pitch, varied scale, three silhouettes.
    const midCacti = scatter({
      count: 7, from: 40, to: W - 40, seed: 20731, scaleRange: [0.3, 0.58], variants: 3,
    })
    const midRocks = scatter({
      count: 5, from: 80, to: W - 80, seed: 90211, scaleRange: [0.45, 0.85], variants: 2,
    })
    this.parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      g.moveTo(0, 1180)
      for (let x = 0; x <= W; x += 10) g.lineTo(x, nearRidge(x))
      g.lineTo(W, 1180).closePath().fill(midTint)
      const litG = new Graphics()
      ridgeLitRuns(litG, nearRidge, 10, 26)
      litG.fill({ color: midLit, alpha: 0.8 })
      const edge = new Graphics()
      edge.moveTo(0, nearRidge(0))
      for (let x = 10; x <= W; x += 10) edge.lineTo(x, nearRidge(x))
      edge.stroke({ color: midLine, width: midLineW.width, alpha: midLineW.alpha })
      c.addChild(g, litG, edge)

      // Shadows first, so every silhouette in this band sits in its own pool.
      const shade = new Graphics()
      const art = new Graphics()
      for (const [bx, bw, bh] of [[210, 250, 112], [980, 300, 86], [1520, 210, 132]] as const) {
        const gy = nearRidge(bx) + 6
        castShadow(shade, bx, gy, bh * 0.5, bw * 0.42, midCast, 0.46)
        butte(art, bx, gy, bw, bh, midTint, midLit, midLine, midLineW)
      }
      for (const s of midCacti) {
        const gy = nearRidge(s.x) + 8
        castShadow(shade, s.x, gy, 96 * s.scale, 12 * s.scale, midCast, 0.4)
        saguaro(art, s.x, gy, s.scale, midPlant, mix(midPlant, pal.light, 0.22),
          grade(midPlant, { valScale: 0.88 }), midLineW, s.variant)
      }
      for (const s of midRocks) {
        const gy = nearRidge(s.x) + 10
        castShadow(shade, s.x, gy, 30 * s.scale, 34 * s.scale, midCast, 0.38)
        boulder(art, s.x, gy, s.scale, midTint, midLit, midLine, midLineW, s.variant)
      }
      c.addChild(shade, art)
      return c
    }, { factorX: 0.15, factorY: 0.1, wrapWidth: W, copies: 3 })

    // Heat: a warm additive veil sitting on the horizon. Sells hanging dust at
    // a low sun without touching a single layer colour.
    const heat = new Sprite(verticalGradient(
      // 0.14, down from 0.20. Additive warm light on a warm sky raises red
      // faster than blue, so the veil was quietly pushing the horizon band back
      // up into the chroma range the rider's kit is reserved in.
      [{ t: 0, c: pal.light, a: 0 }, { t: 0.55, c: pal.light, a: 0.14 }, { t: 1, c: pal.light, a: 0 }],
      128,
    ))
    heat.width = 2400
    heat.height = 220
    heat.position.set(-240, 232)
    heat.blendMode = 'add'
    this.parallax.addLayer(heat, { factorX: 0, factorY: 0.04 })

    // --- near: the desert floor, lit and shaded -----------------------------
    // This is the band the rider is silhouetted against, so it carries the
    // long raking shadows the critic asked for and nothing else in it is
    // allowed to out-contrast him.
    const nearDepth = 0.3
    const nearLineW = depthOutline(nearDepth)
    const nearTint = this.band(pal.mid, nearDepth, 0.56)
    const nearLit = mix(nearTint, pal.light, 0.34)
    const nearLine = grade(nearTint, { valScale: 0.8, satScale: 1.08 })
    const nearCast = mix(nearTint, pal.shade, 0.56)
    /** The bottom of the shoulder, where it meets the cut. L 0.22. */
    const nearDeep = grade(mix(nearTint, pal.shade, 0.8), { valScale: 0.94, satScale: 1.1 })
    /** Erosion lines: the shoulder's own shade, one step darker again. */
    const nearRill = grade(mix(nearTint, pal.shade, 0.72), { valScale: 0.72, satScale: 1.15 })
    const scrub = this.band(pal.accent, nearDepth + 0.26, 0.58)
    const scrubLit = mix(scrub, pal.light, 0.32)
    const scrubLine = grade(scrub, { valScale: 0.8, satScale: 1.1 })
    const nearCacti = scatter({
      count: 5, from: 60, to: W - 60, seed: 44987, scaleRange: [0.9, 1.7], variants: 3,
    })
    const nearRocks = scatter({
      count: 4, from: 120, to: W - 120, seed: 13337, scaleRange: [0.7, 1.35], variants: 2,
    })
    const nearTufts = scatter({
      count: 11, from: 0, to: W, seed: 60013, scaleRange: [0.6, 1.5], variants: 3,
    })
    this.parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      g.moveTo(0, 1400)
      for (let x = 0; x <= W; x += 10) g.lineTo(x, floorLine(x))
      g.lineTo(W, 1400).closePath().fill(nearTint)
      // The face of the open desert, falling off toward the camera — and this
      // is where the frame gets its value plan back.
      //
      // The old version lit the top 60px and left everything below it one flat
      // tint, which meant the rider was punched out against the SAME value the
      // desert behind the mesas carried. A review measured the consequence and
      // called it: the whole picture inside a 30% value band with nothing to
      // separate. The desert here is not flat ground seen from above; it is the
      // shoulder of the cut the course runs through, turning away from a sun
      // that is an hour off the horizon. So it ramps, in eight steps, from a
      // lit contour at L 0.55 down to L 0.22 where it meets the berm — and the
      // rider rides in the bottom two steps of that ramp.
      //
      // The steps are also what stops the band measuring as dead: a continuous
      // fall spreads luminance across the histogram instead of piling every
      // pixel of the lower half into one bin.
      const plane = new Graphics()
      for (const [top, depth, color, a] of [
        [0, 20, nearLit, 0.9],
        [20, 24, nearLit, 0.28],
        [44, 48, nearCast, 0.34],
        [92, 58, nearCast, 0.58],
        [150, 70, nearCast, 0.82],
        [220, 100, nearDeep, 0.72],
        [320, 140, nearDeep, 0.92],
        [460, 940, nearDeep, 1],
      ] as const) {
        plane.moveTo(0, floorLine(0) + top)
        for (let x = 12; x <= W; x += 12) plane.lineTo(x, floorLine(x) + top)
        for (let x = W; x >= 0; x -= 12) plane.lineTo(x, floorLine(x) + top + depth)
        plane.closePath().fill({ color, alpha: a })
      }
      // Erosion rills down the shoulder, raked along the key vector. Two dozen
      // hairlines is all it takes to stop a 300px-tall slope reading as paint,
      // and they run the same diagonal as every cast shadow in the event.
      const rills = new Graphics()
      for (let i = 0; i < 26; i++) {
        // Kept clear of both wrap seams: a rill that ran off the left edge of a
        // copy would show as a cut line every 1920px.
        const rx = 196 + i * 64 + ((i * 53) % 31)
        const top = floorLine(rx) + 40 + ((i * 97) % 90)
        const len = 120 + ((i * 61) % 200)
        rills.moveTo(rx, top)
          .quadraticCurveTo(rx - len * 0.22, top + len * 0.5, rx - len * 0.52, top + len)
      }
      rills.stroke({ color: nearRill, width: 5, alpha: 0.3, cap: 'round' })
      const edge = new Graphics()
      edge.moveTo(0, floorLine(0))
      for (let x = 10; x <= W; x += 10) edge.lineTo(x, floorLine(x))
      edge.stroke({ color: nearLine, width: nearLineW.width, alpha: nearLineW.alpha })
      c.addChild(g, plane, rills, edge)

      // Every standing thing throws one shadow, all of them the same way, all
      // of them long. This is the single pass that makes the sun mean anything.
      const shade = new Graphics()
      const art = new Graphics()
      for (const s of nearCacti) {
        const gy = floorLine(s.x) + 8
        castShadow(shade, s.x, gy, 96 * s.scale, 13 * s.scale, nearCast, 0.5)
      }
      for (const s of nearRocks) {
        castShadow(shade, s.x, floorLine(s.x) + 10, 34 * s.scale, 38 * s.scale, nearCast, 0.46)
      }
      for (const s of nearTufts) {
        castShadow(shade, s.x, floorLine(s.x) + 6, 16 * s.scale, 9 * s.scale, nearCast, 0.34)
      }
      castShadow(shade, 640, floorLine(640) + 6, 92, 62, nearCast, 0.5)
      castShadow(shade, 1560, floorLine(1560) + 6, 92, 66, nearCast, 0.5)
      c.addChild(shade)

      for (const s of nearTufts) {
        tuftClump(art, s.x, floorLine(s.x) + 6, s.scale, scrub, scrubLine, s.variant)
      }
      for (const s of nearRocks) {
        boulder(art, s.x, floorLine(s.x) + 10, s.scale, nearTint, nearLit, nearLine, nearLineW, s.variant)
      }
      for (const s of nearCacti) {
        saguaro(art, s.x, floorLine(s.x) + 8, s.scale, scrub, scrubLit, scrubLine, nearLineW, s.variant)
      }
      c.addChild(art)
      // Sponsor boards. The original plasters brands over everything and the
      // density is part of the period read, so ours get their own hoardings —
      // but they are pushed to the value of the dirt they stand on, because a
      // background sign is not allowed to out-rank the rider.
      c.addChild(this.banner(640, floorLine(640) + 6, 'SOLANA', nearLineW))
      c.addChild(this.banner(1560, floorLine(1560) + 6, 'DUSTLINE', nearLineW))
      return c
    }, { factorX: 0.34, factorY: 0.24, wrapWidth: W, copies: 3 })
  }

  /**
   * One depth ramp for the whole event.
   *
   * Saturation falls monotonically from the play plane to the horizon, value
   * barely moves, and the hue rotates toward the sky the band sits against so
   * the far distance reads as air rather than as faded paper.
   */
  private band(base: Hex, depth: number, screenT: number): Hex {
    const d = clamp01(depth)
    const sky = skyAt(this.pal, screenT)
    const out = grade(base, {
      satScale: 1 - 0.76 * d,
      valScale: 1 - 0.05 * d,
      hueShift: hueToward(base, sky, 0.55 * d),
      fog: sky,
      fogAmount: 0.12 * d + 0.46 * d * d,
    })
    // Backstop. Dissolving a low-chroma base into a saturated desert sky can
    // *raise* its saturation, which is precisely the depth inversion the review
    // found at the cactus line. A hard ceiling per depth makes the fall from
    // camera to horizon monotonic no matter what material goes in.
    const hsv = toHsv(out)
    const ceiling = 0.46 * (1 - 0.82 * d) + 0.015
    return hsv.s > ceiling ? fromHsv({ h: hsv.h, s: ceiling, v: hsv.v }) : out
  }

  /**
   * A roadside hoarding, demoted.
   *
   * It used to be paper white carrying the rider's own pink and cyan, which
   * made two pieces of background signage the second and third things the eye
   * found. The board is now a sun-bleached tan a few percent off the dirt
   * behind it, the lettering is dirt-coloured, and the whole thing is lit and
   * shaded like everything else. Text is built once per copy and never touched.
   */
  private banner(
    x: number, groundY: number, label: string,
    weight: { width: number; alpha: number },
  ): Container {
    const pal = this.pal
    const c = new Container()
    // Derived from the desert it stands on, not from the dirt of the berm: the
    // berm is the dark mass now, and a board cut from it would read as a hole
    // punched in the mid ground. Held within a few points of the value of the
    // dirt behind it either way — a white board was the second thing the eye
    // found in the last review.
    const board = this.band(grade(pal.mid, { valScale: 1.18, satScale: 0.62 }), 0.26, 0.58)
    const boardLit = mix(board, pal.light, 0.34)
    const ink = grade(this.band(pal.mid, 0.3, 0.58), { valScale: 0.6, satScale: 1.15 })
    const post = this.band(mix(pal.shade, pal.near, 0.35), 0.3, 0.6)
    const g = new Graphics()
    // Posts: the sun side is lit, the far side is not.
    g.rect(-6, -18, 8, 60).fill(post)
    g.rect(0, -18, 2, 60).fill(mix(post, pal.light, 0.35))
    g.rect(78, -18, 8, 60).fill(post)
    g.rect(84, -18, 2, 60).fill(mix(post, pal.light, 0.35))
    g.roundRect(-24, -74, 128, 58, 7).fill(board)
    // Terminator: the board's own top-right corner catches the key.
    g.roundRect(-24, -74, 128, 22, 7).fill({ color: boardLit, alpha: 0.75 })
    g.roundRect(-24, -74, 128, 58, 7).stroke({ color: ink, width: weight.width, alpha: weight.alpha * 0.7 })
    // The first of two echoes of the rider's hues.
    //
    // A review said the rider's saturated pixels were "a 25px cluster with no
    // echo anywhere else, so they read as a sticker pasted onto a landscape
    // rather than a rider in one". The answer is not to spread his colour
    // around — that would spend the reservation — but to put it in the world
    // once, sun-bleached and pushed back through the same depth ramp every
    // other background surface goes through. This strip is his pink at a third
    // of its chroma: recognisably the same hue, measurably not competing.
    g.roundRect(-16, -66, 112, 16, 4)
      .fill(grade(this.band(Core.hotPink, 0.52, 0.58), { valScale: 0.78, satScale: 1.05 }))
    c.addChild(g)
    const t = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: 'Anton, Archivo, system-ui, sans-serif',
        fontSize: 22, fill: ink, letterSpacing: 2,
      }),
    })
    t.anchor.set(0.5)
    t.alpha = 0.72
    t.position.set(40, -32)
    c.addChild(t)
    c.position.set(x, groundY)
    return c
  }

  /**
   * The near plane: the darkest mass in the frame, and the thing that crops it
   * at an angle.
   *
   * This is the correction to a previous pass that committed to one hue family
   * so hard the frame had no complement and no dark. A review measured it:
   *
   *   "B has no dark end. Give it a true near-black foreground silhouette layer
   *    (#14100E) cutting across the bottom — a ridge, a fence line, a berm
   *    edge — that both kills the dead lower 40% and finally gives the frame a
   *    full value range for the rider to sit against. A haze style without an
   *    anchoring silhouette is just fog."
   *
   * The previous version of this layer was already dark — L 0.11 — and still
   * read as fog, which is the part worth understanding: it sat five points off
   * the bottom of the berm in front of it, so its edge had nothing to be an
   * edge against, and it had no shape at all beyond a smooth dune shoulder. A
   * silhouette is not a value, it is a value AND a contour AND a lit edge.
   *
   * So: L 0.084 with the true black held for the last band before the frame
   * edge, against a berm face lifted to L 0.24; a broken line of revetment post
   * tops instead of a smooth curve; and one hot rim along the sunward edge,
   * which the posts interrupt. Two layers, the plants rooted at the bank so
   * they crop the picture rather than hiding beneath it.
   */
  private buildForeground(): void {
    const pal = this.pal
    // NEAR_BLACK, warmed by a tenth of the course dirt so it belongs to the
    // amber family without leaving the bottom of the value range. L 0.084 —
    // against a berm face at L 0.26 and a desert shoulder at L 0.44, which is
    // the separation that turns it from a vignette into a shape.
    const silhouette = mix(NEAR_BLACK, pal.near, 0.12)
    const silDeep = NEAR_BLACK
    // The rim is the whole trick. A black shape with a soft edge is fog; a
    // black shape with one hot line along its sunward edge is a silhouette, and
    // the line is the brightest thing in the lower half of the frame.
    const rimHot = mix(pal.light, Core.paperWhite, 0.4)
    const rimSoft = mix(silhouette, pal.light, 0.34)
    // Posts: the tops of the revetment logs holding the near bank up, sticking
    // proud of it at irregular heights. This is the "texture event" the lower
    // 40% had none of — the edge of the near plane is now a broken line of
    // uprights rather than a smooth dune shoulder, and it reads as built
    // ground, which is what a dirt-jump compound actually is.
    this.foreground.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      g.moveTo(0, duneEdge(0))
      for (let x = 40; x <= DUNE_WRAP; x += 40) g.lineTo(x, duneEdge(x))
      g.lineTo(DUNE_WRAP, 1460).lineTo(0, 1460).closePath().fill(silhouette)
      // The bank falls to true black at the bottom edge of the frame, so the
      // very last band of the picture is the darkest thing in it.
      g.moveTo(0, duneEdge(0) + 190)
      for (let x = 40; x <= DUNE_WRAP; x += 40) g.lineTo(x, duneEdge(x) + 190)
      g.lineTo(DUNE_WRAP, 1460).lineTo(0, 1460).closePath()
        .fill({ color: silDeep, alpha: 0.85 })

      // Revetment posts along the crest of the near bank.
      const posts = new Graphics()
      const caps = new Graphics()
      for (let px = 0; px < DUNE_WRAP; px += 34) {
        const h = hash32(px)
        if (h % 5 === 0) continue
        const top = duneEdge(px)
        const rise = 9 + (h % 33)
        const w = 17 + (h >> 6) % 9
        posts.moveTo(px, top + 30)
          .lineTo(px, top - rise)
          .lineTo(px + w, top - rise - 4)
          .lineTo(px + w, top + 30)
          .closePath()
        // Sun side of each cap: a 3px chip of light on the right-hand edge,
        // because the key is low and to the right and even a silhouette obeys.
        caps.moveTo(px + w - 4, top - rise - 3)
          .lineTo(px + w, top - rise - 4)
          .lineTo(px + w, top + 8)
          .lineTo(px + w - 4, top + 7)
          .closePath()
      }
      posts.fill(silhouette)
      caps.fill({ color: rimSoft, alpha: 0.5 })

      // The hot line, laid over the posts so it breaks the way the edge does.
      const rim = new Graphics()
      rim.moveTo(0, duneEdge(0) - 1)
      for (let x = 24; x <= DUNE_WRAP; x += 24) rim.lineTo(x, duneEdge(x) - 1)
      rim.stroke({ color: rimHot, width: 3, alpha: 0.75 })
      // Rim first, posts over it: the lit edge is BROKEN by the uprights
      // rather than ruled across them, which is the difference between a
      // silhouette and a stripe.
      c.addChild(g, rim, posts, caps)
      return c
    }, { factorX: 1.3, factorY: 0.36, wrapWidth: DUNE_WRAP, copies: 2 })

    const clumps = scatter({
      count: 5, from: -120, to: 2480, seed: 31337, scaleRange: [0.55, 1.25], variants: 3,
    })
    this.foreground.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      for (const s of clumps) {
        // Rooted on the near bank rather than 300px below the frame, so the
        // plants actually crop the picture instead of hiding under it.
        nearPlant(g, s.x, 1120, s.scale, silDeep, rimSoft, s.variant, s.jitter)
      }
      c.addChild(g)
      return c
    }, { factorX: 1.6, factorY: 0.44, wrapWidth: 2600, copies: 3 })
  }

  // ------------------------------------------------------------------ course
  private buildTiles(): void {
    for (let i = 0; i < TILE_COUNT; i++) {
      this.tiles.push({ dirt: new Graphics(), props: new Graphics(), span: Number.NaN })
    }
    // Every tile's dirt goes down before any tile's dressing, because adjacent
    // tiles overlap by a couple of samples and interleaving them would let one
    // tile's fill paint over its neighbour's pebbles.
    for (const t of this.tiles) this.world.addChild(t.dirt)
    for (const t of this.tiles) this.world.addChild(t.props)
  }

  /**
   * Keep the six tiles covering the camera. Tiles are addressed by span modulo
   * the ring size, so crossing a boundary reassigns exactly one of them; the
   * scene graph never grows no matter how far the course runs.
   */
  private refreshTiles(force = false): void {
    const first = Math.floor((this.x - 760) / TILE_W)
    let budget = force ? TILE_COUNT : 2
    for (let i = 0; i < TILE_COUNT; i++) {
      const span = first + i
      const t = this.tiles[((span % TILE_COUNT) + TILE_COUNT) % TILE_COUNT]
      if (t.span === span || budget <= 0) continue
      this.drawTile(t, span)
      budget--
    }
  }

  /**
   * Redraw one tile for a new span. Runs in update, never in render.
   *
   * This is the largest object in the frame, and it used to be a flat fill with
   * a scalloped edge on top of it — the single thing the review named first.
   * It is now built as a lit solid:
   *
   *   1. the body below the revetment, in four strata that fall away from the
   *      light toward the camera, so the bottom of the frame carries light
   *      logic instead of one unmodulated brown;
   *   2. an occlusion pool where the revetment meets the body;
   *   3. the revetment band and the crown split into lit / mid / shaded runs by
   *      the dot product of the surface normal with the key light, so the berm
   *      has a terminator wherever it turns away from the sun;
   *   4. tyre ruts along the riding line;
   *   5. dirt scatter down the face, and a cast shadow under every pebble,
   *      tuft and marker standing on it.
   */
  private drawTile(t: Tile, span: number): void {
    const course = this.course
    const d = this.dirt
    const g = t.dirt
    const p = t.props
    g.clear()
    p.clear()
    t.span = span

    const x0 = span * TILE_W
    const k0 = course.kFor(x0 - STEP * 2)
    const k1 = course.kFor(x0 + TILE_W + STEP * 2)
    if (k1 <= k0) return

    const line = depthOutline(0)

    // 1. The bulk of the berm. Four strata, sampled every third node because
    //    they are smooth and nobody can see the faceting at this depth.
    // The top stratum starts a few pixels *above* the revetment's own base so
    // the coarse sampling can never open a seam between the two.
    const strata: readonly (readonly [number, number, Hex])[] = [
      [BAND - 8, BAND + 58, d.bodyLit],
      [BAND + 58, BAND + 124, d.body],
      [BAND + 124, BAND + 196, d.bodyMid],
      [BAND + 196, BAND + 286, d.bodyLow],
      [BAND + 286, BAND + 400, d.bodyDeep],
      [BAND + 400, COURSE_FLOOR, d.bodyFloor],
    ]
    for (const [top, bottom, color] of strata) {
      g.moveTo(k0 * STEP, course.yK(k0) + top)
      for (let k = k0; k <= k1; k += 3) g.lineTo(k * STEP, course.yK(k) + top)
      g.lineTo(k1 * STEP, course.yK(k1) + top)
      if (bottom >= COURSE_FLOOR) {
        g.lineTo(k1 * STEP, COURSE_FLOOR).lineTo(k0 * STEP, COURSE_FLOOR)
      } else {
        g.lineTo(k1 * STEP, course.yK(k1) + bottom)
        for (let k = k1; k >= k0; k -= 3) g.lineTo(k * STEP, course.yK(k) + bottom)
        g.lineTo(k0 * STEP, course.yK(k0) + bottom)
      }
      g.closePath().fill(color)
    }

    // 2. Occlusion pool under the revetment. Two thin strips, because a hollow
    //    where two surfaces meet gathers darkness and a hairline does not.
    for (const [top, bottom, color] of [
      [BAND, BAND + 14, d.occlDeep], [BAND + 14, BAND + 34, d.occl],
    ] as const) {
      g.moveTo(k0 * STEP, course.yK(k0) + top)
      for (let k = k0; k <= k1; k += 2) g.lineTo(k * STEP, course.yK(k) + top)
      g.lineTo(k1 * STEP, course.yK(k1) + bottom)
      for (let k = k1; k >= k0; k -= 2) g.lineTo(k * STEP, course.yK(k) + bottom)
      g.closePath().fill(color)
    }

    // 3. The revetment band itself, with a scalloped bottom edge. This is the
    //    C64's log cross-section under the riding line, and it is the single
    //    strongest identity cue the event has. It takes the shaded tone, and
    //    the lit runs go on top of it in step 4.
    g.moveTo(k0 * STEP, course.yK(k0) + DECK)
    for (let k = k0; k <= k1; k++) g.lineTo(k * STEP, course.yK(k) + DECK)
    let px = k1 * STEP
    g.lineTo(px, course.yK(k1) + BAND)
    while (px > k0 * STEP) {
      const nx = Math.max(k0 * STEP, px - POST_W)
      const my = course.yAt((px + nx) / 2) + BAND + 8
      g.quadraticCurveTo((px + nx) / 2, my, nx, course.yAt(nx) + BAND)
      px = nx
    }
    g.closePath().fill(d.faceShade)

    // 4. Lit runs. One pass per tone class: contiguous stretches of surface
    //    whose normal faces the key get the lit tone, the rest keep the shade,
    //    and the boundary between them is the terminator.
    for (let cls = 1; cls <= 2; cls++) {
      // Inset into the face, which now begins at DECK. Clamped so a lit run can
      // never spill past the scalloped bottom of the band.
      const depthPx = Math.min(BAND - DECK, cls === 2 ? 74 : 52)
      let runStart = -1
      for (let k = k0; k <= k1 + 1; k++) {
        const on = k <= k1 && lightClass(course.angleK(k)) >= cls
        if (on && runStart < 0) runStart = k
        if (!on && runStart >= 0) {
          const end = k - 1
          if (end > runStart) {
            g.moveTo(runStart * STEP, course.yK(runStart) + DECK)
            for (let j = runStart + 1; j <= end; j++) g.lineTo(j * STEP, course.yK(j) + DECK)
            for (let j = end; j >= runStart; j--) g.lineTo(j * STEP, course.yK(j) + DECK + depthPx)
            g.closePath()
          }
          runStart = -1
        }
      }
      g.fill(cls === 2 ? d.faceLit : d.faceMid)
    }

    // 4b. The riding deck: the dirt plane the bike is actually on, between the
    //     tyres and the top of the logs. It is the one surface in the frame
    //     square to a low sun, so it is the brightest dirt tone — which is also
    //     what reads as a track rather than a ledge. Split by the same light
    //     classes so the terminator runs continuously from deck to face.
    for (let cls = 0; cls <= 2; cls++) {
      let runStart = -1
      for (let k = k0; k <= k1 + 1; k++) {
        const on = k <= k1 && lightClass(course.angleK(k)) === cls
        if (on && runStart < 0) runStart = k
        if (!on && runStart >= 0) {
          const end = k - 1
          if (end > runStart) {
            g.moveTo(runStart * STEP, course.yK(runStart))
            for (let j = runStart + 1; j <= end; j++) g.lineTo(j * STEP, course.yK(j))
            for (let j = end; j >= runStart; j--) g.lineTo(j * STEP, course.yK(j) + DECK)
            g.closePath()
          }
          runStart = -1
        }
      }
      g.fill(cls === 2 ? d.deckLit : cls === 1 ? d.deckMid : d.deckShade)
    }

    // 5. Post seams — two strokes per log, not one.
    //
    //    A single 2px hairline at 0.45 alpha on a 19-unit pitch is invisible at
    //    any size a reviewer looks at, which meant the revetment — the event's
    //    strongest identity cue and the only texture in the bottom third of the
    //    frame — was a flat band with faint scratches on it. A dark seam plus a
    //    lit sliver makes each log a cylinder, and a hundred and sixty
    //    cylinders across the frame is the texture event the dead zone wanted.
    const first = Math.ceil(k0 * STEP / POST_W) * POST_W
    for (let x = first; x < k1 * STEP; x += POST_W) {
      const sy = course.yAt(x)
      g.moveTo(x, sy + DECK + 4).lineTo(x, sy + BAND + 4)
    }
    g.stroke({ color: d.postLine, width: 3.4, alpha: 0.6 })
    for (let x = first; x < k1 * STEP; x += POST_W) {
      const sy = course.yAt(x + 5)
      g.moveTo(x + 5, sy + DECK + 8).lineTo(x + 5, sy + BAND - 4)
    }
    g.stroke({ color: d.postLit, width: 2.6, alpha: 0.42 })

    // 6. Tyre ruts. Two wandering grooves just inboard of the crest, which is
    //    where a dirt jumper's line actually polishes the dirt.
    for (const off of [26, 56] as const) {
      g.moveTo(k0 * STEP, course.yK(k0) + off)
      for (let k = k0; k <= k1; k += 2) {
        g.lineTo(k * STEP, course.yK(k) + off + Math.sin(k * 0.21 + off) * 1.8)
      }
      g.stroke({ color: d.rut, width: off === 26 ? 3.5 : 2.5, alpha: 0.42, cap: 'round' })
    }

    // 7. The crest: a dark seam under a sun-caught edge.
    //
    //    Two strokes, and between them they are the dominant line of the whole
    //    composition — the only continuous edge that crosses the frame, and the
    //    boundary where the dark near plane meets the mid desert. The rider
    //    rides along it, which is how he ends up on the strongest value break
    //    in the picture rather than in the middle of a mass.
    g.moveTo(k0 * STEP, course.yK(k0) + 5)
    for (let k = k0; k <= k1; k++) g.lineTo(k * STEP, course.yK(k) + 5)
    g.stroke({ color: d.crestSeam, width: line.width * 1.6, join: 'round', cap: 'round' })
    g.moveTo(k0 * STEP, course.yK(k0))
    for (let k = k0; k <= k1; k++) g.lineTo(k * STEP, course.yK(k))
    g.stroke({
      color: d.crest, width: line.width * 1.05, alpha: 0.82, join: 'round', cap: 'round',
    })

    // --- surface dressing ---------------------------------------------------
    // Placement is a pure hash of the sample index, so a tile redrawn for a new
    // span costs no random state and never flickers. Everything that stands on
    // the berm throws a shadow the same way the sun says it should.
    for (let k = k0; k <= k1; k++) {
      const h = hash32(k)
      const sx = k * STEP
      const sy = course.yK(k)

      // Dirt scatter down the open face. This is the texture the dead zone was
      // missing; it is two short strokes, and it costs nothing.
      //
      // Denser and heavier than it was. A reviewer measured a quarter of the
      // canvas "spending no information" and it was all down here: two-pixel
      // hairlines at 0.32 alpha survive being squinted at about as well as a
      // flat fill does, which is to say not at all.
      if ((h & 3) === 2) {
        const dy = BAND + 22 + ((h >> 4) % 330)
        const len = 9 + ((h >> 11) % 22)
        const tone = dy > BAND + 200 ? d.scatterDeep : d.scatter
        p.moveTo(sx, sy + dy).lineTo(sx + len, sy + dy + 3 + ((h >> 17) % 5))
        p.stroke({ color: tone, width: 3.5, alpha: 0.4, cap: 'round' })
      }
      // Erosion rills raking down the berm face along the key vector, so the
      // largest object in the frame carries the composition's diagonal all the
      // way to the bottom edge instead of stopping at the crest.
      if (h % 11 === 4) {
        const top = BAND + 30 + ((h >> 6) % 70)
        const len = 150 + ((h >> 13) % 260)
        p.moveTo(sx, sy + top)
          .quadraticCurveTo(sx - len * 0.2, sy + top + len * 0.5, sx - len * 0.48, sy + top + len)
        p.stroke({ color: d.rill, width: 6, alpha: 0.26, cap: 'round' })
      }

      if ((course.flagK(k) & (FLAG_DECK | FLAG_STEEP)) !== 0) continue
      const a = course.angleK(k)
      if (Math.abs(a) > 0.3) continue
      if (h % 29 === 3) {
        const r = 4 + (h >> 5) % 5
        castShadow(p, sx, sy + 1, r * 1.5, r * 1.4, d.cast, 0.4)
        p.ellipse(sx, sy - r * 0.55, r * 1.5, r).fill(d.pebble)
        p.ellipse(sx - r * 0.4, sy - r * 0.8, r * 0.8, r * 0.5).fill(d.pebbleLit)
        p.ellipse(sx, sy - r * 0.55, r * 1.5, r)
          .stroke({ color: d.pebbleLine, width: line.width * 0.6 })
      } else if (h % 41 === 7) {
        castShadow(p, sx, sy + 1, 17, 7, d.cast, 0.34)
        const blades = 3 + (h >> 9) % 3
        for (let i = 0; i < blades; i++) {
          const lean = -0.9 + i * (1.8 / blades)
          const bx = sx + i * 3 - 5
          const bh = 13 + ((h >> (3 * i)) % 9)
          p.moveTo(bx, sy + 1)
            .quadraticCurveTo(bx + Math.sin(lean) * 8, sy - bh * 0.55, bx + Math.sin(lean) * 15, sy - bh)
        }
        p.stroke({ color: d.tuft, width: 2.4, cap: 'round' })
      } else if (h % 71 === 19) {
        // Course marker, and the second echo of the rider's hues.
        //
        // These used to be burnt orange, which is the one colour in the frame
        // that reads as "more of the same". They are now the rider's cyan at
        // half chroma and half value: a line of little course flags, the only
        // other cool notes in the picture, running away along the berm he is
        // riding. A review said his saturated pixels "read as a sticker pasted
        // onto a landscape rather than a rider in one" — this is the landscape
        // answering back, quietly enough that the reservation still holds.
        castShadow(p, sx, sy + 1, 30, 8, d.cast, 0.46)
        p.rect(sx - 1.6, sy - 34, 3.2, 34).fill(d.markerLine)
        p.moveTo(sx + 1, sy - 34).lineTo(sx + 21, sy - 27).lineTo(sx + 1, sy - 19)
          .closePath().fill(d.marker)
        p.moveTo(sx + 1, sy - 34).lineTo(sx + 21, sy - 27).lineTo(sx + 11, sy - 27)
          .closePath().fill(d.markerLit)
        p.moveTo(sx + 1, sy - 34).lineTo(sx + 21, sy - 27).lineTo(sx + 1, sy - 19)
          .closePath().stroke({ color: d.markerLine, width: line.width * 0.7 })
      }
    }
  }

  // --------------------------------------------------------------------- hud
  //
  // Three blind reviews of three different events named the interface as the
  // loudest amateur signal in the frame, and this one got it verbatim:
  //
  //   "The HUD is placeholder art. Grey-brown rounded capsule bars on a flat
  //    translucent band, generic letterspaced caps, SCORE 1 hard against the
  //    right edge with no margin. It shares no shape language, no colour and no
  //    weight with the world beneath it. This is the single loudest amateur
  //    tell in the frame and it costs an hour."
  //
  // Every one of those was true and every one of them was self-inflicted: the
  // readouts were authored here, per event, in one-off geometry. They are now
  // `src/render/Hud.ts` — `themeFor(pal)` derives the plates from this event's
  // own palette so there is no neutral grey anywhere, `plate()` gives one body,
  // one radius and one lit top edge, `Readout` gives one label-over-value
  // shape, and everything sits on HUD_MARGIN. Six events, one interface.
  //
  // Two event-specific rules survive on top of the shared system:
  //
  //   1. The HUD may not use the rider's hues, and in this event it may not use
  //      the shared gold either. Colourfulness is how the eye and the scorer
  //      both find the player; a 0.77-chroma gold meter three hundred pixels
  //      from a 0.69-chroma rider is a second subject. Both meters take warm
  //      palette bone instead, and readiness is signalled by weight.
  //   2. Nothing here may be the brightest thing on screen.
  //
  private hint?: ControlHint

  private buildHud(): void {
    const pal = this.pal
    const t = themeFor(pal)

    // How to play. Four of the six events shipped without this; the menu
    // only explains how to drive the menu. It fades after nine seconds so it
    // does not become furniture.
    this.hint = new ControlHint(t, [{ key: 'DOWN', action: 'PRELOAD' }, { key: 'SPACE', action: 'GRAB' }, { key: 'LEFT / RIGHT', action: 'LEAN / SPIN' }])
    this.hud.addChild(this.hint.container)
    // One row, one margin, one baseline. The plates butt against each other on
    // a 14px gutter and every one of them is 74 tall, which is the whole grid.
    const TOP = 26
    const GUT = 14
    const M = HUD_MARGIN

    this.timeOut = new Readout(t, 'TIME', { width: 168 })
    this.timeOut.container.position.set(M, TOP)
    this.distOut = new Readout(t, 'DISTANCE', { width: 186 })
    this.distOut.container.position.set(M + 168 + GUT, TOP)

    // The meters live on a plate of their own rather than floating over the
    // playfield on a translucent bar, which is what they used to do.
    const mw = 252
    const meterPlate = plate(t, mw, 74)
    meterPlate.position.set(M + 168 + GUT + 186 + GUT, TOP)
    /** Warm bone, pulled from the event's own light. Never the shared gold. */
    const boneMeter = mix(Core.paperWhite, pal.light, 0.55)
    this.speedMeter = new Meter(t, 'SPEED', mw - 32, boneMeter)
    this.speedMeter.container.position.set(
      meterPlate.position.x + 16, TOP + 6,
    )
    this.popMeter = new Meter(t, 'POP', mw - 32, mix(pal.light, pal.accent2, 0.3))
    this.popMeter.container.position.set(
      meterPlate.position.x + 16, TOP + 40,
    )

    // Falls, on the same row, on the same gutter, at the same height as every
    // other plate — the grid is untouched and nothing that was already on it
    // moves. A rule the player cannot see is a rule they will not believe, and
    // "0 / 3" says the whole rule in four glyphs.
    this.fallsOut = new Readout(t, 'FALLS', { width: 150 })
    this.fallsOut.container.position.set(M + 168 + GUT + 186 + GUT + mw + GUT, TOP)

    this.scoreOut = new Readout(t, 'SCORE', { width: 268, align: 'right', valueSize: 40 })
    this.scoreOut.container.position.set(1920 - M - 268, TOP)

    this.hud.addChild(
      this.timeOut.container, this.distOut.container, meterPlate,
      this.speedMeter.container, this.popMeter.container, this.fallsOut.container,
      this.scoreOut.container,
    )

    // The call-out. It is NOT in the HUD's grid, because it does not belong to
    // the interface: it belongs to the rider. See `placeCallout`.
    this.callout = new Callout(62)
    this.hud.addChild(this.callout.container)

    this.flashQuad = new Sprite(softDot(Core.paperWhite, 64, 0.95))
    this.flashQuad.width = 1920
    this.flashQuad.height = 1080
    this.flashQuad.alpha = 0
    this.flashQuad.blendMode = 'add'
    this.hud.addChild(this.flashQuad)

    // The end panel is the same plate, at scale.
    const panel = plate(t, 660, 300)
    panel.position.set(-330, -150)
    const label = (size: number, color: Hex): TextStyle =>
      new TextStyle({
        fontFamily: 'Anton, Archivo, system-ui, sans-serif',
        fontSize: size, fill: color, letterSpacing: size * 0.04,
      })
    // The headline is the reason the run stopped, because those are two
    // different endings and a run that ended on the third fall should not be
    // told it ran out of time.
    this.overTitle = new Text({ text: 'TIME', style: label(88, t.value) })
    this.overTitle.anchor.set(0.5)
    this.overTitle.position.set(0, -78)
    this.overScore = new Text({ text: '0', style: label(66, t.value) })
    this.overScore.anchor.set(0.5)
    this.overScore.position.set(0, 4)
    // The shared prompt, so all six events say "play again" in one voice and
    // with one set of key chips rather than each inventing a sentence.
    const prompt = endPrompt(t, 'RIDE AGAIN')
    prompt.position.set(0, 84)
    this.overPanel.addChild(panel, this.overTitle, this.overScore, prompt)
    this.overPanel.position.set(960, 540)
    this.overPanel.visible = false
    this.hud.addChild(this.overPanel)

    this.results = new ResultsPanel(this.pal, 'BMX', RESULT_LABELS, RESULT_COLORS)
    this.results.setVisible(false)
    this.hud.addChild(this.results.container)
  }

  private resetRun(): void {
    this.results?.setVisible(false)
    this.bestAirH = 0
    this.bestSpinD = 0
    this.course.reset(0, 860)
    this.state = 'ride'
    this.startX = 200
    this.x = this.startX
    this.course.ensureTo(this.x + 4000)
    this.y = this.course.yAt(this.x)
    this.v = 420
    this.rot = this.course.angleAt(this.x)
    this.rotVel = 0
    this.yaw = 0
    this.yawVel = 0
    this.preload = 0
    this.popArmed = 0
    this.compress = 0
    this.crashTimer = 0
    this.crashes = 0
    this.sprawl = 0
    this.score = 0
    this.bestTrick = 0
    this.timeLeft = RUN_SECONDS
    this.over = false
    this.endedBy = 'time'
    this.overPanel.visible = false
    this.setTrick('', true, 0)
    this.shownSecond = -1
    this.shownScore = -1
    this.shownMetres = -1
    this.shownFalls = -1
    this.camY = this.y - CAM_Y
    this.prevCamY = this.camY
    this.prevX = this.x
    this.prevY = this.y
    this.prevRot = this.rot
    this.dust.clear()
    this.grit.clear()
    this.refreshTiles(true)
  }

  // ------------------------------------------------------------------ update
  update(dt: number, _tick: number): void {
    this.hint?.tick(dt)
    // The control legend and the end prompt are never on screen together: one
    // tells you how to ride, the other that riding is finished.
    if (this.over && this.hint) this.hint.container.visible = false
    const input = this.ctx.input
    this.prevX = this.x
    this.prevY = this.y
    this.prevRot = this.rot
    this.prevCamY = this.camY

    if (!this.over) {
      this.timeLeft = Math.max(0, this.timeLeft - dt)
      if (this.timeLeft === 0) this.endRun('time')
    }

    // Always keep terrain ready well past the right edge of the frame.
    this.course.ensureTo(this.x + 3400)

    switch (this.state) {
      case 'ride': this.updateRide(dt); break
      case 'air': this.updateAir(dt); break
      case 'crash': this.updateCrash(dt); break
    }

    // Wheels turn with the ground speed they last had; in the air they coast.
    const roll = this.state === 'air' ? Math.hypot(this.vx, this.vy) * 0.6 : this.v
    this.wheelAngle += (roll * dt) / WHEEL_R
    // Braking locks the rear: the wheel turns at a quarter of the ground speed.
    if (this.braking) this.wheelAngle -= (roll * dt * 0.75) / WHEEL_R
    this.wheelAngle %= TAU

    this.refreshTiles()
    this.updateCamera(dt)
    this.updateVisualPose(dt)
    this.updateAudio(dt)
    this.emitHaze(dt)

    this.trickTimer = Math.max(0, this.trickTimer - dt)
    this.callout.tick(dt)
    this.landingFlash = Math.max(0, this.landingFlash - dt * 3.4)
    this.landSquash = Math.max(0, this.landSquash - dt * 2.6)
    this.sky.update(dt)
    this.dust.update(dt)
    this.grit.update(dt)
    this.haze.update(dt)
    this.rider.update(dt, this.rotVel)

    if (this.over && input.justPressed(Action.Start)) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.resetRun()
    }
    if (input.justPressed(Action.Back)) this.ctx.goto('menu')
  }

  private updateRide(dt: number): void {
    const input = this.ctx.input
    const course = this.course
    const angle = course.angleAt(this.x)

    // Gravity along the tangent: the whole one-dimensional equation of motion
    // for a bead on a wire, exactly as the half pipe does it.
    this.v += GRAVITY * Math.sin(angle) * dt

    this.pedalling = false
    this.braking = false
    if (!this.over) {
      if (input.isDown(Action.Right)) {
        // Power tails off toward the ceiling so the bike has a real top speed
        // and the player has to use the terrain to go faster than it.
        //
        // The second term is a granny gear: at a crawl on a climbing face the
        // rider can always just out-push gravity. It is worth nothing at speed,
        // and it is what stops a mistimed jump from stranding the bike in the
        // bottom of a gap with no way out — a course you can get stuck in is
        // not a course.
        const climb = Math.max(0, -Math.sin(angle))
        const grind = GRAVITY * climb * 1.08 * (1 - clamp01(Math.abs(this.v) / 520))
        this.v += (PEDAL_ACCEL * (1 - clamp01(this.v / MAX_SPEED)) + grind) * dt
        this.pedalling = true
        this.ctx.perf.markResponse(input.lastRawPressTime)
      }
      if (input.isDown(Action.Left)) {
        this.v -= BRAKE_DECEL * dt
        this.braking = true
        this.ctx.perf.markResponse(input.lastRawPressTime)
        if (this.v > 90 && this.ctx.rng.chance(0.4)) this.kickDust(2, -1)
      }
    } else {
      this.v -= BRAKE_DECEL * 0.4 * dt
    }

    this.v *= Math.pow(ROLL_FRICTION, dt)
    this.v = clamp(this.v, -280, MAX_SPEED)

    this.updatePreload(dt)

    // --- leaving the ground -------------------------------------------------
    // A pop that found a lip wins outright. Otherwise the bead flies when the
    // centripetal acceleration the crest demands exceeds what gravity can
    // supply — which is why speed, and nothing else, turns a roller into a jump.
    if (this.popArmed > 0) {
      this.popArmed--
      const q = course.lipQuality(this.x)
      if (q > 0.42 || this.popArmed === 0) {
        this.lastPopQuality = q
        this.launch(POP_IMPULSE * this.popCharge * (0.3 + 0.7 * q))
        this.popArmed = 0
        return
      }
    }
    const kappa = course.curvatureAt(this.x)
    if (this.v > 300 && kappa > 0 && this.v * this.v * kappa > GRAVITY * Math.cos(angle) * 1.2) {
      this.lastPopQuality = 0
      this.launch(0)
      return
    }

    this.x += this.v * Math.cos(angle) * dt
    this.y = course.yAt(this.x)
    this.rot = this.bridgeAngle(this.x)

    // Tyres chew dirt whenever there is speed on them, and the rear breaks
    // loose when the rider stamps on it from low speed.
    if (this.v > 340 && this.ctx.rng.chance(this.v / 4200)) this.kickDust(1, -1)
    if (this.pedalling && this.v < 520 && this.ctx.rng.chance(0.22)) this.kickDust(1, -1)
  }

  /**
   * Preload and pop.
   *
   * Hold Down and the rider loads the bike; let go and the stored energy comes
   * back as an upward impulse. The release is *armed* rather
   * than fired, so letting go a few frames before the lip still counts — the
   * same forgiveness the engine's input buffer gives a button press, applied to
   * a release. Let the window lapse and it fires anyway as a weak bunny hop, so
   * the input is never simply swallowed.
   */
  private updatePreload(dt: number): void {
    const input = this.ctx.input
    if (this.over) { this.preload = Math.max(0, this.preload - PRELOAD_RATE * dt); return }

    const loading = input.isDown(Action.Down)
    if (loading) {
      if (input.justPressed(Action.Down)) this.ctx.perf.markResponse(input.lastRawPressTime)
      this.preload = Math.min(1, this.preload + PRELOAD_RATE * dt)
    }
    if (input.justReleased(Action.Down) && this.preload > 0.2) {
      this.popArmed = POP_WINDOW
      this.popCharge = this.preload
      this.ctx.perf.markResponse(input.lastRawPressTime)
      this.ctx.audio.noise({ duration: 0.09, cutoff: 1800, toCutoff: 520, gain: 0.07 })
    }
    if (!loading) this.preload = Math.max(0, this.preload - PRELOAD_RATE * 1.7 * dt)
  }

  /** Angle the frame actually sits at: the chord between the two contact points. */
  private bridgeAngle(x: number): number {
    const back = this.course.yAt(x - 44)
    const front = this.course.yAt(x + 44)
    return Math.atan2(front - back, 88)
  }

  private launch(normalImpulse: number): void {
    const course = this.course
    const angle = course.angleAt(this.x)
    this.y = course.yAt(this.x)
    this.vx = Math.cos(angle) * this.v
    this.vy = Math.sin(angle) * this.v
    // Mostly world-up with a little of the surface normal, so a pop off a steep
    // lip adds height on top of the speed the ramp already redirected rather
    // than fighting it.
    this.vx += Math.sin(angle) * normalImpulse * (1 - POP_UP)
    this.vy -= (POP_UP + Math.cos(angle) * (1 - POP_UP)) * normalImpulse

    this.state = 'air'
    this.rot = this.bridgeAngle(this.x)
    this.rotVel = 0
    this.yaw = 0
    this.yawVel = 0
    this.flip = 0
    this.rotKicked = false
    this.yawKicked = false
    this.grabHeld = 0
    this.tableTime = 0
    this.airTicks = 0
    this.launchY = this.y
    this.peakY = this.y
    this.launchKind = course.kindAt(this.x)
    this.preload = 0

    if (normalImpulse > 40) {
      this.ctx.audio.tone({
        freq: 190, toFreq: 320, duration: 0.13, type: 'triangle',
        gain: 0.06 + 0.06 * this.lastPopQuality,
      })
    }
    this.ctx.audio.noise({ duration: 0.2, cutoff: 3200, toCutoff: 700, gain: 0.1 })
    this.kickDust(6 + Math.round(6 * this.lastPopQuality), -1)
  }

  private updateAir(dt: number): void {
    const input = this.ctx.input
    this.airTicks++

    const ix = this.over ? 0 : input.axisX()
    const tucking = !this.over && input.isDown(Action.A)
    if (tucking) {
      this.grabHeld += dt
      if (input.justPressed(Action.A)) this.ctx.perf.markResponse(input.lastRawPressTime)
    }

    if (ix !== 0) {
      this.ctx.perf.markResponse(input.lastRawPressTime)
      // Tucked, the directions spin the bike about the vertical axis — a 360.
      // Untucked, they flip it in the plane of the screen. Same two buttons,
      // two different risks: a spin lands level, a flip has to come all the way
      // round, and the landing judge cares about both.
      if (tucking) {
        this.yawVel = torque(this.yawVel, ix, dt, this.yawKicked)
        this.yawKicked = true
      } else {
        this.rotVel = torque(this.rotVel, ix, dt, this.rotKicked)
        this.rotKicked = true
      }
    } else if (tucking) {
      this.tableTime += dt
    }

    this.rotVel = clamp(this.rotVel * Math.pow(0.52, dt), -FLIP_CAP, FLIP_CAP)
    this.yawVel = clamp(this.yawVel * Math.pow(0.52, dt), -FLIP_CAP, FLIP_CAP)
    this.rot += this.rotVel * dt
    this.flip += this.rotVel * dt
    this.yaw += this.yawVel * dt

    this.vy += GRAVITY * dt
    this.x += this.vx * dt
    this.y += this.vy * dt
    if (this.y < this.peakY) this.peakY = this.y
    // Run maxima for the results screen, recorded as they happen: nothing else
    // retains them once the trick resolves.
    const airH = this.launchY - this.peakY
    if (airH > this.bestAirH) this.bestAirH = airH
    const spinD = Math.abs((this.yaw * 180) / Math.PI)
    if (spinD > this.bestSpinD) this.bestSpinD = spinD

    const ground = this.course.yAt(this.x)
    if (this.airTicks > 2 && this.vy > 0 && this.y >= ground) this.land(ground)
  }

  /**
   * Landing judgment.
   *
   * Exactly the half pipe's test — how close is the bike's angle to the surface
   * it is meeting — with two additions the BMX needs: a spin also has to come
   * back round to square, and a landing can be bad purely because the impact is
   * flat and enormous (casing a drop), even with a perfect angle.
   */
  private land(groundY: number): void {
    const course = this.course
    const angle = course.angleAt(this.x)

    let diff = ((this.rot - angle + Math.PI) % TAU) - Math.PI
    if (diff < -Math.PI) diff += TAU
    const off = Math.abs(diff)

    let y = this.yaw % TAU
    if (y > Math.PI) y -= TAU
    if (y < -Math.PI) y += TAU
    const yawOff = Math.abs(y)

    // Velocity into the surface. This is the energy the legs have to eat.
    const impact = this.vy * Math.cos(angle) - this.vx * Math.sin(angle)

    if (off > 0.95 || yawOff > 1.0 || impact > 2050) { this.crash(); return }
    const clean = off < 0.34 && yawOff < 0.42 && impact < 1400

    this.state = 'ride'
    this.y = groundY
    this.rot = angle
    this.rotVel = 0
    this.yaw = 0
    this.yawVel = 0
    // Only the tangential component survives. Land square on a downslope and
    // you keep everything; huck onto flat ground and the drop is simply gone.
    this.v = (this.vx * Math.cos(angle) + this.vy * Math.sin(angle)) * (clean ? 0.97 : 0.64)
    this.v = clamp(this.v, -200, MAX_SPEED)
    this.preload = 0
    this.landSquash = clean ? 0.8 : 1
    this.lastAirHeight = Math.max(0, this.launchY - this.peakY)

    this.scoreTrick(clean)
    this.landingFlash = clean ? 1 : 0.35
    this.ctx.audio.noise({
      duration: 0.24, cutoff: clean ? 1600 : 900, toCutoff: 220,
      // `impact` is velocity *into* the surface, so a landing whose angle and
      // speed match the slope — the good one — computes zero or negative and
      // `clamp01` floors it to 0. Silence is the correct thud for it. This used
      // to crash: `exponentialRampToValueAtTime` rejects a target of 0, and
      // `AudioBus` took the whole game loop down rather than playing nothing.
      // The guard lives in `Audio.ts`; do not put a floor here, it would give
      // the softest landings a thud they have not earned.
      gain: clamp01(impact / 1500) * (clean ? 0.2 : 0.26),
    })
    if (clean && this.lastAirHeight > 90) {
      this.ctx.audio.tone({ freq: 420, toFreq: 660, duration: 0.15, type: 'triangle', gain: 0.09 })
    }
    this.kickDust(clean ? 9 : 6, -1)
  }

  /**
   * Build the trick name out of what the player actually did, the way the
   * original prints one on landing. Rotation, spin, table and airtime each
   * contribute a clause, and the clauses compose.
   */
  private scoreTrick(clean: boolean): void {
    const airH = this.lastAirHeight
    const airSec = this.airTicks / 60
    const flips = Math.round(Math.abs(this.flip) / TAU)
    const spins = Math.round(Math.abs(this.yaw) / TAU)

    let name = ''
    if (flips >= 1) {
      const dir = this.flip < 0 ? 'BACK FLIP' : 'FRONT FLIP'
      name = flips >= 3 ? `TRIPLE ${dir}` : flips === 2 ? `DOUBLE ${dir}` : dir
    }
    if (spins >= 1) {
      const deg = `${spins * 360}`
      name = name ? `${name} ${deg}` : deg
    }
    if (!name && this.tableTime > 0.2) name = 'TABLETOP'
    if (!name) name = airH > 340 ? 'HUGE AIR' : airH > 200 ? 'BIG AIR' : airH > 90 ? 'AIR' : ''

    let pts = airH * 0.85 + airSec * 70
    // Risk is what pays. A flip has to come all the way round and be checked;
    // a spin lands level whatever happens; a table costs nothing at all.
    pts += flips * (this.flip < 0 ? 780 : 660)
    pts += spins * 430
    pts += Math.min(this.tableTime, 1) * 120
    // Popping a real lip rather than floating off a roller is worth having.
    pts *= 1 + this.lastPopQuality * 0.35
    pts = Math.round(pts * (clean ? 1 : 0.42))

    if (pts > 0) {
      this.score += pts
      if (pts > this.bestTrick) this.bestTrick = pts
    }
    if (name) this.setTrick(clean ? name : `${name} — SKETCHY`, clean, 1.5)
  }

  /**
   * Show a trick name. Text and colour are written here rather than every
   * render frame, because assigning to a TextStyle re-lays out the glyphs.
   */
  private setTrick(name: string, clean: boolean, seconds: number): void {
    this.trickName = name
    this.trickClean = clean
    this.trickTimer = seconds
    if (!name) {
      this.callout.container.visible = false
      return
    }
    // Paper white for a landed trick, warm cream for a sketchy one or a crash.
    // Both sit on the same deep-ink drop shadow, which is what makes them the
    // highest-contrast thing on screen at the moment they appear — and both are
    // near-colourless, so neither can be mistaken for the rider's own hues.
    this.callout.show(name, clean ? Core.paperWhite : mix(Core.paperWhite, this.pal.accent2, 0.3))
  }

  /**
   * A fall, and possibly the last one.
   *
   * The state guard is what makes the count trustworthy: `land` is the only
   * caller, but a second call before the tumble finishes would otherwise book
   * two falls for one crash, and a miscounted third fall ends a run the player
   * did not lose. A crash after the run is over still *happens* — the sim runs
   * on behind the end panel and a rider frozen mid-air would be visible around
   * the panel's edges — it just does not count, so the readout cannot print
   * "4 / 3" next to a finished run.
   *
   * The original also ends a run instantly when the rider lands on his head.
   * That is NOT implemented: without the ambulance it is an abrupt stop with
   * no reading, and one invisible instant-loss condition undermines the three
   * falls the HUD is now promising.
   */
  private crash(): void {
    if (this.state === 'crash') return
    const rng = this.ctx.rng
    this.state = 'crash'
    this.crashTimer = 2.05
    if (!this.over) this.crashes++
    this.sprawl = 1
    this.rotVel = (this.vx >= 0 ? 1 : -1) * (5.2 + rng.range(0, 3.4))
    this.vx *= 0.52
    this.vy = Math.min(this.vy * 0.3, -170)
    this.v = 0
    this.preload = 0
    this.setTrick('CRASH', false, 1.6)
    this.landingFlash = 0.6
    this.ctx.audio.noise({ duration: 0.55, cutoff: 1100, toCutoff: 150, gain: 0.26 })
    this.ctx.audio.tone({ freq: 175, toFreq: 62, duration: 0.45, type: 'sawtooth', gain: 0.1 })
    this.kickDust(16, -1)
    this.grit.burst(14, () => ({
      x: this.x, y: this.y - 12,
      vx: rng.spread(340), vy: -rng.range(80, 420),
      life: rng.range(0.4, 0.95),
      size: rng.range(4, 10), sizeEnd: 2,
      alpha: 0.85, gravity: 1500, drag: 0.6, spin: rng.spread(9),
    }))
    // The third one is the end of the run. Same exit as the clock, so there is
    // one end-of-run path and the panel cannot disagree with itself.
    if (this.crashes >= MAX_FALLS) this.endRun('falls')
  }

  /** A real tumble: bounce, slide, then a beat where the rider gets back on. */
  private updateCrash(dt: number): void {
    this.crashTimer -= dt
    this.vy += GRAVITY * 0.92 * dt
    this.x += this.vx * dt
    this.y += this.vy * dt
    this.rot += this.rotVel * dt

    const ground = this.course.yAt(this.x)
    if (this.y >= ground) {
      this.y = ground
      if (this.vy > 150) {
        this.vy = -this.vy * 0.33
        this.vx *= 0.6
        this.rotVel *= 0.58
        this.ctx.audio.noise({ duration: 0.16, cutoff: 700, toCutoff: 160, gain: 0.12 })
        this.kickDust(5, -1)
      } else {
        this.vy = 0
        this.vx = damp(this.vx, 0, 0.0008, dt)
        this.rotVel = damp(this.rotVel, 0, 0.0008, dt)
      }
    }

    // The recovery beat: the rider picks the bike up and squares it to the
    // ground before rolling away, rather than blinking back into position.
    if (this.crashTimer < 0.85) {
      const t = 1 - Math.pow(0.0006, dt)
      this.rot = lerpAngle(this.rot, this.bridgeAngle(this.x), t)
      this.sprawl = damp(this.sprawl, 0, 0.0004, dt)
    }

    if (this.crashTimer <= 0) {
      this.state = 'ride'
      this.sprawl = 0
      this.y = this.course.yAt(this.x)
      this.rot = this.bridgeAngle(this.x)
      this.rotVel = 0
      this.yaw = 0
      this.v = 160
    }
  }

  /**
   * The one way a run ends. Both reasons come through here.
   */
  private endRun(reason: 'time' | 'falls' = 'time'): void {
    if (this.over) return
    this.over = true
    this.endedBy = reason
    this.overTitle.text = reason === 'falls' ? 'THREE FALLS' : 'TIME'
    this.setTrick('', true, 0)
    // The results screen replaces the over panel; the panel is still updated
    // because `overTitle` is what the capture gate reads for a finished run.
    this.overPanel.visible = false
    this.results.setTitle(`BMX  \u00b7  ${reason === 'falls' ? 'THREE FALLS' : "TIME'S UP"}`)
    this.results.show(ratingFor(this.score, RESULT_PAR), this.score)
    this.results.meters[0].set(clamp01(this.bestAirH / 260))
    this.results.meters[1].set(clamp01(this.bestSpinD / 720))
    this.results.meters[2].set(clamp01((this.x - this.startX) / 5200))
    this.results.meters[3].set(clamp01(1 - this.crashes / MAX_FALLS))
    this.results.setVisible(true)
    this.ctx.audio.tone({ freq: 660, toFreq: 330, duration: 0.5, type: 'triangle', gain: 0.12 })
  }

  private updateCamera(dt: number): void {
    const ground = this.course.yAt(this.x)
    // Follow the rider, but never let the ground leave the bottom of the frame
    // or climb into the middle of it. The limits are screen heights divided
    // back through the zoom, so pushing the camera in does not change framing.
    const target = clamp(
      this.y - CAM_Y,
      ground - GROUND_SCREEN_LOW / ZOOM,
      ground - GROUND_SCREEN_HIGH / ZOOM,
    )
    this.camY = damp(this.camY, target, 0.0016, dt)
  }

  /** Everything the rig needs that is smoothed rather than simulated. */
  private updateVisualPose(dt: number): void {
    const want = this.state === 'air'
      ? 0.3 + clamp01(this.grabHeld * 2.4) * 0.35
      : clamp01(this.preload * 0.9 + this.landSquash)
    this.compress = damp(this.compress, want, this.state === 'ride' ? 0.00008 : 0.0008, dt)
  }

  private updateAudio(dt: number): void {
    this.audioClock += dt
    if (this.audioClock < 1 / 15) return
    this.audioClock = 0
    const grounded = this.state !== 'air'
    const sp = clamp01(Math.abs(this.v) / MAX_SPEED)
    if (this.tyre) {
      this.tyre.setGain(grounded ? 0.012 + sp * 0.085 + (this.braking ? 0.05 : 0) : 0.003)
      this.tyre.setCutoff(240 + sp * 1500 + (this.braking ? 1100 : 0))
    }
    if (this.wind) this.wind.setGain(this.state === 'air' ? 0.03 + sp * 0.04 : 0.016)
  }

  /** Dust off the tyres. `dir` is the direction it is thrown, -1 = behind. */
  private kickDust(amount: number, dir: number): void {
    const rng = this.ctx.rng
    const pal = this.pal
    this.dust.burst(Math.max(1, Math.round(amount)), () => ({
      x: this.x + dir * 24 + rng.spread(14),
      y: this.y - 6,
      vx: dir * rng.range(50, 230) + rng.spread(50),
      vy: -rng.range(20, 150),
      life: rng.range(0.4, 1.05),
      size: rng.range(14, 40), sizeEnd: 6,
      // Dust is lit dirt hanging in a low sun: it is the one thing on the near
      // plane allowed to be brighter than the dirt it came off.
      color: mix(pal.near, pal.light, rng.range(0.38, 0.8)),
      alpha: 0.5, gravity: 190, drag: 0.3,
    }))
  }

  /** Slow heat haze drifting across the frame, in screen space. */
  private emitHaze(dt: number): void {
    this.hazeClock += dt
    if (this.hazeClock < 0.38) return
    this.hazeClock = 0
    const rng = this.ctx.rng
    this.haze.emit({
      x: 1990, y: rng.range(250, 700),
      vx: -rng.range(30, 90), vy: -rng.range(4, 20),
      life: rng.range(6, 11),
      size: rng.range(120, 300), sizeEnd: rng.range(200, 420),
      alpha: 0.05, alphaEnd: 0,
    })
  }

  // ------------------------------------------------------------------ render
  render(alpha: number): void {
    const x = lerp(this.prevX, this.x, alpha)
    const y = lerp(this.prevY, this.y, alpha)
    const rot = lerpAngle(this.prevRot, this.rot, alpha)
    const camY = lerp(this.prevCamY, this.camY, alpha)

    // The world is scaled, so the camera offset has to be scaled with it or the
    // rider slides off the anchor point as soon as the zoom changes.
    this.world.position.set(CAM_X - x * ZOOM, -camY * ZOOM)
    this.parallax.scrollTo(x * ZOOM, (camY - NOMINAL_CAM_Y) * ZOOM)
    this.foreground.scrollTo(x * ZOOM, (camY - NOMINAL_CAM_Y) * ZOOM)

    // Two shadows under the bike, because it needs both.
    //
    // The soft pool carries the bike's mass and spreads as it climbs, which is
    // the height cue. The hard tyre ellipses are the actual contact: they sit
    // in the surface, rake with the key light, and vanish the instant the
    // wheels leave the dirt. Without the hard pair the bike floats, which is
    // what the review said it did.
    const gap = Math.max(0, this.course.yAt(x) - y)
    const airGap = clamp01(gap / 420)
    // The shadow rakes away from the sun as the bike climbs, and it lands on
    // whatever dirt is under *that* point, not under the wheels. The factor is
    // well under RAKE_X: at this sun angle a literal rake would throw the
    // bike's shadow a third of a frame away at the top of a jump, which reads
    // as a second object rather than as the rider's own shadow.
    const shadowX = x + gap * RAKE_X * 0.22
    const shadowY = this.course.yAt(shadowX)
    const surface = this.course.angleAt(shadowX)
    this.contact.place(shadowX, shadowY + 6, gap, surface)
    this.tyreShadow.position.set(shadowX, shadowY + 3)
    this.tyreShadow.rotation = surface
    this.tyreShadow.scale.set(1 + airGap * 0.4, 1 - airGap * 0.5)
    this.tyreShadow.alpha = 0.85 * (1 - airGap)

    // In a tumble the rig pivots about the body, not the wheel contact point,
    // or the whole bike reads as pinned to the ground and spinning.
    this.rider.container.position.set(x, y - 34 * this.sprawl)
    this.rider.container.rotation = rot
    const airborne = this.state === 'air'
    const p = this.pose
    p.compress = this.compress
    p.lean = airborne ? clamp(this.rotVel * 0.04, -0.3, 0.3) : clamp(this.v / 5200, -0.2, 0.26)
    p.table = airborne ? clamp01(this.tableTime * 4) : 0
    p.tuck = airborne ? clamp01(this.grabHeld * 3) : 0
    p.sprawl = this.sprawl
    p.wheel = this.wheelAngle
    p.yaw = this.yaw
    this.rider.setPose(p)
    this.rider.apply()

    // The call-out hangs off the rider's chest, not off the centre of the sky.
    this.placeCallout(x, y - 96)
    this.renderHud()
  }

  private renderHud(): void {
    const whole = Math.floor(this.timeLeft)
    if (whole !== this.shownSecond) {
      this.shownSecond = whole
      const secs = whole % 60
      this.timeOut.set(`${Math.floor(whole / 60)}:${secs < 10 ? '0' : ''}${secs}`)
    }
    if (this.score !== this.shownScore) {
      this.shownScore = this.score
      const text = this.score.toLocaleString('en-US')
      this.scoreOut.set(text)
      this.overScore.text = text
    }
    const metres = Math.max(0, Math.round((this.x - this.startX) / 20))
    if (metres !== this.shownMetres) {
      this.shownMetres = metres
      this.distOut.set(`${metres} m`)
    }
    if (this.crashes !== this.shownFalls) {
      this.shownFalls = this.crashes
      this.fallsOut.set(`${this.crashes} / ${MAX_FALLS}`)
    }

    // Speed above, pop below, both on the shared meter. Neither ever renders
    // empty — "nothing reads worse than instrumentation at rest" — and neither
    // carries a chroma that could compete with the rider for the eye. The one
    // dynamic cue left is weight: the pop meter comes up to full strength the
    // instant the dirt under the wheels is worth popping off, which is how the
    // timing window gets taught without a word of tutorial.
    this.speedMeter.set(clamp01(Math.abs(this.v) / MAX_SPEED))
    const lip = this.state === 'ride' ? this.course.lipQuality(this.x) : 0
    this.popMeter.set(this.preload)
    this.popMeter.container.alpha = lip > 0.5 ? 1 : 0.55

    this.flashQuad.alpha = this.landingFlash * 0.1
  }

  /**
   * Put the call-out on the rider.
   *
   * "'CRASH' is floating. Centred in empty sky, nowhere near the crash, in a
   * muddy burnt orange that sits only a step or two off the sky it's printed
   * on." Three separate faults, all of them fixed by the same move: feedback
   * belongs to the thing it describes, so `Callout` anchors to a world point,
   * draws a leader back toward it and carries a hard offset shadow. The face is
   * paper white on deep ink — the highest-contrast pair available and, being
   * almost colourless, the one that cannot steal the rider's reservation.
   *
   * The rider lives inside the rolled, overscanned stage and the call-out does
   * not, so the anchor is transformed by hand. That transform is exact and
   * writes no allocations:
   *
   *     stage = world.position + p * ZOOM
   *     screen = C + STAGE_SCALE * R(STAGE_TILT) * (stage - C)
   */
  private placeCallout(x: number, y: number): void {
    if (!this.callout.active) return
    const px = this.world.position.x + x * ZOOM - STAGE_CX
    const py = this.world.position.y + y * ZOOM - STAGE_CY
    const sx = STAGE_CX + STAGE_SCALE * (px * STAGE_COS - py * STAGE_SIN)
    const sy = STAGE_CY + STAGE_SCALE * (px * STAGE_SIN + py * STAGE_COS)
    // Up and to the sunward side, then held inside the frame so a call-out at
    // the edge of the course never prints half off the canvas — and never up
    // into the HUD row, which is the other way text ends up belonging to the
    // interface rather than to the rider.
    const offX = sx > 1180 ? -260 : 240
    this.callout.placeAt(
      clamp(sx, 320, 1600), clamp(sy, 340, 900), offX, -180,
    )
  }

  resize(width: number, height: number): void {
    this.sky.resize(width, height)
  }

  exit(): void {
    const cg = (window as unknown as Record<string, unknown>).__cg as
      Record<string, unknown> | undefined
    if (cg) { delete cg.bmxFalls; delete cg.bmxResults }
    this.tyre?.stop(0.2)
    this.wind?.stop(0.3)
    this.tyre = null
    this.wind = null
    this.dust.clear()
    this.grit.clear()
    this.haze.clear()
  }

  debug(): Record<string, unknown> {
    return {
      // Is the control legend still on screen? The capture gate needs this:
      // three blind reviews were spent on a frame with a tutorial bar across
      // the player, and a wall-clock delay is wrong under software rendering
      // where the simulation advances far slower than the clock.
      // `over` is part of it: the legend is replaced by the end prompt, and a
      // gate that only asked the legend would think it was still up.
      hintUp: (this.hint?.visible ?? false) && !this.over,
      state: this.state,
      speed: Math.round(this.v),
      distance: Math.round(this.x - this.startX),
      groundY: Math.round(this.course.yAt(this.x)),
      airHeight: this.state === 'air'
        ? Math.round(this.launchY - this.peakY)
        : Math.round(this.lastAirHeight),
      rotationDeg: Math.round((this.rot * 180) / Math.PI),
      flipDeg: Math.round((this.flip * 180) / Math.PI),
      spinDeg: Math.round((this.yaw * 180) / Math.PI),
      preload: Math.round(this.preload * 100) / 100,
      pedalling: this.pedalling,
      braking: this.braking,
      lipQuality: Math.round(this.course.lipQuality(this.x) * 100) / 100,
      feature: FEATURE_NAMES[this.course.kindAt(this.x)] ?? '?',
      launchedFrom: FEATURE_NAMES[this.launchKind] ?? '?',
      lastTrick: this.trickName,
      lastTrickClean: this.trickClean,
      score: this.score,
      bestTrick: this.bestTrick,
      crashes: this.crashes,
      falls: this.crashes,
      maxFalls: MAX_FALLS,
      timeLeft: Math.round(this.timeLeft * 10) / 10,
      over: this.over,
      endedBy: this.over ? this.endedBy : '',
    }
  }
}

// ---------------------------------------------------------------------------
// Backdrop geometry. Every profile is a sum of sines whose periods divide the
// 1920px wrap width, so the wrapping parallax copies meet without a seam.
// ---------------------------------------------------------------------------
const W = 1920
const wave = (x: number, n: number, phase: number): number => Math.sin((x / W) * TAU * n + phase)

// Stage heights, authored for the settled camera, where the course surface sits
// at stage y 570.
//
// The horizon used to sit within a few pixels of the vertical midpoint, which a
// neutral critic named first: a frame cut exactly in half has no dominant mass
// and no dominant direction. It is now at roughly 28% of frame height, which
// leaves a light sky across the top quarter, a mid stage of open desert through
// the middle, and the dark berm owning the bottom 45%. Amplitudes are up too,
// because a skyline that wobbles by 40px over 1920 reads as a ruled line.
const farRidge = (x: number): number =>
  316 + wave(x, 2, 0.4) * 48 + wave(x, 5, 2.1) * 20 + wave(x, 11, 0.9) * 8

const midRidge = (x: number): number =>
  372 + wave(x, 3, 1.7) * 30 + wave(x, 7, 0.3) * 13 + wave(x, 13, 2.6) * 6

const nearRidge = (x: number): number =>
  408 + wave(x, 2, 2.9) * 22 + wave(x, 6, 1.1) * 10 + wave(x, 17, 0.2) * 5

const floorLine = (x: number): number =>
  452 + wave(x, 3, 0.8) * 13 + wave(x, 9, 2.4) * 6

/** Wrap period of the near dune. Long, so its edge reads as a ramp, not a hump. */
const DUNE_WRAP = 5200

/**
 * The near dune's top edge.
 *
 * A long climb to the right and a short return, so the 1920-wide window is
 * almost always looking at a monotonic diagonal. This is the "near-plane
 * occluder that crops the frame at an angle" the neutral review asked for: it
 * is the darkest shape in the picture, it cuts the bottom corner rather than
 * lying flat under it, and its slope runs the same way as the raking light.
 *
 * `duneEdge(0)` and `duneEdge(DUNE_WRAP)` are identical, so the wrapping copies
 * meet without a step.
 */
const duneEdge = (x: number): number => {
  const u = (((x % DUNE_WRAP) + DUNE_WRAP) / DUNE_WRAP) % 1
  const rise = 0.74
  const h = u < rise ? u / rise : 1 - (u - rise) / (1 - rise)
  // Break-up, scaled by the ramp height so it vanishes at the seam.
  const ripple = Math.sin(u * TAU * 3) * 14 + Math.sin(u * TAU * 7 + 1.2) * 6
  // The trough is below the frame edge everywhere, the peak crops the bottom
  // fifth of it, and the roll means the right-hand side of the frame sees more
  // of the dune than the left — which is the side the light is coming from.
  return 1120 - h * 330 - ripple * h
}

// ---------------------------------------------------------------------------
// Light
//
// One vector, obeyed by everything. The sun is drawn upper-right, so the
// surface-to-sun direction is (+LIGHT_X, -LIGHT_Y) and shadows rake down-left.
// ---------------------------------------------------------------------------

/**
 * 0 = facing away from the key, 1 = across the terminator, 2 = full light.
 *
 * Thresholds are calibrated to the LOW sun, which changes what the berm looks
 * like completely. Flat dirt only returns 0.37 of the light now, so the crown
 * of the course sits in shade and the near plane holds together as one dark
 * mass; the faces that blaze are the ones tipped toward the sun, which on a
 * dirt-jump course means the landing ramps and the backs of the rollers. The
 * rider therefore launches out of shadow and into light, and the brightest
 * patch of ground in the lower half of the frame is the one he is aimed at.
 */
function lightClass(angle: number): number {
  const lambert = LIGHT_X * Math.sin(angle) + LIGHT_Y * Math.cos(angle)
  return lambert > 0.70 ? 2 : lambert > 0.43 ? 1 : 0
}

/**
 * A cast shadow on a ground plane.
 *
 * Every standing thing in the event goes through this, so all of them rake the
 * same way and the frame reads as having one sun rather than none.
 */
function castShadow(
  g: Graphics, x: number, groundY: number, height: number, halfWidth: number,
  color: Hex, alpha: number,
): void {
  const dx = height * RAKE_X
  const dy = height * RAKE_Y
  const tipW = halfWidth * 0.5
  g.moveTo(x - halfWidth, groundY)
    .lineTo(x + halfWidth, groundY)
    .lineTo(x + dx + tipW, groundY + dy)
    .lineTo(x + dx - tipW, groundY + dy)
    .closePath()
    .fill({ color, alpha })
}

/**
 * Sunlit runs along a ridge profile.
 *
 * Adds one closed polygon per stretch of ridge that falls away to the right,
 * i.e. that is turned toward the key. The caller fills them in one pass, so a
 * whole mountain range gets a terminator for a single draw.
 */
function ridgeLitRuns(
  g: Graphics, profile: (x: number) => number, step: number, depth: number,
): void {
  let runStart = -1
  for (let x = 0; x <= W + step; x += step) {
    const slope = profile(Math.min(x + step, W)) - profile(Math.min(x, W))
    const on = x <= W && slope > 0
    if (on && runStart < 0) runStart = x
    if (!on && runStart >= 0) {
      const end = x - step
      if (end > runStart) {
        g.moveTo(runStart, profile(runStart))
        for (let j = runStart + step; j <= end; j += step) g.lineTo(j, profile(j))
        for (let j = end; j >= runStart; j -= step) g.lineTo(j, profile(j) + depth)
        g.closePath()
      }
      runStart = -1
    }
  }
}

/**
 * Hue rotation, in degrees, that carries `base` part of the way to `toward`.
 *
 * Capped in proportion to `amount`, because the arc from desert tan to desert
 * sky is 175 degrees and taking a quarter of it literally would turn the mesas
 * olive. The cap still rises with depth, so the cooling stays monotonic.
 */
function hueToward(base: Hex, toward: Hex, amount: number): number {
  const a = toHsv(base)
  const b = toHsv(toward)
  if (a.s < 0.02 || b.s < 0.02) return 0
  const d = ((b.h - a.h + 540) % 360) - 180
  const cap = 36 * amount
  return clamp(d * amount, -cap, cap)
}

// ---------------------------------------------------------------------------
// Dirt
// ---------------------------------------------------------------------------

/**
 * Every tone the berm is drawn from, derived once from the key light.
 *
 * `shadePair` gives the two values every surface needs; everything else here is
 * a step on the ramp between the lit crown and the deep occlusion under the
 * revetment, so the bottom of the frame is a falloff instead of a fill.
 */
interface DirtTones {
  faceLit: Hex; faceMid: Hex; faceShade: Hex
  deckLit: Hex; deckMid: Hex; deckShade: Hex
  bodyLit: Hex; body: Hex; bodyMid: Hex; bodyLow: Hex; bodyDeep: Hex; bodyFloor: Hex
  occl: Hex; occlDeep: Hex
  crest: Hex; crestSeam: Hex; postLine: Hex; postLit: Hex; rut: Hex; cast: Hex
  scatter: Hex; scatterDeep: Hex; rill: Hex
  pebble: Hex; pebbleLit: Hex; pebbleLine: Hex
  tuft: Hex
  marker: Hex; markerLit: Hex; markerLine: Hex
}

/**
 * The berm's tones, and the dark third of the value plan.
 *
 * Measured in perceptual luminance, everything here lands between L 0.13 and
 * L 0.35 apart from three deliberate exceptions — the sunlit lip runs, the caps
 * of the pebbles and the crest line — which is what "a dark near plane with a
 * rationed contrast budget" means numerically. The mean of the whole set is
 * L 0.27 against L 0.50 for the desert behind it and L 0.75 for the sky, so the
 * three masses survive being squinted down to pure luminance.
 */
function dirtTones(pal: EventPalette, key: KeyLight): DirtTones {
  const { lit, shade } = shadePair(pal.near, key)
  // A low sun widens the pair. `shadePair` is calibrated for a key overhead,
  // and its +10 / -26 percent split is not enough separation to hold a value
  // plan when the light is grazing: the faces it catches go hot, and the faces
  // it misses get nothing but skylight.
  const faceLit = mix(grade(lit, { valScale: 1.34, satScale: 0.84 }), key.tint, 0.16)
  // Lifted from 1.06 to 1.22. The crown is the surface the bike actually
  // stands on, and at L 0.16 it was within five points of every shadow tone in
  // the file — so the contact shadow, which is the cheapest and most-asked-for
  // fix in the whole project, was invisible on the one object that needs it.
  const faceShade = grade(shade, { valScale: 1.22, satScale: 0.98 })
  // Lifted from valScale 0.74 to 1.06. The body used to sit at L 0.16 — inside
  // five points of the near plane in front of it — so the foreground silhouette
  // had nothing to be a silhouette *against*, and the two of them measured as
  // one unbroken dark mass filling the bottom 40% of the frame. The berm is now
  // the MID-dark step: L 0.24 at the top of the body falling to L 0.14 at the
  // floor, with the true black reserved for the near plane alone.
  const body = grade(pal.near, { valScale: 1.06, satScale: 1.08 })
  // The rider's cyan, half its chroma and half its value: course flags, and the
  // only other cool note in the frame. See the marker block in `drawTile`.
  const marker = grade(Core.electricCyan, { satScale: 0.6, valScale: 0.56 })
  return {
    faceLit,
    faceMid: mix(faceLit, faceShade, 0.54),
    faceShade,
    // The deck faces the sky, so it takes more light than any vertical face on
    // the berm. This is what separates "a track" from "the top of a wall".
    deckLit: mix(grade(faceLit, { valScale: 1.16, satScale: 0.92 }), key.tint, 0.2),
    deckMid: grade(faceLit, { valScale: 1.02, satScale: 0.96 }),
    deckShade: mix(faceLit, faceShade, 0.42),
    // The body falls away from the light toward the camera in six steps rather
    // than four, over a wider range. Both changes are about the same number: a
    // quarter of the canvas measured as flat, and a four-step ramp inside ten
    // points of luminance is flat however many polygons it is made of.
    bodyLit: mix(body, faceLit, 0.34),
    body,
    bodyMid: mix(grade(body, { valScale: 0.84, satScale: 1.06 }), pal.shade, 0.14),
    bodyLow: mix(grade(body, { valScale: 0.7, satScale: 1.1 }), pal.shade, 0.26),
    bodyDeep: mix(grade(body, { valScale: 0.56, satScale: 1.12 }), pal.shade, 0.44),
    bodyFloor: mix(grade(body, { valScale: 0.46, satScale: 1.12 }), pal.shade, 0.6),
    occl: mix(faceShade, pal.shade, 0.55),
    occlDeep: grade(mix(faceShade, pal.shade, 0.82), { valScale: 0.78, satScale: 1.15 }),
    // The crest used to be a dark line on light dirt. Under a grazing sun it is
    // the opposite: the top few pixels of the berm are the only part of it
    // square to the light, so the course draws itself across the frame as a
    // bright edge over a dark seam. It is the strongest line in the picture and
    // it goes wherever the terrain goes, which is the diagonal this event owns.
    crest: mix(faceLit, pal.light, 0.34),
    crestSeam: grade(mix(faceShade, pal.shade, 0.5), { valScale: 0.7, satScale: 1.1 }),
    postLine: grade(faceShade, { valScale: 0.6, satScale: 1.15 }),
    /** The sun side of each log. Two values per surface, applied 160 times. */
    postLit: mix(grade(faceShade, { valScale: 1.55, satScale: 0.88 }), pal.light, 0.18),
    rut: grade(faceShade, { valScale: 1.42, satScale: 0.86 }),
    cast: grade(mix(faceShade, pal.shade, 0.6), { valScale: 0.9, satScale: 1.15 }),
    scatter: grade(body, { valScale: 1.34, satScale: 0.86 }),
    scatterDeep: grade(body, { valScale: 1.12, satScale: 0.96 }),
    rill: grade(mix(body, pal.shade, 0.4), { valScale: 0.66, satScale: 1.15 }),
    pebble: grade(pal.near, { valScale: 1.22, satScale: 0.9 }),
    pebbleLit: mix(grade(pal.near, { valScale: 1.5, satScale: 0.78 }), pal.light, 0.34),
    pebbleLine: grade(pal.near, { valScale: 0.58, satScale: 1.2 }),
    tuft: grade(pal.accent, { valScale: 1.12, satScale: 0.8 }),
    marker,
    markerLit: mix(marker, pal.light, 0.3),
    markerLine: grade(marker, { valScale: 0.6, satScale: 1.15 }),
  }
}

// ---------------------------------------------------------------------------
// Scenery
//
// All three draw into a Graphics the caller owns rather than returning a
// Container each. One Graphics per parallax copy instead of one per plant keeps
// the scene graph flat, and it is what lets a band be scattered densely without
// spending nodes.
//
// Each takes a `variant` so a band can hold three silhouettes rather than one
// stamp repeated, and a lit tone so every shape has a plane facing the sun.
// ---------------------------------------------------------------------------

type Weight = { width: number; alpha: number }

/** A flat-topped mesa. Stepped sides, because sheer ones read as a box. */
function butte(
  g: Graphics, x: number, groundY: number, w: number, h: number,
  fill: Hex, lit: Hex, ink: Hex, weight: Weight,
): void {
  const hw = w / 2
  g.moveTo(x - hw, groundY)
    .lineTo(x - hw * 0.84, groundY - h * 0.42)
    .lineTo(x - hw * 0.66, groundY - h * 0.5)
    .lineTo(x - hw * 0.58, groundY - h)
    .lineTo(x + hw * 0.5, groundY - h * 0.96)
    .lineTo(x + hw * 0.62, groundY - h * 0.56)
    .lineTo(x + hw * 0.88, groundY - h * 0.44)
    .lineTo(x + hw, groundY)
    .closePath()
    .fill(fill)
  // The sun side. A terminator down a mesa is most of what stops it reading
  // as a cut-out.
  g.moveTo(x + hw * 0.06, groundY - h * 0.98)
    .lineTo(x + hw * 0.5, groundY - h * 0.96)
    .lineTo(x + hw * 0.62, groundY - h * 0.56)
    .lineTo(x + hw * 0.88, groundY - h * 0.44)
    .lineTo(x + hw, groundY)
    .lineTo(x + hw * 0.2, groundY)
    .closePath()
    .fill({ color: lit, alpha: 0.9 })
  g.moveTo(x - hw, groundY)
    .lineTo(x - hw * 0.84, groundY - h * 0.42)
    .lineTo(x - hw * 0.66, groundY - h * 0.5)
    .lineTo(x - hw * 0.58, groundY - h)
    .lineTo(x + hw * 0.5, groundY - h * 0.96)
    .lineTo(x + hw * 0.62, groundY - h * 0.56)
    .lineTo(x + hw * 0.88, groundY - h * 0.44)
    .lineTo(x + hw, groundY)
    .closePath()
    .stroke({ color: ink, width: weight.width, alpha: weight.alpha, join: 'round' })
}

/**
 * Saguaro. Three silhouettes: two-armed, one high left arm, one stubby barrel.
 * Height varies with the variant as well as the scale, so a scattered band does
 * not read as one plant at three sizes.
 */
function saguaro(
  g: Graphics, x: number, groundY: number, scale: number,
  fill: Hex, lit: Hex, ink: Hex, weight: Weight, variant: number,
): void {
  const s = scale
  const h = (variant === 2 ? 58 : variant === 1 ? 104 : 92) * s
  const tw = (variant === 2 ? 13 : 9) * s
  const X = (v: number): number => x + v * s
  g.moveTo(x - tw, groundY + 4 * s)
    .lineTo(x - tw, groundY - h + 10 * s)
    .quadraticCurveTo(x - tw, groundY - h, x, groundY - h)
    .quadraticCurveTo(x + tw, groundY - h, x + tw, groundY - h + 10 * s)
    .lineTo(x + tw, groundY + 4 * s)
    .closePath()
  if (variant !== 2) {
    // Left arm.
    g.moveTo(x - tw, groundY - h * 0.52)
      .lineTo(X(-24), groundY - h * 0.52)
      .quadraticCurveTo(X(-31), groundY - h * 0.52, X(-31), groundY - h * 0.6)
      .lineTo(X(-31), groundY - h * 0.86)
      .quadraticCurveTo(X(-31), groundY - h * 0.94, X(-24.5), groundY - h * 0.94)
      .quadraticCurveTo(X(-18), groundY - h * 0.94, X(-18), groundY - h * 0.86)
      .lineTo(X(-18), groundY - h * 0.62)
      .lineTo(x - tw, groundY - h * 0.62)
      .closePath()
  }
  if (variant === 0) {
    // Right arm, set lower so the plant is not symmetrical.
    g.moveTo(x + tw, groundY - h * 0.36)
      .lineTo(X(22), groundY - h * 0.36)
      .quadraticCurveTo(X(28), groundY - h * 0.36, X(28), groundY - h * 0.44)
      .lineTo(X(28), groundY - h * 0.68)
      .quadraticCurveTo(X(28), groundY - h * 0.76, X(22.5), groundY - h * 0.76)
      .quadraticCurveTo(X(17), groundY - h * 0.76, X(17), groundY - h * 0.68)
      .lineTo(X(17), groundY - h * 0.46)
      .lineTo(x + tw, groundY - h * 0.46)
      .closePath()
  }
  g.fill(fill)
  // The lit edge: a sliver down the sun side of the trunk, and a terminator
  // that follows the round of it.
  g.moveTo(x + tw * 0.32, groundY + 4 * s)
    .lineTo(x + tw * 0.32, groundY - h + 9 * s)
    .quadraticCurveTo(x + tw * 0.4, groundY - h, x, groundY - h)
    .quadraticCurveTo(x + tw, groundY - h, x + tw, groundY - h + 10 * s)
    .lineTo(x + tw, groundY + 4 * s)
    .closePath()
    .fill({ color: lit, alpha: 0.85 })
  if (weight.alpha > 0) {
    g.moveTo(x - tw, groundY + 4 * s)
      .lineTo(x - tw, groundY - h + 10 * s)
      .quadraticCurveTo(x - tw, groundY - h, x, groundY - h)
      .quadraticCurveTo(x + tw, groundY - h, x + tw, groundY - h + 10 * s)
      .lineTo(x + tw, groundY + 4 * s)
      .stroke({ color: ink, width: weight.width, alpha: weight.alpha, join: 'round' })
  }
}

/** A weathered boulder pile. Two silhouettes, lit cap, shaded underside. */
function boulder(
  g: Graphics, x: number, groundY: number, scale: number,
  fill: Hex, lit: Hex, ink: Hex, weight: Weight, variant: number,
): void {
  const s = scale
  const X = (v: number): number => x + v * s
  const Y = (v: number): number => groundY + v * s
  if (variant === 1) {
    g.moveTo(X(-34), Y(2))
      .quadraticCurveTo(X(-40), Y(-14), X(-22), Y(-22))
      .quadraticCurveTo(X(-2), Y(-30), X(10), Y(-20))
      .quadraticCurveTo(X(30), Y(-26), X(34), Y(-4))
      .lineTo(X(36), Y(2))
      .closePath()
  } else {
    g.moveTo(X(-40), Y(2))
      .quadraticCurveTo(X(-46), Y(-22), X(-26), Y(-34))
      .quadraticCurveTo(X(-6), Y(-46), X(14), Y(-36))
      .quadraticCurveTo(X(36), Y(-28), X(38), Y(-8))
      .lineTo(X(40), Y(2))
      .closePath()
  }
  g.fill(fill)
  const cap = variant === 1 ? -20 : -32
  g.moveTo(X(-6), Y(cap - 8))
    .quadraticCurveTo(X(18), Y(cap), X(30), Y(cap * 0.4))
    .quadraticCurveTo(X(14), Y(cap * 0.2), X(-6), Y(cap - 8))
    .closePath()
    .fill({ color: lit, alpha: 0.8 })
  if (weight.alpha > 0) {
    g.moveTo(X(-18), Y(cap + 2)).quadraticCurveTo(X(0), Y(cap + 8), X(16), Y(cap + 2))
      .stroke({ color: ink, width: weight.width * 0.7, alpha: weight.alpha * 0.6 })
  }
}

/** A clump of desert grass. Three blade counts, so eleven of them differ. */
function tuftClump(
  g: Graphics, x: number, groundY: number, scale: number,
  fill: Hex, ink: Hex, variant: number,
): void {
  const blades = 3 + variant
  for (let i = 0; i < blades; i++) {
    const lean = blades > 1 ? -1 + (i * 2) / (blades - 1) : 0
    const bh = (16 + ((i * 7 + variant * 5) % 11)) * scale
    const bx = x + (i - (blades - 1) / 2) * 5 * scale
    g.moveTo(bx, groundY)
      .quadraticCurveTo(bx + lean * 7 * scale, groundY - bh * 0.6, bx + lean * 14 * scale, groundY - bh)
  }
  g.stroke({ color: fill, width: 2.6 * scale, cap: 'round' })
  // The shaded half of the clump, on the side turned away from the key.
  g.moveTo(x - 6 * scale, groundY)
    .quadraticCurveTo(x - 12 * scale, groundY - 9 * scale, x - 17 * scale, groundY - 15 * scale)
    .stroke({ color: ink, width: 2.4 * scale, cap: 'round' })
}

/**
 * A near-plane silhouette: the dark shape that crops the bottom of the frame.
 *
 * Rooted well below the frame edge so nothing is ever cut mid-shape, which is
 * what made the old foreground read as unfinished geometry. Three forms — an
 * agave rosette, an ocotillo fan and a rock shoulder — so the band varies.
 */
function nearPlant(
  g: Graphics, x: number, rootY: number, scale: number,
  fill: Hex, rim: Hex, variant: number, jitter: number,
): void {
  const s = scale
  if (variant === 0) {
    // Agave: a rosette of stiff blades.
    const blades = 9
    for (let i = 0; i < blades; i++) {
      const a = -Math.PI + (i + 0.5) * (Math.PI / blades) + (jitter - 0.5) * 0.12
      const len = (150 + ((i * 37) % 70)) * s
      const tipX = x + Math.cos(a) * len
      const tipY = rootY + Math.sin(a) * len
      g.moveTo(x - 16 * s, rootY)
        .lineTo(tipX, tipY)
        .lineTo(x + 16 * s, rootY)
        .closePath()
    }
    g.fill(fill)
    // One rim, laid along the blade that points at the sun, so even a pure
    // silhouette obeys the key light.
    const ri = blades - 2
    const ra = -Math.PI + (ri + 0.5) * (Math.PI / blades) + (jitter - 0.5) * 0.12
    const rlen = (150 + ((ri * 37) % 70)) * s
    g.moveTo(x + 3 * s, rootY)
      .lineTo(x + Math.cos(ra) * rlen, rootY + Math.sin(ra) * rlen)
      .lineTo(x + 16 * s, rootY)
      .closePath()
      .fill({ color: rim, alpha: 0.45 })
  } else if (variant === 1) {
    // Ocotillo: thin whips from a common base.
    const whips = 6
    for (let i = 0; i < whips; i++) {
      const lean = -0.85 + (i * 1.7) / (whips - 1) + (jitter - 0.5) * 0.3
      const len = (210 + ((i * 53) % 90)) * s
      g.moveTo(x - 9 * s, rootY)
        .quadraticCurveTo(x + lean * len * 0.35, rootY - len * 0.6, x + lean * len * 0.8, rootY - len)
        .lineTo(x + lean * len * 0.8 + 11 * s, rootY - len + 5 * s)
        .quadraticCurveTo(x + lean * len * 0.35 + 11 * s, rootY - len * 0.6, x + 9 * s, rootY)
        .closePath()
    }
    g.fill(fill)
  } else {
    // A rock shoulder rising out of the bottom edge.
    const w = 200 * s
    const h = (150 + jitter * 90) * s
    g.moveTo(x - w, rootY)
      .quadraticCurveTo(x - w * 0.75, rootY - h * 0.85, x - w * 0.15, rootY - h)
      .quadraticCurveTo(x + w * 0.45, rootY - h * 1.05, x + w * 0.8, rootY - h * 0.45)
      .lineTo(x + w, rootY)
      .closePath()
      .fill(fill)
    g.moveTo(x - w * 0.15, rootY - h)
      .quadraticCurveTo(x + w * 0.45, rootY - h * 1.05, x + w * 0.8, rootY - h * 0.45)
      .lineTo(x + w * 0.62, rootY - h * 0.42)
      .quadraticCurveTo(x + w * 0.35, rootY - h * 0.86, x - w * 0.12, rootY - h * 0.84)
      .closePath()
      .fill({ color: rim, alpha: 0.35 })
  }
}

/** Cheap integer hash. Deterministic scenery placement with no rng state. */
function hash32(k: number): number {
  let h = k | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = h ^ (h >>> 16)
  return h < 0 ? -h : h
}

/**
 * Air torque for one rotation axis. Kicking a rotation off is instant, building
 * it is steady, and checking it is three times as strong. See FLIP_CHECK.
 */
function torque(w: number, dir: number, dt: number, kicked: boolean): number {
  if (dir * w < -0.4) return w + dir * FLIP_CHECK * dt
  if (!kicked) return w + dir * FLIP_KICK
  return w + dir * FLIP_GAIN * dt
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % TAU) - Math.PI
  if (d < -Math.PI) d += TAU
  return a + d * t
}
