import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  account,
  createRun,
  waitForRun,
  navigate,
  profile,
} from "./fixtures";

test("profile changes persist after navigation and reload", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await navigate(page, "Your profile");
  await page.getByLabel("Your name").fill("UAT Updated Candidate");
  // Native browser validation refuses a one-character country code.
  await page.getByLabel("Country (two-letter code)").fill("U");
  await page.getByRole("button", { name: "Save profile" }).click();
  expect(
    await page
      .getByLabel("Country (two-letter code)")
      .evaluate((el: HTMLInputElement) => el.validity.valid),
  ).toBe(false);
  expect((await account(request)).profile.name).toBe(profile.name);
  await page.getByLabel("Country (two-letter code)").fill("GB");
  await page.getByLabel("Remote roles only").uncheck();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(
    page.getByText("Profile saved. Your next search will use these details."),
  ).toBeVisible();
  await page.reload();
  await navigate(page, "Your profile");
  await expect(page.getByLabel("Your name")).toHaveValue(
    "UAT Updated Candidate",
  );
  await expect(page.getByLabel("Country (two-letter code)")).toHaveValue("GB");
  await expect(page.getByLabel("Remote roles only")).not.toBeChecked();
});

test("search can pause, survive reload, resume and prepare only approved drafts", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New search" }).click();
  await page.getByRole("button", { name: "Pause", exact: false }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: false }),
  ).toBeVisible();
  const paused = (await account(request)).runs[0];
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume", exact: false }),
  ).toBeVisible();
  expect((await account(request)).runs[0].modelCalls).toBe(paused.modelCalls);
  await page.getByRole("button", { name: "Resume", exact: false }).click();
  await expect(
    page.getByRole("button", { name: "Finish review & prepare drafts" }),
  ).toBeVisible({ timeout: 25000 });
  await expect(
    page.getByLabel("Blocked: work rights and language"),
  ).toBeDisabled();
  await page.getByText("See evidence & gaps").first().click();
  await expect(page.locator("blockquote").first()).toContainText(
    "DEMO FIXTURE",
  );
  await page.getByLabel("Prepare draft", { exact: true }).check();
  await page
    .getByRole("button", { name: "Finish review & prepare drafts" })
    .click();
  const completed = await waitForRun(request, paused.id, "completed");
  expect(completed.jobs.filter((j) => j.draft)).toHaveLength(1);
  expect(completed.jobs.find((j) => j.id === "demo-2")?.draft).toBeUndefined();
  await expect(
    page.getByText("Read application draft", { exact: true }),
  ).toBeVisible();
  await page.getByText("Read application draft", { exact: true }).click();
  await expect(
    page.getByText("Unverified text draft · Check before use"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("reviewed-draft.png"),
    fullPage: true,
  });
});

