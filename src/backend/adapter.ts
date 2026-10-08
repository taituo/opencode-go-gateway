/**
 * Pi/OpenCode gateway backend.
 *
 * The gateway does not inject a system prompt. Chat Completions and Responses
 * requests are translated into Pi transcript/tool types, then routed through the
 * provided Models runtime (including the stacked OpenCode-Go router).
 */
import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Model,
  Models,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
  Tool,
} from "@earendil-works/pi-ai";
import type { GatewayBackend, GatewayModel } from "../gateway/types.js";
import {
  ResponsesStreamEncoder,
  toResponsesObject,
  type NormalizedResponseBlock,
} from "../gateway/responses-protocol.js";
import { recordUsage } from "../telemetry.js";
import { InMemoryContinuationStore, type ContinuationStore } from "../gateway/continuation-store.js";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface StoredResponseContext {
  context: Context;
  createdAt: number;
}

export class OpenCodeStackGatewayBackend implements GatewayBackend {
  readonly #continuations: ContinuationStore<StoredResponseContext>;
  readonly #continuationTtlMs: number;

  constructor(
    private readonly models: Models,
    private readonly options: { provider?: string; modelIds?: string[]; maxStoredResponses?: number; continuationStore?: ContinuationStore<StoredResponseContext>; continuationTtlMs?: number } = {},
  ) {
    this.#continuations = options.continuationStore ?? new InMemoryContinuationStore<StoredResponseContext>(Math.max(0, options.maxStoredResponses ?? 1_000));
    this.#continuationTtlMs = options.continuationTtlMs ?? 24 * 60 * 60 * 1000;
  }

  async listModels(): Promise<GatewayModel[]> {
    const provider = this.options.provider ?? "opencode-go";
    const allowed = this.options.modelIds ? new Set(this.options.modelIds) : undefined;
    return this.models.getModels(provider)
      .filter((model) => !allowed || allowed.has(model.id))
      .map((model) => ({ id: model.id, object: "model", owned_by: "opencode-stack" }));
  }

  async handle(request: Request, modelId: string): Promise<Response> {
    const provider = this.options.provider ?? "opencode-go";
    const model = this.models.getModel(provider, modelId);
    if (!model) return json({ error: { message: `Unknown ${provider} model '${modelId}'` } }, 404);
    const path = new URL(request.url).pathname;
    if (path === "/v1/chat/completions") return this.handleChat(request, model, modelId);
    if (path === "/v1/responses") return this.handleResponses(request, model, modelId);
    return json({ error: { message: `Unsupported path '${path}'` } }, 404);
  }

  private async handleChat(request: Request, model: Model<any>, requestedModel: string): Promise<Response> {
    const payload = await request.json() as ChatRequest;
    const context = toPiChatContext(payload, model);
    const sessionId = headerSessionId(request.headers) ?? cacheKey(payload.prompt_cache_key);
    const options = simpleOptions({
      sessionId,
      toolChoice: payload.tool_choice,
      maxTokens: payload.max_tokens ?? payload.max_completion_tokens,
      signal: request.signal,
    });
    if (payload.stream) return this.streamChat(model, context, requestedModel, options);
    const message = await this.models.completeSimple(model, context, options);
    recordUsage(model.id, message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return json({ error: { message: message.errorMessage ?? "Provider failed" } }, message.stopReason === "aborted" ? 499 : 502);
    }
    return json(toChatCompletion(message, requestedModel));
  }

