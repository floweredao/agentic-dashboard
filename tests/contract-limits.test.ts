import { expect, test } from "bun:test";
import { bearer, fixture, payload } from "./backend-helper";

test("request identity obeys the documented 128 character limit", async () => {
  // Given: an authenticated agent sends a well-formed record.
  const f = fixture();
  try {
    // When: only the retry identity exceeds the published contract.
    const response = await f.call(
      "/api/v1/records", "POST", { ...payload(), requestId: "r".repeat(129) }, bearer("omo"),
    );
    // Then: the input boundary rejects it.
    expect(response.status).toBe(400);
  } finally { f.close(); }
});

test("record collections obey the same limits advertised to GPT Actions", async () => {
  // Given: agent input crosses the real API validator.
  const f = fixture();
  try {
    for (const fields of [
      { tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
      { links: Array.from({ length: 11 }, (_, index) => ({ label: `${index}`, url: "https://example.com" })) },
    ]) {
      // When: a collection exceeds its published maximum.
      const response = await f.call(
        "/api/v1/records", "POST",
        payload({ kind: "research", title: "Boundary", ...fields }), bearer("codex"),
      );
      // Then: validation rejects rather than storing incompatible payloads.
      expect(response.status).toBe(400);
    }
  } finally { f.close(); }
});
