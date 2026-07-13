// This file is never executed. It is imported with `?raw` and shown to the
// model as the description of what it may call – so it is documentation whose
// signatures happen to be checked by the compiler.
//
// The `@values` comments are expanded against live app state before the model
// sees them, turning `string` into the exact set of values that exists right
// now. Add a status to the board and the model knows about it on the next turn.

// @api-start
// @values context.statuses
type Status = string;

// @values context.assignees
type Assignee = string;

interface Task {
  id: number;
  title: string;
  status: Status;
  assignee: Assignee;
  /** Estimate in days. */
  estimate: number;
}

/**
 * Every task on the board.
 *
 * The objects are copies: assigning to them changes nothing. Every change must
 * go through addTask / updateTask / removeTask, which is also what keeps the
 * board's validation and undo history intact.
 */
declare function listTasks(): Task[];

/** Adds a task. Defaults: status "todo", assignee "unassigned", estimate 1. */
declare function addTask(input: {
  title: string;
  status?: Status;
  assignee?: Assignee;
  estimate?: number;
}): Task;

/** Changes the given fields of one task. Throws if the id does not exist. */
declare function updateTask(id: number, patch: Partial<Omit<Task, "id">>): Task;

/** Deletes a task. */
declare function removeTask(id: number): { removed: number };

/** The statuses and people the board accepts. */
declare function listStatuses(): Status[];
declare function listAssignees(): Assignee[];

/**
 * What is on screen right now: the visible controls and their current values.
 * Call this before touching the UI – keys change as the user navigates.
 */
declare function readUIState(): unknown;

/** Scrolls an element into view and flashes it, to show the user what you mean. */
declare function highlightElement(key: string): void;

/** Clicks a button, e.g. clickElement("add-task"). */
declare function clickElement(key: string): void;

/** Types into a field, e.g. fillInput("new-task-title", "Fix the build"). */
declare function fillInput(key: string, value: string | number): void;

/** Picks an option in a select control, e.g. selectOption("filter-status", "done"). */
declare function selectOption(key: string, option: string): void;

// ── Examples ─────────────────────────────────────────────────────────────────
//
// Read and compute in one call – do not fetch the list and then ask the user:
//
//   const tasks = listTasks();
//   const open = tasks.filter((t) => t.status !== "done");
//   return { open: open.length, days: open.reduce((sum, t) => sum + t.estimate, 0) };
//
// Change several tasks at once:
//
//   for (const task of listTasks()) {
//     if (task.assignee === "unassigned" && task.status === "todo") {
//       updateTask(task.id, { assignee: "ada" });
//     }
//   }
//   return "assigned all unclaimed todos to ada";
//
// Operate the UI the way the user would, when they ask you to *use* the app:
//
//   selectOption("filter-status", "done");
//   return "filtered the board to completed work";
// @api-end

export {};
