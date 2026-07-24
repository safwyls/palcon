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

from palworld_save_tools.archive import FArchiveReader
from palworld_save_tools.gvas import GvasFile, GvasHeader
from palworld_save_tools.palsav import decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_TYPE_HINTS

from guilds import decode_guild

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


# Soul/condenser stat names come back as Japanese labels regardless of the
# server's language, so they're mapped here rather than shown raw.
STATUS_NAMES = {
    "最大HP": "Max HP",
    "最大SP": "Max SP",
    "攻撃力": "Attack",
    "防御力": "Defense",
    "所持重量": "Carry Weight",
    "捕獲率": "Capture Rate",
    "作業速度": "Work Speed",
}


def status_points(param, key):
    """Soul upgrades, as {stat: points}, skipping the zeroes that pad the list."""
    out = {}
    for entry in v(param, key, "values", default=None) or []:
        name = text(entry, "StatusName")
        points = num(entry, "StatusPoint")
        if name and points:
            out[STATUS_NAMES.get(name, name)] = points
    return out


def parse_pal(param, instance_id):
    char_id = text(param, "CharacterID")
    gender = text(param, "Gender")
    passives = v(param, "PassiveSkillList", "values", default=None) or []
    skills = v(param, "EquipWaza", "values", default=None) or []

    # EPalBaseCampWorkerSickType::None means healthy; anything else is an
    # ailment worth surfacing, since a sick pal stops working at a base.
    sick = text(param, "WorkerSick").split("::")[-1]
    if sick in ("None", ""):
        sick = ""

    # Hp is a FixedPoint64 holding the value scaled by 1000.
    hp_raw = num(param, "Hp", "Value", default=0)

    return {
        "instanceId": instance_id,
        "characterId": char_id,
        "nickname": text(param, "NickName"),
        "level": num(param, "Level", default=1) or 1,
        "exp": num(param, "Exp"),
        "gender": "female" if "Female" in gender else ("male" if "Male" in gender else ""),
        "isBoss": char_id.upper().startswith("BOSS_"),
        "isLucky": bool(unwrap(v(param, "IsRarePal", default=False))),
        "rank": num(param, "Rank", default=1) or 1,
        "talentHp": num(param, "Talent_HP"),
        "talentShot": num(param, "Talent_Shot"),
        "talentDefense": num(param, "Talent_Defense"),
        "passives": [str(p) for p in passives],
        "skills": [str(s).split("::")[-1] for s in skills],
        "hp": round(hp_raw / 1000) if hp_raw else 0,
        "sanity": round(num(param, "SanityValue"), 1),
        "stomach": round(num(param, "FullStomach"), 1),
        "friendship": num(param, "FriendshipPoint"),
        "sick": sick,
        "souls": status_points(param, "GotExStatusPointList"),
        "slotIndex": num(param, "SlotId", "SlotIndex", default=-1),
    }


def skip_property(reader, type_name, size):
    """Seek past a property we don't need.

    `size` counts only the payload, not the per-type header that precedes
    it (an IntProperty writes a guid flag but reports size 4), so the
    header has to be consumed before the skip. Layouts mirror
    FArchiveWriter.property_inner.
    """
    if type_name == "StructProperty":
        reader.fstring()  # struct type
        reader.guid()
        reader.optional_guid()
    elif type_name == "ArrayProperty":
        reader.fstring()  # element type
        reader.optional_guid()
    elif type_name == "MapProperty":
        reader.fstring()  # key type
        reader.fstring()  # value type
        reader.optional_guid()
    elif type_name in ("EnumProperty", "ByteProperty"):
        reader.fstring()  # enum / byte subtype
        reader.optional_guid()
    elif type_name == "BoolProperty":
        # The value lives in the header and size is 0.
        reader.bool()
        reader.optional_guid()
    else:
        reader.optional_guid()
    reader.skip(size)


