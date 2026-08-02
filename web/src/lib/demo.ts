/**
 * Demo mode: answers every API call locally so the real frontend can run as
 * a static site (GitHub Pages) with no backend. Built only when VITE_DEMO=1
 * — api.ts dynamic-imports this module behind that flag, so normal builds
 * carry none of it (including the ~2 MB save fixture in ../demo/).
 *
 * The save-derived data (pals, guilds, paldex, map positions) is a real
 * capture from a real world; the live-server data (metrics, players online,
 * container state) is synthesized, and mutations mutate module state so the
 * demo feels alive without a server. Nothing persists across reloads.
 */
import { ApiError, FEATURES, STREAMS } from "./api";
import type {
  ActivityResult,
  AppUser,
  AuditEntry,
  AutomationResult,
  BackupsResult,
  ConfigResult,
  ConfigSetting,
  ContainerState,
  InventoryResult,
  Me,
  VisibilityInput,
  VisibilityResult,
  Metrics,
  MetricsHistory,
  MetricPoint,
  PalsResult,
  Player,
  PublicStatus,
  RestartSchedule,
  Server,
  ServerInfo,
  Settings,
  SteamJob,
  SteamUpdateStatus,
  StorageContainer,
  StorageResult,
} from "./api";

// ---------------------------------------------------------------------------
// The captured world. Loaded once, timestamps freshened so "parsed 2m ago"
// style labels stay plausible years after the capture.

/** The capture carries the storage array too, which PalsResult itself doesn't
 * — /pals has no use for it, but one fixture backs every save-derived page. */
type Fixture = PalsResult & { storage?: StorageContainer[] };
let fixturePromise: Promise<Fixture> | null = null;

