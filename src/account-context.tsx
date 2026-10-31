import { createContext, useContext } from "react";
import type { Account } from "../shared/account";
import { DashboardContext, type Dashboard } from "./state";

export const AccountContext = createContext<{
  readonly account: Account | null; readonly refresh: () => Promise<void>; readonly update: (account: Account) => void;
  readonly resumeDeletion?: boolean;
} | null>(null);
export const useAccount = () => useContext(AccountContext);

/** Setup reuses the same credential controls before the full record dashboard is mounted. */
export const SetupCredentials = createContext<Pick<Dashboard, "csrfToken" | "notify" | "refresh"> | null>(null);
export function useCredentials() {
  const dashboard = useContext(DashboardContext);
  const setup = useContext(SetupCredentials);
  const value = dashboard ?? setup;
  if (!value) throw new Error("Credential controls require an authenticated session");
  return value;
}
