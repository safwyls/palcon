# Console unification: the monorepo migration plan

Decision (2026-08-16): palcon, wildskeeper, flametender, and ilmari merge
into one monorepo — a shared `core/` console framework, one module per
game, and ilmari as the host-service module — instead of continuing as
four hand-synchronized repos. This document is the plan of record for
that migration.

## Why (the measured version)

The three consoles share a ~30k-line Go shared layer. palcon and
wildskeeper differ by ~2,200 diff lines; wildskeeper and flametender by
~2,800. That is 90%+ identical code, but the drift touches **85 of ~105
shared files** — thin enough that nothing is really diverged, smeared
enough that no fix travels without a manual porting pass. Concrete
casualties of the current model:

- flametender's "Fix backups, which had never once produced a file" has
  no automatic path back to palcon or wildskeeper.
- The Ilmari *client* exists twice (`internal/ilmari` in wildskeeper and
  flametender) and the two copies already differ, while the Ilmari
  *server* versions independently in its own repo.
- flametender's `internal/api/provisioner.go` still carries comments
  about "Dragonwilds sidecars" — transplant residue. Even fresh copies
  rot immediately.

The plugin seam the monorepo needs already exists and is proven:
`internal/game.Definition` + `Client`/`ExtendedClient`/`CommandProber`,
game code isolated under `internal/games/<game>/`, and `gametest`
proving the shared layer runs with no real game at all.
`docs/porting-to-another-game.md` (this repo) already states the
dependency rule; the monorepo turns that convention into structure.

## Reference implementations (who wins what)

Two source-of-truth choices, decided up front:

- **Core comes from flametender.** It has the newest shared layer: the
  revised Ilmari provisioner/companion flow, Cloudflare Access SSO,
  the cleanest agent management, and the most recent shared-layer
  fixes. Wildskeeper and palcon improvements that flametender lacks
  (notably the advisor, wildskeeper's launch/actions work) are merged
  *into* that baseline via the drift ledger — flametender is the trunk,
  not the whole tree.
- **The Palworld game module comes from palcon wholesale.** It is the
  richest game module by far — `palsave` save reading, the
  pals/inventory/achievements/storage/guilds API surface, ~1.1 MB of
  vendored game data, and the deep game UI (PalDetail, breeding, boss
  fights, player map). It sets the bar for what a game module is
  allowed to be, and it forces the one new abstraction this migration
  adds (game-contributed routes/pages — see below).

## Target layout

One repo, one Go module, npm workspaces on the web side. Proposed name:
**`safwyls/sampo`** — the artifact Ilmarinen forged; fits the naming
culture, and it's what the consoles are built from. (Placeholder until
the maintainer blesses a name; nothing below depends on it.)

```
sampo/
  go.mod                      # module github.com/safwyls/sampo
  core/                       # the console framework (today's shared internal/*)
    api/  game/  store/  db/  config/  crypto/
    agentctl/  agentfiles/  steamcmd/  backup/  sched/  notify/
    collector/  savecache/  watchdog/  advisor/  cfaccess/
    agent/                    # shared agent kit: files, jobs, diskfree, launch bones
    ilmariclient/             # the ONE Ilmari client (replaces both internal/ilmari copies)
    game/gametest/            # unchanged role: core must pass with only this
  games/
    palworld/                 # palconfig, palsave, rcon, rest, uid, fallback,
                              #   palagent supervisor, IlmariProvisioner adapter
    dragonwilds/              # dwconfig, dwlog, dwsave, client,
                              #   wkagent supervisor, adapter
    enshrouded/               # esconfig, eslog, esquery, client, banqueue,
                              #   flameagent supervisor, adapter
  ilmari/                     # the host service (host/, dockerctl/) — only module
                              #   allowed to hold a Docker socket
  cmd/
    palcon/  wildskeeper/  flametender/     # console binaries (names/brands unchanged)
    palagent/  wkagent/  flameagent/        # sidecar agents
    ilmari/
  web/                        # npm workspaces
    core/                     # shared pages, components, api lib, test kit, semantic vars
    palcon/  wildskeeper/  flametender/     # theme tokens, game pages, vendored data, entry
  tools/dwbridge/
  deploy/   docs/
```

