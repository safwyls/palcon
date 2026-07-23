#!/usr/bin/env python3
"""Generate the "new layout" save fixture (newlayout/).

Modelled on a real Palworld 0.6-era save. Three things changed versus the
older layout that `gen_fixture.py` produces, and each one silently produced
zero pals before it was handled:

  * A player's OtomoCharacterContainerId / PalStorageContainerId moved out
    of its CharacterSaveParameterMap entry into Players/<uid>.sav.
  * Pals lost OwnerPlayerUId entirely; only OldOwnerPlayerUIds remains, so
    ownership has to come from which container holds the pal.
  * Level became a ByteProperty, which nests one level deeper than the
    IntProperty it used to be.

Compression is plain zlib here on purpose: the Oodle container is already
covered by Level_oodle.sav, and keeping this one zlib means it regenerates
with nothing but pip install palworld-save-tools.

Usage: python3 gen_newlayout_fixture.py [outdir]
"""

import os
import sys

from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import compress_gvas_to_sav
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES

ZERO = "00000000-0000-0000-0000-000000000000"

KYOSHI = "11111111-1111-1111-1111-111111111111"
REN = "22222222-2222-2222-2222-222222222222"
KYOSHI_PARTY = "aaaaaaaa-1111-0000-0000-000000000001"
KYOSHI_BOX = "aaaaaaaa-1111-0000-0000-000000000002"
REN_PARTY = "bbbbbbbb-2222-0000-0000-000000000001"
REN_BOX = "bbbbbbbb-2222-0000-0000-000000000002"
BASE_CONTAINER = "cccccccc-0000-0000-0000-000000000001"


def sp(struct_type, value):
    return {"struct_type": struct_type, "struct_id": ZERO, "id": None, "value": value, "type": "StructProperty"}


def guid(value):
    return sp("Guid", value)


def containerid(value):
    return sp("PalContainerId", {"ID": guid(value)})


def s(value):
    return {"id": None, "value": value, "type": "StrProperty"}


def name(value):
    return {"id": None, "value": value, "type": "NameProperty"}


def i(value):
    return {"id": None, "value": value, "type": "IntProperty"}


def byte(value):
    """Level and friends are ByteProperty in newer saves — note the extra
    nesting versus IntProperty, which is exactly what tripped up parsing."""
    return {"id": None, "value": {"type": "None", "value": value}, "type": "ByteProperty"}


def b(value):
    return {"value": value, "id": None, "type": "BoolProperty"}


def enum(etype, value):
    return {"id": None, "value": {"type": etype, "value": value}, "type": "EnumProperty"}


def namearray(values):
    return {"array_type": "NameProperty", "id": None, "value": {"values": values}, "type": "ArrayProperty"}


def guidarray(prop_name, values):
    return {
        "array_type": "StructProperty",
        "id": None,
        "value": {
            "prop_name": prop_name,
            "prop_type": "StructProperty",
            "values": values,
            "type_name": "Guid",
            "id": ZERO,
        },
        "type": "ArrayProperty",
    }


def slotid(container, index):
    return sp("PalCharacterSlotId", {"ContainerId": containerid(container), "SlotIndex": i(index)})


def entry(player_uid, instance_id, save_parameter):
    return {
        "key": {"PlayerUId": guid(player_uid), "InstanceId": guid(instance_id)},
        "value": {
            "RawData": {
                "array_type": "ByteProperty",
                "id": None,
                "value": {
                    "object": {"SaveParameter": sp("PalIndividualCharacterSaveParameter", save_parameter)},
                    "unknown_bytes": [0, 0, 0, 0],
                    "group_id": ZERO,
                },
                "type": "ArrayProperty",
                "custom_type": ".worldSaveData.CharacterSaveParameterMap.Value.RawData",
            }
        },
    }


def player(uid, nickname, level, instance_id):
    # Deliberately carries no container ids — those live in Players/ now.
    return entry(uid, instance_id, {
        "IsPlayer": b(True),
        "NickName": s(nickname),
        "Level": byte(level),
    })