  private async handleResponses(request: Request, model: Model<any>, requestedModel: string): Promise<Response> {
    const payload = await request.json() as ResponsesRequest;
    const tenantId = request.headers.get("x-synth-tenant") ?? undefined;
    const previousRecord = payload.previous_response_id ? await this.#continuations.getContinuation(payload.previous_response_id, tenantId) : undefined;
    const previous = previousRecord?.value;
    if (payload.previous_response_id && !previous) {
      return json({ error: { message: `Unknown previous_response_id '${payload.previous_response_id}'`, type: "invalid_request_error", param: "previous_response_id" } }, 404);
    }
    const context = toPiResponsesContext(payload, model, previous?.context);
    const sessionId = headerSessionId(request.headers) ?? cacheKey(payload.prompt_cache_key) ?? payload.metadata?.session_id;
    const options = simpleOptions({
      sessionId,
      toolChoice: payload.tool_choice,
      maxTokens: payload.max_output_tokens,
      reasoning: payload.reasoning?.effort,
      signal: request.signal,
    });
    if (payload.stream) return this.streamResponses(model, context, requestedModel, payload, options, tenantId);

    const message = await this.models.completeSimple(model, context, options);
    recordUsage(model.id, message);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return json({ error: { message: message.errorMessage ?? "Provider failed" } }, message.stopReason === "aborted" ? 499 : 502);
    }
    const id = message.responseId ?? `resp_${crypto.randomUUID()}`;
    if (payload.store !== false) await this.storeResponse(id, appendAssistant(context, message), tenantId);
    return json(toResponsesObject({
      id,
      model: requestedModel,
      createdAt: Math.floor(message.timestamp / 1000),
      blocks: responseBlocks(message),
      usage: responseUsage(message),
      status: message.stopReason === "length" ? "incomplete" : "completed",
      ...(message.stopReason === "length" ? { incompleteDetails: { reason: "max_output_tokens" } } : {}),
      previousResponseId: payload.previous_response_id ?? null,
      instructions: payload.instructions ?? null,
    }));
  }

  private streamChat(model: Model<any>, context: Context, requestedModel: string, options: SimpleStreamOptions): Response {
    const encoder = new TextEncoder();
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = this.models.streamSimple(model, context, options);
    // A disconnecting consumer closes the controller while the upstream loop
    // may still be in flight. Guard every enqueue/close/error so a torn-down
    // stream can never throw an uncaught ERR_INVALID_STATE (which killed the
    // gateway process).
    let alive = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (bytes: Uint8Array) => {
          if (!alive) return;
          try { controller.enqueue(bytes); } catch { alive = false; }
        };
        const finish = (fn: () => void) => {
          if (!alive) return;
          alive = false;
          try { fn(); } catch { /* consumer already tore down */ }
        };
        void (async () => {
          try {
            send(encoder.encode(sse({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })));
            for await (const event of stream) {
              if (!alive) return;
              if (event.type === "text_delta") {
                send(encoder.encode(sse({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] })));
              } else if (event.type === "toolcall_start") {
                const call = event.partial.content[event.contentIndex];
                if (call?.type === "toolCall") {
                  send(encoder.encode(sse({
                    id, object: "chat.completion.chunk", created, model: requestedModel,
                    choices: [{ index: 0, delta: { tool_calls: [{ index: event.contentIndex, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }, finish_reason: null }],
                  })));
                }
              } else if (event.type === "toolcall_delta") {
                send(encoder.encode(sse({
                  id, object: "chat.completion.chunk", created, model: requestedModel,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }] }, finish_reason: null }],
                })));
              } else if (event.type === "done") {
                recordUsage(model.id, event.message);
                send(encoder.encode(sse({ id, object: "chat.completion.chunk", created, model: requestedModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.message) }], usage: toChatUsage(event.message) })));
              } else if (event.type === "error") {
                send(encoder.encode(sse({ error: { message: event.error.errorMessage ?? "Provider failed" } })));
              }
            }
            send(encoder.encode("data: [DONE]\n\n"));
            finish(() => controller.close());
          } catch (error) {
            if (!alive) return;
            finish(() => controller.error(error));
          }
        })();
      },
      cancel() { alive = false; stream.abort(); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  private streamResponses(
    model: Model<any>,
    context: Context,
    requestedModel: string,
    payload: ResponsesRequest,
    options: SimpleStreamOptions,
    tenantId?: string,
  ): Response {
    const encoder = new TextEncoder();
    const wire = new ResponsesStreamEncoder(requestedModel);
    const stream = this.models.streamSimple(model, context, options);
    const owner = this;
    // Same disconnect guard as streamChat: never enqueue/close/error into a
    // torn-down controller (uncaught ERR_INVALID_STATE killed the process).
    let alive = true;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (frame: string) => {
          if (!alive) return;
          try { controller.enqueue(encoder.encode(frame)); } catch { alive = false; }
        };
        const finish = (fn: () => void) => {
          if (!alive) return;
          alive = false;
          try { fn(); } catch { /* consumer already tore down */ }
        };
        void (async () => {
          try {
            send(wire.created());
            send(wire.inProgress());
            for await (const event of stream) {
              if (!alive) return;
              if (event.type === "thinking_start") {
                for (const frame of wire.reasoningStart(event.contentIndex)) send(frame);
              } else if (event.type === "thinking_delta") {
                send(wire.reasoningDelta(event.contentIndex, event.delta));
              } else if (event.type === "thinking_end") {
                for (const frame of wire.reasoningDone(event.contentIndex, event.content)) send(frame);
              } else if (event.type === "text_start") {
                for (const frame of wire.textStart(event.contentIndex)) send(frame);
              } else if (event.type === "text_delta") {
                send(wire.textDelta(event.contentIndex, event.delta));
              } else if (event.type === "text_end") {
                for (const frame of wire.textDone(event.contentIndex, event.content)) send(frame);
              } else if (event.type === "toolcall_start") {
                const call = event.partial.content[event.contentIndex];
                if (call?.type === "toolCall") send(wire.functionStart(event.contentIndex, call.id, call.name));
              } else if (event.type === "toolcall_delta") {
                const call = event.partial.content[event.contentIndex];
                if (call?.type === "toolCall") send(wire.functionDelta(event.contentIndex, call.id, event.delta));
              } else if (event.type === "toolcall_end") {
                for (const frame of wire.functionDone(
                  event.contentIndex,
                  event.toolCall.id,
                  event.toolCall.name,
                  JSON.stringify(event.toolCall.arguments),
                )) send(frame);
              } else if (event.type === "done") {
                recordUsage(model.id, event.message);
                if (payload.store !== false) await owner.storeResponse(wire.responseId, appendAssistant(context, event.message), tenantId);
                const terminal = {
                  blocks: responseBlocks(event.message),
                  usage: responseUsage(event.message),
                  previousResponseId: payload.previous_response_id ?? null,
                  instructions: payload.instructions ?? null,
                };
                send(event.message.stopReason === "length"
                  ? wire.incomplete(terminal, "max_output_tokens")
                  : wire.completed(terminal));
              } else if (event.type === "error") {
                send(wire.failed(event.error.errorMessage ?? "Provider failed", event.reason));
              }
            }
            finish(() => controller.close());
          } catch (error) {
            if (!alive) return;
            try { send(wire.failed(error instanceof Error ? error.message : String(error))); } catch { /* torn down */ }
            finish(() => controller.close());
          }
        })();
      },
      cancel() { alive = false; stream.abort(); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }

  private async storeResponse(id: string, context: Context, tenantId?: string): Promise<void> {
    const now = Date.now();
    await this.#continuations.putContinuation({
      id,
      tenantId,
      value: { context: structuredClone(context), createdAt: now },
      createdAt: now,
      expiresAt: now + this.#continuationTtlMs,
    });
  }
}

