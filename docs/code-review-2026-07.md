# Code review: full repository — July 2026

A complete pass over every source file in the repo (Go backend, Python save
extractors, React frontend, migrations, Dockerfile/compose/CI), written so each
finding can be handed to a separate agent as a self-contained task.

Supersedes [code-review.md](code-review.md) (the v0.1 scaffold review — it
references files that no longer exist; kept for history).

> **Paths have moved since this was written.** The game-specific packages were
> split out from the shared core: `internal/palworld` → `internal/games/palworld`,
> `internal/palsave` → `internal/games/palworld/palsave`, `internal/palconfig` →
> `internal/games/palworld/palconfig`, `internal/steamops` → `internal/steamcmd`,
> and the RCON wire protocol moved to `internal/rcon`. The findings still stand;
> the links point at the old layout. See
> [porting-to-another-game.md](porting-to-another-game.md).

## How to use this doc for delegation

Each finding has a **task ID** (`T1`, `T2`, …), a **priority**, the **files
involved**, and enough context that an agent needs nothing else to start.
Suggested batching is at the bottom. Priorities:

- **P1** — real defect or gap worth fixing soon.
- **P2** — worthwhile improvement; user-visible or robustness.
- **P3** — polish, hygiene, or "decide and document".

## Verified baseline (2026-07-24, branch `effective-stats-souls-trust`)

All checked locally as part of this review — findings below are on top of a
green build, not instead of one:

- `go build ./...` — clean
- `go vet ./...` — clean
- `go test ./...` — **pass** (`internal/palconfig`, `internal/palsave` incl.
  the synthetic Level.sav fixtures; all other packages have no tests — see T20)
- `cd web && tsc --noEmit` — clean
- Repo hygiene is good: `localsaves/` (real saves with player IDs), `data/`
  (runtime dir), `__pycache__`, map textures are all gitignored and none are
  committed. The committed test fixtures are synthetic.

One external fact checked during review: the Palworld REST
`GET /v1/api/settings` response **does not** include `AdminPassword` /
`ServerPassword` (confirmed against docs.palworldgame.com). So the ungated
`GET /api/servers/{id}/settings` proxy is safe, and the asymmetry with the
permission-gated `/config` ini editor (which *does* expose passwords) is
intentional and correct. Don't "fix" that asymmetry.

## Status (2026-07-24, same day)

Implemented on `effective-stats-souls-trust`, in severity order:

- **All P1s** — T1, T2, T20 (new `internal/api` httptest suite), T23, T31
  (plus a `.dockerignore`).
- **All P2s except T22** — T3, T4 (with a shared `writeServerLoadError`
  helper), T5, T8, T9, T12, T13, T14 (the deadline check; multi-packet
  reads stay "verify live first"), T21 (store / RCON-framing / dockerctl
  suites), T24, T25, T26, T32 (Go 1.26 across go.mod/Dockerfile/CI).
- **All P3s** — T6 (shared `lib/time.ts`), T7 (soul cap 20 in the form),
  T10 (`COOKIE_SECURE` + 1 MB body cap), T11 (documented in auth.go: keep
  the distinct 403), T15, T16, T17 (8-entry cache cap), T18, T19 (comment
  in 0001), T27, T28, T29 (merge + banner instead of silent reset), T30
  ([vendored-game-data.md](vendored-game-data.md)), T33 (Go deps to
  current; npm in-range only — see below), T34, T35/T36.

Deliberately still open:

- **T22 — live-server validation.** Needs a real Palworld dedicated
  server; the RCON/REST layer remains "written from docs" until then.
  Includes T14's multi-packet question.
- **npm majors** (T33 remainder): React 19, Vite 8, Tailwind 4,
  react-router 7, TS 6+. `npm audit` reports 4 advisories (1 high) fixed
  only in react-router 7 — the high one is SSR-hydration-only and doesn't
  apply to this client-rendered SPA, and the open-redirect needs
  user-controlled link paths, which we don't build. Low practical risk;
  schedule the router-7 migration as its own PR.

---

## A. Correctness bugs

