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
