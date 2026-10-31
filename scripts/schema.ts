import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AGENT_RECORD_GUIDE, AGENT_RECORD_RULES, AGENT_TAGS, AGENT_TEXT, ARTICLE_REACTIONS, ArticleReactionInputSchema,
  CommentInputSchema, CommentSchema, DashboardRecordSchema, DIGEST_LIMITS, DigestInputSchema, DigestSchema,
  DocumentInputSchema, MESSAGE_IMPORTANCE, NARRATABLE_KINDS, NARRATION_LIMITS, NarrationSchema, RECORD_LIMITS,
  ReactionItemSchema, RecordDocumentSchema, RecordInputSchema, TITLE_MAX_WIDTH,
} from "../shared/contracts";
import { mailSchema, newsSchema, xSchema } from "./briefing-convert";

export const SCHEMA_PATH = join(import.meta.dir, "..", "docs", "schema", "agentic-dashboard.schema.json");

/** Export the same boundaries used by the API and briefing-folder importer. */
export function storageSchema() {
  const json = (schema: z.ZodType, io: "input" | "output") => z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/floweredao/agentic-dashboard/docs/schema/agentic-dashboard.schema.json",
    title: "Agentic Dashboard storage contracts",
    $defs: {
      RecordInput: json(RecordInputSchema, "input"), Record: json(DashboardRecordSchema, "output"),
      Narration: json(NarrationSchema, "output"), RecordDocumentInput: json(DocumentInputSchema, "input"),
      RecordDocument: json(RecordDocumentSchema, "output"), CommentInput: json(CommentInputSchema, "input"),
      Comment: json(CommentSchema, "output"), DigestInput: json(DigestInputSchema, "input"), Digest: json(DigestSchema, "output"),
      ArticleReactionInput: json(ArticleReactionInputSchema, "input"), ArticleReaction: json(ReactionItemSchema, "output"),
      BriefingFolderNews: json(newsSchema, "input"), BriefingFolderMail: json(mailSchema, "input"), BriefingFolderX: json(xSchema, "input"),
    },
    "x-agentic-dashboard": {
      agentRecordRules: AGENT_RECORD_RULES, agentRecordGuide: AGENT_RECORD_GUIDE, agentTags: AGENT_TAGS, agentText: AGENT_TEXT,
      titleMaxWidth: TITLE_MAX_WIDTH, recordLimits: RECORD_LIMITS, narratableKinds: NARRATABLE_KINDS,
      narrationLimits: NARRATION_LIMITS, digestLimits: DIGEST_LIMITS, messageImportance: MESSAGE_IMPORTANCE,
      articleReactions: ARTICLE_REACTIONS,
    },
  };
}

export const schemaText = () => `${JSON.stringify(storageSchema(), null, 2)}\n`;

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    if (readFileSync(SCHEMA_PATH, "utf8") !== schemaText()) {
      console.error("Storage schema is out of date; run bun scripts/schema.ts");
      process.exit(1);
    }
    console.log("Storage schema is current");
  } else {
    writeFileSync(SCHEMA_PATH, schemaText());
    console.log(`Wrote ${SCHEMA_PATH}`);
  }
}
