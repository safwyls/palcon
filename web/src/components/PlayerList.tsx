import type { Player } from "../lib/api";

export function PlayerList({
  players,
  onKick,
  onBan,
}: {
  players: Player[];
  onKick: (player: Player) => void;
  onBan: (player: Player) => void;
}) {
  if (players.length === 0) {
    return <p className="text-sm text-slate-500">No players online.</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead className="text-slate-400">
        <tr>
          <th className="py-1 pr-4">Name</th>
          <th className="py-1 pr-4">Level</th>
          <th className="py-1 pr-4">Ping</th>
          <th className="py-1"></th>
        </tr>
      </thead>
      <tbody>
        {players.map((p) => (
          <tr key={p.playerId} className="border-t border-slate-800">
            <td className="py-2 pr-4">{p.name}</td>
            <td className="py-2 pr-4">{p.level}</td>
            <td className="py-2 pr-4">{Math.round(p.ping)}ms</td>
            <td className="space-x-2 py-2 text-right">
              <button onClick={() => onKick(p)} className="rounded bg-amber-700 px-2 py-1 text-xs hover:bg-amber-600">
                Kick
              </button>
              <button onClick={() => onBan(p)} className="rounded bg-red-800 px-2 py-1 text-xs hover:bg-red-700">
                Ban
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
