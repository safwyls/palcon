# Sidecar agent (`palagent`) design

Status: phase 1 in progress (2026-07). This documents the agreed design for
managing Palworld servers directly from the dashboard via a per-server agent
container, replacing the pile of bind mounts palcon needs today.

## Why

Everything palcon does beyond RCON/REST rests on one assumption: palcon
shares a filesystem and a docker host with the game server. The save viewer,
settings editor, backups and SteamCMD cache repair each need another bind
mount wired into palcon's container, and none of them work when the game
server lives on a different machine. The recurring failure that motivated
this design: a Palworld game update corrupts the game container's SteamCMD
manifests/package cache, and the container's embedded updater then fails on
every start. Palcon can only patch around that from the outside.

The agent inverts the privilege direction. A small trusted container sits
*next to* each game server, holding the mounts and the SteamCMD tooling, and
palcon becomes a pure control plane speaking HTTP to it.

## Shape

- **One agent per game server.** "Palcon + a fleet of palagents", never one
  agent supervising many servers. Each agent owns exactly one game server:
  its own volume, its own auth token, its own compose stack. Blast radius,
  updates and restarts stay per-server by construction.
- **Fixed verbs, not an exec agent.** Like the docker-socket-proxy rationale
  in `internal/dockerctl`: the agent exposes only dashboard-shaped
  operations. A compromised palcon (or leaked token) can bounce/repair one
  game server and touch its files — nothing else.
- **Same repo, second binary.** `cmd/palagent`, sharing internal packages
  (e.g. `internal/steamcmd`) with palcon so file operations behave
  identically whichever side executes them. Published as its own image
  (`Dockerfile.palagent`), versioned with a compatibility handshake.

## Two modes

**Companion (phases 1–2, shipped).** The existing game image keeps
running the server; the agent mounts the same `/palworld` volume and absorbs
the file-side features:

- SteamCMD repair: clear `steamapps/*` + `steam/packages/*`, and run
  `steamcmd +app_update 2394010 validate` itself against the shared volume
  — fixing the update-corruption class properly instead of restart-and-pray.
- File verbs (phase 2): the world save directory as a tar bundle
  (ETag/304, so unchanged polls transfer nothing) and
  `PalWorldSettings.ini` GET/PUT (atomic write). Palcon mirrors these into
  `DATA_DIR/agentfiles/<id>/` via `internal/agentfiles`, and the save
  parser, settings editor and backup archiver consume that local cache —
  they never learn agents exist. Game-log tail is deliberately deferred to
  supervisor mode: the companion agent shares a volume, not a PID
  namespace, and container stdout already flows through the docker proxy.

Container power stays with the docker socket proxy in this mode. The agent
cannot see the game process (separate container), so palcon — which can —
refuses SteamCMD updates while the container is running.

**Supervisor (phase 3, shipped).** The same agent image *is* the server
container: `PALAGENT_MODE=supervisor` makes it install the game via
SteamCMD on first boot and run `PalServer.sh` as a child process (own
process group, so signals reach the real binary). Start/stop/restart,
crash auto-restart with backoff, and the game's stdout become agent verbs
(`/v1/power/*`); palcon routes power, status and logs to the agent
whenever `/health` reports supervisor mode, docker proxy not required.
Desired state persists in the install volume, so a recreated agent
resumes what the operator last asked for (docker's unless-stopped, one
level down) — which also means palcon's existing in-game-shutdown
restart flow and restart schedules work unchanged: the game exits, the
supervisor brings it back. SteamCMD updates and a running game are
mutually exclusive, enforced agent-side. Config knobs:
`PALAGENT_GAME_CMD`/`PALAGENT_GAME_ARGS`, `PALAGENT_STOP_GRACE`,
`PALAGENT_AUTOSTART`. Don't combine supervisor mode with a
`containerName`/watchdog on the same server — the supervisor owns
restarts. A server graduates from companion to supervisor by redeploying
its stack.

Supervisor-mode stack (replaces the game image entirely):

