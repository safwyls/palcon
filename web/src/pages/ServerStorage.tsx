import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Lock, MapPin, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { api, ApiError, type ItemSlot, type StorageBase, type StorageContainer, type StorageResult } from "../lib/api";
import { CATEGORIES, itemCategory, itemIconUrl, itemName, rarityColor } from "../lib/items";
import { ROLE_LABELS, type StructureRole, structureIconUrl, structureName, structureRole } from "../lib/structures";
import { mapOf, worldToMapPercent } from "../lib/map";
import { nearestLandmark } from "../lib/pois";
import { PALETTE } from "../lib/palette";
import { agoLabel } from "../lib/time";
import { cn } from "../lib/utils";
import { ItemDetailDialog } from "../components/ItemDetailDialog";
import { SavePathSetup } from "../components/SavePathSetup";
import { SaveReadProgress } from "../components/SaveReadProgress";
import { SaveUpdatingBanner } from "../components/SaveUpdatingBanner";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";

// ---------------------------------------------------------------------------
// The page has two jobs, and they want different shapes.
//
// With no search on, it's a depot list: every base camp and what stands at it,
// so you can read your own storage. With a search on, the question changes to
// "where is this, and how much of it is there" — so the answer leads with the
// distribution across places, and the list below becomes the detail.
// ---------------------------------------------------------------------------

/** Roles stack in this order: things you stock, then things that fill
 * themselves, then what the world left lying around. */
const ROLE_ORDER: StructureRole[] = ["storage", "farm", "station", "drop", "loot"];

/** How many places the stock bar names before the rest become one segment.
 * Past this the segments are slivers, and a bar you can't read is decoration. */
const MAX_SEGMENTS = 6;

/**
 * Where the "yes, I know" for the world-loot spoiler warning is remembered.
 *
 * Per browser rather than per account: it's a preference about what someone
 * wants to be shown, like the map's POI layers beside it, and it costs nothing
 * to be wrong. Asked again after a browser reset, which is the right side to
 * err on for a warning about spoiling a game someone is playing.
 */
const SPOILER_ACK_KEY = "palcon.storage.worldLootAcknowledged";

function spoilerAcknowledged(): boolean {
  try {
    return localStorage.getItem(SPOILER_ACK_KEY) === "1";
  } catch {
    // Private browsing and locked-down storage settings both throw here.
    // Not remembering the answer is a re-prompt, not a failure.
    return false;
  }
}

function rememberSpoilerAck() {
  try {
    localStorage.setItem(SPOILER_ACK_KEY, "1");
  } catch {
    /* see spoilerAcknowledged */
  }
}

/** Containers drawn per role before the rest are counted rather than listed.
 * The world places some four thousand treasure chests; rendering them all costs
 * seconds and 60k DOM nodes to show a wall nobody scrolls through. Anything
 * above this is what search is for. */
const MAX_STRIPS = 40;

/** Blue for what's out in the world, grey for storage with no place at all —
 * bases keep their own assigned colours, so the two never collide. */
const WORLD_COLOR: string = "#5B9BD5"; // pal-blue
const UNPLACED_COLOR: string = "#5F5850"; // ink-muted

/**
 * Colours for base camps: the shared palette minus the two this page spends on
 * meaning. Blue says "out in the world" and grey says "nowhere" here, so a base
 * that happened to hash to either would quietly contradict its own legend.
 */
const BASE_PALETTE = PALETTE.filter((c) => c !== WORLD_COLOR && c !== UNPLACED_COLOR);

function baseColor(baseId: string): string {
  let hash = 0;
  for (let i = 0; i < baseId.length; i++) hash = (hash * 31 + baseId.charCodeAt(i)) | 0;
  return BASE_PALETTE[Math.abs(hash) % BASE_PALETTE.length];
}

interface Filters {
  query: string;
  category: string;
}

function filtersActive(f: Filters): boolean {
  return Boolean(f.query.trim()) || Boolean(f.category);
}

