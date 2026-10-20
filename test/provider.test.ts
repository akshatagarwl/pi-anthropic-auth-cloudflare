import {
  createAssistantMessageEventStream, createModels, InMemoryCredentialStore, normalizeContext,
  type FetchFunction, type Model, type Provider, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { describe, expect, it, vi } from "vitest";
import { installAnthropicOAuth, isAnthropicOAuthToken, wrapAnthropicProvider } from "../src/index.js";
import { billingHeader } from "../src/billing.js";

const model = anthropicProvider().getModels()[0];
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const rawPayload = { model: "test", messages: [{ role: "user", content: "hello" }], stream: true, system: [] };
const token = "sk-ant-oat-test-not-a-credential";

function fixture() {
  const events = createAssistantMessageEventStream();
  const stream = vi.fn<Provider["stream"]>(() => events);
  const streamSimple = vi.fn<Provider["streamSimple"]>(() => events);
  const provider: Provider = { ...anthropicProvider(), stream, streamSimple };
  const wrapped = wrapAnthropicProvider(provider);
  return { provider, wrapped, events, stream, streamSimple };
}

function capturedOptions(spy: ReturnType<typeof fixture>["streamSimple"]): SimpleStreamOptions {
  return spy.mock.calls[0][2]!;
}

describe("provider-scoped transport", () => {
  it("preserves all auth/catalog fields and returns the delegate's exact event stream", () => {
    const f = fixture();
    expect(f.wrapped.auth).toBe(f.provider.auth);
    expect(f.wrapped.getModels).toBe(f.provider.getModels);
    expect(f.wrapped.getAllModels).toBe(f.provider.getAllModels);
    expect(f.wrapped.baseUrl).toBe(f.provider.baseUrl);
    const options = { apiKey: token };
    expect(f.wrapped.streamSimple(model, context, options)).toBe(f.events);
    expect(f.streamSimple).toHaveBeenCalledWith(model, context, expect.any(Object));
    expect(f.wrapped.stream(model, context, options)).toBe(f.events);
    expect(f.stream).toHaveBeenCalledWith(model, context, expect.any(Object));
  });
  it.each([undefined, "api-key-test", "other-provider-oauth"])("preserves exact options for non-OAuth %j", (apiKey) => {
    const f = fixture();
    const options = { apiKey, fetch: vi.fn(), onPayload: vi.fn() };
    f.wrapped.streamSimple(model, context, options);
    expect(capturedOptions(f.streamSimple)).toBe(options);
    f.wrapped.stream(model, context, options);
    expect(capturedOptions(f.stream)).toBe(options);
  });
  it("leaves missing options and other APIs/provider IDs alone", () => {
    const f = fixture();
    f.wrapped.streamSimple(model, context);
    expect(capturedOptions(f.streamSimple)).toBeUndefined();
    const options = { apiKey: token };
    for (const changed of [{ ...model, provider: "gateway" }, { ...model, api: "different-api" }]) {
      f.streamSimple.mockClear();
      f.wrapped.streamSimple(changed, context, options);
      expect(capturedOptions(f.streamSimple)).toBe(options);
    }
  });
  it("leaves a supplied custom SDK client outside the adapter's transport scope", () => {
    const f = fixture();
    const options = { apiKey: token, client: { custom: true } };
    f.wrapped.streamSimple(model, context, options);
    expect(capturedOptions(f.streamSimple)).toBe(options);
  });
  it("composes asynchronous replacement and mutation hooks before shaping", async () => {
    for (const mode of ["replace", "mutate"] as const) {
      const f = fixture();
      const hook = vi.fn(async (payload: unknown, inputModel: Model<string>) => {
        expect(inputModel).toBe(model);
        if (mode === "replace") return { ...rawPayload, system: "caller prompt" };
        Object.assign(payload!, { system: "caller prompt" });
      });
      f.wrapped.streamSimple(model, context, { apiKey: token, onPayload: hook });
      const result = await capturedOptions(f.streamSimple).onPayload?.(structuredClone(rawPayload), model);
      expect(result).toMatchObject({ system: [{ text: expect.stringContaining("x-anthropic-billing-header:") }, { text: "caller prompt" }] });
      expect(hook).toHaveBeenCalledTimes(1);
    }
  });
  it("does not swallow hook exceptions or reinterpret null as undefined", async () => {
    const f = fixture();
    const error = new Error("caller failed");
    f.wrapped.streamSimple(model, context, { apiKey: token, onPayload: () => { throw error; } });
    await expect(capturedOptions(f.streamSimple).onPayload?.(rawPayload, model)).rejects.toBe(error);
    f.streamSimple.mockClear();
    f.wrapped.streamSimple(model, context, { apiKey: token, onPayload: () => null });
    expect(await capturedOptions(f.streamSimple).onPayload?.(rawPayload, model)).toBeNull();
  });
  it("keeps fetch responses and rejections unchanged, without adapter retries", async () => {
    const response = new Response("upstream error", { status: 400, headers: { "request-id": "req-test" } });
    const fetch = vi.fn().mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("network failed"));
    const f = fixture();
    f.wrapped.streamSimple(model, context, { apiKey: token, fetch });
    const options = capturedOptions(f.streamSimple);
    expect(await options.fetch?.("https://example.invalid", { body: "not-json" })).toBe(response);
    expect(response.bodyUsed).toBe(false);
    await expect(options.fetch?.("https://example.invalid")).rejects.toThrow("network failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("aligns only generated billing blocks to a newer wire user-agent, preserving init fields", async () => {
    const fetch = vi.fn<FetchFunction>(async () => new Response());
    const f = fixture();
    f.wrapped.streamSimple(model, context, { apiKey: token, fetch });
    const options = capturedOptions(f.streamSimple);
    const payload = await options.onPayload?.(rawPayload, model);
    const signal = new AbortController().signal;
    const init = { method: "POST", headers: { "user-agent": "claude-cli/3.0.0" }, body: JSON.stringify(payload), signal };
    await options.fetch?.("https://example.invalid", init);
    const sent = fetch.mock.calls[0][1]!;
    expect(sent.signal).toBe(signal);
    expect(sent.headers).toBe(init.headers);
    expect(JSON.parse(String(sent.body)).system[0].text).toBe(await billingHeader("hello", "3.0.0"));
  });
  it("preserves caller billing markers and absolute version pins", async () => {
    for (const explicit of [false, true]) {
      const f = fixture();
      const fetch = vi.fn<FetchFunction>(async () => new Response());
      const wrapped = wrapAnthropicProvider(f.provider, explicit ? { claudeCodeVersion: "1.2.3" } : {});
      const existing = { ...rawPayload, system: [{ type: "text", text: await billingHeader("hello", "2.1.280") }] };
      wrapped.streamSimple(model, context, { apiKey: token, fetch });
      const options = capturedOptions(f.streamSimple);
      const input = explicit ? rawPayload : existing;
      const payload = await options.onPayload?.(input, model);
      await options.fetch?.("https://example.invalid", { headers: { "user-agent": "claude-cli/99.0.0" }, body: JSON.stringify(payload) });
      const sent = fetch.mock.calls[0][1]!;
      expect(JSON.parse(String(sent.body)).system[0].text).toBe(await billingHeader("hello", explicit ? "1.2.3" : "2.1.280"));
    }
  });
  it("preserves Request-only bodies and malformed JSON at the wire boundary", async () => {
    const f = fixture();
    const fetch = vi.fn<FetchFunction>(async () => new Response());
    f.wrapped.streamSimple(model, context, { apiKey: token, fetch });
    const options = capturedOptions(f.streamSimple);
    const input = new Request("https://example.invalid", { method: "POST", body: "request-only", headers: { "user-agent": "claude-cli/3.0.0" } });
    await options.fetch?.(input);
    expect(fetch).toHaveBeenLastCalledWith(input, undefined);
    expect(input.bodyUsed).toBe(false);
    const init = { headers: input.headers, body: "not-json" };
    await options.fetch?.(input, init);
    expect(fetch).toHaveBeenLastCalledWith(input, init);
  });
  it("rejects missing/wrong providers and invalid versions before installing", () => {
    expect(() => installAnthropicOAuth(createModels())).toThrow("No anthropic provider");
    expect(() => wrapAnthropicProvider({ ...fixture().provider, id: "other" })).toThrow("Expected");
    for (const version of ["", "2.1", "v2.1.280", "2.1.280.bad", "2.1.280\nheader", "2.1.280\n", " 2.1.280"]) {
      expect(() => wrapAnthropicProvider(fixture().provider, { claudeCodeVersion: version })).toThrow("X.Y.Z");
    }
    expect(isAnthropicOAuthToken(token)).toBe(true);
    expect(isAnthropicOAuthToken(undefined)).toBe(false);
  });
  it("receives refreshed OAuth credentials from Models without replacing auth ownership", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "oauth", access: "sk-ant-oat-expired-fake", refresh: "refresh-fake", expires: 0,
    }));
    const f = fixture();
    const refresh = vi.fn<NonNullable<Provider["auth"]["oauth"]>["refresh"]>(async (credential) => ({
      ...credential, access: "sk-ant-oat-refreshed-fake", expires: Date.now() + 3_600_000,
    }));
    const oauth: NonNullable<Provider["auth"]["oauth"]> = {
      name: "Test OAuth", login: async () => { throw new Error("Login not expected"); },
      refresh, toAuth: async (credential) => ({ apiKey: credential.access }),
    };
    const models = createModels({ credentials });
    models.setProvider({ ...f.provider, auth: { oauth } });
    installAnthropicOAuth(models);
    models.streamSimple(model, { messages: [] });
    await vi.waitFor(() => expect(f.streamSimple).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(capturedOptions(f.streamSimple).apiKey).toBe("sk-ant-oat-refreshed-fake");
    expect(capturedOptions(f.streamSimple).onPayload).toBeTypeOf("function");
    expect((await credentials.read("anthropic"))).toMatchObject({ access: "sk-ant-oat-refreshed-fake" });
    expect(models.getProvider("anthropic")?.auth.oauth).toBe(oauth);
  });
  it("installs locally, preserving other providers and credential resolution", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({ type: "api_key", key: token }));
    const models = createModels({ credentials });
    const f = fixture();
    const other = { ...f.provider, id: "other" };
    models.setProvider(f.provider);
    models.setProvider(other);
    installAnthropicOAuth(models);
    expect(models.getProvider("other")).toBe(other);
    expect(models.getProvider("anthropic")?.auth).toBe(f.provider.auth);
    // Models resolves the stored credential before invoking the wrapped provider.
    models.streamSimple(model, { messages: [] });
    await vi.waitFor(() => expect(f.streamSimple).toHaveBeenCalled());
    expect(capturedOptions(f.streamSimple).apiKey).toBe(token);
    expect(capturedOptions(f.streamSimple).onPayload).toBeTypeOf("function");
  });
});
