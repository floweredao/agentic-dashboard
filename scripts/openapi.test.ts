import { expect, test } from "bun:test";
import { buildOpenApi } from "./openapi";

test("GPT Action schema exposes only source-authenticated create and own-record read", () => {
  // Given/When: generate the machine-consumed schema for a public TLS endpoint.
  const schema = buildOpenApi("https://agents.example.com");
  // Then: request routing, operation identifiers and authentication are importable.
  expect(schema["servers"]).toEqual([{ url: "https://agents.example.com" }]);
  expect(schema["paths"]).toMatchObject({
    "/api/v1/records": { post: { operationId: "saveRecord" } },
    "/api/v1/records/{id}": { get: { operationId: "readOwnRecord" } },
  });
  expect(schema["security"]).toEqual([{ bearerAuth: [] }]);
  expect(Object.keys(Object(schema["paths"]))).toHaveLength(2);
});

test("GPT Action generation refuses endpoints unreachable by cloud Actions", () => {
  // Given/When/Then: localhost, private tailnet IP and non-443 ports are rejected.
  for (const url of ["http://localhost:4310", "https://example.com:10000", "https://100.125.184.84"]) {
    expect(() => buildOpenApi(url)).toThrow();
  }
});
