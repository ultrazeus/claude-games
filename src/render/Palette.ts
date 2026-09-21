/**
 * The shared colour system.
 *
 * Six events built in parallel will drift apart visually unless they draw from one
 * palette, so every colour in the game comes from here. Each event gets its own
 * time-of-day mood, but all of them are cut from the same saturation and value
 * discipline: saturated, graphic foregrounds that read as flat shapes, and
 * desaturated, lifted backgrounds that fall away with distance.
 *
 * Values are Pixi-style 0xRRGGBB numbers.
 */

export type Hex = number

/** Linear blend between two colours. t=0 returns a, t=1 returns b. */
export function mix(a: Hex, b: Hex, t: number): Hex {
  const it = t < 0 ? 0 : t > 1 ? 1 : t
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff
  const r = Math.round(ar + (br - ar) * it)
  const g = Math.round(ag + (bg - ag) * it)
  const bl = Math.round(ab + (bb - ab) * it)
  return (r << 16) | (g << 8) | bl
}

export const lighten = (c: Hex, t: number): Hex => mix(c, 0xffffff, t)
export const darken = (c: Hex, t: number): Hex => mix(c, 0x000000, t)

/**
 * Push a colour back in space. The workhorse for depth.
 *
 * Not a plain lerp toward the haze: that drains value as well as saturation and
 * turns distant layers to mud. This drops saturation the way OlliOlli World does,
 * takes only a little value the way Alto's does, and *then* dissolves toward the
 * haze. For finer control use `grade()` with `graphicDepth` or `atmosphericDepth`.
 */
export const aerial = (c: Hex, haze: Hex, depth: number): Hex => {
  const d = depth < 0 ? 0 : depth > 1 ? 1 : depth
  const faded = grade(c, {
    satScale: 1 - 0.42 * d,
    valScale: 1 - 0.14 * d,
    fog: haze,
    fogAmount: 0.4 * d,
  })
  // Saturation ceiling. Fogging a low-chroma colour toward a *saturated* haze
  // (a deep blue sky, say) pushes chroma back UP, which silently inverts the
  // depth cue the call was made to produce. Clamp so a distant thing can never
  // end up more saturated than it started.
  const before = toHsv(c)
  const after = toHsv(faded)
  const ceiling = before.s * (1 - 0.3 * d)
  return after.s <= ceiling ? faded : fromHsv({ ...after, s: ceiling })
}