def pal(old_owner, instance_id, char_id, container, slot, level=1, nickname="",
        gender="EPalGenderType::Female", hp=50, shot=50, defense=50, passives=(), lucky=False):
    param = {
        "CharacterID": name(char_id),
        "Level": byte(level),
        "Gender": enum("EPalGenderType", gender),
        "Talent_HP": i(hp),
        "Talent_Shot": i(shot),
        "Talent_Defense": i(defense),
        "SlotId": slotid(container, slot),
        # No OwnerPlayerUId in this layout.
        "OldOwnerPlayerUIds": guidarray("OldOwnerPlayerUIds", [old_owner]),
    }
    if nickname:
        param["NickName"] = s(nickname)
    if passives:
        param["PassiveSkillList"] = namearray(list(passives))
    if lucky:
        param["IsRarePal"] = b(True)
    return entry(ZERO, instance_id, param)


HEADER = {
    "magic": 0x53415647,
    "save_game_version": 3,
    "package_file_version_ue4": 522,
    "package_file_version_ue5": 1008,
    "engine_version_major": 5,
    "engine_version_minor": 1,
    "engine_version_patch": 1,
    "engine_version_changelist": 0,
    "engine_version_branch": "++UE5+Release-5.1",
    "custom_version_format": 3,
    "custom_versions": [],
    "save_game_class_name": "/Script/Pal.PalWorldSaveGame",
}


def write_sav(gvas_dict, path):
    gvas = GvasFile.load(gvas_dict)
    data = compress_gvas_to_sav(gvas.write(PALWORLD_CUSTOM_PROPERTIES), 0x32)
    with open(path, "wb") as f:
        f.write(data)
    print(f"wrote {path} ({len(data)} bytes)")


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "newlayout"
    os.makedirs(os.path.join(outdir, "Players"), exist_ok=True)

    entries = [
        player(KYOSHI, "Kyoshi", 42, "10000000-0000-0000-0000-000000000001"),
        player(REN, "Ren", 37, "20000000-0000-0000-0000-000000000001"),
        # Kyoshi: 2 party, 2 palbox, 1 at a base
        pal(KYOSHI, "10000000-0000-0000-0000-000000000101", "SheepBall", KYOSHI_PARTY, 0, 12,
            "Fluffy", passives=["Brave", "PAL_ALLAttack_up1"]),
        pal(KYOSHI, "10000000-0000-0000-0000-000000000102", "BOSS_Anubis", KYOSHI_PARTY, 1, 47,
            gender="EPalGenderType::Male", hp=100, shot=93, defense=71, passives=["Legend"]),
        pal(KYOSHI, "10000000-0000-0000-0000-000000000103", "PinkCat", KYOSHI_BOX, 0, 8),
        pal(KYOSHI, "10000000-0000-0000-0000-000000000104", "Kitsunebi", KYOSHI_BOX, 1, 20, lucky=True),
        pal(KYOSHI, "10000000-0000-0000-0000-000000000105", "Penguin", BASE_CONTAINER, 0, 15),
        # Ren: 1 party, 1 palbox
        pal(REN, "20000000-0000-0000-0000-000000000101", "LazyCatfish", REN_PARTY, 0, 33,
            gender="EPalGenderType::Male"),
        pal(REN, "20000000-0000-0000-0000-000000000102", "Garm", REN_BOX, 0, 5, "Doggo"),
        # Never owned by anyone — must not show up under any player.
        pal(ZERO, "99999999-0000-0000-0000-000000000001", "GrassMammoth",
            "dddddddd-0000-0000-0000-000000000001", 0, 50),
    ]

    write_sav({
        "header": HEADER,
        "properties": {
            "worldSaveData": sp("PalWorldSaveData", {
                "CharacterSaveParameterMap": {
                    "key_type": "StructProperty",
                    "value_type": "StructProperty",
                    "key_struct_type": "PalInstanceID",
                    "value_struct_type": "PalCharacterSaveParameter",
                    "id": None,
                    "value": entries,
                    "type": "MapProperty",
                },
            }),
        },
        "trailer": "AAAAAA==",
    }, os.path.join(outdir, "Level.sav"))

    for uid, party, box in ((KYOSHI, KYOSHI_PARTY, KYOSHI_BOX), (REN, REN_PARTY, REN_BOX)):
        write_sav({
            "header": {**HEADER, "save_game_class_name": "/Script/Pal.PalWorldPlayerSaveGame"},
            "properties": {
                "SaveData": sp("PalWorldPlayerSaveData", {
                    "PlayerUId": guid(uid),
                    "OtomoCharacterContainerId": containerid(party),
                    "PalStorageContainerId": containerid(box),
                }),
            },
            "trailer": "AAAAAA==",
        }, os.path.join(outdir, "Players", uid.replace("-", "").upper() + ".sav"))


if __name__ == "__main__":
    main()
