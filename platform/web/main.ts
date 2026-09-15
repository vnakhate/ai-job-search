import "./style.css";
import { type Config, login, callback, token, logout } from "./auth";
import {
  type Account,
  type Run,
  type Job,
  canDraft,
  safeUrl,
  postedLabel,
  blockReason,
} from "../worker/contracts";
const root = document.querySelector<HTMLDivElement>("#app")!;
let config: Config;
let account: (Account & { demo: boolean; limit: number }) | undefined;
let tab = "overview";
let selectedRun: string | undefined;
let busy = false;
let notice = "";
let traceIndex = 0;
let traceRun: string | undefined;
let replayTimer: ReturnType<typeof setInterval> | undefined;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const status = (r?: Run) =>
  r?.status === "review"
    ? "Needs your review"
    : r?.status || "Ready when you are";
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token() ? { Authorization: "Bearer " + token() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await r.json()) as any;
  if (!r.ok)
    throw new Error(
      Array.isArray(data.details) && data.details.length
        ? `${data.error}: ${data.details.join("; ")}`
        : data.error || "Request failed",
    );
  return data;
}
function active() {
  return account?.runs.find((r) => r.id === selectedRun) || account?.runs[0];
}
function shell(content: string) {
  root.innerHTML = `<aside><a class="brand" href="/" aria-label="JobPilot home"><span class="brand-icon">↗</span> JobPilot<span class="beta">BETA</span></a><div class="workspace">YOUR WORKSPACE</div><nav>${[
    ["overview", "◈", "Mission control"],
    ["profile", "◎", "Your profile"],
    ["history", "↺", "Run history"],
    ["billing", "▤", "Membership"],
  ]
    .map(
      ([id, icon, label]) =>
        `<button class="nav ${tab === id ? "selected" : ""}" data-tab="${id}"><span>${icon}</span>${label}</button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="agent-avatar">✳</div><strong>Ambition, with direction.</strong><p>You set the destination.<br>Your agent does the legwork.</p><span class="online">● Cloudflare-powered</span></div></aside><main><header><span>Workspace <span class="muted">/ ${tab === "overview" ? "Mission control" : tab === "billing" ? "Membership" : tab === "profile" ? "Your profile" : "Run history"}</span></span><div class="header-right">${config?.demo ? '<span class="demo-badge">LOCAL DEMO · FIXTURE DATA</span>' : `<button class="text-button" id="logout">Sign out</button>`}<span class="avatar">${esc(account?.profile?.name?.slice(0, 1) || "J")}</span></div></header>${notice ? `<div class="notice" role="status">${esc(notice)}<button id="dismiss" aria-label="Dismiss">×</button></div>` : ""}<div class="page">${content}</div><footer>Thoughtful applications. Your decisions. <span>JobPilot / Early access</span></footer></main>`;
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab!;
        notice = "";
        render();
      }),
  );
  root.querySelector("#dismiss")?.addEventListener("click", () => {
    notice = "";
    render();
  });
  root.querySelector("#logout")?.addEventListener("click", logout);
}
function render() {
  if (!account) {
    shell(
      `<section class="welcome"><span class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span><h1>A job search that<br>moves with you.</h1><p>Give your agent a direction. Discover relevant opportunities, understand your fit, and prepare considered applications.</p><button class="primary" id="login">Sign in to your workspace ↗</button><div class="welcome-note">Search autonomously. Review thoughtfully. Stay in control.</div></section>`,
    );
    root
      .querySelector("#login")
      ?.addEventListener("click", () => act(() => login(config)));
    return;
  }
  if (tab === "profile") {
    profile();
    return;
  }
  if (tab === "billing") {
    billing();
    return;
  }
  if (tab === "history") {
    history();
    return;
  }
  const r = active(),
    jobs = r?.jobs || [],
    evaluated = jobs.filter((j) => j.evaluation),
    drafts = jobs.filter((j) => j.draft);
  shell(`<div class="page-heading"><div><span class="eyebrow">A LITTLE MOMENTUM, EVERY DAY</span><h1>Your next chapter.</h1><p>Less searching. More possibility. You’re in the pilot’s seat.</p></div><button class="primary" id="start" ${busy || account.runs.some((r) => ["running", "paused", "review", "failed"].includes(r.status)) ? "disabled" : ""}>＋ New search</button></div>
  <section class="mission"><div class="mission-top"><span class="chip"><span class="pulse"></span> ${esc(status(r))}</span><span class="mission-label">YOUR SEARCH AGENT</span></div><div class="mission-body"><div><h2>${esc(account.profile?.role || "A clear direction changes everything.")}</h2><p>${account.profile ? `${esc(account.profile.country)} · ${account.profile.remote ? "Remote opportunities" : "All working arrangements"} · Profile-led matching` : "Tell your agent about your experience and the work you want to do."}</p></div><div class="orbit" aria-hidden="true"><span>✳</span></div></div><div class="mission-bottom"><span>${esc(r?.planReason || "Your profile → relevant roles → your review → tailored drafts")}</span><div class="controls">${r && r.status === "running" ? '<button data-action="pause">Ⅱ Pause</button>' : ""}${r && r.status === "paused" ? '<button data-action="resume">▶ Resume</button>' : ""}${r && r.status === "failed" ? '<button data-action="retry">↻ Retry</button>' : ""}${r && !["completed", "cancelled"].includes(r.status) ? '<button data-action="cancel">Cancel run</button>' : ""}${!account.profile ? '<button id="setup">Set up profile ↗</button>' : ""}</div></div></section>
  ${r?.error ? `<div class="error" role="alert">${esc(r.error)}</div>` : ""}
  <section class="stats"><article><span>Opportunities found</span><strong>${jobs.length.toString().padStart(2, "0")}</strong><small>From your latest search</small></article><article><span>Matches evaluated</span><strong>${evaluated.length.toString().padStart(2, "0")}</strong><small>With evidence and eligibility checks</small></article><article><span>Application drafts</span><strong>${drafts.length.toString().padStart(2, "0")}</strong><small>Prepared after your review</small></article><article><span>Searches this month</span><strong>${account.used}<em> / ${account.limit}</em></strong><small>${config.demo ? "Demo allowance" : account.entitlement.active ? "Membership active" : "Membership required"}</small></article></section>
  <div class="content-grid"><section class="opportunities"><div class="section-heading"><div><h2>Your opportunity shortlist</h2><p>Every match comes with a reason.</p></div><span class="count">${jobs.length}</span></div>${jobs.length ? jobs.map(jobCard).join("") : `<div class="empty"><span>↗</span><h3>Make room for what’s next.</h3><p>${account.profile ? "Start a search and your agent will find and evaluate opportunities here." : "Complete your profile to give your agent a useful starting point."}</p><button class="secondary" id="empty-action">${account.profile ? "Start your first search" : "Build your profile"} ↗</button></div>`}${r?.status === "review" ? '<div class="review-actions"><p>Select eligible roles for application drafts. Unverified work rights require further research before drafting.</p><button class="primary" id="approve">Finish review & prepare drafts →</button></div>' : ""}</section><section class="activity"><div class="section-heading"><div><h2>Behind the scenes</h2><p>Your agent’s activity, in plain sight.</p></div></div><ol class="timeline">${
    (r?.events || [])
      .slice(-7)
      .map(
        (e) =>
          `<li><span class="dot"></span><strong>${esc(e.attrs?.label || e.type)}</strong><time>${new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>`,
      )
      .join("") ||
    '<li><span class="dot"></span><strong>Your agent is ready</strong><time>Waiting for your direction</time></li>'
  }</ol>${r ? '<button class="secondary full" id="replay">↺ Inspect run timeline</button>' : ""}${r && r.jobs.some((j) => j.evaluation) ? '<button class="secondary full" id="handoff">⇣ Export for /apply</button>' : ""}<div class="trust-note"><span>◎</span><div><strong>You make the final call.</strong><p>Your agent prepares drafts. It never submits applications or contacts employers.</p></div></div></section></div>
  ${r && traceRun === r.id ? `<section class="trace-panel"><div class="section-heading"><h2>Run timeline</h2><button class="secondary" id="export">Download Orca audit export</button></div><p>Recorded activity only. Playback does not call models or repeat tools.</p><input aria-label="Timeline position" id="scrub" type="range" min="0" max="${Math.max(0, r.events.length - 1)}" value="${traceIndex}"><div class="trace-detail"><code>${esc(r.events[traceIndex]?.type)}</code><p>${esc(r.events[traceIndex]?.attrs?.label)}</p></div><button class="secondary" id="play">${replayTimer ? "Pause playback" : "Play timeline"}</button></section>` : ""}`);
  root.querySelector("#start")?.addEventListener("click", start);
  root.querySelector("#setup")?.addEventListener("click", () => {
    tab = "profile";
    render();
  });
  root
    .querySelector("#empty-action")
    ?.addEventListener("click", () =>
      account?.profile ? start() : ((tab = "profile"), render()),
    );
  root.querySelectorAll<HTMLElement>("[data-action]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          await api(`/runs/${r!.id}/control`, "POST", {
            action: b.dataset.action,
          });
          await refresh();
        })),
  );
  root.querySelector("#approve")?.addEventListener("click", () =>
    act(async () => {
      const approvedIds = [
        ...root.querySelectorAll<HTMLInputElement>(
          'input[name="approve"]:checked',
        ),
      ].map((i) => i.value);
      await api(`/runs/${r!.id}/decisions`, "POST", { approvedIds });
      await refresh();
    }),
  );
  root.querySelector("#replay")?.addEventListener("click", () => {
    traceRun = r!.id;
    traceIndex = 0;
    render();
  });
  root.querySelector("#scrub")?.addEventListener("input", (e) => {
    traceIndex = Number((e.target as HTMLInputElement).value);
    render();
  });
  root.querySelector("#play")?.addEventListener("click", () => {
    if (replayTimer) {
      clearInterval(replayTimer);
      replayTimer = undefined;
    } else
      replayTimer = setInterval(() => {
        traceIndex++;
        if (traceIndex >= r!.events.length - 1) {
          traceIndex = r!.events.length - 1;
          clearInterval(replayTimer);
          replayTimer = undefined;
        }
        render();
      }, 850);
    render();
  });
  const download = (path: string, name: string, after?: () => void) =>
    act(async () => {
      const data = await api(path);
      saveFile(name, JSON.stringify(data, null, 2), "application/json");
      after?.();
    });
  root
    .querySelector("#export")
    ?.addEventListener("click", () =>
      download(`/runs/${r!.id}/trace`, r!.id + ".json"),
    );
  root.querySelector("#handoff")?.addEventListener("click", () => {
    const name = r!.id + "-handoff.json";
    download(`/runs/${r!.id}/handoff`, name, () => {
      notice = `Exported ${name}. From the repository root run: python3 tools/import_jobpilot.py ~/Downloads/${name}`;
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach(
    (b) =>
      (b.onclick = async () => {
        const job = r?.jobs.find((j) => j.id === b.dataset.job);
        if (!job?.draft) return;
        const text =
          b.dataset.copy === "letter"
            ? job.draft.coverLetter
            : job.draft.cvBullets.map((x) => "- " + x).join("\n");
        try {
          await navigator.clipboard.writeText(text);
          const label = b.textContent;
          b.textContent = "Copied ✓";
          setTimeout(() => (b.textContent = label), 1500);
        } catch {
          notice = "Copy failed; select the text and copy it manually";
          render();
        }
      }),
  );
  root.querySelectorAll<HTMLButtonElement>("[data-download]").forEach(
    (b) =>
      (b.onclick = () => {
        const job = r?.jobs.find((j) => j.id === b.dataset.download);
        if (!job?.draft) return;
        saveFile(
          `${r!.id}-${job.id}-draft.md`,
          `# ${job.title} at ${job.company}\n\n## Cover letter\n\n${job.draft.coverLetter}\n\n## Suggested CV bullets\n\n${job.draft.cvBullets.map((x) => "- " + x).join("\n")}\n\n## Verification notes\n\n${job.draft.verificationNotes.map((x) => "- " + x).join("\n")}\n\n_Unverified text draft from JobPilot run ${r!.id}. Check before use._\n`,
          "text/markdown",
        );
      }),
  );
  root.querySelectorAll<HTMLElement>("[data-applied]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          await api(`/runs/${r!.id}/applied`, "POST", {
            jobId: b.dataset.applied,
            applied: b.dataset.value === "true",
          });
          await refresh();
        })),
  );
}
function saveFile(name: string, text: string, type: string) {
  const href = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
}
function jobCard(j: Job) {
  const e = j.evaluation;
  return `<article class="job"><div class="job-title"><div class="company-mark">${esc(j.company.slice(0, 1))}</div><div><h3>${esc(j.title)}</h3><p>${esc(j.company)} <span>· ${esc(j.location)} · ${esc(postedLabel(j.date))}</span></p></div>${e ? `<div class="score ${canDraft(j) ? "good" : ""}">${e.score}<small>fit / 100</small></div>` : '<span class="muted">Evaluating…</span>'}</div>${e ? `<p class="reason">${esc(e.reason)}</p><div class="tags"><span>Work rights: ${esc(e.eligibility.toLowerCase())}</span><span>Language: ${esc(e.language.toLowerCase())}</span></div><details><summary>See evidence & gaps</summary>${e.evidence.map((q) => `<blockquote>${esc(q)}</blockquote>`).join("")}<p>${esc(e.gaps.join(" · "))}</p></details>` : ""}<div class="job-bottom">${safeUrl(j.url) ? `<a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer">View posting ↗</a>` : ""}${active()?.status === "review" ? `<label class="check"><input type="checkbox" name="approve" value="${esc(j.id)}" ${canDraft(j) ? "" : "disabled"}> ${canDraft(j) ? "Prepare draft" : esc(blockReason(j) || "Not cleared for drafting")}</label>` : ""}${e && ["completed", "cancelled"].includes(active()?.status || "") ? (j.applied ? `<span class="applied">Applied on ${esc(new Date(j.applied).toLocaleDateString())}</span><button type="button" class="text-button" data-applied="${esc(j.id)}" data-value="false">Undo</button>` : `<button type="button" class="text-button" data-applied="${esc(j.id)}" data-value="true">Mark as applied</button>`) : ""}</div>${j.draft ? `<details class="draft"><summary>Read application draft</summary><pre>${esc(j.draft.coverLetter)}</pre><h4>Suggested CV bullets</h4><ul>${j.draft.cvBullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul><p>${esc(j.draft.verificationNotes.join(" "))}</p><strong>Unverified text draft · Check before use</strong><div class="draft-actions"><button type="button" class="secondary" data-copy="letter" data-job="${esc(j.id)}">Copy cover letter</button><button type="button" class="secondary" data-copy="bullets" data-job="${esc(j.id)}">Copy CV bullets</button><button type="button" class="secondary" data-download="${esc(j.id)}">Download draft (.md)</button></div></details>` : ""}</article>`;
}
function profile() {
  const p = account?.profile;
  const fields = [
    ["name", "Your name", "text", p?.name || ""],
    ["role", "Target role", "text", p?.role || ""],
    ["country", "Country (two-letter code)", "text", p?.country || "US"],
    ["skills", "Skills you can demonstrate", "textarea", p?.skills || ""],
    ["experience", "Your actual experience", "textarea", p?.experience || ""],
    ["languages", "Languages and proficiency", "textarea", p?.languages || ""],
    [
      "workRights",
      "Citizenship / work authorization",
      "textarea",
      p?.workRights || "",
    ],
    [
      "constraints",
      "Deal-breakers and preferences",
      "textarea",
      p?.constraints || "",
    ],
  ];
  const limits: Record<string, string> = {
    name: 'maxlength="100"',
    role: 'minlength="2" maxlength="150"',
    skills: 'minlength="2" maxlength="2000"',
    experience: 'minlength="20" maxlength="6000"',
    languages: 'minlength="2" maxlength="1000"',
    workRights: 'minlength="2" maxlength="1500"',
    constraints: 'maxlength="1500"',
  };
  shell(
    `<div class="page-heading"><div><span class="eyebrow">A BETTER SEARCH STARTS WITH YOU</span><h1>Your profile.</h1><p>Your agent works from the facts you share. Keep them specific and accurate.</p></div></div><form id="profile-form" class="form-panel">${fields.map(([name, label, type, value]) => `<label>${label}${type === "textarea" ? `<textarea name="${name}" ${name === "constraints" ? "" : "required"} ${limits[name] || ""} rows="3">${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}" required ${name === "country" ? 'pattern="[A-Z]{2}" maxlength="2"' : limits[name] || ""}>`}</label>`).join("")}<label class="check"><input name="remote" type="checkbox" ${p?.remote ? "checked" : ""}> Remote roles only</label><p class="muted">Your profile is sent to Workers AI to plan and evaluate your search. Application drafts need your review.</p><button class="primary" ${busy ? "disabled" : ""}>Save profile →</button></form>`,
  );
  root.querySelector("form")!.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const data = Object.fromEntries(f);
    act(async () => {
      await api("/profile", "PUT", { ...data, remote: f.has("remote") });
      notice = "Profile saved. Your next search will use these details.";
      await refresh();
      tab = "overview";
      render();
    });
  });
}
function billing() {
  shell(
    `<div class="page-heading"><div><span class="eyebrow">INVEST IN YOUR NEXT CHAPTER</span><h1>More direction. Less busywork.</h1><p>One membership. Your agent on web and iPhone.</p></div></div><section class="pricing"><span class="chip">JOBPILOT MEMBERSHIP</span><h2>A considered approach<br>to your next role.</h2><p>Pricing is shown securely at checkout.</p><ul><li>60 guided search runs per calendar month</li><li>Evidence-backed match assessments</li><li>Review before application drafting</li><li>Durable runs with pause and resume</li><li>Shared web and iOS controls</li><li>Inspectable run history and audit exports</li></ul><button class="primary" id="subscribe" ${config.demo ? "disabled" : ""}>${account?.entitlement.active ? "Manage membership" : "View price & subscribe"} ↗</button><p class="muted">${config.demo ? "Payments are disabled in the local demo." : "Subscription status: " + esc(account?.entitlement.status)}</p></section>`,
  );
  root.querySelector("#subscribe")?.addEventListener("click", () =>
    act(async () => {
      const b = await api(
        account?.entitlement.active ? "/billing/portal" : "/billing/checkout",
        "POST",
        {},
      );
      const u = new URL(b.url);
      if (
        u.protocol !== "https:" ||
        !["checkout.stripe.com", "billing.stripe.com"].includes(u.hostname)
      )
        throw new Error("Invalid checkout URL");
      location.assign(u.href);
    }),
  );
}
function history() {
  shell(
    `<div class="page-heading"><div><span class="eyebrow">EVERY STEP, REMEMBERED</span><h1>Your search history.</h1><p>Your latest 30 runs, with decisions and drafts preserved.</p></div></div><section class="history">${account!.runs.map((r) => `<button data-run="${r.id}"><span><strong>${esc(r.query || "New search")}</strong><small>${new Date(r.createdAt).toLocaleString()} · ${r.jobs.length} opportunities${r.jobs.filter((j) => j.applied).length ? ` · ${r.jobs.filter((j) => j.applied).length} applied` : ""}</small></span><span class="chip">${esc(status(r))} →</span></button>`).join("") || "<p>No runs yet. Start with your profile.</p>"}</section>`,
  );
  root.querySelectorAll<HTMLElement>("[data-run]").forEach(
    (b) =>
      (b.onclick = () => {
        selectedRun = b.dataset.run;
        tab = "overview";
        render();
      }),
  );
}
async function start() {
  if (!account?.profile) {
    tab = "profile";
    render();
    return;
  }
  await act(async () => {
    const r = await api("/runs", "POST", { requestId: crypto.randomUUID() });
    selectedRun = r.id;
    await refresh();
  });
}
async function refresh() {
  account = await api("/account");
  render();
}
async function act(fn: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } catch (e) {
    notice = e instanceof Error ? e.message : "Something went wrong";
  } finally {
    busy = false;
    render();
  }
}
async function boot() {
  try {
    config = await api("/config");
    await callback(config);
    if (config.demo || token()) await refresh();
    else render();
    if (new URLSearchParams(location.search).get("billing") === "success") {
      await api("/billing/sync", "POST", {});
      historyReplace();
      await refresh();
    }
  } catch (e) {
    notice = e instanceof Error ? e.message : "Unable to connect";
    render();
  }
}
function historyReplace() {
  window.history.replaceState({}, "", "/");
}
setInterval(() => {
  if (
    account?.runs.some((r) => r.status === "running") &&
    !busy &&
    tab !== "profile" &&
    !root.querySelector('input[name="approve"]:checked')
  )
    void refresh().catch((e) => {
      notice = e.message;
      render();
    });
}, 4000);
void boot();
