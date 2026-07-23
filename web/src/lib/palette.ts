// Deterministic color assignment for servers and players, cycling the five
// literal Palworld palette tokens (see tailwind.config.js). Colors are pure
// identity hints — nothing semantic hangs off them — so a stable arbitrary
// assignment (id/hash modulo palette) is all that's needed.

export const PALETTE = [
  "#4A9D7C", // pal-green
  "#5B9BD5", // pal-blue
  "#E8491D", // brand-red
  "#F2A93B", // brand-amber
  "#8B3A9E", // legendary
] as const;

export function serverColor(serverId: number): string {
  return PALETTE[serverId % PALETTE.length];
}

export function playerColor(playerId: string): string {
  let hash = 0;
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "??";
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
}

export function pingColorClass(ping: number): string {
  if (ping <= 60) return "text-pal-green";
  if (ping <= 120) return "text-brand-amber";
  return "text-brand-red";
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${m}m`;
}