async function world(): Promise<Fixture> {
  fixturePromise ??= import("../demo/fixture.json").then((m) => {
    const fx = m.default as unknown as Fixture;
    const now = Date.now();
    fx.parsedAt = new Date(now - 2 * 60_000).toISOString();
    fx.saveModTime = new Date(now - 7 * 60_000).toISOString();
    // Two players are "online" right now (see playersOnline); the others
    // logged off recently rather than at the capture's real date.
    const offsets: Record<string, number> = { Aster: 300, Juniper: 300, Bramble: 3 * 3600, Fenwick: 26 * 3600 };
    for (const p of fx.players) {
      p.lastSeen = Math.floor(now / 1000) - (offsets[p.nickname] ?? 8 * 3600);
      // A real save's stamp is the login that *started* that session, never
      // its end, so the demo keeps the two a session apart — otherwise the
      // views' "seen" and "joined" labels would look interchangeable here in
      // a way they never are on a live server.
      p.lastOnline = p.lastSeen - 2 * 3600;
    }
    return fx;
  });
  return fixturePromise;
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness, so charts and activity look organic but
// don't rearrange on every query refetch.

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Mutable demo state: the container can be stopped/started, settings edited,
// schedules changed. Reload to reset.

const state = {
  containerRunning: true,
  containerStartedAt: new Date(Date.now() - 34 * 24 * 3600_000).toISOString(),
  watchdog: true,
  publicStatus: true,
  steamJob: null as (SteamJob & { _t0: number }) | null,
  backupRunAt: null as string | null,
  schedules: [
    {
      id: 1,
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      timeOfDay: "04:00",
      warningMinutes: [15, 5, 1],
      lastRunAt: new Date(new Date().setHours(4, 0, 0, 0) - (new Date().getHours() < 4 ? 24 * 3600_000 : 0)).toISOString(),
      nextRunAt: new Date(new Date().setHours(4, 0, 0, 0) + (new Date().getHours() >= 4 ? 24 * 3600_000 : 0)).toISOString(),
    },
  ] as RestartSchedule[],
  nextScheduleId: 2,
  discord: { configured: true, enabled: true, onStatus: true, onPlayers: true, onRestarts: true },
  users: [
    { id: 1, username: "demo", role: "admin", permissions: [], disabled: false },
    { id: 2, username: "Aster", role: "member", permissions: ["power", "broadcast"], disabled: false },
    { id: 3, username: "Juniper", role: "member", permissions: ["broadcast", "save"], disabled: false },
    { id: 4, username: "Bramble", role: "member", permissions: ["power"], disabled: false },
  ] as AppUser[],
  nextUserId: 5,
  config: null as ConfigSetting[] | null,
  // Mutated by the visibility PUT so the demo's switches actually do something
  // for the rest of the session.
  playerVisibility: {} as Record<string, string[]>,
  hidePrivateStorage: false,
};

// ---------------------------------------------------------------------------
// Server row + live-ish data.

const SERVER: Server = {
  id: 1,
  name: "Verdant Isle",
  host: "10.0.0.5",
  rconPort: 25575,
  hasRconPassword: true,
  restPort: 8212,
  hasRestPassword: true,
  gamePort: 8211,
  joinAddress: "play.verdant-isle.gg",
  useRest: true,
  enabled: true,
  savePath: "/saves/verdant-isle",
  configPath: "/config/verdant-isle",
  installPath: "",
  agentUrl: "",
  hasAgentToken: false,
  containerName: "palworld-main",
  // Everything on: the demo is a shop window, and the point of the visibility
  // switches is better shown by letting a visitor flip them than by shipping
  // one already flipped.
  hiddenFeatures: [],
};

function unreachable(): never {
  throw new ApiError(502, "server unreachable: the demo container is stopped — start it from the dashboard");
}

/** Who can see what. The roster comes from the same captured world, so the
 * per-player table has real names to switch off. */
async function visibility(): Promise<VisibilityResult> {
  const fx = await world();
  return {
    hiddenFeatures: SERVER.hiddenFeatures,
    hidePrivateStorage: state.hidePrivateStorage,
    players: state.playerVisibility,
    roster: fx.players.map((p) => ({ uid: p.uid, nickname: p.nickname, level: p.level })),
    rosterUnavailable: false,
    allFeatures: [...FEATURES],
    allStreams: [...STREAMS],
  };
}

/** The /storage projection. World loot is sampled in the fixture rather than
 * captured whole — the real world holds a few thousand treasure chests, and
 * shipping their locations would add more than a megabyte to the demo bundle
 * to make a point 120 of them already make. */
async function storage(includesWorld: boolean): Promise<StorageResult> {
  const fx = await world();
  const includesPrivate = !state.hidePrivateStorage;
  const containers = (fx.storage ?? []).filter(
    (c) => (includesWorld || c.kind !== "world") && (includesPrivate || !c.private),
  );
  return {
    containers,
    bases: fx.guilds.flatMap((g) =>
      g.bases.map((b, index) => ({ id: b.id, guildId: g.id, guildName: g.name, index, x: b.x, y: b.y })),
    ),
    guilds: fx.guilds.map((g) => ({ id: g.id, name: g.name })),
    includesWorld,
    includesPrivate,
    parsedAt: fx.parsedAt,
    saveModTime: fx.saveModTime,
  };
}

/** The /inventory projection, taken from the same captured world the pal and
 * guild views read, so one fixture backs every save-derived page. */
async function inventory(): Promise<InventoryResult> {
  const fx = await world();
  return {
    players: fx.players
      .filter((p) => p.inventory && Object.keys(p.inventory).length > 0)
      .map((p) => ({
        uid: p.uid,
        nickname: p.nickname,
        level: p.level,
        inventory: p.inventory!,
        character: p.character,
        lastOnline: p.lastOnline,
        lastSeen: p.lastSeen,
        platform: p.platform,
      })),
    parsedAt: fx.parsedAt,
    saveModTime: fx.saveModTime,
  };
}

async function playersOnline(): Promise<Player[]> {
  if (!state.containerRunning) unreachable();
  const fx = await world();
  const online = ["Aster", "Juniper"];
  return fx.players
    .filter((p) => online.includes(p.nickname) && p.lastX != null && p.lastY != null)
    .map((p, i) => ({
      name: p.nickname,
      playerId: `demo-player-${i + 1}`,
      userId: p.uid,
      level: p.level,
      ping: 23 + i * 31,
      location_x: p.lastX!,
      location_y: p.lastY!,
    }));
}

function serverInfo(): ServerInfo {
  if (!state.containerRunning) unreachable();
  return { servername: "Verdant Isle", version: "v0.6.4", playerCount: 2, transport: "rest" };
}

function metrics(): Metrics {
  if (!state.containerRunning) unreachable();
  const rand = mulberry32(Math.floor(Date.now() / 30_000));
  return {
    serverfps: Math.round(58 + rand() * 4),
    serverframetime: +(15.5 + rand() * 2.5).toFixed(1),
    currentplayernum: 2,
    maxplayernum: 32,
    uptime: Math.floor((Date.now() - Date.parse(state.containerStartedAt)) / 1000),
    days: 213,
  };
}

/** A believable week: evening player peaks, fps dipping under load, and one
 * short null gap (a restart) so the chart's gap handling shows. */
function metricsHistory(minutes: number): MetricsHistory {
  const points: MetricPoint[] = [];
  const stride = Math.max(30, Math.round((minutes * 60) / 400));
  const now = Date.now();
  const rand = mulberry32(minutes);
  const restartAt = now - minutes * 60_000 * 0.35;
  for (let t = now - minutes * 60_000; t <= now; t += stride * 1000) {
    if (t > restartAt && t < restartAt + 5 * 60_000) {
      points.push({ ts: new Date(t).toISOString(), playerCount: null, maxPlayers: null, serverFps: null, frameTime: null });
      continue;
    }
    const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const evening = Math.exp(-((hour - 20.5) ** 2) / 8) + 0.6 * Math.exp(-((hour - 13) ** 2) / 18);
    const players = Math.max(0, Math.min(4, Math.round(evening * 3.6 + rand() * 1.4 - 0.5)));
    const fps = 60 - players * 0.9 - rand() * 1.6;
    points.push({
      ts: new Date(t).toISOString(),
      playerCount: players,
      maxPlayers: 32,
      serverFps: +fps.toFixed(1),
      frameTime: +(1000 / fps).toFixed(1),
    });
  }
  return { points, intervalSeconds: stride };
}

async function activity(hours: number): Promise<ActivityResult> {
  const fx = await world();
  const events: ActivityResult["events"] = [];
  const now = Date.now();
  let id = 1;
  for (const p of fx.players) {
    const rand = mulberry32(p.nickname.length * 7919 + hours);
    for (let day = Math.ceil(hours / 24) - 1; day >= 0; day--) {
      const sessions = rand() < 0.25 ? 0 : rand() < 0.7 ? 1 : 2;
      for (let s = 0; s < sessions; s++) {
        const start = now - day * 24 * 3600_000 - (2 + rand() * 6) * 3600_000 - s * 5 * 3600_000;
        const len = (0.8 + rand() * 3.5) * 3600_000;
        if (start + len > now) continue;
        events.push({ id: id++, ts: new Date(start).toISOString(), userId: p.uid, name: p.nickname, event: "join" });
        events.push({ id: id++, ts: new Date(start + len).toISOString(), userId: p.uid, name: p.nickname, event: "leave" });
      }
    }
  }
  // The two currently-online players joined recently and haven't left.
  for (const p of await playersOnline().catch(() => [] as Player[])) {
    events.push({ id: id++, ts: new Date(now - 47 * 60_000).toISOString(), userId: p.userId, name: p.name, event: "join" });
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, hours, intervalSeconds: 60 };
}

const AUDIT: AuditEntry[] = [
  { id: 6, ts: new Date(Date.now() - 40 * 60_000).toISOString(), username: "demo", action: "broadcast", detail: "\"Server restart in 15 minutes\"" },
  { id: 5, ts: new Date(Date.now() - 5 * 3600_000).toISOString(), username: "Aster", action: "power.restart", detail: "container palworld-main" },
  { id: 4, ts: new Date(Date.now() - 26 * 3600_000).toISOString(), username: "demo", action: "settings.update", detail: "PalCaptureRate: 1.0 → 1.2" },
  { id: 3, ts: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(), username: "demo", action: "backup.run", detail: "manual snapshot" },
  { id: 2, ts: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), username: "Juniper", action: "save", detail: "world save" },
  { id: 1, ts: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(), username: "demo", action: "schedule.create", detail: "daily 04:00, warnings 15/5/1" },
];

