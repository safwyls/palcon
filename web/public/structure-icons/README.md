# Structure icons

Build-menu icons for the buildings that can hold items, shown on the Storage
view so a result says which box to walk to by sight rather than by name alone.

**These are Palworld game assets — copyright Pocketpair, Inc.**, not part of
this project. They're vendored here so a self-hosted deployment works without
extra setup, and the Storage view credits Pocketpair on screen. A fork that
redistributes Palcon should make that call deliberately rather than inherit it.
The same considerations as `../item-icons/README.md` apply.

## Source

Vendored from [palworld-save-pal](https://github.com/oMaN-Rod/palworld-save-pal)
(MIT), path `ui/src/lib/assets/img/t_icon_buildobject_*.webp`. The accompanying
catalog, `web/src/data/structures.json`, is built from the same repo:

| Upstream file | Contributes |
| --- | --- |
| `data/json/buildings.json` | build-menu category (`type_b`) and icon name |
| `data/json/l10n/en/buildings.json` | English name |

Both are static id → data lookups; no code was copied from either project.

## Naming and trimming

A file is named for the catalog's `icon` value with the `t_icon_buildobject_`
prefix stripped — `t_icon_buildobject_itemchest_03.webp` becomes
`itemchest_03.webp`, which is what `structures.json` stores in its `i` field.

Upstream ships 505 building icons (3.7 MB). Only the **159** that can plausibly
own an item container are vendored here (1.6 MB): everything outside the
foundation and general-decoration categories, plus the storage furniture filed
under decoration (the Refrigerator, Wooden Barrel and Wooden Barrel Shelf). A
foundation or a wall never appears on the Storage view, so shipping its icon
would be weight nothing can render — the same reasoning that keeps the item
icons to the items that can appear in a bag.

`structures.json` records `i` **only** for buildings whose icon is actually
vendored, so the view never requests a file that isn't here. Anything else
draws the row without an icon, which is a normal outcome and not a failure —
world treasure chests have no build-menu icon at all.

## Refreshing

Re-run the same selection after a game update that adds buildings; see
`docs/vendored-game-data.md` for the wider refresh chore. A newly-added chest
with no vendored icon degrades to a nameless-but-labelled row rather than a
broken image.
