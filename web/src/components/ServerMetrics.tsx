import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { formatUptime } from "../lib/palette";

export function ServerMetrics({ serverId }: { serverId: number }) {
  const metricsQuery = useQuery({
    queryKey: ["server-metrics", serverId],
    queryFn: () => api.serverMetrics(serverId),
    retry: false,
    refetchInterval: 15_000,
  });

  if (metricsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading metrics...</p>;
  }
  if (metricsQuery.isError) {
    const err = metricsQuery.error;
    if (err instanceof ApiError && err.status === 400) {
      return (
        <p className="text-sm text-muted-foreground">
          Metrics require the REST API — this server is configured RCON-only.
        </p>
      );
    }
    return <p className="text-sm text-destructive">Could not reach server.</p>;
  }

  const m = metricsQuery.data;
  if (!m) return null;

  const stats = [
    { label: "Players online", value: `${m.currentplayernum} / ${m.maxplayernum}`, color: "text-pal-green" },
    { label: "Server tick", value: `${m.serverframetime.toFixed(1)} ms`, color: "text-pal-blue" },
    { label: "In-game days", value: String(m.days), color: "text-brand-amber" },
    { label: "Uptime", value: formatUptime(m.uptime), color: "text-ink" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      {stats.map((s) => (
        <div key={s.label} className="rounded-2xl border border-ink/10 bg-white/70 p-4 lg:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">{s.label}</p>
          <p className={`mt-2 font-mono text-lg font-bold lg:text-2xl ${s.color}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}
