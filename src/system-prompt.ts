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

// Sticky matching: only advance to a new frame after a complete section body.
const UPDATE = /(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.(?=\n\n|$))/y;
const FRAME_IN_BODY = /^(?:Updated system prompt section "[a-z][a-z0-9_-]*":|Removed system prompt section "[a-z][a-z0-9_-]*"\.)/m;

export function shapeSystemUpdate(text: string): string | undefined {
  if (text === "") return text;
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    UPDATE.lastIndex = cursor;
    const frame = UPDATE.exec(text);
    // Free-form leading/trailing instructions cannot be distinguished from
    // frame-like examples. Do not partially rewrite an ambiguous message.
    if (!frame) return text;
    const [, updated] = frame;
    let end = cursor + frame[0].length;
    if (updated === undefined) {
      // A name alone does not prove that the removed section was suppressed:
      // custom docs may have been retained in the initial prompt or an update.
      parts.push(frame[0]);
    } else {
      const remaining = text.slice(end);
      const chunks = parseSystemPromptChunks(remaining);
      const section = chunks[0];
      const tagged = section?.name === updated;
      if (!tagged && (remaining.startsWith("<") || FRAME_IN_BODY.test(remaining))) return text;
      // An untagged body has no reliable end marker. Accept it only as the
      // final update; never interpret any frame-like text within it as a frame.
      const value = tagged ? section.body : remaining;
      end += tagged ? section.raw.length : remaining.length;
      const body = shapeSection(updated, value);
      if (body !== undefined) {
        const raw = tagged ? (body === value ? section.raw : namedSection(updated, body).raw) : body;
        parts.push(`${frame[0]}${raw}`);
      }
    }
    if (end === text.length) break;
    if (!text.startsWith("\n\n", end)) return text;
    cursor = end + 2;
    if (cursor === text.length) return text;
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
