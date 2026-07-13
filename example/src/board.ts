/**
 * board.ts – the demo app's domain. Nothing here knows about the chat.
 *
 * A plain observable store: the agent will drive the very same functions the
 * UI does, which is the point – the agent is another user, not a back door.
 */
import { useSyncExternalStore } from "react";

export const STATUSES = ["todo", "in-progress", "review", "done"] as const;
export type Status = (typeof STATUSES)[number];

export const ASSIGNEES = ["ada", "grace", "linus", "unassigned"] as const;
export type Assignee = (typeof ASSIGNEES)[number];

export interface Task {
  id: number;
  title: string;
  status: Status;
  assignee: Assignee;
  /** Estimate in days. */
  estimate: number;
}

let tasks: Task[] = [
  { id: 1, title: "Design the onboarding flow", status: "done", assignee: "ada", estimate: 2 },
  { id: 2, title: "Rate-limit the public API", status: "in-progress", assignee: "linus", estimate: 3 },
  { id: 3, title: "Fix flaky checkout test", status: "todo", assignee: "unassigned", estimate: 1 },
  { id: 4, title: "Write the release notes", status: "review", assignee: "grace", estimate: 0.5 },
  { id: 5, title: "Migrate the session store", status: "todo", assignee: "ada", estimate: 5 },
];

let nextId = 6;
const listeners = new Set<() => void>();

function commit(next: Task[]) {
  tasks = next;
  for (const listener of listeners) listener();
}

export const board = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  snapshot: () => tasks,

  list(): Task[] {
    return tasks.map((task) => ({ ...task }));
  },

  add(input: { title: string; status?: Status; assignee?: Assignee; estimate?: number }): Task {
    if (!input?.title?.trim()) throw new Error("A task needs a title.");
    const task: Task = {
      id: nextId++,
      title: input.title.trim(),
      status: input.status ?? "todo",
      assignee: input.assignee ?? "unassigned",
      estimate: input.estimate ?? 1,
    };
    commit([...tasks, task]);
    return { ...task };
  },

  update(id: number, patch: Partial<Omit<Task, "id">>): Task {
    const existing = tasks.find((task) => task.id === id);
    if (!existing) throw new Error(`No task with id ${id}. Call listTasks() first.`);

    if (patch.status && !STATUSES.includes(patch.status)) {
      throw new Error(`"${patch.status}" is not a status. Valid: ${STATUSES.join(", ")}.`);
    }
    if (patch.assignee && !ASSIGNEES.includes(patch.assignee)) {
      throw new Error(`"${patch.assignee}" is not on the team. Valid: ${ASSIGNEES.join(", ")}.`);
    }

    const updated = { ...existing, ...patch, id };
    commit(tasks.map((task) => (task.id === id ? updated : task)));
    return { ...updated };
  },

  remove(id: number): { removed: number } {
    if (!tasks.some((task) => task.id === id)) throw new Error(`No task with id ${id}.`);
    commit(tasks.filter((task) => task.id !== id));
    return { removed: id };
  },
};

export function useBoard(): Task[] {
  return useSyncExternalStore(board.subscribe, board.snapshot, board.snapshot);
}
