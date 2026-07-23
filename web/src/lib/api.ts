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
}

export interface PlayerPals {
  uid: string;
  nickname: string;
  level: number;
  party: Pal[];
  palbox: Pal[];
  base: Pal[];
}

export interface PalsResult {
  players: PlayerPals[];
  parsedAt: string;
  saveModTime: string;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ username: string }>("/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<void>("/logout", { method: "POST" }),
  me: () => request<{ username: string }>("/me"),

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
};
