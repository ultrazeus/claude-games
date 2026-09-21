import { Application, Container, Graphics } from 'pixi.js'
import { Loop, type LoopCallbacks } from './Loop'
import { Input } from './Input'
import { AudioBus } from './Audio'
import { Perf } from './Perf'
import { Rng } from './Rng'
import { NullScene, type Scene, type SceneContext, type SceneFactory } from './Scene'
import { clamp01, Ease } from './Tween'
import { setHintsEnabled, setToastLayer, showToast, updateToast } from '../render/Hud'
import { MusicPlayer } from './Music'
import { loadPrefs, savePrefs } from './Prefs'

/** Recursive child count, for spotting a scene that is leaking display objects. */
function countNodes(c: Container): number {
  let n = 1
  for (const child of c.children) n += countNodes(child as Container)
  return n
}

/**
 * Fixed design space. Every scene lays out against exactly these dimensions and
 * the whole stage is scaled to fit the window with letterboxing. Six events built
 * in parallel then compose identically, and a critic comparing screenshots is
 * always looking at the same frame.
 */
export const DESIGN_WIDTH = 1920
export const DESIGN_HEIGHT = 1080

const TRANSITION_OUT = 0.26
const TRANSITION_IN = 0.34

type TransitionPhase = 'idle' | 'out' | 'in'

export class App implements LoopCallbacks {
  readonly input = new Input()
  readonly audio = new AudioBus()
  /** Declared before `music`: class fields initialise in declaration order. */
  private prefs = loadPrefs()
  /*
   * The host is read through getters rather than captured, because none of the
   * audio graph exists until the first gesture unlocks it — `music` is built at
   * construction but cannot touch a node until much later.
   */
  readonly music = new MusicPlayer(
    {
      context: () => this.audio.context,
      musicBus: () => this.audio.musicBus,
      noiseBuffer: () => this.audio.noiseBuffer,
    },
    this.prefs.music,
  )
  /** Scene id whose track should be playing; kept so audio can start late. */
  private trackId = ''
  private currentSceneId = ''
  readonly perf = new Perf()
  readonly rng = new Rng(Date.now() >>> 0)

  private pixi!: Application
  /** Scaled + letterboxed; everything the game draws lives under here. */
  private world = new Container()
  private sceneRoot = new Container()
  private overlayRoot = new Container()
  private fadeQuad = new Graphics()
  private toastRoot = new Container()
  private loop = new Loop(this)

  private scenes = new Map<string, SceneFactory>()
  private current: Scene = new NullScene()
  private pending: { id: string; params?: Record<string, unknown> } | null = null
  private phase: TransitionPhase = 'idle'
  private phaseT = 0
  private fadeAlpha = 0
  private booted = false

  async boot(mount: HTMLElement): Promise<void> {
    if (this.booted) return
    this.booted = true

    this.pixi = new Application()
    await this.pixi.init({
      resizeTo: mount,
      antialias: true,
      // Cap at 2: beyond that the pixel cost is real and the visual gain is not.
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      powerPreference: 'high-performance',
      backgroundColor: 0x0b1020,
      // We drive rendering from our own fixed-step loop.
      sharedTicker: false,
      autoStart: false,
    })
    this.mount = mount
    mount.appendChild(this.pixi.canvas)
    this.pixi.canvas.style.display = 'block'
    this.pixi.canvas.setAttribute('aria-label', 'California Games')

    this.world.addChild(this.sceneRoot)
    this.world.addChild(this.overlayRoot)
    this.pixi.stage.addChild(this.world)

    this.fadeQuad.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT).fill(0x0b1020)
    this.fadeQuad.alpha = 0
    this.fadeQuad.eventMode = 'none'
    this.overlayRoot.addChild(this.fadeQuad)
    // Above the fade quad: an audio toast is a response to the player's own
    // keypress and should not be dimmed by a scene transition they did not ask
    // about. It also outlives the scene, so it cannot live on a scene's HUD.
    this.overlayRoot.addChild(this.toastRoot)
    setToastLayer(this.toastRoot)

    this.input.attach()
    this.layout()
    window.addEventListener('resize', this.layout)

