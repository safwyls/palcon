import { MAP_AREAS, MAP_AREA_ORDER, type MapArea } from "../lib/map";
import { cn } from "../lib/utils";

export function MapAreaToggle({ area, onChange }: { area: MapArea; onChange: (area: MapArea) => void }) {
  if (MAP_AREA_ORDER.length <= 1) return null;

  return (
    <div className="inline-flex rounded-xl border border-ink/15 bg-paper p-1 shadow-lg">
      {MAP_AREA_ORDER.map((a) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors",
            a === area ? "bg-brand-red text-paper" : "text-ink/60 hover:bg-ink/5",
          )}
        >
          {MAP_AREAS[a].label}
        </button>
      ))}
    </div>
  );
}
