import type {
  Api, Model, MutableModels, Provider, ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import {
  billingHeader, DEFAULT_CLAUDE_CODE_VERSION, isRecord,
  validateVersion, wireVersion,
} from "./billing.js";
import { shapePayload } from "./payload.js";

export interface AnthropicOAuthOptions {
  /** Absolute billing version override. Default: upstream floor, raised to a newer wire user-agent. */
  claudeCodeVersion?: string;
}

/** Deliberately matches pi-ai 1.2.0's own OAuth detection. */
export function isAnthropicOAuthToken(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

/**
 * Decorate the built-in Anthropic provider. Auth, catalog, SDK and event streams
 * remain upstream-owned. Other provider IDs are rejected to prevent accidental
 * changes to gateways or providers sharing the anthropic-messages API.
 */
export function wrapAnthropicProvider<TApi extends Api>(
  provider: Provider<TApi>,
  config: AnthropicOAuthOptions = {},
): Provider<TApi> {
  if (provider.id !== "anthropic") throw new Error("Expected the built-in anthropic provider");
  const version = validateVersion(config.claudeCodeVersion ?? DEFAULT_CLAUDE_CODE_VERSION);
  const explicit = config.claudeCodeVersion !== undefined;

  function optionsFor<T extends ProviderRequestOptions>(model: Model<Api>, options: T | undefined): T | undefined {
    if (!options || model.provider !== "anthropic" || model.api !== "anthropic-messages" ||
        !isAnthropicOAuthToken(options.apiKey) || ("client" in options && options.client)) return options;
    const caller = options.onPayload;
    const dispatch = options.fetch ?? globalThis.fetch;
    // Request-local provenance: only billing text emitted by this wrapper may
    // be updated. A preexisting caller-owned marker is never replaced.
    const generated = new Map<string, string>();
    return {
      ...options,
      onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
        const replacement = await caller?.(payload, payloadModel);
        const upstream = replacement === undefined ? payload : replacement;
        const shaped = await shapePayload(upstream, version);
        if (shaped.billing) generated.set(shaped.billing.header, shaped.billing.text);
        return shaped.payload;
      },
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const target = explicit ? version : wireVersion(version, headers.get("user-agent"));
        // pi-ai's Anthropic SDK supplies a serialized body in init. Do not
        // consume Request streams or change non-JSON/custom transport bodies.
        if (target !== version && typeof init?.body === "string") {
          let payload: unknown;
          try { payload = JSON.parse(init.body); } catch { return dispatch(input, init); }
          if (isRecord(payload) && Array.isArray(payload.system)) {
            const system = await Promise.all(payload.system.map(async (block: unknown) => {
              if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
              const text = generated.get(block.text);
              return text === undefined ? block : { ...block, text: await billingHeader(text, target) };
            }));
            return dispatch(input, { ...init, body: JSON.stringify({ ...payload, system }) });
          }
        }
        // Never inspect a response: incremental streaming and all errors stay
        // with the SDK. No adapter retry, floor learning or billing assertion.
        return dispatch(input, init);
      },
    };
  }

  return {
    ...provider,
    stream(model, context, options) {
      return provider.stream(model, context, optionsFor(model, options));
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, optionsFor(model, options));
    },
  };
}

/** Install once, immediately after constructing your mutable model collection. */
export function installAnthropicOAuth(models: MutableModels, options?: AnthropicOAuthOptions): void {
  const provider = models.getProvider("anthropic");
  if (!provider) throw new Error("No anthropic provider registered in this model collection");
  models.setProvider(wrapAnthropicProvider(provider, options));
}
