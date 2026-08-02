# Visibility — turning views off, and hiding individual players

Palcon shows a lot about the people on a server: every pal they own with its
IVs, what's in their bags, where they logged off. Some communities are fine
with that and some aren't, so it's switchable — per server, and per player.

Set both under **Settings → Who can see what** (admin only).

## Two switches

**A feature** is a view an admin can turn off for a whole server: Live map,
Player pals, Inventory, Storage, Paldex, Guilds, Calculators. Turning one off
drops its link from the nav and makes the endpoints behind it refuse with 403.

**A stream** is one player opting out of one kind of data: `pals`, `inventory`
or `map`. The view stays on for everyone else; that player is filtered out of
the payload.

## Password-locked chests

A player can put a password on a chest in-game. **Search password-locked
chests**, beside the view switches, decides whether the Storage view indexes
those at all — off, their contents never reach the browser, on any request.

It is the one switch on this page admins do *not* bypass. A switch that says
"don't search these" and then shows them to the person who set it reads as
broken; the escape hatch is the same as everywhere else, in that only an admin
can turn it back on. Readers also get their own "Exclude locked chests"
checkbox in the view, which is a filter on what the server already sent — the
admin switch is the one that decides what gets sent.

`TestStorageForWithholdsPrivateChests` pins the server side. The password
itself is never read out of the save; the extractor reads only whether one is
set (see `read_map_object_containers`).

## Admins bypass both

A hidden view still appears in an admin's nav, marked with a struck-through
eye, and still serves them data. A hidden player is still listed for them.

This is deliberate: the feature exists so a server owner can honour a privacy
request without also blinding themselves for moderation, and an admin is the
only one who can turn a view back on — a switch that hid itself from the person
holding it would be a trap. An owner who wants the strict version turns the
view off and leaves it off; nobody else can reach it.

## Why streams are coarser than views

Three views — Player pals, Paldex and Calculators — all read one payload,
`GET /servers/{id}/pals`. So there is exactly one per-player `pals` switch
covering all three, and the shared endpoint keeps answering while *any* of the
three is on.

Offering a per-view player switch would have meant hiding someone from the
Paldex page while the Calculators page served the same bytes to the same user:
a checkbox that changes what a page draws but not what the browser can fetch.
The `/guilds` payload is shared the same way — the live map reads it for
offline positions and base coordinates — so it answers while either Guilds or
Live map is on.

## What each hide actually does

| Hide | Effect |
| --- | --- |
| Feature off | Every endpoint that *only* that view uses returns 403; the nav link goes |
| Player, `pals` | Dropped from `/pals` and from `/guilds` — and so from their guild's pal, alpha and dex rollups |
| Player, `inventory` | Dropped from `/inventory` |
| — | No stream covers `/storage`: a chest belongs to a base camp, not to whoever placed it, and the payload carries no player uid to filter on |
| Locked chests off | Password-locked chests are dropped from `/storage` for everyone, admins included |
| — | The guild chest rides on the Storage view's own switch; it belongs to a guild rather than a player, so no per-player stream covers it either |
| Player, `map` | Last-known position blanked in `/guilds`; live coordinates blanked in `/players`. They keep their guild standing and still appear in the online count |

`/pals` and `/guilds` serve an explicit projection (`api.palsPlayer`), not
`palsave.PlayerPals` itself. That matters: PlayerPals is the *extractor's*
struct, and for a while everything added to it appeared on both endpoints for
free — which is how bags and character sheets ended up on an endpoint the
Inventory switches don't govern, gated view and all. `TestPalsPayloadFields`
fails if the projection grows a field, so adding one is a decision rather than
a side effect.

## World loot is a request, not a filter

The Storage view searches base storage by default. The world's own treasure
chests — several thousand of them, and most of the payload — only come back
when the page asks with `?world=1`, which the "Include world loot" checkbox
does. Filtering them out in the browser would have been simpler and would have
meant every visit shipping the location of every unopened chest on the server
to anyone who opened the page. `TestStorageForWithholdsWorldLoot` pins it.

Marking the fields `json:"-"` would not have worked: the same struct is
unmarshalled *from* the extractor's output, so hiding a field from the response
hides it from the parse.

Turning the Live map off blanks live coordinates for everyone in `/players`
without gating the endpoint, because the dashboard's online list reads it too —
a name and a level aren't the private part.

## How the switches are stored

`servers.hidden_features` and the `player_visibility` table both record what is
*hidden*, so the empty default means "everything visible" and no existing
server changes behaviour when the migration runs. A player with nothing hidden
has no row at all.

Unknown keys are dropped on write (`store.encodeKeys`), so a renamed or
retired feature can't survive in the database as a hide nothing in the UI can
see and nothing can therefore undo.

## Adding a new view to the list

1. Add the key to `store.AllFeatures` and the `Feature` union in `web/src/lib/api.ts`.
2. Give it a label and a blurb in `web/src/lib/visibility.ts`.
3. Add it to `SAVE_VIEWS` in `ServerSubNav.tsx` and `MobileChrome.tsx`.
4. Wrap its route in `<FeatureGate feature="...">`.
5. Pass the key to `readSaveForRequest` in whichever handler serves it.

Steps 1–4 only affect the menu. **Step 5 is the one that makes it private** —
without it the view disappears from the nav while its data stays a URL away.

Activity (the playtime board) is deliberately *not* in the list yet; it's one
entry away if you want it, and arguably belongs there.
