import type { Hono } from "hono";
import { z } from "zod";
import { AgentNameSchema } from "../shared/contracts";
import type { TenantRuntime } from "./app-runtime";
import { json } from "./json-body";

export function registerAgents(app: Hono, runtime: TenantRuntime) {
  const { agents, owner } = runtime;
  app.post("/api/v1/agents/invites", async c => {
    await owner(c.req.raw, true);
    const input = z.object({ name: AgentNameSchema }).strict().parse(await json(c.req.raw));
    return c.json(await runtime.invites.create(input.name), 201);
  });
  app.post("/api/v1/agents", async c => {
    await owner(c.req.raw, true);
    const input = z.object({ name: AgentNameSchema, capture: z.boolean().default(false) }).strict().parse(await json(c.req.raw));
    const key = await agents.add(input.name, undefined, input.capture);
    return c.json({ agent: await agents.get(input.name), key }, 201);
  });
  app.post("/api/v1/agents/:name/rotate", async c => {
    await owner(c.req.raw, true);
    const name = AgentNameSchema.parse(c.req.param("name"));
    const key = await agents.rotate(name);
    return c.json({ agent: await agents.get(name), key });
  });
  app.delete("/api/v1/agents/:name", async c => {
    await owner(c.req.raw, true);
    await agents.revoke(AgentNameSchema.parse(c.req.param("name")));
    return c.body(null, 204);
  });
}
