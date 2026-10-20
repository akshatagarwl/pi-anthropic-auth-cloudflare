// Adapted from @gotgenes/pi-anthropic-auth 3.4.3. MIT; see LICENSE and NOTICE.
import { namedSection, parseSystemPromptChunks, renderSystemPromptChunks } from "./system-prompt-sections.js";

const PI_PREFIX = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const MINIMAL = [
  "You are an expert coding assistant.",
  "Be concise and helpful.",
  "Use the available tools to answer the user's request.",
  "Show file paths clearly when working with files.",
].join("\n");
const OWNED = ["tools", "rules", "docs"];
const DOCS_ANCHOR = "Pi documentation (read only when the user asks about pi itself";
const FILLER_ANCHOR = "In addition to the tools above";

// undefined means drop. Only Pi-owned sections may be rewritten.
function shapeSection(name: string, body: string): string | undefined {
  if (name !== "preamble" && !OWNED.includes(name)) return body;
  const text = body.replaceAll(
    "Here is some useful information about the environment you are running in:",
    "Environment context you are running in:",
  );
  if (name === "preamble" && text.startsWith(PI_PREFIX)) return MINIMAL;
  if (name === "docs" && text.includes(DOCS_ANCHOR)) return undefined;
  if (name === "tools") {
    const paragraphs = text.split(/\n\n+/);
    const kept = paragraphs.filter((part) => !part.includes(FILLER_ANCHOR));
    return kept.length === paragraphs.length ? text : kept.join("\n\n").trim();
  }
  return text;
}

export function shapeSystemPrompt(text: string): string {
  const chunks = parseSystemPromptChunks(text);
  if (!chunks.some((chunk) => chunk.name !== null && OWNED.includes(chunk.name))) return text;
  return renderSystemPromptChunks(chunks.flatMap((chunk, index) => {
    const name = chunk.name ?? (index === 0 ? "preamble" : undefined);
    if (name === undefined) return [chunk];
    const body = shapeSection(name, chunk.body);
    if (body === undefined) return [];
    if (body === chunk.body) return [chunk];
    return [chunk.name === null ? { name: null, raw: body, body } : namedSection(chunk.name, body)];
  }));
}

export function shapeInitialSystemText(text: string): string {
  return text.includes(PI_PREFIX) ? shapeSystemPrompt(text) : text;
}

const UPDATE = /^(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.$)/gm;

export function shapeSystemUpdate(text: string): string | undefined {
  const frames = [...text.matchAll(UPDATE)];
  if (frames.length === 0) return text;
  const parts: string[] = [];
  const leading = text.slice(0, frames[0].index).trim();
  if (leading) parts.push(leading);
  for (const [index, frame] of frames.entries()) {
    const [, updated, removed] = frame;
    if (removed !== undefined) {
      if (removed !== "docs") parts.push(frame[0]);
      continue;
    }
    if (updated === undefined) continue;
    const end = frames[index + 1]?.index ?? text.length;
    const value = text.slice(frame.index + frame[0].length, end).trimEnd();
    const chunks = parseSystemPromptChunks(value);
    const tagged = chunks.length === 1 && chunks[0].name === updated;
    const body = shapeSection(updated, tagged ? chunks[0].body : value);
    if (body !== undefined) {
      parts.push(`${frame[0]}${tagged ? namedSection(updated, body).raw : body}`);
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
