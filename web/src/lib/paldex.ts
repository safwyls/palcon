import palDex from "../data/palDex.json";
import palStats from "../data/palStats.json";
import passiveSkills from "../data/passiveSkills.json";
import activeSkills from "../data/activeSkills.json";

/**
 * Lookups that turn a save file's internal ids into what the game actually
 * calls things — "PinkCat" is Cattiva, "PAL_ALLAttack_up1" is Brave.
 *
 * Data and icons are vendored from palworld-server-manager (MIT), which
 * sources the catalogs from palworld-save-pal's English localization; see
 * web/public/pal-icons/README.md. Every lookup falls back to the raw id, so
 * a pal added by a game update shows up with its internal name rather than
 * disappearing.
 */

interface PalEntry {
  name: string;
  elements: string[];
  rarity: number;
}

/** Skills and passives are stored as {n: name, d: description} to keep the
 * chunk small; `d` is often just the name repeated, which callers drop. */
interface NamedEntry {
  n: string;
  /** Null for entries the catalog has no blurb for. */
  d: string | null;
}

const dex = palDex as Record<string, PalEntry>;
const passives = passiveSkills as Record<string, NamedEntry>;
const actives = activeSkills as Record<string, NamedEntry>;
const stats = palStats as Record<string, { hp: number; stomach: number }>;

/** Icons and dex entries share one key: the id lowercased, minus the
 * BOSS_ prefix that marks an alpha variant of an otherwise normal pal. */
export function palKey(characterId: string): string {
  return characterId.toLowerCase().replace(/^boss_/, "");
}

export function palEntry(characterId: string): PalEntry | undefined {
  return dex[palKey(characterId)];
}

export function palName(characterId: string): string {
  return palEntry(characterId)?.name ?? characterId;
}

export function palIconUrl(characterId: string): string {
  return `/pal-icons/${palKey(characterId)}.webp`;
}

export function passiveName(code: string): string {
  return passives[code]?.n ?? code;
}

/** Description, or "" when the catalog just repeats the name (many do). */
export function passiveDescription(code: string): string {
  const entry = passives[code];
  if (!entry?.d || entry.d === entry.n) return "";
  return entry.d;
}

export function skillName(code: string): string {
  return actives[code]?.n ?? code;
}

export function skillDescription(code: string): string {
  const entry = actives[code];
  if (!entry?.d || entry.d === entry.n) return "";
  return entry.d;
}

/** Base max HP and stomach for the species, used to show a pal's current
 * values as a proportion. Undefined for anything not in the catalog. */
export function palBaseStats(characterId: string): { hp: number; stomach: number } | undefined {
  return stats[palKey(characterId)];
}

/** Rarity 8+ is the game's own threshold for a rare (blue-tier) pal, 12+ for
 * legendary — used only to tint the icon frame. */
export function rarityTier(rarity: number): "legendary" | "rare" | "common" {
  if (rarity >= 12) return "legendary";
  if (rarity >= 8) return "rare";
  return "common";
}

export const ELEMENT_COLORS: Record<string, string> = {
  Normal: "#9C9186",
  Fire: "#E8491D",
  Water: "#5B9BD5",
  Leaf: "#4A9D7C",
  Electricity: "#F2A93B",
  Ice: "#7FC8E8",
  Earth: "#A9773F",
  Dark: "#6B4A7E",
  Dragon: "#8B3A9E",
};

export function elementColor(element: string): string {
  return ELEMENT_COLORS[element] ?? "#9C9186";
}
