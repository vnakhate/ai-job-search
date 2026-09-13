# JobPilot — hosted agentic job search

A Cloudflare Workers application with a responsive paid web workspace and a native SwiftUI iOS controller. It adds a product layer to this repository; existing local workflows, CV templates and portal CLIs remain intact.

## Run locally

Requires Node 22.12+ (Node 24 LTS recommended) and npm.

```sh
cd platform
npm ci
npm run dev
```

Open **http://localhost:8797**. The explicit `local` environment uses labelled fixture jobs and fixture model responses. It does not charge Stripe, invoke Workers AI, or send applications. Enter a synthetic profile, start a search, pause/resume it, review the shortlist, then approve eligible roles to generate text drafts. State persists in `.wrangler/state`. The production environment has no demo bypass.

## What works

- OAuth authorization-code + PKCE on web and iOS; server validation of RS256 issuer, audience, expiry and subject. Auth0-compatible issuer and separate SPA/native clients.
- Per-user Durable Object ownership, candidate profiles, up to 30 stored runs, and separate durable run records. No caller-provided tenant ID is trusted.
- Durable background steps: model plans the query → Freehire searches → model evaluates each posting → user reviews → model drafts approved roles.
- Eight postings per run, three attempts per step, 20 reserved model calls per run, 60 new runs per calendar month. A single unfinished run per account keeps controls and billing predictable. These are configurable product defaults, not a finalized commercial offer.
- Work-rights and language gates before drafting, verbatim source-quote validation, explicit uncertainty, preserved profile snapshots, bounded retries, and no automatic submission capability.
- Stripe recurring checkout, customer portal and signed webhook verification. Entitlements derive from current subscription state for the configured price, not a checkout redirect or webhook delivery order.
- Shared web/iOS start, pause, resume, retry, cancel, shortlist review, drafts and history. Pause takes effect after the current bounded step (up to about 25 seconds).
- Inspectable timelines and validated exports using the actual `@orcareplay/core` and `@orcareplay/schema` packages.

## Production setup

1. Set `APP_ORIGIN` to the exact HTTPS origin with no trailing slash in `wrangler.jsonc`. Set `DEMO_MODE` to `false` (already the production default).
2. In Auth0 create an API with RS256 tokens and an audience identifier. Configure `OIDC_ISSUER` (with trailing slash) and `OIDC_AUDIENCE`. Create a **SPA** application with token endpoint authentication set to None; set `OIDC_CLIENT_ID`. Allow `APP_ORIGIN + '/'` as its callback and `APP_ORIGIN` as its web origin/CORS origin.
3. Create a separate **Native** Auth0 application, also without a client secret, and set `OIDC_IOS_CLIENT_ID`. Register `jobpilot://oauth` as its callback. Use the same API audience and shared identity connection so both clients receive the same user subject. Access tokens expire normally; sign out and sign in again to renew. Refresh-token rotation is not implemented.
4. Create a recurring Stripe price and set `STRIPE_PRICE_ID`. Configure the Stripe customer portal. Install secrets using `npx wrangler secret put STRIPE_SECRET_KEY --env=""` and `npx wrangler secret put STRIPE_WEBHOOK_SECRET --env=""`. Start with Stripe test mode.
5. Register `APP_ORIGIN + '/api/billing/webhook'` for `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Copy that endpoint's signing secret into the Worker.
6. Authenticate Wrangler with the intended Cloudflare account. The config binds Workers AI, static assets, and SQLite-backed Durable Objects; no D1 migration, R2 bucket, or separate server is required. Review provider terms and costs for the selected Workers AI model and Freehire before offering live service.
7. Run `npm run check`, then `npm run deploy`. Preflight rejects incomplete public settings. It does not verify installed secrets or provision billing/authentication providers. Validate the complete signed-in, paid journey in staging before a public launch.

The production worker uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Candidate facts and relevant posting text go to Workers AI. Provider credentials never enter prompts or trace exports. A hosted Auth0 custom domain requires adjusting `web/public/_headers`'s `connect-src` as well as the issuer. The native app uses the system sign-in session and stores access tokens per server in Keychain.

## iOS

```sh
python3 ios/generate-project.py
open ios/JobPilot.xcodeproj
```

Select your development team, replace `com.example.jobpilot` with your bundle identifier, install an iOS simulator runtime through Xcode, and run the app. The simulator's local server URL is `http://localhost:8797`; a physical device should use your deployed HTTPS origin. Release builds reject HTTP server URLs. The app controls an existing account and includes no purchase link or StoreKit implementation.

