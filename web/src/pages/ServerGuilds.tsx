import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Home, Users } from "lucide-react";
import { api, ApiError, type Guild, type PlayerPals } from "../lib/api";
import { initials, playerColor } from "../lib/palette";
import { mapOf, MAP_AREAS } from "../lib/map";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { SaveReadProgress } from "../components/SaveReadProgress";
import { SavePathSetup } from "../components/SavePathSetup";

/** Reads as "3d ago"; blank when the save recorded no timestamp. */
export function lastSeenLabel(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function GuildCard({ guild, players, serverId }: { guild: Guild; players: PlayerPals[]; serverId: number }) {
  const navigate = useNavigate();
  const byUid = new Map(players.map((p) => [p.uid, p]));
  // Uids match the player saves, so this normally hits directly. The name
  // fallback covers a member with no player save of their own.
  const byName = new Map(players.map((p) => [p.nickname.toLowerCase(), p]));
  const resolve = (uid: string, name: string) => byUid.get(uid) ?? byName.get(name.toLowerCase());

  return (
    <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      <div className="flex items-center gap-3 border-b border-ink/10 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red/15 text-brand-red">
          <Users className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-base font-bold">{guild.name || "Unnamed guild"}</h2>
          <p className="font-mono text-xs text-ink/40">
            Base level {guild.baseCampLevel} · {guild.memberCount}{" "}
            {guild.memberCount === 1 ? "member" : "members"} · {guild.bases.length}{" "}
            {guild.bases.length === 1 ? "base" : "bases"}
          </p>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Members</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {guild.members.map((m) => {
              const player = resolve(m.uid, m.name);
              const seen = player ? lastSeenLabel(player.lastOnline) : "";
              const color = playerColor(player?.uid ?? m.uid);
              return (
                <div key={m.uid} className="flex items-center gap-2.5 rounded-xl border border-ink/10 bg-white/60 p-2.5">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold"
                    style={{ backgroundColor: `${color}33`, color }}
                  >
                    {initials(m.name || "?")}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{m.name || "Unknown"}</p>
                    <p className="font-mono text-[11px] text-ink/40">
                      {player ? `Lv.${player.level}` : "—"}
                      {seen && ` · seen ${seen}`}
                    </p>
                  </div>
                </div>
              );
            })}
            {guild.members.length === 0 && <p className="text-sm text-muted-foreground">No members recorded.</p>}
          </div>
        </div>

        {guild.bases.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">
              Bases <span className="font-mono text-ink/30">({guild.bases.length})</span>
            </p>
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {guild.bases.map((b, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl border border-ink/10 bg-white/60 p-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-amber/15">
                    <Home className="h-4 w-4 text-brand-amber" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      Base {i + 1}
                      <span className="ml-1.5 text-xs font-normal text-ink/45">
                        {MAP_AREAS[mapOf(b.x, b.y)].label}
                      </span>
                    </p>
                    <p className="font-mono text-[11px] text-ink/40">
                      {Math.round(b.x)}, {Math.round(b.y)}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      navigate(
                        `/servers/${serverId}/map?base=${encodeURIComponent(`base-${guild.id}-${i}`)}` +
                          `&bx=${b.x}&by=${b.y}`,
                      )
                    }
                    className="shrink-0 text-xs font-semibold text-pal-blue hover:underline"
                  >
                    View on map
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function ServerGuilds() {
  const { serverID } = useParams();
  const id = Number(serverID);

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  const guildsQuery = useQuery({
    queryKey: ["server-guilds", id],
    queryFn: () => api.serverGuilds(id),
    retry: false,
    refetchInterval: 5 * 60_000,
  });

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured =
    guildsQuery.isError && guildsQuery.error instanceof ApiError && guildsQuery.error.status === 400;
  const guilds = guildsQuery.data?.guilds ?? [];
  const players = guildsQuery.data?.players ?? [];

  return (
    <div>
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Guilds</h1>
          <p className="mt-0.5 text-sm text-ink/50">{serverQuery.data.name} · from the save file</p>
        </div>
      </header>

      <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
        {guildsQuery.isLoading && <SaveReadProgress />}
        {notConfigured && <SavePathSetup />}

        {guildsQuery.isError && !notConfigured && (
          infoQuery.isError ? <ServerUnreachable /> : (
            <p className="text-sm text-destructive">
              Could not read the save file: {(guildsQuery.error as Error).message}
            </p>
          )
        )}

        {guildsQuery.isSuccess &&
          (guilds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No guilds in this save yet.</p>
          ) : (
            guilds.map((g) => <GuildCard key={g.id} guild={g} players={players} serverId={id} />)
          ))}
      </div>
    </div>
  );
}
