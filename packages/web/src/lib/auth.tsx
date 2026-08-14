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
      const status = await api.get<{ needsSetup: boolean }>("/setup/status").catch(() => ({ needsSetup: false }));
      if (status.needsSetup) {
        setNeedsSetup(true);
        setLoading(false);
        return;
      }
      await api
        .get<{ user: User }>("/auth/me")
        .then((res) => setUser(res.user))
        .catch(() => setUser(undefined));
      setLoading(false);
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
