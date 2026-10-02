import { useMemo } from "react";
import { Plus } from "lucide-react";
import { RecordList } from "../components/RecordList";
import { Chip } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { blankRecord, lastActivity, projectStatuses, taskStatuses, viewRecords } from "../model";
import { useDashboard } from "../state";

const taskFilters = [
  { id: "all", label: "전체" },
  { id: "review", label: taskStatuses.review },
  { id: "active", label: taskStatuses.active },
  { id: "today", label: "오늘" },
  { id: "done", label: taskStatuses.done },
] as const;

const projectFilters = [
  { id: "all", label: "전체" },
  { id: "active", label: projectStatuses.active },
  { id: "idea", label: projectStatuses.idea },
  { id: "planning", label: projectStatuses.planning },
  { id: "paused", label: projectStatuses.paused },
  { id: "done", label: projectStatuses.done },
] as const;

export function WorkPane() {
  const { records, comments, route, setParams, editDraft } = useDashboard();
  const projects = route.params.show === "projects";
  const filter = projects ? route.params.status ?? "all" : route.params.filter ?? "all";
  const filters = projects ? projectFilters : taskFilters;
  // Newest activity first, so an item with a fresh report or comment rises to the top.
  const items = useMemo(() => viewRecords(records, projects ? "projects" : "tasks", filter)
    .map(record => ({ record, at: lastActivity(record, comments) }))
    .sort((left, right) => right.at.localeCompare(left.at))
    .map(({ record }) => record), [comments, filter, projects, records]);
  useListShortcuts(items);

  const pick = (value: string) => setParams(
    projects ? { status: value === "all" ? null : value } : { filter: value === "all" ? null : value },
    { replace: true },
  );

  return <>
    <header className="pane-head work-head">
      <div className="pane-title-row">
        <h1 className="pane-title">{projects ? "프로젝트" : "할 일"} <span className="count">{items.length}</span></h1>
        <button type="button" className="btn btn-primary work-create" onClick={() => editDraft(blankRecord(projects ? "project" : "task"))}>
          <Plus size={16} aria-hidden="true" />{projects ? "새 프로젝트" : "새 할 일"}
        </button>
      </div>
      <div className="pane-toolbar">
        <div className="chip-row" role="group" aria-label={projects ? "프로젝트 상태" : "할 일 필터"}>
          {filters.map(option =>
            <Chip key={option.id} selected={filter === option.id}
              count={viewRecords(records, projects ? "projects" : "tasks", option.id).length}
              onClick={() => pick(option.id)}>
              {option.label}
            </Chip>)}
          <Chip selected={projects}
            count={viewRecords(records, "projects", "all").length}
            onClick={() => setParams({ show: projects ? null : "projects" }, { replace: true })}>
            프로젝트
          </Chip>
        </div>
      </div>
    </header>
    <RecordList records={items} empty={projects ? "프로젝트 없음" : "할 일 없음"} />
  </>;
}
