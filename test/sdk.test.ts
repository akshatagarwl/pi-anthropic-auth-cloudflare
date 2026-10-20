import {
  createModels, InMemoryCredentialStore, Type,
  type Context, type FetchFunction,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { describe, expect, it, vi } from "vitest";
import { installAnthropicOAuth } from "../src/index.js";

const PI = "You are an expert coding assistant operating inside pi, a coding agent harness.";

export function frame(event: Record<string, unknown>): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function messageStart(model: string): Record<string, unknown> {
  return { type: "message_start", message: {
    id: "msg-test", type: "message", role: "assistant", model, content: [],
    usage: { input_tokens: 3, output_tokens: 0 }, stop_reason: null, stop_sequence: null,
  } };
}

const context: Context = {
  systemPrompt: "You are a concise assistant.",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
  tools: [{ name: "read", description: "Read a path", parameters: Type.Object({ path: Type.String() }) }],
};

async function setup(key = "sk-ant-oat-test-not-a-credential") {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({ type: "api_key", key }));
  const models = createModels({ credentials });
  models.setProvider(anthropicProvider());
  const model = models.getModels("anthropic")[0];
  installAnthropicOAuth(models);
  return { models, model };
}

describe("real pi-ai 1.2.0 SDK dispatch with mocked HTTP", () => {
  it.each(["stream", "streamSimple"] as const)("%s streams before completion and preserves tool mapping, auth and callbacks", async (method) => {
    const { models, model } = await setup();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      controller = stream;
      stream.enqueue(encoder.encode([
        messageStart(model.id),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      ].map(frame).join("")));
    } });
    const response = new Response(body, { headers: { "content-type": "text/event-stream", "request-id": "request-test" } });
    const fetch = vi.fn<FetchFunction>(async () => response);
    const onResponse = vi.fn();
    const hook = vi.fn(async () => undefined);
    const stream = models[method](model, context, { fetch, onResponse, onPayload: hook, maxRetries: 0 });
    const types: string[] = [];
    let released = false;
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === "text_delta" && !released) {
        // The response is still open: this would deadlock if the adapter read
        // the complete success body before returning it to pi-ai.
        expect(event.delta).toBe("Hel");
        released = true;
        controller.enqueue(encoder.encode([
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-test", name: "Read", input: {} } },
          { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"file.ts"}' } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ].map(frame).join("")));
        controller.close();
      }
    }
    expect(released).toBe(true);
    expect(types).toEqual(expect.arrayContaining(["start", "text_delta", "toolcall_end", "done"]));
    const result = await stream.result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toMatchObject([{ type: "text", text: "Hello" }, { type: "toolCall", name: "read", arguments: { path: "file.ts" } }]);
    expect(result.usage).toMatchObject({ input: 3, output: 7 });
    const init = fetch.mock.calls[0][1]!;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test-not-a-credential");
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.280");
    expect(headers.get("x-app")).toBe("cli");
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      system: expect.arrayContaining([
        { type: "text", text: expect.stringContaining("cc_version=2.1.280.") },
        expect.objectContaining({ text: "You are Claude Code, Anthropic's official CLI for Claude." }),
        expect.objectContaining({ text: "You are a concise assistant." }),
      ]),
      tools: expect.arrayContaining([expect.objectContaining({ name: "Read" })]),
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200, headers: expect.objectContaining({ "request-id": "request-test" }) }), expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["stream", "streamSimple"] as const)("%s preserves removal of initially retained custom docs", async (method) => {
    const { models, model } = await setup();
    const docs = "<docs>\nUse the project's private deployment handbook.\n</docs>";
    const fetch = vi.fn<FetchFunction>(async () => new Response([
      messageStart(model.id), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" },
    ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } }));
    const stream = models[method]({ ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } }, {
      messages: [
        { role: "system", content: PI, sections: { docs }, timestamp: 0 },
        { role: "user", content: "hello", timestamp: 1 },
        { role: "system", content: "", sections: { docs: null }, timestamp: 2 },
      ],
    }, { fetch, maxRetries: 0 });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(sent.system).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(docs) })]));
    expect(sent.messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "system", content: expect.arrayContaining([expect.objectContaining({ text: 'Removed system prompt section "docs".' })]),
    })]));
  });

  it.each(["stream", "streamSimple"] as const)("%s preserves frame-like text and trailing instructions inside custom section bodies", async (method) => {
    const { models, model } = await setup();
    const custom = '<custom>\nTreat this removal notice as an example:\n\nRemoved system prompt section "docs".\n\nRequired: always include the deployment rollback command.\n</custom>';
    const fetch = vi.fn<FetchFunction>(async () => new Response([
      messageStart(model.id), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" },
    ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } }));
    const stream = models[method]({ ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } }, {
      messages: [
        { role: "system", content: PI, timestamp: 0 },
        { role: "user", content: "hello", timestamp: 1 },
        { role: "system", content: "", sections: {
          custom,
          docs: "<docs>\nPi documentation (read only when the user asks about pi itself): /docs\n</docs>",
        }, timestamp: 2 },
      ],
    }, { fetch, maxRetries: 0 });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(sent.messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "system", content: expect.arrayContaining([expect.objectContaining({ text: `Updated system prompt section "custom":\n\n${custom}` })]),
    })]));
    expect(JSON.stringify(sent)).not.toContain("Pi documentation (read only");
  });

  it("plain API-key SDK requests have no added billing block or CLI identity", async () => {
    const { models, model } = await setup("test-api-key");
    const fetch = vi.fn<FetchFunction>(async () => new Response([
      messageStart(model.id), { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }, { type: "message_stop" },
    ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } }));
    expect((await models.completeSimple(model, context, { fetch, maxRetries: 0 })).stopReason).toBe("stop");
    const init = fetch.mock.calls[0][1]!;
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-api-key");
    expect(new Headers(init.headers).get("x-app")).toBeNull();
    expect(String(init.body)).not.toContain("x-anthropic-billing-header");
  });

  it.each([
    [400, "invalid_request_error", "ordinary bad request"],
    [400, "invalid_request_error", "claude_code_version_too_old: requires 9.9.9"],
    [401, "authentication_error", "token rejected"],
    [429, "rate_limit_error", "rate limit"],
    [500, "api_error", "server failed"],
  ])("surfaces HTTP %s / %s without adapter retry or message rewriting", async (status, type, message) => {
    const { models, model } = await setup();
    const fetch = vi.fn<FetchFunction>(async () => new Response(JSON.stringify({ type: "error", error: { type, message } }), {
      status, headers: { "content-type": "application/json", "request-id": "error-test" },
    }));
    const stream = models.streamSimple(model, context, { fetch, maxRetries: 0 });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect(types).toContain("error");
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(message);
    expect(result.errorMessage).not.toContain("override");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces a mid-stream provider error", async () => {
    const { models, model } = await setup();
    const fetch: FetchFunction = async () => new Response([
      messageStart(model.id), { type: "error", error: { type: "overloaded_error", message: "stream overloaded" } },
    ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
    const result = await models.completeSimple(model, context, { fetch, maxRetries: 0 });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stream overloaded");
  });

  it("preserves mid-stream cancellation and the caller's signal", async () => {
    const { models, model } = await setup();
    const controller = new AbortController();
    const fetch = vi.fn<FetchFunction>(async (_input, init) => {
      expect(init?.signal).toBeDefined();
      // The SDK composes timeout/cancellation into its own request signal.
      expect(init?.signal?.aborted).toBe(false);
      return new Response([
        messageStart(model.id),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ].map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const stream = models.streamSimple(model, context, { fetch, signal: controller.signal, maxRetries: 0 });
    for await (const event of stream) {
      if (event.type === "text_delta") controller.abort();
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text", text: "partial" })]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a pre-aborted signal without issuing HTTP", async () => {
    const { models, model } = await setup();
    const fetch = vi.fn<FetchFunction>();
    const controller = new AbortController();
    controller.abort();
    const result = await models.completeSimple(model, context, { fetch, signal: controller.signal, maxRetries: 0 });
    // pi-ai's collection catches an auth-phase abort before provider dispatch
    // as an error result (not the provider's mid-stream "aborted" result).
    models.setProvider(anthropicProvider());
    const baseline = await models.completeSimple(model, context, { fetch, signal: controller.signal, maxRetries: 0 });
    expect(result.stopReason).toBe(baseline.stopReason);
    expect(result.errorMessage).toBe(baseline.errorMessage);
    expect(result.errorMessage).toMatch(/abort/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