function backups(): BackupsResult {
  const snaps = [0, 1, 2, 3, 4].map((d) => {
    const ts = new Date(Date.now() - d * 24 * 3600_000 - 4 * 3600_000);
    return {
      name: `verdant-isle-${ts.toISOString().slice(0, 10)}-0400.zip`,
      ts: ts.toISOString(),
      bytes: 48_113_204 + d * 213_991,
    };
  });
  if (state.backupRunAt) {
    snaps.unshift({ name: "verdant-isle-manual.zip", ts: state.backupRunAt, bytes: 48_671_552 });
  }
  return {
    available: true,
    running: false,
    intervalHours: 24,
    keep: 5,
    snapshots: snaps,
    totalBytes: snaps.reduce((n, s) => n + s.bytes, 0),
  };
}

// PalWorldSettings.ini, as both the REST /settings view and the editor.
const INI_DEFAULTS: [string, string, ConfigSetting["type"]][] = [
  ["ServerName", "Verdant Isle", "string"],
  ["ServerDescription", "A cozy island for four friends and 5,188 pals.", "string"],
  ["ServerPlayerMaxNum", "32", "int"],
  ["Difficulty", "None", "enum"],
  ["DayTimeSpeedRate", "1.0", "float"],
  ["NightTimeSpeedRate", "1.0", "float"],
  ["ExpRate", "1.0", "float"],
  ["PalCaptureRate", "1.2", "float"],
  ["PalSpawnNumRate", "1.0", "float"],
  ["PalDamageRateAttack", "1.0", "float"],
  ["PalDamageRateDefense", "1.0", "float"],
  ["PlayerDamageRateAttack", "1.0", "float"],
  ["PlayerDamageRateDefense", "1.0", "float"],
  ["PlayerStomachDecreaceRate", "1.0", "float"],
  ["PalStomachDecreaceRate", "1.0", "float"],
  ["PalEggDefaultHatchingTime", "24.0", "float"],
  ["WorkSpeedRate", "1.0", "float"],
  ["DeathPenalty", "ItemAndEquipment", "enum"],
  ["bEnableInvaderEnemy", "True", "bool"],
  ["bEnablePlayerToPlayerDamage", "False", "bool"],
  ["bEnableFriendlyFire", "False", "bool"],
  ["bActiveUNKO", "False", "bool"],
  ["CoopPlayerMaxNum", "4", "int"],
  ["GuildPlayerMaxNum", "20", "int"],
  ["BaseCampMaxNumInGuild", "7", "int"],
  ["BaseCampWorkerMaxNum", "24", "int"],
  ["DropItemMaxNum", "3000", "int"],
  ["AutoSaveSpan", "30.0", "float"],
  ["RESTAPIEnabled", "True", "bool"],
  ["RESTAPIPort", "8212", "int"],
  ["RCONEnabled", "True", "bool"],
  ["RCONPort", "25575", "int"],
  ["PublicPort", "8211", "int"],
];

