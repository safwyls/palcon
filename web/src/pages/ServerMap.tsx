import { useEffect, useMemo, useReducer, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Home, WifiOff } from "lucide-react";
import { api, type Player } from "../lib/api";
import { DEFAULT_MAP_AREA, MAP_AREAS, mapOf, type MapArea } from "../lib/map";
import { playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { PlayerMap, mapMarkerId, type MapMarker } from "../components/PlayerMap";
import { MapAreaToggle } from "../components/MapAreaToggle";
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

/** A player wherever they are: live position for someone online, last-known
 * for someone offline (from the save). */
interface FocusTarget {
  domId: string;
  x: number;
  y: number;
  name: string;
  /** Set only for a live player, whose pin gets the selected highlight. */
  playerId?: string;
}

interface OfflinePlayer {
  uid: string;
  name: string;
  level: number;
  lastOnline: number;
  x: number;
  y: number;
}

interface BaseEntry {
  domId: string;
  index: number;
  x: number;
  y: number;
}

interface GuildBases {
  guildId: string;
  guildName: string;
  bases: BaseEntry[];
}

function PersonRow({
  name,
  color,
  detail,
  areaNote,
  selected,
  onClick,
}: {
  name: string;
  color: string;
  detail: string;
  areaNote?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition",
        selected ? "border-brand-red/30 bg-brand-red/10" : "border-ink/10 hover:border-ink/25",
      )}
    >
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{name}</span>
        <span className="block font-mono text-xs text-ink/40">
          {detail}
          {areaNote && ` · ${areaNote}`}
        </span>
      </span>
    </button>
  );
}

function BaseRow({ label, area, x, y, onClick }: { label: string; area: string; x: number; y: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-ink/10 px-3 py-2.5 text-left transition hover:border-ink/25"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-amber/15">
        <Home className="h-3.5 w-3.5 text-brand-amber" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{label}</span>
        <span className="block font-mono text-xs text-ink/40">
          {area} · {Math.round(x)}, {Math.round(y)}
        </span>
      </span>
    </button>
  );
}

/** The tabbed panel: shared between the desktop side column and the mobile
 * sheet so both stay identical. */
