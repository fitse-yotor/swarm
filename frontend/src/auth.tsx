import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler, token, type User } from "./api";

interface AuthState {
  user: User | null; loading: boolean;
  login: (email: string, password: string) => Promise<void>; logout: () => void; can: (perm: string) => boolean;
  /** Re-read the signed-in user (after a profile or role change). */
  refresh: () => Promise<void>;
}
const Ctx = createContext<AuthState>(null as unknown as AuthState);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!token.get());
  const qc = useQueryClient();
  const logout = useCallback(() => { token.set(null); setUser(null); qc.clear(); }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!token.get()) return;
    api.get<User>("/auth/me").then(setUser).catch(logout).finally(() => setLoading(false));
  }, [logout]);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ access_token: string; user: User }>("/auth/login", { email, password });
    token.set(r.access_token);
    setUser(r.user);
  };
  const refresh = useCallback(() => api.get<User>("/auth/me").then(setUser), []);
  const can = (p: string) => !!user?.permissions.includes(p);
  return <Ctx.Provider value={{ user, loading, login, logout, can, refresh }}>{children}</Ctx.Provider>;
}
