import { passiveName, passiveTier } from "../lib/paldex";
import { cn } from "../lib/utils";

/**
 * Passive-skill chips that mirror the game's tier iconography: a dark slate
 * pill carrying |tier| chevrons (capped at 3) — up in ice/gold for positive
 * tiers, down in red for negative ones. The two special tiers keep their
 * in-game grounds: Rainbow passives (Legend, Lucky, …) sit on indigo, World
 * Tree passives on violet, both with aqua chevrons. Colors are sampled from
 * the tier icons themselves; see the `tier` group in tailwind.config.js.
 */

interface TierLook {
  pill: string;
  chevron: string;
  label: string;
}

function tierLook(tier: number): TierLook {
  if (tier >= 5) return { pill: "bg-tier-violet text-paper", chevron: "text-tier-aqua", label: "World Tree tier" };
  if (tier === 4) return { pill: "bg-tier-indigo text-paper", chevron: "text-tier-aqua", label: "Rainbow tier" };
  if (tier >= 2) return { pill: "bg-tier-slate text-paper/90", chevron: "text-tier-gold", label: `Tier +${tier}` };
  if (tier === 1) return { pill: "bg-tier-slate text-paper/90", chevron: "text-tier-ice", label: "Tier +1" };
  if (tier < 0) return { pill: "bg-tier-slate text-paper/90", chevron: "text-tier-red", label: `Tier ${tier}` };
  return { pill: "bg-tier-slate text-paper/75", chevron: "", label: "" };
}

/** The rank glyph: one chevron per tier step, pointing the way the tier
 * pulls. Tiers 4 and 5 draw the full three; their ground color does the
 * rest. Renders nothing for unranked codes. */
export function TierChevrons({ tier, size = 10, className }: { tier: number; size?: number; className?: string }) {
  const count = Math.min(Math.abs(tier), 3);
  if (count === 0) return null;
  const start = (10 - (2.5 + (count - 1) * 3)) / 2;
  const ys = Array.from({ length: count }, (_, i) => start + i * 3);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <g
        transform={tier < 0 ? "rotate(180 5 5)" : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ys.map((y) => (
          <path key={y} d={`M1.5 ${y + 2.5} L5 ${y} L8.5 ${y + 2.5}`} />
        ))}
      </g>
    </svg>
  );
}

/** Roster-card chip: chevrons + name on the game's slate pill. */
export function PassiveBadge({ code }: { code: string }) {
  const tier = passiveTier(code);
  const look = tierLook(tier);
  return (
    <span
      title={look.label ? `${code} · ${look.label}` : code}
      // `relative` contains the sr-only label: it's position:absolute, and
      // without a positioned parent it anchors to the initial containing block
      // instead, escaping any overflow-hidden/auto scroller it sits in. Chips
      // render in the hundreds, so those stray offsets add up to real scroll.
      className={cn(
        "relative inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
        look.pill,
      )}
    >
      <TierChevrons tier={tier} size={9} className={look.chevron} />
      {passiveName(code)}
      {look.label && <span className="sr-only">, {look.label}</span>}
    </span>
  );
}

/** Detail-view rank tile: the chevrons on their own small slate square, like
 * the game's standalone tier icons, for placing beside text on light rows.
 * Takes a code, or a tier directly for callers that only know a passive by
 * its display name (the filter menu groups codes by name). */
export function PassiveTierTile({ code, tier = passiveTier(code ?? "") }: { code?: string; tier?: number }) {
  if (tier === 0) return null;
  const look = tierLook(tier);
  return (
    <span
      title={look.label}
      className={cn("relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded", look.pill)}
    >
      <TierChevrons tier={tier} size={12} className={look.chevron} />
      <span className="sr-only">{look.label}</span>
    </span>
  );
}
