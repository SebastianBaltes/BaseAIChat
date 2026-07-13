/**
 * useChatAgent.ts – the agent loop, running in the browser.
 *
 * The model, the tool loop and the code execution all happen client-side; the
 * Go proxy only holds the API key. That is what makes the agent useful inside
 * an app: when it calls the evaluate tool, the generated code runs *here*, with
 * synchronous access to the live store and the real DOM. A server-side agent
 * would have to round-trip every read and every click.
 *
 * One turn:
 *   user message
 *     → history + a snapshot of the app's current state
 *       → model streams text and evaluate() calls
 *         → each call is guarded, executed, and its result fed back
 *           → repeat until the model stops or maxSteps is reached
 */
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { jsonSchema, stepCountIs, streamText, tool, type ModelMessage } from "ai";
import { createModel, type ProviderName } from "../providers/createModel";
import { createChatSession, type ChatMessage, type ChatSession } from "./chatSession";
import type { Evaluator } from "../core/evaluator";

export interface ChatAgentOptions {
  /** Which vendor the proxy is configured for (default "google"). */
  provider?: ProviderName;
  /** Model id. Must be permitted by the proxy's allowlist. */
  model: string;
  /** Used instead of `model` as soon as the conversation contains an image. */
  visionModel?: string;
  /** Path or URL of the proxy (default "/aichat"). */
  proxyUrl?: string;

  /**
   * The system prompt. Pass the pieces – instructions, API description, domain
   * knowledge – and they are joined with blank lines.
   */
  systemPrompt: string | string[];

  /**
   * What the evaluate tool can do, written for the model: the API's TypeScript
   * signatures plus a few worked examples. This is the most important string in
   * the whole integration – the model can only use what it reads here.
   */
  toolDescription: string;

  /** The executor from createEvaluator(). */
  evaluate: Evaluator;

  /**
   * A snapshot of what the app looks like right now, appended to each user
   * message. Typically JSON.stringify(readUIState()) plus your own state.
   */
  appContext?: () => string;

  /** Max model steps in one turn (default 20). Each evaluate() call is a step. */
  maxSteps?: number;

  /** Reuse a session to keep history across unmounts. Default: one per hook. */
  session?: ChatSession;

  /** Extra headers on every proxy request (auth cookies ride along anyway). */
  headers?: Record<string, string>;

  /** Sent as X-Title, which is how OpenRouter attributes traffic. */
  appTitle?: string;

  /** Called on transport/model failures – wire it to your error reporting. */
  onError?: (error: unknown) => void;
}

export interface ChatAgent {
  messages: ChatMessage[];
  /** True while a turn is running. */
  busy: boolean;
  error: string | null;
  /** Sends a message; `image` is a data URL. */
  send(text: string, image?: string): Promise<void>;
  /** Aborts the running turn. */
  cancel(): void;
  /** Clears the conversation. */
  clear(): void;
  session: ChatSession;
}

export function useChatAgent(options: ChatAgentOptions): ChatAgent {
  // Options arrive as a fresh object literal on every render, so `send` reads
  // them through a ref instead of depending on their identity – otherwise every
  // render would hand the panel a new send() and remount its handlers.
  const latest = useRef(options);
  latest.current = options;

  const fallbackSession = useMemo(() => createChatSession(), []);
  const session = options.session ?? fallbackSession;

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, image?: string) => {
      const current = latest.current;
      if (!text.trim() && !image) return;

      session.setError(null);
      session.setStatus("busy");
      session.add({ role: "user", text, image });

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        // The state snapshot rides with the newest user message rather than the
        // system prompt: it changes every turn, and the system prompt should
        // stay byte-identical so the provider can cache it.
        const history = withAppState(
          toModelMessages(session.getState().messages),
          readContext(current.appContext)
        );

        const hasImage = session.getState().messages.some((message) => message.image);
        const modelId = hasImage && current.visionModel ? current.visionModel : current.model;

        const result = streamText({
          model: createModel({
            provider: current.provider ?? "google",
            model: modelId,
            baseURL: current.proxyUrl ?? "/aichat",
            fetch: proxyFetch(current.proxyUrl ?? "/aichat", current.appTitle ?? "baseaichat", current.headers),
          }),
          messages: [systemMessage(current.systemPrompt), ...history],
          stopWhen: stepCountIs(current.maxSteps ?? 20),
          abortSignal: abort.signal,
          tools: {
            evaluate: tool({
              description: current.toolDescription,
              inputSchema: jsonSchema<{ code: string }>({
                type: "object",
                properties: {
                  code: {
                    type: "string",
                    description:
                      "JavaScript to run against the API. Use `return` to hand a value back. " +
                      "Only the documented API functions and standard built-ins are available.",
                  },
                },
                required: ["code"],
              }),
              execute: async ({ code }) => {
                try {
                  return await current.evaluate({ code });
                } catch (error) {
                  // Returned, not rethrown: the model reads this, fixes its code
                  // and tries again – which is the whole point of a tool loop.
                  return `Error: ${messageOf(error)}`;
                }
              },
            }),
          },
        });

        await consume(result.fullStream, session);
      } catch (error) {
        if (isAbort(error)) {
          session.add({ role: "assistant", text: "Cancelled." });
        } else {
          const text = messageOf(error);
          session.setError(text);
          session.add({ role: "error", text });
          current.onError?.(error);
        }
      } finally {
        abortRef.current = null;
        session.setStatus("idle");
      }
    },
    [session]
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const clear = useCallback(() => {
    abortRef.current?.abort();
    session.reset();
  }, [session]);

  return {
    messages: state.messages,
    busy: state.status === "busy",
    error: state.error,
    send,
    cancel,
    clear,
    session,
  };
}

