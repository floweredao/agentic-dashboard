import type { DashboardRecord } from "../shared/contracts";
import type { Route } from "./router";
import type { Dashboard } from "./state";

const unexpected = (name: string) => () => { throw new Error(`${name} was not expected in this test`); };

export function fakeDashboard(records: readonly DashboardRecord[], route: Partial<Route> = {}, overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    records, byId: new Map(records.map(record => [record.id, record])), trash: [], comments: [],
    connected: true, csrfToken: "", loading: false, busy: false,
    route: { view: "inbox", id: null, params: {}, ...route }, back: null, goBack: () => {},
    navigate: () => {}, setParams: () => {}, select: () => {}, open: () => {}, notify: () => {},
    briefings: null, briefingReads: new Map(), markBriefing: unexpected("markBriefing"),
    patch: unexpected("patch"), confirm: unexpected("confirm"), markRead: unexpected("markRead"), markPending: unexpected("markPending"), clearRevisit: unexpected("clearRevisit"), toggleStar: unexpected("toggleStar"),
    snooze: unexpected("snooze"), toggleArchive: unexpected("toggleArchive"), revertAiFill: unexpected("revertAiFill"), remove: unexpected("remove"),
    restore: unexpected("restore"), purge: unexpected("purge"), emptyTrash: unexpected("emptyTrash"),
    create: unexpected("create"), update: unexpected("update"), compose: () => {}, edit: () => {},
    editDraft: () => {}, share: () => {}, followUp: () => {}, refresh: async () => {}, requestLogin: () => {},
    login: unexpected("login"), logout: unexpected("logout"), importJson: unexpected("importJson"), addComment: unexpected("addComment"),
    ...overrides,
  };
}
