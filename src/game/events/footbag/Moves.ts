import { Action, type ActionId } from '../../../core/Input'

/**
 * The move vocabulary.
 *
 * The original names its moves and scores them by difficulty; that naming is the
 * whole identity of the event, so it lives in its own table rather than being
 * buried in the scene. Each entry is simultaneously three things:
 *
 *  - a **scoring window**: an ellipse in the player's local frame that the bag
 *    has to be inside at the strike frame,
 *  - an **animation brief**: which joint meets the bag, how long the wind-up is,
 *    and therefore how far ahead the rig has to predict,
 *  - a **risk/reward line**: harder windows pay more, and the aim scatter says
 *    how much the bag runs away from you afterwards.
 *
 * Local frame: x is measured from the player's feet toward the *kicking side*
 * (so every move is authored once and mirrors for free), y is measured from the
 * lawn with up negative.
 */
export type MoveId = 'inside' | 'outside' | 'knee' | 'toe' | 'header'

export interface MoveDef {
  readonly id: MoveId
  /** Printed over the player on contact. */
  readonly name: string
  /** Which joint meets the bag. The rig drives a different chain for each. */
  readonly contact: 'foot' | 'knee' | 'head'
  /** Centre of the scoring window, local px. */
  readonly idealX: number
  readonly idealY: number
  /** Half-extent of the window on each axis. Error is normalised against these. */
  readonly spanX: number
  readonly spanY: number
  /** Ticks from the press to the frame the bag is actually struck. */
  readonly strikeTick: number
  /** Total length of the swing, ticks. */
  readonly swingTicks: number
  /** Upward impulse on a perfect contact, px/s. */
  readonly pop: number
  /**
   * Where a clean contact aims the bag, as an offset from the player on the
   * kicking side. Negative pulls it back across the body, which is what makes
   * a clean contact feel like it is setting up the next one.
   */
  readonly aimBias: number
  /** Random scatter added to the aim. The price of the harder moves. */
  readonly aimScatter: number
  /** Points before quality, repetition and chain multipliers. */
  readonly base: number
}

/**
 * Four moves, four different shapes of window.
 *
 * inside  — close in and mid height. The safety move: small pop, tight aim, and
 *           it hands the bag straight back to you.
 * outside — out past the shoulder. The window is the *biggest* of the four but
 *           it sits a long way off the body, so the difficulty is in the feet,
 *           not the timing. Pays double the inside.
 * knee    — highest contact, highest pop. Buys you a full second to set up
 *           something harder, which is exactly what it is for.
 * toe     — a stab at ankle height. Half the vertical window of the inside kick
 *           and the shortest wind-up in the set, so it is the one move you have
 *           to read early. Pays the most.
 */
export const MOVES: Record<MoveId, MoveDef> = {
  inside: {
    id: 'inside', name: 'INSIDE KICK', contact: 'foot',
    idealX: 32, idealY: -132, spanX: 62, spanY: 60,
    strikeTick: 7, swingTicks: 20,
    pop: 880, aimBias: -12, aimScatter: 46, base: 100,
  },
  outside: {
    id: 'outside', name: 'OUTSIDE KICK', contact: 'foot',
    idealX: 112, idealY: -148, spanX: 66, spanY: 86,
    strikeTick: 8, swingTicks: 22,
    pop: 960, aimBias: -104, aimScatter: 70, base: 200,
  },
  knee: {
    id: 'knee', name: 'KNEE', contact: 'knee',
    idealX: 44, idealY: -150, spanX: 54, spanY: 54,
    strikeTick: 6, swingTicks: 18,
    pop: 1180, aimBias: 6, aimScatter: 40, base: 150,
  },
  toe: {
    id: 'toe', name: 'TOE KICK', contact: 'foot',
    idealX: 96, idealY: -72, spanX: 60, spanY: 42,
    strikeTick: 5, swingTicks: 16,
    pop: 810, aimBias: -34, aimScatter: 62, base: 250,
  },
  /*
   * The fifth move, and the one the original's best tricks are built on: Doda,
   * Reverse Doda and Squinty O Toole are all `outer jerk + header + outer
   * jerk` shapes. Without a header those names cannot exist.
   *
   * It shares the UP binding with the knee rather than taking a fifth key —
   * the legend is already four items and a fifth would push it past being
   * read. Which one fires is decided by where the bag actually is: above
   * `HEADER_MIN_HEIGHT` you head it, below that you knee it. That is also how
   * a person plays: you do not choose between your knee and your head, the
   * ball's height chooses for you.
   */
  header: {
    id: 'header', name: 'HEADER', contact: 'head',
    /*
     * `idealY` is the CROWN of a standing player, measured from the rig rather
     * than guessed: hip 114 + (torso 64 - 7) + neck 15 + head radius 28 = 242
     * rig units, x PLAYER_SCALE 1.16 = 281 world px above the lawn. The first
     * value here was -232, which is the player's *face* — the pose solver was
     * behaving correctly by not rising, and the bag simply met nothing.
     */
    idealX: 8, idealY: -281, spanX: 52, spanY: 70,
    strikeTick: 8, swingTicks: 22,
    pop: 1120, aimBias: 0, aimScatter: 34, base: 220,
  },
}

