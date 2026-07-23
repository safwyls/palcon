# Palcon

Self-hosted RCON/REST management server for Palworld dedicated servers, built to run as a Docker container on TrueNAS Scale.

## Architecture

- **Backend**: Go, single binary, embeds the built frontend
- **Frontend**: React + Vite + TypeScript + Tailwind, embedded into the binary at build time
- **DB**: SQLite (`internal/db`), single file on a mounted volume
- **Server communication**: `internal/palworld` talks to each Palworld server over its REST API (preferred) with automatic fallback to Source RCON if the REST API is unreachable
- **Auth**: single bootstrap admin user, JWT session cookie

Data model, phasing, and the full design discussion are in the conversation history that produced this scaffold. Phase 1 (this scaffold) covers: multi-server registry, REST/RCON actions (info, players, broadcast, kick, ban, unban, save, shutdown), and the dashboard UI. The schema already has tables for phase 2 (scheduled tasks), phase 3 (Discord notifications), and phase 4 (player/metrics history) — those features aren't wired up yet.

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

```sh
docker build -t palcon .
docker run -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e JWT_SECRET=... -e ENCRYPTION_KEY=... -e ADMIN_PASSWORD=... \
  palcon
```

Or with `docker-compose.yml` (reads from `.env`):

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

1. Push the built image to a registry TrueNAS can reach (or build directly on the box if you install Docker there).
2. Create a dataset for persistent data, e.g. `/mnt/tank/apps/palcon/data`.
3. Add a Custom App (Docker Compose) in the TrueNAS Scale Apps UI, pointing at this repo's `docker-compose.yml`, with the volume mapped to that dataset and the env vars set from the table above.
4. Make sure the container can reach your Palworld server's REST API port (default `8212`) and/or RCON port (default `25575`) — same Docker network, or the TrueNAS host's IP if the Palworld server runs in a separate app/jail.
5. Put a reverse proxy (TrueNAS ingress, Traefik, or Nginx Proxy Manager) in front of port 8080 if you want TLS/external access; the session cookie is `HttpOnly` but not marked `Secure` by default since LAN-only HTTP deployments are a legitimate use case here — add `Secure` in `internal/api/auth.go` once you're behind HTTPS.

## Known unverified areas

Nothing in this scaffold has been compiled or run yet (no Go/Node toolchain was available while writing it). Before trusting it end to end, expect to shake out:

- **`internal/palworld/rest.go` JSON field names** — matched against publicly documented Palworld REST API shapes, but should be checked against a real server's actual responses (particularly `/v1/api/players` field names).
- **`internal/palworld/rcon.go` packet parsing** — implements the Source RCON protocol from spec; needs testing against a real Palworld RCON port, especially the `ShowPlayers` CSV parsing.
- **`internal/db/db.go` sqlite DSN string** (`file:...?_pragma=foreign_keys(1)`) — matches `modernc.org/sqlite`'s documented pragma syntax but hasn't been run.
- **`go.sum`** doesn't exist yet — `go mod tidy` (locally or via the Dockerfile's build stage) generates it on first build.

Enable your Palworld server's REST API in `PalWorldSettings.ini` (`RESTAPIEnabled=True`, set `RESTAPIPort` and `AdminPassword`) to use the REST transport; otherwise Palcon falls back to RCON automatically.
