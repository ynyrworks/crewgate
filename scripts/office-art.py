#!/usr/bin/env python3
"""Turns the generated source images of the HD office into the art it ships (dev only; needs numpy and Pillow).

    python scripts/office-art.py <source folder>

The source folder holds floor.png, wall.png, props.png, props2.png and char1.png .. char6.png: images from an image
model on a solid magenta background (see plugins/crewgate-office/ART.md). They are not real pixel art yet, so each is
reduced to a fixed size and a limited palette with hard alpha, and written to plugins/crewgate-office/public as
art-<name>.png, with art-sizes.json. The asset list in office.json is updated to match.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ADDON = Path(__file__).resolve().parent.parent / "plugins" / "crewgate-office"
OUT = ADDON / "public"

# name, width in art pixels; in sheet order, left to right, top to bottom
PROPS = [
    ("desk", 78), ("bookshelf", 56), ("plant", 54), ("flowers", 26),
    ("window", 56), ("lantern", 22), ("painting", 50), ("rug", 136),
    ("chair", 30), ("cabinet", 36), ("coatrack", 30), ("books", 24),
]
PROPS2 = [
    ("sideboard", 60), ("floorlantern", 18), ("crates", 40), ("sofa", 64),
    ("door", 38), ("map", 44), ("hangplant", 26), ("teatable", 30),
    ("wallshelf", 46), ("globe", 24), ("armchair", 36), ("railing", 60),
]
PROPS3 = [   # the room itself: these replace what the sheets above call the same
    ("desk", 80), ("desk2", 80), ("bookshelf", 56), ("lowcabinet", 62),
    ("tallplant", 40), ("planter", 36), ("chest", 28), ("tablelantern", 16),
    ("rug", 136), ("rugsmall", 60), ("notes", 62), ("painting", 52),
]
# on the sheets above, but not placed in the room: not shipped
UNUSED = {"books", "sideboard", "hangplant", "teatable", "armchair", "map", "plant-unused"}
DENSITY = 2        # image pixels per unit of art-sizes.json: the room lays things out in units, so this only adds detail
CHAR_HEIGHT = 62 * DENSITY
SIT_HEIGHT = 40 * DENSITY    # head to waist, at the same scale as the standing frames
FRAMES = 6
SIT_FRAMES = 4
sizes = {}


def quantize(rgb, colours):
    return rgb.quantize(colours, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")


def key_of(sheet):
    return (sheet[..., 0] > 170) & (sheet[..., 1] < 110) & (sheet[..., 2] > 170)


def spans(mask, least):
    out, start = [], None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if i - start >= least:
                out.append((start, i))
            start = None
    return out


def merged(runs, gap):
    """Joins runs closer than gap: the fringe of a rug and the rug are one object."""
    out = []
    for r in runs:
        if out and r[0] - out[-1][1] < gap:
            out[-1] = (out[-1][0], r[1])
        else:
            out.append(r)
    return out


def reduce_cut(crop, key, w, h, colours):
    """Reduces a keyed cut to w x h. Averaging a cell washes thin lines away, and eyes and outlines are thin lines,
    so a cell holding a much darker line takes that line's colour. The key colour never bleeds into the edge."""
    fringe = key | ((crop[..., 0] > crop[..., 1] + 60) & (crop[..., 2] > crop[..., 1] + 60))
    lum = crop @ np.array([0.3, 0.6, 0.1])
    ys, xs = [np.linspace(0, n, m + 1).astype(int) for n, m in ((crop.shape[0], h), (crop.shape[1], w))]
    rgb = np.zeros((h, w, 3), "uint8")
    alpha = np.zeros((h, w), dtype=bool)
    for y in range(h):
        for x in range(w):
            cell = (slice(ys[y], max(ys[y + 1], ys[y] + 1)), slice(xs[x], max(xs[x + 1], xs[x] + 1)))
            alpha[y, x] = (~key[cell]).mean() > 0.5
            use = ~fringe[cell]
            if not use.any():
                use = ~key[cell]
            if not use.any():
                continue
            c, l = crop[cell][use], lum[cell][use]
            part = 0.3 if l.min() < l.mean() * 0.6 else 0.55
            rgb[y, x] = np.median(c[l <= np.quantile(l, part)], axis=0)
    return np.asarray(quantize(Image.fromarray(rgb), colours)), alpha


