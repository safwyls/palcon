# Palcon

[![Docker](https://github.com/safwyls/palcon/actions/workflows/docker.yml/badge.svg)](https://github.com/safwyls/palcon/actions/workflows/docker.yml)

Self-hosted web management for Palworld dedicated servers. A single Go binary
with the React frontend embedded, built to run as a Docker container on
TrueNAS Scale.

## What it does

- **Multi-server registry** — REST API (preferred) with automatic Source RCON
  fallback, credentials encrypted at rest.
- **Dashboard** — live metrics, players online, broadcast, save world, timed
  shutdown, and a read-only view of the server's `PalWorldSettings.ini`.
- **Performance charts** — server FPS, frame time and player count sampled
  every 30s and kept for 7 days.
- **Live map** — players plotted on the real world map with pan/zoom and
  click-to-focus, across both the main map and the Tree area.
- **Player pals** — every player's party, palbox and base pals read from the
  save file, with real names, artwork, IVs, passives and equipped skills.
- **Guilds** — membership, base camp level and base locations, also plotted
  on the map alongside where offline players last logged off.
- **Power control** — start/stop/restart the game server's container through a
  scoped Docker socket proxy.
- **Users and permissions** — give players accounts with only the rights you
  want them to have.

## Deploying on TrueNAS Scale

This is the setup the project is built around. Everything below assumes your
Palworld server runs as its own app/container on the same host — keeping them
separate means updating Palcon never disturbs a running game.

### 1. Create a dataset for Palcon's data

Something like `/mnt/tank/apps/palcon`. This holds `palcon.db` (servers,
users, metrics history).

The container runs as a non-root user, so the dataset has to be writable by
it. The simplest approach on TrueNAS is to run the container as the `apps`
user (uid/gid `568`), which owns app datasets by default — that's what
`user: "568:568"` does below.

### 2. Find the two paths you'll need

- **World save directory** — the folder containing `Level.sav`, typically
  `.../Pal/Saved/SaveGames/0/<long-world-id>`. Needed for Player pals and
  Guilds.
- **Palworld container name** — `docker ps` on the TrueNAS shell. Needed for
  power control.

Both are optional; skip either and the corresponding feature simply doesn't
appear.

### 3. Add a Custom App

In **Apps → Discover Apps → Custom App**, use this compose spec, adjusting
the paths, container name and secrets:

```yaml
services:
  palcon:
    image: ghcr.io/safwyls/palcon:latest
    pull_policy: always          # so redeploying actually picks up new builds
    user: "568:568"              # TrueNAS 'apps' user; must own the data dataset
    ports:
      - 30801:8080
    environment:
      DATA_DIR: /data
      JWT_SECRET: <random string>
      ENCRYPTION_KEY: <exactly 32 characters>
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: <your first-login password>
      # Optional — enables start/stop/restart. Points at the proxy below,
      # never at the host's docker socket.
      DOCKER_HOST: tcp://docker-proxy:2375
    volumes:
      - /mnt/tank/apps/palcon:/data
      # Optional — enables Player pals and Guilds. READ-ONLY on purpose:
      # Palcon never writes to a save file.
      - /mnt/tank/games/palworld/Pal/Saved/SaveGames/0/<world-id>:/saves/myserver:ro
    restart: unless-stopped

  # Optional — only needed for power control.
  docker-proxy:
    image: ghcr.io/tecnativa/docker-socket-proxy:latest
    environment:
      CONTAINERS: 1              # read container state
      POST: 1                    # allow start/stop/restart
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
```

`ENCRYPTION_KEY` must be **exactly 32 characters** and must not change: it
encrypts stored RCON/REST passwords, and losing it makes them unrecoverable.
Back it up with the database.

### 4. Make sure Palcon can reach the game server

Palcon connects to your Palworld server over its REST port (default `8212`)
and/or RCON port (default `25575`). Either put both apps on the same Docker
network, or use the TrueNAS host's LAN IP as the server's host.

To use the REST transport, enable it in `PalWorldSettings.ini`:

```ini
RESTAPIEnabled=True
RESTAPIPort=8212
AdminPassword=<something>
```

Without it, Palcon falls back to RCON automatically. Note that metrics,
settings and the performance charts are REST-only — Palworld's RCON command
set has no equivalent.

### 5. First login and configuration

1. Open `http://<truenas-ip>:30801` and sign in with `ADMIN_USERNAME` /
   `ADMIN_PASSWORD`.
2. **Add server** in the left rail. Fill in host, ports and passwords from
   your `PalWorldSettings.ini`. Two optional fields unlock the extras:
   - **Container name** — the Palworld container from step 2, enabling
     Start/Stop/Restart on the dashboard.
   - **Save path** — the *container* path from step 3 (e.g.
     `/saves/myserver`, not the host path), enabling Player pals and Guilds.
3. **Users** (the icon at the bottom of the rail, admins only) — create
   accounts for other players and grant each only what they need. Giving a
   player just **Power** lets them start the server in the morning without
   any other administrative access.

### 6. Optional: TLS / external access

Put a reverse proxy (TrueNAS ingress, Traefik, Nginx Proxy Manager) in front
of the port. The session cookie is `HttpOnly` but not marked `Secure`, since
LAN-only HTTP is a legitimate deployment here — add `Secure` in
`internal/api/auth.go` once you're behind HTTPS.

### Updating

CI publishes a new image on every push to `main`. With `pull_policy: always`,
redeploying the app in the TrueNAS UI pulls and restarts. Pin to a released
version instead by using `ghcr.io/safwyls/palcon:0.1` or a specific
`0.1.2` tag if you'd rather update deliberately.

### Troubleshooting

**`unable to open database file: out of memory (14)` on startup.**
SQLite's error 14 is `SQLITE_CANTOPEN`; the "out of memory" wording is a
generic driver string, not a real memory problem. The container can't write
to `/data`. Check ownership of the host dataset with `ls -la` — either set
`user:` to match its owning uid/gid (as above), or `chmod 775` the directory
so the container's group can write.

**Player pals shows "Set up save file reading".**
The server has no **Save path** set, or the path doesn't point at a directory
containing `Level.sav`. Remember it's the path *inside the container*
(`/saves/myserver`), not the host path.

**Power controls don't appear.**
Either `DOCKER_HOST` isn't set on the Palcon container, or the server has no
**Container name**. If they're both set and actions fail with a permission
error, the proxy needs `CONTAINERS=1` and `POST=1`.

**Sick pals / a server that won't stop cleanly.**
Stops request a 30-second graceful shutdown so Palworld flushes the world to
disk before Docker resorts to SIGKILL. A stop can therefore take up to half a
minute to report success.

## Users and permissions

`ADMIN_USERNAME`/`ADMIN_PASSWORD` bootstrap a single admin on first run only.
After that, **Users** (admins only) manages accounts, each granted a subset
of:

| Permission | Allows |
|---|---|
| Power | Start, stop and restart the server container |
| Broadcast | Send in-game messages |
| Save world | Trigger a world save |
| Moderate | Kick, ban and unban players |
| In-game shutdown | Shut the server down with a countdown |

Anyone signed in can *view* everything — dashboard, map, pals, guilds. The
permissions above gate only actions that change something. Admins hold all of
them implicitly, plus server and user administration.

In-game shutdown is deliberately separate from Power, so someone trusted to
restart the container isn't automatically able to boot everyone mid-session.

Grants are re-read from the database on every request rather than baked into
the session token, so revoking a permission or disabling an account takes
effect immediately rather than whenever a week-long session expires.

## Server power control

**Palcon does not need, and should not be given, the host's Docker socket.**
That socket is root-equivalent — anything holding it can start a privileged
container and take over the host. Instead,
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) sits
in front with only `CONTAINERS=1` and `POST=1`, so Palcon gets exactly
"inspect, start, stop, restart" and nothing else: no creating containers, no
mounting volumes, no exec. The worst case if Palcon is compromised is a
bounced game server.

## Reading save files

Party composition, palbox contents, per-pal stats and guilds aren't exposed by
REST or RCON at all, so those views read `Level.sav` (Unreal's GVAS format)
directly. **Read-only, as a hard rule** — the save is only ever opened for
reading.

- **No GVAS parser of our own.** A bundled Python extractor
  (`internal/palsave/`) builds on
  [`palworld-save-tools`](https://github.com/cheahjs/palworld-save-tools)
  (MIT, the community standard). Results are cached against `Level.sav`'s
  mtime, so re-parsing only happens after the game autosaves.
- **Only the sections we need are parsed.** A world save holds ~22 sections
  and the unread ones (foliage, every placed structure, every container slot)
  are the enormous ones. Walking past them makes parsing ~100x faster and
  keeps memory flat on an established world.
- **Both save containers are supported.** `PlZ` (zlib, original) and `PlM`
  (Oodle Kraken, game builds 0.6+). palworld-save-tools reads only `PlZ`, so
  `PlM` is unwrapped via [`pyooz`](https://pypi.org/project/pyooz/), whose
  published wheel is decompress-only — the read-only rule is structural, not
  just a convention. Note `ooz` itself carries no license file; it's what
  every community Palworld tool relies on, but worth knowing if this ever
  stops being self-hosted personal software.
- **Newer save layouts are handled leniently.** 0.6 saves append trailing
  bytes and move fields around; decoding reads only what's needed and locates
  shifted structures by shape rather than by fixed offsets, so a game update
  is unlikely to break it outright.
- **Tests** run against synthetic saves in all three layouts
  (`internal/palsave/testdata/`) — no copyrighted game data in the repo.

Pal artwork and names are Pocketpair's, vendored from
[palworld-server-manager](https://github.com/amantu-qbit/palworld-server-manager);
see `web/public/pal-icons/README.md`. The same applies to the world map
textures in `web/public/` — the map and pal views credit Pocketpair on screen.

## Docker (non-TrueNAS)

```sh
docker pull ghcr.io/safwyls/palcon:latest
docker run -p 8080:8080 \
  -v $(pwd)/data:/data \
  -e JWT_SECRET=... -e ENCRYPTION_KEY=<32 chars> -e ADMIN_PASSWORD=... \
  ghcr.io/safwyls/palcon:latest
```

Or `docker compose up` using the bundled `docker-compose.yml`, which already
includes the socket proxy and annotated volume mounts.

Tags published: `latest` (tip of `main`), `main`, `sha-<short-sha>` for every
commit, and `X.Y.Z`/`X.Y` when a `vX.Y.Z` git tag is pushed.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `HTTP_ADDR` | no | `:8080` | listen address |
| `DATA_DIR` | no | `/data` in the image | where `palcon.db` lives |
| `JWT_SECRET` | yes | — | signs session cookies |
| `ENCRYPTION_KEY` | yes | — | encrypts stored RCON/REST passwords; exactly 32 bytes, back it up |
| `ADMIN_USERNAME` | no | `admin` | bootstrap admin username (first run only) |
| `ADMIN_PASSWORD` | yes on first run | — | bootstrap admin password (first run only) |
| `DOCKER_HOST` | no | — | scoped socket proxy for power control, e.g. `tcp://docker-proxy:2375`; unset disables it |

## Local development

Requires Go 1.22+, Node 24+, and Python 3 with `palworld-save-tools` and
`pyooz` if you want the save-reading features to work outside Docker.

```sh
# Backend (from repo root)
cp .env.example .env   # fill in JWT_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD
export $(cat .env | xargs)
go run ./cmd/palcon

# Frontend (separate terminal)
cd web
npm install
npm run dev            # proxies /api to localhost:8080, see vite.config.ts
```

The frontend dev server has hot reload; the Go server serves the API. For a
production-style single-binary run, build the frontend first (`npm run build`
in `web/`) so `web/embed.go` picks up `web/dist`, then `go run ./cmd/palcon`.

```sh
go test ./...          # save-file parsing tests skip if python deps are absent
```

`docs/go-notes.md` is a Go reference written against this codebase, with each
section pointing at the real file and line it's drawn from.
`docs/code-review.md` is a file-by-file review of the original scaffold.

## Repo layout

```
cmd/palcon/           entrypoint
internal/api/         HTTP handlers, auth, permissions, routing
internal/collector/   background metrics sampling for the charts
internal/config/      env-based config
internal/crypto/      AES-GCM encryption for stored passwords
internal/db/          sqlite connection + migrations
internal/dockerctl/   container start/stop/restart via the socket proxy
internal/palsave/     save file reading (Python extractor + Go runner)
internal/palworld/    REST + RCON clients, fallback wrapper
internal/store/       data access: servers, users, metrics
web/                  React frontend, embedded into the Go binary
```
