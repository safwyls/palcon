# Save fixtures

Synthetic Palworld saves for `palsave_test.go`. All contain the same two
players (Kyoshi, Ren) and their pals — no copyrighted game data, so they're
safe to commit.

| File | Container | Covers |
| --- | --- | --- |
| `Level.sav` | `PlZ` (zlib) | The original save format |
| `Level_oodle.sav` | `PlM` (Oodle Kraken) | The newer format used by game builds 0.6+ |
| (generated) | `PlZ` (zlib) | 0.6-era container-based ownership, plus pal storage: a `Players/<uid>_dps.sav` Dimensional Pal Storage sidecar (with an empty slot that must be skipped) and a `GlobalPalStorage.sav` attributed by `OldOwnerPlayerUIds`. Also the player inventories — see below. Built into a temp dir at test time by `gen_newlayout_fixture.py`, so no extra `.sav` binaries need committing; a `newlayout/` on disk is a leftover from running the generator by hand |

## Inventory coverage

The generated fixture's `ItemContainerSaveData` exercises the parts of the item
layout that fail quietly rather than loudly:

- Slot contents are **packed into each slot's `RawData`**, not written as
  properties, and carry trailing padding the reader must ignore.
- Kyoshi's backpack skips slot 2 and holds an empty (zero-count) slot 3, so
  gaps stay gaps and empties are dropped.
- Gear state lives in a separate `DynamicItemSaveData` section joined by guid:
  a bow with durability and a loaded round, an egg naming the species inside,
  and a katana that rolled its own passive.
- `CHEST_CONTAINER` belongs to no player, proving the walk skips the thousands
  of world containers instead of attributing them.
- Ren's player save declares only a backpack — the other container fields are
  absent, which must read as "no such bag" rather than failing.

## Character coverage

Kyoshi's `CharacterSaveParameterMap` entry also carries a full player record —
EXP, a FixedPoint64 HP and shield, hunger, unspent points, both status-point
pools (with a zero that must be dropped rather than reported), and a running
food buff. The stat names are Japanese in every save regardless of the server's
language, so the fixture uses them verbatim; a missed mapping shows up as an
untranslated label rather than an error. Ren's entry has none of it, covering a
player who has never spent a point.

## Regenerating

`Level.sav` is built by `gen_fixture.py`, which assembles the GVAS property
tree by hand and writes it with palworld-save-tools' own SAV writer:

```sh
pip install palworld-save-tools==0.24.0
python3 gen_fixture.py Level.sav
```

`Level_oodle.sav` is the same GVAS payload in the Oodle container. The
published `pyooz` wheel only decompresses (which is what palcon wants), so
the fixture is built with `mkplm.cpp` against the ooz sources:

```sh
git clone --recurse-submodules https://github.com/MRHRTZ/ooz
python3 -c "
from palworld_save_tools.palsav import decompress_sav_to_gvas
open('level.gvas','wb').write(decompress_sav_to_gvas(open('Level.sav','rb').read())[0])"
g++ -O2 -DOOZ_BUILD_DLL=1 -Iooz/simde -o mkplm mkplm.cpp \
    ooz/{bitknit,kraken,lzna,compress,compr_kraken,compr_leviathan,compr_mermaid,compr_entropy,compr_match_finder,compr_multiarray,compr_tans}.cpp
./mkplm level.gvas Level_oodle.sav
```