    // `layout()` scales the 1920x1080 design space to the mount element, and it
    // used to run exactly twice: once at boot and again on `window.resize`. If
    // the element has not been given its real size at the moment boot measures
    // it — a reload into a backgrounded tab, a hot reload landing mid window
    // animation — the scale freezes at that wrong value forever. The centring
    // offset `(w - DESIGN_WIDTH * scale) / 2` then collapses toward zero, so
    // the symptom is the game pinned small in the TOP-LEFT rather than centred,
    // and nothing corrects it until the window happens to be resized.
    //
    // Observing the element fixes it at the source: the first time it reports
    // its true size, the scale recomputes.
    if (typeof ResizeObserver !== 'undefined') {
      this.stageObserver = new ResizeObserver(() => this.layout())
      this.stageObserver.observe(mount)
    }

    // Audio needs a gesture. Any first interaction unlocks it — and the music
    // only starts here, because until this runs there is no AudioContext for
    // the sequencer to schedule against.
    const unlock = (): void => {
      this.audio.unlock()
      this.audio.setAmbienceEnabled(this.prefs.ambience)
      if (this.trackId) this.music.play(this.trackId)
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)

    // Audio switches are global: they work on the menu, mid-run and on an end
    // card, so they are bound here rather than in any event's input handling.
    window.addEventListener('keydown', this.onAudioKey)

