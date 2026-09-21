/**
 * Input with tick-aligned edge detection, buffering and gamepad support.
 *
 * Two things here exist purely for game feel:
 *  1. Presses are counted from raw events, not diffed from held-state, so a tap
 *     shorter than one simulation tick is never swallowed.
 *  2. `buffered()` lets an event accept an input that arrived slightly too early
 *     (the classic "I pressed jump just before landing" case). Arcade games live
 *     or die on this.
 */
export const Action = {
  Left: 0,
  Right: 1,
  Up: 2,
  Down: 3,
  A: 4,
  B: 5,
  Start: 6,
  Back: 7,
} as const

export type ActionId = (typeof Action)[keyof typeof Action]
export const ACTION_COUNT = 8

const KEY_MAP: Record<string, ActionId> = {
  ArrowLeft: Action.Left, KeyA: Action.Left,
  ArrowRight: Action.Right, KeyD: Action.Right,
  ArrowUp: Action.Up, KeyW: Action.Up,
  ArrowDown: Action.Down, KeyS: Action.Down,
  Space: Action.A, KeyJ: Action.A, KeyZ: Action.A,
  ShiftLeft: Action.B, ShiftRight: Action.B, KeyK: Action.B, KeyX: Action.B, KeyB: Action.B,
  Enter: Action.Start,
  Escape: Action.Back,
}

/** Keys we swallow so the page never scrolls or scrubs under the game. */
const SWALLOW = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter', 'Tab',
])

const GAMEPAD_BUTTON_MAP: Record<number, ActionId> = {
  0: Action.A, 1: Action.B, 2: Action.B, 3: Action.A,
  9: Action.Start, 8: Action.Back,
  12: Action.Up, 13: Action.Down, 14: Action.Left, 15: Action.Right,
}

const STICK_DEADZONE = 0.45

export class Input {
  /** Currently physically down. */
  private readonly rawDown = new Uint8Array(ACTION_COUNT)
  /** Press events observed since the last tick boundary. */
  private readonly pressCounts = new Uint8Array(ACTION_COUNT)
  private readonly releaseCounts = new Uint8Array(ACTION_COUNT)

  /** Tick-stable snapshot, valid for the duration of one simulation step. */
  private readonly held = new Uint8Array(ACTION_COUNT)
  private readonly pressed = new Uint8Array(ACTION_COUNT)
  private readonly released = new Uint8Array(ACTION_COUNT)
  private readonly lastPressTick = new Int32Array(ACTION_COUNT).fill(-9999)
  private readonly heldSinceTick = new Int32Array(ACTION_COUNT).fill(-9999)

  private readonly gamepadPrev = new Uint8Array(ACTION_COUNT)
  private currentTick = 0
  private attached = false

  /** Wall-clock ms of the most recent raw press, for latency instrumentation. */
  lastRawPressTime = 0

  attach(target: Window = window): void {
    if (this.attached) return
    this.attached = true
    target.addEventListener('keydown', this.onKeyDown, { passive: false })
    target.addEventListener('keyup', this.onKeyUp, { passive: false })
    target.addEventListener('blur', this.onBlur)
  }

  detach(target: Window = window): void {
    if (!this.attached) return
    this.attached = false
    target.removeEventListener('keydown', this.onKeyDown)
    target.removeEventListener('keyup', this.onKeyUp)
    target.removeEventListener('blur', this.onBlur)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (SWALLOW.has(e.code)) e.preventDefault()
    const a = KEY_MAP[e.code]
    if (a === undefined) return
    if (e.repeat) return
    if (!this.rawDown[a]) {
      this.rawDown[a] = 1
      if (this.pressCounts[a] < 255) this.pressCounts[a]++
      this.lastRawPressTime = performance.now()
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (SWALLOW.has(e.code)) e.preventDefault()
    const a = KEY_MAP[e.code]
    if (a === undefined) return
    if (this.rawDown[a]) {
      this.rawDown[a] = 0
      if (this.releaseCounts[a] < 255) this.releaseCounts[a]++
    }
  }

  /** Dropping focus must not leave a direction stuck on. */
  private onBlur = (): void => {
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (this.rawDown[i]) {
        this.rawDown[i] = 0
        if (this.releaseCounts[i] < 255) this.releaseCounts[i]++
      }
    }
  }

