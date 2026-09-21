import type { SceneFactory } from '../core/Scene'
import { Menu } from './ui/Menu'
import { HalfPipe } from './events/halfpipe/HalfPipe'
import { Surfing } from './events/surfing/Surfing'
import { Bmx } from './events/bmx/Bmx'
import { Skating } from './events/skating/Skating'
import { FootBag } from './events/footbag/FootBag'
import { FlyingDisc } from './events/flyingdisc/FlyingDisc'

/**
 * Every scene in the game.
 *
 * This is the only module that imports the events. Event authors own their own
 * directory and nothing else, so parallel work never collides here.
 */
export const SCENES: Record<string, SceneFactory> = {
  menu: () => new Menu(),
  halfpipe: () => new HalfPipe(),
  surfing: () => new Surfing(),
  bmx: () => new Bmx(),
  skating: () => new Skating(),
  footbag: () => new FootBag(),
  flyingdisc: () => new FlyingDisc(),
}
