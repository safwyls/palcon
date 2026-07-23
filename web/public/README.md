# Map background images

The live map looks for a world texture at one of these paths, trying each in
order and falling back to the next if it's missing:

```
web/public/palworld-map.webp      # main map
web/public/palworld-map.png
web/public/palworld-map.jpg

web/public/palworld-treemap.webp  # the secondary "Tree" area
web/public/palworld-treemap.png
web/public/palworld-treemap.jpg
```

These are in-game world map textures — **copyrighted assets belonging to
Pocketpair, Inc.**, not to this project. They're checked in here so a
self-hosted deployment works without extra setup, and the map view credits
Pocketpair on screen. If you fork or redistribute Palcon, that's a call to
make deliberately rather than by inheriting it: swap in your own art, or
drop the files and let the grid fallback stand.

If no image is present the map falls back to a plain grid, which is still
fully functional — player dots plot at exactly the right positions, just
without the game art underneath.

Both textures are square 8192x8192 images; the map code assumes that (player
positions are percentages of that square), so a non-square replacement will
misplace every marker.

# Favicons

`favicon-32.png`, `favicon-192.png` and `apple-touch-icon.png` are generated
from `palcon_tempicon.png` (a placeholder logo) — cropped to the artwork,
since the source has ~50% empty margin that would leave the fox unreadable
at tab size, then squared and resized:

```sh
python3 - <<'PY'
from PIL import Image, ImageChops
src = Image.open("palcon_tempicon.png").convert("RGBA")
bg = src.getpixel((2, 2))
diff = ImageChops.difference(src.convert("RGB"), Image.new("RGB", src.size, bg[:3])).convert("L")
art = src.crop(diff.point(lambda p: 255 if p > 18 else 0).getbbox())
side = max(art.size); pad = int(side * 0.06)
canvas = Image.new("RGBA", (side + pad * 2,) * 2, bg)
canvas.paste(art, ((canvas.width - art.width) // 2, (canvas.height - art.height) // 2), art)
for nm, sz in (("favicon-32.png", 32), ("favicon-192.png", 192), ("apple-touch-icon.png", 180)):
    canvas.resize((sz, sz), Image.LANCZOS).save(nm, optimize=True)
PY
```

Note that everything in this directory is copied into `web/dist` and embedded
in the Go binary, so `palcon_tempicon.png` ships (~890 KB) despite only being
a build-time source. Move it out of `public/` if that matters.