### T1 (P1) — `handleUpdateUser` commits role/permission changes before validating the password
[internal/api/users.go:144-162](../internal/api/users.go#L144-L162)

The handler calls `store.UpdateUser` (role, permissions, disabled) **first**,
then validates the new password's length. If an admin edits a user, changes the
role *and* types a 5-character password, the request returns
`400 password must be at least 8 characters` — but the role/permission/disabled
change has already been written. The client (Users.tsx) shows an error toast,
so the admin reasonably believes nothing was saved.

**Fix:** hoist the `len(req.Password) < minPasswordLength` check (when
`req.Password != ""`) above the `UpdateUser` call so the request is
validate-then-write. **Acceptance:** an update with a short password changes
nothing; a test covering this (see T20) would be ideal.

### T2 (P1) — `handleUpdateServer` response misreports `hasRconPassword`/`hasRestPassword`
[internal/api/servers.go:130-141](../internal/api/servers.go#L130-L141)

On update, blank passwords mean "keep the existing one" (store layer handles
this correctly). But the response DTO is built from the *request* struct, so
after any edit that doesn't resend passwords, the API answers with
`hasRconPassword: false` even though a password is still stored. The current
UI recovers because `ServerFormDialog` invalidates and refetches, but any
other API consumer gets wrong data.

**Fix:** re-`GetServer` after the update and build the DTO from the stored row
(mirrors what `handleUpdateUser` already does). **Acceptance:** `PUT` with
blank passwords returns `hasRconPassword: true` when one is stored.

### T3 (P2) — Stale footnote: pal detail says trust is *not* included, but it now is
[web/src/components/PalDetailDialog.tsx:176-178](../web/src/components/PalDetailDialog.tsx#L176-L178)

Commit `b95f6a7` wired trust into `palEffectiveStats`
([stats.ts:145-161](../web/src/lib/stats.ts#L145-L161)), but the dialog still
says "trust isn't included." One-line copy fix; keep it consistent with the
Calculators page's wording ("Trust is the one estimate…").

### T4 (P2) — `withClient` reports real DB errors as `400 invalid server id`
[internal/api/actions.go:31-46](../internal/api/actions.go#L31-L46)

`clientForServerID` can fail three ways: non-numeric id (genuinely a 400), row
not found (handled as 404), or an actual store/DB error — which currently also
comes back as `400 invalid server id`. Carried over from the v0.1 review;
still present. **Fix:** distinguish the parse error from other errors and
return 500 for the latter. Same pattern exists in
`handleServerInfo`/`handleServerPlayers`/`handleServerSettings`/`handleServerMetrics`
(any `clientForServerID` error → 404 "server not found") — while in there,
consider routing them all through one helper (see T24).

### T5 (P2) — `palconfig` type inference traps hand-edited float settings
[internal/palconfig/palconfig.go:276-293](../internal/palconfig/palconfig.go#L276-L293)

`classify` types a value by how it's written: `2` → int, `2.000000` → float.
If someone hand-edited the ini to `ExpRate=2`, the editor now treats ExpRate
as an **int** and `format` rejects `2.5` with "not an integer" — the user
cannot re-widen the type from the UI. The game itself always writes `%.6f`,
so this only bites hand-edited files, but that's exactly the audience of a
settings editor. **Fix option:** accept a float-shaped value for an
int-classified key by promoting the written form (or classify against a small
vendored key→type table for the known ~90 keys, falling back to inference).
**Acceptance:** a file containing `ExpRate=2` accepts `2.5` and writes
`2.500000`.

### T6 (P3) — `agoLabel` caps at hours
[web/src/pages/ServerPlayers.tsx:386-391](../web/src/pages/ServerPlayers.tsx#L386-L391)

A save parsed 3 days ago reads "72h ago". Add a `d` tier (the sibling
`lastSeenLabel` in ServerGuilds.tsx already does this — consider sharing one
helper).

### T7 (P3) — Soul rank ceilings disagree (10 vs 20)
[web/src/lib/stats.ts:83](../web/src/lib/stats.ts#L83) clamps soul ranks at
**20** (+3% each); the Calculators form caps the soul inputs at **10**
([ServerCalculators.tsx:490-492](../web/src/pages/ServerCalculators.tsx#L490-L492)),
and `SavePal.trust` documents 0–10. Verify the current in-game maximums
(souls went to 20 with Large Pal Souls; trust rank max 10) and make the form,
the clamp, and the doc comments agree.

---

## B. Security hardening

Context that shapes priority here: self-hosted LAN tool, cookie is `HttpOnly`
+ `SameSite=Lax`, all state-changing routes are POST/PUT/DELETE (so Lax
covers CSRF), passwords encrypted at rest, docker socket reached only through
a scoped proxy. The basics are right; these are belt-and-suspenders items.

### T8 (P2) — No rate limiting or lockout on `/api/login`
[internal/api/auth.go:51-89](../internal/api/auth.go#L51-L89)

bcrypt makes each attempt ~100ms, but there is zero friction against a
scripted credential-stuffing run if the instance is ever exposed beyond the
LAN. Carried over from the v0.1 review. **Fix:** small in-memory limiter
(per-IP + per-username token bucket, e.g. 10 attempts/min) in a middleware on
the login route only. No external deps needed. **Acceptance:** the 11th rapid
attempt gets `429`; successful login resets the counter; behavior covered by
a handler test.

### T9 (P2) — JWT parsing doesn't pin the signing algorithm
[internal/api/auth.go:40-49](../internal/api/auth.go#L40-L49)

`jwt.ParseWithClaims` accepts whatever `alg` the token declares. With an HMAC
`[]byte` key golang-jwt v5 will fail RSA/none tokens anyway, so this isn't
exploitable today — but pinning is the standard defense-in-depth:
`jwt.WithValidMethods([]string{"HS256"})` as a parser option. One line.

### T10 (P3) — Session cookie never sets `Secure`; no request body size limits
[internal/api/auth.go:80-87](../internal/api/auth.go#L80-L87),
[internal/api/server.go:36-44](../internal/api/server.go#L36-L44)

Two small hardening items: (a) add an env-driven `COOKIE_SECURE=true` (or
auto-detect `X-Forwarded-Proto`) for deployments behind TLS; default off so
plain-HTTP LAN keeps working. (b) wrap the API router in
`http.MaxBytesReader` middleware (e.g. 1 MB) so `json.Decode` on any endpoint
can't be fed an arbitrarily large body.

### T11 (P3) — Login responses distinguish "bad credentials" from "account disabled"
[internal/api/auth.go:61-73](../internal/api/auth.go#L61-L73)

The 403 "account disabled" (and the bcrypt-only-when-user-exists timing)
confirms a username exists. For a LAN admin tool this is acceptable — decide
deliberately and either fold disabled into the generic 401 or document the
choice here and move on.

---

## C. Backend robustness

### T12 (P2) — `palsave.Reader` serializes *cache hits* behind in-flight parses
[internal/palsave/palsave.go:183-209](../internal/palsave/palsave.go#L183-L209)

One mutex guards both the cache map and the whole extraction. Serializing
parses is deliberate (memory), but a request for **server A's cached** result
also blocks for up to ~2 minutes while **server B's** save is parsing. With
one configured server this never matters; with several it makes the pals/map
pages stall for the wrong server. **Fix:** short critical section for the
cache lookup + a per-path (or single) parse lock — check cache, then acquire
parse lock, then re-check cache before running the extractor. **Acceptance:**
a cached read returns immediately while another path's parse is running
(testable with a stub script).

### T13 (P2) — Unreachable-server requests pay REST timeout + RCON timeout back-to-back
[internal/palworld/fallback.go](../internal/palworld/fallback.go),
[internal/palworld/rest.go:23-28](../internal/palworld/rest.go#L23-L28),
[internal/palworld/rcon.go:30-35](../internal/palworld/rcon.go#L30-L35)

With `PreferREST`, every call on an offline server waits 10s (REST HTTP
timeout) + up to 10s (RCON dial) before failing — so dashboards/sub-nav show
"checking…" for up to 20s per server. Also, the fallback masks *why* REST
failed (a wrong REST password surfaces as an RCON error). Options, smallest
first: shorten timeouts (3–5s dial for probes), only fall back on
connection-type errors (not auth failures — an HTTP 401 from REST should be
reported, not retried over RCON), and/or wrap errors so both attempts' causes
are visible (`errors.Join`). **Acceptance:** wrong REST password produces an
error message that mentions REST auth; probing a dead host fails in ≤10s
total.

### T14 (P2) — RCON client: single-packet responses, unchecked deadline
[internal/palworld/rcon.go:73-117](../internal/palworld/rcon.go#L73-L117)

Carried over, still true: `readPacket` reads exactly one packet per command,
so a very long `ShowPlayers` response could silently truncate (Source RCON
splits big responses). Palworld responses are typically small; verify against
a full real server before investing in multi-packet handling. Minor: the
`conn.SetDeadline` error result is ignored. Low urgency; mostly "test against
a live busy server" (see T22).

### T15 (P3) — `prepareForStop` and docker actions run on the request context
[internal/api/power.go:63-87](../internal/api/power.go#L63-L87),
[internal/api/power.go:118-131](../internal/api/power.go#L118-L131)

Save-world → in-game shutdown → `docker stop` all derive from `r.Context()`.
If the browser tab closes or the connection drops right after clicking Stop,
the context cancels and the graceful-stop sequence dies midway (the container
may then be left running, or stopped without the world save). Since the
action is deliberate and short, detach it: `context.WithoutCancel(r.Context())`
plus the existing timeouts. **Acceptance:** killing the HTTP client mid-stop
still completes save + stop (verifiable in a handler test with a slow fake
docker server).

### T16 (P3) — Collector sweeps servers serially against a 30s tick
[internal/collector/collector.go:63-75](../internal/collector/collector.go#L63-L75)

Each enabled server gets up to 10s; four filtered/unreachable REST servers
make one sweep 40s and ticks get dropped (Go tickers coalesce, so no pile-up
— but sampling cadence degrades for everyone). Parallelize the per-server
samples (bounded `errgroup` or plain goroutines + WaitGroup; the `unreachable`
map then needs a mutex or channel). Only worth it if multi-server is the real
deployment; note it and defer otherwise.

### T17 (P3) — `palsave.Reader` cache never evicts
[internal/palsave/palsave.go:188-208](../internal/palsave/palsave.go#L188-L208)

Entries are keyed by save path and live forever (one whole parsed world each,
which can be tens of MB as JSON-decoded structs). Deleting a server or
changing its save path strands the old entry. Trivial fix: cap entries or
drop entries whose path no longer belongs to any server. Low urgency.

### T18 (P3) — `config.Load` accepts any-length `JWT_SECRET`
[internal/config/config.go:54-58](../internal/config/config.go#L54-L58)

`ENCRYPTION_KEY` is checked (exactly 32 bytes) but a 1-character `JWT_SECRET`
is accepted. Add `len < 32 → error` (the .env.example already tells people to
generate 32+ hex chars). Carried over from v0.1 review.

### T19 (P3) — Unused phase 2–4 schema: decide keep-or-drop
[internal/db/migrations/0001_init.sql](../internal/db/migrations/0001_init.sql)

`scheduled_tasks`, `player_sessions`, `notification_rules`, `event_log` are
created and never touched by any code (the planned phases 2–4 features were
never built; metrics went a different route in 0003). Harmless, but every
future reader has to rediscover that they're dead. Either add a migration
dropping them, or a comment in the migration/README stating they're reserved
for the roadmap. Decision task, not a code task.

---

## D. Test coverage (the largest single gap)

### T20 (P1) — No tests for the API layer (auth, permissions, admin guards)
`internal/api/` has zero tests, and it contains the logic most worth locking
in — all testable with `httptest` + an in-memory sqlite store (`db.Open` with
a temp file already works; `modernc.org/sqlite` is pure Go):

- login / wrong password / disabled account / session cookie round-trip
- `requireAuth` re-reads the user (permission revocation applies immediately)
- `requirePermission` and `requireAdmin` on representative routes
- last-admin guards: cannot demote/disable/delete the only admin
- self-deletion blocked; duplicate username → 409
- T1's fix (short password changes nothing)
- unmatched `/api/*` → JSON 404 (regression from the v0.1 fix)

### T21 (P2) — No tests for `store`, `palworld` framing, or `dockerctl`
- `internal/store`: CRUD round-trip with encryption, `UpdateServer` blank-password
  preservation, permission encode/decode.
- `internal/palworld`: RCON `writePacket`/`readPacket` are pure and easy to
  test against a `net.Pipe`/loopback fake server (auth failure id=-1, empty
  pre-auth packet skip, `ShowPlayers` parsing incl. header row and short rows).
- `internal/dockerctl`: `httptest.Server` faking the Engine API — 403 → the
  helpful proxy message, 304 treated as success, stop timeout > grace.

### T22 (P2) — Live-server validation pass
The one thing no unit test covers: run the whole stack against a real
Palworld dedicated server (REST + RCON) and confirm: RCON `Broadcast`
underscore substitution, kick/ban id formats over both transports, `Info`
parsing of the real welcome string, a large `ShowPlayers` response (T14), and
REST field names. The transport layer remains "probably right" until this
happens — it was written from docs, not observed traffic (per the v0.1
review, and nothing since has changed that).

### T23 (P1) — CI never runs the Go tests
[.github/workflows/docker.yml:20-46](../.github/workflows/docker.yml#L20-L46)

The `verify` job runs `go build` + `go vet` + frontend build but **not**
`go test ./...` — the palconfig/palsave suites only ever run on dev machines.
Add `go test ./...` (palsave's tests self-skip when `palworld-save-tools`
isn't installed, so no CI Python setup is required — or add
`pip install palworld-save-tools pyooz` to exercise them fully).
**Acceptance:** a PR breaking a palconfig test fails CI.

---

## E. Frontend UX & correctness

### T24 (P2) — No global 401 handling: an expired session degrades into scattered errors
[web/src/lib/api.ts:7-29](../web/src/lib/api.ts#L7-L29),
[web/src/lib/auth.tsx](../web/src/lib/auth.tsx)

Sessions last 7 days; when one expires mid-use every query starts failing
with its own local error ("Could not reach server", "Failed to load users"…)
and nothing redirects to `/login`. **Fix:** in `request()`, on a 401 from any
endpoint except `/login`, notify auth state (event or callback) so the app
clears `me` and `RequireAuth` bounces to the login page. **Acceptance:**
deleting the cookie while on the dashboard lands you on `/login` within one
poll cycle instead of an error mosaic.

### T25 (P2) — Kick/Ban are single-click with no confirmation
[web/src/components/PlayerList.tsx:56-72](../web/src/components/PlayerList.tsx#L56-L72),
[web/src/pages/ServerDashboard.tsx:67-82](../web/src/pages/ServerDashboard.tsx#L67-L82)

"Ban" sits 20px from "Kick" and fires immediately with a hardcoded reason
("Banned by admin"). A misclick permanently bans a player. Add the same
confirm-dialog pattern already used for stop/restart/delete, and while there,
let the admin type the kick/ban reason (the REST transport supports a
message; it's currently always the hardcoded string).

### T26 (P2) — UI shows controls the server will reject for non-privileged users
The backend enforces permissions correctly; the UI only *hides* gated
controls in two places (`ServerPower`, the Settings nav link). Everything
else renders for everyone and fails with a toast:

- Dashboard header: Save world / Broadcast / Shut down
  ([ServerDashboard.tsx:112-133](../web/src/pages/ServerDashboard.tsx#L112-L133))
- Quick broadcast box ([ServerDashboard.tsx:184-203](../web/src/pages/ServerDashboard.tsx#L184-L203))
- PlayerList Kick/Ban (needs `moderate`)
- Mobile menu: Save world / Shut down
  ([MobileChrome.tsx:113-131](../web/src/components/MobileChrome.tsx#L113-L131))
- Server add/edit/delete (admin-only endpoints) shown to all:
  rail + button ([ServerRail.tsx:37-47](../web/src/components/ServerRail.tsx#L37-L47)),
  sub-nav pencil/trash ([ServerSubNav.tsx](../web/src/components/ServerSubNav.tsx)),
  mobile Edit/Remove menu items
- `/users` route reachable by non-admins (renders "Failed to load users")
  ([App.tsx:50](../web/src/App.tsx#L50))

`useAuth().can()` and `isAdmin` already exist — this is wiring, not design.
**Acceptance:** a view-only user sees no action buttons anywhere; a
`moderate`-only user sees Kick/Ban but not Save/Broadcast; non-admins never
see server CRUD or `/users`.

### T27 (P3) — `ServerPlayers` filter objects defeat their own memoization
[web/src/pages/ServerPlayers.tsx:449-453](../web/src/pages/ServerPlayers.tsx#L449-L453)

`controls` is a fresh object every render, so `PlayerSection`'s
`useMemo([player, controls])` recomputes each render, and `visible` runs
`partition()` for every player on top of that — the filtered lists are
effectively computed twice per keystroke. With hundreds of pals it's still
fast enough today (effMap is memoized), but it's the first place scroll/typing
jank will come back. Memoize `controls` (or split it into primitives) and
derive `visible` + per-player partitions in a single `useMemo`.

### T28 (P3) — Per-sphere info probes stack up on the rail
[web/src/components/ServerSphere.tsx:22-27](../web/src/components/ServerSphere.tsx#L22-L27)

Each rail sphere (and the sub-nav, and the mobile top bar — same query key,
so they dedupe) fires `serverInfo` on mount; each *unreachable* server holds
a connection for up to 20s (see T13). One-shot and cached, so it's bounded —
but with several offline servers the rail's status dots take that long to go
red. T13's timeout fix largely solves this; alternatively add a
`refetchInterval` so dots also *recover* without a manual action (today a
server that comes back stays marked offline until something invalidates
`server-info` — window refocus or a power action).

### T29 (P3) — Unsaved settings edits are silently discarded if the file changes on disk
[web/src/pages/ServerConfig.tsx:94-100](../web/src/pages/ServerConfig.tsx#L94-L100)

`draft` resets whenever `baseline` changes. React Query's structural sharing
keeps `baseline` stable across refetches of identical data, so normal
focus-refetches are safe — but if the ini genuinely changes on disk (server
rewrote it, someone else saved) while an admin has edits pending, their draft
is wiped without warning. Low likelihood; a "settings changed on disk —
review your edits" notice instead of the silent reset would do.

### T30 (P3) — Vendored game data will drift with game patches
[web/src/data/](../web/src/data/), [web/src/lib/stats.ts](../web/src/lib/stats.ts)

`palDex/palCombat/breeding/palStats/skills` catalogs and constants like the
stat-calculator's level cap (`max={60}` in
[ServerCalculators.tsx:474](../web/src/pages/ServerCalculators.tsx#L474)) are
snapshots. The code degrades gracefully for unknown ids (humanized names, "no
stats vendored"), which is the right design. Create a small documented chore:
where each JSON came from (paldex README already notes provenance), how to
regenerate, and re-check the level cap / soul caps against the current game
version. Recurring task, not a one-off.

---

## F. Build, CI, deploy

### T31 (P1) — Dockerfile: `go mod tidy` at build time + self-defeating layer caching
[Dockerfile:10-15](../Dockerfile#L10-L15)

Two issues in the backend stage:
1. `COPY go.mod go.sum* ./` is immediately followed by `COPY . .` with no
   `go mod download` between — the first COPY does nothing for caching, so
   every source change re-downloads all modules.
2. `go mod tidy` during the image build can silently *change* dependency
   versions from what's committed in `go.sum` — builds aren't reproducible.
   `go.sum` is committed and correct; tidy doesn't belong here.

**Fix:**
```dockerfile
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -o /out/palcon ./cmd/palcon
```
Note `COPY . .` also copies `localsaves/` and `data/` into the build context
today — add a `.dockerignore` (localsaves, data, web/node_modules, .git,
mocks) as part of this task; it will shrink context upload dramatically.
**Acceptance:** `docker build` twice in a row with a one-line Go change only
re-runs from `COPY . .`; built binary's module versions match `go.sum`.

### T32 (P2) — Go toolchain pinned at 1.22 across the repo
[go.mod](../go.mod), [Dockerfile:10](../Dockerfile#L10),
[.github/workflows/docker.yml:41](../.github/workflows/docker.yml#L41)

Go 1.22 is ~2.5 years old now. Bump go.mod + Dockerfile + CI together (1.24+
also gives `context.WithoutCancel` maturity for T15 and better sqlite perf via
newer modernc releases). Do together with T33 so versions move once.

### T33 (P3) — Dependency refresh (Go + npm)
Everything is pinned at healthy-but-2024 versions: chi 5.0.12, golang-jwt
5.2.1, x/crypto 0.21.0, modernc sqlite 1.29.5; React 18 / Vite 5 / TS 5.5 /
Tailwind 3 / react-router 6. Nothing known-vulnerable in how they're used
(x/crypto is only bcrypt), so this is maintenance, not urgent. Suggested as
one PR per ecosystem with the test suite (post-T20/T21) as the guardrail.
The alpine base (`3.20`) and `palworld-save-tools==0.24.0`/`pyooz==0.0.8`
pins deserve the same periodic check — upstream PR #215 (native PlM support
in palworld-save-tools) would let the pyooz shim retire eventually.

---

## G. Housekeeping

### T34 (P3) — Retire or annotate the outdated v0.1 review doc
[docs/code-review.md](code-review.md) refers to `ServerCard.tsx` and
`Dashboard.tsx` (deleted), and its punch-list is half-done (404 handler fixed,
rate limiting still open). Add a "superseded by code-review-2026-07.md" banner
or move it to `docs/archive/`.

### T35 (P3) — Duplicated per-handler server-loading boilerplate
`loadServer` ([internal/api/config.go:86-102](../internal/api/config.go#L86-L102))
already centralizes the id-parse → GetServer → error-map dance, but
[pals.go](../internal/api/pals.go) (twice),
[servers.go](../internal/api/servers.go),
[power.go](../internal/api/power.go) and
[actions.go](../internal/api/actions.go) each re-implement it with subtly
different status codes (which is how T4 happened). Fold them onto `loadServer`
/ one error-mapping helper. Pure refactor; do after T4 and with T20's tests in
place.

### T36 (P3) — `handleServerPals` / `handleServerGuilds` are near-identical
[internal/api/pals.go:15-78](../internal/api/pals.go#L15-L78)

Same load-server + read-save + error-map body; only the response shape
differs. Collapse into one helper once T35 lands. (Also: `/guilds` returns
the full `players` array including every pal — the guilds page only needs
uid/nickname/level/lastOnline. Fine at current scale; worth trimming if the
payload ever matters.)

---

## Reviewed and sound (don't re-litigate)

For future agents: these were examined and are correct as designed —

- **Crypto**: AES-256-GCM with random nonce per encryption, nonce||ciphertext
  base64 storage ([internal/crypto/secretbox.go](../internal/crypto/secretbox.go)). Fine.
- **Migrations runner**: transactional per-file, ordered, recorded — fine for
  this project's scale. `SetMaxOpenConns(1)` is the right sqlite call.
- **Permission model**: server-side enforcement is consistent (every mutating
  route gated; viewing deliberately open to signed-in users). The `/settings`
  vs `/config` gating asymmetry is *verified correct* (see baseline note).
- **CSRF**: SameSite=Lax + all mutations on non-GET verbs; deliberate, OK.
- **Docker socket exposure**: scoped proxy with CONTAINERS+POST only,
  documented rationale in compose + dockerctl. Good pattern, keep it.
- **Graceful stop sequence** (save → in-game shutdown → docker stop) and the
  exit-code-137 rationale in power.go — sound (modulo T15's context nit).
- **palconfig writer**: validate-whole-then-atomic-write with `.palcon.bak`,
  preserves unknown keys/order; quote/unquote escaping correct for its cases.
- **Python extractor**: targeted section walk with whole-file fallback,
  defensive field access, stdout kept JSON-clean, tested via synthetic
  fixtures for all three container formats (PlZ, PlM/Oodle, new layout).
- **SPA serving**: `/api` sub-router has its own JSON 404 (v0.1 bug fixed and
  still fixed); index.html fallback correct.
- **Map/chart frontend**: the coordinate math, canvas-decode strategy, pin
  counter-scaling and time-axis gap handling in
  PlayerMap/MetricChart are carefully built and commented; leave alone
  without a specific bug report.

## Suggested delegation batches

| Batch | Tasks | Shape |
|-------|-------|-------|
| 1. Quick correctness | T1, T2, T3, T4, T6 | Small, independent diffs; one agent, one PR |
| 2. CI + Docker | T23, T31, T32 | One agent; touches workflow + Dockerfile |
| 3. API test suite | T20, then T21 | One agent; unblocks safe refactors |
| 4. Auth hardening | T8, T9, T10, T11, T18 | One agent; pairs naturally with batch 3's tests |
| 5. Frontend UX | T24, T25, T26 | One agent; all permission/feedback wiring |
| 6. Transport robustness | T13, T14, T15, T16 | One agent; benefits from T21's fakes |
| 7. Deferred/decisions | T5, T7, T12, T17, T19, T27–T30, T33–T36 | Groom into later work |

Batches 1, 2 and 5 need no test infrastructure and can start immediately in
parallel. Batch 6 is best after batch 3/4 land. T22 (live-server validation)
is a manual session whenever a real server is available — it validates the
riskiest still-unverified layer and should happen before any release that
strangers use.
