/**
 * createModel.ts – one model object, whichever vendor is behind it.
 *
 * Every provider package returns something that satisfies the AI SDK's
 * LanguageModel interface, so the rest of the library never branches on the
 * vendor. Switching from Gemini to Claude is a config change.
 *
 * The API key here is deliberately a dummy: the SDKs insist on one, but the
 * real credential is injected by the Go proxy. Nothing secret reaches the
 * browser.
 */
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type ProviderName = "google" | "openai" | "anthropic" | "openrouter";

export interface ModelOptions {
  provider: ProviderName;
  /** Model id, e.g. "gemini-3-flash-preview" or "anthropic/claude-sonnet-5". */
  model: string;
  /** Where the proxy lives, e.g. "/aichat". Used as the SDK's baseURL. */
  baseURL: string;
  /** Fetch wrapper that routes through the proxy and adds its headers. */
  fetch?: typeof globalThis.fetch;
}

export function createModel({ provider, model, baseURL, fetch }: ModelOptions): LanguageModel {
  const shared = { baseURL, apiKey: "proxy-injects-the-real-key", ...(fetch ? { fetch } : {}) };

  switch (provider) {
    case "anthropic":
      return createAnthropic(shared)(model);

    case "openai":
      // .chat() pins the Chat Completions shape. Plain openai() would use the
      // Responses API, which most OpenAI-compatible gateways do not implement.
      return createOpenAI(shared).chat(model);

    case "openrouter":
      return createOpenRouter(shared).chat(model);

    case "google":
      // The native Google provider, not the OpenAI-compatible endpoint: only
      // this one carries the thought signatures that Gemini's thinking models
      // need across multi-step tool calls. Without it, the second step of a
      // tool-calling turn fails.
      return createGoogleGenerativeAI(shared)(model);
  }
}
