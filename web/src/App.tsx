import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { EmptyState } from "./pages/EmptyState";
import { Users } from "./pages/Users";
import { ServerDashboard } from "./pages/ServerDashboard";
import { ServerMap } from "./pages/ServerMap";
import { AppShell } from "./components/AppShell";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";

// Split out: this route pulls in the pal dex, skill and stat catalogs
// (~190 KB), which nothing else needs. Dashboard and map users never
// download them.
const ServerPlayers = lazy(() =>
  import("./pages/ServerPlayers").then((m) => ({ default: m.ServerPlayers })),
);
const ServerGuilds = lazy(() =>
  import("./pages/ServerGuilds").then((m) => ({ default: m.ServerGuilds })),
);

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return <p className="p-6 text-muted-foreground">Loading...</p>;
  if (!username) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <TooltipProvider delayDuration={200}>
      <Toaster position="bottom-right" />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          <Route path="/" element={<EmptyState />} />
          <Route path="/users" element={<Users />} />
          <Route path="/servers/:serverID" element={<ServerDashboard />} />
          <Route path="/servers/:serverID/map" element={<ServerMap />} />
          <Route
            path="/servers/:serverID/guilds"
            element={
              <Suspense fallback={<p className="p-6 text-muted-foreground">Loading…</p>}>
                <ServerGuilds />
              </Suspense>
            }
          />
          <Route
            path="/servers/:serverID/players"
            element={
              <Suspense fallback={<p className="p-6 text-muted-foreground">Loading…</p>}>
                <ServerPlayers />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </TooltipProvider>
  );
}
