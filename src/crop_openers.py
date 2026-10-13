"""Crop teamfight.lol board screenshots (1024x386) to the occupied hexes.
Occupied hexes = colourful pixels (portraits, cost borders, items); empty hexes are grey."""
import sys, numpy as np
from PIL import Image, ImageDraw

BOARD = (195, 0, 830, 386)    # hex board x0,y0,x1,y1 — excludes the trait list (left) and augment panel (right)
LOGO = (198, 128, 238, 172)   # teamfight.lol honeycomb logo beside the board
PAD = 12

def crop_opener(img):
    img = img.convert("RGB")
    # Paint the logo out with the board background so it can't end up in a crop
    lx0, ly0, lx1, ly1 = LOGO
    around = np.asarray(img)[ly0 - 25:ly0 - 5, lx0:lx1].reshape(-1, 3)
    ImageDraw.Draw(img).rectangle(LOGO, fill=tuple(int(v) for v in np.median(around, 0)))
    a = np.asarray(img).astype(np.float32) / 255
    x0, y0, x1, y1 = BOARD
    sub = a[y0:y1, x0:x1]
    mx, mn = sub.max(2), sub.min(2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    mask = (sat > 0.30) & (mx > 0.30)
    rows = np.where(mask.sum(1) > 6)[0]; cols = np.where(mask.sum(0) > 6)[0]
    if not len(rows) or not len(cols):
        return img
    box = (max(x0 + cols[0] - PAD, 0), max(y0 + rows[0] - PAD, 0),
           min(x0 + cols[-1] + PAD, img.width), min(y0 + rows[-1] + PAD, img.height))
    return img.crop(box)

if __name__ == "__main__":
    out = crop_opener(Image.open(sys.argv[1]))
    out.save(sys.argv[2]); print(sys.argv[2], out.size)
