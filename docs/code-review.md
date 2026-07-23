# Code review: palcon v0.1 scaffold

A self-review of the initial scaffold, meant to be walked through file-by-file. Organized bottom-up (same order the code was written): config → db → palworld → store → api → web → deploy. Each item is tagged:

- 🐛 **Bug** — confirmed wrong behavior
- ⚠️ **Rough edge** — works, but will bite you in a specific scenario
- 💡 **Nitpick** — worth knowing, low priority
- ✅ **Confirmed working** — actually tested, not just written

Nothing here has been fixed yet — this is the "walk through and decide" pass. A prioritized punch-list is at the bottom.

## Verified vs. still untested

Worth being precise about what "done" means so far:

- ✅ `go build ./...`, `go vet ./...` — clean
- ✅ Full HTTP flow tested live: login, session cookie, encrypted server CRUD, SQLite migrations, REST→RCON fallback error propagation, auth guard, SPA static serving
- ✅ Frontend: `npm install && npm run build` — TypeScript compiles clean, Vite build succeeds
- ❌ **Never run against a real Palworld server.** Both `internal/palworld/rest.go`'s JSON field names and `internal/palworld/rcon.go`'s command/response parsing are built from documented/remembered protocol shapes, not observed real traffic. Treat both as "probably right, unverified."
- ❌ **`docker build` has never been run** — no Docker on this dev machine. The Dockerfile is untested.

## `internal/config/config.go`

Straightforward env-var loading. Nothing wrong. 💡 `JWT_SECRET` has no minimum-length check (only `ENCRYPTION_KEY` does, because AES-256 requires exactly 32 bytes) — a one-character secret would work and be a bad session-signing key. Worth a `len(jwtSecret) < 16` check if you want to guard against a lazy `.env`.

## `internal/db/db.go`

✅ Confirmed working — migrations ran, CRUD round-tripped correctly in the smoke test.

