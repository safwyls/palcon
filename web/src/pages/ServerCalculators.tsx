import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Sparkles, X } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { palEntry, palName, passiveName, passiveTier, elementColor } from "../lib/paldex";
import { breedChild, parentPairsFor, isBreedable } from "../lib/breeding";
import { eggsForConfidence, expectedEggs, passiveOdds } from "../lib/inheritance";
import {
  HELD_PASSIVES,
  planRoutes,
  rankRoutes,
  type BreedStep,
  type RankMode,
  type RouteOption,
  type StepParent,
} from "../lib/breeding-path";
import { computeStats, talentRating, hasCombatStats, passiveStatEffect, friendshipRank, talentTone } from "../lib/stats";
import { cn } from "../lib/utils";
import { PalPortrait } from "../components/PalPortrait";
import { PassiveBadge, PassiveTierTile } from "../components/PassiveBadge";
import { TalentTriplet } from "../components/TalentTriplet";
import { PalDetailDialog } from "../components/PalDetailDialog";
import { PalPicker, type PickedPal, type SavePal } from "../components/PalPicker";
import { NumberField as NumberInput } from "../components/ui/number-field";
import { Select } from "../components/ui/select";

type Mode = "breeding" | "path" | "stats";
/** Which slot a pending pick lands in; the whole page shares one picker. */
type PickTarget = "a" | "b" | "stats" | "reverse" | null;

export function ServerCalculators() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const [mode, setMode] = useState<Mode>("breeding");

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  // The pal viewer's read is shared, so opening Calculators after Player pals
  // costs no extra parse. retry:false so a save-less server fails fast.
  const palsQuery = useQuery({
    queryKey: ["server-pals", id],
    queryFn: () => api.serverPals(id),
    retry: false,
    gcTime: 60 * 60_000,
    staleTime: 60_000,
  });

  const savePals: SavePal[] | undefined = useMemo(() => {
    if (!palsQuery.data) return undefined;
    const out: SavePal[] = [];
    const seen = new Set<string>();
    for (const player of palsQuery.data.players) {
      const buckets: [typeof player.party, string][] = [
        [player.party, "Party"],
        [player.palbox, "Palbox"],
        [player.base, "At base"],
        [player.storage ?? [], "Pal storage"],
      ];
      for (const [list, where] of buckets) {
        for (const pal of list) {
          if (seen.has(pal.instanceId)) continue;
          seen.add(pal.instanceId);
          // Soul upgrades come back keyed by the game's stat labels; pull the
          // three combat ones. Rank is 1-based (1 = no condenser), so stars = rank-1.
          const souls = pal.souls ?? {};
          out.push({
            key: pal.instanceId,
            characterId: pal.characterId,
            nickname: pal.nickname,
            level: pal.level,
            gender: pal.gender,
            ivHp: pal.talentHp,
            ivAttack: pal.talentShot,
            ivDefense: pal.talentDefense,
            condenser: Math.max(0, (pal.rank ?? 1) - 1),
            souls: {
              hp: souls["Max HP"] ?? 0,
              attack: souls["Attack"] ?? 0,
              defense: souls["Defense"] ?? 0,
            },
            passives: pal.passives ?? [],
            isAlpha: pal.isBoss,
            trust: friendshipRank(pal.friendship),
            playerUid: player.uid,
            playerName: player.nickname,
            pal,
            where,
          });
        }
      }
    }
    return out;
  }, [palsQuery.data]);

  const saveStatus =
    palsQuery.isLoading
      ? "Reading the save…"
      : palsQuery.isError
        ? palsQuery.error instanceof ApiError && palsQuery.error.status === 400
          ? "Add a save path to this server to pick from your own pals."
          : "Couldn't read the save."
        : savePals && savePals.length === 0
          ? "No pals in the save yet."
          : undefined;

  const segClass = (active: boolean) =>
    cn(
      "rounded-lg px-4 py-1.5 text-sm font-bold transition-colors",
      active ? "bg-brand-red text-paper" : "text-ink/60 hover:text-ink",
    );

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (serverQuery.isError || !serverQuery.data)
    return <p className="p-6 text-destructive">Server not found.</p>;

  return (
    <div>
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Calculators</h1>
          <p className="mt-0.5 text-sm text-ink/50">{serverQuery.data.name} · breeding, paths & pal stats</p>
        </div>
        <div className="flex gap-1 rounded-xl bg-ink/5 p-1">
          <button className={segClass(mode === "breeding")} onClick={() => setMode("breeding")}>
            Breeding
          </button>
          <button className={segClass(mode === "path")} onClick={() => setMode("path")}>
            Path
          </button>
          <button className={segClass(mode === "stats")} onClick={() => setMode("stats")}>
            Stats
          </button>
        </div>
      </header>

      <div className="p-4 lg:p-8">
        {/* Mobile mode switch (the desktop one lives in the header). */}
        <div className="mb-4 flex gap-1 rounded-xl bg-ink/5 p-1 lg:hidden">
          <button className={cn(segClass(mode === "breeding"), "flex-1")} onClick={() => setMode("breeding")}>
            Breeding
          </button>
          <button className={cn(segClass(mode === "path"), "flex-1")} onClick={() => setMode("path")}>
            Path
          </button>
          <button className={cn(segClass(mode === "stats"), "flex-1")} onClick={() => setMode("stats")}>
            Stats
          </button>
        </div>

        {mode === "breeding" ? (
          <BreedingCalculator savePals={savePals} saveStatus={saveStatus} />
        ) : mode === "path" ? (
          <PathFinder savePals={savePals} saveStatus={saveStatus} />
        ) : (
          <StatCalculator savePals={savePals} saveStatus={saveStatus} />
        )}
      </div>
    </div>
  );
}

