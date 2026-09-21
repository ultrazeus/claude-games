import { Container } from 'pixi.js'

export interface LayerOptions {
  /** 0 = pinned to the camera (sky), 1 = moves 1:1 with the world (ground). */
  factorX: number
  factorY?: number
  /**
   * Width after which the layer repeats. Required for endlessly scrolling events
   * (surfing, BMX, skating); omit for fixed-extent events (half pipe, footbag).
   */
  wrapWidth?: number
  /** How many copies to keep alive when wrapping. 3 covers any sane camera speed. */
  copies?: number
}

interface Layer {
  root: Container
  /** One entry per copy when wrapping, otherwise a single entry. */
  pieces: Container[]
  factorX: number
  factorY: number
  wrapWidth: number
  baseY: number
}

/**
 * Depth by layered scroll rates.
 *
 * Layers are positioned, never re-created, so scrolling costs a handful of
 * transform writes per frame regardless of how much art is in them. Wrapping
 * layers hold N copies of a content factory and shuffle them around the camera,
 * which gives an infinite backdrop with a bounded scene graph.
 */
export class Parallax {
  readonly container = new Container()
  private layers: Layer[] = []
  private camX = 0
  private camY = 0

  /** A layer with a fixed extent. The content is positioned, never repeated. */
  addLayer(content: Container, opts: LayerOptions): Container {
    const root = new Container()
    root.addChild(content)
    this.container.addChild(root)
    this.layers.push({
      root,
      pieces: [content],
      factorX: opts.factorX,
      factorY: opts.factorY ?? opts.factorX,
      wrapWidth: 0,
      baseY: content.y,
    })
    return content
  }

  /**
   * A layer that repeats forever. `factory` is called `copies` times and must
   * produce content exactly `wrapWidth` wide that tiles seamlessly.
   */
  addWrappingLayer(factory: (copyIndex: number) => Container, opts: LayerOptions & { wrapWidth: number }): Container[] {
    const copies = opts.copies ?? 3
    const root = new Container()
    const pieces: Container[] = []
    for (let i = 0; i < copies; i++) {
      const piece = factory(i)
      pieces.push(piece)
      root.addChild(piece)
    }
    this.container.addChild(root)
    this.layers.push({
      root,
      pieces,
      factorX: opts.factorX,
      factorY: opts.factorY ?? 0,
      wrapWidth: opts.wrapWidth,
      baseY: 0,
    })
    return pieces
  }

  /** Move the camera. Call once per render, after the sim has settled. */
  scrollTo(x: number, y = 0): void {
    this.camX = x
    this.camY = y
    for (const layer of this.layers) {
      const offsetX = -x * layer.factorX
      const offsetY = -y * layer.factorY
      if (layer.wrapWidth > 0) {
        const w = layer.wrapWidth
        // Index of the leftmost copy that should be on screen.
        const first = Math.floor(-offsetX / w)
        for (let i = 0; i < layer.pieces.length; i++) {
          layer.pieces[i].x = (first + i) * w + offsetX
          layer.pieces[i].y = offsetY + layer.baseY
        }
        layer.root.x = 0
        layer.root.y = 0
      } else {
        layer.root.x = offsetX
        layer.root.y = offsetY
      }
    }
  }

  get cameraX(): number { return this.camX }
  get cameraY(): number { return this.camY }

  destroy(): void {
    this.container.destroy({ children: true })
    this.layers.length = 0
  }
}
