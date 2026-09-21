import { Container, Sprite, Texture, type BLEND_MODES } from 'pixi.js'

export interface EmitSpec {
  x: number
  y: number
  vx?: number
  vy?: number
  /** Seconds. */
  life: number
  size: number
  /** Size at death; defaults to `size`. */
  sizeEnd?: number
  color?: number
  alpha?: number
  alphaEnd?: number
  /** Pixels/sec^2 applied to vy. */
  gravity?: number
  /** Fraction of velocity kept per second. 1 = no drag. */
  drag?: number
  rotation?: number
  /** Radians/sec. */
  spin?: number
}

/**
 * Pooled particle system.
 *
 * All state lives in typed arrays and every sprite is allocated up front, so
 * emitting costs no allocation and the GC never runs mid-run. One system holds
 * one texture and one blend mode, which keeps it to a single draw call.
 */
export class ParticleSystem {
  readonly container = new Container()

  private sprites: Sprite[] = []
  private px: Float32Array
  private py: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private size0: Float32Array
  private size1: Float32Array
  private alpha0: Float32Array
  private alpha1: Float32Array
  private gravity: Float32Array
  private drag: Float32Array
  private spin: Float32Array
  private active: Uint8Array
  private capacity: number
  /** Round-robin cursor; when full, the oldest slot is recycled. */
  private cursor = 0
  private liveCount = 0

  constructor(texture: Texture, capacity = 256, blend: BLEND_MODES = 'normal') {
    this.capacity = capacity
    this.px = new Float32Array(capacity)
    this.py = new Float32Array(capacity)
    this.vx = new Float32Array(capacity)
    this.vy = new Float32Array(capacity)
    this.life = new Float32Array(capacity)
    this.maxLife = new Float32Array(capacity)
    this.size0 = new Float32Array(capacity)
    this.size1 = new Float32Array(capacity)
    this.alpha0 = new Float32Array(capacity)
    this.alpha1 = new Float32Array(capacity)
    this.gravity = new Float32Array(capacity)
    this.drag = new Float32Array(capacity)
    this.spin = new Float32Array(capacity)
    this.active = new Uint8Array(capacity)

    for (let i = 0; i < capacity; i++) {
      const s = new Sprite(texture)
      s.anchor.set(0.5)
      s.visible = false
      s.blendMode = blend
      this.sprites.push(s)
      this.container.addChild(s)
    }
    this.container.eventMode = 'none'
    // Particles are decoration; skip the hit-test walk entirely.
    this.container.interactiveChildren = false
  }

  get live(): number { return this.liveCount }

  emit(spec: EmitSpec): void {
    const i = this.claim()
    if (i < 0) return
    this.px[i] = spec.x
    this.py[i] = spec.y
    this.vx[i] = spec.vx ?? 0
    this.vy[i] = spec.vy ?? 0
    this.life[i] = spec.life
    this.maxLife[i] = spec.life
    this.size0[i] = spec.size
    this.size1[i] = spec.sizeEnd ?? spec.size
    this.alpha0[i] = spec.alpha ?? 1
    this.alpha1[i] = spec.alphaEnd ?? 0
    this.gravity[i] = spec.gravity ?? 0
    this.drag[i] = spec.drag ?? 1
    this.spin[i] = spec.spin ?? 0
    const s = this.sprites[i]
    s.visible = true
    s.tint = spec.color ?? 0xffffff
    s.rotation = spec.rotation ?? 0
    s.width = spec.size
    s.height = spec.size
    s.alpha = this.alpha0[i]
    s.position.set(spec.x, spec.y)
  }

  /** Emit `count` particles, letting the caller vary each one. */
  burst(count: number, make: (i: number) => EmitSpec): void {
    for (let i = 0; i < count; i++) this.emit(make(i))
  }

  private claim(): number {
    for (let n = 0; n < this.capacity; n++) {
      const i = (this.cursor + n) % this.capacity
      if (!this.active[i]) {
        this.active[i] = 1
        this.cursor = (i + 1) % this.capacity
        this.liveCount++
        return i
      }
    }
    // Pool exhausted: steal the slot at the cursor rather than dropping the effect.
    const i = this.cursor
    this.cursor = (i + 1) % this.capacity
    return i
  }

  update(dt: number): void {
    for (let i = 0; i < this.capacity; i++) {
      if (!this.active[i]) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.active[i] = 0
        this.sprites[i].visible = false
        this.liveCount--
        continue
      }
      const d = this.drag[i]
      if (d !== 1) {
        const f = Math.pow(d, dt)
        this.vx[i] *= f
        this.vy[i] *= f
      }
      this.vy[i] += this.gravity[i] * dt
      this.px[i] += this.vx[i] * dt
      this.py[i] += this.vy[i] * dt

      const t = 1 - this.life[i] / this.maxLife[i]
      const s = this.sprites[i]
      const size = this.size0[i] + (this.size1[i] - this.size0[i]) * t
      s.position.set(this.px[i], this.py[i])
      s.width = size
      s.height = size
      s.alpha = this.alpha0[i] + (this.alpha1[i] - this.alpha0[i]) * t
      if (this.spin[i] !== 0) s.rotation += this.spin[i] * dt
    }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) {
      this.active[i] = 0
      this.sprites[i].visible = false
    }
    this.liveCount = 0
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.sprites.length = 0
  }
}