function ElementChips({ characterId }: { characterId: string }) {
  const elements = (palEntry(characterId)?.elements ?? []).slice(0, 2);
  if (elements.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center justify-center gap-1">
      {elements.map((el) => (
        <span
          key={el}
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ backgroundColor: `${elementColor(el)}22`, color: elementColor(el) }}
        >
          {el}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Breeding
// ---------------------------------------------------------------------------

function BreedingCalculator({ savePals, saveStatus }: { savePals?: SavePal[]; saveStatus?: string }) {
  const [a, setA] = useState<PickedPal | null>(null);
  const [b, setB] = useState<PickedPal | null>(null);
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<PickTarget>(null);

  const child = a && b ? breedChild(a.characterId, b.characterId) : null;
  const bothFromSave = a?.save && b?.save;

  const onPick = (pick: PickedPal) => {
    if (pickerFor === "a") setA(pick);
    else if (pickerFor === "b") setB(pick);
    else if (pickerFor === "reverse") setReverseTarget(pick.characterId);
  };

  const pairs = reverseTarget ? parentPairsFor(reverseTarget) : [];

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-ink/10 bg-white/70 p-5 lg:p-8">
        <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 lg:gap-6">
          <ParentSlot label="Parent" pick={a} onPick={() => setPickerFor("a")} onClear={() => setA(null)} />
          <div className="flex h-full items-center pt-8">
            <Egg />
          </div>
          <ParentSlot label="Parent" pick={b} onPick={() => setPickerFor("b")} onClear={() => setB(null)} />
        </div>

        <div className="my-6 flex items-center gap-3 text-ink/30">
          <div className="h-px flex-1 bg-ink/10" />
          <ArrowRight className="h-4 w-4 rotate-90" />
          <div className="h-px flex-1 bg-ink/10" />
        </div>

        {child ? (
          <div
            key={child.childId}
            className="mx-auto flex max-w-sm flex-col items-center motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-300"
          >
            {child.special && (
              <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-brand-amber/15 px-2.5 py-0.5 text-xs font-semibold text-brand-amber">
                <Sparkles className="h-3 w-3" /> Special combo
              </span>
            )}
            <PalPortrait characterId={child.childId} size="lg" />
            <p className="mt-2 font-display text-xl font-extrabold">{palName(child.childId)}</p>
            <ElementChips characterId={child.childId} />
            {child.altChildId && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-ink/10 bg-ink/[0.03] px-3 py-2">
                <PalPortrait characterId={child.altChildId} size="sm" />
                <p className="text-xs text-ink/60">
                  or <span className="font-semibold text-foreground">{palName(child.altChildId)}</span> — which
                  hatches depends on the parents' genders.
                </p>
              </div>
            )}
            {bothFromSave && <TalentTargets a={a!.save!} b={b!.save!} />}
            {bothFromSave && <PassiveOddsPanel a={a!.save!} b={b!.save!} />}
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {a && b ? "These two can't be bred together." : "Pick two parents to see what they make."}
          </p>
        )}
      </section>

      {/* Reverse lookup */}
      <section className="rounded-2xl border border-ink/10 bg-white/70 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-bold">What breeds into…</h2>
            <p className="text-xs text-ink/40">Pick a target to see every parent pair that makes it.</p>
          </div>
          <button
            onClick={() => setPickerFor("reverse")}
            className="rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-sm font-semibold text-ink transition hover:bg-ink/5"
          >
            {reverseTarget ? palName(reverseTarget) : "Choose a pal"}
          </button>
        </div>

        {reverseTarget && (
          <div className="mt-4">
            <p className="mb-2 text-xs text-ink/40">
              {pairs.length} {pairs.length === 1 ? "pair" : "pairs"} breed into{" "}
              <span className="font-semibold text-ink/70">{palName(reverseTarget)}</span>
            </p>
            <div className="grid max-h-96 grid-cols-1 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2">
              {pairs.map((p, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-xl border border-ink/10 bg-white/60 p-2"
                >
                  <PalPortrait characterId={p.aId} size="sm" />
                  <span className="text-ink/30">+</span>
                  <PalPortrait characterId={p.bId} size="sm" />
                  <div className="min-w-0 flex-1 text-xs">
                    <p className="truncate font-semibold text-foreground">{palName(p.aId)}</p>
                    <p className="truncate text-ink/50">{palName(p.bId)}</p>
                  </div>
                  {p.special && <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-amber" />}
                </div>
              ))}
              {pairs.length === 0 && (
                <p className="py-4 text-sm text-muted-foreground">
                  Nothing breeds into this one — it's only found in the wild.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <PalPicker
        open={pickerFor !== null}
        onOpenChange={(o) => !o && setPickerFor(null)}
        onPick={onPick}
        title={pickerFor === "reverse" ? "Choose a target pal" : "Pick a parent"}
        savePals={savePals}
        saveStatus={saveStatus}
      />
    </div>
  );
}

/**
 * Passive inheritance odds for the picked parents. The pool is both
 * parents' passives deduped; tapping chips selects the set you're breeding
 * for, and the numbers answer "how many eggs is this going to take".
 * Rates are the community-derived model — see lib/inheritance.ts.
 */
function PassiveOddsPanel({ a, b }: { a: SavePal; b: SavePal }) {
  // Ranked by the game's tier, so the ones worth chasing sit first.
  const pool = useMemo(
    () =>
      [...new Set([...a.passives, ...b.passives])].sort(
        (x, y) => passiveTier(y) - passiveTier(x) || passiveName(x).localeCompare(passiveName(y)),
      ),
    [a, b],
  );
  const [wanted, setWanted] = useState<string[]>([]);
  // Reset the selection when the parents change — the old set may not
  // even exist in the new pool.
  useEffect(() => setWanted([]), [pool]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pool.length === 0) {
    return (
      <p className="mt-4 text-xs text-ink/45">Neither parent carries passive skills, so there's nothing to inherit.</p>
    );
  }

  const selected = wanted.filter((p) => pool.includes(p));
  const odds = passiveOdds(pool.length, selected.length);
  const fmt = (p: number) => (p >= 0.1 ? `${Math.round(p * 100)}%` : `${(p * 100).toFixed(1)}%`);

  return (
    <div className="mt-5 w-full max-w-md rounded-xl border border-ink/10 bg-ink/[0.02] p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-ink/45">Passive inheritance</p>
      <p className="mt-1 text-xs text-ink/45">
        Both parents' passives, deduped ({pool.length} in the pool). Tap the ones the child must have.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {pool.map((code) => {
          const on = selected.includes(code);
          return (
            <button
              key={code}
              type="button"
              aria-pressed={on}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
                on
                  ? "bg-brand-amber/25 text-ink ring-1 ring-brand-amber"
                  : "border border-ink/15 text-ink/50 hover:border-ink/30 hover:text-ink",
              )}
              onClick={() =>
                setWanted((prev) => (prev.includes(code) ? prev.filter((x) => x !== code) : [...prev, code]))
              }
            >
              <PassiveTierTile code={code} />
              {passiveName(code)}
            </button>
          );
        })}
      </div>

      {selected.length > 0 && odds && (
        <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <div>
            <p className="font-mono text-lg font-semibold tabular-nums">{fmt(odds.exact)}</p>
            <p className="text-[11px] text-ink/45">exactly these</p>
          </div>
          <div>
            <p className="font-mono text-lg font-semibold tabular-nums">{fmt(odds.atLeast)}</p>
            <p className="text-[11px] text-ink/45">these + extras</p>
          </div>
          <div>
            <p className="font-mono text-lg font-semibold tabular-nums">~{Math.ceil(expectedEggs(odds.exact))}</p>
            <p className="text-[11px] text-ink/45">eggs on average</p>
          </div>
          <div>
            <p className="font-mono text-lg font-semibold tabular-nums">{eggsForConfidence(odds.exact)}</p>
            <p className="text-[11px] text-ink/45">eggs for 90%</p>
          </div>
        </div>
      )}
      {selected.length > 0 && !odds && (
        <p className="mt-3 text-xs text-destructive">A pal holds at most 4 passives — pick fewer.</p>
      )}
      <p className="mt-3 text-[11px] text-ink/35">
        Community-measured rates, not official ones. Egg counts are for the exact set with no strays.
      </p>
    </div>
  );
}

function ParentSlot({
  label,
  pick,
  onPick,
  onClear,
}: {
  label: string;
  pick: PickedPal | null;
  onPick: () => void;
  onClear: () => void;
}) {
  if (!pick) {
    return (
      <button
        onClick={onPick}
        className="flex h-full min-h-[9rem] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink/15 p-4 text-ink/40 transition-colors hover:border-brand-red/40 hover:text-brand-red"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-current text-xl">
          +
        </span>
        <span className="text-sm font-semibold">Pick a {label.toLowerCase()}</span>
      </button>
    );
  }
  const breedable = isBreedable(pick.characterId);
  return (
    <div className="relative flex flex-col items-center rounded-2xl border border-ink/10 bg-white/60 p-4">
      <button
        onClick={onClear}
        className="absolute right-2 top-2 rounded-full p-1 text-ink/30 hover:bg-ink/5 hover:text-ink"
        aria-label="Clear"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <button onClick={onPick} className="flex flex-col items-center" title="Change">
        <PalPortrait characterId={pick.characterId} size="lg" />
        <p className="mt-2 text-center font-display text-base font-bold leading-tight">
          {palName(pick.characterId)}
        </p>
      </button>
      {pick.save ? (
        <>
          <p className="mt-1 font-mono text-[11px] text-ink/40">
            Lv.{pick.save.level} ·{" "}
            <TalentTriplet hp={pick.save.ivHp} attack={pick.save.ivAttack} defense={pick.save.ivDefense} />
          </p>
          {/* What this parent brings to the egg, in the game's tier chips. */}
          {pick.save.passives.length > 0 ? (
            <div className="mt-2 flex flex-wrap justify-center gap-1">
              {pick.save.passives.map((code, i) => (
                <PassiveBadge key={`${code}-${i}`} code={code} />
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-ink/30">No passives</p>
          )}
        </>
      ) : (
        <ElementChips characterId={pick.characterId} />
      )}
      {!breedable && <p className="mt-1 text-[11px] font-semibold text-brand-red">Not breedable</p>}
    </div>
  );
}

/** Best talent a child could inherit from each parent — the target you breed
 * toward, since each talent is passed from one parent or rerolled. */
function TalentTargets({ a, b }: { a: SavePal; b: SavePal }) {
  const rows: [string, number, number][] = [
    ["HP", a.ivHp, b.ivHp],
    ["Attack", a.ivAttack, b.ivAttack],
    ["Defense", a.ivDefense, b.ivDefense],
  ];
  return (
    <div className="mt-4 w-full rounded-xl border border-ink/10 bg-ink/[0.03] p-3">
      <p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-wide text-ink/40">
        Best inheritable talents
      </p>
      <div className="grid grid-cols-3 gap-2">
        {rows.map(([name, av, bv]) => (
          <div key={name} className="text-center">
            <p className="text-[11px] text-ink/40">{name}</p>
            <p className="font-mono text-lg font-bold" style={{ color: talentTone(Math.max(av, bv)) }}>
              {Math.max(av, bv)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The signature: a Palworld egg sitting between the two parents, reused at
 * small size as the path finder's step markers. */
function Egg({ className = "h-14 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 52" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="eggshell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBF7EE" />
          <stop offset="1" stopColor="#EAD9B8" />
        </linearGradient>
      </defs>
      <path
        d="M20 2 C31 2 38 22 38 34 C38 44 30 50 20 50 C10 50 2 44 2 34 C2 22 9 2 20 2 Z"
        fill="url(#eggshell)"
        stroke="#D98C3F"
        strokeWidth="2"
      />
      {/* Spots, echoing the game's speckled eggs. */}
      <ellipse cx="14" cy="24" rx="3" ry="4" fill="#D98C3F" opacity="0.35" />
      <ellipse cx="25" cy="34" rx="4" ry="5" fill="#D98C3F" opacity="0.3" />
      <ellipse cx="17" cy="40" rx="2.5" ry="3" fill="#D98C3F" opacity="0.35" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Breeding path
// ---------------------------------------------------------------------------

/** How many routes each egg-count column offers. */
const ROUTES_PER_BUCKET = 5;

const RANK_LABELS: [RankMode, string][] = [
  ["balanced", "Balanced"],
  ["talents", "Talents"],
  ["passives", "Passives"],
];

function PathFinder({ savePals, saveStatus }: { savePals?: SavePal[]; saveStatus?: string }) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [scope, setScope] = useState("all");
  const [rank, setRank] = useState<RankMode>("balanced");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // A suggested parent, opened in the same detail dialog the pal viewer uses.
  const [detail, setDetail] = useState<SavePal | null>(null);

  const players = useMemo(() => {
    const byUid = new Map<string, { uid: string; name: string; count: number }>();
    for (const p of savePals ?? []) {
      const cur = byUid.get(p.playerUid);
      if (cur) cur.count++;
      else byUid.set(p.playerUid, { uid: p.playerUid, name: p.playerName, count: 1 });
    }
    return [...byUid.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [savePals]);

  const pool = useMemo(
    () => (scope === "all" ? savePals : savePals?.filter((p) => p.playerUid === scope)),
    [savePals, scope],
  );

  const plan = useMemo(
    () => (targetId && pool && pool.length > 0 ? planRoutes(pool, targetId) : null),
    [pool, targetId],
  );
  // Re-ranking is a sort over routes the planner already found, so switching
  // how the board is ordered never costs another solve.
  const board = useMemo(
    () =>
      plan?.status === "ok"
        ? plan.buckets.map((b) => ({ eggs: b.eggs, routes: rankRoutes(b.routes, rank, ROUTES_PER_BUCKET) }))
        : [],
    [plan, rank],
  );
  const shown = board.flatMap((b) => b.routes);
  // A route the board no longer offers (the ranking changed under it) falls
  // back to the new best, so the step list below always matches a lit row.
  const route = shown.find((r) => r.id === routeId) ?? shown[0];
  const owned = plan?.status === "ok" ? plan.owned : undefined;
  const poolName = scope === "all" ? "the server" : (players.find((p) => p.uid === scope)?.name ?? "this player");
  const poolPossessive = poolName === "the server" ? "the server's" : `${poolName}'s`;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-ink/10 bg-white/70 p-5 lg:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-bold">Breeding path</h2>
            <p className="text-xs text-ink/40">The shortest route from the pals on this server to the one you want.</p>
          </div>
          {players.length > 1 && (
            <label className="flex items-center gap-2 text-xs font-semibold text-ink/50">
              Breed from
              <Select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setRouteId(null);
                }}
              >
                <option value="all">Everyone · {savePals?.length ?? 0}</option>
                {players.map((p) => (
                  <option key={p.uid} value={p.uid}>
                    {p.name} · {p.count}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>

        <div className="mt-4">
          {targetId ? (
            <div className="flex items-center gap-3">
              <PalPortrait characterId={targetId} size="md" />
              <div>
                <p className="font-display text-lg font-bold leading-tight">{palName(targetId)}</p>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="text-sm font-semibold text-brand-red hover:underline"
                >
                  Change target
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-ink/15 px-4 py-3 text-ink/40 transition-colors hover:border-brand-red/40 hover:text-brand-red"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-current text-lg">
                +
              </span>
              <span className="text-sm font-semibold">Pick a target pal</span>
            </button>
          )}
        </div>

      </section>

      {owned?.ownedTarget && (
        <section className="rounded-2xl border border-ink/10 bg-white/70 p-4 lg:p-5">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div>
              <p className="font-display text-base font-bold">Already in the box</p>
              <p className="text-xs text-ink/40">
                {board.length > 0
                  ? "The best copy on the server today — breed only to beat it."
                  : `Nothing in ${poolPossessive} pals breeds into it, so this is the one.`}
              </p>
            </div>
            <div className="max-w-full">
              <ParentRow parent={{ kind: "owned", pal: owned.ownedTarget }} onOpen={setDetail} />
            </div>
          </div>
        </section>
      )}

      {board.length > 0 && (
        <section className="rounded-2xl border border-ink/10 bg-white/70 p-4 lg:p-6">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <div>
              <h2 className="font-display text-base font-bold">Best routes</h2>
              <p className="text-xs text-ink/40">
                What each extra egg buys you. Pick one to see the breeding order.
              </p>
            </div>
            <div className="flex items-baseline gap-1 text-xs">
              <span className="mr-1 text-ink/40">Rank by</span>
              {RANK_LABELS.map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => setRank(mode)}
                  aria-pressed={rank === mode}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-semibold transition-colors",
                    rank === mode
                      ? "text-brand-red underline decoration-2 underline-offset-4"
                      : "text-ink/45 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {board.map((bucket) => (
              <div key={bucket.eggs} className="min-w-0">
                <div className="mb-2 flex items-center gap-2 border-b border-ink/10 pb-2">
                  <EggCount n={bucket.eggs} />
                  <p className="font-display text-base font-bold first-letter:uppercase">
                    {eggCountLabel(bucket.eggs)}
                  </p>
                </div>
                <ol className="space-y-1.5">
                  {bucket.routes.map((opt, i) => (
                    <li key={opt.id}>
                      <RouteRow
                        route={opt}
                        place={i + 1}
                        selected={opt.id === route?.id}
                        onSelect={() => setRouteId(opt.id)}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-ink/35">
            Both readouts are ceilings: the talents assume every stat lands from the better parent, and the
            passives are what the route can reach — a pal holds four at once, drawn from its parents' pool.
          </p>
        </section>
      )}

      {!savePals || savePals.length === 0 ? (
        <PathNote>{saveStatus ?? "No pals in the save yet."}</PathNote>
      ) : !targetId ? (
        <PathNote>Pick a target to plan a route from {poolPossessive} pals.</PathNote>
      ) : plan?.status === "notBreedable" ? (
        <PathNote>{palName(targetId)} can't be bred — catch one in the wild instead.</PathNote>
      ) : plan?.status === "unreachable" ? (
        <PathNote>
          Nothing in {poolPossessive} pals breeds into {palName(targetId)}.{" "}
          {scope !== "all" && players.length > 1
            ? "Try breeding from everyone's pals instead."
            : "Catch one — or a species closer to it — in the wild first."}
        </PathNote>
      ) : route ? (
        <section>
          <div className="mb-3 flex items-baseline gap-2">
            <h2 className="font-display text-base font-bold">Breed order</h2>
            <p className="text-xs text-ink/40">
              {eggCountLabel(route.eggs)}, in order — later steps can reuse anything already hatched.
            </p>
          </div>
          <div>
            {route.steps.map((step, i) => (
              <div key={step.n} className="flex gap-3">
                <div className="flex w-9 shrink-0 flex-col items-center">
                  <EggMarker n={step.n} />
                  {i < route.steps.length - 1 && (
                    <div className="w-0 flex-1 border-l-2 border-dashed border-ink/20" />
                  )}
                </div>
                <StepCard step={step} final={i === route.steps.length - 1} onOpen={setDetail} />
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ink/35">
            A hatched pal's gender is random, so a pair with an egg parent may still need a re-hatch or a Pal
            Reverser; a hatched pal can be reused in later steps.
          </p>
        </section>
      ) : null}

      <PalPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(pick) => {
          setTargetId(pick.characterId);
          setRouteId(null);
        }}
        title="Choose a target pal"
      />
      <PalDetailDialog
        pal={detail?.pal ?? null}
        location={detail ? `${detail.playerName} · ${detail.where}` : ""}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}

function PathNote({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white/70 p-5 text-sm text-muted-foreground">
      {children}
    </section>
  );
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];

/** "two eggs" reads as a cost; "2" reads as a label. Falls back to digits past
 * the point where spelling it out stops helping. */
function eggCountLabel(n: number): string {
  return `${NUMBER_WORDS[n] ?? n} ${n === 1 ? "egg" : "eggs"}`;
}

/** A column's price tag: the page's own egg, once per egg the route costs.
 * Overlapped like a clutch so three still read at a glance. */
function EggCount({ n }: { n: number }) {
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      {Array.from({ length: Math.min(n, 8) }, (_, i) => (
        <Egg key={i} className={cn("h-6 w-[17px]", i > 0 && "-ml-1.5")} />
      ))}
    </span>
  );
}

/**
 * One route in an egg-count column. The two ceilings are the comparison — read
 * a row across, or read row 1 across three columns to see what another egg
 * buys. The pals it pulls out of the box distinguish otherwise-identical rows.
 */
function RouteRow({
  route,
  place,
  selected,
  onSelect,
}: {
  route: RouteOption<SavePal>;
  place: number;
  selected: boolean;
  onSelect: () => void;
}) {
  // The owned pals this route consumes, deduped — a hatched pal can parent
  // more than one later step, but you only need one copy out of the box.
  const leaves: SavePal[] = [];
  const seen = new Set<string>();
  for (const step of route.steps) {
    for (const parent of [step.a, step.b]) {
      if (parent.kind !== "owned" || seen.has(parent.pal.key)) continue;
      seen.add(parent.pal.key);
      leaves.push(parent.pal);
    }
  }
  const held = route.passives.slice(0, HELD_PASSIVES);
  const extra = route.passives.length - held.length;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full rounded-xl border px-2.5 py-2 text-left transition-colors",
        selected
          ? "border-brand-red bg-brand-red/[0.06]"
          : "border-ink/10 bg-white/60 hover:border-brand-red/40 hover:bg-white",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="w-3 shrink-0 font-mono text-[11px] tabular-nums text-ink/30">{place}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {leaves.slice(0, 3).map((pal) => (
            <PalPortrait key={pal.key} characterId={pal.characterId} size="sm" />
          ))}
          {leaves.length > 3 && (
            // Sized and framed like a portrait so it reads as "one more pal",
            // not as the passive overflow count on the line below.
            <span
              className="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-ink/20 font-mono text-[11px] text-ink/40"
              title={`${leaves.length} pals out of the box`}
            >
              +{leaves.length - 3}
            </span>
          )}
        </span>
        <TalentTriplet
          hp={route.ceiling[0]}
          attack={route.ceiling[1]}
          defense={route.ceiling[2]}
          className="ml-auto font-mono text-xs font-semibold tabular-nums"
        />
        {route.reversers > 0 && (
          <span
            className="shrink-0 text-brand-amber"
            title={`Needs ${route.reversers} Pal Reverser${route.reversers === 1 ? "" : "s"}`}
          >
            ⚥
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1 pl-5">
        {held.length > 0 ? (
          <>
            {held.map((code) => (
              <PassiveBadge key={code} code={code} />
            ))}
            {extra > 0 && (
              <span
                className="font-mono text-[10px] text-ink/35"
                title={`${route.passives.length} passives in this route's pool — the child draws four of them`}
              >
                +{extra}
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-ink/30">No passives on this line</span>
        )}
      </div>
    </button>
  );
}

/** Step marker on the hatch line: the page's egg with the breed number inside. */
function EggMarker({ n }: { n: number }) {
  return (
    <div className="relative h-10 w-8 shrink-0" aria-label={`Egg ${n}`}>
      <Egg className="h-10 w-8" />
      <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 pt-1.5 text-center font-display text-sm font-extrabold text-ink/70">
        {n}
      </span>
    </div>
  );
}

function StepCard({
  step,
  final,
  onOpen,
}: {
  step: BreedStep<SavePal>;
  final: boolean;
  onOpen: (pal: SavePal) => void;
}) {
  // Two owned parents of the same sex can't pair as-is: one needs its gender
  // swapped with a Pal Reverser (or substituted for an opposite-sex copy).
  // Egg parents hatch with a random gender, so only owned pairs are flagged.
  const sameSex =
    step.a.kind === "owned" &&
    step.b.kind === "owned" &&
    step.a.pal.gender !== "" &&
    step.a.pal.gender === step.b.pal.gender;
  return (
    <div
      className={cn(
        "mb-3 min-w-0 flex-1 rounded-2xl border bg-white/70 p-3 sm:p-4",
        final ? "border-brand-amber/60" : "border-ink/10",
      )}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
        <div className="min-w-0 space-y-1.5">
          <ParentRow parent={step.a} onOpen={onOpen} />
          <ParentRow parent={step.b} onOpen={onOpen} />
          {sameSex && (
            <p className="inline-flex items-center rounded-full bg-brand-amber/15 px-2 py-0.5 text-[11px] font-semibold text-brand-amber">
              Both {step.a.kind === "owned" && step.a.pal.gender === "female" ? "♀" : "♂"} — swap one's gender
              with a Pal Reverser
            </p>
          )}
        </div>
        {/* Rotated on mobile so the hatched child doesn't read as a third parent. */}
        <ArrowRight className="mx-auto h-4 w-4 rotate-90 text-ink/30 sm:mx-0 sm:rotate-0" />
        <div className="flex min-w-0 items-center gap-3">
          <PalPortrait characterId={step.childId} size="md" />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="truncate font-display text-base font-bold">{palName(step.childId)}</p>
              {step.special && <Sparkles className="h-3.5 w-3.5 shrink-0 text-brand-amber" />}
            </div>
            <p className="font-mono text-[11px] text-ink/40">
              best <TalentTriplet hp={step.ceiling[0]} attack={step.ceiling[1]} defense={step.ceiling[2]} />
            </p>
            {final && (
              <span className="mt-1 inline-flex rounded-full bg-brand-amber/15 px-2 py-0.5 text-[11px] font-semibold text-brand-amber">
                Target
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ParentRow({ parent, onOpen }: { parent: StepParent<SavePal>; onOpen?: (pal: SavePal) => void }) {
  if (parent.kind === "owned") {
    const p = parent.pal;
    return (
      <button
        type="button"
        onClick={() => onOpen?.(p)}
        title="View details"
        className="-m-1 flex min-w-0 max-w-full items-start gap-2 rounded-lg p-1 text-left transition-colors hover:bg-ink/5"
      >
        <PalPortrait characterId={p.characterId} size="sm" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {p.nickname || palName(p.characterId)}
            {p.gender && (
              <span
                className={cn("ml-1", p.gender === "female" ? "text-brand-red" : "text-pal-blue")}
                aria-label={p.gender === "female" ? "Female" : "Male"}
              >
                {p.gender === "female" ? "♀" : "♂"}
              </span>
            )}
          </p>
          <p className="truncate font-mono text-[11px] text-ink/40">
            Lv.{p.level} · <TalentTriplet hp={p.ivHp} attack={p.ivAttack} defense={p.ivDefense} /> ·{" "}
            {p.playerName}
          </p>
          {p.passives.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {p.passives.map((code, i) => (
                <PassiveBadge key={`${code}-${i}`} code={code} />
              ))}
            </div>
          )}
        </div>
      </button>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PalPortrait characterId={parent.speciesId} size="sm" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{palName(parent.speciesId)}</p>
        <p className="font-mono text-[11px] text-ink/40">from egg {parent.n}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface StatForm {
  characterId: string | null;
  level: number;
  ivHp: number;
  ivAttack: number;
  ivDefense: number;
  soulHp: number;
  soulAttack: number;
  soulDefense: number;
  condenser: number;
  trust: number;
  passives: string[];
  isAlpha: boolean;
}

const emptyStatForm: StatForm = {
  characterId: null,
  level: 50,
  ivHp: 50,
  ivAttack: 50,
  ivDefense: 50,
  soulHp: 0,
  soulAttack: 0,
  soulDefense: 0,
  condenser: 0,
  trust: 0,
  passives: [],
  isAlpha: false,
};

function StatCalculator({ savePals, saveStatus }: { savePals?: SavePal[]; saveStatus?: string }) {
  const [form, setForm] = useState<StatForm>(emptyStatForm);
  const [pickerOpen, setPickerOpen] = useState(false);
  const set = <K extends keyof StatForm>(k: K, v: StatForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const onPick = (pick: PickedPal) => {
    if (pick.save) {
      const s = pick.save;
      setForm((f) => ({
        ...f,
        characterId: pick.characterId,
        level: s.level,
        ivHp: s.ivHp,
        ivAttack: s.ivAttack,
        ivDefense: s.ivDefense,
        condenser: s.condenser,
        soulHp: s.souls.hp,
        soulAttack: s.souls.attack,
        soulDefense: s.souls.defense,
        passives: s.passives,
        isAlpha: s.isAlpha,
        trust: s.trust,
      }));
    } else {
      // A bare species has no passives or alpha flag of its own to carry over.
      setForm((f) => ({ ...f, characterId: pick.characterId, passives: [], isAlpha: false }));
    }
  };

  const stats = form.characterId
    ? computeStats({
        characterId: form.characterId,
        level: form.level,
        ivHp: form.ivHp,
        ivAttack: form.ivAttack,
        ivDefense: form.ivDefense,
        soulHp: form.soulHp,
        soulAttack: form.soulAttack,
        soulDefense: form.soulDefense,
        condenser: form.condenser,
        trust: form.trust,
        passives: form.passives,
        isAlpha: form.isAlpha,
      })
    : null;
  const rating = talentRating(form.ivHp, form.ivAttack, form.ivDefense);
  const noStats = form.characterId && !hasCombatStats(form.characterId);
  // Passives that actually move the numbers, for the applied-effects list.
  const statPassives = form.passives.filter((c) => passiveStatEffect(c));

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="space-y-5 rounded-2xl border border-ink/10 bg-white/70 p-5 lg:p-6">
        <div className="flex items-center gap-3">
          {form.characterId ? (
            <PalPortrait characterId={form.characterId} size="md" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-dashed border-ink/15 text-ink/30">
              ?
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg font-bold">
              {form.characterId ? palName(form.characterId) : "No pal chosen"}
            </p>
            <button
              onClick={() => setPickerOpen(true)}
              className="text-sm font-semibold text-brand-red hover:underline"
            >
              {form.characterId ? "Change pal" : "Pick a pal"}
            </button>
          </div>
        </div>

        <NumberField label="Level" min={1} max={60} value={form.level} onChange={(v) => set("level", v)} />

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Talents (0–100)</p>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="HP" min={0} max={100} value={form.ivHp} onChange={(v) => set("ivHp", v)} />
            <NumberField label="Attack" min={0} max={100} value={form.ivAttack} onChange={(v) => set("ivAttack", v)} />
            <NumberField label="Defense" min={0} max={100} value={form.ivDefense} onChange={(v) => set("ivDefense", v)} />
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">
            Upgrades <span className="font-normal normal-case text-ink/30">· optional</span>
          </p>
          {/* Souls cap at rank 20 (+3% each) since Large Pal Souls; trust
              rank still caps at 10. Keep in sync with stats.ts clamps. */}
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Soul HP" min={0} max={20} value={form.soulHp} onChange={(v) => set("soulHp", v)} />
            <NumberField label="Soul Atk" min={0} max={20} value={form.soulAttack} onChange={(v) => set("soulAttack", v)} />
            <NumberField label="Soul Def" min={0} max={20} value={form.soulDefense} onChange={(v) => set("soulDefense", v)} />
          </div>
          <div className="mt-3 grid grid-cols-3 items-end gap-3">
            <NumberField label="Condenser ★" min={0} max={4} value={form.condenser} onChange={(v) => set("condenser", v)} />
            <NumberField label="Trust" min={0} max={10} value={form.trust} onChange={(v) => set("trust", v)} />
            <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.isAlpha}
                onChange={(e) => set("isAlpha", e.target.checked)}
                className="h-4 w-4 accent-brand-red"
              />
              Alpha
            </label>
          </div>
        </div>

        {form.passives.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink/40">Passives</p>
            <div className="flex flex-wrap gap-1.5">
              {form.passives.map((code) => {
                const eff = passiveStatEffect(code);
                const label = !eff
                  ? ""
                  : ["Atk", "Def", "HP"]
                      .map((n, i) => (eff[i] ? `${n} ${eff[i] > 0 ? "+" : ""}${eff[i]}%` : null))
                      .filter(Boolean)
                      .join(" · ");
                return (
                  <span
                    key={code}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      eff ? "bg-brand-red/10 text-brand-red" : "bg-ink/5 text-ink/40",
                    )}
                    title={eff ? label : "No effect on the displayed stats"}
                  >
                    <PassiveTierTile code={code} />
                    {passiveName(code)}
                    {eff && <span className="font-mono">{label}</span>}
                  </span>
                );
              })}
            </div>
            {form.passives.length > statPassives.length && (
              <p className="mt-1.5 text-[11px] text-ink/35">
                Greyed passives boost element damage or buff you, not this pal's shown stats.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-ink/10 bg-white/70 p-5 lg:p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold">Estimated stats</h2>
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg font-display text-lg font-extrabold",
              rating.tier === "S"
                ? "bg-legendary/15 text-legendary"
                : rating.tier === "A"
                  ? "bg-pal-blue/15 text-pal-blue"
                  : rating.tier === "B"
                    ? "bg-pal-green/15 text-pal-green"
                    : "bg-ink/5 text-ink/50",
            )}
            title={`Talent rating · ${rating.average}% average`}
          >
            {rating.tier}
          </span>
        </div>

        {noStats ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No base stats vendored for this pal — try another species.
          </p>
        ) : stats ? (
          <div className="mt-5 space-y-4">
            <StatBar label="HP" value={stats.hp} max={15000} color="#5B9E6F" />
            <StatBar label="Attack" value={stats.attack} max={1500} color="#E0502F" />
            <StatBar label="Defense" value={stats.defense} max={1500} color="#5B8DEF" />
            <p className="pt-2 text-[11px] text-ink/35">
              Calibrated against in-game values — Attack and Defense are exact. Trust is the one estimate, so a
              high-bond pal may read a touch low.
            </p>
          </div>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">Pick a pal to estimate its stats.</p>
        )}
      </section>

      <PalPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={onPick}
        title="Pick a pal"
        savePals={savePals}
        saveStatus={saveStatus}
      />
    </div>
  );
}

function StatBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="font-mono text-lg font-bold" style={{ color }}>
          {value.toLocaleString()}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink/5">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-ink/50">{label}</label>
      <NumberInput value={value} onChange={onChange} min={min} max={max} className="text-right" />
    </div>
  );
}
