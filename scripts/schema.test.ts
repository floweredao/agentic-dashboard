import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SCHEMA_PATH, schemaText } from "./schema";

test("the published storage schema matches the runtime boundaries", () => {
  // Given: the checked-in machine-readable storage contract.
  const published = readFileSync(SCHEMA_PATH, "utf8");
  // When: generating it from the runtime schemas.
  const generated = schemaText();
  // Then: consumers get exactly those boundaries.
  expect(published).toBe(generated);
});
