import { useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * A compact time-series chart, hand-rolled in SVG.
 *
 * Deliberately not a charting library: the only shape needed is a line with
 * a soft fill, and the lightest credible dependency still costs more than
 * the whole current bundle. This also keeps the palette and type consistent
 * with the rest of the app instead of theming someone else's defaults.
 */
export function MetricChart({
  label,
  unit,
  color,
  timestamps,
  values,
  intervalSeconds,
  format = (v) => v.toFixed(1),
  className,
}: {
  label: string;
  unit?: string;
  color: string;
  timestamps: string[];
  values: (number | null)[];
  /** Expected gap between samples; anything much larger is an outage. */
  intervalSeconds: number;
  format?: (value: number) => string;
  className?: string;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Fixed drawing space; the SVG scales to its container and strokes are
  // kept honest with vector-effect, so no resize measurement is needed.
  const W = 300;
  const H = 90;

  const { segments, scaleX, scaleY, dataLo, dataHi, lastIndex, times, tMin, span } = useMemo(() => {
    const present = values.filter((v): v is number => v !== null);
    // Real extremes are reported to the reader; lo/hi below get padded for
    // drawing, and showing those instead would misstate the data.
    const dataLo = present.length ? Math.min(...present) : 0;
    const dataHi = present.length ? Math.max(...present) : 0;
    let lo = dataLo;
    let hi = present.length ? dataHi : 1;
    // A dead-flat series would otherwise divide by zero and render as a
    // line pinned to the top edge; give it a band to sit in the middle of.
    if (hi - lo < 1e-6) {
      const pad = Math.max(Math.abs(hi) * 0.1, 1);
      lo -= pad;
      hi += pad;
    } else {
      const pad = (hi - lo) * 0.15;
      lo -= pad;
      hi += pad;
    }

    // x is time, not array position. Plotting by index would space samples
    // evenly no matter when they were taken, so an outage would silently
    // compress into a normal-looking step instead of showing as missing.
    const times = timestamps.map((t) => Date.parse(t));
    const tMin = times.length ? times[0] : 0;
    const tMax = times.length ? times[times.length - 1] : 1;
    const span = Math.max(1, tMax - tMin);
    const scaleX = (i: number) => ((times[i] - tMin) / span) * W;
    const scaleY = (v: number) => H - ((v - lo) / (hi - lo)) * H;

    // Break the line on a missing reading, or whenever samples are further
    // apart than collection should allow — that's downtime, not data.
    const maxGapMs = intervalSeconds * 2.5 * 1000;
    const segments: { i: number; v: number }[][] = [];
    let run: { i: number; v: number }[] = [];
    let lastIndex = -1;
    values.forEach((v, i) => {
      const brokeByTime = run.length > 0 && times[i] - times[run[run.length - 1].i] > maxGapMs;
      if (v === null || brokeByTime) {
        if (run.length) segments.push(run);
        run = [];
        if (v === null) return;
      }
      lastIndex = i;
      run.push({ i, v });
    });
    if (run.length) segments.push(run);

    return { segments, scaleX, scaleY, dataLo, dataHi, lastIndex, times, tMin, span };
  }, [values, timestamps, intervalSeconds]);

  const toPath = (seg: { i: number; v: number }[]) =>
    seg.map((p, k) => `${k ? "L" : "M"}${scaleX(p.i).toFixed(2)},${scaleY(p.v).toFixed(2)}`).join(" ");

  const hasData = values.some((v) => v !== null);
  const activeIndex = hover ?? lastIndex;
  const activeValue = activeIndex >= 0 ? values[activeIndex] : null;
  const gradientId = `grad-${label.replace(/\W+/g, "")}`;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || values.length === 0) return;
    // Nearest sample by time, not by index — with x on a time axis those
    // differ wherever sampling was uneven.
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = tMin + frac * span;
    let best: number | null = null;
    let bestDist = Infinity;
    times.forEach((t, i) => {
      if (values[i] === null) return;
      const dist = Math.abs(t - target);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setHover(best);
  }

  return (
    <div className={cn("rounded-xl border border-ink/10 bg-white/60 p-4", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">{label}</p>
        {hasData && activeValue !== null && (
          <p className="font-mono text-lg font-bold" style={{ color }}>
            {format(activeValue)}
            {unit && <span className="ml-0.5 text-xs font-medium text-ink/40">{unit}</span>}
          </p>
        )}
      </div>

      {!hasData ? (
        <p className="flex h-[90px] items-center justify-center text-xs text-ink/40">
          No samples in this window yet.
        </p>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="mt-2 h-[90px] w-full overflow-visible"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${label} over time`}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.25" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Fill each run separately — a single fill spanning the gaps
                would shade time we have no readings for. */}
            {segments.map((seg, i) =>
              seg.length > 1 ? (
                <path
                  key={`fill-${i}`}
                  d={`${toPath(seg)} L${scaleX(seg[seg.length - 1].i).toFixed(2)},${H} L${scaleX(seg[0].i).toFixed(2)},${H} Z`}
                  fill={`url(#${gradientId})`}
                />
              ) : null,
            )}
            {segments.map((seg, i) => (
              <path
                key={`line-${i}`}
                d={toPath(seg)}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hover !== null && values[hover] !== null && (
              <>
                <line
                  x1={scaleX(hover)}
                  x2={scaleX(hover)}
                  y1={0}
                  y2={H}
                  stroke="currentColor"
                  className="text-ink/20"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={scaleX(hover)}
                  cy={scaleY(values[hover] as number)}
                  r={3}
                  fill={color}
                  stroke="#fff"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>

          <div className="mt-1 flex justify-between font-mono text-[10px] text-ink/35">
            <span>
              low {format(dataLo)} · high {format(dataHi)}
            </span>
            <span>
              {activeIndex >= 0 && timestamps[activeIndex]
                ? new Date(timestamps[activeIndex]).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : ""}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
