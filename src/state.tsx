import { createContext, useContext } from "react";
import type { Comment, DigestPart, DashboardRecord, RecordInput, RecordKind, RecordPatch, TrashItem } from "../shared/contracts";
import type { DigestPage } from "./api";
import type { Back, Params, Route, View } from "./router";

export type ReviewState = DashboardRecord["reviewState"];
export type Destination = { readonly view: View; readonly id?: string | null; readonly params?: Params };

/** Everything a view needs: live records, the trash, the committed route, and every persisted action. */
export type Dashboard = {
  readonly records: readonly DashboardRecord[];
  readonly byId: ReadonlyMap<string, DashboardRecord>;
  /** Deleted records waiting for their purge date, most recently deleted first. */
  readonly trash: readonly TrashItem[];
  /** Timeline entries on tasks and projects (owner comments, agent reports and replies), oldest first. */
  readonly comments: readonly Comment[];
  readonly connected: boolean;
  /** The owner session's CSRF token for mutations made outside these actions (share, narration); empty while disconnected. */
  readonly csrfToken: string;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly route: Route;
  /** The current screen's back button (router.backOf), or null when it has none. */
  readonly back: Back | null;
  /** Follow `back`: history steps when it came from inside the app, else replace with the parent screen. */
  readonly goBack: () => void;
  readonly navigate: (to: Destination, options?: { readonly replace?: boolean }) => void;
  /** Merge params into the current route (null or "" removes a key). Keeps the view and selection. */
  readonly setParams: (params: Readonly<Record<string, string | null>>, options?: { readonly replace?: boolean }) => void;
  /** Select a record inside the current view, or clear the selection. */
  readonly select: (record: DashboardRecord | null) => void;
  /** Open an item (a record or a digest) inside the current view with the same history rules as select; `params` merge into the route. */
  readonly open: (id: string, params?: Readonly<Record<string, string | null>>) => void;
  /** The last two weeks of digest summaries and the unread total, or null before they load. */
  readonly digests: DigestPage | null;
  /** Read marks made since the digests last loaded (`<id>:<part>` -> that part's readAt), laid over every digest list. */
  readonly digestReads: ReadonlyMap<string, string | null>;
  /** Mark one part (articles or messages) of a digest read or unread; `quiet` skips the toast (opening an unread digest). */
  readonly markDigest: (id: string, part: DigestPart, read: boolean, quiet?: boolean) => Promise<void>;
  /** Version-checked PATCH. Resolves to the saved record, or null after showing the error. */
  readonly patch: (record: DashboardRecord, changes: RecordPatch["changes"], message?: string) => Promise<DashboardRecord | null>;
  /** Material: pending -> approved (확인). Task: mark done. */
  readonly confirm: (record: DashboardRecord) => Promise<void>;
  /**
   * Opening a pending material record confirms it quietly: no busy state, no toast, only an error when the save fails.
   * A no-op for confirmed or rejected material, tasks, projects, and while the same record is already being marked.
   */
  readonly markRead: (record: DashboardRecord) => Promise<void>;
  /** Material: approved -> pending (미확인으로 표시), with 되돌리기. */
  readonly markPending: (record: DashboardRecord) => Promise<void>;
  /** Material: clear a due revisit date (다시 봤어요) without touching reviewState. */
  readonly clearRevisit: (record: DashboardRecord) => Promise<void>;
  readonly toggleStar: (record: DashboardRecord) => Promise<void>;
  /** Set the revisit date seven days from today. */
  readonly snooze: (record: DashboardRecord) => Promise<void>;
  readonly toggleArchive: (record: DashboardRecord) => Promise<void>;
  readonly revertAiFill: (record: DashboardRecord) => Promise<void>;
  /** Version-checked DELETE into the 30-day trash, no dialog; the reader moves to the next item in its list and the toast offers 되돌리기. */
  readonly remove: (record: DashboardRecord) => Promise<void>;
  /** Bring a trashed record back as it was deleted. */
  readonly restore: (item: TrashItem) => Promise<void>;
  /** Delete one trashed record for good after a confirm dialog. */
  readonly purge: (item: TrashItem) => Promise<void>;
  /** Delete everything in the trash for good after a confirm dialog. */
  readonly emptyTrash: () => Promise<void>;
  /** POST a new record (and set its review state when it differs). Throws on failure. Navigates to it. */
  readonly create: (input: RecordInput, requestId: string, review?: ReviewState) => Promise<DashboardRecord>;
  /** PATCH every editable property of an existing record. Throws on failure. */
  readonly update: (record: DashboardRecord, input: RecordInput, review?: ReviewState) => Promise<DashboardRecord>;
  readonly compose: (kind?: RecordKind) => void;
  readonly edit: (record: DashboardRecord) => void;
  /** Open the full editor for an unsaved draft (from compose or follow-up). */
  readonly editDraft: (input: RecordInput) => void;
  readonly share: (record: DashboardRecord) => void;
  /** Open the editor with a task whose evidence is this record. */
  readonly followUp: (record: DashboardRecord) => void;
  readonly refresh: () => Promise<void>;
  readonly requestLogin: () => void;
  readonly login: (token: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly importJson: (text: string) => Promise<DashboardRecord>;
  readonly notify: (message: string, tone?: "info" | "error") => void;
  /** Post the owner's comment on a task or project. Resolves true once saved; shows the error and resolves false otherwise. */
  readonly addComment: (record: DashboardRecord, body: string) => Promise<boolean>;
};

export const DashboardContext = createContext<Dashboard | null>(null);

export function useDashboard(): Dashboard {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside DashboardContext");
  return value;
}
