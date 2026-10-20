# Reusable Cloudflare Anthropic adapter

## Problem Statement
The Pi CLI auth extension cannot be loaded directly by pi-durable on Workers. Users need a small reusable integration rather than reimplementing its transport compatibility changes.

## Solution
Publish an attributed, experimental MIT TypeScript adapter on GitHub, installable from a pinned Git commit, and integrate it into the existing private deployment. No npm release is requested.

## User Stories
1. As a pi-durable owner, I want one installation call so I can retain my existing provider collection.
2. As an API-key user, I want unchanged requests so OAuth shaping does not affect my billing path.
3. As an OAuth user, I want consistent shaping across both stream APIs.
4. As a Worker operator, I want Web API-only code so I do not need a CLI filesystem or extension loader.
5. As a maintainer, I want automated tests and CI so changes cannot silently break passthrough or streaming.
6. As a downstream developer, I want install instructions and upstream attribution so I can reuse the package responsibly.
7. As an account owner, I want explicit policy and billing caveats rather than a promise of subscription acceptance.
8. As the deployment owner, I want pinned dependencies and conventional commits so I can reproduce or roll back the integration.

## Scenarios
Executable coverage lives in the framework-native test suite.

- Given an existing Anthropic provider and resolved OAuth credentials, when either stream API is called, then compatible payload shaping runs and events remain streamed.
- Given API-key credentials, when the provider streams, then OAuth shaping does not change the request.
- Given another provider, when it is used, then its behavior remains unchanged.
- Given a Worker runtime, when the adapter runs, then no Node filesystem or CLI loader is required.
- Given stream cancellation or an upstream error, when it occurs, then the original cancellation/error semantics remain observable.
- Given invalid version configuration, when the adapter is installed, then installation fails clearly.

## Implementation Decisions
Use provider-local decoration of the existing mutable model collection. Keep login, refresh, credentials, catalog, SDK transport parsing and retries upstream-owned. Do not patch global fetch. Export installation and provider-wrapper entry points. Integrate only the Anthropic provider and pin the published Git source in the deployment.

## Testing Decisions
Test observable behavior at the provider/model collection boundary with mocked network credentials. Exercise real pi-ai SDK streaming and local workerd. Run target app tests, checks and deployment, then confirm unauthenticated production routes remain protected. No real subscription success or billing claim without account-level evidence.

## Out of Scope
Npm publication, alternative provider aliases, CLI commands/config loading, guaranteed subscription billing, upstream learned-version retry behavior, and changes to Cloudflare Access.

## Further Notes
Anthropic policy restrictions are documented in the README. This code does not grant authorization or alter entitlements. Live subscription acceptance remains unverified.
