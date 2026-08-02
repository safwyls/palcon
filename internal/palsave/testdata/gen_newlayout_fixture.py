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

from palworld_save_tools.archive import FArchiveWriter
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
CAMP_ID = "eeeeeeee-0000-0000-0000-000000000001"
GUILD_ID = "ffffffff-0000-0000-0000-000000000001"

# Item containers. Each player has a backpack, a key-item container and a
# weapon rack; CHEST_CONTAINER belongs to nobody and must be walked past.
KYOSHI_BAG = "aaaaaaaa-1111-0000-0000-000000000011"
KYOSHI_KEYS = "aaaaaaaa-1111-0000-0000-000000000012"
KYOSHI_ARMS = "aaaaaaaa-1111-0000-0000-000000000013"
REN_BAG = "bbbbbbbb-2222-0000-0000-000000000011"
# CHEST_CONTAINER stands at the base camp, reached through MapObjectSaveData.
# ORPHAN_CONTAINER is claimed by no map object at all, which is what the save
# leaves behind for bulk storage whose object is gone — big enough to keep,
# unlike the single-slot ground drops that share its shape.
CHEST_CONTAINER = "dddddddd-0000-0000-0000-000000000011"
ORPHAN_CONTAINER = "dddddddd-0000-0000-0000-000000000012"
LITTER_CONTAINER = "dddddddd-0000-0000-0000-000000000013"
# The guild chest: owned by the guild, claimed by no map object, no position.
GUILD_CONTAINER = "dddddddd-0000-0000-0000-000000000014"

# Dynamic-item ids, joining a slot to its per-instance state.
BOW_ITEM = "aaaaaaaa-1111-0000-0000-000000000021"
EGG_ITEM = "aaaaaaaa-1111-0000-0000-000000000022"
SWORD_ITEM = "bbbbbbbb-2222-0000-0000-000000000021"


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


def bytearray_prop(values):
    """A plain byte ArrayProperty — how the raw blobs the extractor scans
    sequentially (base camp, worker director) are carried."""
    return {"array_type": "ByteProperty", "id": None, "value": {"values": values}, "type": "ArrayProperty"}


def _transform(x, y):
    return {
        "rotation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
        "translation": {"x": x, "y": y, "z": 0.0},
        "scale3d": {"x": 1.0, "y": 1.0, "z": 1.0},
    }


def map_object_entry(object_id, container_id, camp_id, guild_id, x, y):
    """One MapObjectSaveData entry — a placed object owning an item container.

    Two blobs matter. Model.RawData carries the base camp, guild and world
    position, and runs on past them into fields the extractor deliberately
    stops short of; the trailing junk here is what proves it stops. The
    ItemContainer module blob leads with the container it targets, and the slot
    attributes after it are likewise left unread.
    """
    w = FArchiveWriter()
    w.guid(ZERO)          # instance id
    w.guid(ZERO)          # concrete model instance id
    w.guid(camp_id)
    w.guid(guild_id)
    w.i32(100)            # hp current
    w.i32(100)            # hp max
    w.ftransform(_transform(x, y))
    w.write(b"\x7f" * 48)  # repair/owner/builder guids and whatever follows
    model_raw = list(w.bytes())

    w = FArchiveWriter()
    w.guid(container_id)
    w.write(b"\x5a" * 12)  # slot attributes, lock state, usage type
    module_raw = list(w.bytes())

    return {
        "MapObjectId": name(object_id),
        "Model": sp("PalMapObjectModel", {"RawData": bytearray_prop(model_raw)}),
        "ConcreteModel": sp("PalMapObjectConcreteModel", {
            "ModuleMap": {
                "key_type": "EnumProperty",
                "value_type": "StructProperty",
                "key_struct_type": None,
                "value_struct_type": "PalMapObjectConcreteModelModuleBase",
                "id": None,
                "value": [{
                    "key": "EPalMapObjectConcreteModelModuleType::ItemContainer",
                    "value": {"RawData": bytearray_prop(module_raw)},
                }],
                "type": "MapProperty",
            },
        }),
    }


