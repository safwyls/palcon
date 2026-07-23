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

### Phase 5 (planned): Pal party/palbox viewer

Not available via REST or RCON at all — Palworld's API surface has no endpoint for party composition, palbox contents, or per-Pal stats. Getting this means reading the actual save file (`.sav`, Unreal Engine's GVAS format) directly:

- **Don't write a GVAS parser from scratch.** [`palworld-save-tools`](https://github.com/cheahjs/palworld-save-tools) (Python, MIT, 863 stars, actively maintained, the de facto standard other community tools build on — `PalEdit`, `palworld-server-tool`, etc. all depend on it) already does this correctly, with a "SAV → JSON → SAV round-trips bit-for-bit" correctness guarantee. Shell out to it (or wrap it in a small sidecar service) rather than reimplementing binary save parsing in Go.
- **Read-only first, hard rule.** Corrupting a save file is a much worse failure mode than anything the REST/RCON actions can currently do. No writes back to the save file until viewing is solid and well-tested.
- **Deployment**: since palcon and the Palworld server both run on the same TrueNAS host, this needs a read-only bind mount of the server's save directory into the palcon container — an optional per-server config addition (e.g. a nullable `save_path` column on `servers`), not a new architectural pattern.

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