```yaml
# palworld-main/docker-compose.yml — the agent IS the server
services:
  palagent:
    image: ghcr.io/safwyls/palagent:latest
    environment:
      - PALAGENT_TOKEN=${PALAGENT_TOKEN}
      - PALAGENT_MODE=supervisor
      # Enforced into PalWorldSettings.ini before every start, along
      # with RCONEnabled/RESTAPIEnabled=True. Palworld ships with both
      # interfaces DISABLED — without this the game runs but the
      # dashboard can't connect to it.
      - PALAGENT_ADMIN_PASSWORD=${PALWORLD_ADMIN_PASSWORD}
    volumes: ["./palworld:/palworld"]   # no :ro SaveGames overlay — the game writes its own saves
    ports:
      - "8211:8211/udp"   # game
      - "8212:8212"       # REST — for palcon (omit if palcon shares palcon-net and targets the container name)
      - "25575:25575"     # RCON — same
    networks: [default, palcon-net]
    restart: unless-stopped
```

Dashboard wiring for a supervised server: the game's REST/RCON listen
*inside the agent container*, so the palcon server row's Host must point
where they're reachable — the host IP with the ports published as above,
or the agent's container name on the shared network with the container
ports. The REST/RCON password in the server row is the
`PALAGENT_ADMIN_PASSWORD` value.

## Migrating a companion-mode server to supervisor

Companion mode is the compatibility path for servers that predate the
agent; migrating retires the game image, the companion, and (once no
companions remain) the docker socket proxy. The world survives because
everything lives in the dataset — the game install, saves, and config
never move. Expect one restart's worth of downtime.

1. **Safety net**: run a backup from the dashboard, and snapshot the
   server's dataset.
2. **Stop the server** from the card (save-then-shutdown runs as usual),
   then stop and delete the old game container's app. Keep the dataset.
3. **Turn off the watchdog** and **clear the container name** on the
   server's edit form — the supervisor owns restarts now, and a stale
   container name would race it.
4. **Remove the companion agent service** from wherever it lives, and
   deploy a supervisor-mode stack for the server (per the example above):
   same volume path, `PALAGENT_MODE=supervisor`,
   `PALAGENT_ADMIN_PASSWORD` set to the row's REST/RCON password, the
   game/REST/RCON ports the old app published, and **no** SaveGames `:ro`
   overlay — the game writes its own saves through this mount. Reusing
   the companion's token saves a form edit. As its own stack, not inside
   palcon's app: the agent is the game server now, and the
   separate-stacks rule applies to it.
5. **Update the server row** if ports or the agent URL changed (a
   standalone stack publishes the agent port instead of sharing palcon's
   network).
6. **Start from the card.** The existing PalWorldSettings.ini is kept
   as-is (identity seeding only applies to fresh installs); the
   management settings are enforced on start, so REST connects on its
   own. Verify the card shows "palagent · supervisor" and players can
   join.
7. **Rollback**, if needed: stop the supervisor stack, redeploy the old
   game app and companion — the dataset was never modified structurally.

## Lifecycle coupling (the question that shaped this)

- **Palcon restarts never touch game servers**, in either mode. The agent
  is not a child of palcon and holds no live connection; the relationship is
  request/response. Long-running verbs are **jobs**: `POST` starts the work
  and returns immediately, palcon polls status. A palcon restart mid-update
  orphans nothing — the same `context.WithoutCancel` philosophy as the
  power-stop sequence, one level up.
- **Companion mode has zero lifecycle coupling anywhere.**
- **Stopping is asked before it is imposed, in both modes** — but the two
  differ in what "imposed" reaches. Palcon always saves the world and asks
  the game to shut itself down over REST first. In companion mode
  `docker stop` then signals PID 1, an entrypoint script that typically
  swallows SIGTERM, so the graceful exit completes untouched and the
  container records exit 0. The supervisor signals the game's whole
  *process group* (PalServer.sh is a wrapper; signalling only the script
  leaves the game running), which lands on the engine directly — sent on
  top of an in-flight shutdown it cuts the final save short and the exit
  becomes 143 (`128+SIGTERM`, logged as `Exiting abnormally (error code:
  143)`). So palcon passes `?graceful=` when its in-game shutdown was
  accepted, and the supervisor waits that out before escalating to
  SIGTERM → grace period → SIGKILL. An operator-initiated stop is recorded
  as a stop regardless of exit code: never a crash, and never counted
  toward the restart backoff.
- **Supervisor mode couples the game to the *agent image* only**: updating
  the agent restarts the game (it's the parent process; containers can't
  re-exec across image updates). Mitigation: keep the agent tiny and boring
  so it updates rarely; palcon orchestrates agent updates like scheduled
  restarts (warn, save, stop, recreate). Palcon can update weekly while
  agents update a few times a year.

