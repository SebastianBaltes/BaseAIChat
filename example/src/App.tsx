/**
 * App.tsx – an ordinary React app that happens to have an agent in it.
 *
 * The only chat-specific thing here is the `data-*` annotations on the controls
 * and the <ChatPanel> at the bottom. The board itself neither knows nor cares
 * that an agent is driving it.
 */
import { useMemo, useState } from "react";
import { ChatPanel } from "baseaichat";
import { ASSIGNEES, board, STATUSES, useBoard, type Assignee, type Status } from "./board";
import { agentOptions } from "./agent/setup";
import "./App.css";

export function App() {
  const tasks = useBoard();
  const [filter, setFilter] = useState<Status | "all">("all");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState<Assignee>("unassigned");

  const visible = useMemo(
    () => (filter === "all" ? tasks : tasks.filter((task) => task.status === filter)),
    [tasks, filter]
  );

  const days = visible.reduce((sum, task) => sum + task.estimate, 0);

  const addTask = () => {
    if (!title.trim()) return;
    board.add({ title, assignee });
    setTitle("");
  };

  return (
    <main className="app">
      <header className="app-header">
        <h1>Sprint Board</h1>
        <p>
          Ask the assistant to plan, reassign or clean up the board — or to operate the
          filters for you.
        </p>
      </header>

      {/* data-group-key nests everything below it in what the agent sees. */}
      <section className="panel" data-group-key="filters">
        <label className="field">
          <span>Status</span>
          {/* data-select-key + data-value: the agent reads the current choice and can change it. */}
          <select
            data-select-key="filter-status"
            data-value={filter}
            value={filter}
            onChange={(event) => setFilter(event.target.value as Status | "all")}
          >
            <option value="all">all</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>

        <span className="summary" data-info-key="board-summary">
          {visible.length} tasks · {days} days
        </span>
      </section>

      <section className="panel" data-group-key="new-task">
        <label className="field grow">
          <span>Title</span>
          {/* data-input-key: fillInput() types here, and React sees a real change event. */}
          <input
            data-input-key="new-task-title"
            value={title}
            placeholder="What needs doing?"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addTask()}
          />
        </label>

        <label className="field">
          <span>Assignee</span>
          <select
            data-select-key="new-task-assignee"
            data-value={assignee}
            value={assignee}
            onChange={(event) => setAssignee(event.target.value as Assignee)}
          >
            {ASSIGNEES.map((person) => (
              <option key={person} value={person}>
                {person}
              </option>
            ))}
          </select>
        </label>

        {/* data-button-key: clickElement() presses this. */}
        <button data-button-key="add-task" onClick={addTask}>
          Add task
        </button>
      </section>

      <section className="board" data-group-key="board">
        {STATUSES.map((status) => (
          <div key={status} className="column" data-group-key={`column-${status}`}>
            <h2>
              {status}
              <span>{visible.filter((task) => task.status === status).length}</span>
            </h2>

            {visible
              .filter((task) => task.status === status)
              .map((task) => (
                <article key={task.id} className="card" data-info-key={`task-${task.id}`}>
                  <h3>{task.title}</h3>
                  <p>
                    <span className="tag">{task.assignee}</span>
                    <span className="tag">{task.estimate} d</span>
                  </p>
                  <button
                    className="link"
                    data-button-key={`delete-${task.id}`}
                    onClick={() => board.remove(task.id)}
                  >
                    delete
                  </button>
                </article>
              ))}

            {visible.filter((task) => task.status === status).length === 0 && (
              <p className="empty">nothing here</p>
            )}
          </div>
        ))}
      </section>

      <ChatPanel
        // Rebuilt each render so the model sees the board as it is now.
        agent={agentOptions()}
        title="Board assistant"
        launcherLabel="Ask the board"
        greeting="I can read the board and change it. Try one of these:"
        suggestions={[
          { label: "How much work is left?" },
          { label: "Assign the unclaimed todos to ada" },
          { label: "Move everything in review to done" },
          { label: "Show me only the done tasks", prompt: "Filter the board to done tasks" },
        ]}
      />
    </main>
  );
}
