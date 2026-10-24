import { Hono } from "hono";
import { z } from "zod";
import { CommentInputSchema, DOCUMENT_LIMITS, DocumentInputSchema, NARRATABLE_KINDS, RECORD_LIMITS, RecordInputSchema, RecordPatchSchema } from "../shared/contracts";
import { ApiError } from "./errors";
import { json } from "./json-body";
import { agentCanRead, agentView } from "./store";
import type { TenantRuntime } from "./app-runtime";


const createSchema = z.object({ requestId: z.string().trim().min(1).max(128), record: z.unknown() }).strict();
export function registerRecords(app: Hono, runtime: TenantRuntime, publicOnly: boolean) {
  const { store, auth, aiFillSources, comments, narration, newRecord, editedRecord, notifyEntry, notifyReview, origins, owner, narratable } = runtime;
  if (!publicOnly) {

      app.get("/api/v1/records", async c => {
        const principal = (await auth.authenticate(c.req.raw, false));
        return c.json(principal.source === "manual" ? (await store.list(c.req.query())) : (await store.list(c.req.query(), principal)));
      });

      app.patch("/api/v1/records/:id", async c => {
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source === "manual") (await auth.csrf(c.req.raw, origins));
        const patch = RecordPatchSchema.parse(await json(c.req.raw, RECORD_LIMITS.requestBytes));
        const before = (await store.get(c.req.param("id")));
        if (principal.source === "manual") {
          const record = (await store.patch(c.req.param("id"), patch));
          (await editedRecord(before, record));
          return c.json({ record });
        }
        const record = (await store.agentPatch(principal, c.req.param("id"), patch));
        (await editedRecord(before, record));
        (await notifyReview(before, record));
        return c.json({ record });
      });

      /** Moves a record to the trash: the owner (CSRF) any record, an agent only one it created; the owner restores it from the trash. */
      app.delete("/api/v1/records/:id", async c => {
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source === "manual") (await auth.csrf(c.req.raw, origins));
        else if ((await store.get(c.req.param("id"))).createdBy !== principal.id) throw new ApiError(403, "forbidden", "Agents move only records they created to the trash");
        const input = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(await json(c.req.raw));
        (await store.delete(c.req.param("id"), input.expectedVersion));
        return c.body(null, 204);
      });

      app.get("/api/v1/comments", async c => c.json((await comments.list((await auth.authenticate(c.req.raw, false)), c.req.query()))));

      app.post("/api/v1/comments", async c => {
        const principal = (await auth.authenticate(c.req.raw, false));
        if (principal.source === "manual") (await auth.csrf(c.req.raw, origins));
        const result = (await comments.create(principal, CommentInputSchema.parse(await json(c.req.raw))));
        if (principal.source !== "manual" && !result.replayed) (await notifyEntry(result.comment, result.record));
        return c.json(result, result.replayed ? 200 : 201);
      });

      app.post("/api/v1/comments/:id/seen", async c => c.json((await comments.mark((await auth.authenticate(c.req.raw, false)), c.req.param("id"), "seen"))));

      app.post("/api/v1/comments/:id/done", async c => c.json((await comments.mark((await auth.authenticate(c.req.raw, false)), c.req.param("id"), "done"))));

      app.get("/api/v1/trash", async c => { (await owner(c.req.raw, false)); const items = (await store.trashList()); (await narration.prune()); return c.json({ items }); });

      app.post("/api/v1/trash/:id/restore", async c => { (await owner(c.req.raw, true)); return c.json({ record: (await store.restore(c.req.param("id"))) }); });

      app.delete("/api/v1/trash/:id", async c => { (await owner(c.req.raw, true)); (await store.destroy(c.req.param("id"))); (await narration.prune()); return c.body(null, 204); });

      app.delete("/api/v1/trash", async c => { (await owner(c.req.raw, true)); (await store.emptyTrash()); (await narration.prune()); return c.body(null, 204); });

      /** Full document: read like the record; replaced or removed by the owner (CSRF) or the agent that created the record. */
      app.get("/api/v1/records/:id/document", async c => c.json({ document: (await store.document((await narratable(c.req.raw, c.req.param("id"))).record.id)) }));

      const documentWriter = async (request: Request, id: string) => {
        const { principal, record } = (await narratable(request, id));
        if (principal.source === "manual") (await auth.csrf(request, origins));
        else if (record.createdBy !== principal.id) throw new ApiError(403, "forbidden", "Agents attach documents only to records they created");
        if (!NARRATABLE_KINDS.some(kind => kind === record.kind)) {
          throw new ApiError(400, "document_unsupported", "Only research, work-report, note and social records take a document");
        }
        return { principal, record };
      };

      app.put("/api/v1/records/:id/document", async c => {
        const { principal, record } = (await documentWriter(c.req.raw, c.req.param("id")));
        const input = DocumentInputSchema.parse(await json(c.req.raw, DOCUMENT_LIMITS.requestBytes));
        return c.json({ document: (await store.putDocument(record.id, input.html, principal)) });
      });

      app.delete("/api/v1/records/:id/document", async c => {
        (await store.deleteDocument((await documentWriter(c.req.raw, c.req.param("id"))).record.id));
        return c.body(null, 204);
      });
  }

    app.post("/api/v1/records", async c => {
      const principal = (await auth.authenticate(c.req.raw, publicOnly));
      if (principal.source === "manual") (await auth.csrf(c.req.raw, origins));
      const input = createSchema.parse(await json(c.req.raw, RECORD_LIMITS.requestBytes));
      const result = (await store.create(principal, input.requestId, RecordInputSchema.parse(input.record), input.record));
      if (!result.replayed) (await newRecord(result.record, aiFillSources.has(principal.source), !c.req.header("origin")));
      if (!result.replayed && principal.source !== "manual") (await notifyReview(null, result.record));
      return c.json(result, result.replayed ? 200 : 201);
    });

    app.get("/api/v1/records/:id", async c => {
      const principal = (await auth.authenticate(c.req.raw, publicOnly));
      const record = (await store.get(c.req.param("id")));
      if (principal.source === "manual") return c.json({ record });
      // The public agent listener keeps reading to the agent's own records; the wider read scope stays on the private listener.
      const visible = publicOnly ? record.createdBy === principal.id : agentCanRead(principal, record);
      if (!visible) throw new ApiError(404, "not_found", "Record not found");
      return c.json({ record: agentView(principal, record) });
    });
}
