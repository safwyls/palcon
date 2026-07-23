import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { ServerDetail } from "./pages/ServerDetail";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { username, loading } = useAuth();
  if (loading) return <p className="p-6 text-slate-400">Loading...</p>;
  if (!username) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/servers/:serverID"
        element={
          <RequireAuth>
            <ServerDetail />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