def base_camp_entry(camp_id, guild_id, container_id, x, y):
    """One BaseCampSaveData entry: the camp blob the extractor reads for
    id/transform/guild, and the WorkerDirector blob it reads the worker
    container id from. Both get trailing junk bytes on purpose — newer
    saves append fields there and the reader must not care."""
    w = FArchiveWriter()
    w.guid(camp_id)
    w.fstring("Camp")
    w.byte(3)
    w.ftransform(_transform(x, y))
    w.float(3000.0)
    w.guid(guild_id)
    w.write(b"\x00\x00\x00\x00")
    camp_raw = list(w.bytes())

    w = FArchiveWriter()
    w.guid(camp_id)
    w.ftransform(_transform(x, y))
    w.byte(0)
    w.byte(0)
    w.guid(container_id)
    w.write(b"\x00\x00\x00\x00")
    director_raw = list(w.bytes())

    return {
        "key": camp_id,
        "value": {
            "RawData": bytearray_prop(camp_raw),
            "WorkerDirector": sp("PalWorkerDirector", {"RawData": bytearray_prop(director_raw)}),
        },
    }


def item_slot_raw(index, count, item_id, dynamic_id=ZERO):
    """One packed item slot, as current saves write them: index, stack count,
    item id, then the dynamic-item guid pair. The trailing bytes are padding
    the reader is expected to ignore — real saves have grown them between
    versions."""
    w = FArchiveWriter()
    w.i32(index)
    w.i32(count)
    w.fstring(item_id)
    w.guid(ZERO)  # created world id
    w.guid(dynamic_id)
    w.write(b"\x00" * 20)
    return list(w.bytes())


def dynamic_item_raw(dynamic_id, item_id, durability=None, ammo=0, passives=(), egg_species=None):
    """One DynamicItemSaveData blob: the per-instance state of a piece of gear
    or an egg. Both shapes start with a zero i32 that current saves added
    ahead of the payload."""
    w = FArchiveWriter()
    w.guid(ZERO)  # created world id
    w.guid(dynamic_id)
    w.fstring(item_id)
    w.u32(0)
    if egg_species:
        w.fstring(egg_species)
        w.fstring("None")  # the unhatched pal's (empty) property bag
        w.write(b"\x00" * 20)
    else:
        w.float(durability)
        w.i32(ammo)
        w.u32(len(passives))
        for p in passives:
            w.fstring(p)
        w.fstring("None")
        w.write(b"\x00\x00\x00\x00")
    return list(w.bytes())


def item_container_entry(container_id, slot_num, slots, group_id=ZERO):
    """One ItemContainerSaveData entry. Slots carry their data packed into
    RawData rather than as properties, which is the layout that matters."""
    return {
        "key": {"ID": guid(container_id)},
        "value": {
            # A non-zero GroupId marks a container the guild owns rather than a
            # player. Combined with no map object claiming it, that's the guild
            # chest — see classify_storage.
            "BelongInfo": sp("PalItemContainerBelongInfo", {"GroupId": guid(group_id)}),
            "SlotNum": i(slot_num),
            "Slots": {
                "array_type": "StructProperty",
                "id": None,
                "value": {
                    "prop_name": "Slots",
                    "prop_type": "StructProperty",
                    "values": [{"RawData": bytearray_prop(raw)} for raw in slots],
                    "type_name": "PalItemSlotSaveData",
                    "id": ZERO,
                },
                "type": "ArrayProperty",
            },
        },
    }


def inventory_info(common, essential=None, weapons=None):
    return sp("PalPlayerDataInventoryInfo", {
        "CommonContainerId": containerid(common),
        **({"EssentialContainerId": containerid(essential)} if essential else {}),
        **({"WeaponLoadOutContainerId": containerid(weapons)} if weapons else {}),
    })


