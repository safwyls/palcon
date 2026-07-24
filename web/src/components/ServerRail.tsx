import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LogOut, Plus, Users as UsersIcon } from "lucide-react";
import { type Server } from "../lib/api";
import { useAuth } from "../lib/auth";
import { cn } from "../lib/utils";
import { ServerSphere } from "./ServerSphere";
import { ServerFormDialog } from "./ServerFormDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Desktop icon rail: logo orb, one Pal Sphere per server, add button, logout. */
export function ServerRail({ servers, activeServerId }: { servers: Server[]; activeServerId: number | null }) {
  const { username, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [addOpen, setAddOpen] = useState(false);

  // Switching servers keeps the current view: from a map, land on the new
  // server's map; otherwise its dashboard.
  const goToServer = (id: number) => {
    navigate(location.pathname.endsWith("/map") ? `/servers/${id}/map` : `/servers/${id}`);
  };

  return (
    <aside className="flex w-[72px] shrink-0 flex-col items-center gap-3 border-r border-black/20 bg-ink py-4">
      <div className="clip-notch mb-2 h-9 w-9 rounded-full bg-gradient-to-br from-brand-red to-brand-amber" title="Palcon" />

      {servers.map((server) => (
        <ServerSphere
          key={server.id}
          server={server}
          active={server.id === activeServerId}
          onClick={() => goToServer(server.id)}
        />
      ))}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setAddOpen(true)}
            className="mt-1 flex h-11 w-11 items-center justify-center rounded-full border-2 border-dashed border-white/20 text-paper/40 transition hover:border-white/40 hover:text-paper/70"
          >
            <Plus className="h-5 w-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Add server</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      {isAdmin && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => navigate("/users")}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-full transition",
                location.pathname === "/users"
                  ? "bg-white/10 text-paper"
                  : "text-paper/40 hover:bg-white/10 hover:text-paper",
              )}
            >
              <UsersIcon className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Users</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => logout()}
            className="flex h-10 w-10 items-center justify-center rounded-full text-paper/40 transition hover:bg-white/10 hover:text-paper"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Log out {username}</TooltipContent>
      </Tooltip>

      <ServerFormDialog open={addOpen} onOpenChange={setAddOpen} mode="create" />
    </aside>
  );
}