interface ChatRequest {
  model: string;
  prompt_cache_key?: string;
  stream?: boolean;
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters?: JsonObject } }>;
  tool_choice?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface ResponsesRequest {
  model: string;
  prompt_cache_key?: string;
  stream?: boolean;
  store?: boolean;
  instructions?: string;
  input?: string | Array<Record<string, unknown>>;
  tools?: Array<{ type: "function"; name: string; description?: string; parameters?: JsonObject; strict?: boolean }>;
  tool_choice?: unknown;
  previous_response_id?: string;
  max_output_tokens?: number;
  reasoning?: { effort?: string };
  metadata?: { session_id?: string; [key: string]: unknown };
}

function toPiChatContext(request: ChatRequest, model: Model<any>): Context {
  const messages: Context["messages"] = [];
  let systemPrompt = "";
  for (const raw of request.messages ?? []) {
    const role = String(raw.role ?? "");
    if (role === "system" || role === "developer") {
      const text = contentText(raw.content);
      systemPrompt += `${systemPrompt ? "\n\n" : ""}${text}`;
    } else if (role === "user") {
      messages.push({ role: "user", content: userContent(raw.content), timestamp: Date.now() });
    } else if (role === "assistant") {
      messages.push(chatAssistant(raw, model));
    } else if (role === "tool") {
      messages.push({
        role: "toolResult",
        toolCallId: String(raw.tool_call_id ?? ""),
        toolName: String(raw.name ?? "tool"),
        content: [{ type: "text", text: contentText(raw.content) }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }
  const tools: Tool[] | undefined = request.tools?.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as any,
  }));
  return { systemPrompt: systemPrompt || undefined, messages, tools };
}

function toPiResponsesContext(request: ResponsesRequest, model: Model<any>, previous?: Context): Context {
  const context: Context = previous ? structuredClone(previous) : { messages: [] };
  // previous_response_id carries conversational items, but previous instructions
  // are not inherited. A new request may supply fresh instructions instead.
  context.systemPrompt = request.instructions || undefined;
  if (typeof request.input === "string") {
    context.messages.push({ role: "user", content: request.input, timestamp: Date.now() });
  } else {
    for (const raw of request.input ?? []) appendResponsesItem(context, raw, model);
  }
  if (request.tools) {
    context.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.parameters ?? { type: "object", properties: {} }) as any,
      ...(tool.strict === true ? { constrainedSampling: { type: "json_schema", strict: "require" as const } } : {}),
    }));
  }
  return context;
}

