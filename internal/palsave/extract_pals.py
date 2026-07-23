#!/usr/bin/env python3
"""Extract per-player party/palbox data from a Palworld Level.sav.

Usage: extract_pals.py /path/to/Level.sav

Prints JSON to stdout:
  {
    "players": [
      {
        "uid": "...", "nickname": "...", "level": 12,
        "party":  [<pal>...],   # pals in the player's party container
        "palbox": [<pal>...],   # pals in the player's palbox container
        "base":   [<pal>...]    # owned pals working at a base (neither container)
      }
    ]
  }

Read-only by design: the save file is opened for reading and never written.
Parsing relies on palworld-save-tools (MIT, the community-standard GVAS
implementation) — install with: pip install palworld-save-tools

The save format is community-reverse-engineered and evolves with game
patches, so every field access below is defensive: a missing field degrades
to a default rather than failing the whole extraction.
"""

import json
import sys

from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES, PALWORLD_TYPE_HINTS

ZERO_GUID = "00000000-0000-0000-0000-000000000000"


def decompress_sav(raw):
    """Unwrap a .sav container down to its raw GVAS bytes.

    Palworld has shipped two compression containers, distinguished by the
    magic bytes in the header (NOT by save_type, whose values overlap
    between them):

      PlZ - zlib, the original format; palworld-save-tools handles it.
      PlM - Oodle Kraken, used by newer builds (0.6+). No released version
            of palworld-save-tools reads this yet (upstream PR #215 is
            still open), so we unwrap it here via pyooz, an open-source
            Kraken decompressor. Decompress-only: the published pyooz
            wheel exposes no compressor, which suits the read-only rule.

    A "CNK" magic marks an Xbox-style chunked header, where the real header
    starts 12 bytes further in.
    """
    header_offset = 12 if raw[8:11] == b"CNK" else 0
    magic = raw[header_offset + 8 : header_offset + 11]

    if magic != b"PlM":
        gvas_data, _ = decompress_sav_to_gvas(raw)
        return gvas_data

    try:
        import ooz
    except ImportError:
        raise SystemExit(
            "this save uses the newer Oodle-compressed (PlM) format, which needs "
            "the 'pyooz' package: pip install pyooz"
        )

    uncompressed_len = int.from_bytes(raw[header_offset : header_offset + 4], "little")
    compressed_len = int.from_bytes(raw[header_offset + 4 : header_offset + 8], "little")
    body = raw[header_offset + 12 : header_offset + 12 + compressed_len]
    if len(body) != compressed_len:
        raise SystemExit(
            f"truncated save: header claims {compressed_len} compressed bytes, found {len(body)}"
        )
    return ooz.decompress(body, uncompressed_len)


def v(node, *path, default=None):
    """Walk nested gvas property dicts, unwrapping {"value": ...} at each step."""
    cur = node
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
        if isinstance(cur, dict) and "value" in cur:
            cur = cur["value"]
        if cur is None:
            return default
    return cur


def container_id(node, *path):
    """A container reference is a struct holding a single guid at .ID."""
    raw = v(node, *path, "ID", default=None)
    return str(raw) if raw is not None else None


def parse_pal(param, instance_id):
    char_id = v(param, "CharacterID", default="") or ""
    gender_raw = v(param, "Gender", default="") or ""
    passives = v(param, "PassiveSkillList", "values", default=None) or []
    return {
        "instanceId": instance_id,
        "characterId": char_id,
        "nickname": v(param, "NickName", default="") or "",
        "level": v(param, "Level", default=1) or 1,
        "gender": "female" if "Female" in str(gender_raw) else ("male" if "Male" in str(gender_raw) else ""),
        "isBoss": char_id.upper().startswith("BOSS_"),
        "isLucky": bool(v(param, "IsRarePal", default=False)),
        "rank": v(param, "Rank", default=1) or 1,
        "talentHp": v(param, "Talent_HP", default=0) or 0,
        "talentShot": v(param, "Talent_Shot", default=0) or 0,
        "talentDefense": v(param, "Talent_Defense", default=0) or 0,
        "passives": [str(p) for p in passives],
    }


def main():
    if len(sys.argv) != 2:
        print("usage: extract_pals.py <Level.sav>", file=sys.stderr)
        return 2

    with open(sys.argv[1], "rb") as f:
        raw = f.read()
    gvas_data = decompress_sav(raw)
    gvas = GvasFile.read(gvas_data, PALWORLD_TYPE_HINTS, PALWORLD_CUSTOM_PROPERTIES, allow_nan=True)

    world = gvas.properties.get("worldSaveData", {}).get("value", {})
    char_map = world.get("CharacterSaveParameterMap", {}).get("value", [])

    players = {}  # uid -> player record + container ids
    pals = []     # (owner_uid, container_id, pal)

    for entry in char_map:
        key = entry.get("key", {})
        uid = str(v(key, "PlayerUId", default=ZERO_GUID) or ZERO_GUID)
        instance_id = str(v(key, "InstanceId", default="") or "")
        param = v(entry.get("value", {}), "RawData", "object", "SaveParameter", default=None)
        if not isinstance(param, dict):
            continue

        if v(param, "IsPlayer", default=False):
            players[uid] = {
                "record": {
                    "uid": uid,
                    "nickname": v(param, "NickName", default="") or "",
                    "level": v(param, "Level", default=1) or 1,
                    "party": [],
                    "palbox": [],
                    "base": [],
                },
                "party_container": container_id(param, "OtomoCharacterContainerId"),
                "palbox_container": container_id(param, "PalStorageContainerId"),
            }
        else:
            owner = str(v(param, "OwnerPlayerUId", default="") or "")
            slot_container = container_id(param, "SlotId", "ContainerId") or container_id(param, "SlotID", "ContainerId")
            pals.append((owner, slot_container, parse_pal(param, instance_id)))

    for owner, slot_container, pal in pals:
        p = players.get(owner)
        if p is None:
            continue  # unowned (wild/dungeon) — out of scope
        if slot_container is not None and slot_container == p["party_container"]:
            p["record"]["party"].append(pal)
        elif slot_container is not None and slot_container == p["palbox_container"]:
            p["record"]["palbox"].append(pal)
        else:
            p["record"]["base"].append(pal)

    out = {"players": sorted((p["record"] for p in players.values()), key=lambda r: r["nickname"].lower())}
    json.dump(out, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
