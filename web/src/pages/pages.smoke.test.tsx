import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { makeQueryClient, makeServer } from "../test/utils";

/**
 * Smoke tests: every route renders against an empty-but-valid API without
 * throwing. They are deliberately shallow — the logic these pages sit on is
 * covered directly in src/lib — but they catch the class of break a type
 * checker can't see: a hook order violation, a missing provider, a `.map`
 * on something the API doesn't actually return.
 */

// Permissive stub: any api.* call resolves to a shape the pages tolerate.
// Named entries below override it where a page needs real structure.
const overrides: Record<string, unknown> = {
  me: { username: "admin", isAdmin: true, permissions: [] },
  listServers: [makeServer()],
  getServer: makeServer(),
  serverInfo: { servername: "Palhalla", playerCount: 0, transport: "rest" },
  serverPlayers: [],
  listUsers: [],
  containerStatus: { name: "palagent-main", status: "running", running: true },
  containerLogs: { lines: [] },
  serverMetrics: {
    serverfps: 60,
    serverframetime: 16.6,
    currentplayernum: 0,
    maxplayernum: 32,
    uptime: 3600,
    days: 1,
  },
  serverMetricsHistory: { points: [] },
  serverActivity: { events: [], hours: 48, intervalSeconds: 30 },
  serverAudit: { entries: [] },
  serverAutomation: {
    schedules: [],
    discord: { configured: false, enabled: false, onStatus: false, onPlayers: false, onRestarts: false },
    watchdog: { enabled: false, available: false },
    dockerRestart: false,
    publicStatus: { enabled: false },
  },
  listBackups: { snapshots: [], intervalHours: 0, keep: 3, running: false },
  provisionDefaults: { available: false },
  provisionDiscover: { available: false, servers: [] },
  // Shaped to the real DTOs, not to whatever a page happens to read. A stub
  // missing a field the API contract guarantees makes the page look broken
  // when it is the stub that lied — and worse, an over-narrow stub would
  // let a genuine crash hide behind an expected one.
  serverPals: { players: [], guilds: [], parsedAt: "", saveModTime: "" },
  serverGuilds: { guilds: [], players: [], parsedAt: "", saveModTime: "" },
  serverInventory: { players: [], parsedAt: "", saveModTime: "" },
  serverStorage: {
    containers: [],
    bases: [],
    guilds: [],
    includesWorld: false,
    includesPrivate: true,
    parsedAt: "",
    saveModTime: "",
  },
  serverAchievements: { players: [], parsedAt: "", saveModTime: "" },
  serverSettings: {},
  serverConfig: { settings: [], raw: "" },
  steamUpdateStatus: { running: false },
  serverVisibility: {
    hiddenFeatures: [],
    hidePrivateStorage: false,
    players: {},
    roster: [],
    rosterUnavailable: false,
    allFeatures: [],
    allStreams: [],
  },
  publicStatus: { name: "Palhalla", online: false },
};

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const stub = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "backupDownloadURL") return () => "";
        return () => Promise.resolve(prop in overrides ? overrides[prop] : []);
      },
    },
  );
  return { ...actual, api: stub };
});

import { AuthProvider } from "../lib/auth";
import { EmptyState } from "./EmptyState";
import { Login } from "./Login";
import { PublicStatus } from "./PublicStatus";
import { ServerAchievements } from "./ServerAchievements";
import { ServerActivity } from "./ServerActivity";
import { ServerAutomation } from "./ServerAutomation";
import { ServerCalculators } from "./ServerCalculators";
import { ServerConfig } from "./ServerConfig";
import { ServerDashboard } from "./ServerDashboard";
import { ServerGuilds } from "./ServerGuilds";
import { ServerInventory } from "./ServerInventory";
import { ServerMap } from "./ServerMap";
import { ServerPaldex } from "./ServerPaldex";
import { ServerPlayers } from "./ServerPlayers";
import { ServerStorage } from "./ServerStorage";
import { Users } from "./Users";

/** Renders a page at a route that supplies the params it reads, returning
 * the query client so a test can wait for the data to actually arrive. */
function renderAt(ui: ReactElement, pattern: string, path: string) {
  const client = makeQueryClient();
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[path]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <AuthProvider>
          <Routes>
            <Route path={pattern} element={ui} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, client };
}

const SERVER_ROUTE = "/servers/:serverID";
const SERVER_PATH = "/servers/1";

const pages: [string, ReactElement, string, string][] = [
  ["EmptyState", <EmptyState />, "/", "/"],
  ["Login", <Login />, "/login", "/login"],
  ["PublicStatus", <PublicStatus />, "/status/:token", "/status/abc"],
  ["Users", <Users />, "/users", "/users"],
  ["ServerDashboard", <ServerDashboard />, SERVER_ROUTE, SERVER_PATH],
  ["ServerActivity", <ServerActivity />, SERVER_ROUTE, SERVER_PATH],
  ["ServerAutomation", <ServerAutomation />, SERVER_ROUTE, SERVER_PATH],
  ["ServerPlayers", <ServerPlayers />, SERVER_ROUTE, SERVER_PATH],
  ["ServerPaldex", <ServerPaldex />, SERVER_ROUTE, SERVER_PATH],
  ["ServerGuilds", <ServerGuilds />, SERVER_ROUTE, SERVER_PATH],
  ["ServerInventory", <ServerInventory />, SERVER_ROUTE, SERVER_PATH],
  ["ServerStorage", <ServerStorage />, SERVER_ROUTE, SERVER_PATH],
  ["ServerAchievements", <ServerAchievements />, SERVER_ROUTE, SERVER_PATH],
  ["ServerCalculators", <ServerCalculators />, SERVER_ROUTE, SERVER_PATH],
  ["ServerConfig", <ServerConfig />, SERVER_ROUTE, SERVER_PATH],
  ["ServerMap", <ServerMap />, SERVER_ROUTE, SERVER_PATH],
];

/** React and testing-library warnings that say nothing about the page. */
const BENIGN = [/not wrapped in act/i, /React Router Future Flag/i];

describe("page smoke tests", () => {
  let errors: string[];

  beforeEach(() => {
    // Captured rather than silenced: a page that renders a tree and logs a
    // React error has not passed, and swallowing it here would hide exactly
    // the failures these tests exist to catch.
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const msg = args.map(String).join(" ");
      if (!BENIGN.some((re) => re.test(msg))) errors.push(msg);
    });
  });

  for (const [name, element, pattern, path] of pages) {
    it(`${name} renders without throwing`, async () => {
      const { container, client } = renderAt(element, pattern, path);

      // Wait for the data to actually arrive. Asserting on `container`
      // (always truthy) resolved on the first tick and left every
      // data-driven path unexercised — which is the half where the
      // ServerConfig render loop lived.
      await waitFor(() => expect(client.isFetching()).toBe(0));

      expect(container.innerHTML.length).toBeGreaterThan(0);
      expect(errors, `${name} logged React errors`).toEqual([]);
    });
  }

  it("Login shows the fields a person needs to sign in", async () => {
    renderAt(<Login />, "/login", "/login");
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });
});
