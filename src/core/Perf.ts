/**
 * Frame-time instrumentation.
 *
 * The build has hard numbers to hit (locked 60fps at 1080p, response within two
 * frames), so those numbers have to be measurable from outside the game. This
 * exposes `window.__perf` with a `report()` that a headless browser can read, and
 * an optional on-screen overlay for eyeballing.
 */
export interface PerfReport {
  durationSec: number
  frames: number
  fps: number
  frameMs: { p50: number; p95: number; p99: number; max: number }
  longFrames: number
  longFramePct: number
  worstStreak: number
  /** Scene simulation cost. GPU-independent, so valid under software rendering. */
  simMs: { p50: number; p95: number; max: number }
  /** Scene-graph positioning cost, excluding the GPU submit. Also GPU-independent. */
  cpuRenderMs: { p50: number; p95: number; max: number }
  sceneNodes: number
  inputLatencyMs: { samples: number; p50: number; p95: number; max: number } | null
  drawCalls: number | null
}

/** A frame slower than this is visible as a hitch at 60Hz. */
const LONG_FRAME_MS = 20

export class Perf {
  private times: number[] = []
  private latencies: number[] = []
  private startedAt = performance.now()
  private longStreak = 0
  private worstStreak = 0
  private overlay: HTMLDivElement | null = null
  private overlayAccum = 0
  private lastDrawCalls: number | null = null
  private simTimes: number[] = []
  private cpuTimes: number[] = []
  private sceneNodes = 0

  /** Record one rendered frame. */
  frame(frameDtSec: number): void {
    const ms = frameDtSec * 1000
    this.times.push(ms)
    // Keep memory bounded on long sessions; 10k frames is ~2.8 minutes at 60fps.
    if (this.times.length > 10000) this.times.splice(0, 2000)
    if (ms > LONG_FRAME_MS) {
      this.longStreak++
      if (this.longStreak > this.worstStreak) this.worstStreak = this.longStreak
    } else {
      this.longStreak = 0
    }
  }

  /**
   * Record that the game visibly responded to the most recent input.
   * `pressTime` is Input.lastRawPressTime.
   */
  markResponse(pressTime: number): void {
    if (pressTime <= 0) return
    const ms = performance.now() - pressTime
    // Anything over a quarter second is the player holding, not a response.
    if (ms >= 0 && ms < 250) this.latencies.push(ms)
    if (this.latencies.length > 2000) this.latencies.splice(0, 500)
  }

  setDrawCalls(n: number | null): void {
    this.lastDrawCalls = n
  }

  /** Milliseconds spent in the scene's fixed-step update. */
  sim(ms: number): void {
    this.simTimes.push(ms)
    if (this.simTimes.length > 10000) this.simTimes.splice(0, 2000)
  }

  /** Milliseconds spent positioning the scene graph, excluding the GPU submit. */
  cpuRender(ms: number): void {
    this.cpuTimes.push(ms)
    if (this.cpuTimes.length > 10000) this.cpuTimes.splice(0, 2000)
  }

  setSceneNodes(n: number): void {
    this.sceneNodes = n
  }

  reset(): void {
    this.times.length = 0
    this.latencies.length = 0
    this.simTimes.length = 0
    this.cpuTimes.length = 0
    this.startedAt = performance.now()
    this.longStreak = 0
    this.worstStreak = 0
  }

  report(): PerfReport {
    const durationSec = (performance.now() - this.startedAt) / 1000
    const sorted = [...this.times].sort((a, b) => a - b)
    const pct = (arr: number[], p: number): number =>
      arr.length === 0 ? 0 : round2(arr[Math.min(arr.length - 1, Math.floor(arr.length * p))])
    const longFrames = this.times.reduce((n, t) => (t > LONG_FRAME_MS ? n + 1 : n), 0)
    const lat = [...this.latencies].sort((a, b) => a - b)
    const sim = [...this.simTimes].sort((a, b) => a - b)
    const cpu = [...this.cpuTimes].sort((a, b) => a - b)
    const band = (arr: number[]): { p50: number; p95: number; max: number } => ({
      p50: pct(arr, 0.5),
      p95: pct(arr, 0.95),
      max: arr.length ? round2(arr[arr.length - 1]) : 0,
    })
    return {
      durationSec: round2(durationSec),
      frames: this.times.length,
      fps: durationSec > 0 ? round2(this.times.length / durationSec) : 0,
      frameMs: {
        p50: pct(sorted, 0.5),
        p95: pct(sorted, 0.95),
        p99: pct(sorted, 0.99),
        max: sorted.length ? round2(sorted[sorted.length - 1]) : 0,
      },
      longFrames,
      longFramePct: this.times.length ? round2((longFrames / this.times.length) * 100) : 0,
      worstStreak: this.worstStreak,
      simMs: band(sim),
      cpuRenderMs: band(cpu),
      sceneNodes: this.sceneNodes,
      inputLatencyMs: lat.length
        ? { samples: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: round2(lat[lat.length - 1]) }
        : null,
      drawCalls: this.lastDrawCalls,
    }
  }

  showOverlay(show: boolean): void {
    if (show && !this.overlay) {
      const el = document.createElement('div')
      el.id = 'perf-overlay'
      el.style.cssText = [
        'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
        'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:#8fffc8', 'background:rgba(6,10,14,.82)', 'padding:7px 9px',
        'border-radius:6px', 'pointer-events:none', 'white-space:pre',
        'letter-spacing:.02em', 'text-shadow:0 1px 2px rgba(0,0,0,.6)',
      ].join(';')
      document.body.appendChild(el)
      this.overlay = el
    } else if (!show && this.overlay) {
      this.overlay.remove()
      this.overlay = null
    }
  }

  get overlayVisible(): boolean {
    return this.overlay !== null
  }

  /** Refresh the overlay text; cheap, throttled to ~4Hz. */
  updateOverlay(frameDtSec: number): void {
    if (!this.overlay) return
    this.overlayAccum += frameDtSec
    if (this.overlayAccum < 0.25) return
    this.overlayAccum = 0
    const r = this.report()
    const lat = r.inputLatencyMs ? `${r.inputLatencyMs.p50}ms p50` : 'n/a'
    this.overlay.textContent =
      `fps ${r.fps.toFixed(1)}  frame ${r.frameMs.p50}/${r.frameMs.p95}/${r.frameMs.max}ms\n` +
      `sim ${r.simMs.p50}/${r.simMs.p95}ms  cpu ${r.cpuRenderMs.p50}/${r.cpuRenderMs.p95}ms\n` +
      `long ${r.longFrames} (${r.longFramePct}%)  nodes ${r.sceneNodes}\n` +
      `input ${lat}`
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
