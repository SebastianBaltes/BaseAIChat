/**
 * chatSession.ts – the conversation, kept outside React.
 *
 * The chat has to survive the panel being closed and re-opened, and in an SPA
 * it has to survive route changes that unmount the component. So the messages
 * live in a plain store and the component subscribes to it.
 *
 * A session is an explicit object rather than a module-level singleton: two
 * chats on one page (or a test suite running cases in parallel) each get their
 * own, and none of them can bleed into the next.
 */

export type ChatRole = "user" | "assistant" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Assistant/user prose, or the error text. */
  text: string;
  /** Data URL of an image the user attached. */
  image?: string;
  /** For tool messages: the code the model wrote. */
  code?: string;
  /** For tool messages: what came back. */
  result?: string;
  /** The tool call ended in an error the model then had to work around. */
  failed?: boolean;
  /** Still being streamed – the panel renders a caret. */
  streaming?: boolean;
  createdAt: number;
}

export type ChatStatus = "idle" | "busy";

export interface ChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  /** Last transport/model error, shown as a banner. */
  error: string | null;
}

export interface ChatSession {
  getState(): ChatState;
  subscribe(listener: () => void): () => void;
  setStatus(status: ChatStatus): void;
  setError(error: string | null): void;
  /** Appends a message and returns its id. */
  add(message: Omit<ChatMessage, "id" | "createdAt"> & { id?: string }): string;
  /** Patches an existing message; unknown ids are ignored. */
  update(id: string, patch: Partial<Omit<ChatMessage, "id">>): void;
  /** Appends text to a message, creating it if this is the first delta. */
  appendText(id: string, text: string, role?: ChatRole): void;
  reset(messages?: ChatMessage[]): void;
}

const EMPTY: ChatState = { messages: [], status: "idle", error: null };

export function createChatSession(initialMessages: ChatMessage[] = []): ChatSession {
  let state: ChatState = { ...EMPTY, messages: initialMessages };
  const listeners = new Set<() => void>();
  let counter = 0;

  // Ids must be unique within a session even when several messages are created
  // in the same millisecond – a streamed turn creates many.
  const nextId = () => `m${Date.now().toString(36)}-${counter++}`;

  function commit(next: ChatState) {
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setStatus(status) {
      if (state.status !== status) commit({ ...state, status });
    },

    setError(error) {
      commit({ ...state, error });
    },

    add(message) {
      const id = message.id ?? nextId();
      commit({
        ...state,
        messages: [...state.messages, { createdAt: Date.now(), ...message, id }],
      });
      return id;
    },

    update(id, patch) {
      commit({
        ...state,
        messages: state.messages.map((message) =>
          message.id === id ? { ...message, ...patch } : message
        ),
      });
    },

    appendText(id, text, role = "assistant") {
      const existing = state.messages.find((message) => message.id === id);
      if (!existing) {
        commit({
          ...state,
          messages: [...state.messages, { id, role, text, streaming: true, createdAt: Date.now() }],
        });
        return;
      }
      commit({
        ...state,
        messages: state.messages.map((message) =>
          message.id === id ? { ...message, text: message.text + text } : message
        ),
      });
    },

    reset(messages = []) {
      commit({ ...EMPTY, messages });
    },
  };
}