  /** Call once at the top of every simulation step, before any scene update. */
  beginTick(tick: number): void {
    this.currentTick = tick
    this.pollGamepad()
    for (let i = 0; i < ACTION_COUNT; i++) {
      const wasHeld = this.held[i]
      this.pressed[i] = this.pressCounts[i] > 0 ? 1 : 0
      this.released[i] = this.releaseCounts[i] > 0 ? 1 : 0
      this.held[i] = this.rawDown[i]
      if (this.pressed[i]) this.lastPressTick[i] = tick
      if (this.held[i] && !wasHeld) this.heldSinceTick[i] = tick
      this.pressCounts[i] = 0
      this.releaseCounts[i] = 0
    }
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.()
    if (!pads) return
    const next = new Uint8Array(ACTION_COUNT)
    let any = false
    for (const pad of pads) {
      if (!pad) continue
      any = true
      for (const [idxStr, action] of Object.entries(GAMEPAD_BUTTON_MAP)) {
        if (pad.buttons[Number(idxStr)]?.pressed) next[action] = 1
      }
      const ax = pad.axes[0] ?? 0
      const ay = pad.axes[1] ?? 0
      if (ax < -STICK_DEADZONE) next[Action.Left] = 1
      if (ax > STICK_DEADZONE) next[Action.Right] = 1
      if (ay < -STICK_DEADZONE) next[Action.Up] = 1
      if (ay > STICK_DEADZONE) next[Action.Down] = 1
    }
    if (!any) return
    for (let i = 0; i < ACTION_COUNT; i++) {
      if (next[i] && !this.gamepadPrev[i]) {
        if (!this.rawDown[i]) {
          this.rawDown[i] = 1
          if (this.pressCounts[i] < 255) this.pressCounts[i]++
          this.lastRawPressTime = performance.now()
        }
      } else if (!next[i] && this.gamepadPrev[i]) {
        if (this.rawDown[i]) {
          this.rawDown[i] = 0
          if (this.releaseCounts[i] < 255) this.releaseCounts[i]++
        }
      }
      this.gamepadPrev[i] = next[i]
    }
  }

  isDown(a: ActionId): boolean { return this.held[a] === 1 }
  justPressed(a: ActionId): boolean { return this.pressed[a] === 1 }
  justReleased(a: ActionId): boolean { return this.released[a] === 1 }

  /** Ticks the action has been continuously held, or 0 if not held. */
  heldTicks(a: ActionId): number {
    return this.held[a] ? this.currentTick - this.heldSinceTick[a] + 1 : 0
  }

  /**
   * True if the action was pressed within the last `windowTicks` ticks.
   * Call consumeBuffer() once you act on it so it cannot fire twice.
   */
  buffered(a: ActionId, windowTicks = 6): boolean {
    return this.currentTick - this.lastPressTick[a] <= windowTicks
  }

  consumeBuffer(a: ActionId): void {
    this.lastPressTick[a] = -9999
  }

  /** -1, 0 or 1 from the horizontal actions. */
  axisX(): number {
    return (this.held[Action.Right] ? 1 : 0) - (this.held[Action.Left] ? 1 : 0)
  }

  /** -1 (up), 0 or 1 (down). */
  axisY(): number {
    return (this.held[Action.Down] ? 1 : 0) - (this.held[Action.Up] ? 1 : 0)
  }

  anyPressed(): boolean {
    for (let i = 0; i < ACTION_COUNT; i++) if (this.pressed[i]) return true
    return false
  }

  /** Force-clear everything, e.g. across a scene change. */
  reset(): void {
    this.rawDown.fill(0)
    this.pressCounts.fill(0)
    this.releaseCounts.fill(0)
    this.held.fill(0)
    this.pressed.fill(0)
    this.released.fill(0)
    this.lastPressTick.fill(-9999)
    this.heldSinceTick.fill(-9999)
    this.gamepadPrev.fill(0)
  }
}
