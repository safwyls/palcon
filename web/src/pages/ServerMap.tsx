import { useEffect, useMemo, useReducer, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Player } from "../lib/api";
import { DEFAULT_MAP_AREA, MAP_AREAS, mapOf, type MapArea } from "../lib/map";
import { playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { PlayerMap, mapMarkerId, type MapMarker } from "../components/PlayerMap";
import { MapAreaToggle } from "../components/MapAreaToggle";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { lastSeenLabel } from "./ServerGuilds";

/** Ticks once a second so the "updated Xs ago" chip stays honest. */
function UpdatedAgo({ timestamp }: { timestamp: number }) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  return <>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`} ago</>;
}

function PlayerRow({
  player,
  area,
  selected,
  onClick,
}: {
  player: Player;
  area: MapArea;
  selected: boolean;
  onClick: () => void;
}) {
  const playerArea = mapOf(player.location_x, player.location_y);
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition",
        selected ? "border-brand-red/30 bg-brand-red/10" : "border-ink/10 hover:border-ink/25",
      )}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: playerColor(player.playerId) }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{player.name}</span>
        <span className="block font-mono text-xs text-ink/40">
          Lv.{player.level} · {Math.round(player.ping)}ms
          {playerArea !== area && ` · ${MAP_AREAS[playerArea].label}`}
        </span>
      </span>
    </button>
  );
}

export function ServerMap() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const [searchParams, setSearchParams] = useSearchParams();

  const [area, setArea] = useState<MapArea>(DEFAULT_MAP_AREA);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
  });

  const players = playersQuery.data ?? [];

  // Save-derived overlay. Optional: a server with no save path configured
  // simply gets no markers, so the map still works exactly as before.
  const saveQuery = useQuery({
    queryKey: ["server-guilds", id],
    queryFn: () => api.serverGuilds(id),
    retry: false,
    refetchInterval: 5 * 60_000,
  });

  const markers = useMemo<MapMarker[]>(() => {
    const data = saveQuery.data;
    if (!data) return [];
    const online = new Set(players.map((p) => p.name.toLowerCase()));
    const out: MapMarker[] = [];

    for (const guild of data.guilds) {
      guild.bases.forEach((b, i) => {
        out.push({
          id: `base-${guild.id}-${i}`,
          label: guild.name || "Unnamed guild",
          sublabel: `Base level ${guild.baseCampLevel}`,
          x: b.x,
          y: b.y,
          kind: "base",
        });
      });
    }

    for (const p of data.players) {
      // Someone connected right now is already drawn from live data, at
      // their actual position rather than where they last logged off.
      if (!p.lastX || !p.lastY || online.has(p.nickname.toLowerCase())) continue;
      out.push({
        id: `offline-${p.uid}`,
        label: p.nickname || "Unknown player",
        sublabel: p.lastOnline ? `Last seen ${lastSeenLabel(p.lastOnline)}` : "Offline",
        x: p.lastX,
        y: p.lastY,
        kind: "offline",
      });
    }
    return out;
  }, [saveQuery.data, players]);

  function selectPlayer(p: Player) {
    setSelectedId(p.playerId);
    const playerArea = mapOf(p.location_x, p.location_y);
    if (playerArea !== area) setArea(playerArea);
    setFocusId(`player-marker-${p.playerId}`);
    setSheetOpen(false);
  }

  // Dashboard's "View on map" lands here with ?focus=<playerId>: zoom to
  // that player once the roster is in, then drop the param so refresh or
  // back-navigation doesn't replay the zoom.
  const focusParam = searchParams.get("focus");
  useEffect(() => {
    if (!focusParam || players.length === 0) return;
    const target = players.find((p) => p.playerId === focusParam);
    if (target) selectPlayer(target);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, players.length]);

  // "View on map" from the Guilds page arrives as ?base=<marker id>, with
  // coordinates so the right area can be selected before the marker exists.
  const baseParam = searchParams.get("base");
  const baseX = Number(searchParams.get("bx"));
  const baseY = Number(searchParams.get("by"));
  useEffect(() => {
    if (!baseParam || markers.length === 0) return;
    if (Number.isFinite(baseX) && Number.isFinite(baseY)) {
      const targetArea = mapOf(baseX, baseY);
      if (targetArea !== area) setArea(targetArea);
    }
    setFocusId(mapMarkerId(baseParam));
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseParam, markers.length]);

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  if (infoQuery.isError) {
    return <ServerUnreachable />;
  }

  const selected = players.find((p) => p.playerId === selectedId) ?? null;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Map region: dark ocean surround, square canvas centered inside. */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-[#14333E]">
        <div className="absolute inset-0">
          <PlayerMap
            players={players}
            markers={markers}
            area={area}
            selectedId={selectedId}
            focusId={focusId}
            onSelect={selectPlayer}
            onFocusDone={() => setFocusId(null)}
          />
        </div>

        {/* Corner HUD: the selected player's identity + world coordinates. */}
        <div className="clip-notch absolute left-4 top-4 z-10 space-y-0.5 rounded-xl bg-ink/85 px-4 py-2.5 font-mono text-xs text-paper">
          <p className="font-display text-sm font-bold text-brand-amber">{selected ? selected.name : "— select a player —"}</p>
          <p>
            {selected
              ? `x: ${Math.round(selected.location_x)}   y: ${Math.round(selected.location_y)}`
              : "x: —   y: —"}
          </p>
        </div>

        {/* Redundant on mobile — the top bar already shows the player count. */}
        <div className="absolute right-4 top-4 z-10 hidden rounded-xl bg-white/80 px-3 py-2 font-mono text-xs text-ink/60 lg:block">
          {players.length} online
          {playersQuery.dataUpdatedAt > 0 && (
            <>
              {" · updated "}
              <UpdatedAgo timestamp={playersQuery.dataUpdatedAt} />
            </>
          )}
        </div>

        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
          <MapAreaToggle area={area} onChange={setArea} />
        </div>

        {/* The world map art is Pocketpair's, not ours — credited in the
            corner where map attribution conventionally sits. Abbreviated on
            narrow screens, where the full line would run under the area
            toggle sitting at bottom-center. */}
        <p className="pointer-events-none absolute bottom-4 left-4 z-10 rounded bg-ink/70 px-2 py-1 font-mono text-[10px] text-paper/60">
          <span className="lg:hidden">© Pocketpair</span>
          <span className="hidden lg:inline">Map imagery © Pocketpair, Inc.</span>
        </p>

        {/* Mobile: player list lives in a bottom sheet. */}
        {!sheetOpen && players.length > 0 && (
          <button
            onClick={() => setSheetOpen(true)}
            className="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink px-4 py-2 font-display text-xs font-bold text-paper shadow-lg lg:hidden"
          >
            Players ({players.length})
          </button>
        )}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 max-h-[55%] overflow-hidden rounded-t-2xl border-t border-ink/10 bg-white p-4 transition-transform duration-300 lg:hidden",
            sheetOpen ? "translate-y-0" : "translate-y-full",
          )}
        >
          <button className="mx-auto mb-3 block h-1 w-10 rounded-full bg-ink/20" onClick={() => setSheetOpen(false)} />
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {players.map((p) => (
              <PlayerRow key={p.playerId} player={p} area={area} selected={selectedId === p.playerId} onClick={() => selectPlayer(p)} />
            ))}
          </div>
        </div>
      </div>

      {/* Desktop: player list panel on the right. */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-ink/10 bg-white/80 lg:flex">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="font-display text-base font-bold">Players</h2>
          <p className="mt-0.5 font-mono text-xs text-ink/40">Click to zoom on map</p>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {playersQuery.isLoading && <p className="px-2 py-1 text-sm text-muted-foreground">Loading players...</p>}
          {playersQuery.isError && <p className="px-2 py-1 text-sm text-destructive">Could not reach server.</p>}
          {players.map((p) => (
            <PlayerRow key={p.playerId} player={p} area={area} selected={selectedId === p.playerId} onClick={() => selectPlayer(p)} />
          ))}
          {playersQuery.isSuccess && players.length === 0 && (
            <p className="px-2 py-1 text-sm text-muted-foreground">No players online.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
