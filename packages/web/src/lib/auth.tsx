import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { User } from "./types";

interface AuthState {
  user: User | undefined;
  loading: boolean;
  needsSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (email: string, password: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const status = await api.get<{ needsSetup: boolean }>("/setup/status").catch((e) => {
          // Network failure is not "setup done" — surface as setup needed to avoid login loop
          if (e instanceof ApiError && e.status === 0) throw e;
          return { needsSetup: false } as { needsSetup: boolean };
        });
        if (status.needsSetup) {
          setNeedsSetup(true);
          return;
        }
        await api
          .get<{ user: User }>("/auth/me")
          .then((res) => setUser(res.user))
          .catch(() => setUser(undefined));
      } catch {
        // Network unreachable — keep needsSetup false, loading will show retry
      } finally {
        setLoading(false);
      }
    }
    void init();
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post<{ user: User }>("/auth/login", { email, password });
    setUser(res.user);
  }

  async function logout() {
    await api.post("/auth/logout");
    setUser(undefined);
    // Force reload to clear all cached queries for next login
    try { window.location.reload(); } catch {}
  }

  async function bootstrap(email: string, password: string) {
    const res = await api.post<{ user: User }>("/setup/bootstrap", { email, password });
    setNeedsSetup(false);
    setUser(res.user);
  }

  return (
    <AuthContext.Provider value={{ user, loading, needsSetup, login, logout, bootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
