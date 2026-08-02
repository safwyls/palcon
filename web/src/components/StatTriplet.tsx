import { STAT_COLORS } from "../lib/stats";

/** The compact effective `hp/atk/def` readout, tinted with the same per-stat
 * colors as the pal dialog's bars. Deliberately shaped like TalentTriplet, so
 * a records row reads the same whether it carries talents or estimated stats.
 * Callers set font/size via className. */
export function StatTriplet({
  hp,
  attack,
  defense,
  className,
}: {
  hp: number;
  attack: number;
  defense: number;
  className?: string;
}) {
  return (
    <span className={className} title="Estimated stats: HP / Attack / Defense">
      <span style={{ color: STAT_COLORS.hp }}>{hp}</span>
      <span className="opacity-50">/</span>
      <span style={{ color: STAT_COLORS.attack }}>{attack}</span>
      <span className="opacity-50">/</span>
      <span style={{ color: STAT_COLORS.defense }}>{defense}</span>
    </span>
  );
}
