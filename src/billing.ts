// Adapted from @gotgenes/pi-anthropic-auth 3.4.3. MIT; see LICENSE and NOTICE.
export const BILLING_MARKER = "x-anthropic-billing-header:";
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280";
const VERSION = /^\d+\.\d+\.\d+$/;

export function validateVersion(version: string): string {
  if (version !== version.trim() || !VERSION.test(version)) {
    throw new Error("claudeCodeVersion must be a bare X.Y.Z version");
  }
  return version;
}

export function wireVersion(baseline: string, userAgent: string | null): string {
  const candidate = /(?:^|\s)claude-cli\/(\d+\.\d+\.\d+)(?=\s|$)/.exec(userAgent ?? "")?.[1];
  if (!candidate) return baseline;
  const a = baseline.split(".").map(Number);
  const b = candidate.split(".").map(Number);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] > a[i] ? candidate : baseline;
  }
  return baseline;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function firstUserText(messages: unknown[]): string {
  const message = messages.find((entry) => isRecord(entry) && entry.role === "user");
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const text = message.content.find((block: unknown) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  return isRecord(text) && typeof text.text === "string" ? text.text : "";
}

async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function billingHeader(text: string, version: string): Promise<string | undefined> {
  if (!text) return undefined;
  const sample = [4, 7, 20].map((index) => text[index] || "0").join("");
  const [messageHash, versionHash] = await Promise.all([
    sha256(text), sha256(`59cf53e54c78${sample}${version}`),
  ]);
  return `${BILLING_MARKER} cc_version=${version}.${versionHash.slice(0, 3)}; cc_entrypoint=sdk-cli; cch=${messageHash.slice(0, 5)};`;
}
