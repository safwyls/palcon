import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { api, type Server } from "../lib/api";
import { formatUptime } from "../lib/palette";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { ServerFormDialog } from "./ServerFormDialog";
import { DeleteServerDialog } from "./DeleteServerDialog";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
    isActive
      ? "border border-brand-red/25 bg-brand-red/15 font-semibold text-brand-red"
      : "text-paper/60 hover:bg-white/5 hover:text-paper",
  );

/** Desktop second column: the active server's identity + view navigation. */
export function ServerSubNav({ server }: { server: Server }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const infoQuery = useQuery({
    queryKey: ["server-info", server.id],
    queryFn: () => api.serverInfo(server.id),
    retry: false,
    staleTime: 15_000,
  });
  // Uptime footer needs REST metrics; RCON-only servers just omit the footer.
  const metricsQuery = useQuery({
    queryKey: ["server-metrics", server.id],
    queryFn: () => api.serverMetrics(server.id),
    retry: false,
    refetchInterval: 60_000,
  });

  const transport = infoQuery.data?.transport;
  const port = server.useRest ? server.restPort : server.rconPort;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-black/20 bg-ink-light text-paper">
      <div className="group border-b border-white/10 px-5 py-5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 flex-1 truncate font-display text-lg font-bold leading-tight">{server.name}</p>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <button
              className="rounded p-1 text-paper/50 hover:bg-white/10 hover:text-paper"
              title="Edit server"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded p-1 text-paper/50 hover:bg-white/10 hover:text-brand-red"
              title="Remove server"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              infoQuery.isSuccess ? "bg-pal-green" : infoQuery.isError ? "bg-brand-red" : "bg-white/20",
            )}
          />
          <span className="truncate font-mono text-xs text-paper/60">
            {server.host}:{port}
          </span>
          {transport && (
            <Badge
              variant="outline"
              className={cn(
                "px-1 py-0 font-mono text-[10px]",
                transport === "rest"
                  ? "border-pal-blue/40 bg-pal-blue/15 text-pal-blue"
                  : "border-brand-amber/40 bg-brand-amber/15 text-brand-amber",
              )}
            >
              {transport.toUpperCase()}
            </Badge>
          )}
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        <NavLink to={`/servers/${server.id}`} end className={navLinkClass}>
          Dashboard
        </NavLink>
        <NavLink to={`/servers/${server.id}/map`} className={navLinkClass}>
          Live map
        </NavLink>
        <span className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-paper/30">
          Player details
          <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-paper/30">soon</span>
        </span>
      </nav>

      {metricsQuery.isSuccess && (
        <div className="border-t border-white/10 px-5 py-4 font-mono text-xs text-paper/40">
          Uptime · {formatUptime(metricsQuery.data.uptime)}
        </div>
      )}

      <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} mode="edit" server={server} />
      <DeleteServerDialog server={server} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </aside>
  );
}
