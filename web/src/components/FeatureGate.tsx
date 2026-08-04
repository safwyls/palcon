import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import { api, type Feature } from "../lib/api";
import { useAuth } from "../lib/auth";
import { featureLabel } from "../lib/games";
import { canSeeFeature, featureExists } from "../lib/visibility";

/**
 * Refuses a view this server can't show: one its game doesn't have, or one an
 * admin has switched off.
 *
 * The API refuses it too — this is what stops a deep link from rendering a
 * page whose every request 403s, which reads as broken rather than as off.
 * Admins pass through the privacy switch, so the gate never hides a page from
 * the person who would have to un-hide it; they do not pass through a view the
 * game simply doesn't have, because there is nothing to un-hide.
 */
export function FeatureGate({ feature, children }: { feature: Feature; children: React.ReactNode }) {
  const { serverID } = useParams();
  const id = Number(serverID);
  const { isAdmin } = useAuth();
  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });

  // Say nothing until the answer is known, rather than flashing "turned off"
  // at someone who is allowed in.
  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (canSeeFeature(serverQuery.data, feature, isAdmin)) return <>{children}</>;

  const server = serverQuery.data;
  const missing = !featureExists(server, feature);

  return (
    // min-h rather than flex-1: the route's parent isn't a stretching column,
    // so flex-1 alone left this pinned to the top of an empty page.
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ink/5 text-ink/40">
        <EyeOff className="h-5 w-5" />
      </span>
      <div>
        <p className="font-display text-lg font-bold">
          {featureLabel(server, feature)} {missing ? "isn't available" : "is turned off"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {missing
            ? "This server's game doesn't have this view."
            : "An admin has hidden this view for this server. Ask them to turn it back on in Settings."}
        </p>
      </div>
    </div>
  );
}
