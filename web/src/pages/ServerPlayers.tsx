import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, RefreshCw, Search } from "lucide-react";
import { api, ApiError, type Pal, type PlayerPals } from "../lib/api";
import { initials, playerColor } from "../lib/palette";
import { elementColor, palEntry, palIconUrl, palName, passiveName, rarityTier } from "../lib/paldex";
import { cn } from "../lib/utils";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { SaveReadProgress } from "../components/SaveReadProgress";
import { SaveUpdatingBanner } from "../components/SaveUpdatingBanner";
import { PalDetailDialog } from "../components/PalDetailDialog";
import { SavePathSetup } from "../components/SavePathSetup";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/input";

function PalCard({ pal, onOpen }: { pal: Pal; onOpen: () => void }) {
  const species = palName(pal.characterId);
  const entry = palEntry(pal.characterId);
  const elements = (entry?.elements ?? []).slice(0, 2);
  const tier = rarityTier(entry?.rarity ?? 0);

  return (
    <button
      onClick={onOpen}
      className="flex w-full gap-3 rounded-xl border border-ink/10 bg-white/70 p-3 text-left transition-colors hover:border-ink/25 hover:bg-white"
    >
      <div
        className={cn(
          "flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border",
          tier === "legendary"
            ? "border-legendary/40 bg-legendary/10"
            : tier === "rare"
              ? "border-pal-blue/40 bg-pal-blue/10"
              : "border-ink/10 bg-ink/5",
        )}
      >
        <img
          src={palIconUrl(pal.characterId)}
          alt=""
          className="h-10 w-10 object-contain"
          loading="lazy"
          // A pal added by a game update has no vendored icon; the frame
          // alone reads fine, so drop the broken image rather than show it.
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-semibold text-foreground">
            {pal.nickname || species}
            {pal.gender && (
              // Bumped well past the surrounding text: these glyphs draw
              // small for their font size, so at 14px and 70% opacity they
              // were barely visible.
              <span
                className={cn(
                  "ml-1 align-middle text-lg font-bold leading-none",
                  pal.gender === "female" ? "text-brand-red" : "text-pal-blue",
                )}
                title={pal.gender === "female" ? "Female" : "Male"}
                aria-label={pal.gender === "female" ? "Female" : "Male"}
                role="img"
              >
                {pal.gender === "female" ? "♀" : "♂"}
              </span>
            )}
          </p>
          <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 font-mono text-xs font-bold text-paper">
            Lv.{pal.level}
          </span>
        </div>

        <p className="truncate text-xs text-ink/45">{pal.nickname ? species : ""}&nbsp;</p>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {elements.map((el) => (
            <span
              key={el}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
              style={{ backgroundColor: `${elementColor(el)}22`, color: elementColor(el) }}
            >
              {el}
            </span>
          ))}
          {pal.isBoss && (
            <Badge variant="outline" className="border-legendary/40 bg-legendary/10 px-1.5 py-0 text-[10px] text-legendary">
              Alpha
            </Badge>
          )}
          {pal.isLucky && (
            <Badge variant="outline" className="border-brand-amber/40 bg-brand-amber/10 px-1.5 py-0 text-[10px] text-brand-amber">
              Lucky
            </Badge>
          )}
          <span className="font-mono text-[10px] text-ink/40" title="IVs: HP / Attack / Defense">
            {pal.talentHp}/{pal.talentShot}/{pal.talentDefense}
          </span>
        </div>

        {pal.passives.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {pal.passives.map((p) => (
              <span
                key={p}
                title={p}
                className="rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] text-ink/60"
              >
                {passiveName(p)}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function PalGroup({ title, pals, onOpen }: { title: string; pals: Pal[]; onOpen: (pal: Pal) => void }) {
  if (pals.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">
        {title} <span className="font-mono text-ink/30">({pals.length})</span>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {pals.map((pal) => (
          <PalCard key={pal.instanceId} pal={pal} onOpen={() => onOpen(pal)} />
        ))}
      </div>
    </div>
  );
}

function PlayerSection({ player, query, onOpen }: { player: PlayerPals; query: string; onOpen: (pal: Pal, location: string) => void }) {
  const [open, setOpen] = useState(true);
  const color = playerColor(player.uid);

  const filtered = useMemo(() => {
    if (!query.trim()) return player;
    const q = query.trim().toLowerCase();
    const match = (pal: Pal) =>
      pal.nickname.toLowerCase().includes(q) ||
      pal.characterId.toLowerCase().includes(q) ||
      palName(pal.characterId).toLowerCase().includes(q) ||
      pal.passives.some((p) => passiveName(p).toLowerCase().includes(q) || p.toLowerCase().includes(q));
    return {
      ...player,
      party: player.party.filter(match),
      palbox: player.palbox.filter(match),
      base: player.base.filter(match),
    };
  }, [player, query]);

  const total = filtered.party.length + filtered.palbox.length + filtered.base.length;
  const owned = player.party.length + player.palbox.length + player.base.length;

  // A search that excludes everyone's pals should hide the player entirely
  // rather than leave a row of empty sections to scroll past.
  if (query.trim() && total === 0) return null;

  const expanded = query.trim() ? true : open;

  return (
    <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-ink/5"
        aria-expanded={expanded}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-sm font-bold"
          style={{ backgroundColor: `${color}33`, color }}
        >
          {initials(player.nickname || "?")}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-bold">{player.nickname || player.uid}</h2>
          <p className="font-mono text-xs text-ink/40">
            Lv.{player.level} · {query.trim() ? `${total} of ${owned}` : owned}{" "}
            {owned === 1 && !query.trim() ? "pal" : "pals"}
          </p>
        </div>
        <ChevronDown
          className={cn("h-4 w-4 shrink-0 text-ink/40 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <div className="space-y-5 border-t border-ink/10 p-5">
          <PalGroup title="Party" pals={filtered.party} onOpen={(p) => onOpen(p, "Party")} />
          <PalGroup title="Palbox" pals={filtered.palbox} onOpen={(p) => onOpen(p, "Palbox")} />
          <PalGroup title="At base" pals={filtered.base} onOpen={(p) => onOpen(p, "At base")} />
          {total === 0 && <p className="text-sm text-muted-foreground">No pals owned yet.</p>}
        </div>
      )}
    </section>
  );
}

function agoLabel(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// Re-reading is only worth doing about as often as the data can change, and
// party/palbox contents move on human timescales. The game also rewrites
// Level.sav on every autosave (default: every 30s), so a short interval
// means almost every poll misses the mtime cache and re-parses the world.
const REFRESH_OPTIONS = [1, 2, 5, 10];
const DEFAULT_REFRESH_MINUTES = 5;

export function ServerPlayers() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const [query, setQuery] = useState("");
  const [refreshMinutes, setRefreshMinutes] = useState(DEFAULT_REFRESH_MINUTES);
  const [selected, setSelected] = useState<{ pal: Pal; location: string } | null>(null);
  const openPal = (pal: Pal, location: string) => setSelected({ pal, location });

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const palsQuery = useQuery({
    queryKey: ["server-pals", id],
    queryFn: () => api.serverPals(id),
    retry: false,
    refetchInterval: refreshMinutes * 60_000,
    // Keep the parsed result in memory across navigation. Re-parsing a large
    // save takes 20-30s, so the default 5-minute gcTime meant leaving the
    // page and coming back dropped everything and made you wait again.
    gcTime: 60 * 60_000,
    // A remount within the window reuses the cache instead of refetching,
    // so switching tabs and back is instant; the interval still refreshes it.
    staleTime: 60_000,
  });

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured =
    palsQuery.isError && palsQuery.error instanceof ApiError && palsQuery.error.status === 400;
  // Render from whatever we last parsed, even while a refresh is in flight or
  // a background refresh just failed — a stale roster beats a blank page.
  const hasData = palsQuery.data !== undefined;
  const players = palsQuery.data?.players ?? [];
  const visible = players.filter((p) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return [...p.party, ...p.palbox, ...p.base].some(
      (pal) =>
        pal.nickname.toLowerCase().includes(q) ||
        pal.characterId.toLowerCase().includes(q) ||
        palName(pal.characterId).toLowerCase().includes(q) ||
        pal.passives.some((s) => passiveName(s).toLowerCase().includes(q) || s.toLowerCase().includes(q)),
    );
  });

  return (
    <div>
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Player pals</h1>
          <p className="mt-0.5 text-sm text-ink/50">
            {serverQuery.data.name} · party &amp; palbox from the save file
          </p>
        </div>
        {palsQuery.data && (
          <p className="font-mono text-xs text-ink/40">
            save written {agoLabel(palsQuery.data.saveModTime)} · parsed {agoLabel(palsQuery.data.parsedAt)}
          </p>
        )}
      </header>

      <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
        {/* Full progress only on the very first parse; after that a refresh
            shows the banner over the last result instead of blanking. */}
        {!hasData && palsQuery.isFetching && <SaveReadProgress />}

        {notConfigured && !hasData && <SavePathSetup />}

        {!hasData && palsQuery.isError && !notConfigured && (
          infoQuery.isError ? <ServerUnreachable /> : (
            <p className="text-sm text-destructive">Could not read the save file: {(palsQuery.error as Error).message}</p>
          )
        )}

        {hasData && palsQuery.isFetching && <SaveUpdatingBanner />}

        {hasData && players.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-0 flex-1 sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/30" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pals by name, species or passive…"
                className="pl-9"
              />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <label className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink/40">Refresh</span>
                <select
                  value={refreshMinutes}
                  onChange={(e) => setRefreshMinutes(Number(e.target.value))}
                  className="rounded-lg border border-ink/15 bg-white px-2 py-1.5 font-mono text-xs text-ink focus:border-brand-red/50 focus:outline-none"
                >
                  {REFRESH_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>

              {/* Refetches rather than forcing a re-parse: the server reuses
                  its cached read while Level.sav is unchanged, so this picks
                  up a new autosave immediately without paying to re-parse a
                  world that hasn't moved. */}
              <button
                onClick={() => palsQuery.refetch()}
                disabled={palsQuery.isFetching}
                title="Check for a newer save now"
                aria-label="Refresh now"
                className="rounded-lg border border-ink/15 bg-white p-2 text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-50"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", palsQuery.isFetching && "animate-spin")} />
              </button>
            </div>
          </div>
        )}

        {hasData &&
          (players.length === 0 ? (
            <p className="text-sm text-muted-foreground">No players found in this save yet.</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pals match "{query}".</p>
          ) : (
            visible.map((player) => (
              <PlayerSection key={player.uid} player={player} query={query} onOpen={openPal} />
            ))
          ))}

        {hasData && players.length > 0 && (
          <p className="pt-2 text-xs text-ink/35">
            Pal artwork and names © Pocketpair, Inc. Icons and localisation data vendored from{" "}
            <span className="font-mono">palworld-server-manager</span> and{" "}
            <span className="font-mono">palworld-save-pal</span>.
          </p>
        )}
      </div>

      <PalDetailDialog
        pal={selected?.pal ?? null}
        location={selected?.location ?? ""}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
