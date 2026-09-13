import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountAgent } from "../worker/account";
import {
  type Env,
  canDraft,
  ProfileSchema,
  isDemo,
  safeUrl,
} from "../worker/contracts";
import { verifyWebhook, currentEntitlement } from "../worker/billing";
import handler from "../worker/index";
import { exportAudit } from "../scripts/export-orca.mjs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEvent, validateManifest } from "@orcareplay/schema";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
const keys = vi.hoisted(() => ({ local: undefined as any }));
vi.mock("jose", async (original) => {
  const actual = await original<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet:
      () =>
      (...args: any[]) =>
        keys.local(...args),
  };
});
const profile = {
  name: "Demo Candidate",
  country: "US",
  role: "Platform Engineer",
  skills: "TypeScript, APIs",
  experience: "Built and maintained backend APIs for five years.",
  languages: "English fluent",
  workRights: "US citizen",
  constraints: "",
  remote: true,
};
class Storage {
  data = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async setAlarm(n: number) {
    this.alarmAt = n;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
  async transaction(fn: any) {
    return fn(this);
  }
}
function setup(demo = true) {
  const storage = new Storage();
  const ctx = { storage, blockConcurrencyWhile: async (fn: any) => fn() };
  const env = {
    APP_ORIGIN: demo ? "http://localhost:8787" : "https://jobpilot.example",
    DEMO_MODE: demo ? "true" : "false",
    STRIPE_PRICE_ID: "price_member",
    OIDC_ISSUER: "https://issuer.example/",
    OIDC_CLIENT_ID: "client",
    OIDC_AUDIENCE: "https://api.example",
  } as Env;
  const agent = new AccountAgent(ctx as any, env);
  const call = (path: string, method = "GET", body?: unknown) =>
    agent.fetch(
      new Request("https://internal/api" + path, {
        method,
        headers: { "x-verified-owner": "owner" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { agent, storage, env, call };
}
async function started() {
  const s = setup();
  await s.call("/profile", "PUT", profile);
  const r = await s.call("/runs", "POST", { requestId: crypto.randomUUID() });
  return { ...s, run: (await r.json()) as any };
}
async function toReview(s: Awaited<ReturnType<typeof started>>) {
  for (let i = 0; i < 5; i++) await s.agent.alarm();
  return (await s.agent.read()).runs[0];
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("durable job-search controls", () => {
  it("completes search and approved draft with valid, private audit events", async () => {
    const s = await started();
    const r = await toReview(s);
    expect(r.status).toBe("review");
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[1].evaluation?.score).toBe(0);
    expect(
      (
        await s.call(`/runs/${r.id}/decisions`, "POST", {
          approvedIds: ["demo-1"],
        })
      ).status,
    ).toBe(200);
    await s.agent.alarm();
    await s.agent.alarm();
    const done = (await s.agent.read()).runs[0];
    expect(done.status).toBe("completed");
    expect(done.jobs[0].draft?.coverLetter).toContain("DEMO");
    expect(done.jobs[1].draft).toBeUndefined();
    expect(done.events.filter((e) => e.type === "run.end")).toHaveLength(1);
    expect(done.events.every((e) => validateEvent(e).valid)).toBe(true);
    expect(JSON.stringify(done.events)).not.toContain(profile.experience);
  });
  it("persists pause through reconstruction, resumes and cancels irreversibly", async () => {
    const s = await started();
    await s.call(`/runs/${s.run.id}/control`, "POST", { action: "pause" });
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].modelCalls).toBe(0);
    const restarted = new AccountAgent(
      {
        storage: s.storage,
        blockConcurrencyWhile: async (fn: any) => fn(),
      } as any,
      s.env,
    );
    expect((await restarted.read()).runs[0].status).toBe("paused");
    await s.call(`/runs/${s.run.id}/control`, "POST", { action: "resume" });
    await restarted.alarm();
    expect((await restarted.read()).runs[0].stage).toBe("search");
    await s.call(`/runs/${s.run.id}/control`, "POST", { action: "cancel" });
    await restarted.alarm();
    expect((await restarted.read()).runs[0].status).toBe("cancelled");
    expect(
      (await s.call(`/runs/${s.run.id}/control`, "POST", { action: "resume" }))
        .status,
    ).toBe(409);
  });
  it("deduplicates retried creation and reserves quota once", async () => {
    const s = setup();
    await s.call("/profile", "PUT", profile);
    const body = { requestId: crypto.randomUUID() };
    await s.call("/runs", "POST", body);
    await s.call("/runs", "POST", body);
    expect((await s.agent.read()).used).toBe(1);
    expect((await s.agent.read()).runs).toHaveLength(1);
  });
  it("blocks a second active run", async () => {
    const s = await started();
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(409);
  });
  it("blocks early, ineligible, invented and duplicate approvals", async () => {
    const s = await started();
    expect(
      (
        await s.call(`/runs/${s.run.id}/decisions`, "POST", {
          approvedIds: ["demo-1"],
        })
      ).status,
    ).toBe(409);
    await toReview(s);
    for (const ids of [["demo-2"], ["invented"], ["demo-1", "demo-1"]])
      expect(
        (
          await s.call(`/runs/${s.run.id}/decisions`, "POST", {
            approvedIds: ids,
          })
        ).status,
      ).toBe(400);
  });
  it("can reject every result and complete without drafting", async () => {
    const s = await started();
    await toReview(s);
    await s.call(`/runs/${s.run.id}/decisions`, "POST", { approvedIds: [] });
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].status).toBe("completed");
  });
  it("requires profile and paid access; respects quota and expiry", async () => {
    const s = setup(false);
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(409);
    await s.call("/profile", "PUT", profile);
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(402);
    const a = await s.agent.read();
    a.entitlement = {
      active: true,
      expiresAt: Date.now() + 10000,
      status: "active",
    };
    a.month = new Date().toISOString().slice(0, 7);
    a.used = 60;
    await s.agent.save(a);
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(429);
    a.used = 0;
    a.entitlement.expiresAt = Date.now() - 1;
    await s.agent.save(a);
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(402);
  });
  it("rechecks billing before background work", async () => {
    const s = await started();
    s.env.DEMO_MODE = "false";
    await s.agent.alarm();
    const r = (await s.agent.read()).runs[0];
    expect(r.status).toBe("failed");
    expect(r.modelCalls).toBe(0);
  });
  it("bounds retries and disables the alarm on exhausted attempts", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs[0].attempts["plan:0"] = 3;
    await s.agent.save(a);
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].status).toBe("failed");
    expect(s.storage.alarmAt).toBeNull();
  });
  it("freezes run profile and isolates accounts", async () => {
    const s = await started();
    await s.call("/profile", "PUT", { ...profile, role: "Designer" });
    expect((await s.agent.read()).runs[0].profile.role).toBe(
      "Platform Engineer",
    );
    expect((await setup().call(`/runs/${s.run.id}`)).status).toBe(404);
  });
});
describe("authorization and input boundaries", () => {
  it("rejects malformed profiles and unsafe URLs", () => {
    expect(
      ProfileSchema.safeParse({ ...profile, country: "all" }).success,
    ).toBe(false);
    expect(
      ProfileSchema.safeParse({ ...profile, owner: "victim" }).success,
    ).toBe(false);
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("https://user:pass@example.com")).toBe("");
    expect(safeUrl("https://example.com/job")).toBe("https://example.com/job");
  });
  it("never enables demo auth on a deployed origin", () => {
    expect(
      isDemo({ ...setup().env, APP_ORIGIN: "https://jobpilot.example" }),
    ).toBe(false);
  });
  it("rejects missing or forged tokens before tenant lookup", async () => {
    const { env } = setup(false);
    const spy = vi.fn();
    env.ACCOUNTS = { idFromName: spy } as any;
    expect(
      (
        await handler.fetch(
          new Request("https://jobpilot.example/api/account", {
            headers: { "x-verified-owner": "victim" },
          }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler.fetch(
          new Request("https://jobpilot.example/api/account", {
            headers: { authorization: "Bearer forged" },
          }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
  it("routes by signed subject and validates JWT audience", async () => {
    const pair = await generateKeyPair("RS256");
    keys.local = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] });
    const { env } = setup(false);
    const names: string[] = [];
    env.ACCOUNTS = {
      idFromName: (n: string) => {
        names.push(n);
        return n;
      },
      get: () => ({
        fetch: async (req: Request) =>
          Response.json({ owner: req.headers.get("x-verified-owner") }),
      }),
    } as any;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(env.OIDC_ISSUER)
      .setAudience(env.OIDC_AUDIENCE)
      .setSubject("owner-one")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const req = () =>
      new Request("https://jobpilot.example/api/account", {
        headers: {
          Authorization: "Bearer " + token,
          "x-verified-owner": "victim",
        },
      });
    const r = await handler.fetch(req(), env);
    expect(r.status).toBe(200);
    expect(names).toEqual(["owner-one"]);
    expect(await r.json()).toEqual({ owner: "owner-one" });
    env.OIDC_AUDIENCE = "different";
    expect((await handler.fetch(req(), env)).status).toBe(401);
  });
  it("rejects cross-origin mutations and large bodies", async () => {
    const { env } = setup();
    expect(
      (
        await handler.fetch(
          new Request("http://localhost:8787/api/runs", {
            method: "POST",
            headers: { origin: "https://evil.example" },
            body: "{}",
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler.fetch(
          new Request("http://localhost:8787/api/profile", {
            method: "PUT",
            body: "a".repeat(40001),
          }),
          env,
        )
      ).status,
    ).toBe(413);
  });
  it("keeps unknown eligibility out of drafting", () => {
    expect(
      canDraft({
        evaluation: { eligibility: "UNVERIFIED", language: "PASS", score: 100 },
      } as any),
    ).toBe(false);
  });
});
describe("billing verification", () => {
  it("accepts only fresh, untampered Stripe signatures", async () => {
    const raw = '{"type":"invoice.paid"}',
      secret = "test-secret",
      t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(t + "." + raw),
      ),
    ).toString("hex");
    expect(await verifyWebhook(raw, `t=${t},v1=${sig}`, secret)).toBe(true);
    expect(await verifyWebhook(raw + " ", `t=${t},v1=${sig}`, secret)).toBe(
      false,
    );
    expect(
      await verifyWebhook(raw, `t=${t},v1=${sig}`, secret, (t + 301) * 1000),
    ).toBe(false);
    expect(await verifyWebhook(raw, `t=${t},v1=bad`, secret)).toBe(false);
  });
  it("does not grant access for the wrong price", async () => {
    const { env } = setup(false);
    env.STRIPE_SECRET_KEY = "test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              status: "active",
              current_period_end: Math.floor(Date.now() / 1000) + 1000,
              items: { data: [{ price: { id: "wrong-price" } }] },
            },
          ],
        }),
      ),
    );
    expect((await currentEntitlement(env, "cus_one")).active).toBe(false);
  });
});
describe("Orca interoperability", () => {
  it("uses real Orca core to seal validated events and manifest; refuses overwrite", async () => {
    const s = await started();
    await s.call(`/runs/${s.run.id}/control`, "POST", { action: "cancel" });
    const audit = (await (
      await s.call(`/runs/${s.run.id}/trace`)
    ).json()) as any;
    const dir = await mkdtemp(join(tmpdir(), "jobpilot-orca-"));
    try {
      const target = await exportAudit(audit, dir);
      const manifest = JSON.parse(
        await readFile(join(target, "manifest.json"), "utf8"),
      );
      expect(validateManifest(manifest).valid).toBe(true);
      const events = (await readFile(join(target, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.every((e) => validateEvent(e).valid)).toBe(true);
      expect(manifest.integrity.events_sha256).toBe(
        createHash("sha256")
          .update(await readFile(join(target, "events.jsonl")))
          .digest("hex"),
      );
      await expect(
        exportAudit(
          {
            ...audit,
            events: audit.events.map((e: any, i: number) => ({
              ...e,
              seq: i + 1,
            })),
          },
          dir,
        ),
      ).rejects.toThrow("Non-contiguous");
      await expect(exportAudit(audit, dir)).rejects.toThrow();
      await expect(
        exportAudit({ ...audit, status: "running" }, dir),
      ).rejects.toThrow("Finish or cancel");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("storage and provider failures", () => {
  it("stores retained runs outside the account metadata value", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs = Array.from({ length: 30 }, (_, i) => ({
      ...structuredClone(a.runs[0]),
      id: "run_" + i.toString(16).padStart(32, "0"),
      status: "completed" as const,
      jobs: [
        {
          id: "job",
          title: "Role",
          company: "Company",
          location: "US",
          url: "https://example.com",
          description: "a".repeat(128000),
          date: null,
        },
      ],
    }));
    await s.agent.save(a);
    expect(JSON.stringify(await s.storage.get("account")).length).toBeLessThan(
      10000,
    );
    expect((await s.agent.read()).runs).toHaveLength(30);
    a.runs = a.runs.slice(1);
    await s.agent.save(a);
    expect(await s.storage.get("run_" + "0".repeat(32))).toBeUndefined();
  });
  it("reserves a failed model call and never falls back to demo output", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs[0].demo = false;
    s.env.AI = {
      run: vi.fn(async () => ({ response: "not valid JSON" })),
    } as any;
    await s.agent.save(a);
    await s.agent.alarm();
    const r = (await s.agent.read()).runs[0];
    expect(r.status).toBe("failed");
    expect(r.modelCalls).toBe(1);
    expect(r.query).toBeUndefined();
    expect(r.error).toContain("invalid structured output");
  });
  it("rejects invented evidence from an otherwise valid model response", async () => {
    const s = await started();
    await s.agent.alarm();
    await s.agent.alarm();
    const a = await s.agent.read();
    a.runs[0].demo = false;
    s.env.AI = {
      run: vi.fn(async () => ({
        response: JSON.stringify({
          score: 100,
          eligibility: "PASS",
          language: "PASS",
          reason: "A match",
          evidence: ["Invented quote"],
          gaps: [],
        }),
      })),
    } as any;
    await s.agent.save(a);
    await s.agent.alarm();
    const r = (await s.agent.read()).runs[0];
    expect(r.status).toBe("failed");
    expect(r.jobs[0].evaluation).toBeUndefined();
    expect(r.error).toContain("not found in the posting");
  });
  it("does not resume under a different methodology than the recorded digest", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs[0].contextHash = "old";
    await s.agent.save(a);
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].error).toContain(
      "methodology changed",
    );
  });
});

describe("run recovery and entitlement regressions", () => {
  it("normalizes uppercase request UUIDs for retrieval and idempotent retries", async () => {
    const s = setup();
    await s.call("/profile", "PUT", profile);
    const requestId = crypto.randomUUID().toUpperCase();
    const first = (await (
      await s.call("/runs", "POST", { requestId })
    ).json()) as any;
    expect((await s.call(`/runs/${first.id}`)).status).toBe(200);
    expect(
      (await s.call("/runs", "POST", { requestId: requestId.toLowerCase() }))
        .status,
    ).toBe(200);
    expect((await s.agent.read()).used).toBe(1);
  });
  it("resets the calendar-month allowance only when creating the first new run", async () => {
    const s = setup();
    await s.call("/profile", "PUT", profile);
    const a = await s.agent.read();
    a.month = "2000-01";
    a.used = 60;
    await s.agent.save(a);
    expect(
      (await s.call("/runs", "POST", { requestId: crypto.randomUUID() }))
        .status,
    ).toBe(201);
    expect((await s.agent.read()).used).toBe(1);
    expect((await s.agent.read()).month).toBe(
      new Date().toISOString().slice(0, 7),
    );
  });
  it("resumes a failed model step with a charged retry, retaining the original run", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs[0].demo = false;
    await s.agent.save(a);
    const modelRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary model outage"))
      .mockResolvedValueOnce({
        response: JSON.stringify({
          query: "Platform Engineer",
          reason: "Supported profile skills",
        }),
      });
    s.env.AI = { run: modelRun } as any;
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].status).toBe("failed");
    expect(
      (await s.call(`/runs/${s.run.id}/control`, "POST", { action: "retry" }))
        .status,
    ).toBe(200);
    await s.agent.alarm();
    const r = (await s.agent.read()).runs[0];
    expect(r.stage).toBe("search");
    expect(r.error).toBeUndefined();
    expect(r.modelCalls).toBe(2);
    expect(r.attempts["plan:0"]).toBe(2);
    expect((await s.agent.read()).used).toBe(1);
  });
  it("refuses further model work or retries at the reserved call budget", async () => {
    const s = await started();
    const a = await s.agent.read();
    a.runs[0].modelCalls = 20;
    await s.agent.save(a);
    await s.agent.alarm();
    expect((await s.agent.read()).runs[0].modelCalls).toBe(20);
    expect(
      (await s.call(`/runs/${s.run.id}/control`, "POST", { action: "retry" }))
        .status,
    ).toBe(409);
  });
  it("rechecks membership at shortlist approval and makes no decision on failure", async () => {
    const s = await started();
    await toReview(s);
    s.env.DEMO_MODE = "false";
    expect(
      (
        await s.call(`/runs/${s.run.id}/decisions`, "POST", {
          approvedIds: ["demo-1"],
        })
      ).status,
    ).toBe(402);
    const r = (await s.agent.read()).runs[0];
    expect(r.status).toBe("review");
    expect(r.jobs.every((j) => j.decision === undefined)).toBe(true);
  });
  it.each([
    "expired",
    "missing-exp",
    "wrong-issuer",
    "future-not-before",
    "missing-subject",
  ])("rejects signed but invalid JWT claims: %s", async (variant) => {
    const pair = await generateKeyPair("RS256");
    keys.local = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] });
    const { env } = setup(false);
    const lookup = vi.fn();
    env.ACCOUNTS = { idFromName: lookup } as any;
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(
        variant === "wrong-issuer" ? "https://other.example/" : env.OIDC_ISSUER,
      )
      .setAudience(env.OIDC_AUDIENCE);
    if (variant !== "missing-exp")
      jwt.setExpirationTime(variant === "expired" ? 0 : "5m");
    if (variant !== "missing-subject") jwt.setSubject("candidate");
    if (variant === "future-not-before") jwt.setNotBefore("5m");
    const signed = await jwt.sign(pair.privateKey);
    const response = await handler.fetch(
      new Request("https://jobpilot.example/api/account", {
        headers: { Authorization: "Bearer " + signed },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("Stripe HTTP and checkout boundaries", () => {
  async function signedBody(raw: string, secret: string) {
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${raw}`),
      ),
    ).toString("hex");
    return `t=${timestamp},v1=${digest}`;
  }
  it.each(["invoice.paid", "customer.subscription.deleted"])(
    "routes a signed %s webhook to the provider-owned account",
    async (type) => {
      const { env } = setup(false);
      env.STRIPE_WEBHOOK_SECRET = "webhook-secret";
      env.STRIPE_SECRET_KEY = "stripe-secret";
      const lookup = vi.fn((owner: string) => owner);
      const sync = vi.fn(async () => Response.json({ ok: true }));
      env.ACCOUNTS = {
        idFromName: lookup,
        get: () => ({ fetch: sync }),
      } as any;
      const provider = vi.fn(async () =>
        Response.json({ metadata: { owner: "verified-customer-owner" } }),
      );
      vi.stubGlobal("fetch", provider);
      const raw = JSON.stringify({
        type,
        data: {
          object: {
            customer: "cus_test",
            metadata: { owner: "attacker" },
            status: "active",
          },
        },
      });
      const response = await handler.fetch(
        new Request("https://jobpilot.example/api/billing/webhook", {
          method: "POST",
          body: raw,
          headers: {
            "stripe-signature": await signedBody(
              raw,
              env.STRIPE_WEBHOOK_SECRET,
            ),
          },
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(lookup).toHaveBeenCalledWith("verified-customer-owner");
      expect(provider.mock.calls[0][0]).toBe(
        "https://api.stripe.com/v1/customers/cus_test",
      );
      expect(sync).toHaveBeenCalledWith("https://internal/api/billing/sync", {
        method: "POST",
      });
    },
  );
  it("rejects a webhook before provider calls if its body was tampered with", async () => {
    const { env } = setup(false);
    env.STRIPE_WEBHOOK_SECRET = "webhook-secret";
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const raw = JSON.stringify({ type: "invoice.paid" });
    const response = await handler.fetch(
      new Request("https://jobpilot.example/api/billing/webhook", {
        method: "POST",
        body: raw + " ",
        headers: {
          "stripe-signature": await signedBody(raw, env.STRIPE_WEBHOOK_SECRET),
        },
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
  it("returns a retryable error when signed webhook synchronization fails", async () => {
    const { env } = setup(false);
    env.STRIPE_WEBHOOK_SECRET = "webhook-secret";
    env.STRIPE_SECRET_KEY = "stripe-secret";
    env.ACCOUNTS = {
      idFromName: (s: string) => s,
      get: () => ({
        fetch: async () => new Response("Failed", { status: 500 }),
      }),
    } as any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ metadata: { owner: "candidate" } })),
    );
    const raw = JSON.stringify({
      type: "invoice.paid",
      data: { object: { customer: "cus_test" } },
    });
    const response = await handler.fetch(
      new Request("https://jobpilot.example/api/billing/webhook", {
        method: "POST",
        body: raw,
        headers: {
          "stripe-signature": await signedBody(raw, env.STRIPE_WEBHOOK_SECRET),
        },
      }),
      env,
    );
    expect(response.status).toBe(502);
  });
  it("creates checkout only for the configured price and stored customer", async () => {
    const s = setup(false);
    s.env.STRIPE_SECRET_KEY = "stripe-secret";
    const a = await s.agent.read();
    a.entitlement.customerId = "cus_own";
    await s.agent.save(a);
    const provider = vi.fn(async () =>
      Response.json({ url: "https://checkout.stripe.com/test" }),
    );
    vi.stubGlobal("fetch", provider);
    const response = await s.call("/billing/checkout", "POST", {
      price: "price_free",
      customer: "cus_other",
      success_url: "https://evil.example",
    });
    expect(response.status).toBe(200);
    const [, init] = provider.mock.calls[0] as unknown as [string, RequestInit];
    const body = init.body as URLSearchParams;
    expect(body.get("line_items[0][price]")).toBe("price_member");
    expect(body.get("customer")).toBe("cus_own");
    expect(body.get("success_url")).toBe(
      "https://jobpilot.example/?billing=success",
    );
  });
  it("blocks an additional checkout for an active member", async () => {
    const s = setup(false);
    const a = await s.agent.read();
    a.entitlement = {
      active: true,
      status: "active",
      expiresAt: Date.now() + 60000,
      customerId: "cus_own",
    };
    await s.agent.save(a);
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    expect((await s.call("/billing/checkout", "POST", {})).status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
  });
});
