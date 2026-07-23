import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { PlayerMap } from "../components/PlayerMap";
import { ServerPageHeader } from "../components/ServerPageHeader";

export function ServerMap() {
  const { serverID } = useParams();
  const id = Number(serverID);

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
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
      />

      {playersQuery.isLoading && <p className="text-sm text-muted-foreground">Loading players...</p>}
      {playersQuery.isError && <p className="text-sm text-destructive">Could not reach server.</p>}
      {playersQuery.data && (
        // The map texture is a fixed 8192x8192 square, and player positions
        // are plotted as percentages of that square — so the container must
        // stay square too, or object-cover crops the image asymmetrically
        // while the percentage math stays naive to it, drifting the dots out
        // of alignment with the visible map (worse the more non-square the
        // box is, e.g. an ultrawide window). Fit-to-available-space instead
        // of stretching: h-full sizes by height, max-w-full caps it by width
        // when that's the tighter constraint, and the aspect-ratio box
        // recomputes the other dimension to stay square either way.
        <div className="min-h-0 flex-1">
          <PlayerMap players={playersQuery.data} className="mx-auto h-full w-auto max-w-full" />
        </div>
      )}
    </div>
  );
}
