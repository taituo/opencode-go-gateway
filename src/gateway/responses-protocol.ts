export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export type NormalizedResponseBlock =
  | { type: "text"; text: string; id?: string }
  | { type: "reasoning"; summary: string; id?: string }
  | { type: "function_call"; id: string; name: string; arguments: string; itemId?: string };

export interface NormalizedResponseResult {
  id?: string;
  model: string;
  createdAt?: number;
  blocks: NormalizedResponseBlock[];
  usage?: ResponsesUsage;
  status?: "completed" | "incomplete" | "failed";
  error?: { code?: string; message: string };
  incompleteDetails?: { reason: string };
  previousResponseId?: string | null;
  instructions?: string | null;
}

export interface ResponsesObject {
  id: string;
  object: "response";
  created_at: number;
  completed_at?: number | null;
  status: "completed" | "incomplete" | "failed" | "in_progress";
  model: string;
  output: Array<Record<string, unknown>>;
  usage?: ResponsesUsage;
  error?: { code?: string; message: string } | null;
  incomplete_details?: { reason: string } | null;
  previous_response_id?: string | null;
  instructions?: string | null;
}

export function toResponsesObject(result: NormalizedResponseResult): ResponsesObject {
  const id = result.id ?? `resp_${crypto.randomUUID()}`;
  const created = result.createdAt ?? Math.floor(Date.now() / 1000);
  const status = result.status ?? "completed";
  return {
    id,
    object: "response",
    created_at: created,
    completed_at: status === "completed" ? Math.max(created, Math.floor(Date.now() / 1000)) : null,
    status,
    model: result.model,
    output: result.blocks.map((block, index) => {
      if (block.type === "text") {
        return {
          id: block.id ?? `msg_${id}_${index}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        };
      }
      if (block.type === "reasoning") {
        return {
          id: block.id ?? `rs_${id}_${index}`,
          type: "reasoning",
          summary: [{ type: "summary_text", text: block.summary }],
        };
      }
      return {
        id: block.itemId ?? `fc_${id}_${index}`,
        type: "function_call",
        status: "completed",
        call_id: block.id,
        name: block.name,
        arguments: block.arguments,
      };
    }),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.error ? { error: result.error } : { error: null }),
    incomplete_details: status === "incomplete" ? (result.incompleteDetails ?? { reason: "max_output_tokens" }) : null,
    previous_response_id: result.previousResponseId ?? null,
    instructions: result.instructions ?? null,
  };
}

/** Stateful encoder for the Responses streaming event families used by coding agents. */
export class ResponsesStreamEncoder {
  readonly responseId: string;
  readonly createdAt: number;
  #sequence = 0;

  constructor(readonly model: string, options: { responseId?: string; createdAt?: number } = {}) {
    this.responseId = options.responseId ?? `resp_${crypto.randomUUID()}`;
    this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);
  }

  created(): string {
    return this.event("response.created", {
      response: {
        id: this.responseId,
        object: "response",
        created_at: this.createdAt,
        status: "in_progress",
        model: this.model,
        output: [],
        error: null,
      },
    });
  }

  inProgress(): string {
    return this.event("response.in_progress", {
      response: {
        id: this.responseId,
        object: "response",
        created_at: this.createdAt,
        status: "in_progress",
        model: this.model,
        output: [],
        error: null,
      },
    });
  }

  textStart(outputIndex: number, itemId = `msg_${this.responseId}_${outputIndex}`): string[] {
    return [
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      }),
      this.event("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ];
  }

  textDelta(outputIndex: number, delta: string, itemId = `msg_${this.responseId}_${outputIndex}`): string {
    return this.event("response.output_text.delta", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta,
    });
  }

  textDone(outputIndex: number, text: string, itemId = `msg_${this.responseId}_${outputIndex}`): string[] {
    const part = { type: "output_text", text, annotations: [] };
    return [
      this.event("response.output_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      }),
      this.event("response.content_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part,
      }),
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [part] },
      }),
    ];
  }

  reasoningStart(outputIndex: number, itemId = `rs_${this.responseId}_${outputIndex}`): string[] {
    return [
      this.event("response.output_item.added", {
        output_index: outputIndex,
        item: { id: itemId, type: "reasoning", summary: [] },
      }),
      this.event("response.reasoning_summary_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    ];
  }

  reasoningDelta(outputIndex: number, delta: string, itemId = `rs_${this.responseId}_${outputIndex}`): string {
    return this.event("response.reasoning_summary_text.delta", {
      item_id: itemId,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    });
  }

  reasoningDone(outputIndex: number, text: string, itemId = `rs_${this.responseId}_${outputIndex}`): string[] {
    const part = { type: "summary_text", text };
    return [
      this.event("response.reasoning_summary_text.done", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        text,
      }),
      this.event("response.reasoning_summary_part.done", {
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part,
      }),
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: { id: itemId, type: "reasoning", summary: [part] },
      }),
    ];
  }

  functionStart(outputIndex: number, callId: string, name: string, itemId = `fc_${this.responseId}_${outputIndex}`): string {
    return this.event("response.output_item.added", {
      output_index: outputIndex,
      item: { id: itemId, type: "function_call", status: "in_progress", call_id: callId, name, arguments: "" },
    });
  }

  functionDelta(outputIndex: number, callId: string, delta: string, itemId = `fc_${this.responseId}_${outputIndex}`): string {
    return this.event("response.function_call_arguments.delta", {
      item_id: itemId,
      output_index: outputIndex,
      call_id: callId,
      delta,
    });
  }

  functionDone(outputIndex: number, callId: string, name: string, args: string, itemId = `fc_${this.responseId}_${outputIndex}`): string[] {
    return [
      this.event("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: outputIndex,
        call_id: callId,
        arguments: args,
      }),
      this.event("response.output_item.done", {
        output_index: outputIndex,
        item: { id: itemId, type: "function_call", status: "completed", call_id: callId, name, arguments: args },
      }),
    ];
  }

  completed(result: Omit<NormalizedResponseResult, "id" | "createdAt" | "model" | "status">): string {
    return this.event("response.completed", {
      response: toResponsesObject({ ...result, id: this.responseId, createdAt: this.createdAt, model: this.model, status: "completed" }),
    });
  }

  incomplete(result: Omit<NormalizedResponseResult, "id" | "createdAt" | "model" | "status">, reason = "max_output_tokens"): string {
    return this.event("response.incomplete", {
      response: toResponsesObject({
        ...result,
        id: this.responseId,
        createdAt: this.createdAt,
        model: this.model,
        status: "incomplete",
        incompleteDetails: { reason },
      }),
    });
  }

  failed(message: string, code = "upstream_error"): string {
    return this.event("response.failed", {
      response: toResponsesObject({
        id: this.responseId,
        createdAt: this.createdAt,
        model: this.model,
        blocks: [],
        status: "failed",
        error: { code, message },
      }),
    });
  }

  event(type: string, fields: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.#sequence++, ...fields })}\n\n`;
  }
}

export function parseResponsesInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const chunks: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (value.type === "input_text" || value.type === "output_text") {
      if (typeof value.text === "string") chunks.push(value.text);
      continue;
    }
    if (typeof value.text === "string") chunks.push(value.text);
    if (Array.isArray(value.content)) chunks.push(parseResponsesInputText(value.content));
  }
  return chunks.join("");
}
