/** The configured origin owns redirects, shares, notifications and browser authority together. */
export function originSettings(origin: string, local: boolean, port: number) {
  const origins = new Set(local ? [
    origin, `http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://127.0.0.1:4311", "http://localhost:4311",
  ] : [origin]);
  return { origin, redirectUri: `${origin}/auth/google/callback`, vapidSubject: origin,
    origins, hosts: new Set([...origins].map(value => new URL(value).host)) };
}
