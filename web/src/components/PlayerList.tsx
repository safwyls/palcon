import type { Player } from "../lib/api";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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
    return <p className="text-sm text-muted-foreground">No players online.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Level</TableHead>
          <TableHead>Ping</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {players.map((p) => (
          <TableRow key={p.playerId}>
            <TableCell className="font-medium text-foreground">{p.name}</TableCell>
            <TableCell>{p.level}</TableCell>
            <TableCell>{Math.round(p.ping)}ms</TableCell>
            <TableCell className="space-x-2 text-right">
              <Button variant="secondary" size="sm" onClick={() => onKick(p)}>
                Kick
              </Button>
              <Button variant="destructive" size="sm" onClick={() => onBan(p)}>
                Ban
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