function appendResponsesItem(context: Context, raw: Record<string, unknown>, model: Model<any>): void {
  const type = String(raw.type ?? "");
  const role = String(raw.role ?? "");
  if (type === "function_call") {
    let args: JsonObject = {};
    try { args = JSON.parse(String(raw.arguments ?? "{}")) as JsonObject; } catch {}
    context.messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: String(raw.call_id ?? raw.id ?? crypto.randomUUID()), name: String(raw.name ?? "tool"), arguments: args }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    return;
  }
  if (type === "function_call_output") {
    context.messages.push({
      role: "toolResult",
      toolCallId: String(raw.call_id ?? ""),
      toolName: String(raw.name ?? "tool"),
      content: [{ type: "text", text: outputText(raw.output) }],
      isError: false,
      timestamp: Date.now(),
    });
    return;
  }
  if (role === "system" || role === "developer") {
    const text = contentText(raw.content);
    context.systemPrompt = [context.systemPrompt, text].filter(Boolean).join("\n\n");
    return;
  }
  if (role === "user") {
    context.messages.push({ role: "user", content: userContent(raw.content), timestamp: Date.now() });
    return;
  }
  if (role === "assistant" || type === "message") {
    context.messages.push({
      role: "assistant",
      content: [{ type: "text", text: contentText(raw.content) }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: ZERO_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
}

function chatAssistant(raw: Record<string, unknown>, model: Model<any>): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  const text = contentText(raw.content);
  if (text) content.push({ type: "text", text });
  const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls as Array<any> : [];
  for (const call of calls) {
    let args: JsonObject = {};
    try { args = JSON.parse(String(call?.function?.arguments ?? "{}")) as JsonObject; } catch {}
    content.push({ type: "toolCall", id: String(call.id ?? crypto.randomUUID()), name: String(call?.function?.name ?? "tool"), arguments: args });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: calls.length ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function appendAssistant(context: Context, message: AssistantMessage): Context {
  return { ...structuredClone(context), messages: [...context.messages.map((m) => structuredClone(m)), structuredClone(message)] };
}

function responseBlocks(message: AssistantMessage): NormalizedResponseBlock[] {
  return message.content.flatMap((item): NormalizedResponseBlock[] => {
    if (item.type === "text") return [{ type: "text", text: item.text }];
    if (item.type === "thinking") return item.thinking ? [{ type: "reasoning", summary: item.thinking }] : [];
    if (item.type === "toolCall") return [{ type: "function_call", id: item.id, name: item.name, arguments: JSON.stringify(item.arguments) }];
    return [];
  });
}

function toChatCompletion(message: AssistantMessage, requestedModel: string) {
  const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
  const toolCalls = message.content.filter((item) => item.type === "toolCall").map((item) => ({
    id: item.id,
    type: "function",
    function: { name: item.name, arguments: JSON.stringify(item.arguments) },
  }));
  return {
    id: message.responseId ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(message.timestamp / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason(message) }],
    usage: toChatUsage(message),
  };
}

function simpleOptions(input: { sessionId?: string; toolChoice?: unknown; maxTokens?: number; reasoning?: string; signal?: AbortSignal }): SimpleStreamOptions {
  const options: SimpleStreamOptions = {};
  if (input.signal) options.signal = input.signal;
  if (input.sessionId) options.sessionId = input.sessionId;
  if (input.toolChoice === "none") options.toolChoice = "none";
  else if (input.toolChoice !== undefined) options.toolChoice = "auto";
  if (typeof input.maxTokens === "number") options.maxTokens = input.maxTokens;
  if (isThinkingLevel(input.reasoning)) options.reasoning = input.reasoning;
  return options;
}

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function finishReason(message: AssistantMessage): string {
  if (message.stopReason === "toolUse") return "tool_calls";
  if (message.stopReason === "length") return "length";
  return "stop";
}

function toChatUsage(message: AssistantMessage) {
  return { prompt_tokens: message.usage.input, completion_tokens: message.usage.output, total_tokens: message.usage.totalTokens };
}

function responseUsage(message: AssistantMessage) {
  return {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    total_tokens: message.usage.totalTokens,
    input_tokens_details: { cached_tokens: message.usage.cacheRead },
    ...(message.usage.reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: message.usage.reasoning } }),
  };
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Image part of a Chat Completions ("image_url") or Responses ("input_image") content item, or undefined. */
function imagePart(record: Record<string, unknown>): ImageContent | string | undefined {
  if (record.type !== "image_url" && record.type !== "input_image") return undefined;
  const ref = record.image_url;
  const url = typeof ref === "string" ? ref : ref && typeof ref === "object" ? String((ref as Record<string, unknown>).url ?? "") : "";
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return "[image omitted: only base64 data: URLs are supported by this gateway]";
  const data = m[2] ?? "";
  if (data.length * 0.75 > MAX_IMAGE_BYTES) return "[image omitted: larger than 12 MB]";
  return { type: "image", data, mimeType: m[1] ?? "image/png" };
}

/** User message content: plain text stays a string; images are kept (not silently dropped) as Pi image parts. */
function userContent(value: unknown): string | (TextContent | ImageContent)[] {
  if (!Array.isArray(value)) return contentText(value);
  const parts: (TextContent | ImageContent)[] = [];
  let hasImage = false;
  for (const item of value) {
    if (item && typeof item === "object") {
      const img = imagePart(item as Record<string, unknown>);
      if (img !== undefined) {
        if (typeof img === "string") parts.push({ type: "text", text: img });
        else { parts.push(img); hasImage = true; }
        continue;
      }
    }
    const text = contentText([item]);
    if (text) parts.push({ type: "text", text });
  }
  return hasImage ? parts : contentText(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.type === "input_text" || record.type === "output_text") return String(record.text ?? "");
    return "";
  }).join("");
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  return contentText(value);
}

/** OpenAI's `prompt_cache_key` doubles as the conversation id for sticky account routing. */
export function cacheKey(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 256) : undefined;
}

export function headerSessionId(headers: Headers): string | undefined {
  return headers.get("x-synth-session") ?? headers.get("x-session-id") ?? headers.get("x-opencode-session") ?? undefined;
}

function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
