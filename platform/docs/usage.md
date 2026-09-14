# Using JobPilot

JobPilot turns a candidate profile into a reviewed shortlist of job postings and, for the roles you approve, unverified application text drafts. It searches, evaluates and drafts on your behalf; it never contacts an employer or submits an application. This guide covers the web workspace, the iOS controller and the API. For deployment, see [the platform README](../README.md); for the architecture and evidence map, see [architecture.md](architecture.md).

## 1. Start the local demo

Requires Node 22.12 or newer and npm.

```sh
cd platform
npm ci
npm run dev
```

Open <http://localhost:8797>. The header shows **LOCAL DEMO · FIXTURE DATA**: there is no sign-in, searches return two labelled fixture postings, model calls return fixture text, and payments are disabled. State persists in `platform/.wrangler/state` between restarts, so runs you make today are still in Run history tomorrow. Demo mode only activates when `DEMO_MODE` is `true` **and** `APP_ORIGIN` is a localhost address; production has no demo bypass.

Stop the server with Ctrl-C in the terminal that started it.

## 2. The workspace

The web app has four pages, reachable from the left sidebar.

| Page | What it is for |
| --- | --- |
| **Mission control** | The current run: status chip, stats, the opportunity shortlist, the agent's activity timeline, and the run controls. This is where you start searches, review shortlists and read drafts. |
| **Your profile** | The facts the agent works from. Saved once per account; each run stores its own snapshot so later profile edits do not alter a run in progress. |
| **Run history** | Your latest 30 runs with decisions and drafts preserved. Selecting one opens it in Mission control. |
| **Membership** | Subscription status and the Stripe checkout or customer-portal link. Disabled in the local demo. |

In production the first screen is **Sign in to your workspace**, which uses an Auth0 authorization-code flow with PKCE. Access tokens are kept in session storage and expire normally; **Sign out** in the header clears the session. There is no refresh-token rotation, so an expired session simply asks you to sign in again.

## 3. Your first search, step by step

### Step 1: Save a profile

Open **Your profile** and fill in every field except deal-breakers, which is optional.

| Field | Rule |
| --- | --- |
| Your name | 1 to 100 characters |
| Target role | 2 to 150 characters; the demo uses it as the search query |
| Country | Two uppercase letters, for example `US`, `GB`, `DK` |
| Skills you can demonstrate | 2 to 2000 characters |
| Your actual experience | At least 20 characters |
| Languages and proficiency | 2 to 1000 characters |
| Citizenship / work authorization | 2 to 1500 characters; drives the eligibility gate |
| Deal-breakers and preferences | Optional, up to 1500 characters |
| Remote roles only | Checkbox |

The form is validated in the browser and again by the Worker. Saving returns you to Mission control with a confirmation notice.

### Step 2: Start a run

Press **＋ New search** on Mission control. The button is disabled while any run is running, paused, awaiting review, or failed: an account has one unfinished run at a time. Starting a run reserves one of your 60 monthly searches immediately, even if you cancel it later.

The agent then works through three bounded stages, each visible in the **Behind the scenes** timeline:

1. **Plan**: the model turns your profile into a focused search query.
2. **Search**: the Worker queries Freehire for your country and the plan's query, keeping up to eight postings. In live mode, postings already seen in your last 30 runs are dropped.
3. **Evaluate**: one posting at a time, the model scores fit from 0 to 100 and applies two gates: work rights (`PASS`, `FAIL` or `UNVERIFIED`) and language (`PASS`, `FAIL` or `FLAG`). Every evidence line must be a verbatim quote from the posting, or the step fails and is retried. A `FAIL` on either gate forces the score to 0.

The page polls every four seconds while a run is active. When evaluation finishes the status chip changes to **Needs your review**.

### Step 3: Review the shortlist

Each opportunity card shows the score, the two gate tags, the model's reason, and an expandable **See evidence & gaps** section with the quoted posting text. Cards for roles you may draft carry a **Prepare draft** checkbox. A role is draftable only when work rights are `PASS` and language is not `FAIL`; everything else shows **Not cleared for drafting** and cannot be selected. `UNVERIFIED` work rights therefore block drafting until you research the role yourself.

Tick the roles you want, then press **Finish review & prepare drafts**. Submitting no roles is valid: the run completes with no drafts and you can start a new search.

### Step 4: Read the drafts

The run moves through a **Draft** stage, one approved role at a time, and finishes as **completed** with the timeline entry "Run completed; nothing submitted". Each approved card gains a **Read application draft** expander containing a cover-letter draft, suggested CV bullets and verification notes. Treat these as text drafts: the model has not verified the employer, the posting's availability or any company fact, and the drafts are not the compiled, PDF-verified documents produced by the repository's local LaTeX workflow.

## 4. Controls, statuses and limits

### Run controls

The controls appear in the mission card and act at the next step boundary. A step is bounded to roughly 25 seconds, so a pause or cancel may take that long to show; a model request already sent is not aborted.

| Control | Available when | Effect |
| --- | --- | --- |
| **Pause** | running | Finishes the current step, then stops. No model calls are spent while paused. |
| **Resume** | paused | Continues from the stored stage and cursor. Needs an active membership in production and remaining model-call budget. |
| **Retry** | failed | Clears the error and re-runs the failed step, counting against the three-attempt limit for that step. |
| **Cancel run** | anything except completed or cancelled | Ends the run permanently; it stays in history and can be exported. |

### Statuses

