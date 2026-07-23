import { useEffect } from "react";
import { Outlet, useMatch } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { preloadMapTextures } from "../lib/map";
import { ServerRail } from "./ServerRail";
import { ServerSubNav } from "./ServerSubNav";
import { MobileTopBar, MobileBottomRail } from "./MobileChrome";

/**
 * App chrome, per mocks/dashboard.html + mobile.html:
 * - Desktop (lg+): [icon rail][server sub-nav][content] — Discord-style
 *   server switching via Pal Sphere buttons, dark two-column nav.
 * - Mobile: [top bar w/ segmented view control][content][bottom server rail].
 * Which server is active comes from the route, so back/forward and deep
 * links keep working with no separate selection state.
 */
export function AppShell() {
  const match = useMatch("/servers/:serverID/*");
  const activeServerId = match ? Number(match.params.serverID) : null;

  const serversQuery = useQuery({ queryKey: ["servers"], queryFn: api.listServers });
  const servers = serversQuery.data ?? [];
  const activeServer = servers.find((s) => s.id === activeServerId) ?? null;

  useEffect(() => {
    preloadMapTextures();
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <div className="hidden lg:flex">
        <ServerRail servers={servers} activeServerId={activeServerId} />
        {activeServer && <ServerSubNav server={activeServer} />}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="lg:hidden">
          <MobileTopBar server={activeServer} />
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <div className="lg:hidden">
          <MobileBottomRail servers={servers} activeServerId={activeServerId} />
        </div>
      </div>
    </div>
  );
}