### Structural rules (enforced, not hoped)

Import-boundary checks live in CI as tests, in the repos' own style
("interface satisfaction is a compile-time fact, not a hope"):

1. `core` never imports `games/*` or `ilmari`.
2. Game modules never import each other.
3. `ilmari` never imports `core` or `games/*` — its README's contract
   ("it does not know what a game is") becomes mechanical.
4. Nothing outside tests imports `gametest`.
5. `dockerctl` exists only under `ilmari/` — consoles lose Docker
   rights entirely, monorepo-wide, the way flametender already did.

Single Go module (not go.work multi-module): at one maintainer,
intra-repo versioning is pure tax; the boundaries above do the isolation
work. Ilmari still **deploys** independently — shared source, separate
images and cadence, so "a game's change never becomes a deploy of
ilmari" survives the merge.

### The one new abstraction: game-contributed surface

palcon's depth doesn't fit the current shape: `internal/api/pals.go`
(449 lines of pals/inventory/achievements/guilds handlers) lives in the
*shared* api package and imports `palsave` directly. Porting it as-is
would teach core about Palworld. So the `game.Definition` grows an
optional capability, same pattern as `ExtendedClient`:

- **Backend:** a game may contribute an `http.Handler` mounted under
  `/servers/{id}/game/...` (exact seam designed during Phase 5, but the
  rule is fixed now: core mounts it blind, the game owns everything
  under it).
- **Frontend:** `web/core` exposes a route/section registry; each
  console app registers its game pages (`pages/<game>/` already exists
  as a convention in wildskeeper and flametender — palcon adopts it
  during its port). Feature keys stay views, not game concepts, per the
  porting doc.

Universal surfaces — moderation, rosters, automation, logs, backups,
power, provisioning, users, public status — stay in core and are never
forked per game.

## Phases

Each phase is a PR-sized unit (or a small stack) with a verification
gate. Order matters: the consoles migrate easiest-first so the process
is debugged before it meets palcon's bulk.

### Phase 0 — Freeze and name (immediately)