// ── Stream handling ───────────────────────────────────────────────────────────

/**
 * Turns the model's event stream into chat messages. Text arrives token by
 * token; every evaluate() call shows up as its own message with the code and
 * the result, so the user can see exactly what the agent did to their app.
 */
async function consume(stream: AsyncIterable<any>, session: ChatSession): Promise<void> {
  const toolMessages = new Map<string, string>(); // toolCallId → message id
  const textMessages = new Set<string>();

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        session.appendText(part.id, part.text);
        textMessages.add(part.id);
        break;

      case "text-end":
        if (textMessages.has(part.id)) session.update(part.id, { streaming: false });
        break;

      case "tool-call":
        toolMessages.set(
          part.toolCallId,
          session.add({ role: "tool", text: "", code: String(part.input?.code ?? "") })
        );
        break;

      case "tool-result": {
        const id = toolMessages.get(part.toolCallId);
        const output = String(part.output ?? "");
        // The tool returns its own errors as text so the model can recover;
        // surface them as failures rather than as ordinary results.
        if (id) session.update(id, { result: output, failed: output.startsWith("Error:") });
        break;
      }

      case "tool-error": {
        const id = toolMessages.get(part.toolCallId);
        if (id) session.update(id, { result: messageOf(part.error), failed: true });
        break;
      }

      case "error":
        session.add({ role: "error", text: messageOf(part.error) });
        session.setError(messageOf(part.error));
        break;

      case "abort":
        session.add({ role: "assistant", text: "Cancelled." });
        break;
    }
  }

  // A turn that only ran tools and never spoke leaves the user staring at code.
  const messages = session.getState().messages;
  for (const id of textMessages) {
    session.update(id, { streaming: false });
  }
  const lastSpoken = [...messages].reverse().find((message) => message.role === "assistant");
  const lastTool = [...messages].reverse().find((message) => message.role === "tool");
  if (lastTool && (!lastSpoken || lastSpoken.createdAt < lastTool.createdAt)) {
    session.add({ role: "assistant", text: "Done." });
  }
}

// ── Message plumbing ──────────────────────────────────────────────────────────

function systemMessage(prompt: string | string[]): ModelMessage {
  return {
    role: "system",
    content: Array.isArray(prompt) ? prompt.join("\n\n") : prompt,
    // Anthropic charges a fraction for a cached prefix, and the system prompt –
    // instructions plus the full API description – is by far the largest part of
    // every request. Other providers ignore this field.
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };
}

/** Only user and assistant prose goes back to the model; tool chatter does not. */
function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      result.push(
        message.image
          ? {
              role: "user",
              content: [
                { type: "image", image: message.image },
                ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
              ],
            }
          : { role: "user", content: message.text }
      );
    } else if (message.role === "assistant" && message.text.trim()) {
      result.push({ role: "assistant", content: message.text });
    }
  }

  return result;
}

/** Attaches the app-state snapshot to the newest user message. */
function withAppState(history: ModelMessage[], context: string): ModelMessage[] {
  const last = history.at(-1);
  if (!context || last?.role !== "user") return history;

  const block = `\n\n<app-state>\n${context}\n</app-state>`;
  const content =
    typeof last.content === "string"
      ? last.content + block
      : [...last.content, { type: "text" as const, text: block }];

  return [...history.slice(0, -1), { role: "user", content }];
}

function readContext(appContext?: () => string): string {
  if (!appContext) return "";
  try {
    return appContext();
  } catch (error) {
    console.warn("[baseaichat] appContext() failed – continuing without it", error);
    return "";
  }
}

// ── Proxy transport ───────────────────────────────────────────────────────────

/**
 * Rewrites the SDK's provider-shaped URL into a call to our proxy.
 *
 * The SDK builds e.g. `<baseURL>/v1beta/models/x:streamGenerateContent`. We POST
 * everything to the proxy itself and pass the intended path in a header, so the
 * host app can mount the proxy at any route it likes.
 */
function proxyFetch(
  proxyUrl: string,
  appTitle: string,
  extraHeaders?: Record<string, string>
): typeof globalThis.fetch {
  return async (input, init) => {
    const base = new URL(proxyUrl, window.location.origin);
    const requested = new URL(String(input instanceof Request ? input.url : input), window.location.origin);

    const index = requested.pathname.indexOf(base.pathname);
    if (index < 0) return fetch(input, init);

    const targetPath = requested.pathname.slice(index + base.pathname.length);
    const endpoint = base.origin + base.pathname + requested.search;

    return fetch(endpoint, {
      ...init,
      // Cookie-based sessions in the host app must reach the proxy's Authorize hook.
      credentials: init?.credentials ?? "include",
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        "X-Target-Path": targetPath,
        // HTTP headers are latin-1 only; an app title with an em dash or an
        // umlaut would otherwise make fetch() throw before it ever leaves.
        "X-Title": appTitle.replace(/[^\x20-\x7E]/g, "_"),
        "HTTP-Referer": window.location.origin,
        ...csrfHeader(),
        ...extraHeaders,
      },
    });
  };
}

function csrfHeader(): Record<string, string> {
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  return token ? { "X-CSRF-Token": token } : {};
}

// ── Errors ────────────────────────────────────────────────────────────────────

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}
