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

import contextlib
import json
import os
import sys

from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_TYPE_HINTS

ZERO_GUID = "00000000-0000-0000-0000-000000000000"

CHARACTER_PATH = ".worldSaveData.CharacterSaveParameterMap.Value.RawData"


def decode_character(reader, type_name, size, path):
    """Decode one character blob, reading only as far as we actually need.

    palworld-save-tools' own decoder reads the trailing fields after the
    property tree (unknown bytes, group id, ...) and then asserts it landed
    exactly on EOF. Newer saves append more trailing data, so that assertion
    fires ("Warning: EOF not reached") and takes the whole extraction with
    it — even though the pal data itself parsed perfectly.

    We only ever read `object.SaveParameter`, and being read-only we never
    have to re-encode the tail, so we stop once the property tree is out and
    ignore whatever follows. Trailing-layout changes can't break us.
    """
    if type_name != "ArrayProperty":
        raise Exception(f"expected ArrayProperty, got {type_name}")
    value = reader.property(type_name, size, path, nested_caller_path=path)
    inner = reader.internal_copy(bytes(value["value"]["values"]), debug=False)
    value["value"] = {"object": inner.properties_until_end()}
    return value


def _unused_encode(*_args, **_kwargs):
    raise NotImplementedError("palcon never writes save files")


# Deliberately the *only* custom decoder we register. palworld-save-tools
# ships decoders for group/guild data, item containers, foliage, base camps,
# map objects and more; every one is both dead weight (we read none of them)
# and a way for an unrelated format change to break the Pal viewer. Left
# unregistered, those blobs stay unparsed byte arrays that nothing can choke
# on, and a big world parses substantially faster.
CUSTOM_PROPERTIES = {CHARACTER_PATH: (decode_character, _unused_encode)}


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


def unwrap(val):
    """Strip gvas value wrappers down to the scalar inside.

    Property values nest to different depths by type — a ByteProperty holds
    {"value": {"type": ..., "value": 5}} where an IntProperty holds
    {"value": 5} — so unwrap until there's no wrapper left rather than
    assuming a fixed depth.
    """
    while isinstance(val, dict) and "value" in val:
        val = val["value"]
    return val


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


def num(node, *path, default=0):
    val = unwrap(v(node, *path, default=None))
    return val if isinstance(val, (int, float)) and not isinstance(val, bool) else default


def text(node, *path, default=""):
    val = unwrap(v(node, *path, default=None))
    return val if isinstance(val, str) else default


def container_id(node, *path):
    """A container reference is a struct holding a single guid at .ID."""
    raw = unwrap(v(node, *path, "ID", default=None))
    return str(raw) if raw is not None else None


def parse_pal(param, instance_id):
    char_id = text(param, "CharacterID")
    gender = text(param, "Gender")
    passives = v(param, "PassiveSkillList", "values", default=None) or []
    return {
        "instanceId": instance_id,
        "characterId": char_id,
        "nickname": text(param, "NickName"),
        "level": num(param, "Level", default=1) or 1,
        "gender": "female" if "Female" in gender else ("male" if "Male" in gender else ""),
        "isBoss": char_id.upper().startswith("BOSS_"),
        "isLucky": bool(unwrap(v(param, "IsRarePal", default=False))),
        "rank": num(param, "Rank", default=1) or 1,
        "talentHp": num(param, "Talent_HP"),
        "talentShot": num(param, "Talent_Shot"),
        "talentDefense": num(param, "Talent_Defense"),
        "passives": [str(p) for p in passives],
    }


def read_gvas(path, custom_properties):
    """Parse one .sav file. Library progress/warning chatter goes to stderr:
    it prints to stdout by default, which would corrupt the JSON we emit."""
    with open(path, "rb") as f:
        raw = f.read()
    with contextlib.redirect_stdout(sys.stderr):
        return GvasFile.read(
            decompress_sav(raw), PALWORLD_TYPE_HINTS, custom_properties, allow_nan=True
        )


