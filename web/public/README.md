# Map background image

The player map (server detail page) looks for a background image at one of:

```
web/public/palworld-map.webp
web/public/palworld-map.png
web/public/palworld-map.jpg
```

This isn't included in the repo — it's the in-game world map texture, which is
a copyrighted Palworld game asset. `.gitignore` excludes `web/public/palworld-map.*`
so whatever you place here stays local and is never committed.

If no image is present, the map view falls back to a plain grid background —
still fully functional (player dots plot at the correct positions), just without
the game's map art underneath.