def namemap(value_type, pairs):
    """MapProperty keyed by pal CharacterID — the shape RecordData uses for
    PaldeckUnlockFlag (bool) and PalCaptureCount (int)."""
    return {
        "key_type": "NameProperty",
        "value_type": value_type,
        "key_struct_type": None,
        "value_struct_type": None,
        "id": None,
        "value": [{"key": k, "value": v} for k, v in pairs],
        "type": "MapProperty",
    }


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


def statuspoints(prop_name, pairs):
    """A GotStatusPointList / GotExStatusPointList. The stat names really are
    Japanese in every save regardless of server language."""
    return {
        "array_type": "StructProperty",
        "id": None,
        "value": {
            "prop_name": prop_name,
            "prop_type": "StructProperty",
            "values": [{"StatusName": name(k), "StatusPoint": i(p)} for k, p in pairs],
            "type_name": "PalGotStatusPoint",
            "id": ZERO,
        },
        "type": "ArrayProperty",
    }


def fixed64(value):
    """Hp and ShieldHP are FixedPoint64 — the real value scaled by 1000."""
    return sp("FixedPoint64", {"Value": {"id": None, "value": value, "type": "Int64Property"}})


def player(uid, nickname, level, instance_id, character=None):
    # Deliberately carries no container ids — those live in Players/ now.
    return entry(uid, instance_id, {
        "IsPlayer": b(True),
        "NickName": s(nickname),
        "Level": byte(level),
        **(character or {}),
    })


def pal_param(char_id, level=1, nickname="", gender="EPalGenderType::Female",
              hp=50, shot=50, defense=50, old_owner=None):
    """A bare SaveParameter, for storage slots that carry it as plain
    properties instead of behind the RawData decoder."""
    param = {
        "CharacterID": name(char_id),
        "Level": byte(level),
        "Gender": enum("EPalGenderType", gender),
        "Talent_HP": i(hp),
        "Talent_Shot": i(shot),
        "Talent_Defense": i(defense),
    }
    if nickname:
        param["NickName"] = s(nickname)
    if old_owner:
        param["OldOwnerPlayerUIds"] = guidarray("OldOwnerPlayerUIds", [old_owner])
    return param


def storage_slot(instance_id, param):
    """One Dimensional/Global Pal Storage slot; an empty slot holds
    CharacterID "None" and no instance."""
    return {
        "SaveParameter": sp("PalIndividualCharacterSaveParameter", param),
        "InstanceId": sp("PalInstanceID", {"InstanceId": guid(instance_id)}),
    }


