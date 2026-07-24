import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type Action = "start" | "stop" | "restart";

const CONFIRM: Record<Action, { title: string; body: string; verb: string }> = {
  start: { title: "Start the server?", body: "The container will boot and players can connect once it's up.", verb: "Start" },
  stop: {
    title: "Stop the server?",
    body: "Anyone playing will be disconnected. The container is asked to stop gracefully, so the world is saved first.",
    verb: "Stop",
  },
  restart: {
    title: "Restart the server?",
    body: "Anyone playing will be disconnected and the server will come straight back up.",
    verb: "Restart",
  },
};

/**
 * Start/stop/restart the container the game server runs in.
 *
 * Renders nothing unless the instance has a Docker endpoint and this server
 * has a container name — power control is optional, and a server without it
 * should look no different from before the feature existed.
 */
export function ServerPower({ serverId }: { serverId: number }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Action | null>(null);

  const statusQuery = useQuery({
    queryKey: ["container", serverId],
    queryFn: () => api.containerStatus(serverId),
    retry: false,
    refetchInterval: 15_000,
  });

  const act = useMutation({
    mutationFn: (action: Action) => api.containerAction(serverId, action),
    onSuccess: (_, action) => {
      toast.success(`Server ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}`);
      setConfirming(null);
      queryClient.invalidateQueries({ queryKey: ["container", serverId] });
      // The game server takes a moment to accept connections, so let the
      // reachability probes re-run shortly after.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["server-info", serverId] });
        queryClient.invalidateQueries({ queryKey: ["container", serverId] });
      }, 5000);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Action failed"),
  });

  // Not configured (400) is the normal "feature is off" case, so the card
  // stays hidden rather than showing an error to every user.
  if (statusQuery.isError && statusQuery.error instanceof ApiError && statusQuery.error.status === 400) {
    return null;
  }
  if (statusQuery.isLoading) return null;

  const state = statusQuery.data;
  const running = state?.running ?? false;
  const allowed = can("power");

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-white/70 p-4 lg:p-5">
      <div className="flex items-center gap-3">
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full", running ? "bg-pal-green" : "bg-ink/30")}
          aria-hidden
        />
        <div>
          <p className="font-display text-sm font-bold">
            Container {running ? "running" : (state?.status ?? "unknown")}
          </p>
          <p className="font-mono text-xs text-ink/40">
            {state?.name}
            {statusQuery.isError && " · status unavailable"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {!allowed && <span className="text-xs text-ink/40">You don't have power permission</span>}
        <Button
          variant="secondary"
          size="sm"
          disabled={!allowed || running || act.isPending}
          onClick={() => setConfirming("start")}
        >
          <Play className="h-4 w-4" />
          Start
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!allowed || !running || act.isPending}
          onClick={() => setConfirming("restart")}
        >
          <RotateCw className="h-4 w-4" />
          Restart
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!allowed || !running || act.isPending}
          onClick={() => setConfirming("stop")}
        >
          <Square className="h-4 w-4" />
          Stop
        </Button>
      </div>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          {confirming && (
            <>
              <DialogHeader>
                <DialogTitle>{CONFIRM[confirming].title}</DialogTitle>
                <DialogDescription>{CONFIRM[confirming].body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  variant={confirming === "stop" ? "destructive" : "default"}
                  disabled={act.isPending}
                  onClick={() => act.mutate(confirming)}
                >
                  {act.isPending ? "Working…" : CONFIRM[confirming].verb}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
