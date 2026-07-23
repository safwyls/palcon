import { Outlet, useMatch } from "react-router-dom";
import { cn } from "../lib/utils";
import { AppSidebar } from "./AppSidebar";

/**
 * Split-pane shell: a persistent sidebar (server list) + main content pane.
 * On screens narrower than `lg`, only one pane shows at a time — which pane
 * is driven by the route itself (server selected -> detail pane; otherwise
 * -> sidebar), so there's no separate mobile navigation state to keep in
 * sync, and the browser back button "just works" for going back to the list.
 */
export function AppShell() {
  const onServerDetail = useMatch("/servers/:serverID/*") !== null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside
        className={cn(
          "w-full shrink-0 border-border lg:block lg:w-64 lg:border-r",
          onServerDetail ? "hidden" : "block",
        )}
      >
        <AppSidebar />
      </aside>
      <main className={cn("min-w-0 flex-1 overflow-y-auto lg:block", onServerDetail ? "block" : "hidden")}>
        <Outlet />
      </main>
    </div>
  );
}
