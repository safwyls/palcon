"""Decode guild (GroupSaveDataMap) records out of a Palworld Level.sav.

palworld-save-tools ships a decoder for this, but it reads the blob as a
rigid sequence of fields and asserts it lands exactly on EOF. Newer saves
insert fields mid-record and append trailing data, so it fails outright
("could not read 16 bytes for uuid") — the same class of breakage that
affected character records.

Only the leading fields have stayed put across versions, so membership is
taken from individual_character_handle_ids, which sits before everything
that shifts: one entry per character in the guild, with a non-zero player
uid for players and a zero one for pals. Those uids match the ones in
Players/<uid>.sav, so names resolve from data we already read.

The guild's own name still lives past the shifting region and is found by
shape rather than offset.
"""

import string

PRINTABLE = set(string.printable) - set("\x0b\x0c")


def _u32(buf, off):
    return int.from_bytes(buf[off : off + 4], "little")


def _read_string(buf, off, max_len=128):
    """Read a length-prefixed UTF-8 string, or None if it isn't one.

    Palworld strings are a little-endian length (including the trailing
    null) followed by the bytes. A negative length marks UTF-16, which
    guild and player names in practice aren't.
    """
    if off + 4 > len(buf):
        return None
    n = _u32(buf, off)
    if n < 2 or n > max_len or off + 4 + n > len(buf):
        return None
    body = buf[off + 4 : off + 4 + n]
    if body[-1] != 0:
        return None
    try:
        text = body[:-1].decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not text or any(c not in PRINTABLE for c in text):
        return None
    return text, off + 4 + n


def _scan_names(buf, start):
    """Collect player names the guild record carries after its own name.

    Only a fallback: names normally come from the player saves, keyed by
    uid. This covers anyone missing from there — and unlike membership,
    getting a name wrong costs a label, not a member.

    Deliberately not tied to record boundaries. This previously walked
    [guid][i64][name] contiguously and found exactly one member on a real
    save: newer formats pad between records, so the second read landed on
    padding and the loop stopped. Membership no longer depends on it.
    """
    names = []
    off = start
    while off < len(buf):
        got = _read_string(buf, off, max_len=64)
        if got:
            name, after = got
            names.append(name)
            off = after
            continue
        off += 1
    return names


def _guid(buf, off):
    # palworld-save-tools' UUID, not the stdlib one: Palworld stores GUID
    # bytes in a shuffled order, so the stdlib rendering of the same 16
    # bytes gives a different string and ids silently fail to match.
    from palworld_save_tools.archive import UUID

    return UUID(bytes(buf[off : off + 16]))


def decode_guild(raw):
    """Return a guild dict, or None if the blob doesn't look like one."""
    buf = bytes(raw)
    pos = 0

    # These leading fields have been stable across versions.
    try:
        group_id = _guid(buf, pos)
        pos += 16
        got = _read_string(buf, pos, max_len=128)
        if got is None:
            return None
        _admin_key, pos = got

        # individual_character_handle_ids: one entry per character in the
        # guild, each two GUIDs (owning player uid, then character instance
        # id). A pal's owner uid is all zeroes, so the non-zero ones are
        # exactly the member list — and this sits ahead of every field the
        # newer format moves around.
        handle_count = _u32(buf, pos)
        pos += 4
        member_uids = []
        for i in range(handle_count):
            raw_uid = buf[pos + i * 32 : pos + i * 32 + 16]
            if len(raw_uid) == 16 and any(raw_uid):
                member_uids.append(str(_guid(buf, pos + i * 32)))
        pos += handle_count * 32
        if pos > len(buf):
            return None

        pos += 1  # org_type
        base_id_count = _u32(buf, pos)
        pos += 4
        base_ids = [str(_guid(buf, pos + i * 16)) for i in range(base_id_count)]
        pos += base_id_count * 16
        base_camp_level = _u32(buf, pos)
        pos += 4
    except Exception:
        return None

    # From here the layout shifts between versions, so find the guild's own
    # name by shape rather than offset.
    name_hit = None
    probe = pos
    while probe < len(buf) and name_hit is None:
        got = _read_string(buf, probe, max_len=64)
        if got:
            name_hit = got
            break
        probe += 1

    return {
        "id": str(group_id),
        "name": name_hit[0] if name_hit else "",
        "baseCampLevel": base_camp_level,
        "baseIds": base_ids,
        "memberUids": member_uids,
        # Names in record order, used only to label uids the player saves
        # don't cover.
        "spareNames": _scan_names(buf, name_hit[1] if name_hit else pos),
    }
