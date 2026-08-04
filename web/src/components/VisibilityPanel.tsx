import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { api, errorDetail, STREAMS, type Feature, type Stream } from "../lib/api";
import { initials, playerColor } from "../lib/palette";
import { featureBlurb, featureLabel } from "../lib/games";
import { cn } from "../lib/utils";

/** What each per-player switch withholds. Written from the player's side —
 * this is what someone is agreeing to when they ask to be hidden. */
const STREAM_LABELS: Record<Stream, string> = {
  pals: "Pals",
  inventory: "Inventory",
  map: "Map",
};

const STREAM_HINTS: Record<Stream, string> = {
  pals: "Their pals, and their share of Paldex and Calculators",
  inventory: "Their bags, gear and character sheet",
  map: "Their live and last-known position",
};

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-red",
        on ? "bg-pal-green" : "bg-ink/20",
      )}
    >
      {/* left-0.5 is load-bearing: without an explicit inset an absolutely
          positioned knob falls back to its static position, which in a
          right-aligned table cell puts it at the far end and reads as "on"
          whichever way the switch is set. */}
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
          on ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

/**
 * Who can see what, for one server.
 *
 * Two switches on the same data: a view can be turned off for the whole
 * server, and a single player can be withheld from one kind of data while the
 * view stays on for everyone else. Admins see through both — the point is
 * letting an owner honour a privacy request without blinding themselves, and
 * an admin is the only one who can turn a view back on.
 *
 * The locked-chest switch below them is the exception: it takes password-locked
 * chests out of the Storage index for everyone, admins included, because a
 * switch that says "don't search these" and then shows them to whoever set it
 * reads as broken. The escape hatch is the same — only an admin can undo it.
 */