- [db.go:25](../internal/db/db.go#L25): `sqlDB.SetMaxOpenConns(1)`. This serializes **every** query — reads included — through one connection. It's the right call for SQLite (avoids `database is locked` errors from concurrent writers), and at this app's scale (a handful of admins clicking buttons) it's a non-issue. Just know it's a hard ceiling if you ever wanted concurrent request handling to matter here.
- The migration runner is minimal (no down-migrations, no dry-run) — fine for a single-maintainer project, would need `golang-migrate` or similar if this ever needs rollback support.

## `internal/palworld/` — the transport layer

This is the least-verified part of the app, since it talks to a game server we don't have running.

- ✅ **Fixed.** `MaxPlayers` was dead (declared, never set) — deleted rather than guessed at, since there's no real server yet to confirm which REST field would populate it. While touching this struct, also found and fixed a second, more significant issue that wasn't caught in the original pass: `PlayerCount` was tagged `json:"-"`, meaning `Info()` was doing a full extra `Players()` round-trip (a real network/RCON call) just to compute a value that the JSON encoder then silently discarded before it ever reached the frontend. Changed the tag to `json:"playerCount"` so the computed value is actually returned, and updated the frontend's `ServerInfo` type in [api.ts](../web/src/lib/api.ts) to match. No UI currently displays it — just fixed the API contract so the data isn't wastefully thrown away.
- ⚠️ **[rcon.go:171-179](../internal/palworld/rcon.go#L171-L179): RCON fallback silently drops the kick/ban `message`.** Both methods accept a `message` parameter (to match the REST API, which does support a reason message) but the RCON commands `KickPlayer`/`BanPlayer` only take a Steam ID — so when REST fails and RCON fallback kicks in, the admin's kick/ban reason vanishes with no error or log. Not fixable (Palworld's RCON command set genuinely doesn't support it) but worth a code comment at minimum, since it's a silent behavior difference between the two transports.
- ⚠️ **[fallback.go](../internal/palworld/fallback.go) masks *why* REST failed.** If REST fails because of a wrong REST password (config mistake) vs. REST being genuinely disabled, both look identical from the fallback's perspective — it just tries RCON next. If RCON is also misconfigured, the error the admin sees is the *RCON* failure, which has nothing to do with the actual REST password typo. Debugging a bad REST config will be confusing until you check both.
- ⚠️ **No multi-packet response handling in `readPacket`** ([rcon.go](../internal/palworld/rcon.go)). Source RCON can split large responses across multiple packets with a sentinel terminator; this implementation reads exactly one packet per command. Fine for Palworld's typically-small responses (`Info`, single-line `Broadcast` ack), but if `ShowPlayers` ever returns a very long player list, it could silently truncate. Worth a real-world test with a full server once you have one running.
- 💡 The underscore-for-space substitution in `Broadcast`/`Shutdown` messages ([rcon.go:166](../internal/palworld/rcon.go#L166), [rcon.go:193](../internal/palworld/rcon.go#L193)) is based on a documented RCON quirk, not something tested against a live server — first thing to check once you have real access.

## `internal/store/` — data layer

✅ Confirmed working live (create/list/get round-tripped correctly with encryption).

- No concurrency/locking concerns worth flagging beyond what's already covered by `SetMaxOpenConns(1)`.
- 💡 `UpdateServer` re-encrypts and preserves old passwords when the incoming ones are empty strings ([servers.go:127-156](../internal/store/servers.go#L127-L156)) — a nice touch, but it means there's currently no way to *clear* a password via the API (empty string always means "keep existing"). Not a bug, just a design choice worth remembering if you ever build the "edit server" UI.

## `internal/api/` — HTTP layer

- ✅ **Fixed.** Unmatched `/api/*` paths used to return the SPA's HTML with a `200 OK` instead of a JSON 404 — confirmed live with `curl` before the fix. Cause: [server.go](../internal/api/server.go)'s `r.NotFound(spaHandler(staticFS))` was registered on the top-level router, and chi propagates the parent's `NotFound` handler down into the `/api` sub-router (mounted via `r.Route("/api", ...)`) when that sub-router never sets its own. Fix was to give the `/api` group its own `r.NotFound(...)` returning a JSON 404. Re-verified live after the fix:
  ```
  curl -i http://localhost:18091/api/this-does-not-exist
  → HTTP/1.1 404 Not Found, Content-Type: application/json, {"error":"not found"}
  ```
- ⚠️ **[actions.go:33-39](../internal/api/actions.go#L33-L39): `withClient` mislabels DB errors as "invalid server id".** `clientForServerID` can fail for two different reasons — a non-numeric ID in the URL (genuinely a bad request) or a real `store.GetServer` failure that isn't `ErrNotFound` (e.g. an actual DB error). Both currently get reported to the client as `400 invalid server id`, which is misleading in the second case. Low-impact since DB errors here should be rare, but worth tightening if you want accurate error messages.
- 💡 **JSON bool zero-value gotcha**, worth knowing as a Go/JSON lesson: `serverWriteRequest.Enabled`/`UseREST` in [servers.go:42-51](../internal/api/servers.go#L42-L51) are plain `bool`. If any future API client omits those fields entirely, Go's JSON decoder leaves them at the zero value (`false`) rather than erroring or leaving them unset — there's no way to distinguish "not sent" from "explicitly false" with a plain `bool`. The current frontend form always sends both explicitly, so this isn't biting you yet, but it's the kind of bug that appears the moment someone adds a "quick toggle" API call that only sends a partial body. Fix (if it ever matters): use `*bool` and check for `nil`.
- No CSRF token is used, deliberately — `SameSite=Lax` on the session cookie ([auth.go:70](../internal/api/auth.go#L70)) already blocks the cookie from being attached to cross-site non-GET requests, which covers the state-changing endpoints here (all of them are POST/PUT/DELETE). This is fine as-is; just flagging it as an intentional gap rather than an oversight.
- ⚠️ **No rate limiting on `/login`.** A self-hosted single-admin tool is lower-risk than a multi-tenant SaaS, but if you ever expose this past your LAN, brute-forcing the admin password has no friction. Worth a simple in-memory attempt counter or an nginx/Traefik-level rate limit in front of it eventually.

## `web/` — frontend

- ⚠️ **[ServerCard.tsx](../web/src/components/ServerCard.tsx) fires a live `info` request per server card on every dashboard load**, each of which — if that server is unreachable — waits out the RCON dial timeout (10s default, [rcon.go:33-38](../internal/palworld/rcon.go#L33-L38)) before showing the red "unreachable" dot. With several offline servers configured, the dashboard could feel sluggish for several seconds on load. Not broken, just worth knowing before you add a 6th server and wonder why the page hangs.
- 💡 There's no "edit server" UI yet — [Dashboard.tsx](../web/src/pages/Dashboard.tsx) only has a create form, even though the backend fully supports `PUT /servers/{id}`. First obvious next feature if you want to change a server's port/password without deleting and recreating it.
- 💡 Port number inputs (`Number(e.target.value)`) will silently become `NaN` if a field is cleared — no validation/clamping on the form. Low priority for a single-admin internal tool.

## Deployment

- ⚠️ **Dockerfile is unverified** — written correctly as far as I can tell (multi-stage: Node build → Go build with embedded frontend → alpine runtime), and the `go mod tidy` step inside the build stage means it doesn't need a pre-existing `go.sum` to succeed, but nobody has actually run `docker build .` against it yet.

## Prioritized punch-list

Both confirmed 🐛 bugs (the `/api` 404 handler and the dead/discarded `MaxPlayers`/`PlayerCount` fields) are now fixed and re-verified live. What's left, roughly in order of impact:

1. **Test against a real Palworld server** — this is what actually validates `internal/palworld/`, the riskiest untested layer. Everything else is secondary until this happens.
2. **Run an actual `docker build .`** once you have Docker somewhere — that's the real deployment path, and it's never been executed.
3. Decide whether the kick/ban message-drop-on-RCON-fallback ([rcon.go:171-179](../internal/palworld/rcon.go#L171-L179)) needs a log line so it's not silent.
4. Everything else in this doc (error-message precision in `withClient`, rate limiting, edit-server UI) is polish — worth doing, not urgent.