function MapSidePanel({
  tab,
  onTab,
  area,
  online,
  offline,
  guildBases,
  selectedId,
  onFocus,
}: {
  tab: "players" | "bases";
  onTab: (t: "players" | "bases") => void;
  area: MapArea;
  online: Player[];
  offline: OfflinePlayer[];
  guildBases: GuildBases[];
  selectedId: string | null;
  onFocus: (t: FocusTarget) => void;
}) {
  const baseCount = guildBases.reduce((n, g) => n + g.bases.length, 0);
  const tabClass = (active: boolean) =>
    cn(
      "flex-1 rounded-lg px-3 py-1.5 text-center text-sm font-semibold transition-colors",
      active ? "bg-brand-red text-paper" : "text-ink/50 hover:text-ink",
    );

  return (
    <>
      <div className="flex gap-1 rounded-xl border border-ink/10 bg-ink/[0.03] p-1">
        <button className={tabClass(tab === "players")} onClick={() => onTab("players")}>
          Players
        </button>
        <button className={tabClass(tab === "bases")} onClick={() => onTab("bases")}>
          Bases {baseCount > 0 && <span className="opacity-60">({baseCount})</span>}
        </button>
      </div>

      {tab === "players" ? (
        <div className="space-y-2">
          {online.map((p) => (
            <PersonRow
              key={`on-${p.playerId}`}
              name={p.name}
              color={playerColor(p.playerId)}
              detail={`Lv.${p.level} · ${Math.round(p.ping)}ms`}
              areaNote={mapOf(p.location_x, p.location_y) !== area ? MAP_AREAS[mapOf(p.location_x, p.location_y)].label : undefined}
              selected={selectedId === p.playerId}
              onClick={() =>
                onFocus({ domId: `player-marker-${p.playerId}`, x: p.location_x, y: p.location_y, name: p.name, playerId: p.playerId })
              }
            />
          ))}

          {offline.length > 0 && (
            <>
              <p className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink/35">Offline · last seen</p>
              {offline.map((p) => (
                <PersonRow
                  key={`off-${p.uid}`}
                  name={p.name}
                  color="#8A8079"
                  detail={p.lastOnline ? `Lv.${p.level} · ${lastSeenLabel(p.lastOnline)}` : `Lv.${p.level}`}
                  areaNote={mapOf(p.x, p.y) !== area ? MAP_AREAS[mapOf(p.x, p.y)].label : undefined}
                  selected={selectedId === `offline-${p.uid}`}
                  onClick={() => onFocus({ domId: mapMarkerId(`offline-${p.uid}`), x: p.x, y: p.y, name: p.name, playerId: `offline-${p.uid}` })}
                />
              ))}
            </>
          )}

          {online.length === 0 && offline.length === 0 && (
            <p className="px-2 py-1 text-sm text-muted-foreground">No players online, and none in the save yet.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {guildBases.map((g) => (
            <div key={g.guildId}>
              {guildBases.length > 1 && (
                <p className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-ink/35">{g.guildName}</p>
              )}
              <div className="space-y-2">
                {g.bases.map((b) => (
                  <BaseRow
                    key={b.domId}
                    label={guildBases.length > 1 ? `Base ${b.index + 1}` : `${g.guildName} · base ${b.index + 1}`}
                    area={MAP_AREAS[mapOf(b.x, b.y)].label}
                    x={b.x}
                    y={b.y}
                    onClick={() => onFocus({ domId: mapMarkerId(b.domId), x: b.x, y: b.y, name: g.guildName })}
                  />
                ))}
              </div>
            </div>
          ))}
          {baseCount === 0 && (
            <p className="px-2 py-1 text-sm text-muted-foreground">No bases in the save, or no save path configured.</p>
          )}
        </div>
      )}
    </>
  );
}

export function ServerMap() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const [searchParams, setSearchParams] = useSearchParams();

  const [area, setArea] = useState<MapArea>(DEFAULT_MAP_AREA);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<"players" | "bases">("players");

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const playersQuery = useQuery({
    queryKey: ["server-players", id],
    queryFn: () => api.serverPlayers(id),
    refetchInterval: 10_000,
    retry: false,
  });

  const online = playersQuery.data ?? [];

  // Save-derived data: guild bases, and where offline players last logged
  // off. Shares its cache (key + config) with the Guilds page.
  const saveQuery = useQuery({
    queryKey: ["server-guilds", id],
    queryFn: () => api.serverGuilds(id),
    retry: false,
    refetchInterval: 5 * 60_000,
    gcTime: 60 * 60_000,
    staleTime: 60_000,
  });

  const onlineNames = useMemo(() => new Set(online.map((p) => p.name.toLowerCase())), [online]);

  const offline = useMemo<OfflinePlayer[]>(() => {
    if (!saveQuery.data) return [];
    return saveQuery.data.players
      .filter((p) => p.lastX != null && p.lastY != null && !onlineNames.has(p.nickname.toLowerCase()))
      .map((p) => ({ uid: p.uid, name: p.nickname || "Unknown", level: p.level, lastOnline: p.lastOnline, x: p.lastX!, y: p.lastY! }))
      .sort((a, b) => b.lastOnline - a.lastOnline);
  }, [saveQuery.data, onlineNames]);

  const guildBases = useMemo<GuildBases[]>(() => {
    if (!saveQuery.data) return [];
    return saveQuery.data.guilds
      .map((g) => ({
        guildId: g.id,
        guildName: g.name || "Unnamed guild",
        bases: g.bases.map((b, i) => ({ domId: `base-${g.id}-${i}`, index: i, x: b.x, y: b.y })),
      }))
      .filter((g) => g.bases.length > 0);
  }, [saveQuery.data]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [];
    for (const g of guildBases) {
      for (const b of g.bases) {
        out.push({ id: b.domId, label: g.guildName, sublabel: `Base ${b.index + 1}`, x: b.x, y: b.y, kind: "base" });
      }
    }
    for (const p of offline) {
      out.push({
        id: `offline-${p.uid}`,
        label: p.name,
        sublabel: p.lastOnline ? `Last seen ${lastSeenLabel(p.lastOnline)}` : "Offline",
        x: p.x,
        y: p.y,
        kind: "offline",
      });
    }
    return out;
  }, [guildBases, offline]);

  // Focus any target: switch to its map area first (so the marker exists in
  // the right area's DOM), remember it for the HUD, and trigger the zoom.
  function focusTarget(t: FocusTarget) {
    if (mapOf(t.x, t.y) !== area) setArea(mapOf(t.x, t.y));
    setSelectedId(t.playerId ?? null);
    setFocus(t);
    setFocusId(t.domId);
    setSheetOpen(false);
  }

  // Dashboard's "View on map" arrives as ?focus=<playerId>.
  const focusParam = searchParams.get("focus");
  useEffect(() => {
    if (!focusParam || online.length === 0) return;
    const target = online.find((p) => p.playerId === focusParam);
    if (target)
      focusTarget({ domId: `player-marker-${target.playerId}`, x: target.location_x, y: target.location_y, name: target.name, playerId: target.playerId });
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusParam, online.length]);

  // Guilds page "View on map" arrives as ?base=<marker id>&bx=&by=.
  const baseParam = searchParams.get("base");
  const baseX = Number(searchParams.get("bx"));
  const baseY = Number(searchParams.get("by"));
  useEffect(() => {
    if (!baseParam || markers.length === 0) return;
    if (Number.isFinite(baseX) && Number.isFinite(baseY)) {
      setTab("bases");
      focusTarget({ domId: mapMarkerId(baseParam), x: baseX, y: baseY, name: "Base" });
    }
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseParam, markers.length]);

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const offlineServer = infoQuery.isError;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Map region: dark ocean surround, square canvas centered inside. */}
      <div className="relative min-w-0 flex-1 overflow-hidden bg-[#14333E]">
        <div className="absolute inset-0">
          <PlayerMap
            players={online}
            markers={markers}
            area={area}
            selectedId={selectedId}
            focusId={focusId}
            onSelect={(p) =>
              focusTarget({ domId: `player-marker-${p.playerId}`, x: p.location_x, y: p.location_y, name: p.name, playerId: p.playerId })
            }
            onFocusDone={() => setFocusId(null)}
          />
        </div>

        {/* Corner HUD: the focused player/base identity + world coordinates. */}
        <div className="clip-notch absolute left-4 top-4 z-10 space-y-0.5 rounded-xl bg-ink/85 px-4 py-2.5 font-mono text-xs text-paper">
          <p className="font-display text-sm font-bold text-brand-amber">{focus ? focus.name : "— select a marker —"}</p>
          <p>{focus ? `x: ${Math.round(focus.x)}   y: ${Math.round(focus.y)}` : "x: —   y: —"}</p>
        </div>

        {/* Status chip: player count when online, or a clear offline note —
            the map still works offline off the save data. */}
        <div className="absolute right-4 top-4 z-10 hidden rounded-xl px-3 py-2 font-mono text-xs lg:block">
          {offlineServer ? (
            <span className="flex items-center gap-1.5 rounded-xl bg-ink/85 px-3 py-2 text-brand-amber">
              <WifiOff className="h-3.5 w-3.5" /> server offline · showing last saved data
            </span>
          ) : (
            <span className="rounded-xl bg-white/80 px-3 py-2 text-ink/60">
              {online.length} online
              {playersQuery.dataUpdatedAt > 0 && (
                <>
                  {" · updated "}
                  <UpdatedAgo timestamp={playersQuery.dataUpdatedAt} />
                </>
              )}
            </span>
          )}
        </div>

        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
          <MapAreaToggle area={area} onChange={setArea} />
        </div>

        <p className="pointer-events-none absolute bottom-4 left-4 z-10 rounded bg-ink/70 px-2 py-1 font-mono text-[10px] text-paper/60">
          <span className="lg:hidden">© Pocketpair</span>
          <span className="hidden lg:inline">Map imagery © Pocketpair, Inc.</span>
        </p>

        {/* Mobile: the panel lives in a bottom sheet. */}
        {!sheetOpen && (
          <button
            onClick={() => setSheetOpen(true)}
            className="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-full bg-ink px-4 py-2 font-display text-xs font-bold text-paper shadow-lg lg:hidden"
          >
            Players &amp; bases
          </button>
        )}
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 z-20 max-h-[60%] overflow-hidden rounded-t-2xl border-t border-ink/10 bg-white p-4 transition-transform duration-300 lg:hidden",
            sheetOpen ? "translate-y-0" : "translate-y-full",
          )}
        >
          <button className="mx-auto mb-3 block h-1 w-10 rounded-full bg-ink/20" onClick={() => setSheetOpen(false)} />
          <div className="max-h-[calc(60vh-3rem)] space-y-3 overflow-y-auto">
            <MapSidePanel
              tab={tab}
              onTab={setTab}
              area={area}
              online={online}
              offline={offline}
              guildBases={guildBases}
              selectedId={selectedId}
              onFocus={focusTarget}
            />
          </div>
        </div>
      </div>

      {/* Desktop: side panel on the right. */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-ink/10 bg-white/80 lg:flex">
        <div className="border-b border-ink/10 px-5 py-4">
          <h2 className="font-display text-base font-bold">On the map</h2>
          <p className="mt-0.5 font-mono text-xs text-ink/40">Click to zoom</p>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <MapSidePanel
            tab={tab}
            onTab={setTab}
            area={area}
            online={online}
            offline={offline}
            guildBases={guildBases}
            selectedId={selectedId}
            onFocus={focusTarget}
          />
        </div>
      </aside>
    </div>
  );
}
