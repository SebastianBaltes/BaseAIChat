/**
 * baseaichat – a chat agent you can embed in an existing app.
 *
 * The agent runs in the browser, writes JavaScript against an API you define,
 * and can read and operate your UI. A Go proxy (see ../server) keeps the
 * provider API key out of the client.
 *
 * Minimal integration:
 *
 * ```tsx
 * const evaluate = createEvaluator({ api: { ...myApi, ...createUIActions(), readUIState } });
 *
 * <ChatPanel agent={{
 *   provider: "google",
 *   model: "gemini-3-flash-preview",
 *   proxyUrl: "/aichat",
 *   systemPrompt: [instructions, apiDescription],
 *   toolDescription: apiDescription,
 *   evaluate,
 *   appContext: () => JSON.stringify(readUIState()),
 * }} />
 * ```
 */

// The tool loop: guarded execution of model-written code.
export { createEvaluator } from "./core/evaluator";
export type { Evaluator, EvaluatorOptions } from "./core/evaluator";
export { guardCode, guardScript } from "./core/guard";
export type { GuardOptions, GuardResult, ScriptGuardOptions } from "./core/guard";

// Prompt building.
export { expandRuntimeTypes } from "./core/runtimeTypes";
export { roundValues } from "./core/roundValues";

// UI awareness: let the agent see and operate the app.
export { readUIState } from "./browser/uiState";
export type { UINode, UIStateOptions } from "./browser/uiState";
export { createUIActions } from "./browser/uiActions";
export type { UIActionOptions, UIActions } from "./browser/uiActions";

// Providers.
export { createModel } from "./providers/createModel";
export type { ModelOptions, ProviderName } from "./providers/createModel";

// React.
export { useChatAgent } from "./react/useChatAgent";
export type { ChatAgent, ChatAgentOptions } from "./react/useChatAgent";
export { ChatPanel } from "./react/ChatPanel";
export type { ChatPanelProps, Suggestion } from "./react/ChatPanel";
export { createChatSession } from "./react/chatSession";
export type { ChatMessage, ChatRole, ChatSession, ChatState, ChatStatus } from "./react/chatSession";
