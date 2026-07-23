import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

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
      return <p className="text-sm text-muted-foreground">Requires the REST API — this server is configured RCON-only.</p>;
    }
    return <p className="text-sm text-destructive">Could not reach server.</p>;
  }

  const m = metricsQuery.data;
  if (!m) return null;

  const stats = [
    { label: "Players", value: `${m.currentplayernum} / ${m.maxplayernum}`, color: "text-pal-blue" },
    { label: "Days elapsed", value: m.days, color: "text-brand-amber" },
    { label: "Uptime", value: formatUptime(m.uptime), color: "text-pal-green" },
    { label: "Server FPS", value: m.serverfps.toFixed(1), color: "text-brand-red" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="rounded-md border border-border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.label}</p>
          <p className={`mt-1 font-mono text-lg font-bold ${s.color}`}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}