export function toCss(c: Hex, alpha = 1): string {
  const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`
}

/** Evaluate a multi-stop gradient at t (0..1). */
export function gradientAt(stops: readonly { t: number; c: Hex }[], t: number): Hex {
  if (stops.length === 0) return 0x000000
  if (t <= stops[0].t) return stops[0].c
  const last = stops[stops.length - 1]
  if (t >= last.t) return last.c
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1]
    if (t >= a.t && t <= b.t) {
      const local = (t - a.t) / (b.t - a.t || 1)
      return mix(a.c, b.c, local)
    }
  }
  return last.c
}

// ---------------------------------------------------------------------------
// Depth grading
//
// Measured from the two reference games (see refs/BAR-ANALYSIS.md), both looks
// reduce to one primitive: a per-layer colour transform driven by depth.
//
//   OlliOlli World: saturation falls ~45% across the depth range, value barely
//   moves (<=15%), and the *rendering mode* changes per band instead — filled
//   and outlined up close, a single flat tint in the middle, bare linework far
//   away.
//
//   Alto's Odyssey: hue is locked within ~6 degrees, saturation holds or rises,
//   value falls 15-25% per layer, and every layer is lerped toward the sky
//   gradient sampled at that layer's own screen height.
//
// Doing this in HSV rather than lerping toward a flat grey is what stops distant
// layers going muddy, which is the usual failure of naive aerial perspective.
// ---------------------------------------------------------------------------

export interface Hsv { h: number; s: number; v: number }

export function toHsv(c: Hex): Hsv {
  const r = ((c >> 16) & 0xff) / 255
  const g = ((c >> 8) & 0xff) / 255
  const b = (c & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function fromHsv(hsv: Hsv): Hex {
  const h = ((hsv.h % 360) + 360) % 360
  const s = hsv.s < 0 ? 0 : hsv.s > 1 ? 1 : hsv.s
  const v = hsv.v < 0 ? 0 : hsv.v > 1 ? 1 : hsv.v
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
}

export interface DepthGrade {
  /** Multiplies saturation. Below 1 washes out, above 1 enriches. */
  satScale?: number
  /** Multiplies value. Below 1 darkens. */
  valScale?: number
  /** Degrees of hue rotation. Keep tiny; both reference games lock hue. */
  hueShift?: number
  /** Colour the layer is lerped toward after the HSV transform. */
  fog?: Hex
  /** How far toward `fog`, 0..1. */
  fogAmount?: number
}

/** Apply a depth grade to one colour. */
export function grade(c: Hex, g: DepthGrade): Hex {
  const hsv = toHsv(c)
  const out = fromHsv({
    h: hsv.h + (g.hueShift ?? 0),
    s: hsv.s * (g.satScale ?? 1),
    v: hsv.v * (g.valScale ?? 1),
  })
  return g.fog !== undefined && g.fogAmount ? mix(out, g.fog, g.fogAmount) : out
}

/**
 * The OlliOlli World depth curve: saturation falls hard, value holds.
 * Pair it with a render-mode change per band for the full effect.
 */
export const graphicDepth = (depth: number): DepthGrade => ({
  satScale: 1 - 0.45 * depth,
  valScale: 1 - 0.12 * depth,
})

/**
 * The Alto's Odyssey depth curve: saturation holds or rises, value falls, and
 * the layer dissolves into the sky behind it. `skyBehind` should be the sky
 * gradient sampled at this layer's own screen height — that is what keeps a
 * day-night cycle from going muddy between keyframes.
 */
export const atmosphericDepth = (depth: number, skyBehind: Hex): DepthGrade => ({
  satScale: 1 + 0.16 * depth,
  valScale: 1 - 0.34 * depth,
  fog: skyBehind,
  fogAmount: 0.55 * depth,
})

/** Sample an event's sky gradient at a fraction of screen height (0 = top). */
export const skyAt = (palette: EventPalette, t: number): Hex => gradientAt(palette.sky, t)

/** Colours shared by every event: UI, characters, common props. */
export const Core = {
  /** The one bright accent. Used for scores, highlights, the sun. */
  sunGold: 0xffc93c,
  sunWhite: 0xfff3c4,
  hotPink: 0xff4f81,
  electricCyan: 0x2fe6d6,
  deepInk: 0x151226,
  softInk: 0x2c2740,
  paperWhite: 0xfdf8ee,
  // Character palette. Kept consistent so the athlete reads as one person.
  skinLight: 0xf0b98d,
  skinMid: 0xc9855c,
  skinDeep: 0x8a5334,
  hairSun: 0xf2d07a,
  suitPrimary: 0xff4f81,
  suitSecondary: 0x2fe6d6,
  suitDark: 0x2b2545,
  /**
   * Foot Bag reserves this one rose-crimson for the contestant's kit — shirt,
   * shorts, shoes and headband. It is the only thing in that event carrying
   * hue 330-350 at any chroma worth the name: the background is locked to the
   * cyan-blues around 205, the bag owns the warm 20-45 band, and the HUD is
   * grey. It exists as a named constant so the reservation is checkable.
   */
  footbagKit: 0xf50f63,
} as const

export interface EventPalette {
  /** Vertical sky gradient, top to horizon. */
  sky: readonly { t: number; c: Hex }[]
  /** Colour distant geometry fades into. */
  haze: Hex
  /** Sun/light source tint for rim lighting and bloom. */
  light: Hex
  /** Background-most terrain or water. */
  far: Hex
  mid: Hex
  /** The surface the athlete is on. */
  near: Hex
  /** Deepest shadow in the scene. Never pure black. */
  shade: Hex
  /** Event-specific accent for props, banners, particles. */
  accent: Hex
  accent2: Hex
}

/**
 * Per-event moods. Each is a different hour of the same day, which gives the
 * six-event run an arc instead of six unrelated looks.
 */
export const Palettes: Record<string, EventPalette> = {
  // Dawn, and the whole frame is water — so this palette is written as a
  // **value plan** first and as a set of hues second, and the plan was
  // inverted by the review that killed the last version.
  //
  // The old version made the sky the light mass and let the wave fall away
  // under it. A neutral review measured what that costs and named it:
  //
  //   "B's value structure is inverted against its own subject: the wave — the
  //    hero — is the darkest, lowest-chroma mass in the picture, while the
  //    brightest thing is empty sky at upper right. The eye lands on nothing."
  //
  // So the masses are reassigned. The sun is low and BEHIND the wave, which
  // means the physically true reading and the compositionally useful one are
  // the same reading: water a few centimetres thick at the lip transmits, and
  // it is the brightest surface in the frame. The sky, seen against that, is a
  // quiet mid band.
  //
  //   light mass — the wave face from the lip down through the shoulder,
  //                lum 0.95 falling to 0.61. The hero is the lit thing.
  //   mid  mass  — the sky, lum 0.30-0.44 across the wedge that is ever on
  //                screen, chroma under 0.42 and falling. It sits BEHIND the
  //                subject and it is never allowed to out-value it. Measured
  //                on the last capture, dropping it this far is what takes the
  //                rider's contrast against what is behind him from 0.42 to
  //                0.49 without touching him.
  //   dark mass  — the lower face and everything below the terminator,
  //                lum 0.41 down to 0.17.
  //
  // One hue family, 160-215 degrees, for everything that is water or sky. The
  // warm half of the wheel is rationed to two things and nothing else: the sun
  // and the light coming through the lip. The vermilion is the rider's alone.
  //
  // Chroma is capped at 0.45 across every non-player surface; see `sea()` in
  // the event. Measured with the detector's own metric that puts the whole
  // background under 0.36 against the suit's 0.59, which is the reservation
  // stated as a number rather than as an intention.
  surfing: {
    sky: [
      { t: 0, c: 0x2b3f57 },
      { t: 0.18, c: 0x334860 },
      { t: 0.28, c: 0x3c5169 },
      { t: 0.36, c: 0x455a72 },
      { t: 0.43, c: 0x4e637a },
      { t: 0.50, c: 0x596d84 },
      { t: 0.60, c: 0x687a8e },
      { t: 1, c: 0x7a8a9a },
    ],
    haze: 0x748799,
    light: 0xffe0b0,
    far: 0x53789e,
    mid: 0x3d6386,
    near: 0x2b4a6e,
    shade: 0x172636,
    accent: 0xdff0f4,
    /** The rider's reserved vermilion. Nothing else in the event may use it. */
    accent2: 0xc41f18,
  },
  // Bright mid-morning over the bay — but re-cut as a **three-mass value plan**
  // rather than as a set of naturalistic local colours.
  //
  // A neutral review of the old version said the frame had "five mid-value,
  // mid-saturation hues all shouting at the same volume", and that the athlete
  // was "the smallest, palest, least saturated object in the frame". Both are
  // palette failures, so the palette is where they are answered:
  //
  //   light mass  — sky, v 0.83-0.96, chroma under 0.34. One band, no drama.
  //   mid  mass   — water, hills, bridge, seawall, v 0.58-0.70, chroma under 0.36.
  //   dark mass   — the lawn, v 0.29-0.47, and the only background surface
  //                 allowed real chroma.
  //
  // Every background hue sits in the 190-215 degree cyan-blue family and the
  // lawn is pulled to a sea-green at 160 so it stays in that family too. The
  // whole warm half of the wheel is **reserved**: gold and orange for the bag,
  // and one crimson that only the athlete may wear (see `Core.footbagKit`).
  //
  // The sky ramp was then **re-cut**, and it is the single largest change this
  // palette has had. It used to run 0.67 -> 0.91 luminance over the whole
  // canvas, which is a 24-point spread across 760 pixels: a gradient that slow
  // is, at a squint, one flat tone. A neutral review measured the consequence
  // rather than guessing at it — "roughly 55% of the canvas is empty gradient"
  // — and no amount of cloud drawing fixes a ramp that gentle, because the
  // clouds have to sit inside it.
  //
  // It now runs 0.32 at the zenith to 0.86 at the waterline. A deep azure top
  // does three things at once: it halves the height of any one value band, it
  // gives the pale horizon haze somewhere to read as light, and it means the
  // cloud forms in `Scenery.buildSkyForms` can sit at mid value — lighter than
  // the zenith, darker than the horizon — instead of having to be white to be
  // seen. Nothing in the sky is allowed to out-value the contestant's rim.
  //
  // Re-cut a third time, and this one is a **measured** value plan rather than a
  // described one. A neutral review put a number on the failure: "A's sky,
  // water, hills and clouds all sit inside roughly a 20% luminance band
  // (#5f80a2, #7e9ab0, #6f8ba4, #b9cad9) — the bridge tower at #8a7a68 is the
  // highest-contrast object in the frame, so your eye lands on scenery, not on
  // the player." Both halves of that are palette faults.
  //
  // The three masses are now measured in luminance, not asserted:
  //
  //   sky        0.33 at the top of frame -> 0.84 at the waterline. The ramp is
  //              twice as steep as it was, which halves the height of any one
  //              value band and is most of why the canvas stops measuring as
  //              empty gradient.
  //   headlands  0.66 far, 0.47 near spur. The far band is DELIBERATELY light:
  //              it is what the contestant's head and shoulders sit against, and
  //              the frame's biggest value break has to belong to him.
  //   bay+wall   0.82 at the waterline falling to 0.59, seawall 0.71. A sunlit
  //              midday bay is a LIGHT mass, and it is the band the crimson kit
  //              is punched out of.
  //   lawn       0.43 at the verge -> 0.17 at the bottom edge, kerb 0.11, near
  //              bank 0.14. The dark third of the frame, and it is where his
  //              feet are.
  //
  // Hue is unchanged in intent and tightened in fact: every background surface
  // is cyan-blue 190-215 and **none of it exceeds 0.31 chroma**. The warm half
  // of the wheel is spent on exactly two objects, and the reservation is now
  // ordered as well as exclusive — the kit sits at 0.88 chroma, the bag's shell
  // and panels at 0.71 and 0.77, so the contestant is unambiguously the most
  // colourful thing in the frame and the bag is unambiguously the second.
  //
  // `accent` in particular came DOWN. It used to be 0xf2681c, which measures
  // 0.93 chroma — more colourful than the contestant's own kit. The single most
  // chromatic object in an event named after its hero was a 30px prop.
  // Re-cut a FOURTH time, and this one throws out the premise of the last three.
  //
  // Every version above tried to give the background a value plan of its own —
  // a steep sky ramp, a light bay, a deliberately pale far headland — on the
  // theory that a background with internal structure reads as designed. It
  // measures well and it loses blind A/Bs, and the review that beat it said
  // why: "sky, hills, seawall and the callout glyphs all sit inside a ~25-luma
  // band, 44% of the frame falls in luma 120-200, and the highest-contrast
  // objects in the entire image are the near-black UI chips in the corners."
  // A background with FIVE mid values is not structured, it is undecided: every
  // plane is competing at the same volume, so nothing recedes and nothing
  // advances, and the eye ends up on whatever genuinely has contrast — which
  // was the HUD.
  //
  // So the background gives up its value plan entirely. It is ONE quiet plate
  // now, and the whole of it lives inside fourteen points:
  //
  //   sky        0.72 at the zenith -> 0.86 at the waterline. Not a ramp any
  //              more; a tone with a breath of gradient in it.
  //   clouds     derived from the sky they sit in, so they follow it down.
  //   bay        0.80 -> 0.72. Was a 0.82 -> 0.59 internal ramp.
  //   seawall    0.76. Was 0.70 with its own lit/shade split.
  //   headlands  0.74 far, 0.62 near spur — the ONE deliberate step left in the
  //              background, because a distance with no step at all is fog.
  //
  // Two values where there were five, and its overall contrast is roughly a
  // third of what it was. Nothing in it can be mistaken for the subject.
  //
  // Re-cut a FIFTH time, and this one keeps the last cut's decision and fixes
  // the thing it got wrong. Collapsing the background to one quiet plate was
  // right. Leaving that plate at 0.72-0.86 was not, and a blind review named
  // the result exactly: "from the top of the sky to the seawall at y=640
  // everything lives inside a ~20-step value band, so the bridge towers,
  // clouds, hills and bay fuse into one grey mush."
  //
  // Measured on the capture, 68% of the playfield sat above 0.70 luminance. The
  // other five events in this game measure 0.08-0.25 there and all of them beat
  // this one. Crushing a background's CONTRAST while leaving its VALUE at the
  // top of the range does not make the athlete the light or the dark of the
  // frame — it paints a white wall and stands him in front of it.
  //
  // So the plate keeps its low internal contrast and moves down as a body, and
  // the land under it moves down much further. What comes out is three masses
  // in the order a landscape actually has them:
  //
  //   sky        0.57 at the zenith -> 0.80 at the waterline. Still one tone
  //              with a breath of gradient, just no longer a near-white one.
  //   clouds     derived from the sky at their own height, so the whole bank
  //              comes down with it. This is most of why the flat area falls:
  //              at a 0.86 sky the body/crown steps were pinned against the
  //              1.0 ceiling and every cumulus in the frame landed inside one
  //              0.05 bin. The same formula on a 0.57-0.80 sky spreads the
  //              bank from 0.42 to 0.87.
  //   headlands  0.60 far, 0.50 near spur.
  //   bay        0.66 -> 0.59. It stays the LIGHTEST band below the horizon on
  //              purpose: it is the plate the crimson kit is punched out of and
  //              a midday strait does glare.
  //   seawall    0.39, was 0.76. The single biggest move in the cut, because it
  //              is the band immediately behind his knees and it was reading at
  //              sky value. The ground he stands on is now unambiguously darker
  //              than the sky above him.
  //   lawn       0.30 at the verge -> 0.14 at the bottom edge, kerb 0.11, near
  //              bank 0.09.
  //
  // The athlete keeps both extremes: his sunlit rim is still the only thing in
  // the frame above 0.90 and his shoes are still its darkest note, but now the
  // frame has a ladder for them to be the ends of instead of a wall with one
  // dark mark on it.
  //
  // Hue is unchanged: every background surface is cyan-blue 190-215, the warm
  // half of the wheel is spent on exactly two objects, and the reservation is
  // ordered — the kit at 0.88 chroma, the bag's shell and panels at 0.71 and
  // 0.77.
  // Re-cut a SIXTH time, and this cut changes the *shape* of the plan rather
  // than sliding the last one up or down.
  //
  // Cuts three, four and five all argued about one number: how bright the
  // background plate should be. Three separate blind reviews then converged on
  // the same sentence, and none of them was about brightness:
  //
  //   "cloud at (798,360) and open sky 80px away are a TWO-LEVEL difference
  //    across the entire top 60% of the frame, built from one scalloped cloud
  //    stamp repeated at identical value."
  //
  // Measured on the capture, that is exactly right and the previous cut is not
  // what caused it. The ramp *did* reach the canvas — the zenith measures
  // 0.574, the number this file asks for. What sat at 0.78-0.83 was the CLOUD
  // BANK, every cumulus in the frame, because `cloudTones` derived each tone as
  // a fixed step above the sky behind it. Pin nine shapes to a ramp and they
  // inherit the ramp's flatness no matter what value the ramp is at.
  //
  // And the calibration point that kills the "bright frames lose" theory
  // outright: the reference frame this event is judged against measures
  // high_frac 0.39 and median 0.68 — BRIGHTER than ours at 0.26 / 0.62. It wins
  // because its masses are three separated tiers of coral, rose and cream, not
  // because it is dark.
  //
  // So the plate is abandoned as a goal. The sky gets a real ramp back, the
  // clouds stop being derived from it, and the ladder is built out of the
  // difference between them:
  //
  //   sky        0.53 at the zenith -> a HOT BAND at 0.91 around y=560, then
  //              easing back. The climb is deliberately front-loaded: the sky
  //              is over 0.70 from y=300 down, so the frame keeps the
  //              reference's brightness (high_frac 0.39, median 0.68) and the
  //              deep corner at the same time — and the near cumulus rank,
  //              written at 0.64-0.70, becomes DARKER than the sky it hangs in.
  //              A bank of dark scalloped masses on a bright sky is how Half
  //              Pipe wins three blind A/Bs in four. The hot band is sited where it can be seen: the
  //              far ridge runs at y 563-639, so a horizon glow at the
  //              waterline (y=733) would have been entirely behind the hills.
  //              This is the aperture the contestant stands in.
  //   clouds     three ABSOLUTE tiers, 0.86 / 0.70 / 0.56 at the crown with a
  //              cool belly a third of the way down from each. The low bank
  //              behind the hills is DARKER than the sky it sits on, which is
  //              what makes it a silhouette instead of a fourth pale smear.
  //   headlands  0.51 far, 0.40 near spur. They fall as the sky above them
  //              rises, so the ridge line carries a 0.34 step — the largest
  //              value break in the background and the one the eye reads as
  //              the horizon, 130px clear of the contestant.
  //   bay        0.52 -> 0.42, and pushed COOL. It is no longer "the lightest
  //              band below the horizon": a strait under a low sun is a dark
  //              cool plane with one hot smear on it, and that reading is what
  //              stops sky, hills and water reading as three grey stripes.
  //   seawall    0.36, lawn 0.30 -> 0.14 as before.
  //
  // The step from the water to the hills above it is kept deliberately SMALL.
  // The contestant's centre of mass sits 39px under the waterline, and a hard
  // horizontal there is measured as the frame's horizon — "a subject on the
  // horizon line is the single worst place to put one". The frame's two hard
  // edges are the ridge, 130px above him, and the kerb, 70px below.
  //
  // Hue stops being one family, and it stops being GREY, which is the finding
  // the value work kept walking past.
  //
  // Every cut above argued about luminance and left the chroma policy alone:
  // "every background surface is cyan-blue 190-215 and none of it exceeds 0.31
  // chroma". Measured against the set that policy produced, on the playfield,
  // mean chroma:
  //
  //     Foot Bag   0.079        <- loses five reviews in six
  //     Half Pipe  0.166   BMX  0.181   Surfing  0.217   <- all win
  //     the reference frame     0.367
  //
  // Foot Bag is the least colourful frame in the game by a factor of two, and
  // the three reviews that named the sky did not say "too bright", they said
  // "three unmotivated grey stripes" and "a third grey stripe". A capped
  // background is not the mechanism that reserves an accent — ORDER is, and
  // every winning event keeps its order at twice this chroma.
  //
  // So the background gets its colour back, spent as a warm/cool journey rather
  // than as saturation everywhere: a deep teal zenith, a gold hot band, cool
  // blue water, warm cloud crowns against cool blue bellies. Chroma runs
  // 0.13-0.33 across the background — level with Surfing.
  //
  // The reservation is unchanged and still ordered, because order is a ratio
  // and not a ceiling: the kit at 0.90 chroma, the bag's shell and panels at
  // 0.70 and 0.80, and the most colourful thing in the background at 0.33. The
  // athlete is still, unambiguously, the most colourful object in the frame.
  footbag: {
    sky: [
      { t: 0, c: 0x568da4 },
      { t: 0.14, c: 0x6d9aa6 },
      { t: 0.28, c: 0x8fb2ae },
      { t: 0.4, c: 0xd8cfa0 },
      { t: 0.52, c: 0xffe9b0 },
      { t: 0.66, c: 0xf0d79d },
      { t: 1, c: 0xdec28a },
    ],
    haze: 0xe3d2ac,
    light: 0xffefc8,
    far: 0x4d7285,
    mid: 0x3a5c6e,
    near: 0x246048,
    shade: 0x0a1d1a,
    /** The bag's panels. Kept below the kit's chroma on purpose; see above. */
    accent: 0xef7a24,
    /** The bag's shell. */
    accent2: 0xfcba45,
  },
  // An hour before sunset, through hanging desert dust. ONE hue family, top to
  // bottom: everything between 15 and 45 degrees, with no second temperature
  // anywhere in the frame.
  //
  // What was here before was blue sky over tan dirt with green cacti — three
  // families with nothing in common, and a neutral review named the first pair
  // for what it was: "the two colours that arrive for free in any engine". No
  // amount of lighting recovers from that, because every layer downstream is
  // graded against the sky.
  //
  // So the decision is made here. The sun is low and to the right and the air
  // is full of dust, which means:
  //
  //   - there is no blue in this event at all. Dust at a low sun angle scatters
  //     the short wavelengths out; the sky goes amber, pale near the sun and
  //     loaded with ochre away from it. It is still the LIGHT mass (mean
  //     luminance 0.75), it just is not cyan-blue;
  //   - the ridges and the open desert are the same family, pushed down in
  //     chroma and value, and they are the MID mass at 0.50;
  //   - the dirt of the course is a burnt sienna dark enough to be the NEAR
  //     mass at 0.27, which is most of what makes the frame survive a squint.
  //     It used to be 0xd9a066 — a tan lighter than some of the sky;
  //   - `shade` carries a violet lean, because the only light reaching a
  //     shadow at this hour is skylight. It is the one cool note in the
  //     environment and it is kept at very low chroma;
  //   - the vegetation is dried khaki, not cactus green. A saturated green is
  //     the third family that broke the old palette;
  //   - `haze` is warm, because distance under this light goes warm.
  //
  // Squinted, that is three separated masses, 0.25 of luminance apart, in a
  // fixed order. The rider's reserved cyan is then the only cool saturated hue
  // in the entire frame, and it sits on the break between the first two.
  // One warm family for the field, and one COOL complement (`shade`) reserved
  // for the ground the rider sits on, so the hero has a hue break and not only
  // a value break. A frame with no complement reads as flat as one with five.
  //
  // CHROMA RESERVATION, and it is arithmetic rather than taste. The frame is
  // read by taking the most colourful pixels and calling them the player, where
  // colourfulness is `(max-min) * (0.45 + 0.55*max)`. The old ramp put a third
  // of the canvas between 0.35 and 0.44 on that scale — an amber sky measurably
  // as colourful as the rider — so the two reserved hues did not detonate
  // against anything, they merely joined in. Every stop below is now held under
  // 0.26 and the rider's kit sits at 0.51-0.69, which is the gap the reference
  // wins with, stated as a number.
  //
  // The ramp was widened in value at the same time: the zenith drops to L 0.53
  // so the sky alone spans 43 points instead of sitting inside the same narrow
  // band as everything under it.
  bmx: {
    sky: [
      { t: 0, c: 0xa38162 },
      { t: 0.38, c: 0xc9a681 },
      { t: 0.70, c: 0xe6c8a1 },
      { t: 0.88, c: 0xf6e1c0 },
      { t: 1, c: 0xfff5db },
    ],
    haze: 0xe6c8a1,
    light: 0xffebc2,
    far: 0x8a6e70,
    mid: 0x8c644c,
    near: 0x543120,
    // The one cool note in an otherwise wholly warm frame. Reserved for the
    // ground the rider is on, so the hero gets a hue break as well as a value
    // break — a review found the previous all-amber frame had no complement at
    // all and the rider dissolved into the berm.
    shade: 0x2d2740,
    accent: 0x70693e,
    // Deliberately NOT cyan and NOT pink. Those are the rider's, and the
    // palette must not hand them back to props or the HUD through an accent.
    // Dropped to 0.33 colourfulness so that even the one warm accent in the
    // event cannot enter the band the rider's kit is reserved in.
    accent2: 0xa6633b,
  },
  // Autumn, an hour before the sun goes. The one explicit hue SPLIT in the
  // game: a warm sky against a cool field.
  //
  // The previous version of this event was blue-sky-over-green-grass, and a
  // neutral review named it for what it was — "the two colours that arrive for
  // free in any engine". Nothing else in the frame could recover from that,
  // because every layer was graded against it.
  //
  // So the decision is made here and everything downstream inherits it. The sun
  // is low and off to the right, which means:
  //
  //   - the sky ramps from a deep indigo at the zenith to a warm, RESTRAINED
  //     band at the horizon. It is the mid mass of the frame, not the light
  //     mass: the light mass is the disc, and nothing else is allowed into it;
  //   - the treeline on the far bank is backlit, so it is the DARK seam,
  //     sitting against the warmest part of the sky;
  //   - the grass is in the cool half of the split — a muted olive, not a
  //     poster green — and it steps DOWN in three flat bands toward the
  //     camera, so the lower half recedes instead of ping-ponging;
  //   - `haze` is warm, because distance under this light goes warm, not blue.
  //
  // Squinted, that is a funnel: dark at the top of the frame, a warm band
  // across the middle, dark at the bottom, and one small gold object carrying
  // forty-plus points of luminance over everything it crosses.
  //
  // The sky gradient is stretched over the FULL frame height, so the horizon at
  // y=430 lands at t≈0.4, and the camera's tilt can push it to t≈0.51 — which
  // is why the warm band is held nearly flat from 0.40 to 0.62 rather than
  // peaking on one stop.
  flyingdisc: {
    // THE SKY WAS INVERTED, AND IT MADE EVERY OTHER FIX ON THE DISC POINTLESS.
    //
    // The version above this one climbed toward the horizon — L=176 at y=140
    // rising to L=225 at y=340 — on the theory that a wide pale band gives the
    // athlete a value break to stand in. It does. It also parks the brightest,
    // emptiest value in the frame directly behind the one thing the event is
    // about. A blind review measured the gold disc against the sky it crosses
    // at five points along its arc and found the hero DARKER than its
    // background at every one of them, by six to sixteen points of luminance:
    //
    //   "The single most important thing in A's frame is functionally
    //    invisible, and only snaps into view where it crosses the green."
    //
    // Three passes re-keyed the disc, widened its ink ring and rebuilt its
    // flight arc. None of them could have worked. A subject cannot be found by
    // being made brighter when the background is already brighter than
    // anything the subject is allowed to be.
    //
    // So the gradient is inverted and deepened, and the ceiling is the design
    // constraint rather than the shape: NO STOP MAY EXCEED L=165. Composited
    // with the horizon haze band `Sky` lays over it, the brightest pixel of sky
    // anywhere in the frame measures L=160.9, at y=480.
    //
    // The number that ceiling is set against is the disc's PLATE — its largest
    // area — which is `mix(sunGold, sunWhite, 0.18)`, #ffd154, L=209.8, the
    // same gold as its drawn arc and its trail. It is worth saying which,
    // because the pass that wrote this paragraph quoted L=211 for the disc when
    // only the ARC measured 211: the disc's body was still at L=173 from a
    // previous keying, so on the half of the arc that crosses the warm band the
    // hero was clearing its background by twelve points rather than forty. See
    // the measured table in `flyingdisc/Disc.ts`.
    //
    // At L=209.8 against a 160.9 ceiling the disc carries +48.9 over the
    // brightest sky, +45 over the brightest mark in the scene (the hill crest's
    // rim light), and +75 or better over everything else its arc crosses. If a
    // later pass lifts these numbers, it has to re-key the disc first — and if
    // a later pass re-keys the disc, it has to re-key the plate, not the arc.
    //
    // It buys three things at once:
    //   - the throw is trackable, because the disc is the brightest thing in
    //     the frame by a wide margin and nothing else competes;
    //   - the frame gets the light-to-dark funnel it lacked: a warm band at
    //     the horizon, indigo above it, dark ground below it, so the eye is
    //     led to the middle instead of to the top corners;
    //   - the near-black HUD slabs drop from violent to merely heavy, because
    //     they no longer sit in a 200-plus sky.
    //
    // The athlete's break survives it: he stands across the horizon with his
    // legs on grass at L=58-92 and his head against sky at L=150, which is a
    // bigger local step than the pale band ever gave him. `break` measured
    // 0.651 against a reference's 0.283 under the old sky — it was never the
    // thing that was short.
    //
    //   t 0.00  L  38   zenith, deep indigo-navy, mostly behind the HUD strip
    //   t 0.16  L  83   the prescribed #4a517a, and the top of the disc's arc
    //   t 0.31  L 120   the athlete's head and shoulders
    //   t 0.40  L 152   the horizon at rest
    //   t 0.44  L 162   the ceiling, and it holds through the camera's tilt
    //
    // ---------------------------------------------------------------------
    // AND THEN THE FRAME HAD NO HIGHLIGHT ANYWHERE IN IT.
    //
    // The ceiling above is correct and it stays. What it did NOT license was
    // capping everything ELSE against the disc as well, which is what the rest
    // of the event quietly did — the sun to L=182, the bank to L=146, the
    // fairway to L=112 — until a blind review measured the result with the HUD
    // masked out and found a p99 of 153 and a median of 95:
    //
    //   "99% of its artwork sits in a 25-153 mid-dark mush with no highlight
    //    anywhere, which means the brightest thing in frame A is its own
    //    interface text at 255."
    //   "it paints dusk but lights the ground as if under flat overcast."
    //
    // The fix is in `flyingdisc/Field.ts` (GROUND_BANDS), not here: the sky
    // stays inverted and the GROUND takes the light, because the fairway is
    // the one large plane in the picture turned toward a sun eleven degrees
    // up. Five bands now run 196 / 156 / 112 / 72 / 31 down the frame.
    //
    // What that changes about the paragraphs above, stated plainly so the next
    // pass is not misled by them: the disc's plate at L=209.8 is still the
    // brightest OBJECT in the frame, but its margin is no longer +45 over
    // everything. It is +8.5 over the river bank (L=201.3), +11.4 over the
    // sun's own disc (L=198.4) and +13.3 over the sun rake band (L=196.5).
    // The +48.9 over the sky is untouched, and the sky is what the disc
    // actually crosses: the arc's lowest point is seventy-five pixels of sky
    // above the bank, so along every pixel of its flight the disc still clears
    // its background by forty-eight or better. A later pass that wants to lift
    // the ground further has to re-key the plate first, and if it re-keys the
    // plate it has to re-key the plate and not the arc.
    sky: [
      { t: 0, c: 0x1e2547 },
      { t: 0.08, c: 0x2c3358 },
      { t: 0.16, c: 0x4a517a },
      { t: 0.24, c: 0x6b5f85 },
      { t: 0.31, c: 0x8f6f85 },
      { t: 0.365, c: 0xb07f78 },
      { t: 0.40, c: 0xc68f6e },
      { t: 0.44, c: 0xd09a6b },
      { t: 0.62, c: 0xc8946a },
      { t: 1, c: 0xab7a5c },
    ],
    // Haze and light come down with the sky. They are sampled by the hills,
    // the far wood and the water's glitter path, so leaving either at its old
    // value would reintroduce the bright mass one layer further forward.
    haze: 0xc9976a,
    light: 0xf5b976,
    far: 0x3d5470,
    mid: 0x24332c,
    near: 0x46603f,
    shade: 0x16241d,
    accent: 0xffc93c,
    // Deliberately NOT pink. The athletes' hue is reserved and the palette must
    // not hand it back to props or the HUD through the accent slot.
    accent2: 0x2fe6d6,
  },
  // Sundown over a vert contest. Written as a THREE-MASS VALUE PLAN, not as a
  // set of local colours.
  //
  // The previous version put a violet sky (v 0.40), green hills (v 0.40) and a
  // tan ramp (v 0.40) in the same frame. A neutral review measured it and said
  // so: "A lives inside a ~30% value band ... the ragdoll's cyan limbs sit
  // against the ramp's warm tan at nearly the same luminance, so it reads as
  // scenery." Three masses inside thirty points of value is one mass, and the
  // rider had nothing to stand on.
  //
  //   light mass — sky, lum 0.51 at the top of frame rising to 0.95 at the
  //                horizon. The brightest thing in the frame that is not the
  //                rider, and it sits BEHIND everything.
  //   mid mass   — the hills and the far ridge, lum 0.24-0.38. Crushed toward
  //                silhouette; they exist to separate sky from structure.
  //   dark mass  — the ramp, the decks, the ground and the near plane, lum
  //                0.05-0.30. A near-silhouette the rider is punched out of.
  //
  // Hue family: one warm rose-to-amber wedge across the entire field. The ONE
  // complement in the frame is `accent2`, and it is reserved for the rider and
  // the board — no coping, no HUD, no prop may use it.
  halfpipe: {
    // Chroma discipline, and it is load-bearing rather than taste. The rider is
    // found in review by being the most saturated cluster in the frame.
    //
    // The number that matters is the one the detector actually uses, which is
    // COLOURFULNESS — (max-min) weighted by brightness — not HSV saturation.
    // Stated in HSV these stops were inside their budget; measured the way they
    // are read, the 0.28 and 0.4 stops came out at 0.358 and 0.363 and the haze
    // band over the sun at 0.39, against a rider at 0.59-0.66. That put ~320
    // sky pixels into the top 0.6% of the frame, which stretched the "subject"
    // box to 58% of frame height and invalidated the reading outright. These
    // are the same colours held under 0.32 colourfulness, which is the gap the
    // reservation was always claiming to have.
    sky: [
      { t: 0, c: 0xc2758f },
      { t: 0.14, c: 0xda8a8a },
      { t: 0.28, c: 0xeeb29b },
      { t: 0.4, c: 0xf9cbab },
      { t: 0.52, c: 0xffe0b8 },
      { t: 1, c: 0xfff4dc },
    ],
    haze: 0xffdac6,
    light: 0xfff0c2,
    far: 0x8c5a7a,
    mid: 0x55374f,
    // Dust and spray: warm cream, so particles read as sparks against a ramp
    // that is now almost black.
    near: 0xf0cfa6,
    shade: 0x1b1224,
    // Warm coral for cloud undersides and bunting. Deliberately NOT the rider's
    // hue: the complement slot below is the only cool thing in the event.
    accent: 0xe2938a,
    accent2: 0x35f0dc,
  },
  // Golden hour on the boardwalk. Warmest palette in the game.
  skating: {
    sky: [
      { t: 0, c: 0x3f5aa8 },
      { t: 0.34, c: 0x9a6fb0 },
      { t: 0.62, c: 0xef8f76 },
      { t: 0.85, c: 0xffb861 },
      { t: 1, c: 0xffe0a3 },
    ],
    haze: 0xf0bd96,
    light: 0xffd07a,
    far: 0x7d7bb0,
    mid: 0x2f6f96,
    near: 0xe8c48c,
    shade: 0x6b4a56,
    accent: 0xff4f81,
    accent2: 0x2fe6d6,
  },
}

/** Fallback so a scene never crashes on a missing key. */
export const defaultPalette: EventPalette = Palettes.halfpipe
