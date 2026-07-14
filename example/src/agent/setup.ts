/**
 * setup.ts – everything the chat needs to know about this app.
 *
 * This is the whole integration surface: an API object, a system prompt, and a
 * snapshot function. The library supplies the rest.
 */
import {
  createEvaluator,
  createUIActions,
  expandRuntimeTypes,
  readUIState,
  roundValues,
  type ChatAgentOptions,
} from "baseaichat";
import apiSource from "./api.ts?raw";
import instructions from "./instructions.md?raw";
import type { AgentApi } from "./api";
import { ASSIGNEES, board, STATUSES } from "../board";

const ui = createUIActions();

/**
 * The API the model writes code against. Its keys are the only names the
 * generated code can reach – the guard rejects everything else.
 *
 * The `AgentApi` annotation is the load-bearing part: `api.ts` is not a
 * description *of* this object, it is a contract *over* it. Rename a function
 * here and the build fails; add one without describing it there and the excess
 * property check fails. The description the model reads and the code it reaches
 * cannot drift apart.
 *
 * That is also why the UI actions are listed one by one instead of spread in:
 * a spread slips past the excess property check, and then an undescribed
 * function could reach the model's scope unannounced.
 */
const api: AgentApi = {
  listTasks: () => board.list(),
  addTask: board.add,
  updateTask: board.update,
  removeTask: board.remove,
  listStatuses: () => [...STATUSES],
  listAssignees: () => [...ASSIGNEES],
  readUIState: () => readUIState({ context: () => ({ page: "board" }) }),
  highlightElement: ui.highlightElement,
  clickElement: ui.clickElement,
  selectOption: ui.selectOption,
  fillInput: ui.fillInput,
};

const evaluate = createEvaluator({
  api,
  // Estimates are halves and quarters; 0.30000000000000004 helps nobody.
  transformResult: (result) => roundValues(result, 2),
  onBeforeRun: (code) => console.debug("[agent] running:\n", code),
});

/**
 * Built fresh on every render so the model always sees the current options.
 * Cheap: it is string substitution, not a request.
 */
export function agentOptions(): ChatAgentOptions {
  const api = expandRuntimeTypes(apiSource, {
    statuses: STATUSES,
    assignees: ASSIGNEES,
  });

  return {
    provider: (import.meta.env.VITE_AI_PROVIDER as ChatAgentOptions["provider"]) ?? "google",
    model: import.meta.env.VITE_AI_MODEL ?? "gemini-3-flash-preview",
    visionModel: import.meta.env.VITE_AI_VISION_MODEL,
    proxyUrl: "/aichat",
    appTitle: "Sprint Board",

    // Instructions and API description go in the system prompt, so a provider
    // that supports prompt caching can charge a fraction for the stable part.
    systemPrompt: [instructions, "## API\n\n```ts\n" + api + "\n```"],
    toolDescription:
      "Runs JavaScript against the sprint board in the user's browser and returns " +
      "the value you `return`. Available API:\n\n```ts\n" +
      api +
      "\n```",
    evaluate,

    // Sent with every message: the model reasons about the live board and the
    // visible UI instead of asking the user to describe them.
    appContext: () =>
      JSON.stringify({
        tasks: board.list(),
        ui: readUIState(),
      }),
  };
}
