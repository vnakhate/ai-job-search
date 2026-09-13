# Verification — 2026-09-13

## Updated unit and UAT suite

- `npm run check`: **66 unit/contract tests passed** across four files; Worker/web type checks and production web build passed.
- `UAT_BROWSER_CHANNEL=chrome npm run test:uat`: **18 UAT executions passed** (nine scenarios in desktop and iPhone-sized Chromium projects) in about 50 seconds.
- UAT started its own Worker on port 8798 with temporary state and shut it down afterwards; the interactive demo account on port 8797 was not used.
- A new billing regression test exposed an unrelated subscription item extending an expired JobPilot entitlement. The calculation now considers only the configured price when deriving item-level expiry; the regression passes.
- GitHub CI passed on branch `codex/jobpilot-cloudflare` at implementation commit `ef898be`: [JobPilot platform run 34763864355](https://github.com/vnakhate/ai-job-search/actions/runs/34763864355). This includes unit/contract tests, type checking, build, Worker deployment dry run and desktop/mobile UAT. Reports are uploaded as workflow artifacts.
- Cloudflare deployment remains pending: the existing OAuth token has Pages permissions but lacks Workers/AI deployment access, and the attempted authorization refresh timed out. Auth0 and Stripe settings also remain unconfigured. No public Worker was deployed.
- See [the UAT matrix](uat.md) for commands and the still-pending live-service/native acceptance cases.

## Initial platform verification baseline

The following checks were recorded during the initial implementation, before the test-suite expansion above.

| Check | Result | Claim boundary |
| --- | --- | --- |
| TypeScript `tsc --noEmit` | Passed | Worker and web source contracts |
| Vitest | 25 tests passed | State machine, JWT validation, account isolation, payment gating, Stripe HMAC, quotas, retention, source validation, evidence rejection, real Orca writer/schema |
| Vite production build | Passed | Web assets built successfully |
| Playwright / installed Chrome | Passed, desktop + 390px mobile | Real local Worker; profile → start → pause → reload → resume → review → draft, timeline, disabled demo billing, no browser JS errors or horizontal overflow |
| Wrangler production dry run | Passed, ~853 KiB Worker / ~146 KiB gzip | Worker bundles with static assets, Durable Object and Workers AI bindings; **no deployment performed** |
| Swift compiler + iOS 26.4 Simulator SDK | Passed targeting iOS 17+ | Native source compiles against SwiftUI, Keychain, CryptoKit and AuthenticationServices |
| Native Xcode/simulator execution | Not run successfully | Xcode reports iOS 26.4 platform/runtime unavailable; no runnable simulator devices |
| Freehire live request | Passed | Public `/api/v1/agent/jobs/search` returned `{data,meta}` with expected fields |
| npm dependency audit | Zero known vulnerabilities after updating Vitest | Installed dependency snapshot |
| Deployment preflight | Correctly rejected placeholder APP_ORIGIN | Incomplete configuration cannot pass the npm deploy entrypoint |
| `git diff --check` | Passed | No whitespace errors |

The updated suite writes screenshots to per-test directories under `platform/test-results/` and its HTML report to `platform/playwright-report/index.html`. These are ignored build evidence; the old single-journey screenshot paths and shared-server procedure are superseded.

Still unverified: live Workers AI generation and model quality; a real Auth0 login across both clients; real Stripe checkout, cancellation and webhook delivery; Cloudflare deployment health; iOS device/simulator operation and TestFlight distribution. The local test fixture is clearly labelled and never used as a production fallback. Orca interoperability proves audit export/read compatibility, not execution replay or model forking.
