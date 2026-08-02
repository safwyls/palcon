import type { Feature, Server } from "./api";

/**
 * Which views a signed-in user gets.
 *
 * Admins bypass every switch — the point of the feature is letting a server
 * owner honour a privacy request without blinding themselves for moderation.
 * The API enforces the same rule; this only decides what the nav offers, so a
 * disagreement between the two costs a 403, not a leak.
 */

/** Raw flag: has an admin switched this view off for this server? */
export function featureOff(server: Server | undefined, feature: Feature): boolean {
  return Boolean(server?.hiddenFeatures?.includes(feature));
}

/** Whether this user should be offered the view at all. */
export function canSeeFeature(server: Server | undefined, feature: Feature, isAdmin: boolean): boolean {
  return isAdmin || !featureOff(server, feature);
}

/** Human names, for nav labels and the settings switches. Kept here so the
 * label and the key that gates it can't drift apart. */
export const FEATURE_LABELS: Record<Feature, string> = {
  map: "Live map",
  pals: "Player pals",
  inventory: "Inventory",
  storage: "Storage",
  paldex: "Paldex",
  guilds: "Guilds",
  calculators: "Calculators",
};

/** What each view exposes, for the settings page. Written from the player's
 * side — what someone would be agreeing to when they ask to be hidden. */
export const FEATURE_BLURBS: Record<Feature, string> = {
  map: "Where players are now, and where they logged off",
  pals: "Every player's pals, with IVs and passives",
  inventory: "What each player is carrying, wearing and hoarding",
  storage: "What's in every chest and box at the guild's bases",
  paldex: "Paldex completion and capture counts per player",
  guilds: "Guild rosters, bases and shared pal totals",
  calculators: "Breeding tools that read the pals in your boxes",
};
