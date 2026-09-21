#!/usr/bin/env python3
"""
Score a captured frame on the things every blind review has actually judged it on.

Single-frame comparison against a *curated* marketing still was never fair: the
reference is a chosen best frame and ours was whatever instant the shutter hit.
This scores several candidates so the strongest can be chosen the same way, on a
stated criterion rather than on taste.

Three measures, all of which came directly out of critic language:

  subject_break  The player's local value contrast against what is behind them.
                 "His legs dissolving into the grass, silhouette broken at the
                 knees." The player is found as the most chromatic cluster in
                 the frame, since every event now reserves one hue for them.

  value_spread   p95 minus p05 of luminance. "Every plane sits between roughly
                 45% and 65% luminance, so the athlete has no contrast to stand
                 on."

  dead_frac      Fraction of the frame inside a narrow band around the modal
                 luminance and carrying almost no local detail. "Roughly 30% of
                 the canvas spending no information."

Plus two compositional *guards*. These are deliberately not scoring terms.

Selecting best-of-N on the three measures above cost one event a win it already
held: the chosen frame scored well and put the rider exactly on the horizon line.
The lesson from rigging the critic prompt applies to the scorer too — adding a
term for every fault I can think of turns the proxy into a thing I optimise
against instead of a thing that catches mistakes. So faults the critics named in
their own words become pass/fail gates, and ranking among survivors is unchanged:

  on_horizon     "B's rider sits on the horizon line - the single worst place to
                 put a subject."

  subject_small  "She's ~8% of frame height." The reference puts its subject at
                 5-18% of frame height; below that it is set dressing.

And a validity flag, which is not a judgement of the frame but of the reading.
The detector takes the most colourful ~0.6% of the playfield and calls it the
player. That is only the player if the frame actually reserves a hue for them.
When it does not, the "subject" is a scattered dust of pixels spanning half the
canvas and its measured contrast against a local ring is noise — several bar
frames read 0.003 this way. A number produced under those conditions must not be
quoted as a result, so it is marked `subject_found: false`. Symptom of a real
thing either way: a subject box taller than a third of the frame means the accent
is not reserved, which is the mechanism every critique says the bar wins with.
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def analyse(path: str) -> dict:
    im = Image.open(path).convert("RGB").resize((480, 270), Image.LANCZOS)
    a = np.asarray(im, dtype=float) / 255.0
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    # Colourfulness, not HSV saturation.
    #
    # Three separate reviewers found this detector locking onto shadow rather
    # than onto the player. HSV saturation is (max-min)/max, which a dark
    # saturated navy maximises — deep water measured 0.88 against a hot pink
    # rider at 0.69, so "the most saturated cluster" was a flat mass of shade at
    # the bottom of the frame. Chroma (max-min) is small for dark colours, which
    # is the behaviour wanted: the player is the most *colourful* thing, not the
    # most nominally saturated.
    sat = (mx - mn) * (0.45 + 0.55 * mx)

    # Ignore the HUD bands: they are chromatic and would be mistaken for the
    # player. Everything above 9% and below 88% of frame height is playfield.
    h = lum.shape[0]
    field = np.zeros_like(lum, dtype=bool)
    field[int(h * 0.09):int(h * 0.88), :] = True

    # The player: the most saturated cluster in the playfield.
    s = np.where(field, sat, 0.0)
    thresh = np.percentile(s[field], 99.4)
    subject = s >= max(thresh, 0.35)
    if subject.sum() < 12:
        subject = s >= np.percentile(s[field], 99.0)

    ys, xs = np.nonzero(subject)
    if len(ys) == 0:
        return {"subject_break": 0.0, "value_spread": 0.0, "dead_frac": 1.0,
                "subject_frac": 0.0, "subject_h": 0.0, "subject_at": [0, 0],
                "on_horizon": False, "horizon_at": None,
                "subject_w": 0.0, "subject_found": False,
                "high_frac": 0.0, "lum_median": 0.0}

    cy, cx = int(ys.mean()), int(xs.mean())
    half = 34
    y0, y1 = max(0, cy - half), min(lum.shape[0], cy + half)
    x0, x1 = max(0, cx - half), min(lum.shape[1], cx + half)
    around = lum[y0:y1, x0:x1]
    ring = around.copy()
    # Blank the subject out of its own surroundings.
    sub_local = subject[y0:y1, x0:x1]
    ring[sub_local] = np.nan
    bg = np.nanmedian(ring) if np.isfinite(ring).any() else lum.mean()
    subject_break = float(abs(np.median(lum[subject]) - bg))

    # Playfield only. `value_spread` used to run over the whole image, and a
    # near-black HUD plate is darker than anything in most of these scenes: in
    # Surfing the bottom-left plate measured luma 0.098 across 3.45% of the
    # frame and set p05 single-handedly, so the number was reporting the
    # interface, not the picture. Worse for comparisons — the reference frames
    # are marketing stills with no HUD at all, so ours were being measured
    # against theirs on a quantity only ours contained. Every value_spread
    # quoted before this was inflated by its own UI.
    value_spread = float(np.percentile(lum[field], 95) - np.percentile(lum[field], 5))

    # Horizon: the row carrying the strongest sustained vertical luminance step.
    # Only counted as a horizon if that row stands clearly above the rest of the
    # frame, so events with no sky/ground split are not given a phantom one.
    dy = np.abs(np.gradient(lum, axis=0)).mean(axis=1)
    band = slice(int(h * 0.12), int(h * 0.80))
    rows = dy[band]
    hy = int(np.argmax(rows)) + band.start
    has_horizon = bool(rows.max() > np.median(rows) * 3.0)
    on_horizon = bool(has_horizon and abs(cy - hy) < h * 0.045)

    # Subject size as a fraction of frame height, measured on the bounding box
    # rather than on area: a rider is mostly empty space inside their own box.
    subj_h = float((ys.max() - ys.min() + 1) / h)
    subj_w = float((xs.max() - xs.min() + 1) / lum.shape[1])
    # A coherent read: the accent occupies a compact region and separates from
    # what is behind it. Scattered accent, or no separation, means no subject was
    # found and subject_break below is not measuring anything.
    subject_found = bool(subj_h < 0.45 and subj_w < 0.55 and subject_break > 0.04)

    # Where the playfield's mass sits in the value range. Reported only — never
    # scored, never a gate, and emphatically not "lower is better".
    #
    # It separated Foot Bag, which lost three reviews at high_frac 0.68 /
    # median 0.765, from the four events that win at 0.07-0.26. Tempting rule:
    # bright frames lose. **The reference frame measures 0.39 / 0.68 and beats
    # most of ours.** So brightness is not the fault. What lost was brightness
    # with no ladder under it — a pass had crushed the background's *contrast*
    # while leaving its *value* at the top of the range, which turns one quiet
    # plate into a white wall with a small dark mark on it. The athlete owned
    # neither extreme because there was no ladder for him to be the end of.
    #
    # Read these two next to `value_spread` and `subject_break`, never alone.
    high_frac = float((lum[field] > 0.70).mean())
    lum_median = float(np.median(lum[field]))

    # Local detail via a cheap gradient magnitude.
    gy, gx = np.gradient(lum)
    detail = np.hypot(gy, gx)
    hist, edges = np.histogram(lum[field], bins=24, range=(0, 1))
    modal = (edges[hist.argmax()] + edges[hist.argmax() + 1]) / 2
    flat = (np.abs(lum - modal) < 0.05) & (detail < 0.012) & field
    dead_frac = float(flat.sum() / field.sum())

    # Report the centroid in source-image coordinates so a wrong subject is
    # obvious. If this lands in a HUD corner or on a banner, the number below is
    # measuring the interface, not the player — which is itself the finding.
    full_w, full_h = Image.open(path).size
    return {
        "subject_break": round(subject_break, 4),
        "value_spread": round(value_spread, 4),
        "dead_frac": round(dead_frac, 4),
        "subject_frac": round(float(subject.sum() / field.sum()), 5),
        "subject_at": [int(cx / lum.shape[1] * full_w), int(cy / lum.shape[0] * full_h)],
        "subject_h": round(subj_h, 4),
        "high_frac": round(high_frac, 4),
        "lum_median": round(lum_median, 4),
        "subject_w": round(subj_w, 4),
        "subject_found": subject_found,
        "on_horizon": on_horizon,
        "horizon_at": int(hy / h * full_h) if has_horizon else None,
    }


def faults(m: dict) -> list:
    """Compositional faults, by critic language. Pass/fail, never scored."""
    bad = []
    if m.get("on_horizon"):
        bad.append("on-horizon")
    if m.get("subject_h", 1.0) < 0.05:
        bad.append("subject-small")
    return bad


def composite(m: dict) -> float:
    """One number to rank candidates by. Subject separation dominates.

    Treat this as a tie-breaker between candidates that are ALREADY legitimate,
    never as a definition of a good frame. It has now twice preferred a worse
    picture with a better number: once a rider parked on the horizon line, once
    an outright wipeout — inverted surfer, "BLEW THE LANDING" across the frame,
    score 0.0 — which measured 0.390 against 0.195 for the frame before it,
    because a subject silhouetted against sky separates beautifully.

    The work of excluding bad frames belongs upstream in the capture driver
    (which must refuse failure states and hold out for the event's signature
    moment) and in `faults()` below. Do not add terms here to compensate.
    """
    return round(m["subject_break"] * 2.2 + m["value_spread"] * 0.8 - m["dead_frac"] * 1.1, 4)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    out = []
    for p in args.paths:
        m = analyse(p)
        m["path"] = p
        m["score"] = composite(m)
        m["faults"] = faults(m)
        out.append(m)
    # Order: named faults last, then unreadable subjects, then by score.
    #
    # `subject_found: false` is NOT a fault — a frame that deliberately reserves
    # two accents (an athlete and the object in play) can span half the canvas
    # and still be the better picture. But a flagged frame's numbers cannot be
    # quoted, so between two otherwise comparable candidates, prefer the one
    # that can actually be measured.
    out.sort(key=lambda d: (len(d["faults"]), not d["subject_found"], -d["score"]))
    if args.json:
        print(json.dumps(out, indent=2))
    else:
        for m in out:
            at = m.get("subject_at", [0, 0])
            flag = ("  !" + ",".join(m["faults"])) if m["faults"] else ""
            if not m["subject_found"]:
                flag += "  ?no-subject"
            print(f"{m['score']:+.3f}  break {m['subject_break']:.3f}  spread {m['value_spread']:.3f}  "
                  f"dead {m['dead_frac']:.3f}  hi {m['high_frac']:.2f} med {m['lum_median']:.2f}  "
                  f"subj {m['subject_frac']*100:.2f}% h{m['subject_h']*100:.0f}% "
                  f"@{at[0]},{at[1]}{flag}  {m['path']}")
    print(out[0]["path"], file=sys.stderr)


if __name__ == "__main__":
    main()