def read_sections(gvas_data, wanted):
    """Pull just the named worldSaveData sections, skipping everything else.

    A world save holds ~22 sections, and the ones we never look at —
    foliage instances, every placed structure, every container slot — are
    the enormous ones. Parsing them costs minutes and gigabytes on an
    established world (byte arrays deserialize into Python lists of ints),
    purely to be discarded. Properties are length-prefixed, so we walk the
    top level, seek past anything unwanted, and stop as soon as everything
    asked for has been read.
    """
    found = {}
    with FArchiveReader(
        gvas_data, PALWORLD_TYPE_HINTS, CUSTOM_PROPERTIES, allow_nan=True
    ) as reader:
        GvasHeader.read(reader)
        while True:
            name = reader.fstring()
            if name == "None":
                break
            type_name = reader.fstring()
            size = reader.u64()
            if name != "worldSaveData" or type_name != "StructProperty":
                skip_property(reader, type_name, size)
                continue

            # Descend into worldSaveData rather than skipping it.
            reader.fstring()
            reader.guid()
            reader.optional_guid()
            while True:
                inner = reader.fstring()
                if inner == "None":
                    break
                inner_type = reader.fstring()
                inner_size = reader.u64()
                if inner in wanted:
                    prop = reader.property(inner_type, inner_size, f".worldSaveData.{inner}")
                    found[inner] = prop.get("value", [])
                    if len(found) == len(wanted):
                        return found
                    continue
                skip_property(reader, inner_type, inner_size)
            break
    return found


def read_character_entries(gvas_data):
    return read_sections(gvas_data, {"CharacterSaveParameterMap"}).get(
        "CharacterSaveParameterMap", []
    )


def read_gvas(path, custom_properties):
    """Parse one .sav file whole. Library progress/warning chatter goes to
    stderr: it prints to stdout by default, which would corrupt our JSON."""
    with open(path, "rb") as f:
        raw = f.read()
    with contextlib.redirect_stdout(sys.stderr):
        return GvasFile.read(
            decompress_sav(raw), PALWORLD_TYPE_HINTS, custom_properties, allow_nan=True
        )


def parse_base_camps(entries, reader_source):
    """Base camps as {guild id: [{x, y}]}.

    A camp's own name is an untranslated internal placeholder, so camps are
    labelled by the guild that owns them instead. Coordinates come out in
    the same world space the live map already plots players in.
    """
    by_guild = {}
    for entry in entries or []:
        try:
            raw = bytes(entry["value"]["RawData"]["value"]["values"])
            r = reader_source.internal_copy(raw, debug=False)
            r.guid()          # camp id
            r.fstring()       # placeholder name
            r.byte()          # state
            transform = r.ftransform()
            r.float()         # area range
            guild_id = str(r.guid())
        except Exception as exc:
            print(f"warning: skipping a base camp: {exc}", file=sys.stderr)
            continue
        t = transform.get("translation", {})
        by_guild.setdefault(guild_id, []).append(
            {"x": t.get("x", 0.0), "y": t.get("y", 0.0)}
        )
    return by_guild


def parse_guilds(entries, base_camps, player_names):
    """Assemble guilds, naming members from the player saves.

    Membership comes from the guild's character handles (reliable across
    versions); names come from player_names, which is built from
    Players/<uid>.sav. Anyone missing there falls back to a name carried in
    the guild record itself, and finally to the bare uid.
    """
    out = []
    for entry in entries or []:
        group_type = text(entry.get("value", {}), "GroupType")
        if "Guild" not in group_type:
            continue  # organizations and parties aren't player guilds
        raw = v(entry.get("value", {}), "RawData", "values", default=None)
        if raw is None:
            continue
        guild = decode_guild(raw)
        if not guild:
            continue

        spare = [n for n in guild.pop("spareNames", []) if n != guild["name"]]
        members = []
        for uid in guild.pop("memberUids", []):
            name = player_names.get(uid, "")
            if not name and spare:
                name = spare.pop(0)
            members.append({"uid": uid, "name": name or uid[:8]})

        guild["members"] = members
        guild["memberCount"] = len(members)
        guild["bases"] = base_camps.get(guild["id"], [])
        out.append(guild)
    out.sort(key=lambda g: (-len(g["members"]), g["name"].lower()))
    return out


