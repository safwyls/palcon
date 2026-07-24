# Pal icons

Sprite icons for every pal, shown on the Player details view.

**These are Palworld game assets — copyright Pocketpair, Inc.**, not part of
this project. They're vendored here so a self-hosted deployment works without
extra setup, and the Player details view credits Pocketpair on screen. A fork
that redistributes Palcon should make that call deliberately rather than
inherit it.

## Source

Vendored from [palworld-server-manager](https://github.com/amantu-qbit/palworld-server-manager)
(MIT), path `assets/pal-icons`. The accompanying lookup tables in
`web/src/data/` come from the same repo:

| File | Upstream source |
| --- | --- |
| `web/src/data/palDex.json` | `src/data/palDex.json` — display name, elements, rarity |
| `web/src/data/passiveSkills.json` | `bridge/data/passive_skills.json` — passive id → English name |

Those catalogs originate from [palworld-save-pal](https://github.com/oMaN-Rod/palworld-save-pal)'s
English localization data, which in turn derives from
[palworld-save-tools](https://github.com/cheahjs/palworld-save-tools). Both are
static id → display-name lookups; no code was copied from either project.

## Naming

A file is named for the pal's internal id, lowercased, with the `BOSS_` prefix
(which marks an alpha variant) stripped — so `BOSS_Anubis` and `Anubis` both
resolve to `anubis.webp`. `web/src/lib/paldex.ts` does that mapping and falls
back to the raw id whenever a lookup misses, so a pal added by a game update
still renders, just without art or a localized name.

## Refreshing

```sh
curl -sL https://github.com/amantu-qbit/palworld-server-manager/archive/refs/heads/main.tar.gz | \
  tar xz --wildcards '*/assets/pal-icons/*' --strip-components=3 -C web/public/pal-icons
```

The lookup tables are trimmed to the fields the UI renders (descriptions and
unused columns are dropped) to keep them out of the JS bundle's way; see the
commit that added them for the exact transform.
