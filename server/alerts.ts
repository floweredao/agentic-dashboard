import ky from "ky";
import type { Sql } from "./db";

export type AlertKind = "signup" | "capacity" | "maintenance" | "usage";
export interface AlertOptions {
  readonly owner: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly now?: () => number;
}
const messages: Readonly<Record<AlertKind, string>> = {
  signup: "A new dashboard account was created.",
  capacity: "The dashboard sign-up capacity has been reached.",
  maintenance: "Dashboard maintenance or backup failed. Check operator logs.",
  usage: "A configured database usage metric exceeded 70% of its allowance.",
};
export function createAlerts(sql: Sql, options: AlertOptions) {
  return {
    async send(kind: AlertKind) {
      const day = new Date((options.now ?? Date.now)()).toISOString().slice(0, 10);
      const claim = await sql.run("INSERT OR IGNORE INTO operator_alerts(kind,day) VALUES(?,?)", [kind, day]);
      if (!claim.changes) return;
      // Do not retry an uncertain send: a network failure must not produce duplicate mail.
      await ky.post(options.endpoint ?? "https://api.resend.com/emails", {
        timeout: 10000, retry: 0, headers: { Authorization: `Bearer ${options.apiKey}`, "Idempotency-Key": `dashboard-${kind}-${day}` },
        json: { from: "onboarding@resend.dev", to: [options.owner], subject: `Dashboard: ${kind}`, text: messages[kind] },
      });
    },
  };
}
