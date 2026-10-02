import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { AGENT_RECORD_GUIDE } from "../shared/contracts";

class PublicEndpointError extends Error {
  override readonly name = "PublicEndpointError";
  constructor() {
    super("GPT Actions에는 공개 DNS 이름과 HTTPS 443 주소가 필요합니다.");
  }
}

export function buildOpenApi(url: string): Record<string, unknown> {
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    isIP(endpoint.hostname) ||
    endpoint.hostname.startsWith("[") ||
    !endpoint.hostname.includes(".") ||
    endpoint.hostname.endsWith(".local") ||
    endpoint.hostname.endsWith(".localhost")
  ) {
    throw new PublicEndpointError();
  }
  const record = {
    type: "object",
    required: ["kind", "title", "tags"],
    additionalProperties: false,
    description: AGENT_RECORD_GUIDE,
    properties: {
      kind: { type: "string", enum: ["project", "task", "research", "work-report", "note", "social"] },
      title: { type: "string", minLength: 1, maxLength: 200,
        description: "Agent titles must be one line of at most 40 columns where Hangul and CJK count 2 (about 18 Korean characters): subject plus key point, no dates, details in fields.summary." },
      body: { type: "string", maxLength: 16000 },
      status: { type: "string" },
      projectId: { type: ["string", "null"] },
      taskId: { type: ["string", "null"] },
      dueDate: { type: ["string", "null"], format: "date" },
      tags: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" }, description: "1-5 topic words without #, spaces or commas." },
      links: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          required: ["label", "url"],
          properties: { label: { type: "string" }, url: { type: "string", format: "uri" } },
        },
      },
      fields: {
        type: "object",
        description: "research/work-report: summary (1-3 lines), conclusion (one line), nextActions (\"- \" lines). note/social: summary. Projects: nextAction. Tasks: today. No other keys; see CONTRACT.md.",
        additionalProperties: true,
      },
    },
  };
  const saved = {
    type: "object",
    properties: {
      record: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          source: { type: "string" },
          reviewState: { type: "string" },
          fields: { type: "object", additionalProperties: true },
        },
      },
      replayed: { type: "boolean" },
    },
  };
  const response = {
    description: "Persisted record",
    content: { "application/json": { schema: saved } },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Agentic Dashboard agent API", version: "1.0.0" },
    servers: [{ url: endpoint.origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/records": {
        post: {
          operationId: "saveRecord",
          summary: "Save a project, task, research report or social item",
          "x-openai-isConsequential": true,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["requestId", "record"],
                  properties: {
                    requestId: {
                      type: "string",
                      minLength: 1,
                      maxLength: 128,
                      description: "Unique save identity; reuse unchanged on retry.",
                    },
                    record,
                  },
                },
              },
            },
          },
          responses: { "201": response, "200": response },
        },
      },
      "/api/v1/records/{id}": {
        get: {
          operationId: "readOwnRecord",
          summary: "Read a record created with this agent credential",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": response },
        },
      },
    },
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
  };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { url: { type: "string" } },
    });
    console.log(JSON.stringify(buildOpenApi(values.url ?? process.env["PUBLIC_API_BASE_URL"] ?? ""), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "스키마 생성 실패");
    process.exitCode = 1;
  }
}