/**
 * Bag height (local px, up negative) at or above which UP heads the bag
 * instead of kneeing it. Sits between the knee window's top edge and the
 * header window's bottom edge, so neither move is ever unreachable.
 */
export const HEADER_MIN_HEIGHT = -196

/**
 * The four that `THE WORKS` counts. The header is deliberately outside it: it
 * shares a key with the knee, so requiring both inside one four-contact window
 * would make the existing bonus depend on bag height rather than on vocabulary.
 */
export const MOVE_ORDER: readonly MoveId[] = ['inside', 'outside', 'knee', 'toe']

/**
 * Press-to-move bindings, tested in this order.
 *
 * The two directions come first because they are the harder pair: if a player
 * mashes Down and A in the same frame they meant the toe kick.
 */
export const TRIGGERS: readonly (readonly [ActionId, MoveId])[] = [
  [Action.Down, 'toe'],
  [Action.Up, 'knee'],
  [Action.B, 'outside'],
  [Action.A, 'inside'],
]

/** How well the bag was struck. Drives the impulse, the points and the sound. */
export type ContactGrade = 'perfect' | 'clean' | 'glance' | 'whiff'

/** `err` is the normalised elliptical distance from the centre of the window. */
export function gradeFor(err: number): ContactGrade {
  if (err <= 0.5) return 'perfect'
  if (err <= 1) return 'clean'
  if (err <= 1.5) return 'glance'
  return 'whiff'
}

/**
 * Repeating a move is worth progressively less.
 *
 * Halving per repeat is steep on purpose: two inside kicks in a row still score,
 * four is worth barely more than one, so the only way the score moves is variety.
 * The floor stops a stuck player from earning literally nothing.
 */
export const repeatFactor = (streak: number): number =>
  streak <= 0 ? 1 : Math.max(0.12, Math.pow(0.48, streak))

export interface ChainTier {
  /** Chain length at which this name fires. */
  readonly at: number
  readonly name: string
  readonly bonus: number
}

/**
 * Named chains. The chain counts consecutive clean contacts where each move
 * differs from the one before it, so it is a measure of vocabulary, not of
 * stamina — a long rally of one move never gets past LINK.
 */
export const CHAIN_TIERS: readonly ChainTier[] = [
  { at: 3, name: 'LINK', bonus: 75 },
  { at: 5, name: 'FLOW', bonus: 200 },
  { at: 7, name: 'RHYTHM', bonus: 450 },
  { at: 10, name: 'CLOCKWORK', bonus: 900 },
  { at: 14, name: 'GOLDEN GATE SET', bonus: 2000 },
]

/** Bonus for covering all four moves inside a four-contact window. */
export const WORKS_NAME = 'THE WORKS'
export const WORKS_BONUS = 500

/** Chain multiplier applied to every contact. Caps so it stays readable. */
export const chainMultiplier = (chain: number): number =>
  1 + 0.2 * Math.min(chain, 10)

/* ------------------------------------------------------------------ tricks --- */