function configSettings(): ConfigSetting[] {
  state.config ??= INI_DEFAULTS.map(([key, value, type]) => ({ key, value, type }));
  return state.config;
}

function restSettings(): Settings {
  const out: Settings = {};
  for (const s of configSettings()) {
    out[s.key] = s.type === "int" ? parseInt(s.value, 10) : s.type === "float" ? parseFloat(s.value) : s.type === "bool" ? s.value === "True" : s.value;
  }
  return out;
}

function automation(): AutomationResult {
  return {
    schedules: state.schedules,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    dockerRestart: true,
    discord: state.discord,
    watchdog: { enabled: state.watchdog, available: true },
    publicStatus: { enabled: state.publicStatus, token: "demo" },
  };
}

function container(): ContainerState {
  return {
    name: "palworld-main",
    status: state.containerRunning ? "running" : "exited",
    running: state.containerRunning,
    startedAt: state.containerStartedAt,
    exitCode: state.containerRunning ? 0 : 0,
  };
}

const CONTAINER_LOGS = [
  "[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.",
  "Setting breakpad minidump AppID = 2394010",
  "[2026.07.31-11.02.44] LogPal: Loading world save: 38B9F97D...",
  "[2026.07.31-11.03.12] LogPal: World loaded in 27.8s (5188 pals, 7 bases)",
  "[2026.07.31-11.03.12] LogPal: REST API listening on 0.0.0.0:8212",
  "[2026.07.31-11.03.12] LogPal: RCON listening on 0.0.0.0:25575",
  "[2026.07.31-11.03.13] LogPal: Session established. Server started.",
  "[2026.07.31-18.13.51] LogPal: Player joined: Aster (Lv.73)",
  "[2026.07.31-18.14.09] LogPal: Player joined: Juniper (Lv.78)",
  "[2026.07.31-18.40.00] LogPal: Autosave complete (2.1s)",
];

