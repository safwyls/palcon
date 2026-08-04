import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Crown, Dumbbell, Sparkles, Swords, Target } from "lucide-react";
import { api, ApiError, type Pal, type PlayerPals } from "../lib/api";
import {
  DECK_BASE_ENTRIES,
  DECK_UNCATCHABLE_ENTRIES,
  DECK_VARIANT_ENTRIES,
  palDeckNo,
  palDeckSortValue,
  palEntry,
  palIconUrl,
  palName,
  passiveTier,
  completionPct,
} from "../lib/paldex";
import { initials, playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { palEffectiveStats, powerScore } from "../lib/stats";
import { ElementTag } from "../components/ElementIcon";
import { PalPortrait } from "../components/PalPortrait";
import { PassiveTierTile } from "../components/PassiveBadge";
import { StatTriplet } from "../components/StatTriplet";
import { TalentTriplet } from "../components/TalentTriplet";
import { TIER_LOOKS, TierTile, type TierLook } from "../components/TierTile";
import { SavePathSetup } from "../components/SavePathSetup";
import { SaveReadProgress } from "../components/SaveReadProgress";
import { SaveUpdatingBanner } from "../components/SaveUpdatingBanner";
import { ServerUnreachable } from "../components/ServerUnreachable";

/** All of a player's pals, wherever they live. */
function allPals(p: PlayerPals): Pal[] {
  return [...p.party, ...p.palbox, ...p.base, ...p.storage];
}

/** A player's registered deck labels. The save's record ids normalize
 * through palDeckNo, so decorated capture ids count for their species. */
function deckLabels(p: PlayerPals): Set<string> {
  const out = new Set<string>();
  for (const id of p.paldeck) {
    const label = palDeckNo(id);
    if (label) out.add(label);
  }
  return out;
}

/**
 * Deck labels of the species a player has actually thrown a sphere at.
 *
 * The save keeps two separate records and they mean different things:
 * PaldeckUnlockFlag registers a species however it was acquired — caught,
 * hatched, traded, awarded — while PalCaptureCount only ever counts sphere
 * captures. The difference between them is the one thing the save says about
 * how a pal was obtained; nothing on an individual pal records its origin.
 */
function sphereCaughtLabels(p: PlayerPals): Set<string> {
  const out = new Set<string>();
  for (const [characterId, count] of Object.entries(p.captures ?? {})) {
    if (count <= 0) continue;
    const label = palDeckNo(characterId);
    if (label) out.add(label);
  }
  return out;
}

/** Deck labels of the species a player currently owns, for flagging
 * "in the box but never registered" (a traded-in pal doesn't write the
 * receiver's dex — verified against a real save). */
function ownedLabels(p: PlayerPals): Set<string> {
  const out = new Set<string>();
  for (const pal of allPals(p)) {
    const label = palDeckNo(pal.characterId);
    if (label) out.add(label);
  }
  return out;
}

const BASE_ENTRIES = DECK_BASE_ENTRIES;
const VARIANT_ENTRIES = DECK_VARIANT_ENTRIES;
const UNCATCHABLE = DECK_UNCATCHABLE_ENTRIES;

/** One Paldeck slot: its in-game number and an id to draw it by. */
type DeckEntry = { label: string; characterId: string };

/**
 * The hero wears the game's passive-tier tiles as the server levels up:
 * the negative red tile below 25%, tier-1 ice to 50%, gold to 75%, and the
 * Rainbow aqua from 75%. The tile itself lives in TierTile — the Automation
 * page's next-restart hero wears the same four looks.
 */
function heroLook(pct: number): TierLook {
  if (pct >= 75) return TIER_LOOKS.aqua;
  if (pct >= 50) return TIER_LOOKS.gold;
  if (pct >= 25) return TIER_LOOKS.ice;
  return TIER_LOOKS.red;
}

function PlayerChip({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-paper"
        style={{ backgroundColor: playerColor(name) }}
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

function DexChip({
  entry,
  owned,
  ownedText = "owned",
  title,
}: {
  entry: DeckEntry;
  owned: boolean;
  /** The word on the amber marker — "owned" reads as the player's own box on
   * the per-player lists, but as somebody's box on the server-wide board. */
  ownedText?: string;
  /** Overrides the hover text, for lists where the species isn't missing. */
  title?: string;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 rounded-lg border bg-white py-1 pl-1 pr-2",
        owned ? "border-brand-amber/60 ring-1 ring-brand-amber/40" : "border-ink/10",
      )}
      title={
        title ??
        (owned
          ? `${palName(entry.characterId)} — in their box but not registered; the dex only counts pals they acquired themselves (a traded pal doesn't register).`
          : palName(entry.characterId))
      }
    >
      <img src={palIconUrl(entry.characterId)} alt="" loading="lazy" className="h-5 w-5 object-contain" />
      <span className="font-mono text-[10px] text-ink/40">#{entry.label}</span>
      <span className="max-w-[7rem] truncate text-xs text-ink/70">{palName(entry.characterId)}</span>
      {owned && <span className="text-[10px] font-semibold text-brand-amber">{ownedText}</span>}
    </span>
  );
}

function CompletionRow({ player }: { player: PlayerPals }) {
  const [open, setOpen] = useState(false);
  const caught = useMemo(() => deckLabels(player), [player]);
  const owned = useMemo(() => ownedLabels(player), [player]);
  const caughtBase = useMemo(() => BASE_ENTRIES.filter((e) => caught.has(e.label)).length, [caught]);
  const caughtVariants = useMemo(() => VARIANT_ENTRIES.filter((e) => caught.has(e.label)).length, [caught]);
  const total = BASE_ENTRIES.length;
  const pct = completionPct(caughtBase, total);
  // A species sitting in the box isn't missing in any useful sense — the
  // player has one, they just have nothing to go and find. So ownership pulls
  // an entry out of the missing lists and into its own group below, rather
  // than leaving it among the species they still have to hunt down. Some
  // entries can only ever land here: a few Paldeck slots are spawn variants
  // the save never writes into the dex record, so owning one is the only
  // evidence there is.
  const missingBase = useMemo(
    () => BASE_ENTRIES.filter((e) => !caught.has(e.label) && !owned.has(e.label)),
    [caught, owned],
  );
  const missingVariants = useMemo(
    () => VARIANT_ENTRIES.filter((e) => !caught.has(e.label) && !owned.has(e.label)),
    [caught, owned],
  );
  const unregistered = useMemo(
    () => [...BASE_ENTRIES, ...VARIANT_ENTRIES].filter((e) => !caught.has(e.label) && owned.has(e.label)),
    [caught, owned],
  );

  // Registered species with no sphere capture behind them: hatched, traded or
  // awarded. Skipped entirely when the save carries no capture record at all,
  // because "no captures recorded" would otherwise render as "never caught any
  // of them" — a confident claim built on missing data.
  const sphereCaught = useMemo(() => sphereCaughtLabels(player), [player]);
  const neverCaught = useMemo(
    () =>
      sphereCaught.size === 0
        ? []
        : [...BASE_ENTRIES, ...VARIANT_ENTRIES].filter((e) => caught.has(e.label) && !sphereCaught.has(e.label)),
    [caught, sphereCaught],
  );
  // A player file with no dex record reads as zero registered while they
  // plainly own pals — that's missing data, not a 0% player.
  const noRecord = player.paldeck.length === 0 && allPals(player).length > 0;

  return (
    <li>
      <button
        className="flex w-full items-center gap-4 px-5 py-3.5 text-left hover:bg-ink/[0.02]"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={noRecord}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{player.nickname || player.uid.slice(0, 8)}</span>
          <span className="font-mono text-xs text-ink/40">Lv.{player.level}</span>
        </span>
        {noRecord ? (
          <span className="text-xs text-ink/45">no Paldex record in the save</span>
        ) : (
          <>
            <span className="hidden h-2 w-40 overflow-hidden rounded-full bg-ink/10 sm:block lg:w-64">
              <span className="block h-full rounded-full bg-brand-red" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-24 text-right" title="Species, with registered B-variants beneath">
              <span className="block font-mono text-sm tabular-nums">
                {caughtBase}/{total}
              </span>
              {caughtVariants > 0 && (
                <span className="block font-mono text-[11px] tabular-nums text-ink/40">
                  +{caughtVariants}/{VARIANT_ENTRIES.length}
                </span>
              )}
            </span>
            <span className="w-12 text-right font-mono text-sm font-semibold tabular-nums">{pct}%</span>
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-ink/30 transition-transform", open && "rotate-180")} />
          </>
        )}
      </button>

      {open && !noRecord && (
        <div className="space-y-3 border-t border-ink/5 bg-ink/[0.015] px-5 py-4">
          {missingBase.length === 0 && missingVariants.length === 0 && unregistered.length === 0 ? (
            <p className="text-sm text-ink/60">Paldex complete — every species and variant is registered. 🎉</p>
          ) : (
            <>
              {unregistered.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink/35">
                    In their box, unregistered · {unregistered.length}
                  </p>
                  <p className="mb-2 text-xs text-ink/45">
                    They have one, so it isn't missing — it just never wrote the dex. The dex only counts pals a
                    player acquired themselves, so traded-in pals don't register, and a few Paldeck slots are spawn
                    variants the save never records at all.
                  </p>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {unregistered.map((e) => (
                      <DexChip key={e.label} entry={e} owned ownedText="in box" />
                    ))}
                  </div>
                </div>
              )}
              {missingBase.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/35">
                    Missing · {missingBase.length}
                  </p>
                  <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
                    {/* Owned entries were filtered out above, so nothing here
                        is in a box — these are genuinely still to be found. */}
                    {missingBase.map((e) => (
                      <DexChip key={e.label} entry={e} owned={false} />
                    ))}
                  </div>
                </div>
              )}
              {missingVariants.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/35">
                    Variants missing · {missingVariants.length}
                    <span className="ml-1 normal-case text-ink/30">(not counted in the %)</span>
                  </p>
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {missingVariants.map((e) => (
                      <DexChip key={e.label} entry={e} owned={false} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Outside the missing/complete branch on purpose: a finished Paldex
              is exactly where "which of these did they never actually catch"
              is the interesting question. */}
          {neverCaught.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink/35">
                Never caught one · {neverCaught.length}
              </p>
              <p className="mb-2 text-xs text-ink/45">
                Registered, but the save records no sphere capture for them — hatched, traded or awarded. Catching
                one later takes it off this list.
              </p>
              <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                {neverCaught.map((e) => (
                  <DexChip
                    key={e.label}
                    entry={e}
                    owned={false}
                    title={`${palName(e.characterId)} — registered without a sphere capture on record. The save counts captures per species, so this only means they never caught one of these.`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * One wanted poster: the pal printed as a faded sepia photograph, because
 * nobody on the server has seen one. Hover or keyboard focus develops it into
 * full colour. Nothing is actually hidden — the number, name and element are
 * all text — so the reveal stays a flourish rather than something you have to
 * find.
 *
 * A print rather than a silhouette on purpose: about half the vendored icons
 * are cropped close-ups with no transparency, and masking those to a shape
 * gives a black rectangle. A colour filter reads the same on both kinds.
 */
function BountyPoster({ entry }: { entry: DeckEntry }) {
  const element = palEntry(entry.characterId)?.elements[0];
  return (
    <figure
      className="group relative rounded-lg border border-ink/10 bg-white px-3 pb-3 pt-3"
      title={`${palName(entry.characterId)} — no player has registered one, and none is in a box on the server.`}
    >
      <div className="mx-auto h-20 w-20 overflow-hidden rounded-md border border-ink/10 bg-paper">
        <img
          src={palIconUrl(entry.characterId)}
          alt=""
          loading="lazy"
          className="h-full w-full object-contain [filter:grayscale(1)_sepia(0.6)_brightness(0.94)_contrast(1.12)] transition-[filter] duration-300 group-hover:[filter:none] group-focus-within:[filter:none] motion-reduce:transition-none"
        />
      </div>
      {/* Struck off-register at the poster's corner rather than centred, so it
          reads as stamped on rather than laid out. It clears the print at wide
          widths and grazes it at narrow ones, which is why it doesn't multiply
          into the card: over a dark photograph multiply turns the red
          near-black and the word disappears, and over the white margin — where
          it sits the rest of the time — the blend does nothing at all.
          Decorative: the section heading already says these are wanted, so it
          stays out of the accessibility tree. */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-2 -rotate-[8deg] rounded-[3px] border border-brand-red/70 px-1.5 py-px font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-brand-red"
      >
        Wanted
      </span>
      <figcaption className="mt-1.5 text-center">
        <span className="block truncate font-display text-sm font-bold">{palName(entry.characterId)}</span>
        <span className="mt-0.5 flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] text-ink/45">
          <span className="font-mono">#{entry.label}</span>
          {element && <ElementTag element={element} />}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * Species not one player on the server has registered — the inverse of the
 * hero's percentage, so it sits directly beneath it.
 *
 * `owned` is the union of everybody's boxes: a species somebody physically has
 * but nobody registered isn't really at large, so it's marked on the list and
 * kept out of the most-wanted picks.
 */
function BountyBoard({ caught, owned }: { caught: Set<string>; owned: Set<string> }) {
  const { wanted, rest, total } = useMemo(() => {
    const all = [...BASE_ENTRIES, ...VARIANT_ENTRIES]
      .filter((e) => !caught.has(e.label))
      .sort((a, b) => palDeckSortValue(a.characterId) - palDeckSortValue(b.characterId));
    // Rarest first — the game's own rarity number, so the picks are the
    // hardest targets rather than whatever sorts to the top.
    const wanted = all
      .filter((e) => !owned.has(e.label))
      .sort(
        (a, b) =>
          (palEntry(b.characterId)?.rarity ?? 0) - (palEntry(a.characterId)?.rarity ?? 0) ||
          palDeckSortValue(b.characterId) - palDeckSortValue(a.characterId),
      )
      .slice(0, 4);
    const featured = new Set(wanted.map((e) => e.label));
    return { wanted, rest: all.filter((e) => !featured.has(e.label)), total: all.length };
  }, [caught, owned]);

  return (
    <section className="rounded-xl border border-ink/10 bg-ink/[0.035]">
      <div className="flex items-baseline justify-between gap-3 border-b border-ink/5 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-bold">Pal Bounty Board</h2>
          <p className="mt-0.5 text-xs text-ink/50">Species no player on this server has registered yet.</p>
        </div>
        {total > 0 && (
          <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-brand-red">
            {total} at large
          </span>
        )}
      </div>

      {total === 0 ? (
        <p className="px-5 py-6 text-sm text-ink/60">
          The board is clear — between them, the players have registered every catchable species. 🎉
        </p>
      ) : (
        <div className="space-y-4 px-5 py-4">
          {wanted.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/35">
                Most wanted
                <span className="ml-1 normal-case text-ink/30">(rarest first)</span>
              </p>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {wanted.map((e) => (
                  <BountyPoster key={e.label} entry={e} />
                ))}
              </div>
            </div>
          )}
          {rest.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/35">
                Also at large · {rest.length}
              </p>
              <div className="flex max-h-72 flex-wrap gap-1.5 overflow-y-auto">
                {rest.map((e) => (
                  <DexChip
                    key={e.label}
                    entry={e}
                    owned={owned.has(e.label)}
                    ownedText="in a box"
                    title={
                      owned.has(e.label)
                        ? `${palName(e.characterId)} — somebody has one in a box, but no player has registered it. Traded-in pals don't register.`
                        : `${palName(e.characterId)} — no player has registered one.`
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RecordCard({
  icon,
  title,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-ink/10 bg-white", className)}>
      <div className="flex items-center gap-2 border-b border-ink/5 px-5 py-3.5">
        {icon}
        <h3 className="font-display text-sm font-bold">{title}</h3>
      </div>
      <div className="px-5 py-3">{children}</div>
    </section>
  );
}

export function ServerPaldex() {
  const { serverID } = useParams();
  const id = Number(serverID);
  // MOCKUP ONLY: ?heroPct= previews the hero at any completion — remove
  // once the tier styling is settled.
  const heroPctParam = new URLSearchParams(window.location.search).get("heroPct");

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const infoQuery = useQuery({ queryKey: ["server-info", id], queryFn: () => api.serverInfo(id), retry: false });
  // Shares the pal viewer's cache — opening Paldex after Player pals is free.
  const palsQuery = useQuery({
    queryKey: ["server-pals", id],
    queryFn: () => api.serverPals(id),
    retry: false,
    gcTime: 60 * 60_000,
    staleTime: 60_000,
  });

  const players = useMemo(
    () => (palsQuery.data?.players ?? []).filter((p) => p.nickname || allPals(p).length > 0),
    [palsQuery.data],
  );

  const serverCaught = useMemo(() => {
    const union = new Set<string>();
    for (const p of players) for (const label of deckLabels(p)) union.add(label);
    return union;
  }, [players]);
  const serverCaughtBase = useMemo(
    () => BASE_ENTRIES.filter((e) => serverCaught.has(e.label)).length,
    [serverCaught],
  );
  const serverCaughtVariants = useMemo(
    () => VARIANT_ENTRIES.filter((e) => serverCaught.has(e.label)).length,
    [serverCaught],
  );
  /** Every box on the server, for the bounty board's "somebody has one but
   * nobody registered it" case. */
  const serverOwned = useMemo(() => {
    const union = new Set<string>();
    for (const p of players) for (const label of ownedLabels(p)) union.add(label);
    return union;
  }, [players]);

  // Every player showing an empty dex while owning pals means the save's
  // Players/*.sav records weren't readable — say so instead of rendering a
  // page of zeros that looks like nobody ever caught anything.
  const recordsUnavailable =
    players.length > 0 &&
    players.every((p) => p.paldeck.length === 0) &&
    players.some((p) => allPals(p).length > 0);

  const records = useMemo(() => {
    const owned: { pal: Pal; owner: string }[] = [];
    for (const p of players) {
      const owner = p.nickname || p.uid.slice(0, 8);
      for (const pal of allPals(p)) owned.push({ pal, owner });
    }

    // Scored once and read by both records below: estimating stats per pal is
    // cheap, but doing it inside a sort comparator over every pal on the
    // server is not.
    const scored = owned.map(({ pal, owner }) => {
      const eff = palEffectiveStats(pal);
      return {
        pal,
        owner,
        eff,
        iv: pal.talentHp + pal.talentShot + pal.talentDefense,
        power: eff ? powerScore(eff) : 0,
        // The game's own passive ranking, summed: Rainbow and World Tree
        // passives count 4 and 5, ordinary ones 1–3, and a negative passive
        // subtracts. Only used to order equal talent rolls.
        passiveRank: pal.passives.reduce((n, code) => n + passiveTier(code), 0),
      };
    });

    // Talent rolls, and nothing else — a level-1 pal can top this list, which
    // is the point: it's the breeding record. IV total caps at 300 and plenty
    // of pals reach it (93 of them in the sample world), so ties break on the
    // other half of a breeding pal — the quality of its passive set — rather
    // than on whatever order the save happened to store them in. Deliberately
    // not by strength: that would just reprint the Strongest card.
    const best = [...scored].sort((a, b) => b.iv - a.iv || b.passiveRank - a.passiveRank).slice(0, 25);

    // The other record: who actually hits hardest right now. Species, level,
    // condenser, souls, trust and stat passives all count — see powerScore.
    // Pals of a species the combat catalog doesn't cover can't be estimated,
    // so they drop out rather than rank as zero.
    const strongest = scored
      .flatMap((x) => (x.eff ? [{ ...x, eff: x.eff }] : []))
      .sort((a, b) => b.power - a.power)
      .slice(0, 25);

    const captures = players
      .map((p) => {
        // PalCaptureCount keys are raw ids — BOSS_ variants and captured
        // HUMANS included. Fold everything through the deck so a species
        // counts once, and humans stay off a pal leaderboard.
        const byLabel = new Map<string, number>();
        for (const [cid, n] of Object.entries(p.captures)) {
          const label = palDeckNo(cid);
          if (label) byLabel.set(label, (byLabel.get(label) ?? 0) + n);
        }
        let total = 0;
        for (const n of byLabel.values()) total += n;
        return { name: p.nickname || p.uid.slice(0, 8), total, species: byLabel.size };
      })
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    const hunters = players
      .map((p) => {
        const pals = allPals(p);
        return {
          name: p.nickname || p.uid.slice(0, 8),
          // The game stores luckies with the BOSS_ prefix too, so "boss"
          // alone would count every lucky as an alpha as well.
          alphas: pals.filter((x) => x.isBoss && !x.isLucky).length,
          luckies: pals.filter((x) => x.isLucky).length,
        };
      })
      .filter((h) => h.alphas + h.luckies > 0)
      .sort((a, b) => b.alphas + b.luckies - (a.alphas + a.luckies))
      .slice(0, 5);

    // Species exactly one specimen of exists on the whole server — the
    // catches nobody else has.
    const countByLabel = new Map<string, { n: number; owner: string; characterId: string }>();
    for (const { pal, owner } of owned) {
      const label = palDeckNo(pal.characterId);
      if (!label) continue;
      const cur = countByLabel.get(label);
      if (cur) cur.n += 1;
      else countByLabel.set(label, { n: 1, owner, characterId: pal.characterId });
    }
    const rarest = [...countByLabel.entries()]
      .filter(([, v]) => v.n === 1)
      .map(([label, v]) => ({ label, ...v }))
      .sort((a, b) => parseInt(b.label, 10) - parseInt(a.label, 10))
      .slice(0, 25);

    return { best, strongest, captures, hunters, rarest };
  }, [players]);

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured = palsQuery.isError && palsQuery.error instanceof ApiError && palsQuery.error.status === 400;
  const hasData = palsQuery.data !== undefined;
  const baseTotal = BASE_ENTRIES.length;
  const pct = completionPct(serverCaughtBase, baseTotal);

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Paldex</h1>
          <p className="text-sm text-ink/60">Completion per player, and the server's record book</p>
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-4 p-4 lg:space-y-6 lg:p-8">
        {!hasData && palsQuery.isFetching && <SaveReadProgress />}

        {notConfigured && !hasData && <SavePathSetup />}

        {!hasData &&
          palsQuery.isError &&
          !notConfigured &&
          (infoQuery.isError ? (
            <ServerUnreachable />
          ) : (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-ink/70">
              The save could not be read. Refresh to try again.
            </p>
          ))}

        {hasData && palsQuery.isFetching && <SaveUpdatingBanner />}

        {palsQuery.data && (
          <>
            {recordsUnavailable && (
              <p className="rounded-lg border border-brand-amber/50 bg-brand-amber/10 px-4 py-3 text-sm text-ink/70">
                No Paldex records were found in the save — completion can't be computed. The records live in the
                world folder's <code className="font-mono">Players/*.sav</code> files, so make sure the server's
                save path mounts the whole folder, not just Level.sav.
              </p>
            )}

            {/* The one bold element: how much of the Paldex this server has
                seen, all players together — dressed as the game's passive
                tier for this much progress. */}
            {(() => {
              const shownPct = heroPctParam !== null ? Number(heroPctParam) : pct;
              const look = heroLook(shownPct);
              return (
                <TierTile
                  look={look}
                  eyebrow="Server Paldex"
                  value={`${shownPct}%`}
                  sub={
                    <>
                      {serverCaughtBase} of {baseTotal} species registered by someone
                      {serverCaughtVariants > 0 && ` · +${serverCaughtVariants}/${VARIANT_ENTRIES.length} variants`}
                    </>
                  }
                  footer={
                    <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${shownPct}%`, backgroundColor: look.accent }}
                      />
                    </div>
                  }
                />
              );
            })()}

            {/* Directly under the hero on purpose: it's the same number read
                from the other end — what the server has left to catch.
                Skipped when the dex records didn't load, where "nobody has
                caught these" would be a claim about missing data. */}
            {players.length > 0 && !recordsUnavailable && (
              <BountyBoard caught={serverCaught} owned={serverOwned} />
            )}

            <section className="rounded-xl border border-ink/10 bg-white">
              <div className="border-b border-ink/5 px-5 py-4">
                <h2 className="font-display text-base font-bold">Completion by player</h2>
                {UNCATCHABLE.length > 0 && (
                  <p className="mt-0.5 text-xs text-ink/45">
                    {UNCATCHABLE.map((e) => palName(e.characterId)).join(", ")}{" "}
                    {UNCATCHABLE.length === 1 ? "can't be caught, so it's" : "can't be caught, so they're"} left out
                    of the count.
                  </p>
                )}
              </div>
              {players.length === 0 ? (
                <p className="px-5 py-6 text-sm text-ink/60">No players in the save yet.</p>
              ) : (
                <ul className="divide-y divide-ink/5">
                  {players.map((p) => (
                    <CompletionRow key={p.uid} player={p} />
                  ))}
                </ul>
              )}
            </section>

            <h2 className="pt-2 font-display text-base font-bold">Server records</h2>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RecordCard icon={<Sparkles className="h-4 w-4 text-brand-amber" />} title="Best rolls · IV total">
                {records.best.length === 0 ? (
                  <p className="py-2 text-sm text-ink/60">No pals in the save yet.</p>
                ) : (
                  <>
                    <p className="pb-1 text-xs text-ink/45">
                      Talents as hatched or caught, so level doesn't count. Equal rolls break on passive tier.
                    </p>
                    {/* Top 25, scrolling after roughly the first six — the
                        half-visible row is the scroll affordance. */}
                    <ul className="max-h-80 divide-y divide-ink/5 overflow-y-auto pr-1">
                      {records.best.map(({ pal, owner }) => (
                        <li key={pal.instanceId} className="flex items-center gap-3 py-2">
                          <PalPortrait characterId={pal.characterId} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">
                              {pal.nickname || palName(pal.characterId)}
                            </span>
                            <span className="block truncate text-xs text-ink/45">
                              <PlayerChip name={owner} />
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <TalentTriplet
                              hp={pal.talentHp}
                              attack={pal.talentShot}
                              defense={pal.talentDefense}
                              className="font-mono text-xs"
                            />
                            {/* The tiebreak, made visible: unranked passives
                                render nothing, so a fuller strip is a better
                                set. */}
                            <span className="mt-1 flex justify-end gap-0.5">
                              {pal.passives.map((code, i) => (
                                <PassiveTierTile key={`${code}-${i}`} code={code} />
                              ))}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </RecordCard>

              <RecordCard icon={<Dumbbell className="h-4 w-4 text-pal-green" />} title="Strongest pals">
                {records.strongest.length === 0 ? (
                  <p className="py-2 text-sm text-ink/60">No pals with stat data in the save yet.</p>
                ) : (
                  <>
                    <p className="pb-1 text-xs text-ink/45">
                      Estimated stats at their current level, with condenser, souls, trust and stat passives counted.
                    </p>
                    <ul className="max-h-80 divide-y divide-ink/5 overflow-y-auto pr-1">
                      {records.strongest.map(({ pal, owner, eff }) => (
                        <li key={pal.instanceId} className="flex items-center gap-3 py-2">
                          <PalPortrait characterId={pal.characterId} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold">
                              {pal.nickname || palName(pal.characterId)}
                            </span>
                            <span className="block truncate text-xs text-ink/45">
                              <PlayerChip name={owner} />
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block font-mono text-[11px] text-ink/40">Lv.{pal.level}</span>
                            <StatTriplet
                              hp={eff.hp}
                              attack={eff.attack}
                              defense={eff.defense}
                              className="font-mono text-xs"
                            />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </RecordCard>

              <RecordCard icon={<Crown className="h-4 w-4 text-legendary" />} title="One of a kind">
                {records.rarest.length === 0 ? (
                  <p className="py-2 text-sm text-ink/60">No species is down to a single specimen.</p>
                ) : (
                  <>
                    <p className="pb-1 text-xs text-ink/45">Species with exactly one specimen on the server.</p>
                    <ul className="max-h-80 divide-y divide-ink/5 overflow-y-auto pr-1">
                      {records.rarest.map((r) => (
                        <li key={r.label} className="flex items-center gap-3 py-2 text-sm">
                          <PalPortrait characterId={r.characterId} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-semibold">
                              <span className="font-mono text-xs text-ink/40">#{r.label}</span>{" "}
                              {palName(r.characterId)}
                            </span>
                            <span className="block truncate text-xs text-ink/45">
                              <PlayerChip name={r.owner} />
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </RecordCard>

              <RecordCard icon={<Swords className="h-4 w-4 text-brand-red" />} title="Alphas & luckies owned">
                {records.hunters.length === 0 ? (
                  <p className="py-2 text-sm text-ink/60">No alpha or lucky pals owned yet.</p>
                ) : (
                  <ul className="divide-y divide-ink/5">
                    {records.hunters.map((h) => (
                      <li key={h.name} className="flex items-center gap-3 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-semibold">
                          <PlayerChip name={h.name} />
                        </span>
                        <span className="font-mono text-xs tabular-nums text-brand-red">{h.alphas} alpha</span>
                        <span className="w-20 text-right font-mono text-xs tabular-nums text-brand-amber">
                          {h.luckies} lucky
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </RecordCard>

              {/* Five cards in a two-column grid, so the last one takes the
                  full row rather than leaving a half-width orphan. */}
              <RecordCard
                icon={<Target className="h-4 w-4 text-pal-blue" />}
                title="Most captures"
                className="lg:col-span-2"
              >
                {records.captures.length === 0 ? (
                  <p className="py-2 text-sm text-ink/60">No captures recorded yet.</p>
                ) : (
                  <ul className="divide-y divide-ink/5">
                    {records.captures.map((c, i) => (
                      <li key={c.name} className="flex items-center gap-3 py-2 text-sm">
                        <span className="w-5 font-mono text-xs text-ink/35">{i + 1}.</span>
                        <span className="min-w-0 flex-1 truncate font-semibold">
                          <PlayerChip name={c.name} />
                        </span>
                        <span className="font-mono text-xs text-ink/45">{c.species} species</span>
                        <span className="w-16 text-right font-mono font-semibold tabular-nums">{c.total}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </RecordCard>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
