// This file is a contract, and it binds in both directions.
//
// Downwards it is what the model reads: the file is imported with `?raw` and the
// text between the markers becomes the API description in the system prompt and
// the tool description. Upwards it is a type the implementation must satisfy –
// `setup.ts` annotates its api object with `AgentApi`, so `tsc` fails when a
// function here does not exist there, has a different signature, or exists there
// without being described here.
//
// That is the whole point of the shape: a signature in this file cannot be
// fiction. Describe a function that nobody implements and the build breaks –
// rather than the model dutifully calling it and the bug looking like a model
// error.
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
 * Everything you may call. The code runs inside a `with (api)` scope, so you
 * write the bare name: `listTasks()`, not `api.listTasks()`.
 */
interface AgentApi {
  /**
   * Every task on the board.
   *
   * The objects are copies: assigning to them changes nothing. Every change must
   * go through addTask / updateTask / removeTask, which is also what keeps the
   * board's validation and undo history intact.
   */
  listTasks(): Task[];

  /** Adds a task. Defaults: status "todo", assignee "unassigned", estimate 1. */
  addTask(input: {
    title: string;
    status?: Status;
    assignee?: Assignee;
    estimate?: number;
  }): Task;

  /** Changes the given fields of one task. Throws if the id does not exist. */
  updateTask(id: number, patch: Partial<Omit<Task, "id">>): Task;

  /** Deletes a task. */
  removeTask(id: number): { removed: number };

  /** The statuses and people the board accepts. */
  listStatuses(): Status[];
  listAssignees(): Assignee[];

  /**
   * What is on screen right now: the visible controls and their current values.
   * Call this before touching the UI – keys change as the user navigates.
   */
  readUIState(): unknown;

  /** Scrolls an element into view and flashes it, to show the user what you mean. */
  highlightElement(key: string): void;

  /** Clicks a button, e.g. clickElement("add-task"). */
  clickElement(key: string): void;

  /** Types into a field, e.g. fillInput("new-task-title", "Fix the build"). */
  fillInput(key: string, value: string | number): void;

  /** Picks an option in a select control, e.g. selectOption("filter-status", "done"). */
  selectOption(key: string, option: string): void;
}

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

// Below the marker: the compiler sees this, the model never does. `expandRuntimeTypes`
// trims everything outside @api-start/@api-end, which is what lets this file be a real
// module – with imports and exports – instead of a floating wall of text.
export type { AgentApi, Assignee, Status, Task };
