import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { billingHeader, firstUserText, wireVersion } from "../src/billing.js";
import { shapePayload } from "../src/payload.js";
import { parseSystemPromptChunks, renderSystemPromptChunks } from "../src/system-prompt-sections.js";
import { shapeSystemPrompt, shapeSystemUpdate } from "../src/system-prompt.js";

const VERSION = "2.1.280";
export const PI = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const project = '<project_context>\n<project_instructions path="a">\nKeep pi and Here is some useful information about the environment you are running in:\n</project_instructions>\n</project_context>';
export const prompt = `${PI}\nOld identity\n\n<tools>\nUse tools carefully.\n\nIn addition to the tools above, custom tools exist.\n</tools>\n\n<docs>\nPi documentation (read only when the user asks about pi itself): /docs\n</docs>\n\n${project}`;

const payload = (extra: Record<string, unknown> = {}) => ({
  model: "test-model", stream: true, messages: [{ role: "user", content: "hello" }], system: [], ...extra,
});

function referenceHeader(text: string, version: string): string {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const suffix = hash(`59cf53e54c78${[4, 7, 20].map((i) => text[i] || "0").join("")}${version}`).slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${hash(text).slice(0, 5)};`;
}

describe("upstream billing recipe, using Web Crypto", () => {
  it("matches a fixed upstream-compatible hash vector", async () => {
    expect(await billingHeader("hello", VERSION)).toBe("x-anthropic-billing-header: cc_version=2.1.280.790; cc_entrypoint=sdk-cli; cch=2cf24;");
  });
  it.each(["a", "012345678901234567890123456789", "A😀é𐐷z\nhello world!", "line\n\"quoted\"\\end"])("matches Node upstream hashing for %j", async (text) => {
    expect(await billingHeader(text, VERSION)).toBe(referenceHeader(text, VERSION));
  });
  it("only raises the default floor to a valid newer wire version", () => {
    expect(wireVersion(VERSION, "claude-cli/2.1.999")).toBe("2.1.999");
    expect(wireVersion(VERSION, "claude-cli/2.10.1")).toBe("2.10.1");
    for (const userAgent of [null, "claude-cli/2.1.1", "notclaude-cli/9.0.0", "claude-cli/9.0.0.1", "claude-cli/9.0.0-beta", "other/9.0.0"]) {
      expect(wireVersion(VERSION, userAgent)).toBe(VERSION);
    }
  });
  it("skips empty text and only uses the first text of the first user message", async () => {
    expect(await billingHeader("", VERSION)).toBeUndefined();
    expect(firstUserText([{ role: "assistant", content: "not this" }, { role: "user", content: [{ type: "image" }, { type: "text", text: "first" }, { type: "text", text: "second" }] }])).toBe("first");
    expect(firstUserText([{ role: "user", content: [{ type: "image" }] }, { role: "user", content: "later" }])).toBe("");
  });
});

describe("conservative prompt shaping", () => {
  it("strips only recognized Pi content and preserves project instructions exactly", () => {
    const shaped = shapeSystemPrompt(prompt);
    expect(shaped).toContain("You are an expert coding assistant.\nBe concise and helpful.");
    expect(shaped).toContain("<tools>\nUse tools carefully.\n</tools>");
    expect(shaped).not.toContain(PI);
    expect(shaped).not.toContain("<docs>");
    expect(shaped).not.toContain("In addition to");
    expect(shaped).toContain(project);
  });
  it("preserves custom docs, unknown sections, malformed and unstructured prompts", () => {
    for (const text of ["You are a concise assistant.", `${PI}\nProject instructions without sections`, "<rules>broken", "<custom>\nkeep me\n</custom>"]) {
      expect(shapeSystemPrompt(text)).toBe(text);
      expect(renderSystemPromptChunks(parseSystemPromptChunks(text))).toBe(text);
    }
    const text = `${PI}\n\n<docs>\nUser-defined docs\n</docs>\n\n<custom>\nuntouched\n</custom>`;
    expect(shapeSystemPrompt(text)).toContain("<docs>\nUser-defined docs\n</docs>");
    expect(shapeSystemPrompt(text)).toContain("<custom>\nuntouched\n</custom>");
  });
  it("round trips nested tags, extra blank lines and unparsed remainders", () => {
    const text = `${prompt}\n\n\n<rules>\n<inner>\ntext\n</inner>\n</rules>\n\nraw tail`;
    expect(renderSystemPromptChunks(parseSystemPromptChunks(text))).toBe(text);
  });
  it("applies replacements only inside Pi-owned sections", () => {
    const trigger = "Here is some useful information about the environment you are running in:";
    const text = `${PI}\n\n<rules>\n${trigger}\n</rules>\n\n${project}`;
    const shaped = shapeSystemPrompt(text);
    expect(shaped).toContain("<rules>\nEnvironment context you are running in:\n</rules>");
    expect(shaped).toContain(project);
  });
  it("shapes framed updates and drops docs removal notices", () => {
    expect(shapeSystemUpdate(`Updated system prompt section "preamble":\n\n${PI}`)).toContain("Be concise and helpful.");
    expect(shapeSystemUpdate('Updated system prompt section "docs":\n\n<docs>\nPi documentation (read only when the user asks about pi itself)\n</docs>')).toBeUndefined();
    expect(shapeSystemUpdate('Removed system prompt section "docs".')).toBeUndefined();
    expect(shapeSystemUpdate('Removed system prompt section "custom".')).toBe('Removed system prompt section "custom".');
    expect(shapeSystemUpdate('Updated system prompt section "custom":\n\n<custom>\nKeep pi\n</custom>')).toBe('Updated system prompt section "custom":\n\n<custom>\nKeep pi\n</custom>');
  });
});

describe("payload shaping", () => {
  it("prepends billing, preserves cache metadata, tools, signatures and assistant ordering", async () => {
    const assistant = { role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "signed" }, { type: "tool_use", id: "id", name: "Read", input: {} }, { type: "text", text: "after" }] };
    const toolResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "id", content: "ok" }] };
    const tools = [{ name: "Read", input_schema: { type: "object" } }];
    const input = payload({ system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }], tools, messages: [{ role: "user", content: "hello" }, assistant, toolResult] });
    const before = structuredClone(input);
    const result = await shapePayload(input, VERSION);
    expect(result.payload).toMatchObject({ system: [{ type: "text", text: referenceHeader("hello", VERSION) }, { cache_control: { type: "ephemeral" } }], tools });
    expect(result.payload).toMatchObject({ messages: [input.messages[0], assistant, toolResult] });
    expect(input).toEqual(before);
    expect(await shapePayload(result.payload, VERSION)).toEqual({ payload: result.payload });
  });
  it("preserves custom string system prompts and existing caller billing headers", async () => {
    const result = await shapePayload(payload({ system: "You are a concise assistant." }), VERSION);
    expect(result.payload).toMatchObject({ system: [{ text: referenceHeader("hello", VERSION) }, { text: "You are a concise assistant." }] });
    const existing = { type: "text", text: "x-anthropic-billing-header: caller-owned" };
    const shaped = await shapePayload(payload({ system: [existing] }), VERSION);
    expect(shaped.billing).toBeUndefined();
    expect(shaped.payload).toMatchObject({ system: [existing] });
  });
  it("retains content-less effort and tool changes but drops empty docs-only updates", async () => {
    const docs = { type: "text", text: 'Removed system prompt section "docs".' };
    const effort = { role: "system", content: [docs], output_config: { effort: "low" } };
    const tool = { role: "system", content: [docs, { type: "tool_addition", name: "read" }] };
    const result = await shapePayload(payload({ messages: [{ role: "user", content: "hello" }, { role: "system", content: [docs] }, effort, tool] }), VERSION);
    expect(result.payload).toMatchObject({ messages: [{ role: "user" }, { ...effort, content: [] }, { ...tool, content: [{ type: "tool_addition", name: "read" }] }] });
  });
  it("adds no billing block when the first user has no text", async () => {
    const result = await shapePayload(payload({ messages: [{ role: "user", content: [{ type: "image" }] }] }), VERSION);
    expect(result.payload).toMatchObject({ system: [] });
    expect(result.billing).toBeUndefined();
  });
  it.each([null, [], "raw", {}, { model: "test", messages: [], stream: "yes" }])("passes non-messages payloads through by identity: %j", async (input) => {
    expect((await shapePayload(input, VERSION)).payload).toBe(input);
  });
});
