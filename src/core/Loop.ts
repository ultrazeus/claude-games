/**
 * Fixed-timestep simulation with interpolated rendering.
 *
 * Simulation runs at an exact, deterministic rate (default 60Hz) no matter what
 * the display does. Rendering happens once per rAF and interpolates between the
 * previous and current simulation states using `alpha`, so motion stays smooth
 * on 60Hz, 120Hz and 144Hz panels alike, and physics never changes with framerate.
 */
export interface LoopCallbacks {
  /** Advance the simulation by exactly `dt` seconds. */
  update(dt: number, tick: number): void
  /** Draw. `alpha` is 0..1 between the previous and current sim state. */
  render(alpha: number, frameDt: number): void
}

export class Loop {
  /** Exact seconds per simulation step. */
  readonly fixedDt: number

  private readonly cb: LoopCallbacks
  private readonly maxFrameTime: number
  private acc = 0
  private lastTime = 0
  private running = false
  private rafId = 0
  private tickCount = 0

  constructor(cb: LoopCallbacks, hz = 60) {
    this.cb = cb
    this.fixedDt = 1 / hz
    // Clamp catch-up to 5 steps. Beyond that we drop simulated time rather than
    // spiral: a long stall (tab hidden, GC pause) must never cause a freeze while
    // the loop tries to replay seconds of simulation in one frame.
    this.maxFrameTime = this.fixedDt * 5
  }

  get tick(): number {
    return this.tickCount
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.acc = 0
    this.rafId = requestAnimationFrame(this.frame)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    cancelAnimationFrame(this.rafId)
    document.removeEventListener('visibilitychange', this.onVisibility)
  }

  private onVisibility = (): void => {
    // Returning from a hidden tab: throw away the gap instead of simulating it.
    if (!document.hidden) {
      this.lastTime = performance.now()
      this.acc = 0
    }
  }

  private frame = (now: number): void => {
    if (!this.running) return
    this.rafId = requestAnimationFrame(this.frame)

    let frameTime = (now - this.lastTime) / 1000
    this.lastTime = now
    if (frameTime > this.maxFrameTime) frameTime = this.maxFrameTime
    if (frameTime < 0) frameTime = 0

    this.acc += frameTime
    while (this.acc >= this.fixedDt) {
      this.cb.update(this.fixedDt, this.tickCount)
      this.tickCount++
      this.acc -= this.fixedDt
    }

    this.cb.render(this.acc / this.fixedDt, frameTime)
  }
}