## Deployment rule: separate stacks

Palcon's stack (dashboard + docker-proxy) and each game server's stack
(game + agent, or supervisor-agent alone) are **separate compose files**
joined by a shared external network. `docker compose down` on the palcon
stack must be structurally unable to take a game server with it. The
compose-snippet generator (phase 4) emits standalone per-server stack files,
never service blocks to paste into palcon's own stack.

Companion-mode example (game server stack):

```yaml
# palworld-main/docker-compose.yml — one stack per game server
services:
  palworld:
    image: thijsvanloef/palworld-server-docker:latest
    volumes: ["./palworld:/palworld"]
    # ... existing game config unchanged ...
  palagent:
    image: ghcr.io/safwyls/palagent:latest
    volumes:
      - ./palworld:/palworld
      # Save data stays kernel-enforced read-only inside the agent: the
      # agent's verbs never write under SaveGames/, and this nested :ro
      # bind makes that a mount guarantee rather than a code promise —
      # the same stance palcon's own save mounts always had. Remove this
      # line only if/when a deliberate restore-backup verb ships.
      - ./palworld/Pal/Saved/SaveGames:/palworld/Pal/Saved/SaveGames:ro
    environment:
      - PALAGENT_TOKEN=${PALAGENT_TOKEN}   # generated in the palcon UI
    networks: [palcon-net]
networks:
  palcon-net:
    external: true
```

## Agent API (v1)

All `/v1/*` routes require `Authorization: Bearer <token>` (constant-time
compare; agent refuses to start with a token under 16 chars). Bare
`GET /healthz` (204, no body) exists for container healthchecks only.

| Verb | Route | Mode | Notes |
|---|---|---|---|
| GET | `/v1/health` | all | version, API version, mode, install/save/config status, disk free, current/last job, game state (supervisor), provision defaults (provisioner) |
| POST | `/v1/steam/clear-cache` | companion/supervisor | empties `steamapps/*` and `steam/packages/*`; returns `{removed}` |
| POST | `/v1/steam/update` | companion/supervisor | SteamCMD `app_update` job (`{"validate": bool}`); 202 + `{job}`; 409 while busy or (supervisor) while the game runs |
| GET | `/v1/jobs/{id}` | all | job status: state, timestamps, error, capped log tail |
| GET | `/v1/files/save` | companion/supervisor | world save dir as a tar bundle, ETag/304 |
| GET/PUT | `/v1/files/config` | companion/supervisor | `PalWorldSettings.ini`; PUT writes atomically, refuses to create |
| POST | `/v1/power/{start,stop,restart}` | supervisor | game process control; returns post-action status. `?graceful=20s` on stop/restart means "the game has already accepted an in-game shutdown — let that exit finish before signalling it" (see below) |
| GET | `/v1/power/logs` | supervisor | game stdout ring buffer |
| POST | `/v1/provision` | provisioner | instantiate the locked supervisor template; 409 when `palagent-<slug>` already exists, checked before the mkdir and the pull so a refusal means nothing was made |
| GET | `/v1/discover` | provisioner | list palagent containers (name, mode, ports, state — never env) |
| POST | `/v1/adopt` | provisioner | recover a palagent container's registration data, **secrets included** — the deliberate exception to the env rule, bounded to palagent containers, because the provisioner injected those secrets itself and returning them to the token-authenticated control plane recreates a lost server row in one click |

Never a generic exec or arbitrary path parameter, in any mode.

## Auth

