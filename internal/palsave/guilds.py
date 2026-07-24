"""Decode guild (GroupSaveDataMap) records out of a Palworld Level.sav.

palworld-save-tools ships a decoder for this, but it reads the blob as a
rigid sequence of fields and asserts it lands exactly on EOF. Newer saves
insert fields mid-record and append trailing data, so it fails outright
("could not read 16 bytes for uuid") — the same class of breakage that
affected character records.

Only the leading fields have stayed put across versions, so this reads
those positionally and then locates the member list *structurally*, by the
shape of its records, rather than trusting a byte offset that the next
patch may move again.
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


def _scan_members(buf, start):
    """Find the member list: [guid][i64][name] repeated.

    Scanned rather than read at a fixed offset because the number of bytes
    between the guild name and this list has changed between game versions.

    The i64 here is not a wall-clock time — it reads as roughly a week in
    ticks, i.e. elapsed world time rather than a date — so it isn't
    validated or surfaced. Real "last seen" comes from Players/<uid>.sav,
    which stores a genuine FDateTime. Validation therefore rests on the
    name: a correctly length-prefixed, null-terminated, printable string is
    unlikely to appear by chance 24 bytes into unrelated data, and a false
    match would have to repeat to beat a real run.
    """
    best = []
    off = start
    while off + 28 <= len(buf):
        probe = off
        found = []
        while probe + 28 <= len(buf):
            nxt = _read_string(buf, probe + 24, max_len=64)
            if nxt is None:
                break
            name, after = nxt
            found.append({"uid": str(_guid(buf, probe)), "name": name})
            probe = after
        if len(found) > len(best):
            best = found
        off += 1
    return best


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

        member_count = _u32(buf, pos)
        pos += 4
        # Each handle is two GUIDs (player uid + character instance id).
        pos += member_count * 32
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

    # From here the layout shifts between versions, so find things by shape.
    name_hit = None
    probe = pos
    while probe < len(buf) and name_hit is None:
        got = _read_string(buf, probe, max_len=64)
        if got:
            name_hit = got
            break
        probe += 1
    guild_name = name_hit[0] if name_hit else ""
    members = _scan_members(buf, name_hit[1] if name_hit else pos)

    return {
        "id": str(group_id),
        "name": guild_name,
        "baseCampLevel": base_camp_level,
        "baseIds": base_ids,
        "members": members,
        "memberCount": len(members),
    }
