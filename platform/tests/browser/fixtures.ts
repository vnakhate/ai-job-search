import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { Run } from "../../worker/contracts";
export const profile = {
  name: "UAT Candidate",
  country: "US",
  role: "Platform Engineer",
  skills: "TypeScript, APIs",
  experience: "Built and maintained backend APIs for five years.",
  languages: "English fluent",
  workRights: "US citizen",
  constraints: "",
  remote: true,
};
export async function account(request: APIRequestContext) {
  const response = await request.get("/api/account");
  expect(response.ok()).toBe(true);
  return response.json();
}
export async function createRun(request: APIRequestContext): Promise<Run> {
  const response = await request.post("/api/runs", {
    data: { requestId: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  return response.json();
}
export async function waitForRun(
  request: APIRequestContext,
  id: string,
  status: string,
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/runs/${id}`);
        expect(response.ok()).toBe(true);
        return (await response.json()).status;
      },
      { timeout: 25000, intervals: [250, 500, 1000] },
    )
    .toBe(status);
  return (await (await request.get(`/api/runs/${id}`)).json()) as Run;
}
export async function navigate(page: Page, name: string) {
  await page.getByRole("navigation").getByRole("button", { name }).click();
}
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page, request, baseURL }, use) => {
      expect(baseURL).toBe("http://localhost:8798");
      const before = await account(request);
      expect(before.demo).toBe(true);
      for (const run of before.runs)
        if (!["completed", "cancelled"].includes(run.status)) {
          expect(
            (
              await request.post(`/api/runs/${run.id}/control`, {
                data: { action: "cancel" },
              })
            ).ok(),
          ).toBe(true);
        }
      expect((await request.put("/api/profile", { data: profile })).ok()).toBe(
        true,
      );
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await use();
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