export function VisibilityPanel({ serverId }: { serverId: number }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["server-visibility", serverId],
    queryFn: () => api.serverVisibility(serverId),
  });
  // For the per-game labels below. The switch list itself comes from the
  // visibility payload's allFeatures, which is this server's game's views.
  const serverQuery = useQuery({ queryKey: ["server", serverId], queryFn: () => api.getServer(serverId) });
  const server = serverQuery.data;

  // Edited locally and saved as a whole, like the settings editor beside it:
  // flipping six switches shouldn't be six round trips.
  const [hiddenFeatures, setHiddenFeatures] = useState<string[]>([]);
  const [hidePrivateStorage, setHidePrivateStorage] = useState(false);
  const [players, setPlayers] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setHiddenFeatures(query.data.hiddenFeatures ?? []);
    setHidePrivateStorage(query.data.hidePrivateStorage ?? false);
    setPlayers(query.data.players ?? {});
    setDirty(false);
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api.updateServerVisibility(serverId, { hiddenFeatures, hidePrivateStorage, players }),
    onSuccess: () => {
      setDirty(false);
      toast.success("Visibility saved");
      // The nav reads hiddenFeatures off the server row, so it has to re-read.
      queryClient.invalidateQueries({ queryKey: ["server", serverId] });
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      queryClient.invalidateQueries({ queryKey: ["server-visibility", serverId] });
    },
    onError: (err) => toast.error("Couldn't save visibility", { description: errorDetail(err) }),
  });

  const roster = query.data?.roster ?? [];
  // Anyone with a hide set who is no longer in the save still needs a row, or
  // their hide would be invisible and un-removable.
  const rows = useMemo(() => {
    const known = new Set(roster.map((p) => p.uid));
    const strays = Object.keys(players)
      .filter((uid) => !known.has(uid))
      .map((uid) => ({ uid, nickname: "", level: 0 }));
    return [...roster, ...strays];
  }, [roster, players]);

  const setFeature = (feature: Feature, visible: boolean) => {
    setHiddenFeatures((prev) => (visible ? prev.filter((f) => f !== feature) : [...new Set([...prev, feature])]));
    setDirty(true);
  };

  const setStream = (uid: string, stream: Stream, visible: boolean) => {
    setPlayers((prev) => {
      const current = prev[uid] ?? [];
      const next = visible ? current.filter((s) => s !== stream) : [...new Set([...current, stream])];
      const out = { ...prev };
      if (next.length === 0) delete out[uid];
      else out[uid] = next;
      return out;
    });
    setDirty(true);
  };

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading visibility…</p>;
  if (query.isError) {
    return <p className="text-sm text-destructive">Couldn't load visibility: {errorDetail(query.error)}</p>;
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink/10 px-5 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-red/15 text-brand-red">
          <Eye className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-bold">Who can see what</h2>
          <p className="text-xs text-ink/50">
            Turn a view off for everyone, or hide one player's data while the view stays on. Admins
            see through both — the locked-chest switch at the bottom is the one exception, and it
            applies to you too.
          </p>
        </div>
        {dirty && (
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="clip-notch shrink-0 bg-brand-red px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>

      <div className="divide-y divide-ink/10">
        {(query.data?.allFeatures ?? []).map((feature) => {
          const visible = !hiddenFeatures.includes(feature);
          const label = featureLabel(server, feature as Feature);
          return (
            <div key={feature} className="flex items-center justify-between gap-4 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{label}</p>
                <p className="text-xs text-ink/40">{featureBlurb(server, feature as Feature)}</p>
              </div>
              <Toggle on={visible} onChange={(next) => setFeature(feature as Feature, next)} label={label} />
            </div>
          );
        })}

        {/* Sits with the view switches because it's the same kind of decision,
            but it isn't one: it takes a category of container out of the
            Storage index for everyone, admins included. An admin who wants to
            look turns it back on — they're the only ones who can. */}
        <div className="flex items-center justify-between gap-4 px-5 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Search password-locked chests</p>
            <p className="text-xs text-ink/40">
              A password on a chest is a player saying its contents are theirs. Off keeps those
              chests out of Storage results entirely — for you as well.
            </p>
          </div>
          <Toggle
            on={!hidePrivateStorage}
            onChange={(next) => {
              setHidePrivateStorage(!next);
              setDirty(true);
            }}
            label="Search password-locked chests"
          />
        </div>
      </div>

      <div className="border-t border-ink/10 px-5 py-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ink/40">Per player</h3>
          <span className="font-mono text-[11px] text-ink/30">{rows.length}</span>
        </div>
        <p className="mt-1 text-xs text-ink/45">
          Hiding a player's pals also removes them from Paldex and Calculators — all three read the
          same data, so splitting them would be a switch that doesn't switch anything.
        </p>

        {query.data?.rosterUnavailable ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Player-level control needs a readable save. Set a save path for this server first.
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No players in this save yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            {/* Capped: stretched across a wide screen the switches ended up a
                hand's width from the name they belong to. */}
            <table className="w-full min-w-[26rem] max-w-2xl border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className="pb-2 text-left text-[10px] font-semibold uppercase tracking-wide text-ink/40">
                    Player
                  </th>
                  {STREAMS.map((stream) => (
                    <th
                      key={stream}
                      className="pb-2 pl-4 text-right text-[10px] font-semibold uppercase tracking-wide text-ink/40"
                      title={STREAM_HINTS[stream]}
                    >
                      {STREAM_LABELS[stream]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const hidden = players[p.uid] ?? [];
                  return (
                    <tr key={p.uid}>
                      <td className="border-t border-ink/10 py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <span
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-display text-[10px] font-bold"
                            style={{ backgroundColor: `${playerColor(p.uid)}33`, color: playerColor(p.uid) }}
                          >
                            {initials(p.nickname || "?")}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm text-foreground">
                              {p.nickname || p.uid.slice(0, 8)}
                            </span>
                            {p.level > 0 && <span className="font-mono text-[11px] text-ink/35">Lv.{p.level}</span>}
                            {!p.nickname && (
                              <span className="font-mono text-[11px] text-ink/35">not in this save</span>
                            )}
                          </span>
                          {hidden.length > 0 && (
                            <EyeOff className="h-3.5 w-3.5 shrink-0 text-ink/30" aria-label="Partly hidden" />
                          )}
                        </div>
                      </td>
                      {STREAMS.map((stream) => (
                        <td key={stream} className="border-t border-ink/10 py-2 pl-4 text-right">
                          <span className="inline-flex justify-end">
                            <Toggle
                              on={!hidden.includes(stream)}
                              onChange={(next) => setStream(p.uid, stream, next)}
                              label={`${p.nickname || p.uid} ${STREAM_LABELS[stream]}`}
                            />
                          </span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!dirty && save.isSuccess && (
        <p className="flex items-center gap-1.5 border-t border-ink/10 px-5 py-2.5 text-xs text-pal-green">
          <Check className="h-3.5 w-3.5" /> Saved
        </p>
      )}
    </section>
  );
}
