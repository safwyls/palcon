# Save fixtures

Synthetic Palworld saves for `palsave_test.go`. Both contain the same two
players (Kyoshi, Ren) and their pals — no copyrighted game data, so they're
safe to commit.

| File | Container | Covers |
| --- | --- | --- |
| `Level.sav` | `PlZ` (zlib) | The original save format |
| `Level_oodle.sav` | `PlM` (Oodle Kraken) | The newer format used by game builds 0.6+ |

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