# Unreal FDateTime counts 100ns ticks from 0001-01-01; Unix time starts here.
FDATETIME_EPOCH_OFFSET = 62_135_596_800


def ticks_to_unix(ticks):
    if not ticks:
        return 0
    seconds = ticks / 10_000_000 - FDATETIME_EPOCH_OFFSET
    # Reject anything not in living memory: the field is absent or holds
    # something else entirely on some saves, and a bogus date is worse
    # than none.
    return round(seconds) if 1_500_000_000 < seconds < 4_000_000_000 else 0


def player_containers_from_dir(players_dir):
    """Map each player's pal containers from Players/<uid>.sav.

    Newer saves moved OtomoCharacterContainerId (party) and
    PalStorageContainerId (palbox) out of the character entry and into
    per-player files, and dropped OwnerPlayerUId from pals entirely — so
    a pal's owner is now established by which container holds it.

    Returns ({container_guid: (player_uid, bucket)}, {uid: player metadata}).
    """
    index, meta = {}, {}
    if not os.path.isdir(players_dir):
        return index, meta
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
        translation = v(save_data, "LastTransform", "Translation", default=None) or {}
        meta[uid] = {
            "lastOnline": ticks_to_unix(num(save_data, "LastOnlineDateTime")),
            "lastX": unwrap(translation.get("x")) if "x" in translation else None,
            "lastY": unwrap(translation.get("y")) if "y" in translation else None,
            "platform": text(save_data, "PlayerPlatform").split("::")[-1],
            "technologyPoints": num(save_data, "TechnologyPoint"),
        }
        for key, bucket in (
            ("OtomoCharacterContainerId", "party"),
            ("PalStorageContainerId", "palbox"),
        ):
            cid = container_id(save_data, key)
            if cid:
                index[cid] = (uid, bucket)
    return index, meta


def main():
    if len(sys.argv) != 2:
        print("usage: extract_pals.py <Level.sav>", file=sys.stderr)
        return 2

    level_path = sys.argv[1]
    if os.path.isdir(level_path):
        level_path = os.path.join(level_path, "Level.sav")

    # container guid -> (player uid, "party" | "palbox")
    containers, player_meta = player_containers_from_dir(
        os.path.join(os.path.dirname(level_path), "Players")
    )

    with open(level_path, "rb") as f:
        gvas_data = decompress_sav(f.read())
    guilds = []
    guild_entries, camps = None, {}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            sections = read_sections(
                gvas_data,
                {"CharacterSaveParameterMap", "BaseCampSaveData", "GroupSaveDataMap"},
            )
        char_map = sections.get("CharacterSaveParameterMap", [])
        with contextlib.redirect_stdout(sys.stderr), FArchiveReader(
            b"", PALWORLD_TYPE_HINTS, {}, allow_nan=True
        ) as helper:
            camps = parse_base_camps(sections.get("BaseCampSaveData"), helper)
            guild_entries = sections.get("GroupSaveDataMap")
    except Exception as exc:
        # The targeted walk depends on save layout; if a future format
        # shift breaks it, fall back to parsing everything rather than
        # reporting no pals at all.
        print(f"warning: fast path failed ({exc}); parsing whole save", file=sys.stderr)
        with contextlib.redirect_stdout(sys.stderr):
            gvas = GvasFile.read(gvas_data, PALWORLD_TYPE_HINTS, CUSTOM_PROPERTIES, allow_nan=True)
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

    for uid, rec in players.items():
        rec.update(player_meta.get(uid, {}))
        rec.setdefault("lastOnline", 0)
        rec.setdefault("lastX", None)
        rec.setdefault("lastY", None)
        rec.setdefault("platform", "")

    player_names = {uid: rec["nickname"] for uid, rec in players.items() if rec["nickname"]}
    if guild_entries:
        with contextlib.redirect_stdout(sys.stderr):
            guilds = parse_guilds(guild_entries, camps, player_names)

    out = {
        "players": sorted(players.values(), key=lambda r: (r["nickname"].lower(), r["uid"])),
        "guilds": guilds,
    }
    json.dump(out, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