def player_containers_from_dir(players_dir):
    """Map each player's pal containers from Players/<uid>.sav.

    Newer saves moved OtomoCharacterContainerId (party) and
    PalStorageContainerId (palbox) out of the character entry and into
    per-player files, and dropped OwnerPlayerUId from pals entirely — so
    a pal's owner is now established by which container holds it.

    Returns {container_guid: (player_uid, bucket)}.
    """
    index = {}
    if not os.path.isdir(players_dir):
        return index
    for name in sorted(os.listdir(players_dir)):
        if not name.lower().endswith(".sav"):
            continue
        try:
            save_data = read_gvas(os.path.join(players_dir, name), {}).properties["SaveData"]["value"]
        except Exception as exc:  # one unreadable player shouldn't sink the rest
            print(f"warning: skipping {name}: {exc}", file=sys.stderr)
            continue
        uid = str(unwrap(save_data.get("PlayerUId")) or "")
        if not uid:
            continue
        for key, bucket in (
            ("OtomoCharacterContainerId", "party"),
            ("PalStorageContainerId", "palbox"),
        ):
            cid = container_id(save_data, key)
            if cid:
                index[cid] = (uid, bucket)
    return index


def main():
    if len(sys.argv) != 2:
        print("usage: extract_pals.py <Level.sav>", file=sys.stderr)
        return 2

    level_path = sys.argv[1]
    if os.path.isdir(level_path):
        level_path = os.path.join(level_path, "Level.sav")

    # container guid -> (player uid, "party" | "palbox")
    containers = player_containers_from_dir(os.path.join(os.path.dirname(level_path), "Players"))

    gvas = read_gvas(level_path, CUSTOM_PROPERTIES)
    world = gvas.properties.get("worldSaveData", {}).get("value", {})
    char_map = world.get("CharacterSaveParameterMap", {}).get("value", [])

    players = {}  # uid -> record
    pals = []     # (container_guid, old_owner_uids, pal)

    def record_for(uid):
        return players.setdefault(
            uid,
            {"uid": uid, "nickname": "", "level": 1, "party": [], "palbox": [], "base": []},
        )

    for entry in char_map:
        key = entry.get("key", {})
        uid = str(unwrap(v(key, "PlayerUId", default=ZERO_GUID)) or ZERO_GUID)
        instance_id = str(unwrap(v(key, "InstanceId", default="")) or "")
        param = v(entry.get("value", {}), "RawData", "object", "SaveParameter", default=None)
        if not isinstance(param, dict):
            continue

        if unwrap(v(param, "IsPlayer", default=False)):
            rec = record_for(uid)
            rec["nickname"] = text(param, "NickName")
            rec["level"] = num(param, "Level", default=1) or 1
            # Older saves keep the player's containers on the character entry
            # itself; newer ones only in Players/<uid>.sav (already indexed).
            for prop, bucket in (
                ("OtomoCharacterContainerId", "party"),
                ("PalStorageContainerId", "palbox"),
            ):
                cid = container_id(param, prop)
                if cid:
                    containers.setdefault(cid, (uid, bucket))
        else:
            cid = container_id(param, "SlotId", "ContainerId") or container_id(param, "SlotID", "ContainerId")
            # OwnerPlayerUId was dropped in newer saves; OldOwnerPlayerUIds is
            # what remains to attribute a pal sitting in a base container.
            old_owners = [
                str(o) for o in (v(param, "OldOwnerPlayerUIds", "values", default=None) or [])
            ]
            owner = str(unwrap(v(param, "OwnerPlayerUId", default="")) or "")
            if owner:
                old_owners.insert(0, owner)
            pals.append((cid, old_owners, parse_pal(param, instance_id)))

    for cid, old_owners, pal in pals:
        owner_bucket = containers.get(cid) if cid else None
        if owner_bucket is not None:
            uid, bucket = owner_bucket
            record_for(uid)[bucket].append(pal)
            continue
        # Not in anyone's party or palbox: it's working at a base (or was
        # otherwise released from a container). Attribute it to its most
        # recent owner if we know one; a pal with no owner at all is wild.
        for uid in old_owners:
            if uid and uid != ZERO_GUID:
                record_for(uid)["base"].append(pal)
                break

    out = {"players": sorted(players.values(), key=lambda r: (r["nickname"].lower(), r["uid"]))}
    json.dump(out, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
