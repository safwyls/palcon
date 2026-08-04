# Vendored game data — provenance and refresh chore

The frontend ships snapshots of Palworld game data. They drift with every
game patch, so this is a **recurring chore**, not a one-off: re-check after
each significant Palworld update (the ones that add pals or rebalance
stats), or when players report a missing pal/skill or an off stat estimate.

The code degrades gracefully for unknown ids — humanized names, "no stats
vendored", hidden icons — so drift is cosmetic, never a crash. That's by
design; keep it that way when regenerating.

## What's vendored, and from where

All files live in `web/src/data/`:

| File | Contents | Source |
|------|----------|--------|
| `palDex.json` | id → name, elements, rarity | palworld-server-manager (MIT), which sources palworld-save-pal's English localization |
| `palStats.json` | id → hp, stomach | same |
| `passiveSkills.json`, `activeSkills.json` | code → name/description | merged from deafdudecomputers/PalworldSaveTools (MIT) |
| `passiveTiers.json` | passive code → tier | same |
| `palCombat.json` | id → [hp, shotAttack, defense, 3 friendship rates] | palworld-save-pal data, calibrated (see `web/src/lib/stats.ts` header) |
| `palPassives.json` | passive code → [atk%, def%, hp%] | same |
| `breeding.json` | breeding combination table | palworld-save-pal |
| `palDeck.json` | id → Paldeck label ("94", "94B") | palworld-save-pal `pals.json` (`pal_deck_index`); see `web/public/pal-icons/README.md` for the transform |
| `mapPois.json` | map POI world coordinates by kind; fast travel + watchtower entries carry their English names (`[x, y, name]`) used as "near X" landmarks for bases | palworld-save-pal `fast_travel_points.json` (split on the `UnlockMapPoint` class) joined with `l10n/en/fast_travel_points.json` by GUID, and `map_objects.json` (dungeons, alpha/predator spawns), rounded to whole units |
| `items.json` | item id → name, category, rarity, weight, icon, description, and the gear figures the inventory view shows (max durability, magazine size, attack, defense, built-in passives) | palworld-save-pal `items.json` joined with `l10n/en/items.json`; see `web/public/item-icons/README.md` |
| `structures.json` | building id → build-menu name (`n`), category (`c`, upstream's `type_b`) and icon name (`i`), for the Storage view's container labels, its storage/farm/station grouping and its row icons | palworld-save-pal `buildings.json` joined with `l10n/en/buildings.json` by key; 489 entries trimmed to those three fields |
| `fieldBosses.json` | `spawns`: field boss flag key (`81_1_grass_FBOSS_20`) → the pal there, so the Achievements view can name them. `points`: where to draw each one on the live map, with its level | palworld-save-pal `data/json/bosses.json`, cross-checked against [PalworldSaveTools](https://github.com/deafdudecomputers/PalworldSaveTools) (MIT) `resources/game_data/boss_mapping.json` — see the note below on the nine keys deliberately dropped |
| `bossFights.json` | boss record key → the fight's in-game title, where it happens, and `[level, HP]` per difficulty, for the Achievements view's fight dialog | [paldb.cc/en/Tower](https://paldb.cc/en/Tower) and [paldb.cc/en/Raid](https://paldb.cc/en/Raid), both datamined — see the note below on why not the guide sites |

Pal icons: `web/public/pal-icons/` — see the README there. Item icons:
`web/public/item-icons/`, and structure icons `web/public/structure-icons/`,
same arrangement and their own READMEs. Map textures
(`web/public/palworld-map.webp`, `palworld-treemap.webp`) are vendored the
same way: © Pocketpair, Inc., credited on-screen in the map view — see
`web/public/README.md` for the fork/redistribution considerations.

Not in `web/src/data/`, but vendored the same way: **`STATUS_NAMES` in
`internal/games/palworld/palsave/extract_pals.py`** maps the Japanese stat names every save
uses — whatever language the server runs in — to English. Taken from
palworld-save-pal's `STATUS_NAME_MAP` (`psp-core/src/domain/player.rs`), which
is the full 18-entry set; the relic-granted "adventure" stats arrived with
Palworld 1.0, so a patch that adds another will show up in the UI as an
untranslated Japanese label until this table is refreshed. Collecting the list
from a sample save is how one got missed before — a stat nobody had spent a
point on simply wasn't there to notice.

The frontend's display order for those stats lives in `ADVENTURE_STATS`
(`web/src/pages/ServerInventory.tsx`) and mirrors the same source, so every
player's build panel reads in one order.

Also not in `web/src/data/`: the roster tables in **`web/src/lib/achievements.ts`**.
No names are vendored there — `palDex.json` already carries them all, under
keys the record data doesn't use. What's hand-maintained is only the *join*:

| Table | Maps | Refresh trigger |
|---|---|---|
| `PALPAGOS_TOWERS` | the eight `BOSS_BATTLE_NAME_<region>Boss` towers → a `gym_*` catalog id | A game update adds a faction tower |
| `PANTHALUS` | the one fight between the towers and the World Tree | — |
| `WORLD_TREE_RUN` | the three `WorldTreeMiddleBoss<n>` dungeon bosses, beatable in any order | A game update adds another gated set |
| `ASTRALYM` | the last fight, gated on all three above | — |
| `RAID_ROSTER` | `PalSummon_<pal>` → a `raid_*` catalog id | A game update adds a summonable raid boss |

`TowerBossDefeatFlag` is one map holding a whole progression, which is why
there are four tables rather than one — the tiers are what the hero draws:

```
Palpagos Islands towers  →  Panthalus  →  World Tree run (any order)  →  Astralym
```

The save backs the split rather than just the labels: every tower carries a
`Tower_<region>` area flag, where Panthalus gets its own `BOSS_KingWhale` one.
`BOSS_CHAIN` flattens all four back into progression order for counting and for
picking the next fight the group can close out.

The Forbidden Laboratory has no catalog portrait — it's a place, and a gauntlet
of eight modified pals rather than one boss. It borrows Grizzbolt's outline,
flattened to black under a red rim, the way the game presents those fights.
That isn't a stand-in: the first wave *is* a Highly Modified Grizzbolt, which
paldb catalogues under exactly that name. If you ever swap it, check the
silhouette at 44px first — a rounder pal flattens to a featureless blob, and
the horns are what make it read as a creature at all.

`BOUNTY_ROSTER` needs no maintenance — the human bounty targets are derived
from every `boss_*` key in the catalog at module load, so refreshing
`palDex.json` refreshes the roster and its denominator together. One rule is
applied on top: keys containing `_quest_` are excluded, which currently means
only Elder (`boss_hunter_fat_gatlinggun_quest_strongoldman`), a quest-spawned
target that isn't obtainable in the game as it stands. That leaves 33. It is
the *rule* that's encoded rather than the name, so a future quest-spawned
target is handled without an edit — and it agrees with the map data, where
Elder is the only target with no position.

Being unrecorded in a save is deliberately **not** the test: four other targets
were unrecorded on the world this was checked against and are perfectly
obtainable, which is exactly what "still out there" is for.

Both tables render keys they don't recognise rather than dropping them: an
unknown tower is listed under the run, an unknown raid boss gets its own row.
That's the signal to add a line here.

Every key in all four tables is read off a real save record. The three
`WorldTreeMiddleBoss<n>` labels are the one thing no catalog carries — there is
no `worldtreemiddleboss` entry anywhere — so they were derived from the saves
using two order-preserving facts: a flag map records keys in the order they
were first set, and each of those bosses drops a distinctly named item into the
next free inventory slot. Four players with three different clear orders all
imply the same assignment (1 = Dandilord, 2 = Silvance, 3 = the Laboratory),
which is six-ways-to-be-wrong agreeing four times. See `WORLD_TREE_RUN` in
`web/src/lib/achievements.ts` for the working. Still inference rather than a
lookup: if a future save disagrees, redo it there.

The Forbidden Laboratory's roster, by contrast, *is* confirmed from game data —
PalworldSaveTools' `characters.json` carries eight `BOSS_<pal>_BossRush`
entries (Grizzbolt, Lyleen, Orserk, Faleris, Shadowbeak, Selyne, Shaolong,
Bastigor), matching what the fight dialog lists. Only their pairing into four
waves comes from a guide.

### fieldBosses.json — the join the save doesn't have

The save names a field boss *spawn point*, never its occupant, and neither the
item catalog nor the map POI data connects the two. PalworldSaveTools carries
the join, and uses it for the same reason we do: its bounty token counts come
from `NormalBossDefeatFlag` through this table, because the tokens themselves
get spent and so can't be counted from anyone's inventory.

Generated from palworld-save-pal `data/json/bosses.json` — 159 entries of
`{spawner_id, character_id, level, x, y, z}`, of which 90 name a pal (the other
69 are human bosses, `character_id: "None"`). PalworldSaveTools
`resources/game_data/boss_mapping.json` (keyed `BossDefeatReward_<Pal>` → one
spawn key or a list) is kept as the **cross-check**, not as input: the
generator asserts the two agree on every shared key. They currently agree on
all 90, zero disagreements, which is the strongest check available on either.

That file also lists **nine spawn keys the location data doesn't have**, and
those are deliberately dropped rather than carried as positionless entries:

```
50_12_dungeon_snow_boss  50_5_dungeon_forest  81_1_grass_FBOSS_19
81_1_grass_FBOSS_5  81_1_grass_FBOSS_8  81_5_Yamijima_FBOSS_17
skyisland_8_01_A_meadow  worldtree_9_55_WorldTreeAura  yellow_D
```

No save read has ever set one of them — zero occurrences across 84 distinct
field boss keys in a four-player world — and the location data has none of
them either. Two sources missing them and no save containing them says they're
spawn points a game update removed or renamed, not content anyone can reach.
Keeping them made the Achievements roster promise nine field bosses (Broncherry
Aqua, Pyrin, Pierdon Cryst, Quivern, Relaxaurus Lux, Felbat, Katress, Ribbuny
Botan, Petallia) that could not be found on the map. If one ever does appear in
a save it is counted and reported through `unknownFieldBossCount`, which is the
signal to put it back.

Pal names and elements are baked into the JSON so `web/src/lib/fieldBosses.ts`
needs no catalog: the live map draws these, and reaching into `achievements.ts`
for them pulled `palDex.json` into the main bundle and cost 230 KB on first
paint.

The lists are separate because they don't line up one-to-one. `spawns` has
89 keys for 89 pals; `points` has 90, because
`remainsIsland_1_GrassGolem_FBOSS` covers **two** Dualith spawns at different
places and levels, so keying pins by flag key drops one.

`bounties` is the third list: the human bounty targets, from the same source's
`character_id: "None"` entries. 66 pins for 33 targets — most spawn in more
than one camp, and the save records one flag per *target*, so beating it
anywhere clears them all. Names come from `palDex.json`'s `boss_*` keys, which
is also how the Achievements roster names them.

Two deliberate omissions there. **Elder** has no pin: its id
(`boss_hunter_fat_gatlinggun_quest_strongoldman`) marks it quest-spawned, so
there is no fixed world position to record — the one bounty target of 34 that
can't be placed, and not a data gap. And the three `REGION_Oilrig_*` entries
the source files alongside these are dropped: no catalog name, no bounty flag,
and the save counts them separately in `OilrigClearCount`.

Three things checked when it was first vendored, worth repeating on refresh:

- **Coverage.** Every non-human key in a real four-player save resolved — 55,
  64, 46 and 33 respectively — with the leftovers being exactly the `BOSS_*`
  human bounty targets, which are a separate roster. A key the table doesn't
  know is counted but not named, and the view says how many those are. This is
  also the check that says whether a dropped key has come back.
- **Agreement.** A handful of spawn keys name their own species, which is a
  free correctness test: Arsox, Dinossom Lux, Lyleen, Lyleen Noct and Celesdir
  all match. The one disagreement is `1_10_plain_F_Boss_FairyDragon`, which the
  table calls Chillet — a plains spawn whose contents changed without the level
  object being renamed is the likely story, and the table comes from game data
  where the key text is only a label, so the table wins.
- **Icons.** All 89 pal ids resolve to a file in `web/public/pal-icons/`.

Upstream has one collision: `worldtree_9_55_WorldTreeAura` is claimed by both
`HerculesBeetle` and `LazyDragon_Electric`, so one of them loses. It appears in
no save read so far. If it ever renders wrong, that is why.

### Why bossFights.json comes from paldb and nowhere else

The guide sites disagree with each other about tower boss levels, and some of
them are simply wrong: one popular list has Lyleen at 25, Orserk at 40 and
Faleris at 45, where the datamined values are 20, 30 and 40. Another prints an
element column that contradicts our own `palDex.json` — Orserk as Ice, Saya &
Selyne as Electric, Auri & Shaolong as Dark — and its own comment section
disputes the last one. [paldb.cc](https://paldb.cc/en/Tower) is datamined
rather than written up, and it agreed exactly with the one guide that published
HP figures, so it is the only source used here. Prefer it on the next refresh.

`bossFights.json` deliberately carries **no elements and no weaknesses**:

- Elements are already in `palDex.json` for every boss form, and they match
  paldb — including the awkward ones, like Saya & Selyne's Dark/Normal and
  Astralym having none at all.
- Weaknesses are computed by `elementCounters` in `web/src/lib/paldex.ts` from
  the element chart. A chart is a rule; copying it into thirteen rows is
  thirteen chances to get it wrong, and it would have to be re-checked every
  time a boss is added.

`EFFIGY_KINDS` in `web/src/lib/achievements.ts` is the other hand-maintained
join. The save counts effigies by the bonus they feed
(`EPalRelicType::JumpPower`) while players know them by the pal on the statue
("Rooby Effigy"), and nothing vendored connects the two. The thirteen pairings
come from [paldb.cc/en/Pal_Effigy](https://paldb.cc/en/Pal_Effigy); the sets
line up exactly — thirteen effigy items, thirteen enum values, no leftovers on
either side — which is the check that the mapping is right. Refresh it if a
game update adds an effigy.

Two things the effigy code deliberately does not do. It doesn't read
`RelicObtainForInstanceFlag`, which predates effigies having kinds and holds
only the Lifmunk ones — on a played save that is a quarter to a half of the
real figure, and it matched the CapturePower bucket exactly on every player
checked; the per-kind map is summed instead, with the legacy flag kept only as
the fallback for saves too old to have one. And it doesn't import `items.json`
for the icons: the icon name is the item id lowercased (`Relic_04` →
`relic_04`), and importing the catalog would pull 532 KB into a route that
needs thirteen strings.

The element glyphs in `web/src/components/ElementIcon.tsx` are **not** vendored
either. Eight are lucide icons — the icon language the rest of palcon already
speaks — and Dragon is drawn to match, because lucide has no dragon. Nothing of
Pocketpair's is redistributed for them, and they take the element's colour, so
a glyph tints and scales where a lifted PNG would not.

The Laboratory is the one entry whose element the dialog refuses to state. It
borrows Grizzbolt's portrait because the first wave really is a Highly Modified
Grizzbolt, but the fight is eight different pals — so it prints its waves
instead of a matchup that would be wrong about seven of them.

Two joins are deliberately *not* attempted. The bare field-alpha spawner ids
(`81_1_grass_FBOSS_20` — about two thirds of them) name no species anywhere in
the save, so they're counted rather than named; only the ones that carry a
species in the id (`..._FBOSS_FlameBuffalo`) resolve. And
`FastTravelPointUnlockFlag` is a count, never a percentage: it runs higher than
the 141 fast-travel points in `mapPois.json`, so it evidently covers other map
points too, and a denominator would be invented.

### Why structures.json is worth the refresh

The Storage view names the chest an item is sitting in, and a wrong name sends
someone to the wrong chest. These were hand-written from memory first, and the
guesses were wrong in ways the UI could never reveal: `ItemChest_02` is the
**Metal Chest**, not the "Iron Chest"; `BlastFurnace3` is the **Electric
Furnace**, not an "improved" one; `WorkBench_SkillUnlock` is the **Pal Gear
Workbench** and has nothing to do with skill fruit. Prefer the catalog over
judgement here, and let unknown ids fall back to the humanized id.

Upstream covers buildings only. The world's own objects — treasure chests,
ground drops, wild eggs — are named by `WORLD_OBJECTS` in
`web/src/lib/structures.ts`, which is the easy half: nobody finds a treasure
chest by name. Coverage against a real save is 45 catalog + 12 hand-written,
with no humanized fallbacks.

Icons come from the same upstream (`ui/src/lib/assets/img/t_icon_buildobject_*.webp`).
Upstream has 505; only the 159 that can own an item container are vendored, since
a foundation's icon is weight the Storage view can never draw — see
`web/public/structure-icons/README.md` for the selection rule. `i` is recorded in
the catalog only when the file is actually vendored, so a missing icon is a row
without a picture rather than a failed request.

## Constants that drift with game patches

These are hand-maintained and must be re-verified against the current game
version whenever the caps change:

- **Level cap** — `max={60}` in `ServerCalculators.tsx` (Level field).
  History: 50 → 55 → 60; Pocketpair raises it in major updates.
- **Soul rank cap** — 20 (+3% each) in `web/src/lib/stats.ts` (`soulMult`)
  and the Calculators soul fields. Went 10 → 20 with Large Pal Souls.
- **Trust/bond rank cap** — 10, and the `FRIENDSHIP_THRESHOLDS` table in
  `stats.ts` (vendored from PalworldSaveTools).
- **Condenser stars** — 4 (+5% each).
- **`TRUST_SCALE = 0.85`** in `stats.ts` — empirical calibration; re-check
  against in-game numbers if a patch touches the bond bonus.
- **Uncatchable deck entries** — `UNCATCHABLE_DECK_LABELS` in
  `web/src/lib/paldex.ts`: Paldeck numbers the game lists but never lets a
  player acquire, excluded from completion so 100% stays reachable and the
  missing-list stays actionable. Currently just #204 Astralym. A patch that
  makes a raid boss catchable (or adds an uncatchable one) has to be
  reflected here by hand — the save gives no catchability flag.
- **Passive inheritance rates** — `web/src/lib/inheritance.ts`: the
  40/30/20/10 inherit-count weights, the matching random-passive roll, and
  the 4-slot cap are community reverse-engineered (the model every public
  breeding calculator implements), not official. Re-verify if a patch
  touches breeding.

## Local touch-ups to preserve on refresh

- `palDex.json`: `plantslime_flower` is renamed to **"Gumoss (Special)"** —
  upstream names it plain "Gumoss", identical to the base pal, which made
  the #12B entry in the Paldex missing-list read as base Gumoss missing.
  It's the only base/variant name collision in the catalog; keep it fixed.
- **Known drift (as of 2026-07)**: the Yakushima creatures
  (`YakushimaMonster001/_Blue/_Pink`, `YakushimaMonster002`,
  `YakushimaBoss001…`) exist in real saves but are absent from
  `palDeck.json`/`palDex.json`. They currently fall out of Paldex and
  species math silently; pick them up on the next catalog refresh.

## How to refresh

1. Pull the current catalogs from the upstream repos listed above (their
   data folders are JSON; the vendored files keep upstream's shape, minus
   fields we don't read).
2. Diff against the current files — additions are safe; renames matter
   (a renamed key silently falls back to the humanized id).
3. Spot-check in the UI with a real save: a newly-added pal should show
   name, icon, elements, and effective stats.
4. Re-verify the constants above against patch notes.
5. Update the attribution footers in `ServerPlayers.tsx` and
   `ServerInventory.tsx` if sources change.

## Related upstream watch

`palworld-save-tools` (Python, powers the backend save extractor — pinned
in the Dockerfile and CI) and `pyooz` have their own pins; upstream PR #215
(native PlM support in palworld-save-tools) would let the pyooz shim retire.
Check those pins on the same cadence.