function matchSlot(slot: ItemSlot, f: Filters): boolean {
  if (f.category && itemCategory(slot.itemId) !== f.category) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return (
    itemName(slot.itemId).toLowerCase().includes(q) ||
    slot.itemId.toLowerCase().includes(q) ||
    (slot.eggSpecies ?? "").toLowerCase().includes(q)
  );
}

/** A container plus where it stands, which the payload keeps apart. */
interface Placed {
  container: StorageContainer;
  base?: StorageBase;
  /** Slots matching the current filter; every slot when no filter is on. */
  matched: ItemSlot[];
}

/** The heading a group of containers sits under. Bases are keyed by camp id;
 * everything else falls into one of the standing groups. */
function groupKeyOf(c: StorageContainer): string {
  if (c.kind === "base" && c.baseId) return c.baseId;
  // Keyed by guild rather than a bare "guild", so two guilds on one server get
  // a section each rather than sharing one heading.
  if (c.kind === "guild") return c.guildId ? `guild:${c.guildId}` : "guild";
  return c.kind === "world" ? "world" : "unplaced";
}

/** True for the group key a guild chest lands in. */
function isGuildKey(key: string): boolean {
  return key === "guild" || key.startsWith("guild:");
}

// ---------------------------------------------------------------------------

/** One item, drawn the way the game draws a slot. Shared shape with the
 * inventory page's cells, at a size that suits a horizontal strip. */
