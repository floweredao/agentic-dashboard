import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  readonly details?: readonly { readonly path: readonly string[]; readonly message: string }[];
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message);
  }
}

/** Agent format rules contain field paths and fixed guidance, never record values. */
export class RecordFormatError extends ApiError {
  override readonly details: readonly { readonly path: readonly string[]; readonly message: string }[];
  constructor(issues: readonly string[], message: string) {
    super(400, "record_incomplete", `${message}: ${issues.join("; ")}`);
    this.details = issues.map(issue => {
      const separator = issue.indexOf(":");
      return { path: issue.slice(0, separator).split("."), message: issue.slice(separator + 1).trim() };
    });
  }
}
