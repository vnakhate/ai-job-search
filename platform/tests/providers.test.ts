import { it, expect, vi, afterEach } from "vitest";
import { searchJobs } from "../worker/providers";
import type { Env, Profile } from "../worker/contracts";
const p = { country: "US", remote: true } as Profile;
const env = { DEMO_MODE: "false" } as Env;
afterEach(() => vi.unstubAllGlobals());
it("honors source filters and excludes closed/stale/duplicate listings", async () => {
  const job = {
    public_slug: "one",
    title: "Engineer",
    company: "Example",
    url: "https://example.com/jobs/one",
    description: "Real posting text",
    posted_at: new Date().toISOString(),
  };
  const spy = vi.fn(async () =>
    Response.json({
      data: [
        job,
        { ...job, public_slug: "duplicate" },
        {
          ...job,
          public_slug: "closed",
          title: "Closed role",
          closed_at: new Date().toISOString(),
        },
        {
          ...job,
          public_slug: "old",
          title: "Old role",
          posted_at: "2020-01-01",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", spy);
  const results = await searchJobs(env, p, "Engineer");
  expect(results.map((r) => r.id)).toEqual(["one"]);
  const url = new URL(String(spy.mock.calls[0][0]));
  expect(url.hostname).toBe("freehire.me");
  expect(url.searchParams.get("countries")).toBe("US");
  expect(url.searchParams.get("work_mode")).toBe("remote");
  expect(url.searchParams.get("posted_within_days")).toBe("14");
});
it("surfaces provider outages and schema changes without invented jobs", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Unavailable", { status: 503 })),
  );
  await expect(searchJobs(env, p, "Engineer")).rejects.toThrow("503");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ unexpected: [] })),
  );
  await expect(searchJobs(env, p, "Engineer")).rejects.toThrow();
});