Per-agent bearer token, generated by the admin (palcon UI suggests one),
stored encrypted in the `servers` row exactly like the RCON/REST passwords,
pasted into the agent's environment. Plain HTTP on the shared compose
network to start; for cross-host deployments, TLS with a pinned self-signed
cert fingerprint stored alongside the token (later phase). The
reverse-connection variant (agent dials out over WebSocket for NAT'd hosts)
is deferred; the verb surface doesn't change if it's added.

## Palcon integration

- `internal/agentctl` — client mirroring `dockerctl`'s structure.
- `servers` gains `agent_url` + `agent_token_enc`.
- Feature resolution per server: agent if configured, else the local
  path / docker proxy it uses today. Bind mounts remain a fully supported
  degraded mode; nothing existing breaks.
- Palcon-side safety that the agent can't provide in companion mode lives
  in palcon: SteamCMD update is refused while the container reports running.

## Provisioning ("new server from the dashboard")

Palcon never gains docker create/mount rights (see the proxy comment in
`docker-compose.yml` for why: create with arbitrary bind mounts is
root-equivalent, and no socket proxy can validate payloads). The goal —
spinning up a new Palworld server from the dashboard — lands in two steps:

- **Phase 4, one-paste — SHIPPED 2026-07**: the "New server" wizard
  (behind the add-server dialog) registers a fully wired server row —
  host, ports, generated admin password and agent token, REST/RCON
  credentials — and emits the complete supervisor stack file with copy /
  download. The human pastes it and deploys; the agent installs the game
  via SteamCMD on first boot (progress on the server's card) and comes up
  already connected, because PALAGENT_ADMIN_PASSWORD enforces the
  management interfaces. Everything is dashboard-driven except the single
  paste (`POST /servers/provision`, admin-only).
- **Phase 5 (optional), one-click — SHIPPED 2026-07**: a provisioner-mode
  palagent (`PALAGENT_MODE=provisioner`) holds the docker create rights
  palcon must never have, exposing one fixed verb — `/v1/provision`,
  instantiate the locked Palworld supervisor template. The template lives
  in code (internal/palagent/provisioner.go): no arbitrary images, mounts
  or privileges are expressible; data dirs are always `<data root>/<slug>`
  with the slug pattern forbidding traversal. A compromised palcon (or
  leaked provisioner token) can stamp out more Palworld servers, and
  nothing else. When palcon has `PROVISIONER_URL`/`PROVISIONER_TOKEN`
  set, the wizard deploys the stack itself — the operator clicks Generate
  and watches the install on the server's card.

  Two kinds of deploy failure, handled differently, because only one of
  them has a fallback. A provisioner that *refused* — the container name
  is taken (409), the token was rejected, the request was malformed —
  made nothing, and pasting the same stack elsewhere would collide the
  same way; palcon registers no server row and returns the error. A
  provisioner that merely couldn't be *reached* leaves the paste flow
  intact: the row and the generated stack still describe a server the
  operator can bring up by hand, which is the point of still generating
  one. Hence the ordering in `handleProvisionServer` — deploy first,
  register after. Registering first is what once left a name collision
  showing as a server in the rail that palcon could never reach, since
  its row carried credentials the running container had never seen.

  Provisioner stack (deliberately privileged — the ONE component that
  touches the docker socket; run as root, no `user:` line, since it
  chowns data dirs and drives docker):

  ```yaml
  services:
    palprovisioner:
      image: ghcr.io/safwyls/palagent:latest
      environment:
        - PALAGENT_MODE=provisioner
        - PALAGENT_TOKEN=${PROVISIONER_TOKEN}
        - PALAGENT_DATA_ROOT=/mnt/pool/apps/palworld-servers
        # Wizard defaults, reported via /v1/health so the form prefills
        # instead of asking. PUBLIC_HOST is the LAN address palcon and
        # players reach this box on — it can't be guessed from inside a
        # container ("localhost" would be the container itself).
        - PALAGENT_PUBLIC_HOST=10.0.0.5
        - PALAGENT_DEFAULT_RUN_AS=568:568   # default anyway
        - PALAGENT_DEFAULT_IMAGE_TAG=latest # default anyway
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock
        # MUST be mounted at the identical path: the provisioner mkdirs
        # inside this mount and hands docker the same string as a host
        # bind for the new container.
        - /mnt/pool/apps/palworld-servers:/mnt/pool/apps/palworld-servers
      ports: ["8810:8811"]
      restart: unless-stopped
  # palcon env: PROVISIONER_URL=http://<host>:8810  PROVISIONER_TOKEN=<same token>
  ```

  Caveat: one-click containers are plain docker containers — on TrueNAS
  they show as external/discovered, not as apps. Use the paste flow when
  you want them managed as TrueNAS custom apps.

  With a provisioner configured, the wizard infers nearly everything:
  `/v1/health` reports the provisioner's data root, public host, and
  run-as/image-tag defaults; palcon adds a free-port proposal computed
  from the servers it already tracks; and the form collapses to name +
  MOTD with the rest behind an Advanced disclosure (data path disappears
  entirely — one-click servers always live at `<data root>/<slug>`).
  `/v1/discover` additionally lists palagent-shaped containers on the
  host (name, mode, published ports, running state — never environment
  values, which carry tokens), so the add-server dialog can offer
  existing supervisor installs for adoption with their ports prefilled.

  `/v1/destroy` is create's inverse, and the only verb that unmakes
  anything. It is gated on the `palcon.provisioned=true` label that
  `/v1/provision` writes — deliberately narrower than discover/adopt,
  which also match the palagent image name. A palagent deployed by hand
  (a TrueNAS app, a pasted stack) carries the image but not the label and
  is refused, so this verb can only ever unmake what the same provisioner
  made. It stops the container first, giving the game its grace period to
  flush the world, and **never removes the volume**: the world lives in a
  host bind mount under the data root and survives. Removing a server in
  palcon still defaults to dropping just the row — destroying the
  container is an explicit opt-in on the remove dialog
  (`DELETE /servers/{id}?removeContainer=true`), offered only when a
  provisioner is configured and the row records a container name.

  Data directories are never deleted, by any verb. Reclaiming the disk
  is a deliberate trip to the host — the one step where a mistake costs
  a world that no amount of re-provisioning brings back.

  ### Understand the risk before deploying the provisioner

  **A container holding the docker socket as root IS root on the host** —
  every pool, every dataset. If arbitrary code ever runs inside the
  provisioner container, there is no second wall. Deploying it is a
  deliberate trade of that exposure for one-click convenience; the paste
  flow delivers identical capability without it. Know the three paths in:

  1. **Its API.** Bounded by design: locked verbs, template in code,
     token-authenticated. A fully hostile caller with the token can stamp
     out Palworld-supervisor containers from this repo's image — fill a
     disk, squat free host ports, chown under the data root — and can
     destroy the containers a provisioner created, taking those servers
     offline until they are re-provisioned. It cannot touch containers it
     did not create, delete any world data, or reach host root. Keep it
     that way operationally: **never publish the provisioner's port**;
     reach it over the compose network by service name, so only palcon
     (and containers beside it) can talk to it at all.
  2. **Bugs in the provisioner itself.** The verb handler and its docker
     payload builder are the code standing in front of a root socket —
     the one place in this repo where an input-validation slip is
     host-critical. Keep this surface tiny and reviewed; new
     caller-controlled fields need a hostile-input argument before they
     land.
  3. **Supply chain — the realistic one.** The provisioner runs this
     repo's own image: whoever controls the GitHub account or CI pipeline
     controls a root-equivalent container on the host. This class of risk
     predates phase 5 (any socket-proxy image carries it), but the
     provisioner moves it onto *this* repo — treat the GitHub account as
     holding root on the NAS, because it effectively does. 2FA, no stale
     tokens, review workflow changes.

  Risk-reduction modes, in increasing order of caution: run it
  continuously (homelab-normal, same class as Portainer/Watchtower);
  **keep it stopped and start it only while provisioning** — palcon
  degrades gracefully to the paste flow whenever it's unreachable, so
  nothing else breaks; or don't deploy it at all and paste. The
  supervisors and companions it creates never hold the socket — a
  compromised game server gets its own volume and verbs, nothing more.

## Phases

1. **Agent skeleton** — SHIPPED 2026-07 (API v1): token auth, `/health`,
   steam verbs (clear-cache, update/validate as a job), `internal/agentctl`,
   palcon UI. Field-validated on a real TrueNAS deployment.
2. **File verbs** — SHIPPED 2026-07 (API v2): save bundle, config GET/PUT;
   `internal/agentfiles` sync layer feeding the existing parser, editor and
   backup archiver. Retires the save/config/install mounts.
3. **Supervisor mode** — SHIPPED 2026-07 (API v3): the agent runs the game
   as a child process; power/status/logs route through it, crash restarts
   and install-on-first-boot included.
4. **Compose-snippet generator** + docs.

## Accepted tradeoffs

- A second published image to build/version (multi-arch), with `/health`
  reporting `apiVersion` so an old agent keeps working with a new palcon.
- Token management UX (generate → paste → env).
- Save reads while the game is writing stay best-effort, same as the
  current backup semantics.
- SteamCMD in the agent image is routine (every server image bundles it);
  supervisor mode is Linux-only, like the containers themselves.