function SlotCell({ slot, onOpen }: { slot: ItemSlot; onOpen: (slot: ItemSlot) => void }) {
  const color = rarityColor(slot.itemId);
  const icon = itemIconUrl(slot.itemId);
  return (
    <button
      onClick={() => onOpen(slot)}
      title={`${itemName(slot.itemId)}${slot.count > 1 ? ` ×${slot.count.toLocaleString()}` : ""}`}
      className={cn(
        "group relative h-11 w-11 shrink-0 rounded-md border bg-ink-light transition-colors [content-visibility:auto]",
        "hover:bg-[#4A403A] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-amber",
      )}
      style={{ borderColor: color ? `${color}55` : "rgba(255,255,255,0.07)" }}
    >
      {icon && (
        <img
          src={icon}
          alt={itemName(slot.itemId)}
          className="absolute inset-1 h-[calc(100%-0.5rem)] w-[calc(100%-0.5rem)] object-contain"
          loading="lazy"
          decoding="async"
          onError={(e) => {
            e.currentTarget.style.visibility = "hidden";
          }}
        />
      )}
      {slot.count > 1 && (
        <span className="absolute bottom-0 right-0.5 font-mono text-[10px] font-bold leading-tight text-paper drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]">
          {slot.count > 9999 ? `${Math.round(slot.count / 1000)}k` : slot.count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

/** How much of a container a browsing eye gets before it has to ask for more.
 * A full 54-slot chest drawn whole is a wall of icons, and a base has dozens of
 * them — at that point the page stops being readable at any zoom. */
const PREVIEW_SLOTS = 10;

/**
 * One container: a dark strip of what's in it, captioned with what's holding
 * it. The game's own container idiom, laid on its side so a base's worth of
 * them reads down the page.
 *
 * A search shows exactly what matched, which is few by definition. Browsing
 * shows the biggest stacks and offers the rest, because "what's in this chest"
 * is answered by its ten deepest stacks far more often than by all fifty-four.
 */
function CrateStrip({
  placed,
  searching,
  onOpen,
}: {
  placed: Placed;
  searching: boolean;
  onOpen: (slot: ItemSlot, where: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { container, matched } = placed;
  const label = structureName(container.objectId);
  const icon = structureIconUrl(container.objectId);
  const where = placed.base ? `${label} · ${placed.base.guildName}` : label;

  // Browsing ranks by stack depth; a search keeps the container's own order, so
  // a matched slot sits where the game draws it.
  const ordered = searching ? matched : [...matched].sort((a, b) => b.count - a.count);
  const shown = searching || expanded ? ordered : ordered.slice(0, PREVIEW_SLOTS);
  const hidden = ordered.length - shown.length;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-ink px-3 py-2.5",
        // Browsing, the strips run the full width and stack into something
        // that reads like shelving. A search result holds a slot or two, and a
        // full-width bar around one icon is mostly empty ink — so it hugs.
        searching && "w-fit max-w-full",
      )}
    >
      {/* The build-menu icon, at the size the game's own hotbar draws it. This
          is the fastest way to know which box to walk to — people recognise
          the chest they built long before they read its tier name. Absent for
          world chests and anything the catalog doesn't cover, and the row
          reads fine without it. */}
      {icon && (
        // On a paper chip, not bare on the ink. The game draws these on its
        // light build menu and the art is dark line work — mean luminance
        // around 70 of 255 — so straight onto the strip it reads as a smudge.
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-paper/85">
          <img
            src={icon}
            alt=""
            aria-hidden
            className="h-7 w-7 object-contain [content-visibility:auto]"
            loading="lazy"
            decoding="async"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        </span>
      )}
      {/* Wide enough for the game's own longest storage names — "Large-Scale
          Electric Egg Incubator" and friends — since a name clipped to
          "Advanced Medicine Work…" is the opposite of telling someone which
          building to walk to. */}
      <p className="w-52 shrink-0" title={container.objectId || "no blueprint id in the save"}>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-paper">{label}</span>
          {/* Someone locked this one. Marked on the row rather than only in
              the filter, so a result you're reading says whose business it is
              without you having to remember what the checkbox is set to. */}
          {container.private && (
            // The save records that a password exists, never what it is.
            <span title="Password-locked by a player" className="shrink-0">
              <Lock className="h-3 w-3 text-brand-amber" aria-label="Password-locked" />
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] text-paper/40">
          {container.slots.length} / {container.size}
        </span>
        {/* A base's chests all stand within a few metres of each other, so
            their position is the base's and lives on its heading. A chest out
            in the world has no heading to inherit one from, and where it is is
            the only thing worth knowing about it. */}
        {!container.baseId && container.x !== undefined && container.y !== undefined && (
          <span
            className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-paper/40"
            title={`${Math.round(container.x)}, ${Math.round(container.y)} in world coordinates`}
          >
            <MapPin className="h-2.5 w-2.5" />
            {mapPosition({ x: container.x, y: container.y })}
          </span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((slot) => (
          <SlotCell key={`${container.id}-${slot.slot}`} slot={slot} onOpen={(s) => onOpen(s, where)} />
        ))}
        {hidden > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="h-11 rounded-md border border-white/[0.07] px-2.5 font-mono text-[11px] text-paper/50 transition-colors hover:bg-white/5 hover:text-paper"
          >
            +{hidden}
          </button>
        )}
        {expanded && (
          <button
            onClick={() => setExpanded(false)}
            className="h-11 rounded-md px-2.5 font-mono text-[11px] text-paper/40 transition-colors hover:text-paper"
          >
            Show less
          </button>
        )}
        {ordered.length === 0 && <span className="py-3 font-mono text-xs text-paper/30">Empty</span>}
      </div>
    </div>
  );
}

/** A base camp (or one of the standing groups) and everything in it. */
function PlaceSection({
  id,
  title,
  subtitle,
  color,
  base,
  serverId,
  placed,
  searching,
  open,
  onToggle,
  onOpen,
}: {
  id: string;
  title: string;
  subtitle: string;
  color: string;
  /** Absent for world loot and unplaced storage, which have no camp. */
  base?: StorageBase;
  serverId: number;
  placed: Placed[];
  searching: boolean;
  open: boolean;
  onToggle: () => void;
  onOpen: (slot: ItemSlot, where: string) => void;
}) {
  const total = placed.reduce((n, p) => n + p.matched.reduce((m, s) => m + s.count, 0), 0);
  const locked = placed.filter((p) => p.container.private).length;
  const byRole = ROLE_ORDER.map((role) => ({
    role,
    items: placed.filter((p) => structureRole(p.container.objectId) === role),
  })).filter((g) => g.items.length > 0);

  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      {/* The marker stays welded to the title, so a heading that wraps on a
          phone doesn't leave a lone dot on the line above it. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-ink/10 px-5 py-4">
        {/* Collapsing is on the heading itself rather than a separate control:
            a base is a container of containers, and the whole banner is the
            obvious thing to click to fold it away. The map link beside it
            stays its own target. */}
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className="group flex min-w-0 items-baseline gap-2 text-left"
        >
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 self-center text-ink/40 transition-transform", !open && "-rotate-90")}
          />
          <h2 className="truncate font-display text-base font-bold group-hover:text-brand-red">
            <span
              className="mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full align-middle"
              style={{ backgroundColor: color }}
            />
            {title}
          </h2>
        </button>
        <p className="font-mono text-xs text-ink/40">{subtitle}</p>
        <p className="ml-auto font-mono text-xs text-ink/40">
          <span className="text-brand-amber">{total.toLocaleString()}</span> items
        </p>
        {locked > 0 && (
          <span
            className="flex items-center gap-1 font-mono text-xs text-brand-amber/80"
            title={`${locked} password-locked ${locked === 1 ? "chest" : "chests"} in this group`}
          >
            <Lock className="h-3 w-3" />
            {locked}
          </span>
        )}
        {base && (
          // Lands on the pin the map already draws for this camp, the same way
          // the guilds page does it.
          <Link
            to={
              `/servers/${serverId}/map?base=${encodeURIComponent(`base-${base.guildId}-${base.index}`)}` +
              `&bx=${base.x}&by=${base.y}`
            }
            className="flex items-center gap-1 font-mono text-xs text-ink/40 transition-colors hover:text-brand-red"
            title="Show this base on the map"
          >
            <MapPin className="h-3 w-3" />
            {mapPosition(base)}
          </Link>
        )}
      </div>
      <div id={`${id}-body`} hidden={!open} className="space-y-4 p-4">
        {byRole.map(({ role, items }) => {
          const shown = items.slice(0, MAX_STRIPS);
          const hidden = items.length - shown.length;
          return (
            <div key={role}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink/40">
                {ROLE_LABELS[role]}
                <span className="ml-1.5 font-mono normal-case tracking-normal text-ink/30">
                  {items.length} {items.length === 1 ? "container" : "containers"}
                </span>
              </p>
              <div className="space-y-1.5">
                {shown.map((p) => (
                  <CrateStrip key={p.container.id} placed={p} searching={searching} onOpen={onOpen} />
                ))}
              </div>
              {hidden > 0 && (
                // Says what it's leaving out. Drawing four thousand chests
                // nobody scrolls to costs seconds and tells you nothing a
                // search wouldn't tell you faster.
                <p className="mt-2 text-xs text-ink/40">
                  {hidden.toLocaleString()} more {hidden === 1 ? "container" : "containers"} not shown — search to find
                  what's in them.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Coordinates as the map reads them — a percentage of the sheet the position
 * falls on, which is what someone comparing two bases actually wants. */
function mapPosition(coords: { x: number; y: number }): string {
  const area = mapOf(coords.x, coords.y);
  const { xPct, yPct } = worldToMapPercent(coords.x, coords.y, area);
  return `${xPct.toFixed(0)}, ${yPct.toFixed(0)}`;
}

/**
 * The stock line: what a search actually answers.
 *
 * Leads with the total, then splits it across the places holding it. The bar is
 * the point — a number alone says "you have 4,000 cement" where the split says
 * "and it's all at one base you haven't visited in a week".
 */
function StockLine({
  itemId,
  title,
  segments,
  places,
  total,
  containers,
  onJump,
}: {
  /** The one item the search settled on, if it settled on one — it gets the
   * icon and the game's own name. Empty for a search spanning several. */
  itemId: string;
  title: string;
  segments: { key: string; label: string; count: number; color: string }[];
  /** Real place count, which the segment list caps (see MAX_SEGMENTS). */
  places: number;
  total: number;
  containers: number;
  onJump: (key: string) => void;
}) {
  if (total === 0) return null;
  const icon = itemId ? itemIconUrl(itemId) : "";
  return (
    // Notched on the two corners the shape is known by, rounded on the other
    // two — the house treatment, same as TierTile.
    <div className="clip-notch-lg rounded-br-[10px] rounded-tl-[10px] bg-ink px-6 py-5 text-paper">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {icon && <img src={icon} alt="" className="h-7 w-7 shrink-0 self-center object-contain" />}
        <p className="font-display text-lg font-bold">{title}</p>
        <p className="font-mono text-sm text-paper/60">
          <span className="text-brand-amber">{total.toLocaleString()}</span> across {containers}{" "}
          {containers === 1 ? "container" : "containers"} in {places} {places === 1 ? "place" : "places"}
        </p>
      </div>

      <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full">
        {segments.map((s) => (
          <button
            key={s.key}
            onClick={() => onJump(s.key)}
            title={`${s.label} — ${s.count.toLocaleString()}`}
            aria-label={`Jump to ${s.label}, holding ${s.count}`}
            // Grows from nothing on a new search, so the split reads as an
            // answer arriving rather than a bar that was always there.
            className="min-w-[3px] origin-left transition-[flex-grow] duration-300 ease-out motion-reduce:transition-none"
            style={{ flexGrow: s.count, backgroundColor: s.color }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <button
            key={s.key}
            onClick={() => onJump(s.key)}
            className="flex items-center gap-1.5 font-mono text-[11px] text-paper/50 transition-colors hover:text-paper"
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            {s.label}
            <span className="text-paper/30">{s.count.toLocaleString()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const REFRESH_OPTIONS = [1, 2, 5, 10];
const DEFAULT_REFRESH_MINUTES = 5;

export function ServerStorage() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [place, setPlace] = useState("");
  const [world, setWorld] = useState(false);
  const [excludePrivate, setExcludePrivate] = useState(false);
  const [spoilerOpen, setSpoilerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [refreshMinutes, setRefreshMinutes] = useState(DEFAULT_REFRESH_MINUTES);
  const [selected, setSelected] = useState<{
    slot: ItemSlot;
    location: string;
  } | null>(null);

  const serverQuery = useQuery({
    queryKey: ["server", id],
    queryFn: () => api.getServer(id),
  });
  const infoQuery = useQuery({
    queryKey: ["server-info", id],
    queryFn: () => api.serverInfo(id),
    retry: false,
  });
  // World loot is a separate payload, so the two are cached separately and
  // toggling back is instant rather than a re-fetch.
  const storageQuery = useQuery<StorageResult>({
    queryKey: ["server-storage", id, world],
    queryFn: () => api.serverStorage(id, world),
    retry: false,
    refetchInterval: refreshMinutes * 60_000,
    gcTime: 60 * 60_000,
    staleTime: 60_000,
  });

  const filters: Filters = useMemo(() => ({ query, category }), [query, category]);
  const active = filtersActive(filters);

  const { groups, segments, total, matchedContainers, soleItemId, places, privateCount } = useMemo(() => {
    const data = storageQuery.data;
    const empty = {
      groups: [],
      segments: [],
      total: 0,
      matchedContainers: 0,
      soleItemId: "",
      places: [],
      privateCount: 0,
    };
    if (!data) return empty;

    const baseByID = new Map(data.bases.map((b) => [b.id, b]));
    const guildNames = new Map((data.guilds ?? []).map((g) => [g.id, g.name]));
    const buckets = new Map<string, Placed[]>();
    const placeOptions = new Map<string, string>();
    let total = 0;
    let matchedContainers = 0;
    let privateCount = 0;

    for (const container of data.containers) {
      if (container.private) privateCount += 1;
      // Two filters that narrow which containers are considered at all, rather
      // than which of their slots match: excluding locked chests, and pinning
      // the view to one place. Neither counts as "searching" — the stock line
      // answers "where is this item", and neither of these asks that.
      if (excludePrivate && container.private) continue;
      const groupKey = groupKeyOf(container);
      // Every place the reader could pin to, gathered before the pin is
      // applied — otherwise choosing one would empty the menu it came from.
      if (!placeOptions.has(groupKey)) {
        const base = container.baseId ? baseByID.get(container.baseId) : undefined;
        placeOptions.set(
          groupKey,
          groupKey === "world"
            ? "World loot"
            : groupKey === "unplaced"
              ? "Unplaced storage"
              : isGuildKey(groupKey)
                ? "Guild Chest"
                : baseTitle(base),
        );
      }
      if (place && groupKey !== place) continue;
      const matched = active ? container.slots.filter((s) => matchSlot(s, filters)) : container.slots;
      // A filter that nothing in this container satisfies drops the container,
      // rather than leaving an empty strip to scroll past. With no filter on,
      // an empty shelf at a base is worth seeing.
      if (active && matched.length === 0) continue;
      if (active) {
        matchedContainers += 1;
        for (const slot of matched) total += slot.count;
      }
      const key = groupKeyOf(container);
      const placed: Placed = {
        container,
        base: container.baseId ? baseByID.get(container.baseId) : undefined,
        matched,
      };
      const bucket = buckets.get(key);
      if (bucket) bucket.push(placed);
      else buckets.set(key, [placed]);
    }

    const groups = [...buckets.entries()]
      .map(([key, placed]) => {
        const base = placed[0].base;
        const count = placed.reduce((n, p) => n + p.matched.reduce((m, s) => m + s.count, 0), 0);
        return {
          key,
          placed,
          count,
          base,
          title:
            key === "world"
              ? "World loot"
              : key === "unplaced"
                ? "Unplaced storage"
                : isGuildKey(key)
                  ? "Guild Chest"
                  : baseTitle(base),
          color: key === "world" ? WORLD_COLOR : key === "unplaced" ? UNPLACED_COLOR : baseColor(key),
          guildName: guildNames.get(placed[0].container.guildId ?? "") ?? "",
        };
      })
      // Most of what you're looking for, first — for a search that's the
      // ranking, and for the resting list it puts the busiest base on top.
      .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));

    // One guild's camps all carry that guild's name, so the name alone can't
    // tell two of them apart; the map position does that work instead.
    const disambiguate = needsPosition(groups);

    // The stock bar names the biggest places and folds the tail into one
    // segment, so a search matching four thousand map chests still reads.
    const segments = groups.slice(0, MAX_SEGMENTS).map((g) => ({
      key: g.key,
      label: g.base && disambiguate ? `${g.title} · ${mapPosition(g.base)}` : g.title,
      count: g.count,
      color: g.color,
    }));
    const rest = groups.slice(MAX_SEGMENTS);
    if (rest.length > 0) {
      segments.push({
        key: rest[0].key,
        label: `${rest.length} more`,
        count: rest.reduce((n, g) => n + g.count, 0),
        color: UNPLACED_COLOR,
      });
    }
    const places = [...placeOptions.entries()]
      .map(([key, title]) => ({ key, title }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

    return {
      groups,
      segments,
      total,
      matchedContainers,
      soleItemId: soleItem(groups),
      places,
      privateCount,
    };
  }, [storageQuery.data, filters, active, excludePrivate, place]);

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (serverQuery.isError || !serverQuery.data) return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured =
    storageQuery.isError && storageQuery.error instanceof ApiError && storageQuery.error.status === 400;
  const hasData = storageQuery.data !== undefined;
  const containerCount = storageQuery.data?.containers.length ?? 0;

  const jump = (key: string) => {
    // A collapsed section can still be the answer to a search, so open it on
    // the way rather than scrolling to a closed banner.
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    // After the section has had a frame to expand, or the scroll lands short.
    requestAnimationFrame(() =>
      document.getElementById(`place-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  // Warn the first time, then take the reader at their word.
  const askAboutSpoilers = () => {
    if (spoilerAcknowledged()) setWorld(true);
    else setSpoilerOpen(true);
  };

  return (
    <div>
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Storage</h1>
          <p className="mt-0.5 text-sm text-ink/50">
            {serverQuery.data.name} · every chest, box and hopper in the world
          </p>
        </div>
        {storageQuery.data && (
          <p className="font-mono text-xs text-ink/40">
            save written {agoLabel(storageQuery.data.saveModTime)} · parsed {agoLabel(storageQuery.data.parsedAt)}
          </p>
        )}
      </header>

      <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
        {!hasData && storageQuery.isFetching && <SaveReadProgress />}

        {notConfigured && !hasData && <SavePathSetup />}

        {!hasData &&
          storageQuery.isError &&
          !notConfigured &&
          (infoQuery.isError ? (
            <ServerUnreachable />
          ) : (
            <p className="text-sm text-destructive">
              Could not read the save file: {(storageQuery.error as Error).message}
            </p>
          ))}

        {hasData && storageQuery.isFetching && <SaveUpdatingBanner />}

        {hasData && (
          // Two rows on purpose: what you're looking for on top, what to leave
          // out below. On one row the search box — the control that matters —
          // was the first thing the others squeezed.
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative w-full min-w-0 sm:w-auto sm:min-w-[18rem] sm:flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/30" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search every container…"
                  className="pl-9"
                />
              </div>

              <label className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink/40">Category</span>
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">All</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </label>

              {places.length > 1 && (
                <label className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink/40">Place</span>
                  <Select value={place} onChange={(e) => setPlace(e.target.value)}>
                    <option value="">Everywhere</option>
                    {places.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.title}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {/* Off by default: it's most of the payload, and it's the location
                of every chest on the server nobody has opened yet. Turning it
                on goes through the spoiler warning; turning it off doesn't. */}
              <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink/50">
                <input
                  type="checkbox"
                  checked={world}
                  onChange={(e) => (e.target.checked ? askAboutSpoilers() : setWorld(false))}
                  className="h-4 w-4 rounded border-ink/25 text-brand-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-amber"
                />
                Include world loot
              </label>

              {/* Only offered when there's something to exclude: a checkbox that
                can never change the result is a question with one answer. */}
              {privateCount > 0 && (
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-ink/50">
                  <input
                    type="checkbox"
                    checked={excludePrivate}
                    onChange={(e) => setExcludePrivate(e.target.checked)}
                    className="h-4 w-4 rounded border-ink/25 text-brand-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-amber"
                  />
                  <span className="flex items-center gap-1">
                    <Lock className="h-3 w-3 text-brand-amber" />
                    Exclude locked chests
                    <span className="font-mono text-ink/30">{privateCount}</span>
                  </span>
                </label>
              )}

              {(active || place || excludePrivate) && (
                <button
                  onClick={() => {
                    setQuery("");
                    setCategory("");
                    setPlace("");
                    setExcludePrivate(false);
                  }}
                  className="text-xs font-semibold text-brand-red hover:underline"
                >
                  Clear filters
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                <label className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-ink/40">Refresh</span>
                  <Select
                    value={refreshMinutes}
                    onChange={(e) => setRefreshMinutes(Number(e.target.value))}
                    className="font-mono text-xs"
                  >
                    {REFRESH_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </Select>
                </label>
                <button
                  onClick={() => storageQuery.refetch()}
                  disabled={storageQuery.isFetching}
                  title="Check for a newer save now"
                  aria-label="Refresh now"
                  className="rounded-lg border border-ink/15 bg-white p-2 text-ink/60 transition-colors hover:bg-ink/5 hover:text-ink disabled:opacity-50"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", storageQuery.isFetching && "animate-spin")} />
                </button>
              </div>
            </div>
          </div>
        )}

        {hasData && active && (
          <StockLine
            itemId={soleItemId}
            // One item gets its own name; a search spanning several is quoted
            // back as the search it was, rather than dressed up as an item.
            title={soleItemId ? itemName(soleItemId) : query.trim() ? `“${query.trim()}”` : category}
            segments={segments}
            places={groups.length}
            total={total}
            containers={matchedContainers}
            onJump={jump}
          />
        )}

        {hasData && containerCount === 0 && (
          <p className="text-sm text-muted-foreground">
            No storage in this save yet. Chests, feed boxes and work stations show up here once a base has some.
          </p>
        )}

        {hasData && containerCount > 0 && groups.length === 0 && (
          // An empty result is a place to say what would widen it. Each filter
          // that's actually on gets named, so the suggestion is never to turn
          // on something already on.
          <p className="text-sm text-muted-foreground">
            Nothing in {place ? "that place" : world ? "any container" : "base storage"} matches that search.
            {!world && " Turn on world loot to search the map's treasure chests too."}
            {excludePrivate && " Locked chests are excluded — untick that to include them."}
            {place && " Or search everywhere instead of one place."}
          </p>
        )}

        {groups.map((g) => (
          <PlaceSection
            key={g.key}
            id={`place-${g.key}`}
            title={g.title}
            subtitle={
              g.key === "world"
                ? `${g.placed.length} ${g.placed.length === 1 ? "chest" : "chests"} out in the world`
                : g.key === "unplaced"
                  ? "the save records no position for these"
                  : isGuildKey(g.key)
                    ? `${g.guildName || "shared"} · reached from any of the guild's chests`
                    : (g.base?.guildName ?? "")
            }
            color={g.color}
            base={g.base}
            serverId={id}
            placed={g.placed}
            searching={active}
            open={!collapsed.has(g.key)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(g.key)) next.delete(g.key);
                else next.add(g.key);
                return next;
              })
            }
            onOpen={(slot, location) => setSelected({ slot, location })}
          />
        ))}

        {hasData && containerCount > 0 && (
          <p className="pt-2 text-xs text-ink/35">
            {world
              ? "Showing base storage and world loot."
              : "Showing base storage. World loot is off — turn it on to search the map's treasure chests."}{" "}
            {/* Says which chests are missing and why, rather than quietly
                returning fewer results than the world holds. */}
            {storageQuery.data?.includesPrivate === false &&
              "Password-locked chests are excluded for this server by an admin. "}
            Item and building artwork and names © Pocketpair, Inc.
          </p>
        )}
      </div>

      <ItemDetailDialog
        slot={selected?.slot ?? null}
        location={selected?.location ?? ""}
        onClose={() => setSelected(null)}
      />

      <Dialog open={spoilerOpen} onOpenChange={setSpoilerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-brand-amber" />
              Show world loot?
            </DialogTitle>
            <DialogDescription>
              The world's treasure chests are part of the game's exploration. Turning this on lists what's inside every
              one of them and where it stands — including chests nobody on this server has found yet.
              <br />
              <br />
              Your own bases are unaffected either way. Palcon won't ask again on this device.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpoilerOpen(false)}>
              Keep it hidden
            </Button>
            <Button
              className="clip-notch"
              onClick={() => {
                rememberSpoilerAck();
                setWorld(true);
                setSpoilerOpen(false);
              }}
            >
              Show world loot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * What to call a base camp. The save gives camps no name of their own — only
 * the guild that owns them — and a guild's seven camps would otherwise all read
 * "Fluffy Genocide Inc". So they're numbered the way the map numbers them, and
 * placed by the nearest landmark, which is how people actually refer to a base
 * ("the one by the tower") rather than by its index.
 */
function baseTitle(base?: StorageBase): string {
  if (!base) return "Base camp";
  const landmark = nearestLandmark(base.x, base.y);
  return landmark ? `Base ${base.index + 1} · near ${landmark.name}` : `Base ${base.index + 1}`;
}

/** Whether two groups would show the same title, in which case the map
 * position is what tells them apart. */
function needsPosition(groups: { title: string }[]): boolean {
  return new Set(groups.map((g) => g.title)).size < groups.length;
}

/** The item a search settled on, so the stock line can name and picture it.
 * A search matching several items — a category filter, a partial word — has no
 * single answer, and says so by returning nothing. */
function soleItem(groups: { placed: Placed[] }[]): string {
  let found = "";
  for (const g of groups) {
    for (const p of g.placed) {
      for (const slot of p.matched) {
        if (!found) found = slot.itemId;
        else if (found !== slot.itemId) return "";
      }
    }
  }
  return found;
}
