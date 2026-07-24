# Palcon

[![Docker](https://github.com/safwyls/palcon/actions/workflows/docker.yml/badge.svg)](https://github.com/safwyls/palcon/actions/workflows/docker.yml)

Self-hosted RCON/REST management server for Palworld dedicated servers, built to run as a Docker container on TrueNAS Scale.

## Architecture

- **Backend**: Go, single binary, embeds the built frontend
- **Frontend**: React + Vite + TypeScript + Tailwind, embedded into the binary at build time
- **DB**: SQLite (`internal/db`), single file on a mounted volume
- **Server communication**: `internal/palworld` talks to each Palworld server over its REST API (preferred) with automatic fallback to Source RCON if the REST API is unreachable
- **Auth**: single bootstrap admin user, JWT session cookie

Data model, phasing, and the full design discussion are in the conversation history that produced this scaffold. Phase 1 (this scaffold) covers: multi-server registry, REST/RCON actions (info, players, broadcast, kick, ban, unban, save, shutdown), and the dashboard UI. The schema already has tables for phase 2 (scheduled tasks) and phase 3 (Discord notifications) — not wired up yet. Live server metrics, a read-only settings viewer, and a real-time player map (phase 4 material) shipped as part of the UI redesign.

### Phase 5: Pal party/palbox viewer ("Player pals")

Not available via REST or RCON at all — Palworld's API surface has no endpoint for party composition, palbox contents, or per-Pal stats, so this reads the actual save file (`Level.sav`, Unreal Engine's GVAS format) directly:

- **No GVAS parser of our own.** A bundled Python extractor (`internal/palsave/extract_pals.py`, baked into the Docker image with python3) builds on [`palworld-save-tools`](https://github.com/cheahjs/palworld-save-tools) (MIT, the de facto community standard). The Go side shells out to it and caches results keyed on `Level.sav`'s mtime, so re-parses only happen after the game autosaves.
- **Both save containers are supported.** Saves come wrapped in one of two containers, identified by magic bytes: `PlZ` (zlib, original) and `PlM` (Oodle Kraken, written by game builds 0.6+). palworld-save-tools only reads `PlZ` — upstream's Oodle PR is still open — so the extractor unwraps `PlM` itself via [`pyooz`](https://pypi.org/project/pyooz/), an open-source Kraken decompressor that ships prebuilt musllinux wheels (no compiler in the image). Its published wheel is *decompress-only*, which enforces the read-only rule structurally. Note `ooz` itself carries no license file; it's the implementation every community Palworld tool relies on, but that's worth knowing if this ever stops being self-hosted personal software.
- **Read-only, hard rule.** The save file is only ever opened for reading. No write-back features until/unless viewing has been solid for a long time.
- **Setup**: bind-mount the world save folder (the one containing `Level.sav`) read-only into the container (see `docker-compose.yml`), then set that container path as the server's **Save path** in the UI. Servers without a save path simply show setup guidance on the Player pals page.
- **Tests** run against synthetic saves in both containers (`internal/palsave/testdata/`, see the README there for how they're generated) — no copyrighted game data in the repo.

## Repo layout

```
cmd/palcon/          entrypoint
internal/config/     env-based config
internal/db/          sqlite connection + migrations
internal/palworld/    REST + RCON clients, fallback wrapper
internal/store/       data access (servers, users), password encryption
internal/api/         HTTP handlers, auth, routing
internal/crypto/      AES-GCM encryption for stored passwords
web/                  React frontend (embedded into the Go binary via internal/web)
```

## Local development

This was scaffolded without Go, Node, or Docker installed on the machine that generated it — none of it has been built or run yet. You'll need:

- Go 1.22+
- Node 20+
- (optional but recommended) Docker, for testing the real deployment path

```sh
# Backend (from repo root)
cp .env.example .env   # fill in JWT_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD
export $(cat .env | xargs)
go mod tidy             # generates go.sum, only needed once / after adding deps
go run ./cmd/palcon

# Frontend (separate terminal)
cd web
npm install
npm run dev             # proxies /api to localhost:8080, see vite.config.ts
```

The frontend dev server runs on its own port with hot reload; the Go server serves the API. For a production-style single-binary run, build the frontend first (`npm run build` in `web/`) so `internal` — actually `web/embed.go` — picks up `web/dist`, then `go run ./cmd/palcon` (or `go build`) again.

## Docker

### Pre-built image (recommended)

Every push to `main` builds and publishes an image via GitHub Actions (`.github/workflows/docker.yml`) to GitHub Container Registry — no local Docker needed to get an image:

```sh
docker pull ghcr.io/safwyls/palcon:latest
docker run -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e JWT_SECRET=... -e ENCRYPTION_KEY=... -e ADMIN_PASSWORD=... \
  ghcr.io/safwyls/palcon:latest
```

Tags published: `latest` (tip of `main`), `main` (branch name), `sha-<short-sha>` (every commit), and `X.Y.Z`/`X.Y` (if you push a `vX.Y.Z` git tag). The package is public by default for a public repo; if the repo is private, TrueNAS will need a GHCR pull secret (a GitHub PAT with `read:packages`).

### Building locally

```sh
docker build -t palcon .
docker run -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e JWT_SECRET=... -e ENCRYPTION_KEY=... -e ADMIN_PASSWORD=... \
  palcon
```

Or with `docker-compose.yml` (reads from `.env`, builds locally by default — swap `build: .` for `image: ghcr.io/safwyls/palcon:latest` to use the published image instead):

```sh
docker compose up --build
```

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HTTP_ADDR` | no | `:8080` | listen address |
| `DATA_DIR` | no | `./data` | where `palcon.db` lives |
| `JWT_SECRET` | yes | — | signs session cookies |
| `ENCRYPTION_KEY` | yes | — | encrypts stored RCON/REST passwords, must be exactly 32 bytes |
| `ADMIN_USERNAME` | no | `admin` | bootstrap admin username (first run only) |
| `ADMIN_PASSWORD` | yes on first run | — | bootstrap admin password (first run only) |
| `DOCKER_HOST` | no | — | scoped docker socket proxy for start/stop/restart, e.g. `tcp://docker-proxy:2375`. Unset disables power control |

## Users and permissions

`ADMIN_USERNAME`/`ADMIN_PASSWORD` bootstrap a single admin on first run.
From there, **Users** in the sidebar (admins only) creates accounts for other
players and grants each one a subset of:

| Permission | Allows |
|---|---|
| Power | Start, stop and restart the server container |
| Broadcast | Send in-game messages |
| Save world | Trigger a world save |
| Moderate | Kick, ban and unban players |
| In-game shutdown | Shut the server down with a countdown |

Anyone signed in can *view* everything — dashboard, map, pals, guilds. The
permissions above gate only the actions that change something, and admins
implicitly hold all of them plus server and user administration.

Grants are re-read from the database on every request rather than baked into
the session token, so revoking a permission or disabling an account takes
effect immediately instead of whenever a week-long session happens to expire.

## Server power control

Palcon can start/stop/restart the container a Palworld server runs in, which
is what makes "stop overnight, start in the morning" a button instead of an
SSH session.

**It does not need — and should not be given — the host's docker socket.**
That socket is root-equivalent: anything holding it can start a privileged
container and own the host. Instead, run
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
alongside Palcon with only `CONTAINERS=1` and `POST=1`, and point
`DOCKER_HOST` at it (see `docker-compose.yml`). Palcon then gets exactly
"inspect, start, stop, restart" and nothing else; it cannot create
containers, mount volumes, or exec into anything.

Then set each server's **Container name** in its edit dialog. Servers without
one simply don't show power controls.

Stops request a 30-second graceful shutdown so the world is written to disk
before Docker resorts to SIGKILL.

## Deploying on TrueNAS Scale

1. Use the image GitHub Actions already publishes: `ghcr.io/safwyls/palcon:latest` (see [Docker](#docker) above) — no build step needed on the TrueNAS box itself.
2. Create a dataset for persistent data, e.g. `/mnt/tank/apps/palcon/data`.
3. Add a Custom App (Docker Compose) in the TrueNAS Scale Apps UI, pointing at this repo's `docker-compose.yml` (switch its `build: .` to `image: ghcr.io/safwyls/palcon:latest`), with the volume mapped to that dataset and the env vars set from the table above.
4. Make sure the container can reach your Palworld server's REST API port (default `8212`) and/or RCON port (default `25575`) — same Docker network, or the TrueNAS host's IP if the Palworld server runs in a separate app/jail.
5. Put a reverse proxy (TrueNAS ingress, Traefik, or Nginx Proxy Manager) in front of port 8080 if you want TLS/external access; the session cookie is `HttpOnly` but not marked `Secure` by default since LAN-only HTTP deployments are a legitimate use case here — add `Secure` in `internal/api/auth.go` once you're behind HTTPS.

### Troubleshooting: container crash-loops with `unable to open database file: out of memory (14)`

The Dockerfile runs as a non-root user (uid 1000) for security, not root. If your TrueNAS dataset/host path for `/data` is owned by a different user/group with no write access for uid 1000, SQLite can't create `palcon.db` and fails with this error — SQLite error code `14` is `SQLITE_CANTOPEN`; the "out of memory" wording is just a generic driver string, not an actual memory issue. Check with `ls -la` on the host path. Two ways to fix it:

- **Match ownership**: set `user: "<uid>:<gid>"` in the app's compose spec to the host directory's owning UID/GID (e.g. TrueNAS's `apps` group is usually `568`) — this is what `app.yaml` in this repo does.
- **Or open up permissions**: `chmod 775` the host directory so its group (already attached to the container via `group_add`) gets write access.

## Known unverified areas

The Go backend (`go build`/`go vet`) and frontend (`npm run build`) both build clean and have been smoke-tested live — login, encrypted server CRUD, SQLite migrations, auth guard, and SPA serving all confirmed working (see `docs/code-review.md` for the full pass, including two bugs found and fixed since the initial scaffold). CI (`.github/workflows/docker.yml`) builds and pushes the image on every push to `main`, and it's now been deployed and run successfully on real TrueNAS Scale hardware — the Dockerfile itself is confirmed working end to end. What's still genuinely unverified:

- **`internal/palworld/rest.go` JSON field names** and **`internal/palworld/rcon.go` packet/response parsing** — built from documented/remembered Palworld REST and RCON protocol shapes, never run against a real Palworld server. This is the last remaining unknown; everything else in the stack — build, CI, deployment, auth, storage — has now been exercised for real.

Enable your Palworld server's REST API in `PalWorldSettings.ini` (`RESTAPIEnabled=True`, set `RESTAPIPort` and `AdminPassword`) to use the REST transport; otherwise Palcon falls back to RCON automatically.
