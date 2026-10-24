import { z } from "zod";
import { NarrationAutoSchema, NarrationStatusSchema, NarrationStyleSchema } from "../shared/contracts";
import type { DashboardRecord, NarrationAuto } from "../shared/contracts";
import type { Store } from "./store";
import type { AudioStore } from "./audio-store";
import type { Jobs } from "./jobs";


/** One spoken turn of a podcast: host A explains, host B asks and sums up. */
export interface SpeechTurn { readonly speaker: "A" | "B"; readonly text: string }

/** A text-to-speech backend. Every method may cost money except `available`. */
export interface NarrationProvider {
  readonly ttsModel: string;
  readonly scriptModel: string;
  /** The ways to reach `scriptModel` (for example Vertex AI, then the key), tried in turn; one unnamed route when absent. */
  readonly scriptRoutes?: readonly string[];
  readonly voice: string;
  /** The voices of podcast hosts A and B. */
  readonly hosts: readonly [string, string];
  /** Whether a key is configured; checked before any paid call. */
  available(): Promise<boolean>;
  /** Writes the script with `scriptModel` through `route` (else the first), telling `onText` how many characters have arrived so far. */
  script(system: string, prompt: string, signal: AbortSignal, route?: string, onText?: (chars: number) => void): Promise<string>;
  /** Speaks one chunk as 24 kHz mono 16-bit little-endian PCM, in `voice` or else `voice` above. */
  speak(text: string, style: string, signal: AbortSignal, voice?: string): Promise<Uint8Array>;
  /** Speaks a run of podcast turns in one request, each in its host's voice (`hosts`, else `hosts` above), as the same PCM. */
  converse(turns: readonly SpeechTurn[], style: string, signal: AbortSignal, hosts?: readonly [string, string]): Promise<Uint8Array>;
}

/**
 * A provider failure reduced to a code; `transient` failures (429, 5xx, network, timeout) are retried with backoff, waiting
 * `retryAfterMs` when the provider said how long. `quota_daily` (the day's free quota is used up) is final.
 */
export class ProviderError extends Error {
  constructor(readonly code: string, readonly transient: boolean, readonly retryAfterMs?: number) {
    super(code);
    this.name = "ProviderError";
  }
}

/** Turns the finished WAV into the stored file (for example AAC), or returns it unchanged. */
export type Encoder = (wavPath: string, signal: AbortSignal) => Promise<{ path: string; mime: string }>;

/** Narratable content that is not a record (a digest part), shaped as a record, with its kind label and the API path its audio lives under. */
export interface NarrationSource { readonly record: DashboardRecord; readonly label: string; readonly audioBase: string }

export interface NarrationOptions {
  readonly audioStore?: AudioStore;
  readonly jobs?: Jobs;
  readonly requireKey?: () => Promise<void>;
  readonly store: Store;
  readonly lookup?: (id: string) => Promise<NarrationSource | null>;
  readonly globalDailyLimit?: number;
  readonly provider: NarrationProvider | null;
  readonly audioDir: string;
  readonly encode?: Encoder;
  readonly dailyLimit?: number;
  readonly strictDailyLimit?: boolean;
  /** The zone whose calendar day the daily limit counts in; defaults to UTC. */
  readonly timeZone?: string;
  readonly timeoutMs?: number;
  /** The first backoff wait; each retry doubles it (plus up to a quarter of jitter). 0 retries at once. */
  readonly retryDelayMs?: number;
  /** Waits between retries and chunks; resolves early when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** What Settings › Automatic audio starts with until the owner saves a choice; unset values are off and the full document. */
  readonly autoDefaults?: Partial<NarrationAuto>;
  /** Jobs run at the same time (different records; one record never runs twice at once). Default 1. */
  readonly concurrency?: number;
}

/** A running job: its controller, and the wait, step start and script try the owner sees. */
export interface Job { readonly id: string; readonly controller: AbortController; readonly lease?: string;
  waitUntil: number | null; stepAt: number | null; scriptTry: number | null }

/** The owner stopped this job; nothing more is paid for and the row was already settled by `cancel`. */
export class Cancelled extends Error {
  constructor() { super("cancelled"); this.name = "Cancelled"; }
}

export const rowSchema = z.object({
  record_id: z.string(), status: NarrationStatusSchema, job_hash: z.string(), requested_by: z.string(),
  requested_at: z.string(), updated_at: z.string(), attempts: z.number().int(), error: z.string().nullable(),
  progress_done: z.number().int().nullable(), progress_total: z.number().int().nullable(),
  script: z.string().nullable(), script_hash: z.string().nullable(),
  audio_file: z.string().nullable(), audio_hash: z.string().nullable(), audio_mime: z.string().nullable(),
  audio_bytes: z.number().int().nullable(), audio_ms: z.number().int().nullable(),
  audio_model: z.string().nullable(), audio_voice: z.string().nullable(), audio_at: z.string().nullable(),
  style: NarrationStyleSchema, script_style: NarrationStyleSchema, audio_style: NarrationStyleSchema,
  scope: NarrationAutoSchema.shape.scope, audio_scope: NarrationAutoSchema.shape.scope,
});

export type Row = z.infer<typeof rowSchema>;

export type Changes = Partial<Omit<Row, "record_id" | "updated_at">>;