`running` → `review` → `running` (drafting) → `completed`, with `paused`, `failed` and `cancelled` as side exits. A `failed` run shows its error in red above the stats, for example "Model evidence was not found in the posting" or "This step reached its three-attempt limit".

### Limits

These are product defaults, not a finalized commercial offer.

| Limit | Value |
| --- | --- |
| New runs per calendar month | 60, reserved at start |
| Postings per run | 8 |
| Model calls per run | 20, reserved before each request |
| Attempts per step | 3 |
| Runs kept in history | 30 |
| Unfinished runs per account | 1 |
| Request body size | 40 KB |

A run also fails if the evaluation methodology bundled into the Worker changes underneath it; cancel it and start a new search.

## 5. Timeline and audit export

**↺ Inspect run timeline** on Mission control opens a scrubber over the run's recorded events. Playback replays what was recorded; it does not call a model or repeat a tool. **Download Orca audit export** saves `run_<id>.json` in the `jobpilot-audit-v1` format: event summaries only, with no profile data, prompts, model bodies or credentials.

To seal that export as an OrcaReplay trace, the run must be completed or cancelled:

```sh
cd platform
npm run orca:export -- /absolute/path/run_<id>.json
orca show run_<id>          # with an installed Orca CLI
orca export run_<id> -o audit.html
```

The trace supports inspection, not byte-exact execution replay.

## 6. The iOS controller

The SwiftUI app controls an existing account; it has no purchase flow.

```sh
cd platform
python3 ios/generate-project.py
open ios/JobPilot.xcodeproj
```

- **Settings**: enter the server URL (`http://localhost:8797` for the simulator against the local demo; your HTTPS origin for a device, since release builds reject HTTP), sign in, and see monthly usage. **Sign out** clears the Keychain token for that server.
- **Profile**: the same fields as the web form.
- **Mission**: **Start a new search**, then the run list. A run's detail screen offers Pause, Resume, Retry and Cancel, the opportunity list with approval toggles, **Finish review & prepare drafts**, drafts, and the run timeline.

Web and iOS share one account and one durable run, so a run started on the web can be paused on the phone and cancelled on the web.

## 7. Membership (production only)

Starting, resuming, retrying or reviewing a run in production requires an active subscription. **View price & subscribe** on the Membership page opens Stripe Checkout; once subscribed the same button becomes **Manage membership** and opens the Stripe customer portal. Entitlement is derived from the current subscription state for the configured price each time Stripe notifies the Worker, so the order in which webhooks arrive does not matter. No price is shown in the app; Stripe displays it at checkout.

## 8. API reference

All routes live under `/api`. Outside the demo, every route except `config`, `health` and the billing webhook requires `Authorization: Bearer <access token>`. Browser requests must carry the configured `APP_ORIGIN` as their origin. Responses are JSON and never cached.

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Liveness: `{"ok":true,"service":"jobpilot"}` |
| `GET /api/config` | Demo flag and OAuth issuer, client IDs and audience for the clients |
| `GET /api/account` | Profile, entitlement, monthly usage, and all stored runs without profile snapshots or posting bodies |
| `PUT /api/profile` | Replace the profile; body must match the profile schema exactly |
| `POST /api/runs` | Start a run. Body `{"requestId":"<uuid>"}`; repeating a UUID returns the existing run instead of reserving quota twice. Returns 201. |
| `GET /api/runs/:id` | One run |
| `POST /api/runs/:id/control` | Body `{"action":"pause"\|"resume"\|"cancel"\|"retry"}` |
| `POST /api/runs/:id/decisions` | Body `{"approvedIds":[...]}`, up to 8 unique IDs of draftable jobs; only while the run is in review |
| `GET /api/runs/:id/trace` | Audit export in `jobpilot-audit-v1` format |
| `POST /api/billing/checkout` | Create a Stripe Checkout session; returns `{"url"}` |
| `POST /api/billing/portal` | Create a Stripe customer-portal session; returns `{"url"}` |
| `POST /api/billing/sync` | Re-read the current Stripe subscription |
| `POST /api/billing/webhook` | Stripe webhook; verified by signature, no bearer token |

### Error codes

| Status | Meaning |
| --- | --- |
| 400 | Invalid input (details listed), malformed JSON, ineligible approval, or bad webhook signature |
| 401 | Missing or expired token |
| 402 | Active subscription required |
| 403 | Origin not allowed, or demo called from a non-local host |
| 404 | Unknown route or run |
| 409 | State conflict: no profile yet, another run unfinished, control not valid for the run's status, model budget exhausted, run not in review, or billing disabled in demo |
| 413 | Body over 40 KB |
| 429 | Monthly run allowance reached |
| 503 | Authentication, price or webhook not configured |

## 9. Verify a change

```sh
cd platform
npm run check            # context build, type check, 66 unit/contract tests, web build
npx playwright install chromium   # once
npm run test:uat         # 9 scenarios × desktop and mobile, on an isolated Worker at :8798
```

UAT never touches the interactive demo on port 8797. See [uat.md](uat.md) for the scenario matrix and the manual staging cases that still need a deployed origin.

## 10. What JobPilot does not do

No automatic submission, employer messaging, portal auto-apply, arbitrary browsing, scheduled searches, push notifications, resume upload or in-app purchase. Drafts are unverified text, not the repository's compiled and visually checked CV and cover-letter PDFs. The full list of boundaries is in [the README](../README.md#boundaries-of-this-version).
