import palCombat from "../data/palCombat.json";
import palPassives from "../data/palPassives.json";
import type { Pal } from "./api";
import { palKey, palEntry } from "./paldex";

/**
 * Estimated pal stats from species, level, talents (IVs) and upgrades.
 *
 * Calibrated against in-game numbers: the base + level + talent core is exact
 * (talents worth up to +30%). On top of it:
 *  - Passives of the same stat stack ADDITIVELY (Legend +20% and Burly Body
 *    +20% give +40% defense, not ×1.44).
 *  - Condenser (+5%/star) and souls (+3%/rank) multiply.
 *  - An Alpha (captured field boss) carries an HP-only bonus of +rarity%, which
 *    is why a level-70 alpha Jetragon shows ~15% more HP than its listed base.
 *  - Trust/bond uses the game's per-pal friendship rate, but the exact curve
 *    isn't published, so it's the one approximate term.
 *
 * Base values are [hp, shotAttack, defense, then the three friendship rates].
 * "attack" is shot attack — the value the game surfaces as Attack.
 */
const combat = palCombat as Record<string, number[]>;
const passiveEffects = palPassives as Record<string, number[]>; // code -> [atk%, def%, hp%]

/** Base [hp, attack, defense] for a species, or null when the catalog has no
 * combat stats for it (a handful of event/variant forms). */
export function baseStats(characterId: string): { hp: number; attack: number; defense: number } | null {
  const b = combat[palKey(characterId)];
  return b ? { hp: b[0], attack: b[1], defense: b[2] } : null;
}

export function hasCombatStats(characterId: string): boolean {
  return palKey(characterId) in combat;
}

/** Per-level trust bonus rates [hp%, attack%, defense%] for the species. */
function trustRates(characterId: string): [number, number, number] {
  const b = combat[palKey(characterId)];
  return b && b.length >= 6 ? [b[3], b[4], b[5]] : [0, 0, 0];
}

/** Whether a passive code actually changes the displayed HP/Attack/Defense. */
export function passiveAffectsStats(code: string): boolean {
  return code in passiveEffects;
}

/** A passive's stat effect as [attack%, defense%, hp%], or null when it doesn't
 * touch the displayed stats (element-damage and player-buff passives don't). */
export function passiveStatEffect(code: string): [number, number, number] | null {
  const e = passiveEffects[code];
  return e ? [e[0], e[1], e[2]] : null;
}

export interface StatInput {
  characterId: string;
  level: number;
  /** Talents (IVs), 0–100 each. */
  ivHp: number;
  ivAttack: number;
  ivDefense: number;
  /** Soul upgrade rank per stat, 0–20 (+3% each). */
  soulHp?: number;
  soulAttack?: number;
  soulDefense?: number;
  /** Condenser stars, 0–4 (+5% each), applied to all three. */
  condenser?: number;
  /** Trust/bond level; scaled by the species' friendship rates. Approximate. */
  trust?: number;
  /** Passive skill codes; only stat-affecting ones move the numbers. */
  passives?: string[];
  /** Captured field boss — adds an HP-only bonus of +rarity%. */
  isAlpha?: boolean;
}

