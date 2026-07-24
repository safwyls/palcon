import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, type Player } from "../lib/api";
import { cn } from "../lib/utils";
import { PlayerList } from "../components/PlayerList";
import { ServerMetrics } from "../components/ServerMetrics";
import { ServerPower } from "../components/ServerPower";
import { ServerPerformance } from "../components/ServerPerformance";
import { ServerSettings } from "../components/ServerSettings";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { BroadcastDialog, ShutdownDialog } from "../components/ServerActionDialogs";
import { Input } from "../components/ui/input";

export function ServerDashboard() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [shutdownOpen, setShutdownOpen] = useState(false);
  const [quickMsg, setQuickMsg] = useState("");

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
  });

  const invalidatePlayers = () => queryClient.invalidateQueries({ queryKey: ["server-players", id] });

  // Everything the dashboard shows, refetched together. Each panel polls on
  // its own schedule, so without this the only way to force a fresh read was
  // reloading the page.
  const dashboardQueries = [
    "server-info",
    "server-players",
    "server-metrics",
    "server-metrics-history",
    "server-settings",
    "container",
  ];
  const refreshAll = () =>
    dashboardQueries.forEach((key) => queryClient.invalidateQueries({ queryKey: [key, id] }));
  const fetching = useIsFetching({
    predicate: (q) => q.queryKey[1] === id && dashboardQueries.includes(String(q.queryKey[0])),
  });

  const save = useMutation({
    mutationFn: () => api.save(id),
    onSuccess: () => toast.success("World saved"),
    onError: () => toast.error("Save failed"),
  });
  const quickBroadcast = useMutation({
    mutationFn: (message: string) => api.broadcast(id, message),
    onSuccess: () => {
      toast.success("Broadcast sent");
      setQuickMsg("");
    },
    onError: () => toast.error("Failed to send broadcast"),
  });
  const kick = useMutation({
    mutationFn: (p: Player) => api.kick(id, p.playerId, "Kicked by admin"),
    onSuccess: (_, p) => {
      toast.success(`Kicked ${p.name}`);
      invalidatePlayers();
    },
    onError: (_, p) => toast.error(`Failed to kick ${p.name}`),
  });
  const ban = useMutation({
    mutationFn: (p: Player) => api.ban(id, p.playerId, "Banned by admin"),
    onSuccess: (_, p) => {
      toast.success(`Banned ${p.name}`);
      invalidatePlayers();
    },
    onError: (_, p) => toast.error(`Failed to ban ${p.name}`),
  });

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const server = serverQuery.data;
  const playerCount = playersQuery.data?.length;

  const headerButton = "font-display font-bold text-sm px-4 py-2 rounded-xl clip-notch transition";

  return (
    <div>
      {/* Desktop page header; on mobile the top bar + overflow menu covers this. */}
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Server dashboard</h1>
          <p className="mt-0.5 text-sm text-ink/50">
            {server.name} · {infoQuery.data?.version ?? (infoQuery.isError ? "unreachable" : "checking...")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshAll}
            disabled={fetching > 0}
            title="Refresh dashboard"
            aria-label="Refresh dashboard"
            className="rounded-xl border border-ink/15 bg-white p-2.5 text-ink/60 transition hover:bg-ink/5 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", fetching > 0 && "animate-spin")} />
          </button>
          <button
            className={`${headerButton} border border-ink/15 bg-white text-ink hover:bg-ink/5 disabled:opacity-40`}
            onClick={() => save.mutate()}
            disabled={save.isPending || infoQuery.isError}
          >
            {save.isPending ? "Saving..." : "Save world"}
          </button>
          <button
            className={`${headerButton} bg-brand-red text-paper hover:brightness-110 disabled:opacity-40`}
            onClick={() => setBroadcastOpen(true)}
            disabled={infoQuery.isError}
          >
            Broadcast
          </button>
          <button
            className={`${headerButton} bg-ink text-paper hover:bg-ink-light disabled:opacity-40`}
            onClick={() => setShutdownOpen(true)}
            disabled={infoQuery.isError}
          >
            Shut down
          </button>
        </div>
      </header>

      {infoQuery.isError ? (
        // Power controls stay put when the server is unreachable — a
        // stopped server is precisely when you need the Start button, and
        // rendering only the unreachable art left no way to bring it back.
        <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
          <ServerPower serverId={id} />
          <ServerUnreachable />
        </div>
      ) : (
        <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
          <ServerPower serverId={id} />

          <ServerMetrics serverId={id} />

          <ServerPerformance serverId={id} />

          <div className="grid grid-cols-1 gap-4 lg:gap-6 xl:grid-cols-3">
            <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70 xl:col-span-2">
              <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
                <h2 className="font-display text-base font-bold">Players online</h2>
                {playerCount !== undefined && (
                  <span className="font-mono text-xs text-ink/40">{playerCount} connected</span>
                )}
              </div>
              {playersQuery.isLoading && <p className="px-5 py-4 text-sm text-muted-foreground">Loading players...</p>}
              {playersQuery.isError && <p className="px-5 py-4 text-sm text-destructive">Could not reach server.</p>}
              {playersQuery.data && (
                <PlayerList
                  players={playersQuery.data}
                  onViewMap={(p) => navigate(`/servers/${id}/map?focus=${encodeURIComponent(p.playerId)}`)}
                  onKick={(p) => kick.mutate(p)}
                  onBan={(p) => ban.mutate(p)}
                />
              )}
            </section>

            <section className="space-y-4 rounded-2xl border border-ink/10 bg-white/70 p-5">
              <h2 className="font-display text-base font-bold">Server settings</h2>
              <ServerSettings serverId={id} />

              <div className="border-t border-ink/10 pt-3">
                <label className="text-xs font-semibold uppercase tracking-wide text-ink/40">Broadcast message</label>
                <div className="mt-2 flex gap-2">
                  <Input
                    placeholder="Server restarting in 10 minutes…"
                    value={quickMsg}
                    onChange={(e) => setQuickMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && quickMsg) quickBroadcast.mutate(quickMsg);
                    }}
                  />
                  <button
                    className="rounded-lg bg-brand-red px-4 font-display text-sm font-bold text-paper transition hover:brightness-110 disabled:opacity-50"
                    disabled={!quickMsg || quickBroadcast.isPending}
                    onClick={() => quickBroadcast.mutate(quickMsg)}
                  >
                    Send
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}

      <BroadcastDialog serverId={id} open={broadcastOpen} onOpenChange={setBroadcastOpen} />
      <ShutdownDialog serverId={id} open={shutdownOpen} onOpenChange={setShutdownOpen} />
    </div>
  );
}