test("rejecting the entire shortlist completes without drafting", async ({
  page,
  request,
}) => {
  const run = await createRun(request);
  await waitForRun(request, run.id, "review");
  await page.goto("/");
  await page
    .getByRole("button", { name: "Finish review & prepare drafts" })
    .click();
  const done = await waitForRun(request, run.id, "completed");
  expect(done.jobs.every((j) => j.decision === "rejected" && !j.draft)).toBe(
    true,
  );
  await page.reload();
  await expect(
    page.getByText("Read application draft", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New search" })).toBeEnabled();
});

test("cancellation persists in history and timeline export stays private", async ({
  page,
  request,
}) => {
  const run = await createRun(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await waitForRun(request, run.id, "cancelled");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume", exact: false }),
  ).toHaveCount(0);
  await navigate(page, "Run history");
  await page.locator(`[data-run="${run.id}"]`).click();
  await page.getByRole("button", { name: "Inspect run timeline" }).click();
  const slider = page.getByRole("slider", { name: "Timeline position" });
  await expect(slider).toBeVisible();
  await slider.focus();
  await page.keyboard.press("End");
  await expect(page.locator(".trace-detail")).toContainText("run.end");
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download Orca audit export" })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(run.id + ".json");
  const audit = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(audit.status).toBe("cancelled");
  expect(audit.events[0].type).toBe("run.start");
  expect(audit.events.at(-1).type).toBe("run.end");
  expect(JSON.stringify(audit)).not.toContain(profile.experience);
  expect(audit.scope).toContain("replay is unavailable");
});

test("a failed start shows an error, restores controls and creates no ghost run", async ({
  page,
  request,
}) => {
  const before = (await account(request)).used;
  await page.goto("/");
  await page.route("**/api/runs", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "UAT: service temporarily unavailable" },
    }),
  );
  await page.getByRole("button", { name: "New search" }).click();
  await expect(page.getByRole("status")).toContainText(
    "UAT: service temporarily unavailable",
  );
  await expect(page.getByRole("button", { name: "New search" })).toBeEnabled();
  expect((await account(request)).used).toBe(before);
  await page.unroute("**/api/runs");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("demo billing is visibly disabled and cannot be bypassed through the API", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await navigate(page, "Membership");
  await expect(
    page.getByRole("button", { name: "View price & subscribe" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Payments are disabled in the local demo."),
  ).toBeVisible();
  expect(
    (await request.post("/api/billing/checkout", { data: {} })).status(),
  ).toBe(409);
  expect(
    (await request.post("/api/billing/portal", { data: {} })).status(),
  ).toBe(409);
});

test("untrusted profile text renders literally without script execution", async ({
  page,
  request,
}) => {
  const injected = '<img src=x onerror="window.uatInjected=true">';
  await request.put("/api/profile", { data: { ...profile, role: injected } });
  await page.goto("/");
  await expect(page.locator(".mission h2")).toHaveText(injected);
  expect(await page.evaluate(() => Boolean((window as any).uatInjected))).toBe(
    false,
  );
  await expect(page.locator(".mission img")).toHaveCount(0);
});

test("handoff export carries evaluated postings, decisions and drafts for the local workflow", async ({
  page,
  request,
}) => {
  const run = await createRun(request);
  await waitForRun(request, run.id, "review");
  expect(
    (
      await request.post(`/api/runs/${run.id}/decisions`, {
        data: { approvedIds: ["demo-1"] },
      })
    ).ok(),
  ).toBe(true);
  await waitForRun(request, run.id, "completed");
  await page.goto("/");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export for /apply" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(run.id + "-handoff.json");
  const bundle = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(bundle.format).toBe("jobpilot-handoff-v1");
  expect(bundle.jobs.map((j: any) => [j.id, j.decision])).toEqual([
    ["demo-1", "approved"],
    ["demo-2", "rejected"],
  ]);
  expect(bundle.jobs[0].description).toContain("DEMO FIXTURE");
  expect(bundle.jobs[0].draft.coverLetter).toContain("DEMO DRAFT");
  expect(JSON.stringify(bundle)).not.toContain(profile.workRights);
  await expect(page.getByRole("status")).toContainText(
    "tools/import_jobpilot.py",
  );
});

test("profile save names the rejected field and the form mirrors the schema limits", async ({
  page,
}) => {
  await page.goto("/");
  await navigate(page, "Your profile");
  await expect(page.getByLabel("Your actual experience")).toHaveAttribute(
    "minlength",
    "20",
  );
  await expect(page.getByLabel("Your actual experience")).toHaveAttribute(
    "maxlength",
    "6000",
  );
  await expect(page.getByLabel("Your name")).toHaveAttribute(
    "maxlength",
    "100",
  );
  await page.route("**/api/profile", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: "Invalid input",
        details: [
          "experience: Too small: expected string to have >=20 characters",
        ],
      },
    }),
  );
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("experience");
  await page.unroute("**/api/profile");
});

test("draft controls copy to the clipboard and download as Markdown", async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const run = await createRun(request);
  await waitForRun(request, run.id, "review");
  await request.post(`/api/runs/${run.id}/decisions`, {
    data: { approvedIds: ["demo-1"] },
  });
  await waitForRun(request, run.id, "completed");
  await page.goto("/");
  await page.getByText("Read application draft", { exact: true }).click();
  await page.getByRole("button", { name: "Copy cover letter" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "DEMO DRAFT",
  );
  await page.getByRole("button", { name: "Copy CV bullets" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    profile.experience,
  );
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download draft" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(run.id + "-demo-1-draft.md");
  const markdown = await readFile((await download.path())!, "utf8");
  expect(markdown).toContain("DEMO DRAFT");
  expect(markdown).toContain("## Suggested CV bullets");
  expect(markdown).toContain("Check before use");
});

test("cards show the posting age and a blocked role says why", async ({
  page,
  request,
}) => {
  const run = await createRun(request);
  await waitForRun(request, run.id, "review");
  await page.goto("/");
  await expect(page.getByText("Posted today").first()).toBeVisible();
  await expect(
    page.getByLabel("Blocked: work rights and language"),
  ).toBeDisabled();
  await expect(page.getByLabel("Prepare draft", { exact: true })).toBeEnabled();
});

test("marking a posting as applied persists across reload and is counted in history", async ({
  page,
  request,
}) => {
  const run = await createRun(request);
  await waitForRun(request, run.id, "review");
  await request.post(`/api/runs/${run.id}/decisions`, {
    data: { approvedIds: ["demo-1"] },
  });
  await waitForRun(request, run.id, "completed");
  await page.goto("/");
  await page.getByRole("button", { name: "Mark as applied" }).first().click();
  await expect(page.getByText("Applied on").first()).toBeVisible();
  await page.reload();
  await expect(page.getByText("Applied on").first()).toBeVisible();
  const stored = (await account(request)).runs.find(
    (r: any) => r.id === run.id,
  );
  expect(stored.jobs[0].applied).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(stored.jobs[1].applied).toBeUndefined();
  await navigate(page, "Run history");
  await expect(page.locator(`[data-run="${run.id}"]`)).toContainText(
    "1 applied",
  );
  await page.locator(`[data-run="${run.id}"]`).click();
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByText("Applied on")).toHaveCount(0);
});
