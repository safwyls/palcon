# Porting palcon to another game

Palcon is split into a game-agnostic core and one package per game. Roughly
two thirds of the codebase — auth, users and permissions, the audit trail,
metrics collection and charting, scheduled restarts, the crash watchdog,
Discord notifications, backups, SteamCMD repair and update, Docker control,
the sidecar agent, the PWA shell, the public status page — never learns which
game it is managing.

This document is the contract: what a new game has to provide, and what it
gets for free.

A note on intent before the details: the expected way to reuse this work is
a **sibling project that lifts or copies the generic packages** — `rcon`,
`rcontest`, `savecache`, `steamcmd`, the generic halves of `palagent` and
`agentctl` — not a second game registered inside this binary (Go's
`internal/` rule means a separate module can't import them in place anyway).
The registry below is deliberately frozen at what palcon itself consumes:
feature gating, client construction, and game-port normalization. Resist
growing `Definition` ahead of a reader — a field nothing consults is a
promise nothing keeps.

## The dependency rule

```
internal/api, collector, sched, watchdog, backup, notify, store
        │  depend on
        ▼
internal/game            ← contracts only: Client, Metrics, Definition, registry
        ▲
        │  implemented by
internal/games/<game>/   ← everything that knows the game
```

Shared packages import `internal/game`. They never import
`internal/games/<game>`. If you find yourself wanting to, the thing you need
belongs on `game.Definition` instead.

The one deliberate exception is `internal/api`'s save-derived views
(`pals.go`) — see [What is still Palworld-shaped](#what-is-still-palworld-shaped).

## What you have to write

### 1. A client — `game.Client`

Eight methods: `Info`, `Players`, `Broadcast`, `Kick`, `Ban`, `Unban`, `Save`,
`Shutdown`. This is the intersection of what the Source-derived dedicated
server population offers, and it is remarkably stable across games.

If the game speaks Source RCON — ARK, Conan Exiles, 7 Days to Die, Minecraft,
Project Zomboid and most of the rest do — you do **not** write any wire
protocol. `internal/rcon` handles framing, auth, the empty pre-auth packet
some servers send, and the dropped-reply-after-kick behaviour several games
have. You write only the command vocabulary:

```go
func (c *RCONClient) Save(ctx context.Context) error {
    _, err := c.conn().Exec(ctx, "SaveWorld")  // ARK's spelling
    return err
}
```

Compare [`internal/games/palworld/rcon.go`](../internal/games/palworld/rcon.go),
which is now nothing but vocabulary.

If the game also has an HTTP admin API (Palworld's REST, Satisfactory's
HTTPS API), implement `game.ExtendedClient` for `Settings` and `Metrics`, and
wrap the two transports the way
[`fallback.go`](../internal/games/palworld/fallback.go) does. Nothing requires
it: a plain RCON client is a complete implementation, and the shared layer
type-asserts for the extras and degrades when they are absent.

### 2. A definition — `game.Definition`

One value describing the game, registered from an `init`:

```go
var Definition = &game.Definition{
    ID:              "ark",
    Name:            "ARK: Survival Ascended",
    DefaultGamePort: 7777,
    NewClient:       New,
    CanonicalUID:    CanonicalUID,
    Features:        []string{game.FeatureMap, game.FeaturePals, ...},
}

func init() { game.Register(Definition) }
```

Then add one line to [`internal/games/games.go`](../internal/games/games.go).
That is the entire wiring; the blank import there is what populates the
registry for the binary.

`CanonicalUID` deserves attention. Games spell the same player id differently
depending on which transport reported it, and save files use a third spelling.
Getting it wrong does not error — the id simply never matches, which for a
visibility check means **failing open**. Palworld's is in
[`uid.go`](../internal/games/palworld/uid.go).

### 3. A save reader (optional)

Only if you want the save-derived views. You implement `savecache.Source`:

```go
type Source[T any] interface {
    Locate(savePath string) (string, error)
    Parse(ctx context.Context, file string, modTime time.Time) (*T, error)
}
```

`Locate` says which file's mtime decides freshness; `Parse` turns it into your
own result type. Everything else — reusing a parse until the mtime moves,
serializing extractions so two worlds are never in memory at once,
stale-while-revalidate so a page load never blocks on the parser, the settle
window that stops a half-written save being read — is
[`internal/savecache`](../internal/savecache/savecache.go) and you get it free.

Palworld shells out to Python because the community GVAS tooling lives there.
Nothing requires that: Conan Exiles and Project Zomboid keep their saves in
SQLite, so `Parse` would just be a query.

### 4. Frontend labels

Add a `GameProfile` to [`web/src/lib/games.ts`](../web/src/lib/games.ts) with
the labels and blurbs for the feature keys your game offers. The nav, the
route gate and the visibility settings all read from the server's `features`
list, which the API derives from your `Definition` — so a game without a
creature collection has no Paldex link, no `/paldex` route and no switch for
it, without a single conditional in a component.

Route segments stay the same across games (they're part of the URL contract);
only the words change.

## What you get for free

| Concern | Package |
|---|---|
| Source RCON wire protocol, plus a fake server for tests | `internal/rcon`, `internal/rcon/rcontest` |
| Save parse caching, single-flight, stale-serve, settle window | `internal/savecache` |
| SteamCMD update args + cache repair (app id is a parameter) | `internal/steamcmd` |
| Metrics sampling, retention, pruning, charts | `internal/collector`, `internal/store` |
| Player join/leave events, playtime sessions, last-seen | `internal/collector` |
| Scheduled restarts with in-game warnings | `internal/sched` |
| Crash watchdog | `internal/watchdog` |
| Discord notifications | `internal/notify` |
| Backup schedule + archives | `internal/backup` |
| Docker power control and provisioning | `internal/dockerctl` |
| Remote file/process access next to the game server | `internal/palagent`, `internal/agentctl` |
| Auth, users, permissions, audit trail, per-view visibility | `internal/api`, `internal/store` |

## Feature keys are views, not game concepts

`FeaturePals`, `FeatureGuilds`, `FeaturePaldex` name *dashboard views*. A
second game reuses the ones that fit rather than inventing synonyms — ARK's
tames are Pals, its tribes are Guilds, its dino dex is Paldex — and renames
them in its `GameProfile`. That keeps one set of routes, one visibility
schema, and one set of stored switches.

`game.AllFeatures()` (the validation set for stored switches) deliberately
returns the full canonical list rather than only what is registered: keeping a
key no game offers costs nothing, while dropping one silently erases a switch
an admin set.

## What is still Palworld-shaped

Being honest about the remaining coupling, because the seams above are only
worth having if the map is accurate:

- **`internal/api/pals.go`** serves the save-derived views (pals, inventory,
  storage, paldex, achievements) in terms of `palsave` types. These are domain
  endpoints, not shared infrastructure — a second game with a save reader
  would add its own alongside, and route registration would move behind the
  definition. Splitting it before there is a second consumer would be
  guesswork.
- **`web/src/data/` and most of `web/src/pages/`** are Palworld domain views —
  breeding maths, the paldex, the map. These are meant to be *replaced* per
  game, not shared. The shared frontend is the shell: `AppShell`, `ServerRail`,
  auth, the API client, `ui/`, `MetricChart`, `ServerPower`, `ServerSettings`,
  the log dialogs, `PublicStatus`, `Users`.
- **`internal/palagent`** is a Palworld supervisor: it knows how to launch
  `PalServer.sh` and write `PalWorldSettings.ini`. The file/process/SteamCMD
  half is generic; the launch half is not.
- **`internal/games/palworld/palconfig`** parses Palworld's one-line
  `OptionSettings=(…)` format. The *policy* around it is reusable and worth
  copying — never add or remove keys, validate each new value against the
  existing type, keep one `.bak`, swap atomically — but the parser is not.

## Checklist

1. `internal/games/<game>/` — client implementing `game.Client`
2. `var Definition = &game.Definition{…}` + `func init() { game.Register(Definition) }`
3. One line in `internal/games/games.go`
4. Optional: `savecache.Source` for save reading
5. Optional: `GameProfile` in `web/src/lib/games.ts`
6. Servers get `game = '<id>'` on their row (migration `0019_game.sql` added the column, defaulting to `palworld`)
