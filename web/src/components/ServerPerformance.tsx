import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { cn } from "../lib/utils";
import { MetricChart } from "./MetricChart";

const RANGES = [
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
];

export function ServerPerformance({ serverId }: { serverId: number }) {
  const [minutes, setMinutes] = useState(60);

  const historyQuery = useQuery({
    queryKey: ["server-metrics-history", serverId, minutes],
    queryFn: () => api.serverMetricsHistory(serverId, minutes),
    retry: false,
    // Roughly the collector's own cadence — polling faster only redraws the
    // same points.
    refetchInterval: 30_000,
  });

  const points = historyQuery.data?.points ?? [];
  const timestamps = points.map((p) => p.ts);
  const intervalSeconds = historyQuery.data?.intervalSeconds ?? 30;

  return (
    <section className="rounded-2xl border border-ink/10 bg-white/70 p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-base font-bold">Performance</h2>
          <p className="mt-0.5 text-xs text-ink/40">Sampled every 30s, kept for 7 days</p>
        </div>
        <div className="inline-flex rounded-lg border border-ink/10 bg-ink/5 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              onClick={() => setMinutes(r.minutes)}
              className={cn(
                "rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
                r.minutes === minutes ? "bg-brand-red text-paper" : "text-ink/50 hover:text-ink",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {historyQuery.isLoading && <p className="text-sm text-muted-foreground">Loading history...</p>}

      {historyQuery.isError && (
        <p className="text-sm text-destructive">
          {historyQuery.error instanceof ApiError && historyQuery.error.status === 404
            ? "Server not found."
            : "Could not load metrics history."}
        </p>
      )}

      {historyQuery.isSuccess && points.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No samples yet — collection starts when the server is reachable over the REST API, and the
          first points appear within a minute.
        </p>
      )}

      {historyQuery.isSuccess && points.length > 0 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <MetricChart
            label="Server FPS"
            color="#4A9D7C"
            timestamps={timestamps}
            intervalSeconds={intervalSeconds}
            values={points.map((p) => p.serverFps)}
            format={(v) => v.toFixed(1)}
          />
          <MetricChart
            label="Frame time"
            unit="ms"
            color="#5B9BD5"
            timestamps={timestamps}
            intervalSeconds={intervalSeconds}
            values={points.map((p) => p.frameTime)}
            format={(v) => v.toFixed(1)}
          />
          <MetricChart
            label="Players online"
            color="#F2A93B"
            timestamps={timestamps}
            intervalSeconds={intervalSeconds}
            values={points.map((p) => p.playerCount)}
            format={(v) => String(Math.round(v))}
          />
        </div>
      )}
    </section>
  );
}