def save(name, rgb, alpha):
    if name in UNUSED:
        return
    Image.fromarray(np.dstack([rgb, alpha.astype("uint8") * 255])).save(OUT / f"art-{name}.png", optimize=True)
    sizes[name] = [rgb.shape[1] / DENSITY, rgb.shape[0] / DENSITY]


def tile(src, filename, name, size, colours):
    im = Image.open(src / filename).convert("RGB").resize((size, size), Image.Resampling.BOX)
    a = np.asarray(im, dtype=float)
    # the model's tiles do not quite wrap: cross-fade a few pixels across each edge
    n = 4
    for i in range(n):
        k = (i + 1) / (n + 1)
        a[:, -n + i], a[:, n - 1 - i] = a[:, -n + i] * (1 - k * 0.5) + a[:, n - 1 - i] * k * 0.5, a[:, n - 1 - i] * (1 - k * 0.5) + a[:, -n + i] * k * 0.5
        a[-n + i, :], a[n - 1 - i, :] = a[-n + i, :] * (1 - k * 0.5) + a[n - 1 - i, :] * k * 0.5, a[n - 1 - i, :] * (1 - k * 0.5) + a[-n + i, :] * k * 0.5
    rgb = np.asarray(quantize(Image.fromarray(a.astype("uint8")), colours))
    save(name, rgb, np.ones(rgb.shape[:2], dtype=bool))


def prop_sheet(src, filename, table):
    sheet = np.asarray(Image.open(src / filename).convert("RGB"), dtype=int)
    key = key_of(sheet)
    i = 0
    grid_rows = 3
    band = sheet.shape[0] / grid_rows
    for row in range(grid_rows):
        # Objects of neighbouring rows can almost touch, so rows are not cut by their gaps: a band finds the columns,
        # then each object takes its own vertical run, the one centred in the band, and its own width there.
        y0, y1 = round(row * band), round((row + 1) * band)
        centre = (y0 + y1) / 2
        for cx0, cx1 in merged(spans((~key[y0:y1]).sum(axis=0) > 1, 2), 16):
            if i >= len(table):
                raise SystemExit(f"{filename}: more objects than the table lists")
            name, width = table[i]
            i += 1
            runs = spans((~key[:, cx0:cx1]).sum(axis=1) > 1, 9)
            top, bottom = min(runs, key=lambda r: abs((r[0] + r[1]) / 2 - centre))
            cols = np.where((~key[top:bottom, cx0:cx1]).sum(axis=0) > 0)[0]
            x0, x1 = cx0 + cols[0], cx0 + cols[-1] + 1
            width *= DENSITY
            height = max(1, round(width * (bottom - top) / (x1 - x0)))
            rgb, alpha = reduce_cut(sheet[top:bottom, x0:x1], key[top:bottom, x0:x1], width, height, 48)
            if name == "window":   # what glows: sky and clouds, not the frame. The room is lit by a low sun, not a blue noon
                r, g, b = [rgb[..., c].astype(int) for c in range(3)]
                glass = ((b > 150) & (b >= r - 5) & (g > 130)) | ((r > 190) & (g > 190) & (b > 180))
                light = (rgb[glass].astype(float) @ np.array([0.3, 0.6, 0.1]))[..., None] / 255
                rgb = rgb.copy()
                rgb[glass] = np.clip(light * np.array([300, 245, 170]), 0, 255).astype("uint8")
                glow = np.zeros_like(rgb)
                glow[glass] = rgb[glass]
                save("window-glow", glow, np.ones(rgb.shape[:2], dtype=bool))
            save(name, rgb, alpha)
    if i != len(table):
        raise SystemExit(f"{filename}: found {i} objects, the table lists {len(table)}")