- Pick the repo name; create the empty GitHub repo.
- **Core freeze** in all four repos: bug fixes allowed (each one gets a
  line in the drift ledger so it isn't lost), no new shared-layer
  features. Game-module and web-game work may continue — it ports
  wholesale anyway. The freeze race is what created this problem;
  don't reconcile a moving target.

### Phase 1 — Bootstrap with history

- `git subtree add` each of the four repos under a prefix, preserving
  full history; restructure to the target layout with ordinary `git mv`
  commits (`git log --follow` keeps blame usable).
- CI skeleton: `go test ./...`, per-console web test + build, the
  import-boundary tests (rules 1–5 above) from day one.
- **Drift ledger** (`docs/drift-ledger.md`): scripted three-way diff of
  the consoles' `internal/`, one row per differing file — winner repo,
  merge-both, or game-leak-to-relocate. This is the highest-judgment
  work in the whole migration and the input to Phase 2. The ~20
  "only in X" files are the easy rows; the ~85 modified-everywhere
  files are the real list.

### Phase 2 — Core extraction

- Copy flametender's shared layer in as `core/` baseline; apply the
  ledger row by row, pulling wildskeeper/palcon wins on top (advisor —
  newest of palcon 2026-08-08 / wildskeeper 2026-08-10 lineage — plus
  wildskeeper's launch and actions-test work, and any fix that never
  traveled).
- Promote **cfaccess to core**: SSO becomes a feature all three
  consoles get, not a flametender fork. Same for any
  currently-single-console core capability the ledger surfaces.
- Extract `core/agent`: the three sidecar agents share files.go,
  jobs.go, diskfree, appid, launch bones almost verbatim — that's the
  kit; supervisors stay per-game.
- Collapse the two `internal/ilmari` clients into `core/ilmariclient`,
  reconciled against the actual ilmari server in-repo (first payoff of
  coupling client and server).
- **Gate:** core compiles and passes its full test suite with *only*
  `gametest` registered. That is the definition of "game-agnostic".

### Phase 3 — First console port: flametender

Nearly free by construction (core *is* its shared layer): move
`games/enshrouded` (incl. banqueue), `cmd/flametender`/`flameagent`,
and its web app onto `web/core` + theme tokens.

- **Gate:** image built from the monorepo runs against the real
  Enshrouded server — provisioning via ilmari, stop/save behavior, ban
  queue, backups. The old repo then goes read-only (final commit points
  here).

### Phase 4 — Second port: wildskeeper

- `games/dragonwilds` moves over; wkagent onto `core/agent`; dwbridge
  into `tools/`.
- Its self-provisioning path becomes a Dragonwilds
  `IlmariProvisioner` adapter (it already half-lives in the Ilmari
  world — adoption/discovery shipped). Direct-Docker provisioning does
  not make the jump.
- Wildskeeper *gains* from core here: cfaccess, flametender-era fixes
  (the backup fix), the reconciled advisor.
- **Gate:** real Dragonwilds server + the TrueNAS deploy path from
  `deploy/truenas-app.yaml`, now publishing from monorepo CI to the
  *same ghcr image names* — deployed apps repoint tags, nothing else.

### Phase 5 — Third port: palcon (the big one)

- `games/palworld` wholesale; `api/pals.go` becomes the first user of
  the game-contributed-routes seam; the deep-game UI, vendored data,
  and a new `pages/palworld/` land in `web/palcon` on `web/core`.
- palcon converges on Ilmari provisioning (adapter written here;
  ilmari already runs on the shared TrueNAS host). Console-side
  `dockerctl` is deleted monorepo-wide at the end of this phase.
- palcon *gains*: cfaccess, every core fix since drift began.
- **Gate:** real Palworld server — save reading, RCON/REST paths,
  provisioning, the full pals surface.

### Phase 6 — Decommission and consolidate

- Archive the four old repos (each with a pointer commit).
- Merge the doc culture: one root CLAUDE.md (framework rules +
  dependency rules), per-module docs keep their homes
  (`games/dragonwilds/docs/recon.md` etc.), one `docs/state-of-play.md`
  for the whole system, roadmaps merged with per-game sections.
- Retire `porting-to-another-game.md` into `docs/adding-a-game.md` —
  in the monorepo it stops being a porting guide and becomes the
  fourth-game checklist, which is the entire point.

## Risks, and the rules that contain them

- **Over-abstraction** is the failure mode of every "extract the
  framework" project. Rule: core owns what gametest can exercise;
  everything needing a real game's shape sits behind the Definition or
  an optional capability interface. Never fatten the *required*
  interface for one game's feature.
- **Reconciliation errors**: a wrong "winner" call in the ledger
  silently reverts a fix. Mitigation: the ledger is reviewed as its own
  PR before Phase 2 consumes it, and each console's port gate runs
  against a real server before its old repo freezes.
- **Deploy continuity**: image names, env var names (`FLAMEAGENT_*`,
  `WKAGENT_OWNER_ID`, ...), ports, and volume layouts are all frozen
  API for this migration — running TrueNAS apps must survive on a tag
  repoint. Renames, if ever, are a separate later project.
- **The freeze slipping**: every mid-migration fix in an old repo must
  land as a ledger row the same day, or it dies in the archive.

## Sequencing summary

| Phase | What | Size |
|---|---|---|
| 0 | Name, repo, core freeze | hours |
| 1 | History import, CI, drift ledger | 1 PR + the ledger (the judgment work) |
| 2 | Core from flametender + ledger, cfaccess/advisor/agent-kit/ilmariclient | the big one; a small PR stack |
| 3 | Flametender port + real-server gate | small |
| 4 | Wildskeeper port, Ilmari adapter, TrueNAS gate | medium |
| 5 | palcon port, game-routes seam, docker retirement | large |
| 6 | Archive, docs consolidation | small |

Phases 3–5 each end with a working, deployed console, so the migration
is abortable after any phase without leaving anything broken — the
worst case at every point is "some consoles already live in the
monorepo, the rest still work where they are."
