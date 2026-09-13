# JobPilot acceptance tests

## Run locally

```sh
cd platform
npm ci
npm run test:unit
npx playwright install chromium
npm run test:uat
```

With an existing Chrome installation, use `UAT_BROWSER_CHANNEL=chrome npm run test:uat` instead of downloading Chromium. `npm run test:browser` remains an alias.

UAT builds the current code, starts its own local Worker on **http://localhost:8798**, and uses a fresh temporary directory for Durable Object storage. It never reuses the interactive demo on port 8797. It removes its temporary state when the server stops. Port 8798 and inspector port 9248 must be available; an existing server causes a failure instead of being reused. Tests run serially and restore a synthetic candidate profile before each scenario. Only unfinished runs within that dedicated fixture account are cancelled between scenarios.

The suite runs every scenario in desktop Chrome/Chromium and an iPhone-sized **Chromium emulation**, not native iOS or Safari. UAT uses real local Worker HTTP routes and Durable Objects with explicit fixture search/model providers. Only the network-failure display scenario intercepts a response; this is named in the test and never counted as provider availability evidence.

## Automated acceptance matrix

| Scenario | Observable acceptance |
| --- | --- |
| Profile validation and persistence | Invalid country cannot save; valid edits and remote preference survive reload |
| Pause/reload/resume | Same durable run survives reload without spending calls while paused |
| Shortlist and approved drafts | Ineligible role is disabled; exact posting evidence visible; only selected role gets a draft |
| Reject all | Run completes with no drafts and allows a new search |
| Cancellation and history | Cancel persists; historical run opens; no resume offered |
| Audit download | Correct run ID, terminal boundaries, no candidate experience, explicit audit-only scope |
| Service error | Error visible; start controls recover; no ghost run or quota consumption |
| Demo membership | Disabled payment UI and rejected direct checkout/portal API requests |
| Untrusted text | HTML-shaped profile data displays literally and executes no script |
| Concurrent creation | Identical UUIDs reserve one run; competing runs conflict without double quota use |
| API rejection boundaries | Unsafe origin, malformed JSON, oversized body and missing run produce correct errors; account responses are not cached |

The 9 Playwright tests cover these criteria in two viewport projects, for **18 automated UAT executions**. Unit/contract tests separately exercise production JWT claims, OAuth PKCE, Stripe signatures/checkout/subscription states, retry budgets, evidence validation, methodology changes and actual Orca writer integrity.

## Evidence

`playwright-report/index.html` is the HTML report. Failed cases retain screenshots and Playwright traces under `test-results/`. Successful reviewed-draft journeys also save a screenshot per project. Use `npx playwright show-report` or `npx playwright show-trace <trace.zip>` to inspect failures. CI runs both the unit/check suite and UAT, then uploads the reports as `jobpilot-uat-results` for 14 days, including on failure. No CI step publishes the Worker or invokes paid generation.

## Configured-service and native acceptance (manual, pending)

Use synthetic staging identities and Stripe **test mode**, with the deployed staging origin. Record actual evidence for each case; these have not been verified merely because local tests pass.

| Case | Procedure | Expected result |
| --- | --- | --- |
| Shared web/iOS identity | Sign in with the same test identity using SPA and native OAuth clients | Both clients show the same profile and run IDs |
| Token expiry | Expire/revoke a staging session and attempt an authenticated action | API denies access; signing in again restores permitted access |
| Membership activation | Complete Stripe test checkout; deliver the signed webhook | Entitlement becomes active and starting a run is allowed |
| Billing delivery/revocation | Retry/reorder recorded test webhooks, then cancel/expire the subscription | Current Stripe state governs access; stale events do not restore entitlement |
| Live model and search | Run with production provider bindings using a synthetic profile | Actual sourced postings, valid evidence, visible failure for provider outages; no demo fallback |
| Cross-client controls | Start on web, pause/resume on iOS, then cancel on web | Same run transitions on both clients; no later step after the persisted cancellation |
| Native review | On iOS select only eligible roles and finish review | Only selected roles get drafts; failed/unknown eligibility remains blocked |
| Native recovery | Background/terminate the app during a run and reopen | Server work survives; reload retrieves the current state |
| Native credential handling | Sign out and reconnect to another server/account | Tokens remain server-scoped in Keychain; no previous account data shown |
| Physical device layout | Use an installed simulator runtime and a signed physical-device build | Readable controls, profile keyboard behavior, usable expanded evidence/drafts and landscape layout |

The current machine previously reported an unavailable iOS simulator runtime. Mobile browser UAT does not satisfy native simulator/device acceptance, payment-provider verification, live model-quality review, or Orca execution replay compatibility.
