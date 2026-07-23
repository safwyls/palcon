import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type Pal, type PlayerPals } from "../lib/api";
import { initials, playerColor } from "../lib/palette";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { Badge } from "../components/ui/badge";

function displayName(pal: Pal): string {
  if (pal.nickname) return pal.nickname;
  return pal.isBoss ? pal.characterId.replace(/^BOSS_/i, "") : pal.characterId;
}

function PalCard({ pal }: { pal: Pal }) {
  return (
    <div className="rounded-xl border border-ink/10 bg-white/70 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {displayName(pal)}
            {pal.gender && (
              <span className={pal.gender === "female" ? "ml-1 text-brand-red/70" : "ml-1 text-pal-blue/70"}>
                {pal.gender === "female" ? "♀" : "♂"}
              </span>
            )}
          </p>
          {pal.nickname && <p className="truncate font-mono text-xs text-ink/40">{pal.characterId}</p>}
        </div>
        <span className="shrink-0 rounded-full bg-ink px-2 py-0.5 font-mono text-xs font-bold text-paper">
          Lv.{pal.level}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
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
        <span className="font-mono text-[11px] text-ink/40" title="IVs: HP / Attack / Defense">
          IV {pal.talentHp}/{pal.talentShot}/{pal.talentDefense}
        </span>
      </div>

      {pal.passives.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {pal.passives.map((p) => (
            <span key={p} className="rounded-full bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] text-ink/50">
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PalGroup({ title, pals }: { title: string; pals: Pal[] }) {
  if (pals.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">
        {title} <span className="font-mono text-ink/30">({pals.length})</span>
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {pals.map((pal) => (
          <PalCard key={pal.instanceId} pal={pal} />
        ))}
      </div>
    </div>
  );
}

function PlayerSection({ player }: { player: PlayerPals }) {
  const color = playerColor(player.uid);
  const total = player.party.length + player.palbox.length + player.base.length;
  return (
    <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      <div className="flex items-center gap-3 border-b border-ink/10 px-5 py-4">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-display text-sm font-bold"
          style={{ backgroundColor: `${color}33`, color }}
        >
          {initials(player.nickname || "?")}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-bold">{player.nickname || player.uid}</h2>
          <p className="font-mono text-xs text-ink/40">
            Lv.{player.level} · {total} pals
          </p>
        </div>
      </div>
      <div className="space-y-5 p-5">
        <PalGroup title="Party" pals={player.party} />
        <PalGroup title="Palbox" pals={player.palbox} />
        <PalGroup title="At base" pals={player.base} />
        {total === 0 && <p className="text-sm text-muted-foreground">No pals owned yet.</p>}
      </div>
    </section>
  );
}

function agoLabel(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function ServerPlayers() {
  const { serverID } = useParams();
  const id = Number(serverID);

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const palsQuery = useQuery({
    queryKey: ["server-pals", id],
    queryFn: () => api.serverPals(id),
    retry: false,
    // The backend re-parses only when Level.sav's mtime changes, so polling
    // is cheap; ~the game's autosave cadence.
    refetchInterval: 60_000,
  });

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured =
    palsQuery.isError && palsQuery.error instanceof ApiError && palsQuery.error.status === 400;

  return (
    <div>
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Player details</h1>
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
        {palsQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Reading save file — first parse of a large world can take a moment...</p>
        )}

        {notConfigured && (
          <section className="rounded-2xl border border-ink/10 bg-white/70 p-6">
            <h2 className="font-display text-base font-bold">Set up the Pal viewer</h2>
            <p className="mt-2 max-w-2xl text-sm text-ink/60">
              This reads the server's save file directly, so Palcon needs to see it. Bind-mount your world save
              folder (the one containing <code className="font-mono">Level.sav</code>) into the container{" "}
              <span className="font-semibold">read-only</span>, then put that container path in the server's{" "}
              <span className="font-semibold">Save path</span> (edit the server from the sidebar).
            </p>
            <pre className="mt-3 max-w-2xl overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-xs text-paper/80">
              - /path/to/Pal/Saved/SaveGames/0/&lt;world-id&gt;:/saves/myserver:ro
            </pre>
          </section>
        )}

        {palsQuery.isError && !notConfigured && (
          infoQuery.isError ? <ServerUnreachable /> : (
            <p className="text-sm text-destructive">Could not read the save file: {(palsQuery.error as Error).message}</p>
          )
        )}

        {palsQuery.data &&
          (palsQuery.data.players.length > 0 ? (
            palsQuery.data.players.map((player) => <PlayerSection key={player.uid} player={player} />)
          ) : (
            <p className="text-sm text-muted-foreground">No players found in this save yet.</p>
          ))}
      </div>
    </div>
  );
}