/**
 * The original's named tricks.
 *
 * c64-wiki lists Foot Bag's scoring table by name, and those names are the
 * event's identity — the chain system was only ever a stand-in for them. Each
 * entry below keeps the original's **name and point value**; what is adapted is
 * the input shape, because our vocabulary is five moves and a side rather than
 * the original's joystick-and-fire.
 *
 * `seq` is matched against the most recent contacts, oldest first. `side` is
 * -1 or 1 in the player's own frame, and `null` means either side — so
 * HORSESHOE requires two outer contacts on *different* feet, while FIVE IN A
 * ROW does not care.
 *
 * Not implemented, and why:
 *   - the Axle family (Half Axle 250, Full Axle 500, Axle Foley 750) is scored
 *     on 180/360 turns *between* shots, and we have no turn control;
 *   - Catch the throw-in (1500) needs the bag to leave the screen and be
 *     thrown back, which our bag never does;
 *   - Jester (2000) is a shot taken mid-jump, and the player never leaves the
 *     ground under their own control.
 * Those four need new verbs, not new patterns. Everything else is here.
 */
export interface TrickDef {
  readonly name: string
  readonly points: number
  /** Oldest first. `side: null` matches either. */
  readonly seq: readonly { readonly id: MoveId; readonly side: -1 | 1 | null }[]
  /** True when every named side must alternate rather than match literally. */
  readonly mirrored?: boolean
}

const L = -1 as const
const R = 1 as const

/**
 * Longest first: SQUINTY O TOOLE contains DOUBLE ARCH's opening, and whichever
 * matches first wins, so the big one has to be tested before the small one or
 * it can never fire.
 */
export const TRICKS: readonly TrickDef[] = [
  {
    // "right outside foot lift, left outside foot lift, headbutt ... knee"
    name: 'SQUINTY O TOOLE', points: 7500,
    seq: [{ id: 'outside', side: R }, { id: 'outside', side: L },
          { id: 'header', side: null }, { id: 'knee', side: null }],
  },
  {
    // "left + right + left outer jerk"
    name: 'DOUBLE ARCH', points: 2500,
    seq: [{ id: 'outside', side: L }, { id: 'outside', side: R }, { id: 'outside', side: L }],
  },
  {
    // "left outer jerk + header + right outer jerk"
    name: 'DODA', points: 5000,
    seq: [{ id: 'outside', side: L }, { id: 'header', side: null }, { id: 'outside', side: R }],
  },
  {
    // "right outer jerk + header + left outer jerk"
    name: 'REVERSE DODA', points: 5000,
    seq: [{ id: 'outside', side: R }, { id: 'header', side: null }, { id: 'outside', side: L }],
  },
  {
    // "front header + rear header" — ours is the two-sided pair.
    name: 'DIZZY DEAN', points: 1500,
    seq: [{ id: 'header', side: L }, { id: 'header', side: R }],
  },
  {
    name: 'HEAD BEANGER', points: 1500,
    seq: [{ id: 'header', side: R }, { id: 'header', side: L }],
  },
  {
    // "left heel shot + right heel shot"
    name: 'HORSESHOE', points: 500,
    seq: [{ id: 'outside', side: L }, { id: 'outside', side: R }],
  },
]

/** One contact, as the trick matcher sees it. */
export interface Contact { readonly id: MoveId; readonly side: -1 | 1 }

/**
 * The longest trick ending on the most recent contact, or null.
 *
 * `history` is oldest-first and may be longer than any pattern. Only sequences
 * that *end* on the latest contact count, so a trick fires on the frame it is
 * completed rather than drifting a touch later.
 */
export function matchTrick(history: readonly Contact[]): TrickDef | null {
  for (const t of TRICKS) {
    const n = t.seq.length
    if (history.length < n) continue
    const tail = history.slice(history.length - n)
    let ok = true
    for (let i = 0; i < n; i++) {
      const want = t.seq[i]
      const got = tail[i]
      if (got.id !== want.id) { ok = false; break }
      if (want.side !== null && got.side !== want.side) { ok = false; break }
    }
    if (ok) return t
  }
  return null
}

/** "Five in a row" (750): five consecutive scoring contacts, any moves. */
export const RUN_NAME = 'FIVE IN A ROW'
export const RUN_POINTS = 750
export const RUN_LENGTH = 5

/** "Fowl" (1000): the low-flying gull, struck with the bag. */
export const FOWL_NAME = 'FOWL'
export const FOWL_POINTS = 1000
