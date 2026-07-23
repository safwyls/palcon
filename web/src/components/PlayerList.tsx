import type { Player } from "../lib/api";
import { playerColor, initials, pingColorClass } from "../lib/palette";

/**
 * Dashboard players table, per mocks/dashboard.html: avatar initials chip in
 * the player's assigned color, mono numerals, latency-colored ping, and text
 * actions. "View on map" is the mock's action; Kick/Ban are kept because
 * they're real admin capability with nowhere else to live.
 */
export function PlayerList({
  players,
  onViewMap,
  onKick,
  onBan,
}: {
  players: Player[];
  onViewMap: (player: Player) => void;
  onKick: (player: Player) => void;
  onBan: (player: Player) => void;
}) {
  if (players.length === 0) {
    return <p className="px-5 py-4 text-sm text-muted-foreground">No players online.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink/40">
            <th className="px-3 py-2 font-semibold lg:px-5">Player</th>
            <th className="px-3 py-2 font-semibold lg:px-5">Level</th>
            <th className="px-3 py-2 font-semibold lg:px-5">Ping</th>
            <th className="px-3 py-2 font-semibold lg:px-5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5">
          {players.map((p) => {
            const color = playerColor(p.playerId);
            return (
              <tr key={p.playerId} className="hover:bg-ink/5">
                <td className="max-w-48 px-3 py-3 lg:px-5">
                  <span className="flex items-center gap-2">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold"
                      style={{ backgroundColor: `${color}33`, color }}
                    >
                      {initials(p.name)}
                    </span>
                    <span className="truncate font-medium text-foreground">{p.name}</span>
                  </span>
                </td>
                <td className="px-3 py-3 font-mono lg:px-5">{p.level}</td>
                <td className={`whitespace-nowrap px-3 py-3 font-mono lg:px-5 ${pingColorClass(p.ping)}`}>
                  {Math.round(p.ping)} ms
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right lg:px-5">
                  <button className="text-xs font-semibold text-pal-blue hover:underline" onClick={() => onViewMap(p)}>
                    View on map
                  </button>
                  <button
                    className="ml-3 text-xs font-semibold text-ink/50 hover:text-ink hover:underline"
                    onClick={() => onKick(p)}
                  >
                    Kick
                  </button>
                  <button
                    className="ml-3 text-xs font-semibold text-destructive/70 hover:text-destructive hover:underline"
                    onClick={() => onBan(p)}
                  >
                    Ban
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
