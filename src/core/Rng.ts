/**
 * Seeded, deterministic PRNG (mulberry32).
 *
 * Every system that needs randomness takes an Rng rather than calling Math.random,
 * so a run can be replayed exactly. Critical for reproducing a bug a critic found.
 */
export class Rng {
  private state: number

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1))
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]
  }

  /** Symmetric noise in [-amount, amount]. */
  spread(amount: number): number {
    return (this.next() * 2 - 1) * amount
  }

  reseed(seed: number): void {
    this.state = seed >>> 0
  }
}

/** Shared instance for cosmetic randomness where determinism does not matter. */
export const cosmeticRng = new Rng(0x5eed1234)
