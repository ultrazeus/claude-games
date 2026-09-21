import type { Container } from 'pixi.js'
import type { Input } from './Input'
import type { Rng } from './Rng'
import type { Perf } from './Perf'
import type { AudioBus } from './Audio'

/** Everything a scene is handed when it starts. */
export interface SceneContext {
  /** The scene's own root container. Cleared automatically on exit. */
  readonly root: Container
  readonly input: Input
  readonly audio: AudioBus
  readonly rng: Rng
  readonly perf: Perf
  /** Logical design-space size. Scenes lay out against this, not device pixels. */
  readonly width: number
  readonly height: number
  /** Queue a transition. Takes effect at the end of the current tick. */
  goto(sceneId: string, params?: Record<string, unknown>): void
}

export interface Scene {
  readonly id: string
  /** Build the scene graph. Called once, before the first update. */
  enter(ctx: SceneContext, params?: Record<string, unknown>): void | Promise<void>
  /** Advance simulation by exactly dt. Never read wall-clock time here. */
  update(dt: number, tick: number): void
  /** Position visuals for this frame. `alpha` interpolates between sim states. */
  render(alpha: number): void
  /** Logical size changed. */
  resize(width: number, height: number): void
  /** Release anything not owned by the root container (timers, audio voices). */
  exit(): void
  /**
   * Optional. Expose the scene's simulation state for automated review, so a
   * critic can assert on what the game is actually doing rather than guessing
   * from pixels. Reached from outside as `__cg.state()`.
   */
  debug?(): Record<string, unknown>
}

export type SceneFactory = () => Scene

/** A scene that does nothing, used as the initial state before boot completes. */
export class NullScene implements Scene {
  readonly id = 'null'
  enter(): void {}
  update(): void {}
  render(): void {}
  resize(): void {}
  exit(): void {}
  debug(): Record<string, unknown> { return {} }
}