function steamStatus(): SteamUpdateStatus {
  let job: SteamJob | null = state.steamJob;
  if (state.steamJob && Date.now() - state.steamJob._t0 > 7000 && state.steamJob.state === "running") {
    state.steamJob = {
      ...state.steamJob,
      state: "done",
      finishedAt: new Date().toISOString(),
      log: [
        ...(state.steamJob.log ?? []),
        " Update state (0x61) downloading, progress: 84.31 (1443161239 / 1711890453)",
        " Update state (0x81) verifying update, progress: 44.29 (758228116 / 1711890453)",
        "Success! App '2394010' fully installed.",
      ],
    };
    job = state.steamJob;
  }
  return {
    job,
    agent: { version: "0.6.1", apiVersion: 3, mode: "companion", installDirOk: true, diskFreeBytes: 412_316_860_416 },
  };
}

// ---------------------------------------------------------------------------
// The router. Method + path in, exactly what the real API would return out.

const ME: Me = { username: "demo", role: "admin", isAdmin: true, permissions: [] };

export async function demoRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const [route, queryString] = path.split("?");
  const q = new URLSearchParams(queryString);
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  // A whisper of latency so loading states render like the real thing.
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
  return (await route_(route, method, q, body)) as T;
}

async function route_(route: string, method: string, q: URLSearchParams, body: any): Promise<unknown> {
  // --- session ---
  if (route === "/login" && method === "POST") return { username: "demo" };
  if (route === "/logout" && method === "POST") return undefined;
  if (route === "/me") return ME;
  if (route === "/me/password" && method === "POST") return undefined;

  // --- users (admin screens) ---
  if (route === "/users" && method === "GET") return state.users;
  if (route === "/users" && method === "POST") {
    const u: AppUser = { id: state.nextUserId++, username: body.username, role: body.role, permissions: body.permissions ?? [], disabled: false };
    state.users.push(u);
    return u;
  }
  const userMatch = route.match(/^\/users\/(\d+)$/);
  if (userMatch) {
    const u = state.users.find((x) => x.id === +userMatch[1]);
    if (!u) throw new ApiError(404, "no such user");
    if (method === "DELETE") {
      state.users = state.users.filter((x) => x !== u);
      return undefined;
    }
    Object.assign(u, { role: body.role, permissions: body.permissions ?? u.permissions, disabled: body.disabled ?? u.disabled });
    if (body.username) u.username = body.username;
    return u;
  }

  // --- servers ---
  if (route === "/servers" && method === "GET") return [SERVER];
  if (route === "/servers" && method === "POST") throw new ApiError(403, "the demo has a fixed server list");
  if (route === "/servers/provision/defaults") return { available: false };
  if (route === "/servers/provision/discover") return { available: false, servers: [] };
  if (route === "/servers/provision" && method === "POST") throw new ApiError(403, "provisioning is disabled in the demo");
  if (route === "/servers/1" && method === "GET") return SERVER;
  if (route === "/servers/1" && method === "PUT") return SERVER;
  if (route === "/servers/1" && method === "DELETE") throw new ApiError(403, "the demo server can't be deleted");

  // --- live server data ---
  if (route === "/servers/1/info") return serverInfo();
  if (route === "/servers/1/players") return playersOnline();
  if (route === "/servers/1/metrics") return metrics();
  if (route === "/servers/1/metrics/history") return metricsHistory(+(q.get("minutes") ?? 60));
  if (route === "/servers/1/settings") {
    if (!state.containerRunning) unreachable();
    return restSettings();
  }

  // --- save-file data ---
  if (route === "/servers/1/pals" || route === "/servers/1/guilds") return world();
  if (route === "/servers/1/inventory") return inventory();
  if (route === "/servers/1/storage") return storage(q.get("world") === "1");
  if (route === "/servers/1/visibility" && method === "GET") return visibility();
  if (route === "/servers/1/visibility" && method === "PUT") {
    const input = body as VisibilityInput;
    SERVER.hiddenFeatures = input.hiddenFeatures ?? [];
    state.hidePrivateStorage = Boolean(input.hidePrivateStorage);
    state.playerVisibility = input.players ?? {};
    return undefined;
  }

  // --- activity + audit ---
  if (route === "/servers/1/activity") return activity(+(q.get("hours") ?? 24));
  if (route === "/servers/1/audit") return { entries: AUDIT };

  // --- container power ---
  if (route === "/servers/1/container" && method === "GET") return container();
  const power = route.match(/^\/servers\/1\/container\/(start|stop|restart)$/);
  if (power && method === "POST") {
    state.containerRunning = power[1] !== "stop";
    if (power[1] !== "stop") state.containerStartedAt = new Date().toISOString();
    return container();
  }
  if (route === "/servers/1/container/logs") return { lines: CONTAINER_LOGS.slice(-(+(q.get("tail") ?? 100))) };

  // --- game actions: accept and do nothing, like a very agreeable server ---
  if (["/servers/1/broadcast", "/servers/1/kick", "/servers/1/ban", "/servers/1/unban", "/servers/1/save", "/servers/1/shutdown"].includes(route) && method === "POST") {
    if (!state.containerRunning) unreachable();
    return undefined;
  }

  // --- steam repair/update ---
  if (route === "/servers/1/steam-cache/clear" && method === "POST") return { removed: 412 };
  if (route === "/servers/1/steam/update" && method === "GET") return steamStatus();
  if (route === "/servers/1/steam/update" && method === "POST") {
    if (state.containerRunning) throw new ApiError(409, "stop the server before updating");
    state.steamJob = {
      id: `demo-${Date.now()}`,
      kind: "update",
      state: "running",
      startedAt: new Date().toISOString(),
      log: ["Redirecting stderr to '/palworld/steam/logs/stderr.txt'", " Update state (0x61) downloading, progress: 12.05 (206305480 / 1711890453)"],
      _t0: Date.now(),
    };
    return { job: state.steamJob };
  }

  // --- config editor ---
  if (route === "/servers/1/config" && method === "GET") {
    return { settings: configSettings(), path: "/config/verdant-isle/PalWorldSettings.ini", writable: true } satisfies ConfigResult;
  }
  if (route === "/servers/1/config" && method === "PUT") {
    for (const s of configSettings()) {
      if (body.changes[s.key] !== undefined) s.value = String(body.changes[s.key]);
    }
    return { settings: configSettings(), path: "/config/verdant-isle/PalWorldSettings.ini", writable: true } satisfies ConfigResult;
  }

  // --- automation ---
  if (route === "/servers/1/automation") return automation();
  if (route === "/servers/1/schedules" && method === "POST") {
    const s: RestartSchedule = { id: state.nextScheduleId++, ...body, lastRunAt: null, nextRunAt: null };
    state.schedules.push(s);
    return s;
  }
  const schedMatch = route.match(/^\/servers\/1\/schedules\/(\d+)$/);
  if (schedMatch) {
    const s = state.schedules.find((x) => x.id === +schedMatch[1]);
    if (!s) throw new ApiError(404, "no such schedule");
    if (method === "DELETE") {
      state.schedules = state.schedules.filter((x) => x !== s);
      return undefined;
    }
    Object.assign(s, body);
    return s;
  }
  if (route === "/servers/1/discord" && method === "PUT") {
    state.discord = { configured: true, enabled: body.enabled, onStatus: body.onStatus, onPlayers: body.onPlayers, onRestarts: body.onRestarts };
    return state.discord;
  }
  if (route === "/servers/1/discord" && method === "DELETE") {
    state.discord = { configured: false, enabled: false, onStatus: false, onPlayers: false, onRestarts: false };
    return undefined;
  }
  if (route === "/servers/1/discord/test" && method === "POST") return undefined;
  if (route === "/servers/1/watchdog" && method === "PUT") {
    state.watchdog = body.enabled;
    return { enabled: state.watchdog };
  }
  if (route === "/servers/1/public" && method === "PUT") {
    state.publicStatus = body.enabled;
    return { enabled: state.publicStatus, token: "demo" };
  }

  // --- backups ---
  if (route === "/servers/1/backups" && method === "GET") return backups();
  if (route === "/servers/1/backups/settings" && method === "PUT") return { intervalHours: body.intervalHours, keep: body.keep };
  if (route === "/servers/1/backups/run" && method === "POST") {
    state.backupRunAt = new Date().toISOString();
    return undefined;
  }
  if (route.match(/^\/servers\/1\/backups\/[^/]+$/) && method === "DELETE") return undefined;

  // --- public status page ---
  if (route === "/public/status/demo") {
    return {
      name: "Verdant Isle",
      online: state.containerRunning,
      players: state.containerRunning ? 2 : undefined,
      maxPlayers: state.containerRunning ? 32 : undefined,
      nextRestartAt: state.schedules[0]?.nextRunAt ?? undefined,
    } satisfies PublicStatus;
  }

  throw new ApiError(404, `demo: no handler for ${method} ${route}`);
}
