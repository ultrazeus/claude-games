/** The six events of the 1987 original, in run order. */
export interface EventMeta {
  id: string
  /** Display name, as the original titles it. */
  name: string
  /** One line of what the player does. */
  blurb: string
  /** Palette key in src/render/Palette.ts. */
  palette: string
}

export const EVENTS: readonly EventMeta[] = [
  { id: 'halfpipe',   name: 'Half Pipe',      blurb: 'Pump the transition, launch the lip, land it clean.', palette: 'halfpipe' },
  { id: 'surfing',    name: 'Surfing',        blurb: 'Carve the face, get tubed, air off the lip.',          palette: 'surfing' },
  { id: 'bmx',        name: 'BMX',            blurb: 'Desert jumps. Air, trick, land or crash.',             palette: 'bmx' },
  { id: 'skating',    name: 'Roller Skating', blurb: 'Golden-hour boardwalk. Jump every hazard.',            palette: 'skating' },
  { id: 'footbag',    name: 'Foot Bag',       blurb: 'Keep the bag up. Chain the named moves.',               palette: 'footbag' },
  { id: 'flyingdisc', name: 'Flying Disc',    blurb: 'Throw against the wind, then run it down and catch.',   palette: 'flyingdisc' },
] as const

export const eventById = (id: string): EventMeta | undefined => EVENTS.find((e) => e.id === id)
