import { useMemo } from "react";
import { Plus } from "lucide-react";
import { RecordList } from "../components/RecordList";
import { Chip } from "../components/primitives";
import { useListShortcuts } from "../hooks";
import { blankRecord, lastActivity, projectStatuses, taskStatuses, viewRecords } from "../model";
import { strings } from "../i18n";
import { useDashboard } from "../state";

const text = strings({
  en: {
    all: "All", today: "Today", projects: "Projects", tasks: "Tasks",
    newProject: "New project", newTask: "New task",
    projectStatus: "Project status", taskFilter: "Task filter",
    noProjects: "No projects", noTasks: "No tasks",
  },
  ko: {
    all: "전체", today: "오늘", projects: "프로젝트", tasks: "할 일",
    newProject: "새 프로젝트", newTask: "새 할 일",
    projectStatus: "프로젝트 상태", taskFilter: "할 일 필터",
    noProjects: "프로젝트 없음", noTasks: "할 일 없음",
  },
});

const taskFilters = () => [
  { id: "all", label: text().all },
  { id: "review", label: taskStatuses.review },
  { id: "active", label: taskStatuses.active },
  { id: "today", label: text().today },
  { id: "done", label: taskStatuses.done },
] as const;

const projectFilters = () => [
  { id: "all", label: text().all },
  { id: "active", label: projectStatuses.active },
  { id: "idea", label: projectStatuses.idea },
  { id: "planning", label: projectStatuses.planning },
  { id: "paused", label: projectStatuses.paused },
  { id: "done", label: projectStatuses.done },
] as const;

export function WorkPane() {
  const t = text();
  const { records, comments, route, setParams, editDraft } = useDashboard();
  const projects = route.params.show === "projects";
  const filter = projects ? route.params.status ?? "all" : route.params.filter ?? "all";
  const filters = projects ? projectFilters() : taskFilters();
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
        <h1 className="pane-title">{projects ? t.projects : t.tasks} <span className="count">{items.length}</span></h1>
        <button type="button" className="btn btn-primary work-create" onClick={() => editDraft(blankRecord(projects ? "project" : "task"))}>
          <Plus size={16} aria-hidden="true" />{projects ? t.newProject : t.newTask}
        </button>
      </div>
      <div className="pane-toolbar">
        <div className="chip-row" role="group" aria-label={projects ? t.projectStatus : t.taskFilter}>
          {filters.map(option =>
            <Chip key={option.id} selected={filter === option.id}
              count={viewRecords(records, projects ? "projects" : "tasks", option.id).length}
              onClick={() => pick(option.id)}>
              {option.label}
            </Chip>)}
          <Chip selected={projects}
            count={viewRecords(records, "projects", "all").length}
            onClick={() => setParams({ show: projects ? null : "projects" }, { replace: true })}>
            {t.projects}
          </Chip>
        </div>
      </div>
    </header>
    <RecordList records={items} empty={projects ? t.noProjects : t.noTasks} />
  </>;
}
