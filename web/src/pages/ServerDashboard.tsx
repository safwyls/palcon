import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Power, Save } from "lucide-react";
import { toast } from "sonner";
import { api, type Player } from "../lib/api";
import { PlayerList } from "../components/PlayerList";
import { ServerMetrics } from "../components/ServerMetrics";
import { ServerSettings } from "../components/ServerSettings";
import { ServerPageHeader } from "../components/ServerPageHeader";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export function ServerDashboard() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const queryClient = useQueryClient();

  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [shutdownMsg, setShutdownMsg] = useState("Server restarting soon");
  const [shutdownWait, setShutdownWait] = useState(60);

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
  });

  const invalidatePlayers = () => queryClient.invalidateQueries({ queryKey: ["server-players", id] });

  const broadcast = useMutation({
    mutationFn: (message: string) => api.broadcast(id, message),
    onSuccess: () => {
      toast.success("Broadcast sent");
      setBroadcastMsg("");
    },
    onError: () => toast.error("Failed to send broadcast"),
  });
  const save = useMutation({
    mutationFn: () => api.save(id),
    onSuccess: () => toast.success("World saved"),
    onError: () => toast.error("Save failed"),
  });
  const shutdown = useMutation({
    mutationFn: ({ waitSeconds, message }: { waitSeconds: number; message: string }) => api.shutdown(id, waitSeconds, message),
    onSuccess: () => toast.success("Shutdown initiated"),
    onError: () => toast.error("Shutdown failed"),
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

  return (
    <div className="flex h-full flex-col p-4 sm:p-6">
      <ServerPageHeader
        server={server}
        statusText={infoQuery.data?.version ?? (infoQuery.isError ? "unreachable" : "checking...")}
        transport={infoQuery.data?.transport}
        actions={
          <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="h-4 w-4" />
            {save.isPending ? "Saving..." : "Save world"}
          </Button>
        }
      />

      {infoQuery.isError ? (
        <ServerUnreachable />
      ) : (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <ServerMetrics serverId={id} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Players</CardTitle>
          </CardHeader>
          <CardContent>
            {playersQuery.isLoading && <p className="text-sm text-muted-foreground">Loading players...</p>}
            {playersQuery.isError && <p className="text-sm text-destructive">Could not reach server.</p>}
            {playersQuery.data && (
              <PlayerList players={playersQuery.data} onKick={(p) => kick.mutate(p)} onBan={(p) => ban.mutate(p)} />
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Broadcast</CardTitle>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Input
                placeholder="Broadcast message"
                value={broadcastMsg}
                onChange={(e) => setBroadcastMsg(e.target.value)}
              />
              <Button variant="secondary" onClick={() => broadcastMsg && broadcast.mutate(broadcastMsg)}>
                <Megaphone className="h-4 w-4" />
                Send
              </Button>
            </CardContent>
          </Card>

          <Card className="border-destructive/30 bg-destructive/5">
            <CardHeader>
              <CardTitle className="text-destructive">Shutdown server</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <div className="w-24 space-y-1">
                  <Label className="text-xs">Wait (s)</Label>
                  <Input type="number" value={shutdownWait} onChange={(e) => setShutdownWait(Number(e.target.value))} />
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Message</Label>
                  <Input value={shutdownMsg} onChange={(e) => setShutdownMsg(e.target.value)} />
                </div>
              </div>
              <Button
                variant="destructive"
                className="w-full"
                onClick={() => shutdown.mutate({ waitSeconds: shutdownWait, message: shutdownMsg })}
              >
                <Power className="h-4 w-4" />
                Shutdown
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Server settings</CardTitle>
          </CardHeader>
          <CardContent>
            <ServerSettings serverId={id} />
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  );
}
