import { useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LogOut, MoreVertical, Pencil, Plus, Power, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type Server } from "../lib/api";
import { useAuth } from "../lib/auth";
import { serverColor, initials } from "../lib/palette";
import { cn } from "../lib/utils";
import { ServerSphere } from "./ServerSphere";
import { ServerFormDialog } from "./ServerFormDialog";
import { DeleteServerDialog } from "./DeleteServerDialog";
import { ShutdownDialog } from "./ServerActionDialogs";

const segmentClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex-1 rounded-lg py-1.5 text-center text-sm font-semibold transition",
    isActive ? "bg-brand-red text-paper" : "text-paper/60",
  );

/** Mobile top bar: active server identity, Dashboard/Live map segmented control,
 * and an overflow menu carrying the actions that have no other mobile home. */
export function MobileTopBar({ server }: { server: Server | null }) {
  const { username, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);

  const infoQuery = useQuery({
    queryKey: ["server-info", server?.id],
    queryFn: () => api.serverInfo(server!.id),
    retry: false,
    staleTime: 15_000,
    enabled: server !== null,
  });

  const save = useMutation({
    mutationFn: () => api.save(server!.id),
    onSuccess: () => toast.success("World saved"),
    onError: () => toast.error("Save failed"),
  });

  const menuItem =
    "flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm text-ink hover:bg-ink/5 transition-colors";

  return (
    <div className="shrink-0 bg-ink px-4 pb-3 pt-4 text-paper">
      <div className="flex items-center justify-between">
        {server ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="sphere-ring h-9 w-9 shrink-0 rounded-full p-[2px]"
              style={{ "--ring-color": serverColor(server.id) } as React.CSSProperties}
            >
              <span className="flex h-full w-full items-center justify-center rounded-full bg-ink-light font-display text-xs font-bold">
                {initials(server.name)}
              </span>
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-sm font-bold leading-tight">{server.name}</p>
              <p className="font-mono text-[11px] text-paper/50">
                {infoQuery.isSuccess
                  ? `${infoQuery.data.playerCount} online`
                  : infoQuery.isError
                    ? "unreachable"
                    : "checking..."}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <div className="clip-notch h-8 w-8 rounded-full bg-gradient-to-br from-brand-red to-brand-amber" />
            <p className="font-display text-sm font-bold">Palcon</p>
          </div>
        )}

        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-sm text-paper/70"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-10 z-30 w-52 overflow-hidden rounded-xl border border-ink/10 bg-paper text-ink shadow-lg">
                {server && (
                  <>
                    <button
                      className={menuItem}
                      onClick={() => {
                        setMenuOpen(false);
                        save.mutate();
                      }}
                    >
                      <Save className="h-4 w-4 text-ink/50" /> Save world
                    </button>
                    <button
                      className={menuItem}
                      onClick={() => {
                        setMenuOpen(false);
                        setShutdownOpen(true);
                      }}
                    >
                      <Power className="h-4 w-4 text-brand-red" /> Shut down…
                    </button>
                    <button
                      className={menuItem}
                      onClick={() => {
                        setMenuOpen(false);
                        setEditOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4 text-ink/50" /> Edit server…
                    </button>
                    <button
                      className={menuItem}
                      onClick={() => {
                        setMenuOpen(false);
                        setDeleteOpen(true);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-ink/50" /> Remove server…
                    </button>
                    <div className="border-t border-ink/10" />
                  </>
                )}
                <button
                  className={menuItem}
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                  }}
                >
                  <LogOut className="h-4 w-4 text-ink/50" /> Log out {username}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {server && (
        <div className="mt-3 flex rounded-xl bg-white/10 p-1">
          <NavLink to={`/servers/${server.id}`} end className={segmentClass}>
            Dashboard
          </NavLink>
          <NavLink to={`/servers/${server.id}/map`} className={segmentClass}>
            Live map
          </NavLink>
          <NavLink to={`/servers/${server.id}/players`} className={segmentClass}>
            Pals
          </NavLink>
        </div>
      )}

      {server && (
        <>
          <ShutdownDialog serverId={server.id} open={shutdownOpen} onOpenChange={setShutdownOpen} />
          <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} mode="edit" server={server} />
          <DeleteServerDialog server={server} open={deleteOpen} onOpenChange={setDeleteOpen} />
        </>
      )}
    </div>
  );
}

/** Mobile bottom bar: Pal Sphere per server + add button. */
export function MobileBottomRail({ servers, activeServerId }: { servers: Server[]; activeServerId: number | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [addOpen, setAddOpen] = useState(false);

  const goToServer = (id: number) => {
    navigate(location.pathname.endsWith("/map") ? `/servers/${id}/map` : `/servers/${id}`);
  };

  return (
    <div className="flex shrink-0 items-center justify-around border-t border-black/20 bg-ink py-2.5">
      {servers.map((server) => (
        <ServerSphere
          key={server.id}
          server={server}
          size="sm"
          active={server.id === activeServerId}
          onClick={() => goToServer(server.id)}
        />
      ))}
      <button
        onClick={() => setAddOpen(true)}
        className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-white/20 text-paper/40"
      >
        <Plus className="h-4 w-4" />
      </button>
      <ServerFormDialog open={addOpen} onOpenChange={setAddOpen} mode="create" />
    </div>
  );
}
