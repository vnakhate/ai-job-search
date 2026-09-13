import { test, expect, account, waitForRun } from "./fixtures";
// Runtime integration acceptance: these requests hit actual workerd Durable Objects.
test("concurrent duplicate requests reserve one run and concurrent competing requests conflict", async ({
  request,
}) => {
  const before = await account(request);
  const requestId = crypto.randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      request.post("/api/runs", { data: { requestId } }),
    ),
  );
  expect(responses.map((r) => r.status()).sort()).toEqual([200, 200, 200, 201]);
  const ids = await Promise.all(
    responses.map(async (r) => (await r.json()).id),
  );
  expect(new Set(ids).size).toBe(1);
  const competitors = await Promise.all(
    Array.from({ length: 2 }, () =>
      request.post("/api/runs", { data: { requestId: crypto.randomUUID() } }),
    ),
  );
  expect(competitors.every((r) => r.status() === 409)).toBe(true);
  expect((await account(request)).used).toBe(before.used + 1);
  await request.post(`/api/runs/${ids[0]}/control`, {
    data: { action: "cancel" },
  });
  await waitForRun(request, ids[0], "cancelled");
});
test("real API rejects unsafe origins, malformed JSON, oversized bodies and unknown runs", async ({
  request,
}) => {
  expect(
    (
      await request.post("/api/runs", {
        headers: { Origin: "https://evil.example" },
        data: { requestId: crypto.randomUUID() },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.put("/api/profile", {
        headers: { "Content-Type": "application/json" },
        data: "{",
      })
    ).status(),
  ).toBe(400);
  expect(
    (await request.put("/api/profile", { data: "a".repeat(40001) })).status(),
  ).toBe(413);
  expect((await request.get("/api/runs/run_" + "0".repeat(32))).status()).toBe(
    404,
  );
  const response = await request.get("/api/account");
  expect(response.headers()["cache-control"]).toBe("no-store");
});