def storage_sav(slots):
    """The root property tree shared by Players/<uid>_dps.sav and
    GlobalPalStorage.sav: a bare SaveParameterArray of slots."""
    return {
        "header": {**HEADER, "save_game_class_name": "/Script/Pal.PalWorldDimensionalPalStorageSaveGame"},
        "properties": {
            "SaveParameterArray": {
                "array_type": "StructProperty",
                "id": None,
                "value": {
                    "prop_name": "SaveParameterArray",
                    "prop_type": "StructProperty",
                    "values": slots,
                    "type_name": "PalDimensionalPalStorageSaveParameter",
                    "id": ZERO,
                },
                "type": "ArrayProperty",
            },
        },
        "trailer": "AAAAAA==",
    }


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

    # Kyoshi has a full character record — both point pools, a running food
    # buff, a dented shield. Ren's entry carries none of it, covering a save
    # where the player has never spent a point.
    kyoshi_character = {
        "Exp": i(1234567),
        "Hp": fixed64(6820000),
        "ShieldHP": fixed64(1045000),
        "FullStomach": {"id": None, "value": 89.5, "type": "FloatProperty"},
        "UnusedStatusPoint": i(2),
        "GotStatusPointList": statuspoints("GotStatusPointList", [
            ("最大HP", 17),
            ("最大SP", 18),
            ("攻撃力", 18),
            ("所持重量", 18),
            ("捕獲率", 7),
            ("作業速度", 0),   # a zero must not survive into the payload
            ("移動速度アップ", 15),
            # The stat an earlier hand-collected mapping missed, because no
            # player in the sample save had spent a point on it.
            ("スタミナ消費軽減", 20),
        ]),
        "GotExStatusPointList": statuspoints("GotExStatusPointList", [
            ("最大HP", 9),
            ("攻撃力", 7),
        ]),
        "FoodWithStatusEffect": name("Minestrone"),
        "Tiemr_FoodWithStatusEffect": i(367),
    }

    entries = [
        player(KYOSHI, "Kyoshi", 42, "10000000-0000-0000-0000-000000000001", kyoshi_character),
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
                # One base camp whose worker container is the container the
                # base pal (Penguin) sits in — covers the worker→base join.
                "BaseCampSaveData": {
                    "key_type": "StructProperty",
                    "value_type": "StructProperty",
                    "key_struct_type": "Guid",
                    "value_struct_type": "PalBaseCampSaveData",
                    "id": None,
                    "value": [base_camp_entry(CAMP_ID, GUILD_ID, BASE_CONTAINER, 123400.0, -56700.0)],
                    "type": "MapProperty",
                },
                # Player item containers, plus a world chest owned by nobody
                # that the targeted walk has to skip rather than attribute.
                "ItemContainerSaveData": {
                    "key_type": "StructProperty",
                    "value_type": "StructProperty",
                    "key_struct_type": "PalContainerId",
                    "value_struct_type": "PalItemContainerSaveData",
                    "id": None,
                    "value": [
                        item_container_entry(KYOSHI_BAG, 6, [
                            item_slot_raw(0, 1200, "Money"),
                            item_slot_raw(1, 42, "PalSphere_Mega"),
                            # Slot 2 is skipped on purpose: a gap in a bag is
                            # real, and an empty slot writes a zero count.
                            item_slot_raw(3, 0, "None"),
                            item_slot_raw(4, 1, "PalEgg_Fire_01", EGG_ITEM),
                        ]),
                        item_container_entry(KYOSHI_KEYS, 230, [
                            item_slot_raw(0, 1, "TreasureBoxKey01"),
                        ]),
                        item_container_entry(KYOSHI_ARMS, 4, [
                            item_slot_raw(0, 1, "SkyBow_2", BOW_ITEM),
                        ]),
                        item_container_entry(CHEST_CONTAINER, 30, [
                            item_slot_raw(0, 999, "Wood"),
                            # Gear in storage: its durability has to survive the
                            # same dynamic-item join a worn weapon gets.
                            item_slot_raw(1, 1, "Katana_2", SWORD_ITEM),
                        ]),
                        item_container_entry(ORPHAN_CONTAINER, 54, [
                            item_slot_raw(0, 5441, "Berries"),
                        ]),
                        item_container_entry(LITTER_CONTAINER, 1, [
                            item_slot_raw(0, 1, "WheatSeeds"),
                        ]),
                        item_container_entry(GUILD_CONTAINER, 54, [
                            item_slot_raw(0, 9999, "Tomato"),
                        ], group_id=GUILD_ID),
                        item_container_entry(REN_BAG, 6, [
                            item_slot_raw(0, 1, "Katana_2", SWORD_ITEM),
                        ]),
                    ],
                    "type": "MapProperty",
                },
                # The chest above, standing at the base camp. Two objects, only
                # one of which owns a container, so the walk has to skip past a
                # module-less entry rather than assume every object has one.
                "MapObjectSaveData": {
                    "array_type": "StructProperty",
                    "id": None,
                    "value": {
                        "prop_name": "MapObjectSaveData",
                        "prop_type": "StructProperty",
                        "values": [
                            map_object_entry("ItemChest_03", CHEST_CONTAINER, CAMP_ID, GUILD_ID, 123400.0, -56700.0),
                            {
                                "MapObjectId": name("DefenseWall"),
                                "Model": sp("PalMapObjectModel", {"RawData": bytearray_prop([])}),
                                "ConcreteModel": sp("PalMapObjectConcreteModel", {
                                    "ModuleMap": {
                                        "key_type": "EnumProperty",
                                        "value_type": "StructProperty",
                                        "value_struct_type": "PalMapObjectConcreteModelModuleBase",
                                        "id": None,
                                        "value": [],
                                        "type": "MapProperty",
                                    },
                                }),
                            },
                        ],
                        "type_name": "PalMapObjectSaveData",
                        "id": ZERO,
                    },
                    "type": "ArrayProperty",
                },
                "DynamicItemSaveData": {
                    "array_type": "StructProperty",
                    "id": None,
                    "value": {
                        "prop_name": "DynamicItemSaveData",
                        "prop_type": "StructProperty",
                        "values": [
                            {"RawData": bytearray_prop(dynamic_item_raw(BOW_ITEM, "SkyBow_2", durability=2857.0, ammo=1))},
                            {"RawData": bytearray_prop(dynamic_item_raw(EGG_ITEM, "PalEgg_Fire_01", egg_species="Kitsunebi"))},
                            # A dropped weapon that rolled its own passive.
                            {"RawData": bytearray_prop(dynamic_item_raw(SWORD_ITEM, "Katana_2", durability=688.0, passives=["Legend"]))},
                        ],
                        "type_name": "PalDynamicItemSaveData",
                        "id": ZERO,
                    },
                    "type": "ArrayProperty",
                },
            }),
        },
        "trailer": "AAAAAA==",
    }, os.path.join(outdir, "Level.sav"))

    # Kyoshi's save carries Paldex records (deck registrations + capture
    # counts); Ren's deliberately has no RecordData at all, covering older
    # or fresh player files where the whole struct is absent.
    kyoshi_record = sp("PalLoggedinPlayerSaveDataRecordData", {
        "PaldeckUnlockFlag": namemap("BoolProperty", [
            ("SheepBall", True),
            ("PinkCat", True),
            ("Kitsunebi", True),
            ("Penguin", False),  # seen-but-false must not count as registered
        ]),
        "PalCaptureCount": namemap("IntProperty", [
            ("SheepBall", 4),
            ("PinkCat", 1),
        ]),
    })
    for uid, party, box, extra in (
        (KYOSHI, KYOSHI_PARTY, KYOSHI_BOX, {
            "RecordData": kyoshi_record,
            "InventoryInfo": inventory_info(KYOSHI_BAG, KYOSHI_KEYS, KYOSHI_ARMS),
        }),
        # Ren carries only a backpack — a player save can omit any of the
        # container fields, and the missing ones must not fail the read.
        (REN, REN_PARTY, REN_BOX, {"InventoryInfo": inventory_info(REN_BAG)}),
    ):
        write_sav({
            "header": {**HEADER, "save_game_class_name": "/Script/Pal.PalWorldPlayerSaveGame"},
            "properties": {
                "SaveData": sp("PalWorldPlayerSaveData", {
                    "PlayerUId": guid(uid),
                    "OtomoCharacterContainerId": containerid(party),
                    "PalStorageContainerId": containerid(box),
                    **extra,
                }),
            },
            "trailer": "AAAAAA==",
        }, os.path.join(outdir, "Players", uid.replace("-", "").upper() + ".sav"))

    # Kyoshi's Dimensional Pal Storage sidecar: two pals and an empty slot
    # (CharacterID "None"), which must be skipped rather than parsed.
    write_sav(storage_sav([
        storage_slot("10000000-0000-0000-0000-000000000201",
                     pal_param("Bastet", level=18, nickname="Vault Cat", hp=88)),
        storage_slot(ZERO, {"CharacterID": name("None")}),
        storage_slot("10000000-0000-0000-0000-000000000202",
                     pal_param("JetDragon", level=50, gender="EPalGenderType::Male", shot=100)),
    ]), os.path.join(outdir, "Players", KYOSHI.replace("-", "").upper() + "_dps.sav"))

    # Guild-shared storage: one pal attributed to Ren by OldOwnerPlayerUIds.
    write_sav(storage_sav([
        storage_slot("20000000-0000-0000-0000-000000000201",
                     pal_param("Umihebi", level=44, old_owner=REN)),
    ]), os.path.join(outdir, "GlobalPalStorage.sav"))


if __name__ == "__main__":
    main()
