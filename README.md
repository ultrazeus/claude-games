# California Games

A browser remaster of **California Games** (Epyx, 1987) — all six events,
written with Claude in TypeScript and PixiJS. It was built with the
[gauntlet-loop](https://github.com/robonuggets/gauntlet-loop), which loops a
builder and a separate harsh critic on each piece until it wins a blind
comparison against a real quality bar.

There are no image files and no audio files. Every shape is drawn as vectors at
runtime and every sound is synthesised on the fly, which is why the whole game
is about 130 KB and starts instantly.

**[▶ Play it in your browser](https://ultrazeus.github.io/claude-games/)**

![The menu](docs/shots/menu.png)

## The events

|  |  |
|---|---|
| **Half Pipe** — Hollywood, under a purple sky. Pump the transition, air off the lip, land it. | **Surfing** — Ride the pocket, get tubed, launch off the lip. Five judges score the ride. |
| ![Half Pipe](docs/shots/halfpipe.png) | ![Surfing](docs/shots/surfing.png) |
| **BMX** — A banked dirt course out in the desert. Air the jumps, spin, land clean. | **Roller Skating** — A boardwalk at golden hour. Clear the cracks, sand and banana skins. |
| ![BMX](docs/shots/bmx.png) | ![Roller Skating](docs/shots/skating.png) |
| **Foot Bag** — A lawn under the Golden Gate. Keep the bag up and chain the named tricks. | **Flying Disc** — Yosemite. Set angle and power against the wind, then run under it and catch. |
| ![Foot Bag](docs/shots/footbag.png) | ![Flying Disc](docs/shots/flyingdisc.png) |

## Controls

Each event shows its own controls on screen while you play.

| Key |  |
|---|---|
| **Arrows** | Move, steer, lean, spin |
| **Space** | The main action — jump, grab, pump, throw |
| **Shift** | The second action, where an event has one |
| **Enter** | Start, and play again from a results screen |
| **Esc** | Back to the menu |
| **M** | Music on / off |
| **N** | Wind, surf and tyre noise on / off |

Both audio settings are remembered between sessions.

## How close is it to the original?

Where the 1987 game is documented, this follows it:

- **90-second runs**, not the minute and a quarter that merely feels about right
- **Three falls ends a run** in Half Pipe, Surfing, Skating and BMX — Foot Bag
  is exempt, and the original says so explicitly
- **Three throws** in Flying Disc
- **Foot Bag's named tricks at their original point values** — Doda 5000,
  Squinty O Toole 7500, Double Arch 2500, Horseshoe 500, and Fowl 1000 for
  knocking the seagull out of the sky
- **A judges' results screen after every event**, which is how the original does
  it — the panel is shared, not a Surfing jury

The sponsors are invented. The original plastered real 1987 brands over
everything and that density is part of the look, so this has its own.

## Running it locally

```bash
npm install
npm run dev          # http://localhost:5273
```

```bash
npm run build        # typecheck + production build into dist/
npm run preview      # serve the built bundle
```

Node 18 or newer. No asset pipeline, no environment variables, nothing to
download.

## Reading the code

```
src/core/       App, Loop, Input, Audio, Music, Scene
src/render/     Palette, Hud, Gradient
src/game/ui/    Menu, Results
src/game/events/<event>/
```

Four decisions shaped most of it:

- **The simulation runs at a fixed 1/60 and rendering interpolates between
  ticks**, so the physics is identical on every machine while motion stays
  smooth at any frame rate.
- **Each event owns a palette rather than a set of colours.** One hue family, an
  accent reserved for the athlete, and depth applied by grading instead of fog —
  `src/render/Palette.ts`.
- **Music is a sequencer, not a player.** `src/core/Music.ts` schedules seven
  tunes using Web Audio lookahead, so a busy frame can't make them stutter.
- **The art rules are written down.** `ENGINE.md` covers the value plans and
  composition; `SOURCE-NOTES.md` records what the original does, quoted from the
  source.

## How it was built

The whole thing came from one prompt, written by the
[gauntlet-loop](https://github.com/robonuggets/gauntlet-loop) skill and pasted
into a fresh session. It ran from there.

<details>
<summary>The prompt</summary>

```
Build a browser remaster of California Games (Epyx, 1987) — the full event
roster, modern graphics, arcade feel intact.

The bar is OlliOlli World for art direction and game feel, and Alto's Odyssey
for smoothness and atmosphere. Pull real screenshots and footage of both and
compare against those directly, not against a description of them. The
measurable half: locked 60fps at 1080p in Chrome, under three seconds from load
to playable, input to on-screen response within two frames.

Break this into the smallest pieces that can be improved and judged on their own
— each event's controls and feel, art, parallax, animation, audio, menus,
transitions. For each piece, fan out a builder and a separate critic with fresh
context. The critic plays the actual build, puts our capture next to the
reference blind with the labels stripped, says which is better, and names the
single biggest remaining gap. Then it goes back to the builder.
Use the /browse skill for anything in a browser.

The critic should be a harsh critic. Praise is not useful. If ours does not win,
it keeps going.

/loop on each piece until the critic picks ours blind. Do not stop before that.

Keep a live progress page updating as the work evolves so I can watch it.

Fan out subagents and ultracode.
```

</details>

It worked: sixty-five blind comparisons later, every event beat its reference.

Two clauses did not survive contact, and they are worth stating plainly.

**"The critic *plays* the actual build."** It never did. Every verdict judged a
still screenshot. So the art was tested exhaustively and the feel was not tested
at all — and the first person to actually sit down and play it immediately found
a crash on a well-landed BMX jump, a banana skin and a beach ball that were
never drawn at all (only their shadows), and a control legend naming keys that
weren't bound to anything. None of it visible in a screenshot.

**"Locked 60fps at 1080p, response within two frames."** Never measured. The
only browser available to the loop had no GPU, so every performance figure it
produced was meaningless and none is quoted here.

The lesson is not that the loop failed — the art really did clear a high bar.
It is that a process quietly substitutes what it *can* check for what it was
*asked* to check, and nothing inside it notices.

## Credits

California Games is © Epyx, 1987. This is an independent, non-commercial remake
built for the love of it. It shares no code or assets with the original and is
not affiliated with or endorsed by any rights holder. If you hold those rights
and would like it taken down, open an issue and it will be.

Code is MIT licensed — see [LICENSE](LICENSE).
