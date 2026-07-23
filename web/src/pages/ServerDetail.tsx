import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Player } from "../lib/api";
import { PlayerList } from "../components/PlayerList";
import { ActionsPanel } from "../components/ActionsPanel";

export function ServerDetail() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const queryClient = useQueryClient();

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
  });

  const invalidatePlayers = () => queryClient.invalidateQueries({ queryKey: ["server-players", id] });

  const broadcast = useMutation({ mutationFn: (message: string) => api.broadcast(id, message) });
  const save = useMutation({ mutationFn: () => api.save(id) });
  const shutdown = useMutation({
    mutationFn: ({ waitSeconds, message }: { waitSeconds: number; message: string }) => api.shutdown(id, waitSeconds, message),
  });
  const kick = useMutation({
    mutationFn: (p: Player) => api.kick(id, p.playerId, "Kicked by admin"),
    onSuccess: invalidatePlayers,
  });
  const ban = useMutation({
    mutationFn: (p: Player) => api.ban(id, p.playerId, "Banned by admin"),
    onSuccess: invalidatePlayers,
  });

  if (serverQuery.isLoading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-red-400">Server not found.</p>;

  const server = serverQuery.data;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <Link to="/" className="text-sm text-slate-400 hover:text-slate-200">
        &larr; Back
      </Link>
      <div className="mt-2 mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{server.name}</h1>
          <p className="text-sm text-slate-400">
            {server.host} &middot; {infoQuery.data?.version ?? (infoQuery.isError ? "unreachable" : "checking...")}
          </p>
        </div>
      </div>

      <section className="mb-6 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Players</h2>
        {playersQuery.isLoading && <p className="text-sm text-slate-500">Loading players...</p>}
        {playersQuery.isError && <p className="text-sm text-red-400">Could not reach server.</p>}
        {playersQuery.data && (
          <PlayerList players={playersQuery.data} onKick={(p) => kick.mutate(p)} onBan={(p) => ban.mutate(p)} />
        )}
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Actions</h2>
        <ActionsPanel
          onBroadcast={(message) => broadcast.mutate(message)}
          onSave={() => save.mutate()}
          onShutdown={(waitSeconds, message) => shutdown.mutate({ waitSeconds, message })}
        />
      </section>
    </div>
  );
}
