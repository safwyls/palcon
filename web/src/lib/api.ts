export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const isJSON = res.headers.get("content-type")?.includes("application/json");
  const body = isJSON ? await res.json() : undefined;

  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String(body.error) : res.statusText;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const PERMISSIONS = ["power", "broadcast", "save", "moderate", "shutdown"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Human labels for the permission checkboxes, and what each actually allows. */
export const PERMISSION_LABELS: Record<Permission, { label: string; help: string }> = {
  power: { label: "Power", help: "Start, stop and restart the server container" },
  broadcast: { label: "Broadcast", help: "Send in-game messages" },
  save: { label: "Save world", help: "Trigger a world save" },
  moderate: { label: "Moderate", help: "Kick, ban and unban players" },
  shutdown: { label: "In-game shutdown", help: "Shut the server down with a countdown" },
};

export interface Me {
  username: string;
  role: string;
  isAdmin: boolean;
  permissions: Permission[];
}

export interface AppUser {
  id: number;
  username: string;
  role: string;
  permissions: Permission[];
  disabled: boolean;
}

export interface UserWriteInput {
  username?: string;
  password?: string;
  role: string;
  permissions: Permission[];
  disabled?: boolean;
}

export interface ContainerState {
  name: string;
  status: string;
  running: boolean;
  startedAt: string;
  exitCode: number;
}

export interface Server {
  id: number;
  name: string;
  host: string;
  rconPort: number;
  hasRconPassword: boolean;
  restPort: number;
  hasRestPassword: boolean;
  useRest: boolean;
  enabled: boolean;
  savePath: string;
  containerName: string;
}

export interface ServerWriteInput {
  name: string;
  host: string;
  rconPort: number;
  rconPassword?: string;
  restPort: number;
  restPassword?: string;
  useRest: boolean;
  enabled: boolean;
  savePath: string;
  containerName: string;
}

export interface ServerInfo {
  servername: string;
  version: string;
  playerCount: number;
  transport: "rest" | "rcon";
}

export interface Player {
  name: string;
  playerId: string;
  userId: string;
  level: number;
  ping: number;
  location_x: number;
  location_y: number;
}

export interface Metrics {
  serverfps: number;
  serverframetime: number;
  currentplayernum: number;
  maxplayernum: number;
  uptime: number;
  days: number;
}

export type Settings = Record<string, unknown>;

/** One collected sample. Nulls are real gaps — the server was unreachable
 * or reported nothing — and must break the line rather than plot as zero. */
export interface MetricPoint {
  ts: string;
  playerCount: number | null;
  maxPlayers: number | null;
  serverFps: number | null;
  frameTime: number | null;
}

export interface MetricsHistory {
  points: MetricPoint[];
  /** Collection cadence, so the chart can tell a gap from sparse sampling. */
  intervalSeconds: number;
}

export interface Pal {
  instanceId: string;
  characterId: string;
  nickname: string;
  level: number;
  gender: "male" | "female" | "";
  isBoss: boolean;
  isLucky: boolean;
  rank: number;
  talentHp: number;
  talentShot: number;
  talentDefense: number;
  passives: string[];
  exp: number;
  skills: string[];
  hp: number;
  sanity: number;
  stomach: number;
  friendship: number;
  /** Ailment name, or "" when healthy. A sick pal stops working at a base. */
  sick: string;
  /** Soul upgrades applied, keyed by stat name. */
  souls: Record<string, number>;
  slotIndex: number;
}

export interface PlayerPals {
  uid: string;
  nickname: string;
  level: number;
  party: Pal[];
  palbox: Pal[];
  base: Pal[];
  /** Unix seconds; 0 when the save recorded none. */
  lastOnline: number;
  /** Where they logged off, in the same world space the map plots. */
  lastX: number | null;
  lastY: number | null;
  platform: string;
  technologyPoints: number;
}

export interface GuildMember {
  uid: string;
  name: string;
}

export interface Guild {
  id: string;
  name: string;
  baseCampLevel: number;
  members: GuildMember[];
  memberCount: number;
  bases: { x: number; y: number }[];
}

export interface GuildsResult {
  guilds: Guild[];
  players: PlayerPals[];
  parsedAt: string;
  saveModTime: string;
}

export interface PalsResult {
  players: PlayerPals[];
  guilds: Guild[];
  parsedAt: string;
  saveModTime: string;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ username: string }>("/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<void>("/logout", { method: "POST" }),
  me: () => request<Me>("/me"),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    request<void>("/me/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),

  listUsers: () => request<AppUser[]>("/users"),
  createUser: (input: UserWriteInput) => request<AppUser>("/users", { method: "POST", body: JSON.stringify(input) }),
  updateUser: (id: number, input: UserWriteInput) =>
    request<AppUser>(`/users/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteUser: (id: number) => request<void>(`/users/${id}`, { method: "DELETE" }),

  containerStatus: (id: number) => request<ContainerState>(`/servers/${id}/container`),
  containerAction: (id: number, action: "start" | "stop" | "restart") =>
    request<ContainerState>(`/servers/${id}/container/${action}`, { method: "POST" }),

  listServers: () => request<Server[]>("/servers"),
  getServer: (id: number) => request<Server>(`/servers/${id}`),
  createServer: (input: ServerWriteInput) => request<Server>("/servers", { method: "POST", body: JSON.stringify(input) }),
  updateServer: (id: number, input: ServerWriteInput) =>
    request<Server>(`/servers/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteServer: (id: number) => request<void>(`/servers/${id}`, { method: "DELETE" }),

  serverInfo: (id: number) => request<ServerInfo>(`/servers/${id}/info`),
  serverPlayers: (id: number) => request<Player[]>(`/servers/${id}/players`),
  broadcast: (id: number, message: string) =>
    request<void>(`/servers/${id}/broadcast`, { method: "POST", body: JSON.stringify({ message }) }),
  kick: (id: number, playerUid: string, message: string) =>
    request<void>(`/servers/${id}/kick`, { method: "POST", body: JSON.stringify({ playerUid, message }) }),
  ban: (id: number, playerUid: string, message: string) =>
    request<void>(`/servers/${id}/ban`, { method: "POST", body: JSON.stringify({ playerUid, message }) }),
  unban: (id: number, playerUid: string) =>
    request<void>(`/servers/${id}/unban`, { method: "POST", body: JSON.stringify({ playerUid }) }),
  save: (id: number) => request<void>(`/servers/${id}/save`, { method: "POST" }),
  shutdown: (id: number, waitSeconds: number, message: string) =>
    request<void>(`/servers/${id}/shutdown`, { method: "POST", body: JSON.stringify({ waitSeconds, message }) }),

  // REST-only — throws a 400 ApiError for servers configured RCON-only.
  serverSettings: (id: number) => request<Settings>(`/servers/${id}/settings`),
  serverMetrics: (id: number) => request<Metrics>(`/servers/${id}/metrics`),
  serverMetricsHistory: (id: number, minutes: number) =>
    request<MetricsHistory>(`/servers/${id}/metrics/history?minutes=${minutes}`),

  // Save-file-backed (phase 5) — throws a 400 ApiError when the server has
  // no save path configured.
  serverPals: (id: number) => request<PalsResult>(`/servers/${id}/pals`),
  serverGuilds: (id: number) => request<GuildsResult>(`/servers/${id}/guilds`),
};
