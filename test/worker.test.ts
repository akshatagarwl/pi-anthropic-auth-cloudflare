import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";

// This runtime probe intentionally has no pi-ai runtime import. The adapter
// must execute in workerd without nodejs_compat or filesystem polyfills.
const probe = `
import { wrapAnthropicProvider } from "./src/index.ts";
export default {
  async fetch() {
    let captured;
    const sentinel = {};
    const auth = {};
    const provider = {
      id: "anthropic", auth, getModels: () => [],
      stream: (_model, _context, options) => { captured = options; return sentinel; },
      streamSimple: (_model, _context, options) => { captured = options; return sentinel; },
    };
    const wrapped = wrapAnthropicProvider(provider);
    const model = { api: "anthropic-messages", provider: "anthropic" };
    const response = new Response("unread response", { status: 400 });
    const baseFetch = async (_input, init) => { captured.sent = JSON.parse(init.body); return response; };
    const sameStream = wrapped.streamSimple(model, {}, { apiKey: "sk-ant-oat-fake", fetch: baseFetch }) === sentinel;
    const payload = await captured.onPayload({ model: "test", stream: true, system: "Custom prompt", messages: [{ role: "user", content: "hello" }] }, model);
    const sameResponse = await captured.fetch("https://example.invalid", { headers: { "user-agent": "claude-cli/3.0.0" }, body: JSON.stringify(payload) }) === response;
    return Response.json({ sameStream, sameResponse, sameAuth: wrapped.auth === auth, bodyUsed: response.bodyUsed, sent: captured.sent });
  }
};`;

describe("Cloudflare runtime compatibility", () => {
  it("bundles only Web API runtime source, with no runtime imports", async () => {
    const result = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, platform: "browser", format: "esm", metafile: true });
    expect(Object.keys(result.metafile!.inputs).every((path) => path.startsWith("src/"))).toBe(true);
    expect(result.metafile!.outputs[Object.keys(result.metafile!.outputs)[0]].imports).toEqual([]);
    expect(result.outputFiles[0].text).not.toMatch(/node:|process\.|require\(/);
  });
  it("runs Web Crypto shaping and preserves streams/errors in real workerd without Node compatibility", async () => {
    const result = await build({ stdin: { contents: probe, resolveDir: process.cwd(), sourcefile: "worker-probe.js" }, bundle: true, write: false, platform: "browser", format: "esm" });
    const mf = new Miniflare({ workers: [{ config: {
      name: "adapter", compatibilityDate: "2026-10-01",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: result.outputFiles[0].text } } },
    } }] });
    try {
      const response = await mf.dispatchFetch("https://adapter.test");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        sameStream: true, sameResponse: true, sameAuth: true, bodyUsed: false,
        sent: { system: [{ type: "text", text: expect.stringContaining("cc_version=3.0.0.") }, { text: "Custom prompt" }] },
      });
    } finally {
      await mf.dispose();
    }
  }, 20_000);
  it("runs the real Anthropic SDK path in workerd with upstream's Node compatibility enabled", async () => {
    const script = `
      import { createModels } from "@earendil-works/pi-ai";
      import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
      import { installAnthropicOAuth } from "./src/index.ts";
      export default { async fetch() {
        const models = createModels();
        models.setProvider(anthropicProvider());
        installAnthropicOAuth(models);
        const model = models.getModels("anthropic")[0];
        let sent, bearer;
        const result = await models.completeSimple(model, {
          systemPrompt: "Worker custom context", messages: [{ role: "user", content: "hello", timestamp: 0 }],
        }, {
          apiKey: "sk-ant-oat-fake", maxRetries: 0,
          fetch: async (_input, init) => {
            sent = JSON.parse(init.body);
            bearer = new Headers(init.headers).get("authorization");
            const events = [
              { type: "message_start", message: { id: "msg-worker", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Worker streamed" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
              { type: "message_stop" },
            ];
            const body = events.map(event => "event: " + event.type + "\\ndata: " + JSON.stringify(event) + "\\n\\n").join("");
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
          },
        });
        return Response.json({ result, sent, bearer });
      } };
    `;
    const bundle = await build({ stdin: { contents: script, resolveDir: process.cwd(), sourcefile: "sdk-worker.js" }, bundle: true, write: false, platform: "browser", format: "esm", external: ["node:*"] });
    const mf = new Miniflare({ workers: [{ config: {
      name: "sdk-adapter", compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"],
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } },
    } }] });
    try {
      const response = await mf.dispatchFetch("https://adapter.test");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        bearer: "Bearer sk-ant-oat-fake",
        result: { stopReason: "stop", content: [{ type: "text", text: "Worker streamed" }] },
        sent: { system: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("cc_version=2.1.280.") }),
          expect.objectContaining({ text: "Worker custom context" }),
        ]) },
      });
    } finally {
      await mf.dispose();
    }
  }, 20_000);

});