def character(src, n):
    sheet = np.asarray(Image.open(src / f"char{n}.png").convert("RGB"), dtype=int)
    key = key_of(sheet)
    runs = spans((~key).sum(axis=0) > 1, 30)
    if len(runs) != FRAMES:
        raise SystemExit(f"char{n}.png: found {len(runs)} frames, expected {FRAMES}: {runs}")
    rows = np.where((~key).sum(axis=1) > 1)[0]
    top, bottom = rows[0], rows[-1] + 1
    scale = CHAR_HEIGHT / (bottom - top)
    width = round(max(x1 - x0 for x0, x1 in runs) * scale) + 2
    for f, (x0, x1) in enumerate(runs):
        w = max(1, round((x1 - x0) * scale))
        rgb, alpha = reduce_cut(sheet[top:bottom, x0:x1], key[top:bottom, x0:x1], w, CHAR_HEIGHT, 48)
        canvas_rgb = np.zeros((CHAR_HEIGHT, width, 3), dtype="uint8")
        canvas_a = np.zeros((CHAR_HEIGHT, width), dtype=bool)
        at = (width - w) // 2
        canvas_rgb[:, at:at + w] = rgb
        canvas_a[:, at:at + w] = alpha
        save(f"c{n}-{f}", canvas_rgb, canvas_a)


def seated(src, n):
    """Frames FRAMES.. of a character: head to waist. The raised hand makes frame 4 taller, so all share its height."""
    sheet = np.asarray(Image.open(src / f"seat{n}.png").convert("RGB"), dtype=int)
    key = key_of(sheet)
    runs = spans((~key).sum(axis=0) > 1, 30)
    if len(runs) != SIT_FRAMES:
        raise SystemExit(f"seat{n}.png: found {len(runs)} frames, expected {SIT_FRAMES}: {runs}")
    rows = np.where((~key).sum(axis=1) > 1)[0]
    top, bottom = rows[0], rows[-1] + 1
    first = np.where((~key[:, runs[0][0]:runs[0][1]]).sum(axis=1) > 1)[0]
    scale = SIT_HEIGHT / (first[-1] + 1 - first[0])
    height = round((bottom - top) * scale)
    width = round(max(x1 - x0 for x0, x1 in runs) * scale) + 2
    for f, (x0, x1) in enumerate(runs):
        w = max(1, round((x1 - x0) * scale))
        rgb, alpha = reduce_cut(sheet[top:bottom, x0:x1], key[top:bottom, x0:x1], w, height, 48)
        canvas_rgb = np.zeros((height, width, 3), dtype="uint8")
        canvas_a = np.zeros((height, width), dtype=bool)
        canvas_rgb[:, :w] = rgb
        canvas_a[:, :w] = alpha
        # drawn facing right; the desks' working side and monitors are to the character's lower left
        save(f"c{n}-{FRAMES + f}", canvas_rgb[:, ::-1], canvas_a[:, ::-1])


def main():
    src = Path(sys.argv[1])
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("art-*"):
        old.unlink()
    tile(src, "floor2.png", "floor", 128 * DENSITY, 32)
    tile(src, "wall2.png", "wall", 128 * DENSITY, 32)
    tile(src, "beam.png", "beam", 64 * DENSITY, 16)
    prop_sheet(src, "props.png", PROPS)
    prop_sheet(src, "props2.png", PROPS2)
    prop_sheet(src, "props3.png", PROPS3)
    for n in range(1, 7):
        character(src, n)
        seated(src, n)
    (OUT / "art-sizes.json").write_text(json.dumps(sizes, indent=0, sort_keys=True) + "\n")
    manifest_path = ADDON / "office.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["assets"] = ["three.module.min.js", "art-sizes.json"] + [f"art-{name}.png" for name in sorted(sizes)]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(p.stat().st_size for p in OUT.glob("art-*"))
    print(f"{len(sizes)} images, {total // 1024} KB")


if __name__ == "__main__":
    main()
