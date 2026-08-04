import type { Feature, Server } from "./api";

/**
 * Which views a signed-in user gets.
 *
 * Two different questions, deliberately kept apart:
 *  - does this server's game have this view at all (server.features), and
 *  - has an admin switched it off for this server (server.hiddenFeatures)?
 *
 * The first is a fact about the game and applies to everyone including admins.
 * The second is a privacy switch, and admins bypass it — the point of the
 * feature is letting a server owner honour a privacy request without blinding
 * themselves for moderation. The API enforces the same rules; a disagreement
 * costs a 403, not a leak.
 *
 * Human-readable names for these keys are per-game and live in lib/games.
 */

/** Does this server's game offer the view at all? */
export function featureExists(server: Server | undefined, feature: Feature): boolean {
  // An older payload with no features list is Palworld, which has them all.
  if (!server?.features) return true;
  return server.features.includes(feature);
}

/** Raw flag: has an admin switched this view off for this server? */
export function featureOff(server: Server | undefined, feature: Feature): boolean {
  return Boolean(server?.hiddenFeatures?.includes(feature));
}

/** Whether this user should be offered the view at all. */
export function canSeeFeature(server: Server | undefined, feature: Feature, isAdmin: boolean): boolean {
  if (!featureExists(server, feature)) return false;
  return isAdmin || !featureOff(server, feature);
}

/** The views this server offers, in nav order. */
export function serverFeatures(server: Server | undefined): Feature[] {
  return server?.features ?? [];
}
