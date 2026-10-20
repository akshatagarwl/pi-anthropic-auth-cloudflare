// Adapted from @gotgenes/pi-anthropic-auth 3.4.3. MIT; see LICENSE and NOTICE.
import { BILLING_MARKER, billingHeader, firstUserText, isRecord } from "./billing.js";
import { shapeInitialSystemText, shapeSystemUpdate } from "./system-prompt.js";

function shapeMessage(message: unknown): unknown[] {
  if (!isRecord(message) || message.role !== "system" || !Array.isArray(message.content)) {
    return [message];
  }
  const content = message.content.flatMap((block: unknown) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [block];
    const text = shapeSystemUpdate(block.text);
    return text === undefined ? [] : [{ ...block, text }];
  });
  // Per-message effort and non-text tool updates must survive even without text.
  return content.length || message.output_config !== undefined ? [{ ...message, content }] : [];
}

export interface ShapedRequest {
  payload: unknown;
  billing?: { header: string; text: string };
}

export async function shapePayload(payload: unknown, version: string): Promise<ShapedRequest> {
  if (!isRecord(payload) || typeof payload.model !== "string" ||
      !Array.isArray(payload.messages) || typeof payload.stream !== "boolean") return { payload };

  const messages = payload.messages.flatMap(shapeMessage);
  const system = typeof payload.system === "string"
    ? [{ type: "text", text: shapeInitialSystemText(payload.system) }]
    : Array.isArray(payload.system) ? payload.system.map((block: unknown) => {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
      const text = shapeInitialSystemText(block.text);
      return text === block.text ? block : { ...block, text };
    }) : [];
  const present = system.some((block: unknown) =>
    isRecord(block) && typeof block.text === "string" && block.text.includes(BILLING_MARKER),
  );
  const text = firstUserText(messages);
  const header = present ? undefined : await billingHeader(text, version);
  return {
    payload: { ...payload, messages, system: header ? [{ type: "text", text: header }, ...system] : system },
    ...(header ? { billing: { header, text } } : {}),
  };
}