export interface StatResult {
  hp: number;
  attack: number;
  defense: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ivMult = (iv: number) => 1 + 0.3 * (clamp(iv, 0, 100) / 100);
const soulMult = (soul: number) => 1 + 0.03 * clamp(soul, 0, 20);

// Bond point → rank thresholds (0–10), vendored from PalworldSaveTools. Souls
// store their own rank; friendship is stored as accumulated points, so this
// maps them to the rank the game shows as "Trust".
const FRIENDSHIP_THRESHOLDS = [0, 6000, 13000, 21000, 30000, 40000, 55000, 80000, 110000, 150000, 200000];
export function friendshipRank(points: number): number {
  let rank = 0;
  for (let i = 0; i < FRIENDSHIP_THRESHOLDS.length; i++) if (points >= FRIENDSHIP_THRESHOLDS[i]) rank = i;
  return rank;
}
// Empirical scale on the per-pal friendship rate: the vendored rates slightly
// overshoot the in-game bond bonus; 0.85 lands within ~1% across calibration.
const TRUST_SCALE = 0.85;
const trustMult = (rate: number, rank: number) => 1 + (rate / 100) * clamp(rank, 0, 10) * TRUST_SCALE;

/** Summed passive percentages per stat: [atk%, def%, hp%]. Same-stat passives
 * add rather than compound. */
function passiveSums(passives: string[] | undefined): [number, number, number] {
  const s: [number, number, number] = [0, 0, 0];
  for (const code of passives ?? []) {
    const e = passiveEffects[code];
    if (e) {
      s[0] += e[0];
      s[1] += e[1];
      s[2] += e[2];
    }
  }
  return s;
}

export function computeStats(input: StatInput): StatResult | null {
  const base = baseStats(input.characterId);
  if (!base) return null;
  const L = Math.max(1, input.level);
  const cond = 1 + 0.05 * clamp(input.condenser ?? 0, 0, 4);
  const trust = Math.max(0, input.trust ?? 0);
  const [fHp, fAtk, fDef] = trustRates(input.characterId);
  const [sAtk, sDef, sHp] = passiveSums(input.passives);
  // Alphas carry an HP-only bonus equal to the pal's rarity, in percent.
  const rarity = palEntry(input.characterId)?.rarity ?? 0;
  const baseHp = input.isAlpha ? base.hp * (1 + rarity / 100) : base.hp;

  const hp = Math.floor(
    (500 + 5 * L + baseHp * 0.5 * L * ivMult(input.ivHp)) *
      cond * soulMult(input.soulHp ?? 0) * trustMult(fHp, trust) * (1 + sHp / 100),
  );
  const attack = Math.floor(
    (100 + base.attack * 0.075 * L * ivMult(input.ivAttack)) *
      cond * soulMult(input.soulAttack ?? 0) * trustMult(fAtk, trust) * (1 + sAtk / 100),
  );
  const defense = Math.floor(
    (50 + base.defense * 0.075 * L * ivMult(input.ivDefense)) *
      cond * soulMult(input.soulDefense ?? 0) * trustMult(fDef, trust) * (1 + sDef / 100),
  );
  return { hp, attack, defense };
}

/** Effective stats for a pal read from a save, wiring its level, talents,
 * condenser rank, souls, passives, alpha flag and bond into computeStats. The
 * save stores friendship as accumulated points, so they're mapped to the trust
 * rank first. Null when the species has no combat data. */
export function palEffectiveStats(pal: Pal): StatResult | null {
  const souls = pal.souls ?? {};
  return computeStats({
    characterId: pal.characterId,
    level: pal.level,
    ivHp: pal.talentHp,
    ivAttack: pal.talentShot,
    ivDefense: pal.talentDefense,
    condenser: Math.max(0, pal.rank - 1),
    soulHp: souls["Max HP"] ?? 0,
    soulAttack: souls["Attack"] ?? 0,
    soulDefense: souls["Defense"] ?? 0,
    trust: friendshipRank(pal.friendship),
    passives: pal.passives,
    isAlpha: pal.isBoss,
  });
}

/** Per-stat colors for effective HP / Attack / Defense, so the bars in the pal
 * dialog and the triplets on the records board name the same stat the same
 * way. */
export const STAT_COLORS = { hp: "#5B9E6F", attack: "#E0502F", defense: "#5B8DEF" };

/**
 * One number for ranking pals against each other by raw strength.
 *
 * The three stats can't simply be summed: HP runs to five figures while attack
 * and defense sit in the hundreds, so HP alone would decide every ranking. The
 * scaling factor isn't invented — computeStats above grows HP by 0.5 per level
 * and attack/defense by 0.075, while the species base values all share one
 * ~60–200 range. Multiplying HP by 0.075/0.5 therefore puts all three back into
 * base-stat units, and the total comes out proportional to the pal's effective
 * base-stat sum times its level.
 *
 * Everything computeStats folds in rides along: level, talents, condenser,
 * souls, trust, the alpha bonus, and the passives that move stats. Passives
 * that don't (Lucky, work suitability, element damage) stay out, which is why
 * a ranking by this is a strength ranking and not a "best pal" ranking.
 */
export function powerScore(s: StatResult): number {
  return s.hp * 0.15 + s.attack + s.defense;
}

/** IV color cue, shared by every talent readout in the app: gold is a
 * perfect 100, green (70–99) is breeding stock, blue is below par. */
export function talentTone(v: number): string {
  if (v >= 100) return "#D4A017";
  if (v >= 70) return "#4A9D7C";
  return "#5B9BD5";
}

export interface TalentRating {
  /** Single-letter tier, S being a near-perfect roll. */
  tier: "S" | "A" | "B" | "C" | "D";
  /** Average of the three talents, 0–100. */
  average: number;
}

/** A quick read on a pal's talent roll, averaged across the three stats. */
export function talentRating(ivHp: number, ivAttack: number, ivDefense: number): TalentRating {
  const average = Math.round((clamp(ivHp, 0, 100) + clamp(ivAttack, 0, 100) + clamp(ivDefense, 0, 100)) / 3);
  const tier = average >= 90 ? "S" : average >= 70 ? "A" : average >= 50 ? "B" : average >= 30 ? "C" : "D";
  return { tier, average };
}
