import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me, type Permission } from "./api";

interface AuthState {
  username: string | null;
  isAdmin: boolean;
  /** Mirrors the server's grants so the UI can hide controls it would
   * reject anyway. The server still enforces every one of them. */
  can: (permission: Permission) => boolean;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) {
          console.error(err);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (u: string, p: string) => {
    await api.login(u, p);
    // Re-read rather than trusting the login response: /me is the single
    // source for role and permissions.
    setMe(await api.me());
  };

  const logout = async () => {
    await api.logout();
    setMe(null);
  };

  const value: AuthState = {
    username: me?.username ?? null,
    isAdmin: me?.isAdmin ?? false,
    can: (permission) => Boolean(me?.isAdmin) || Boolean(me?.permissions?.includes(permission)),
    loading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
