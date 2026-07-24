import type { Pal } from "../lib/api";
import {
  elementColor,
  palBaseStats,
  palEntry,
  palIconUrl,
  palName,
  passiveDescription,
  passiveName,
  rarityTier,
  skillDescription,
  skillName,
} from "../lib/paldex";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

/** IVs run 0-100; the bar makes "is this one worth keeping" readable at a
 * glance in a way three bare numbers don't. */
function TalentBar({ label, value }: { label: string; value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  const tone = pct >= 70 ? "#4A9D7C" : pct >= 40 ? "#F2A93B" : "#9C9186";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-ink/50">{label}</span>
        <span className="font-mono text-xs font-bold" style={{ color: tone }}>
          {value}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: tone }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink/10 bg-ink/[0.03] px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/40">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-bold text-ink">{value}</p>
    </div>
  );
}

export function PalDetailDialog({
  pal,
  location,
  onClose,
}: {
  pal: Pal | null;
  location: string;
  onClose: () => void;
}) {
  if (!pal) return null;

  const species = palName(pal.characterId);
  const entry = palEntry(pal.characterId);
  const base = palBaseStats(pal.characterId);
  const tier = rarityTier(entry?.rarity ?? 0);
  const souls = Object.entries(pal.souls ?? {});

  return (
    <Dialog open={pal !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border",
                tier === "legendary"
                  ? "border-legendary/40 bg-legendary/10"
                  : tier === "rare"
                    ? "border-pal-blue/40 bg-pal-blue/10"
                    : "border-ink/10 bg-ink/5",
              )}
            >
              <img
                src={palIconUrl(pal.characterId)}
                alt=""
                className="h-12 w-12 object-contain"
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
            </span>
            <span className="min-w-0">
              <span className="block truncate">
                {pal.nickname || species}
                {pal.gender && (
                  <span
                    className={cn("ml-1.5 text-xl", pal.gender === "female" ? "text-brand-red" : "text-pal-blue")}
                    aria-label={pal.gender === "female" ? "Female" : "Male"}
                    role="img"
                  >
                    {pal.gender === "female" ? "♀" : "♂"}
                  </span>
                )}
              </span>
              <span className="block text-sm font-normal text-ink/50">
                {pal.nickname ? `${species} · ` : ""}Lv.{pal.level} · {location}
                {pal.slotIndex >= 0 && ` slot ${pal.slotIndex + 1}`}
              </span>
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {(entry?.elements ?? []).map((el) => (
              <span
                key={el}
                className="rounded px-2 py-0.5 text-xs font-semibold"
                style={{ backgroundColor: `${elementColor(el)}22`, color: elementColor(el) }}
              >
                {el}
              </span>
            ))}
            {pal.isBoss && (
              <Badge variant="outline" className="border-legendary/40 bg-legendary/10 text-legendary">
                Alpha
              </Badge>
            )}
            {pal.isLucky && (
              <Badge variant="outline" className="border-brand-amber/40 bg-brand-amber/10 text-brand-amber">
                Lucky
              </Badge>
            )}
            {pal.rank > 1 && (
              <Badge variant="outline" className="border-pal-blue/40 bg-pal-blue/10 text-pal-blue">
                Condenser +{pal.rank - 1}
              </Badge>
            )}
          </div>

          {pal.sick && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              Ailing: {pal.sick.replace(/([a-z])([A-Z])/g, "$1 $2")} — a sick pal stops working at a base until
              treated.
            </p>
          )}

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Talents (IVs)</p>
            <div className="grid grid-cols-3 gap-3">
              <TalentBar label="HP" value={pal.talentHp} />
              <TalentBar label="Attack" value={pal.talentShot} />
              <TalentBar label="Defense" value={pal.talentDefense} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="HP" value={pal.hp ? String(pal.hp) : "—"} />
            <Stat
              label="Stomach"
              value={base?.stomach ? `${Math.round(pal.stomach)}/${base.stomach}` : String(Math.round(pal.stomach))}
            />
            <Stat label="Sanity" value={`${Math.round(pal.sanity)}`} />
            <Stat label="Friendship" value={String(pal.friendship)} />
          </div>

          {pal.skills.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Equipped skills</p>
              <div className="space-y-1.5">
                {pal.skills.map((s) => (
                  <div key={s} className="rounded-lg border border-ink/10 bg-white/60 px-3 py-2">
                    <p className="text-sm font-semibold text-ink">{skillName(s)}</p>
                    {skillDescription(s) && <p className="mt-0.5 text-xs text-ink/55">{skillDescription(s)}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {pal.passives.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Passive skills</p>
              <div className="space-y-1.5">
                {pal.passives.map((p) => (
                  <div key={p} className="rounded-lg border border-ink/10 bg-white/60 px-3 py-2">
                    <p className="text-sm font-semibold text-ink">{passiveName(p)}</p>
                    {passiveDescription(p) && <p className="mt-0.5 text-xs text-ink/55">{passiveDescription(p)}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {souls.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Soul upgrades</p>
              <div className="flex flex-wrap gap-1.5">
                {souls.map(([stat, points]) => (
                  <span key={stat} className="rounded-full bg-ink/5 px-2 py-1 font-mono text-xs text-ink/60">
                    {stat} +{points}
                  </span>
                ))}
              </div>
            </div>
          )}

          <p className="border-t border-ink/10 pt-3 font-mono text-[10px] text-ink/30">
            {pal.characterId} · {pal.instanceId}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
