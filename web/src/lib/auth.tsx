import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";

interface AuthState {
  username: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((res) => setUsername(res.username))
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          console.error(err);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (u: string, p: string) => {
    const res = await api.login(u, p);
    setUsername(res.username);
  };

  const logout = async () => {
    await api.logout();
    setUsername(null);
  };

  return <AuthContext.Provider value={{ username, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
