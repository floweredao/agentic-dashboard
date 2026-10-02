import { expect, test } from "bun:test";
import { createApp } from "../server/app";
import { fixture, origin, tokens } from "./backend-helper";

test("HTTPS deployment retains usable local HTTP login without weakening remote cookies", async () => {
  // Given: production is configured for a private HTTPS origin.
  const f = fixture();
  const remoteOrigin = "https://dashboard.example.test:9443";
  const app = createApp({ ...f.options, privateOrigin: remoteOrigin });
  try {
    for (const requestOrigin of [origin, remoteOrigin]) {
      // When: an explicitly allowed local or remote browser signs in.
      const response = await app.fetch(new Request(`${origin}/api/v1/auth/session`, {
        method: "POST",
        headers: { origin: requestOrigin, "content-type": "application/json" },
        body: JSON.stringify({ token: tokens.owner }),
      }));
      // Then: the cookie's transport matches that browser's trusted origin.
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")?.includes("; Secure")).toBe(requestOrigin.startsWith("https:"));
    }
  } finally {
    app.close();
    f.close();
  }
});
