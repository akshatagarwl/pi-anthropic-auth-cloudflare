# Research: Worker-safe Anthropic OAuth shaping

## Inspected artifacts (before implementation)

- Installed `@gotgenes/pi-anthropic-auth` **3.4.3**, at
  `/Users/akshat/.pi/agent/npm/node_modules/@gotgenes/pi-anthropic-auth`.
  [Published source](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/),
  [repository](https://github.com/gotgenes/pi-anthropic-auth),
  [MIT license](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/LICENSE).
  npm `dist.integrity`:
  `sha512-w2WwBxUKY4pLOHYvVdkR39lDrFgRrETIs3Oh5iCK461nL5MhKjW18iBjBD9DkTJlcavKZkrRvRvQnLz9o8DVMg==`.
- Target `/Users/akshat/workspace/pi-durable-cf` uses
  `@earendil-works/pi-ai` **1.2.0** and `@earendil-works/pi-durable` **1.2.0**.
  pi-ai npm `dist.integrity`:
  `sha512-U5/1zXqfV1on7/9sbez03tT4Ru49Lvfb4+zXSDK3DBKF5cRk6KxvAOTOY3HJ4jimlZth+rs7vbJqN6iBQAoNuQ==`.
  Registry queries returned no `gitHead`; version-pinned package URLs below
  identify the inspected sources rather than inventing a commit citation.

## Exact extension seams

1. [`models.d.ts`](https://unpkg.com/@earendil-works/pi-ai@1.2.0/dist/models.d.ts)
   declares `MutableModels.getProvider(id)` and `setProvider(provider)` (upsert by
   provider ID). `Provider` owns `auth`, catalog accessors, `stream`, and
   `streamSimple`. There is no reason to use a process-global compat API registry.
2. [`models.js`](https://unpkg.com/@earendil-works/pi-ai@1.2.0/dist/models.js),
   `applyAuth`, `stream`, `streamSimple`: the collection normalizes context,
   resolves and refreshes credentials, assembles headers, then calls the current
   provider with the resolved `options.apiKey`. Wrapping the provider therefore
   sees the effective token, including tokens refreshed by built-in OAuth.
   `complete`/`completeSimple` delegate through these same methods.
3. [`types.d.ts`](https://unpkg.com/@earendil-works/pi-ai@1.2.0/dist/types.d.ts),
   `ProviderRequestOptions`: `onPayload(payload, model)` may asynchronously return
   a replacement, or `undefined` to retain the original; `fetch` is an injectable
   `typeof globalThis.fetch`. These are local per-request extension points.
4. [`providers/anthropic.js`](https://unpkg.com/@earendil-works/pi-ai@1.2.0/dist/providers/anthropic.js)
   constructs a plain provider with built-in API-key/OAuth auth, full catalog,
   and the lazy Anthropic API. Preserve all those fields; replace only its two
   stream methods, delegating to the captured original (not a registry lookup).
5. [`api/anthropic-messages.js`](https://unpkg.com/@earendil-works/pi-ai@1.2.0/dist/api/anthropic-messages.js),
   `stream`, `isOAuthToken`, `createClient`: OAuth detection is
   `apiKey.includes("sk-ant-oat")`. The built-in SDK client supplies Bearer auth,
   `x-app: cli`, and `user-agent: claude-cli/2.1.280`. It awaits `onPayload`
   after building messages, then sends via the injectable fetch. A supplied
   `client` bypasses that built-in OAuth construction and is out of scope.
   The built-in payload also adds the Claude Code system identity and may add a
   deferred-tool placeholder; neither should be removed.
   Keep SDK streaming, beta/tool naming, thinking signatures, retry/abort, and
   response/error parsing untouched.
6. [`pi-durable/dist/harness/generation.js`](https://unpkg.com/@earendil-works/pi-durable@1.2.0/dist/harness/generation.js)
   dispatches generations through `runtime.models.streamSimple`. Giving the
   harness this collection covers calls using it; direct pi-ai compat calls,
   separately constructed providers/collections and custom clients bypass it.

Target-local inspection: `src/models.ts:createAppModels` already calls
`builtinModels({ credentials })`; this is the future installation point.
`src/chat.ts:createChatHarnessOptions` supplies that collection to the harness.
The chat preamble is custom, not the CLI Pi identity, and must remain unchanged.
The target already registers Bun OAuth flows statically for Worker bundling;
this adapter must not take over login, persistence, refresh or that registration.
No target file is changed by this research/implementation.

## Upstream behavior and portability

- [`oauth-transport.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/oauth-transport.ts)
  composes caller `onPayload` first, shapes last, gated on the OAuth token marker.
  Its CLI `registerProvider` wiring is not the target's `MutableModels` API.
- [`request-shaping.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/request-shaping.ts)
  adds a **system text block**, not an HTTP billing header. It leaves assistant
  content (including signed thinking and tool calls) intact and shapes
  mid-conversation system updates. Content-less effort updates survive.
- [`billing-header.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/billing-header.ts)
  hashes the first text block of the first user message with SHA-256; `cch` is
  the first five hex digits. Version suffix: first three hex digits of SHA-256
  of `59cf53e54c78` + characters at UTF-16 positions `[4,7,20]` (missing = `0`)
  + Claude Code version. Format is
  `x-anthropic-billing-header: cc_version=X.Y.Z.sss; cc_entrypoint=sdk-cli; cch=hhhhh;`.
  Empty first-user text means no added billing block. Replace `node:crypto`
  with asynchronous Web Crypto; do not reinterpret the indexing as code points.
- [`system-prompt-shaping.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/system-prompt-shaping.ts),
  [`system-prompt-sections.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/system-prompt-sections.ts),
  [`constants.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/constants.ts):
  conservatively parse Pi's tagged sections. Replace the recognized Pi preamble,
  drop Pi docs only when the known anchor occurs, remove tool filler, and apply
  one text substitution only in Pi-owned sections. Preserve project/custom
  sections and unknown/unstructured prompts. Shape framed system updates too.
- [`claude-code-version.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/claude-code-version.ts)
  uses `2.1.280` as a floor. [`billing-version-sync.ts`](https://unpkg.com/@gotgenes/pi-anthropic-auth@3.4.3/src/billing-version-sync.ts)
  raises to a newer wire user-agent version, learns server-required floors and
  retries certain 400s once. This port will retain wire-version alignment and
  an explicit version option, but **not** learned floors, error rewriting, or
  adapter-owned retries. Rejections will remain visible and require an explicit
  configuration/dependency update.
- CLI entrypoint, filesystem config, diagnostics/account profiling, environment
  variables, process-level state and extension loader aliases are unnecessary
  and must not be imported by Worker code.

## Implementation decision and limits

Implement a small provider decorator plus `installAnthropicOAuth(models)` for
only the existing `anthropic` provider. Both stream APIs will use the same
OAuth-only options composition. API-key and other-provider paths retain their
original options, fetch and payload hooks. Use no runtime dependencies (pi-ai
is a type-only peer), only Web APIs. Port the pure parser/rules with MIT notice.
Align only billing text generated by this adapter with a newer wire user-agent;
leave caller-supplied billing markers alone. Never read/clone a response.

Tests must cover known hash vectors, prompt/custom-context preservation,
mid-conversation effort/tool updates, caller-hook composition, collection auth
resolution, both stream APIs, passthrough, incremental SSE/tools, HTTP failures,
version errors and abort. Bundle/runtime checks should distinguish this
adapter's Web-only graph from pi-ai's larger dependency graph.

**Evidence boundary:** Upstream describes this as subscription compatibility;
that is an upstream assertion, not proof of present Anthropic acceptance or
billing treatment. The billing string is an unofficial client-identity recipe,
not a contractual routing guarantee. No live OAuth request, plan-limit debit,
extra-usage charge, login/refresh or subscription success has been tested here.
Use must comply with Anthropic's current terms and OAuth policy; API-key usage
remains the supported fallback. MIT licensing is not service authorization.


## Official authentication policy (primary-source check)

Read [Claude Code legal and compliance, Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)
and [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
during this research (both returned HTTP 200). The documentation states:

> Developers building products or services that interact with Claude’s
> capabilities, including those using the Agent SDK, should use API key
> authentication through Claude Console or a supported cloud provider.

It also explicitly says third-party developers may not offer Claude.ai login in
their applications or route Free/Pro/Max credentials on users' behalf, may not
collect/store/intermediate Claude.ai credentials or session tokens, and that
Anthropic may enforce restrictions without prior notice. The Consumer Terms
also prohibit sharing account credentials or making one's account available to
others. These are not hypothetical billing caveats: public availability of this
MIT-licensed prototype is **not authorization** to deploy third-party
subscription login. Obtain Anthropic authorization for the intended use; use API
keys otherwise. No target integration or live account probe was performed.

## Validation findings

The implemented tests use pi-ai 1.2.0's actual SDK with fake credentials and mock
HTTP, plus real local workerd. They confirm both stream methods, incremental
text/tool delivery, error propagation, and Web Crypto behavior. The standalone
adapter bundles without runtime imports and runs without `nodejs_compat`; the
full pi-ai SDK integration probe uses `nodejs_compat` because of **upstream**
dependencies. This does not prove the full pi-ai dependency graph is Node-free.

pi-ai's collection returns an error result for cancellation during auth, before
provider dispatch; the adapter preserves that behavior. Mid-stream cancellation
is a provider `aborted` result. A fake OAuth auth implementation separately tests
that collection-owned refresh still runs and the refreshed access token reaches
the wrapper. Neither test is a real Anthropic login or refresh validation.

Final local validation: `npm ci`, `npm run check`, `npm run build`, `npm test`
(**50 tests in 4 files passed**), `npm audit` (**0 vulnerabilities**), and
`npm pack --dry-run --ignore-scripts` (generated entrypoint, declarations,
README, research, license and attribution present; no publication). Local
Node was v24.22.0. GitHub CI is configured but has not run remotely. The target
app's Git working tree remained unchanged.
