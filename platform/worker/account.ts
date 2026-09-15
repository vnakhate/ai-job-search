import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  type Env,
  type Account,
  type Run,
  ProfileSchema,
  PlanSchema,
  EvaluationSchema,
  DraftSchema,
  HttpError,
  isDemo,
  canDraft,
  MAX_RUNS_PER_MONTH,
  publicAccount,
} from "./contracts";
import { model, searchJobs, MODEL } from "./providers";
import { event } from "./trace";
import { stripe, currentEntitlement } from "./billing";
import context from "./context.generated.json";

export class AccountAgent extends DurableObject<Env> {
  async read(): Promise<Account> {
    const meta = await this.ctx.storage.get<
      Omit<Account, "runs"> & { runIds: string[] }
    >("account");
    if (!meta)
      return {
        runs: [],
        entitlement: { active: false, expiresAt: 0, status: "inactive" },
        month: "",
        used: 0,
      };
    const runs: Run[] = [];
    for (const id of meta.runIds || []) {
      const run = await this.ctx.storage.get<Run>(id);
      if (run) runs.push(run);
    }
    return {
      profile: meta.profile,
      entitlement: meta.entitlement,
      month: meta.month,
      used: meta.used,
      runs,
    };
  }
  async write(tx: DurableObjectTransaction, a: Account) {
    const old = await tx.get<{ runIds: string[] }>("account");
    for (const id of old?.runIds || [])
      if (!a.runs.some((r) => r.id === id)) await tx.delete(id);
    for (const run of a.runs) await tx.put(run.id, run);
    const { runs, ...meta } = a;
    await tx.put("account", { ...meta, runIds: runs.map((r) => r.id) });
  }
  async save(a: Account) {
    await this.ctx.storage.transaction((tx) => this.write(tx, a));
  }
  async fetch(request: Request): Promise<Response> {
    // Serialize commands with a bounded alarm step. Pauses take effect at a step boundary.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        return await this.route(request);
      } catch (e) {
        if (e instanceof HttpError)
          return Response.json({ error: e.message }, { status: e.status });
        if (e instanceof SyntaxError)
          return Response.json({ error: "Malformed JSON" }, { status: 400 });
        if (e instanceof z.ZodError)
          return Response.json(
            {
              error: "Invalid input",
              details: e.issues.map((i) => i.path.join(".") + ": " + i.message),
            },
            { status: 400 },
          );
        console.error(
          "Account operation failed",
          e instanceof Error ? e.name : "unknown",
        );
        return Response.json(
          { error: "Operation failed; please retry" },
          { status: 500 },
        );
      }
    });
  }
  async route(request: Request): Promise<Response> {
    const a = await this.read();
    const url = new URL(request.url);
    const p = url.pathname;
    const post = request.method === "POST";
    const demo = isDemo(this.env);
    if (p === "/api/account" && request.method === "GET")
      return Response.json({
        ...publicAccount(a),
        demo,
        limit: MAX_RUNS_PER_MONTH,
        model: MODEL,
        contextHash: context.hash,
      });
    if (p === "/api/profile" && request.method === "PUT") {
      a.profile = ProfileSchema.parse(await request.json());
      await this.save(a);
      return Response.json({ ok: true });
    }
    if (p === "/api/billing/sync" && post) {
      if (a.entitlement.customerId) {
        a.entitlement = await currentEntitlement(
          this.env,
          a.entitlement.customerId,
        );
        await this.save(a);
      }
      return Response.json({ ok: true });
    }
    if (p === "/api/billing/checkout" && post) {
      if (demo)
        throw new HttpError(409, "Billing is disabled in local demo mode");
      if (!this.env.STRIPE_PRICE_ID)
        throw new HttpError(503, "Subscription price is not configured");
      const owner = request.headers.get("x-verified-owner")!;
      if (!a.entitlement.customerId) {
        const c = await stripe(
          this.env,
          "customers",
          new URLSearchParams({ "metadata[owner]": owner }),
          "customer-" + owner,
        );
        a.entitlement.customerId = c.id;
        await this.save(a);
      }
      if (a.entitlement.active && a.entitlement.expiresAt > Date.now())
        throw new HttpError(409, "You already have an active subscription");
      const session = await stripe(
        this.env,
        "checkout/sessions",
        new URLSearchParams({
          mode: "subscription",
          customer: a.entitlement.customerId!,
          "line_items[0][price]": this.env.STRIPE_PRICE_ID,
          "line_items[0][quantity]": "1",
          success_url: this.env.APP_ORIGIN + "/?billing=success",
          cancel_url: this.env.APP_ORIGIN + "/?billing=cancelled",
        }),
        "checkout-" + owner + "-" + Math.floor(Date.now() / 1800000),
      );
      return Response.json({ url: session.url });
    }
    if (p === "/api/billing/portal" && post) {
      if (demo || !a.entitlement.customerId)
        throw new HttpError(409, "No billing account");
      const session = await stripe(
        this.env,
        "billing_portal/sessions",
        new URLSearchParams({
          customer: a.entitlement.customerId,
          return_url: this.env.APP_ORIGIN,
        }),
      );
      return Response.json({ url: session.url });
    }
    if (p === "/api/runs" && post) {
      const input = z
        .object({ requestId: z.string().uuid() })
        .strict()
        .parse(await request.json());
      const existing = a.runs.find(
        (r) =>
          r.id === `run_${input.requestId.replaceAll("-", "").toLowerCase()}`,
      );
      if (existing) return Response.json(existing);
      if (!a.profile)
        throw new HttpError(409, "Save your candidate profile first");
      if (
        a.runs.some((r) =>
          ["running", "paused", "review", "failed"].includes(r.status),
        )
      )
        throw new HttpError(409, "Finish or cancel your current run first");
      this.requirePaid(a, demo);
      const month = new Date().toISOString().slice(0, 7);
      if (a.month !== month) {
        a.month = month;
        a.used = 0;
      }
      if (a.used >= MAX_RUNS_PER_MONTH)
        throw new HttpError(429, "Monthly run allowance reached");
      const now = new Date().toISOString();
      const r: Run = {
        id: `run_${input.requestId.replaceAll("-", "").toLowerCase()}`,
        createdAt: now,
        updatedAt: now,
        status: "running",
        stage: "plan",
        profile: structuredClone(a.profile),
        jobs: [],
        cursor: 0,
        modelCalls: 0,
        attempts: {},
        events: [],
        demo,
        contextHash: context.hash,
      };
      event(r, "run.start", "Search started", {
        demo,
        contextHash: context.hash,
      });
      a.runs.unshift(r);
      a.runs = a.runs.slice(0, 30);
      a.used++;
      // Alarm and state share one durable storage transaction, including quota reservation.
      await this.ctx.storage.transaction(async (tx) => {
        await this.write(tx, a);
        await tx.setAlarm(Date.now() + 500);
      });
      return Response.json(r, { status: 201 });
    }
    const match = p.match(
      /^\/api\/runs\/(run_[a-f0-9]{32})(?:\/(control|decisions|trace|handoff|applied))?$/,
    );
    if (!match) throw new HttpError(404, "Not found");
    const r = a.runs.find((r) => r.id === match[1]);
    if (!r) throw new HttpError(404, "Run not found");
    if (!match[2] && request.method === "GET") return Response.json(r);
    if (match[2] === "trace" && request.method === "GET")
      return Response.json({
        format: "jobpilot-audit-v1",
        runId: r.id,
        createdAt: r.createdAt,
        status: r.status,
        events: r.events,
        scope:
          "Audit summaries only; no wire responses or filesystem snapshots. Orca CLI execution replay is unavailable for this export.",
      });
    if (match[2] === "handoff" && request.method === "GET")
      return Response.json({
        format: "jobpilot-handoff-v1",
        runId: r.id,
        exportedAt: new Date().toISOString(),
        status: r.status,
        query: r.query,
        jobs: r.jobs
          .filter((j) => j.evaluation)
          .map(
            ({
              id,
              title,
              company,
              location,
              url,
              description,
              date,
              evaluation,
              decision,
              draft,
              applied,
            }) => ({
              id,
              title,
              company,
              location,
              url,
              date,
              description,
              evaluation,
              decision,
              draft,
              applied,
            }),
          ),
        scope:
          "Evaluated postings with verbatim source text, gates, decisions and unverified drafts, for import into the local workflow. The candidate profile snapshot is not included.",
      });
    if (match[2] === "applied" && post) {
      const { jobId, applied } = z
        .object({ jobId: z.string().max(300), applied: z.boolean() })
        .strict()
        .parse(await request.json());
      const j = r.jobs.find((j) => j.id === jobId);
      if (!j) throw new HttpError(400, "Unknown posting");
      if (applied) j.applied = new Date().toISOString();
      else delete j.applied;
      event(r, "note", applied ? "Marked as applied" : "Applied mark removed", {
        jobId,
      });
      await this.save(a);
      return Response.json(r);
    }
    if (match[2] === "control" && post) {
      const { action } = z
        .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
        .strict()
        .parse(await request.json());
      if (action === "pause" && r.status === "running") {
        r.status = "paused";
        event(r, "note", "Paused by you");
        await this.ctx.storage.deleteAlarm();
      } else if (
        action === "cancel" &&
        !["completed", "cancelled"].includes(r.status)
      ) {
        r.status = "cancelled";
        event(r, "run.end", "Cancelled", { exit_code: 1 });
        await this.ctx.storage.deleteAlarm();
      } else if (
        (action === "resume" && r.status === "paused") ||
        (action === "retry" && r.status === "failed")
      ) {
        this.requirePaid(a, demo);
        if (r.modelCalls >= 20)
          throw new HttpError(
            409,
            "Model call budget exhausted; cancel this run",
          );
        r.status = "running";
        delete r.error;
        event(r, "note", "Resumed by you");
        await this.ctx.storage.setAlarm(Date.now() + 500);
      } else throw new HttpError(409, `Cannot ${action} a ${r.status} run`);
      await this.save(a);
      return Response.json(r);
    }
    if (match[2] === "decisions" && post) {
      const { approvedIds } = z
        .object({ approvedIds: z.array(z.string().max(300)).max(8) })
        .strict()
        .parse(await request.json());
      if (r.status !== "review")
        throw new HttpError(409, "This run is not awaiting review");
      this.requirePaid(a, demo);
      if (
        new Set(approvedIds).size !== approvedIds.length ||
        approvedIds.some(
          (id) => !r.jobs.some((j) => j.id === id && canDraft(j)),
        )
      )
        throw new HttpError(
          400,
          "Only eligible jobs can be approved for drafting",
        );
      for (const j of r.jobs)
        j.decision = approvedIds.includes(j.id) ? "approved" : "rejected";
      event(r, "note", "Your shortlist review was recorded", {
        approved: approvedIds.length,
      });
      r.stage = "draft";
      r.cursor = 0;
      r.status = "running";
      await this.ctx.storage.transaction(async (tx) => {
        await this.write(tx, a);
        await tx.setAlarm(Date.now() + 500);
      });
      return Response.json(r);
    }
    throw new HttpError(405, "Method not allowed");
  }
  requirePaid(a: Account, demo: boolean) {
    if (
      !demo &&
      (!a.entitlement.active || a.entitlement.expiresAt <= Date.now())
    )
      throw new HttpError(402, "An active subscription is required");
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const a = await this.read();
      const r = a.runs.find((r) => r.status === "running");
      if (!r) return;
      try {
        this.requirePaid(a, isDemo(this.env));
        if (r.contextHash !== context.hash)
          throw new Error(
            "Evaluation methodology changed. Cancel this run and start a new search.",
          );
        const key = r.stage + ":" + r.cursor;
        const tries = (r.attempts[key] || 0) + 1;
        if (tries > 3)
          throw new Error(
            "This step reached its three-attempt limit. Cancel the run to start again.",
          );
        r.attempts[key] = tries;
        // Watchdog recovers interrupted execution; retries still consume the reserved budget.
        await this.ctx.storage.transaction(async (tx) => {
          await this.write(tx, a);
          await tx.setAlarm(Date.now() + 60000);
        });
        await this.step(a, r);
        if (r.status === "running")
          await this.ctx.storage.setAlarm(Date.now() + 1000);
        else await this.ctx.storage.deleteAlarm();
      } catch (e) {
        r.status = "failed";
        r.error =
          e instanceof z.ZodError || e instanceof SyntaxError
            ? "Model returned invalid structured output; retry this step."
            : e instanceof Error
              ? e.message
              : "Agent step failed";
        event(r, "error", "Step failed", { stage: r.stage });
        await this.ctx.storage.deleteAlarm();
      }
      await this.save(a);
    });
  }
  async infer<T>(
    a: Account,
    r: Run,
    task: string,
    input: unknown,
    schema: z.ZodType<T>,
    fixture: NoInfer<T>,
  ): Promise<T> {
    if (r.modelCalls >= 20) throw new Error("Model call budget exhausted");
    r.modelCalls++;
    event(
      r,
      "model.request",
      {
        plan: "Planning your search",
        evaluate: "Assessing the next opportunity",
        draft: "Writing your application draft",
        search: "Searching for opportunities",
        done: "Finishing the run",
      }[r.stage],
      { model: r.demo ? "demo-fixture" : MODEL },
    );
    await this.save(a);
    const output = r.demo
      ? schema.parse(fixture)
      : await model(this.env, task, input, schema);
    event(r, "model.response", "Validated structured output");
    return output;
  }
  async step(a: Account, r: Run) {
    if (r.stage === "plan") {
      const plan = await this.infer(
        a,
        r,
        "Create a focused job search query. Geography and remote filters are enforced separately by the harness.",
        r.profile,
        PlanSchema,
        {
          query: r.profile.role,
          reason: "Demo: search the target role in your selected country.",
        },
      );
      r.query = plan.query;
      r.planReason = plan.reason;
      r.stage = "search";
      event(r, "note", "Search plan ready");
      return;
    }
    if (r.stage === "search") {
      event(r, "tool.call", "Search Freehire", { country: r.profile.country });
      r.jobs = await searchJobs(this.env, r.profile, r.query!);
      if (!r.demo) {
        const seen = new Set(
          a.runs
            .filter((prior) => prior.id !== r.id)
            .flatMap((prior) => prior.jobs.map((j) => j.id)),
        );
        r.jobs = r.jobs.filter((j) => !seen.has(j.id));
      }
      event(r, "tool.result", "Job search finished", { count: r.jobs.length });
      r.stage = "evaluate";
      return;
    }
    if (r.stage === "evaluate") {
      if (r.cursor < r.jobs.length) {
        const j = r.jobs[r.cursor];
        const fail = r.demo && j.id === "demo-2";
        const evaluation = await this.infer(
          a,
          r,
          "Evaluate this job with eligibility and language gates first. eligibility PASS requires supporting posting evidence and matching candidate rights; silence is UNVERIFIED. Evidence must be exact quotations from the posting. Do not score a FAIL: use score 0. Explain uncertainty and genuine gaps.",
          { profile: r.profile, job: j },
          EvaluationSchema,
          {
            score: fail ? 0 : 88,
            eligibility: fail ? "FAIL" : "PASS",
            language: fail ? "FAIL" : "PASS",
            reason: fail
              ? "Demo: explicit rights and language requirements conflict with the supplied profile."
              : "Demo: your stated skills align with this example role.",
            evidence: [j.description],
            gaps: fail
              ? ["Citizenship and language requirements"]
              : [
                  "Verify the employer and current role availability before applying",
                ],
          },
        );
        if (evaluation.evidence.some((quote) => !j.description.includes(quote)))
          throw new Error(
            "Model evidence was not found in the posting. Retry to evaluate again.",
          );
        if (evaluation.eligibility === "FAIL" || evaluation.language === "FAIL")
          evaluation.score = 0;
        j.evaluation = evaluation;
        r.cursor++;
        event(r, "note", "Eligibility and language checked", {
          jobId: j.id,
          eligibility: evaluation.eligibility,
          language: evaluation.language,
        });
        return;
      }
      r.status = "review";
      r.cursor = 0;
      event(r, "note", "Shortlist ready for your review", {
        count: r.jobs.length,
      });
      return;
    }
    if (r.stage === "draft") {
      const selected = r.jobs.filter((j) => j.decision === "approved");
      if (r.cursor < selected.length) {
        const j = selected[r.cursor];
        if (!canDraft(j)) throw new Error("Draft eligibility guard failed");
        j.draft = await this.infer(
          a,
          r,
          "Create a cover-letter draft and suggested CV bullets. Use only facts in the profile. Do not claim independent company verification. Include verificationNotes describing unsupported claims to avoid and required human checks. These are unverified text drafts, not compiled application documents.",
          { profile: r.profile, job: j },
          DraftSchema,
          {
            coverLetter: `DEMO DRAFT\n\nDear Hiring Manager,\n\nI am interested in the ${j.title} position. My background includes ${r.profile.experience}. My skills include ${r.profile.skills}. I would welcome the chance to discuss how this experience connects with your role.\n\nBest regards,\n${r.profile.name}`,
            cvBullets: [r.profile.experience],
            verificationNotes: [
              "Demo content. Verify every claim before use.",
              "Company facts and posting availability have not been independently verified.",
            ],
          },
        );
        r.cursor++;
        event(r, "tool.result", "Application text draft prepared", {
          jobId: j.id,
        });
        return;
      }
      r.status = "completed";
      r.stage = "done";
      event(r, "run.end", "Run completed; nothing submitted", { exit_code: 0 });
    }
  }
}
