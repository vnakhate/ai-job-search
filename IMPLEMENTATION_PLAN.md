# Implementation plan: close the gaps between JobPilot and the local workflow

Branch: `codex/jobpilot-cloudflare`. Started 2026-09-14.

## Gap analysis (web solution vs the slash-command workflow)

| Gap | Severity for a live job seeker | Decision |
| --- | --- | --- |
| No bridge from a JobPilot run into the local tracker and seen-jobs file; approved roles and drafts die in the browser | High: the hosted app finds and triages, the local workflow applies, and nothing connects them | **Implement** (stages 1 to 3) |
| Single job source (Freehire, tech only); portal CLIs are Bun scrapers that cannot run in Workers | High for non-tech seekers | Out of scope: documented boundary in `platform/README.md` |
| One model-written keyword query per run, semantic matching off | Medium | Deferred: eight postings per run caps recall anyway; revisit with the source gap |
| Drafts are text, not the compiled and verified PDFs | Medium | Out of scope by design: the local `/apply` owns document production |
| No outcome tracking, follow-ups or interview prep in-app | Medium | Covered by the bridge: these live in the local workflow once a run is imported |
| No company research | Low | Out of scope: the local reviewer agent owns it |
| Live model quality, Auth0 and Stripe unverified | High before launch | Blocked on deployment; tracked in `platform/docs/uat.md` |

## Stage 1: Handoff export from the Worker and web UI
**Goal**: `GET /api/runs/:id/handoff` returns a `jobpilot-handoff-v1` bundle (run id, status, query, every evaluated posting with verbatim description, evaluation, decision and draft; never the profile snapshot), and the web timeline offers an "Export for /apply" download.
**Success Criteria**: A user who finished a run can download one JSON file containing everything the local workflow needs to re-score and apply.
**Tests**: Vitest contract test on the route (content, profile exclusion, 404); Playwright journey test on the download.
**Status**: Complete

## Stage 2: Local import tool
**Goal**: `python3 tools/import_jobpilot.py <handoff.json>` adds each posting to `job_scraper/seen_jobs.json` under the canonical `tools/job_key.py` key with `status: new`, a fit band derived from the JobPilot score and gates, `portal: jobpilot`, and `source: jobpilot`; skips postings already present by URL or key; writes atomically; supports `--dry-run`.
**Success Criteria**: After import, `/rank` picks the postings up as new candidates and `/scrape` dedupes against them.
**Tests**: unittest suite covering import, fit mapping, duplicate skipping, format rejection, missing state file, dry run.
**Status**: Complete

## Stage 3: Documentation
**Goal**: usage guide, UAT matrix, platform README, both explainers and `docs/how-it-works.md` describe the bridge and no longer claim it is missing.
**Success Criteria**: A reader can follow the export-then-import path end to end from the docs.
**Tests**: Repo lint and unit suites stay green; `npm run check` and UAT pass.
**Status**: Complete

## Stage 4: Applicant usability, first cut (items 1 to 5)
**Goal**: Profile save names the rejected field and the form mirrors the schema limits; drafts get copy and Markdown download controls; job cards show the posting's age; a blocked role says why; the handoff download shows the import command.
**Success Criteria**: A candidate can fix a rejected profile without guessing, reuse a draft in two clicks, see how fresh a posting is, know what to do about a blocked role, and find the import step without reading the docs.
**Tests**: Vitest for the shared `postedLabel` and `blockReason` helpers; Playwright for the surfaced validation detail, form limits, clipboard copy, draft download, posting age, blocked reason and export hint.
**Status**: Complete

## Stage 5: Mark as applied (item 6)
**Goal**: `POST /api/runs/:id/applied` records or clears an applied date on one posting; the card shows "Applied on <date>" with an undo; history rows count applied postings; the handoff bundle carries the field.
**Success Criteria**: A candidate can see at a glance which shortlisted roles they already sent, across reloads and devices.
**Tests**: Vitest for the route (set, clear, unknown posting, event recorded, bundle passthrough); Playwright for marking, persistence and the history count.
**Status**: Complete
