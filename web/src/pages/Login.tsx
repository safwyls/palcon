import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">Palcon</h1>
        <div className="space-y-1">
          <label className="block text-sm text-slate-400">Username</label>
          <input
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm text-slate-400">Password</label>
          <input
            type="password"
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-indigo-600 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
