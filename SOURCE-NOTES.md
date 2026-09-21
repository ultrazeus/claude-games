# The original as source of truth

California Games, Epyx, 1987. This document says what the game **is**. It is not
the quality bar — OlliOlli World and Alto's Odyssey are the bar. This is the thing
we must still be recognisably remaking when we get there.

Reference images are in `refs/original/`:

- `c64-<event>.png` and `c64-<event>-strip.png` — the 1987 Commodore 64 original,
  the canonical look. The strips are four frames of animation each.
- `<event>-0N.png` — the 1991 Mega Drive port, higher fidelity, useful for reading
  layout and staging. Note it **dropped Flying Disc** and added Double Pipe/Double
  Bag, so it is not authoritative on the event roster.

## The roster

Six events. All six ship. This is the 1987 Commodore 64 roster.

### 1. Half Pipe

Side-on cross-section of a skateboard vert ramp. The Hollywood sign sits on green
hills behind it under a **purple sky** — the single most recognisable frame in the
game. Palm trees flank the ramp. Sponsor decals run along the ramp wall.

Pump down the transition to build speed, launch off the lip, trick in the air, land
back on the ramp. Tricks are named on landing (the original prints e.g. "AERIAL
TURN"). Bail and you lose time. Run is timed, around 1:15.

### 2. Foot Bag

Hacky sack on a lawn with the **Golden Gate Bridge** and the Marin headlands
behind, bay in between, a footpath in the foreground. One character, centred,
mostly stationary.

Keep the bag in the air. Different inputs produce different named moves, each worth
points, with harder moves worth more. Timed.

### 3. Surfing

Side-on view of a wave face. Deep blue water, heavy white foam, cyan sky. A sponsor
banner and a timer sit at the top.

Ride the face: carve up and down, cut back, get tubed, launch aerials off the lip.
Scored on points like every other event — "the more tricks, the more points",
"riding close to the wave peak gets you more points". (An earlier draft of this
file said "judged as a score out of 10"; the source does not say that, and the
word "judge" appears nowhere in it. See CLAUDE.md.) Mistime it and you wipe out,
and **three falls ends the run**. The original tracks time spent in the tube.

### 4. Roller Skating

Side-scrolling boardwalk. Low wall with posts separating path from sand, beach
beyond.

Skate right along the boardwalk. The path is littered with hazards — cracks, sand
patches, banana skins, beach balls. Jump them, and spin or handstand over them for
points. Hitting one puts the skater on the floor and costs you.

### 5. BMX

Side-scrolling desert course. Pale washed sky, tan and ochre dirt, cacti, distant
mountains, rolling dirt jumps.

Ride right over a course of jumps and dips. Air off the lips and trick — the
original has jump, 360, and a back flip. Land badly and you crash hard. Timed, with
points for tricks.

### 6. Flying Disc

The one the Mega Drive port cut, and the odd one out structurally: **two phases**.

A wide green field with a purple river band across it and mountains behind. A
narrow **overhead strip along the top** shows the field from above with the disc
and the receiver on it. **SPEED** and **ANGLE** gauges sit at the bottom.

Phase one, throw: set angle and power against the wind. Phase two, catch: you now
control the receiver, running under the disc to catch it, diving if needed. Scored
on distance and on the quality of the catch.

## The shared frame

These are identity, not decoration. Losing them loses the game.

- **Status bar.** The original keeps a persistent bar with the player name, the
  sponsor, and the score. Ours needs its own equivalent — a consistent bottom or
  top band across all six events.
- **Sponsor culture.** Real 1987 brands plastered on everything (Ocean Pacific,
  Santa Cruz, Casio, Kawasaki). We invent our own period-correct equivalents rather
  than using real marks, but the *density* of branding is part of the look.
- **The judges' screen.** Between events — *every* event, not just Surfing — a
  row of judges under palm trees holds up scorecards, under a banner naming the
  player's sponsor. It is the results screen, not a per-event jury. Warm,
  staged, silly. Worth keeping. **Built, but currently wired to Surfing alone.**
- **The title screen.** Palm tree, sunset, a big stacked "CALIFORNIA / GAMES"
  logotype.
- **The high-score table**, on a sunset with a fat sun on the horizon.
- **Event select**, letting the player take one event or run all six.
- **Californian everything.** Every backdrop is a specific place: Hollywood, the
  Golden Gate, the Pacific, a boardwalk, the desert. Generic scenery is a failure.