SDK-only compilation, useful when a simulator runtime is absent:

```sh
xcrun swiftc -typecheck -parse-as-library \
  -target arm64-apple-ios17.0-simulator \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -module-cache-path /tmp/jobpilot-swift-cache -D DEBUG \
  ios/JobPilot/JobPilotApp.swift
```

This validates Swift/SwiftUI source, not simulator execution or App Store readiness. Signing, app icons, privacy disclosures, account deletion, purchase-policy review, and a TestFlight/device test remain release work. No Apple or Cloudflare resource has been published by this change.

## OrcaReplay integration

[OrcaReplay](https://github.com/Continuum-AI-Corp/OrcaReplay) is an actual pinned development dependency (`0.2.4`), not a copied brand or an invented runtime API. The Worker stores schema-compatible audit summaries; a local exporter uses Orca's `TraceWriter` for validation, write-path redaction, blob handling and integrity hashes:

```sh
# Download a completed/cancelled run's JSON from the web timeline first.
npm run orca:export -- /absolute/path/run_export.json
# Inspect the resulting trace with an installed Orca CLI:
orca show run_<id>
orca export run_<id> -o audit.html
```

Exports intentionally omit private candidate profiles, raw prompts, model response bodies and tool result bodies. The browser timeline replays **recorded activity**, without executing tools or calling a model. These audit exports do **not** support Orca's byte-exact execution replay, model forks, or checkpoint comparison. That requires a separate capture adapter storing provider exchanges and the state needed by the replay runner. The Node CLI's process/filesystem capture does not run inside Workers. Original timestamps are retained in event attributes; export time is the Orca container's timeline clock.

Orca main's newer `agent.*` event types are absent in published schema 0.2.4. This integration deliberately uses its supported `note` events instead. An executable test checks the real published schema and writer.

## Harness engineering

[Ryan Lopopolo's harness-engineering](https://github.com/lopopolo/harness-engineering) is a methodology/context corpus, not an installable orchestration library. Its authority and proof guidance informed explicit tool permissions, credential separation, durable recovery, bounded inference, review receipts, and tests tied to observable user journeys. See [the architecture and evidence map](docs/architecture.md) and [third-party attribution](THIRD_PARTY_NOTICES.md).

The build reads evaluation and writing methodology from `.claude/skills/job-application-assistant/`, maintaining the repository's canonical ownership. Each run records the context digest. `CLAUDE.md`, candidate identity files, CVs, cover letters and local trackers are not bundled. **Review shared methodology before deployment if `/setup` has personalized those files**; the template's scoring notes may contain candidate-specific values after setup. Hosted users supply their own profile; the repository profile remains unfilled.

## Verification

```sh
npm run check
# Install the test browser once; UAT starts its own isolated Worker:
npx playwright install chromium
npm run test:uat
# No upload or resource provisioning:
npx wrangler deploy --dry-run --env="" --outdir /tmp/jobpilot-worker-build
```

Unit/contract tests cover the actual account state machine, authentication, gates, billing signatures and real Orca package compatibility. The desktop/mobile UAT suite starts a separate local Worker on port 8798 with temporary state, so it never mutates the interactive demo. Its lifecycle scenarios use the real Worker runtime with fixture providers. One explicitly named error-display test injects an HTTP failure. See [the UAT matrix and staging/native acceptance procedure](docs/uat.md). `tests/cloudflare-stub.ts` only substitutes the Durable Object base class for fast unit tests; native alarms are exercised by the browser journey.

## Boundaries of this version

This is a working initial product, not a launched paid service. Live authentication, Stripe checkout/webhook delivery and Workers AI quality/cost need configured end-to-end tests. Freehire is the first production connector, scoped to tech roles; the existing Bun-based LinkedIn/Danish portal CLIs are not hosted inside Workers. Closed, stale, duplicate and malformed source results are filtered. Repeat source IDs in the last 30 runs are excluded in live mode; a long-term cross-portal deduplication index is not implemented.

Drafts are unverified cover-letter text and suggested CV bullets, not the existing compiled, visually verified LaTeX/PDF application workflow. Unverified work rights cannot be approved for drafting; role-level employer research is a follow-on capability. Model-generated eligibility is evidence-checked but still needs human judgment. There is no employer messaging, portal auto-apply, arbitrary browsing, recurring search schedule, push notification, resume upload, StoreKit purchase, or full Orca execution replay.