    this.exposeDebugHandles()
  }

  register(id: string, factory: SceneFactory): void {
    this.scenes.set(id, factory)
  }

  /** Start the loop on the given scene. */
  async run(startSceneId: string, params?: Record<string, unknown>): Promise<void> {
    await this.swapScene(startSceneId, params)
    this.fadeAlpha = 1
    this.phase = 'in'
    this.phaseT = 0
    this.loop.start()
  }

  /** Queue a scene change; it happens at the next tick boundary. */
  goto = (id: string, params?: Record<string, unknown>): void => {
    if (this.pending) return
    if (!this.scenes.has(id)) {
      console.warn(`[app] unknown scene "${id}"`)
      return
    }
    this.pending = { id, params }
    this.phase = 'out'
    this.phaseT = 0
  }

  private makeContext(): SceneContext {
    return {
      root: this.sceneRoot,
      input: this.input,
      audio: this.audio,
      rng: this.rng,
      perf: this.perf,
      width: DESIGN_WIDTH,
      height: DESIGN_HEIGHT,
      goto: this.goto,
    }
  }

  /**
   * True from the instant the outgoing scene's display objects are destroyed
   * until the incoming scene is installed. `update` and `render` must not touch
   * `this.current` while it is set.
   *
   * `swapScene` destroys the old scene, then AWAITS `scene.enter()`, and only
   * then assigns `this.current`. The loop keeps running across that await, so
   * it was calling `render()` on a scene whose Containers had already been
   * destroyed. PixiJS v8 nulls a destroyed object's transform, so the first
   * `row.root.x = ...` threw "Cannot set properties of null" and took the whole
   * game down on the menu. It needed a scene swap and an await that actually
   * yielded to reproduce, which is why every headless capture missed it — those
   * load a scene directly by URL.
   */
  private swapping = false

  /** True while a capture holds the frame. Simulation stops; rendering does not. */
  private frozen = false

  /** Watches the mount element so a wrong boot-time measurement self-corrects. */
  private stageObserver?: ResizeObserver

  /** The element the stage is fitted to. `layout()` measures this directly. */
  private mount?: HTMLElement

  /**
   * M toggles music, N the ambience beds.
   *
   * Both persist, because a player who turns music off means it, and meeting
   * them with it back on next launch is how a setting becomes a nuisance.
   * Ignored while a modifier is held so browser and OS shortcuts still work.
   */
  private onAudioKey = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
    if (e.code === 'KeyM') {
      this.prefs.music = !this.prefs.music
      this.music.setEnabled(this.prefs.music)
      savePrefs(this.prefs)
      const name = this.music.nowPlaying
      showToast(this.prefs.music ? (name ? `MUSIC ON  \u00b7  ${name}` : 'MUSIC ON') : 'MUSIC OFF')
    } else if (e.code === 'KeyN') {
      this.prefs.ambience = !this.prefs.ambience
      this.audio.setAmbienceEnabled(this.prefs.ambience)
      savePrefs(this.prefs)
      showToast(this.prefs.ambience ? 'AMBIENCE ON' : 'AMBIENCE OFF')
    }
  }

  private async swapScene(id: string, params?: Record<string, unknown>): Promise<void> {
    const factory = this.scenes.get(id)
    if (!factory) return
    this.swapping = true
    this.current.exit()
    this.sceneRoot.removeChildren().forEach((c) => c.destroy({ children: true }))
    this.input.reset()
    this.audio.panic()
    this.trackId = id
    this.currentSceneId = id
    this.music.play(id)
    const scene = factory()
    try {
      await scene.enter(this.makeContext(), params)
      scene.resize(DESIGN_WIDTH, DESIGN_HEIGHT)
      this.current = scene
    } finally {
      // Cleared even if `enter` throws, so a failed scene load leaves the app
      // rendering something rather than frozen behind a flag.
      this.swapping = false
    }
  }

  update(dt: number, tick: number): void {
    this.input.beginTick(tick)
    // Outside the frozen/swapping guard below: a toast belongs to the player's
    // keypress, not to the scene, and must still expire while a scene is being
    // swapped or a capture has the simulation frozen.
    updateToast(dt)

    if (this.phase === 'out') {
      this.phaseT += dt
      this.fadeAlpha = clamp01(this.phaseT / TRANSITION_OUT)
      if (this.phaseT >= TRANSITION_OUT && this.pending) {
        const next = this.pending
        this.pending = null
        this.phase = 'in'
        this.phaseT = 0
        this.fadeAlpha = 1
        void this.swapScene(next.id, next.params)
        return
      }
    } else if (this.phase === 'in') {
      this.phaseT += dt
      this.fadeAlpha = 1 - Ease.outCubic(clamp01(this.phaseT / TRANSITION_IN))
      if (this.phaseT >= TRANSITION_IN) {
        this.phase = 'idle'
        this.fadeAlpha = 0
      }
    }

    const t0 = performance.now()
    // Same window as `render`: the outgoing scene is destroyed and the
    // incoming one is not installed yet, so there is nothing safe to step.
    if (!this.swapping && !this.frozen) this.current.update(dt, tick)
    this.perf.sim(performance.now() - t0)
  }

  render(alpha: number, frameDt: number): void {
    const t0 = performance.now()
    // Mid-swap the old scene is destroyed and the new one is not installed yet.
    // Only the fade quad is live; drawing the scene would touch dead objects.
    if (!this.swapping) this.current.render(alpha)
    this.fadeQuad.alpha = this.fadeAlpha
    this.perf.cpuRender(performance.now() - t0)
    this.pixi.render()
    this.perf.frame(frameDt)
    // Node count drifts only on scene changes; sampling once a second is plenty.
    if (this.nodeSampleAccum > 1) {
      this.nodeSampleAccum = 0
      this.perf.setSceneNodes(countNodes(this.sceneRoot))
    }
    this.nodeSampleAccum += frameDt
    this.perf.updateOverlay(frameDt)
  }

  private nodeSampleAccum = 0

  /** Scale the design space to fit the window, centred, preserving aspect. */
  /**
   * Fit the 1920x1080 design space to the mount element.
   *
   * This MEASURES THE ELEMENT and resizes the renderer itself, rather than
   * reading `renderer.width` and trusting it. `resizeTo: mount` makes Pixi
   * resize on its own queued animation frame, but `boot()` calls `layout()`
   * immediately after `init()` — so it was reading the renderer's default size
   * (~800x600), computing a scale from it, and the centring offset
   * `(w - 1920*scale)/2` then collapsed toward zero. Symptom: the game pinned
   * small in the TOP-LEFT of a large window, forever, because `#app` is
   * `position: fixed; inset: 0` and never changes size, so nothing ever fired a
   * resize to correct it.
   */
  private layout = (): void => {
    if (!this.pixi?.renderer) return
    const w = this.mount?.clientWidth || this.pixi.renderer.width / this.pixi.renderer.resolution
    const h = this.mount?.clientHeight || this.pixi.renderer.height / this.pixi.renderer.resolution
    if (w < 1 || h < 1) return
    if (Math.round(this.pixi.renderer.width / this.pixi.renderer.resolution) !== Math.round(w)
      || Math.round(this.pixi.renderer.height / this.pixi.renderer.resolution) !== Math.round(h)) {
      this.pixi.renderer.resize(w, h)
    }
    const scale = Math.min(w / DESIGN_WIDTH, h / DESIGN_HEIGHT)
    this.world.scale.set(scale)
    this.world.position.set(
      Math.round((w - DESIGN_WIDTH * scale) * 0.5),
      Math.round((h - DESIGN_HEIGHT * scale) * 0.5),
    )
    this.current.resize(DESIGN_WIDTH, DESIGN_HEIGHT)
  }

  /**
   * Handles the automated critic drives the game through. Everything a headless
   * browser needs to verify a claim lives on `window.__cg`.
   */
  private exposeDebugHandles(): void {
    const handles = {
      perf: () => this.perf.report(),
      resetPerf: () => this.perf.reset(),
      overlay: (on: boolean) => this.perf.showOverlay(on),
      scene: () => this.current.id,
      // Freeze the simulation on the current frame.
      //
      // A capture used to decide "this is the moment" and then make a SECOND
      // round-trip to take the screenshot, hundreds of milliseconds later, with
      // the game still running. The shutter therefore photographed a different
      // instant than the one the gate approved — which is how a frame chosen on
      // a clean rally arrived with 'DROPPED' across it. Freezing first makes the
      // decision and the photograph the same frame.
      freeze: (on: boolean) => { this.frozen = on },
      // Turn every on-screen control legend off. Captures call this so a
      // critic never judges a frame with a tutorial bar across the player;
      // it is not reachable from gameplay.
      hints: (on: boolean) => setHintsEnabled(on),
      state: () => this.current.debug?.() ?? null,
      goto: (id: string, params?: Record<string, unknown>) => this.goto(id, params),
      scenes: () => [...this.scenes.keys()],
      mute: (m: boolean) => this.audio.setMuted(m),
      music: (on: boolean) => { this.prefs.music = on; this.music.setEnabled(on); savePrefs(this.prefs) },
      ambience: (on: boolean) => { this.prefs.ambience = on; this.audio.setAmbienceEnabled(on); savePrefs(this.prefs) },
      nowPlaying: () => this.music.nowPlaying,
      probe: (ms?: number) => this.audio.probe(ms),
      /*
       * Every live HUD readout: does its value text fit inside its plate?
       *
       * A player found digits sitting on the bottom border in two events and
       * asked whether it was true of all six. Eyeballing six screenshots is how
       * that question gets answered badly; this reads the real bounds out of
       * the live scene graph instead, so the answer is per-readout and exact.
       */
      hudAudit: () => {
        const out: { label: string; value: string; overflow: Record<string, number> }[] = []
        const walk = (c: Container): void => {
          if (c.label === 'readout' && c.children.length >= 3) {
            const [plate, lab, val] = c.children as [Container, Container, Container]
            const p = plate.getLocalBounds()
            const v = val.getBounds()
            const pw = c.toGlobal({ x: p.x, y: p.y })
            const pe = c.toGlobal({ x: p.maxX, y: p.maxY })
            const over = {
              top: Math.round(Math.max(0, pw.y - v.y)),
              bottom: Math.round(Math.max(0, v.maxY - pe.y)),
              left: Math.round(Math.max(0, pw.x - v.x)),
              right: Math.round(Math.max(0, v.maxX - pe.x)),
            }
            out.push({
              label: (lab as unknown as { text: string }).text,
              value: (val as unknown as { text: string }).text,
              overflow: over,
            })
          }
          for (const ch of c.children) walk(ch as Container)
        }
        walk(this.sceneRoot)
        const bad = out.filter((r) => Object.values(r.overflow).some((n) => n > 0))
        return { scene: this.currentSceneId, readouts: out.length, clipped: bad.length, bad }
      },
      press: (code: string, ms = 60) => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))
        window.setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }))
        }, ms)
      },
      hold: (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })),
      release: (code: string) => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })),
    }
    ;(window as unknown as Record<string, unknown>).__cg = handles
    ;(window as unknown as Record<string, unknown>).__perf = this.perf
  }
}
