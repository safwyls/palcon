import type { Feature, Server } from "./api";

/**
 * Per-game presentation.
 *
 * The console itself is game-agnostic: it navigates by feature key, and the
 * API tells it which keys a given server offers. What it can't know is what to
 * *call* them — "Paldex" and "Player pals" are Palworld's words, and ARK's
 * equivalents are "Dinodex" and "Tames". That vocabulary lives here, one entry
 * per game, so adding a game means adding a profile rather than editing every
 * component that renders a label.
 *
 * Route segments deliberately do NOT live here: they're part of the URL
 * contract and stay the same whatever the game calls a view, so a bookmark
 * survives and a shared link means one thing.
 */
export interface GameProfile {
  id: string;
  name: string;
  /** Nav and settings labels, per feature key. */
  labels: Record<Feature, string>;
  /** What each view exposes, for the settings page. Written from the player's
   * side — what someone would be agreeing to when they ask to be hidden. */
  blurbs: Record<Feature, string>;
}

const PALWORLD: GameProfile = {
  id: "palworld",
  name: "Palworld",
  labels: {
    map: "Live map",
    pals: "Player pals",
    inventory: "Inventory",
    storage: "Storage",
    paldex: "Paldex",
    achievements: "Achievements",
    guilds: "Guilds",
    calculators: "Calculators",
  },
  blurbs: {
    map: "Where players are now, and where they logged off",
    pals: "Every player's pals, with IVs and passives",
    inventory: "What each player is carrying, wearing and hoarding",
    storage: "What's in every chest and box at the guild's bases",
    paldex: "Paldex completion and capture counts per player",
    achievements: "Which towers, raids and bosses each player has beaten",
    guilds: "Guild rosters, bases and shared pal totals",
    calculators: "Breeding tools that read the pals in your boxes",
  },
};

const GAMES: Record<string, GameProfile> = {
  [PALWORLD.id]: PALWORLD,
};

/**
 * The profile for a game id. Falls back to Palworld for an empty id (every
 * server predating multi-game support) and for a game this build doesn't know
 * — the backend is the authority on which views exist, so an unknown game
 * still navigates correctly, just with borrowed words.
 */
export function gameProfile(id: string | undefined): GameProfile {
  return (id && GAMES[id]) || PALWORLD;
}

/** The label for one of a server's views. */
export function featureLabel(server: Server | undefined, feature: Feature): string {
  return gameProfile(server?.game).labels[feature] ?? feature;
}

/** The settings-page description for one of a server's views. */
export function featureBlurb(server: Server | undefined, feature: Feature): string {
  return gameProfile(server?.game).blurbs[feature] ?? "";
}

/**
 * Where each view lives under /servers/:id. The segment differs from the
 * feature key for pals — the page has always lived at /players, and changing
 * it would break every bookmark.
 */
export const FEATURE_ROUTES: Record<Feature, string> = {
  map: "map",
  pals: "players",
  inventory: "inventory",
  storage: "storage",
  paldex: "paldex",
  achievements: "achievements",
  guilds: "guilds",
  calculators: "calculators",
};
