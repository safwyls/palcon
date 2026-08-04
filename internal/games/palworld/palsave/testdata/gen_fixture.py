#!/usr/bin/env python3
"""Generate a minimal synthetic Level.sav fixture for palcon's extractor tests."""

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


def b(value):
    return {"value": value, "id": None, "type": "BoolProperty"}


def enum(etype, value):
    return {"id": None, "value": {"type": etype, "value": value}, "type": "EnumProperty"}


def namearray(values):
    return {"array_type": "NameProperty", "id": None, "value": {"values": values}, "type": "ArrayProperty"}


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


def player(uid, nickname, level, party_container, box_container, instance_id):
    return entry(uid, instance_id, {
        "IsPlayer": b(True),
        "NickName": s(nickname),
        "Level": i(level),
        "OtomoCharacterContainerId": containerid(party_container),
        "PalStorageContainerId": containerid(box_container),
    })


def pal(owner, instance_id, char_id, container, slot, level=1, nickname="", gender="EPalGenderType::Female",
        rank=1, hp=50, shot=50, defense=50, passives=(), lucky=False):
    param = {
        "CharacterID": name(char_id),
        "Level": i(level),
        "Gender": enum("EPalGenderType", gender),
        "Rank": i(rank),
        "Talent_HP": i(hp),
        "Talent_Shot": i(shot),
        "Talent_Defense": i(defense),
        "OwnerPlayerUId": guid(owner),
        "SlotId": slotid(container, slot),
    }
    if nickname:
        param["NickName"] = s(nickname)
    if passives:
        param["PassiveSkillList"] = namearray(list(passives))
    if lucky:
        param["IsRarePal"] = b(True)
    return entry(ZERO, instance_id, param)


entries = [
    player(KYOSHI, "Kyoshi", 42, KYOSHI_PARTY, KYOSHI_BOX, "10000000-0000-0000-0000-000000000001"),
    player(REN, "Ren", 37, REN_PARTY, REN_BOX, "20000000-0000-0000-0000-000000000001"),
    # Kyoshi: 2 party, 2 box, 1 base
    pal(KYOSHI, "10000000-0000-0000-0000-000000000101", "SheepBall", KYOSHI_PARTY, 0, 12, "Fluffy",
        passives=["Brave", "PAL_ALLAttack_up1"]),
    pal(KYOSHI, "10000000-0000-0000-0000-000000000102", "BOSS_Anubis", KYOSHI_PARTY, 1, 47,
        gender="EPalGenderType::Male", hp=100, shot=93, defense=71, passives=["Legend"]),
    pal(KYOSHI, "10000000-0000-0000-0000-000000000103", "PinkCat", KYOSHI_BOX, 0, 8),
    pal(KYOSHI, "10000000-0000-0000-0000-000000000104", "Kitsunebi", KYOSHI_BOX, 1, 20, lucky=True),
    pal(KYOSHI, "10000000-0000-0000-0000-000000000105", "Penguin", "cccccccc-0000-0000-0000-000000000001", 0, 15),
    # Ren: 1 party, 1 box
    pal(REN, "20000000-0000-0000-0000-000000000101", "LazyCatfish", REN_PARTY, 0, 33,
        gender="EPalGenderType::Male"),
    pal(REN, "20000000-0000-0000-0000-000000000102", "Garm", REN_BOX, 0, 5, "Doggo"),
    # Unowned wild pal — must be ignored
    pal(ZERO, "99999999-0000-0000-0000-000000000001", "GrassMammoth", "dddddddd-0000-0000-0000-000000000001", 0, 50),
]

gvas_dict = {
    "header": {
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
    },
    "properties": {
        "worldSaveData": {
            "struct_type": "PalWorldSaveData",
            "struct_id": ZERO,
            "id": None,
            "type": "StructProperty",
            "value": {
                "CharacterSaveParameterMap": {
                    "key_type": "StructProperty",
                    "value_type": "StructProperty",
                    "key_struct_type": "PalInstanceID",
                    "value_struct_type": "PalCharacterSaveParameter",
                    "id": None,
                    "value": entries,
                    "type": "MapProperty",
                },
            },
        },
    },
    "trailer": "AAAAAA==",
}

gvas = GvasFile.load(gvas_dict)
sav = compress_gvas_to_sav(gvas.write(PALWORLD_CUSTOM_PROPERTIES), 0x32)
out = sys.argv[1] if len(sys.argv) > 1 else "Level.sav"
with open(out, "wb") as f:
    f.write(sav)
print(f"wrote {out} ({len(sav)} bytes)")
