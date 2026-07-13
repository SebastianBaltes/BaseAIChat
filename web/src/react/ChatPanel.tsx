/**
 * ChatPanel.tsx – the drop-in chat window.
 *
 * A floating launcher, a resizable panel, streamed markdown, image attachments,
 * and – the part that matters for an agent that touches the app – a visible
 * record of every piece of code it ran. Hiding the tool activity would leave
 * the user watching their own UI change with no idea why.
 *
 * Everything about the panel is presentational; the conversation itself lives
 * in useChatAgent. If this component does not fit your product, replace it and
 * keep the hook.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useChatAgent, type ChatAgentOptions } from "./useChatAgent";
import type { ChatMessage } from "./chatSession";
import "./ChatPanel.css";

marked.setOptions({ breaks: true, gfm: true });

export interface Suggestion {
  /** Shown on the chip. */
  label: string;
  /** Sent to the agent when clicked. Defaults to the label. */
  prompt?: string;
}

export interface ChatPanelProps {
  /** Passed straight through to useChatAgent. */
  agent: ChatAgentOptions;
  title?: string;
  /** Label of the floating launcher button. */
  launcherLabel?: string;
  /** Shown before the first message. */
  greeting?: string;
  placeholder?: string;
  /** One-click starter prompts. */
  suggestions?: Suggestion[];
  /** Start with the panel open (default false). */
  defaultOpen?: boolean;
  /** Let the user attach screenshots (default true). Needs a vision model. */
  allowImages?: boolean;
  /** Show the code the agent ran (default true). */
  showToolActivity?: boolean;
  /** Initial panel size in pixels. */
  defaultSize?: { width: number; height: number };
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 360;

export function ChatPanel({
  agent,
  title = "Assistant",
  launcherLabel = "Ask",
  greeting = "Ask me about this screen, or tell me what to change.",
  placeholder = "Ask a question or describe a goal…",
  suggestions = [],
  defaultOpen = false,
  allowImages = true,
  showToolActivity = true,
  defaultSize = { width: 420, height: 560 },
}: ChatPanelProps) {
  const { messages, busy, error, send, cancel, clear } = useChatAgent(agent);

  const [open, setOpen] = useState(defaultOpen);
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<string | null>(null);
  const [size, setSize] = useState(defaultSize);

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resizeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  const visible = useMemo(
    () => (showToolActivity ? messages : messages.filter((message) => message.role !== "tool")),
    [messages, showToolActivity]
  );

  // Follow the newest content while the answer streams in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [visible, busy]);

  const submit = useCallback(() => {
    if (busy) return;
    const text = draft.trim();
    if (!text && !attachment) return;
    setDraft("");
    setAttachment(null);
    void send(text, attachment ?? undefined);
  }, [busy, draft, attachment, send]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const onAttach = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // let the same file be picked twice in a row
    if (!file?.type.startsWith("image/")) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setAttachment(reader.result);
    };
    reader.readAsDataURL(file);
  };

  // Resizing from the top-left corner: the panel is anchored bottom-right, so
  // dragging up and left grows it.
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { x: event.clientX, y: event.clientY, ...size };
  };

  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    setSize({
      width: clamp(start.width + (start.x - event.clientX), MIN_WIDTH, window.innerWidth - 32),
      height: clamp(start.height + (start.y - event.clientY), MIN_HEIGHT, window.innerHeight - 32),
    });
  };

  const onResizeEnd = () => {
    resizeRef.current = null;
  };

  if (!open) {
    return (
      <button type="button" className="bac-launcher" onClick={() => setOpen(true)}>
        {launcherLabel}
      </button>
    );
  }

  return (
    <section
      className="bac-panel"
      role="dialog"
      aria-label={title}
      style={{ width: size.width, height: size.height }}
    >
      <div
        className="bac-resize"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        aria-hidden="true"
      />

      <header className="bac-header">
        <h2>{title}</h2>
        <div className="bac-header-actions">
          <button type="button" onClick={clear} title="Clear conversation" aria-label="Clear conversation">
            ⟲
          </button>
          <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close chat">
            ✕
          </button>
        </div>
      </header>

      <div className="bac-messages" ref={listRef}>
        {messages.length === 0 && greeting && <div className="bac-greeting">{greeting}</div>}

        {visible.map((message) => (
          <Message key={message.id} message={message} />
        ))}

        {busy && !hasStreamingText(messages) && (
          <div className="bac-typing" aria-label="Thinking">
            <span />
            <span />
            <span />
          </div>
        )}

        {error && <div className="bac-banner">{error}</div>}
      </div>

      {suggestions.length > 0 && messages.length === 0 && (
        <div className="bac-suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => void send(suggestion.prompt ?? suggestion.label)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}

      <form className="bac-composer" onSubmit={onSubmit}>
        {attachment && (
          <div className="bac-attachment">
            <img src={attachment} alt="Attachment" />
            <button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment">
              ✕
            </button>
          </div>
        )}

        <textarea
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />

        <div className="bac-controls">
          {allowImages ? (
            <>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAttach} />
              <button
                type="button"
                className="bac-icon"
                onClick={() => fileRef.current?.click()}
                aria-label="Attach a screenshot"
              >
                🖼
              </button>
            </>
          ) : (
            <span />
          )}

          {busy ? (
            <button type="button" className="bac-icon bac-stop" onClick={cancel} aria-label="Stop">
              ■
            </button>
          ) : (
            <button type="submit" className="bac-send" aria-label="Send">
              ➤
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return <ToolActivity message={message} />;

  return (
    <div className={`bac-message bac-${message.role}`}>
      {message.image && <img className="bac-image" src={message.image} alt="Attachment" />}
      {message.role === "assistant" ? (
        <Markdown text={message.text} streaming={message.streaming} />
      ) : (
        message.text && <p>{message.text}</p>
      )}
    </div>
  );
}

/**
 * What the agent did, collapsed by default: the user needs to be able to audit
 * it, but the code is not the answer they asked for.
 */
function ToolActivity({ message }: { message: ChatMessage }) {
  const summary = message.failed ? "Ran code – failed" : "Ran code";

  return (
    <details className={`bac-tool${message.failed ? " bac-tool-failed" : ""}`}>
      <summary>{summary}</summary>
      <pre>
        <code>{message.code}</code>
      </pre>
      {message.result && <pre className="bac-tool-result">{truncate(message.result, 800)}</pre>}
    </details>
  );
}

/**
 * Model output is untrusted text: it is markdown-rendered for readability and
 * sanitised because a prompt-injected response could otherwise plant a script
 * tag or a javascript: link in the host app's DOM.
 */
function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  }, [text]);

  return (
    <div className={`bac-markdown${streaming ? " bac-streaming" : ""}`}>
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function hasStreamingText(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.streaming);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
