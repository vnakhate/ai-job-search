import { afterEach, it, expect, vi } from "vitest";
import { currentEntitlement, stripe, verifyWebhook } from "../worker/billing";
import type { Env } from "../worker/contracts";
const env = {
  STRIPE_SECRET_KEY: "test-key",
  STRIPE_PRICE_ID: "price_member",
} as Env;
afterEach(() => vi.unstubAllGlobals());
it.each(["active", "trialing"])(
  "grants unexpired %s membership using item-level billing periods",
  async (status) => {
    const end = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              status,
              items: {
                data: [
                  { price: { id: "price_member" }, current_period_end: end },
                ],
              },
            },
          ],
        }),
      ),
    );
    expect(await currentEntitlement(env, "cus_member")).toEqual({
      active: true,
      expiresAt: end * 1000,
      status: "active",
      customerId: "cus_member",
    });
  },
);
it.each([
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
])("denies %s subscriptions even with a future period", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: [
          {
            status,
            current_period_end: Math.floor(Date.now() / 1000) + 3600,
            items: { data: [{ price: { id: "price_member" } }] },
          },
        ],
      }),
    ),
  );
  expect((await currentEntitlement(env, "cus_member")).active).toBe(false);
});
it("does not extend an expired membership with an unrelated subscription item", async () => {
  const expired = Math.floor(Date.now() / 1000) - 1;
  const future = expired + 7200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: [
          {
            status: "active",
            items: {
              data: [
                { price: { id: "price_member" }, current_period_end: expired },
                { price: { id: "price_other" }, current_period_end: future },
              ],
            },
          },
        ],
      }),
    ),
  );
  expect((await currentEntitlement(env, "cus_member")).active).toBe(false);
});
it("uses current provider state after subscription removal", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        data: [
          {
            status: "active",
            current_period_end: Math.floor(Date.now() / 1000) + 1000,
            items: { data: [{ price: { id: "price_member" } }] },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetcher);
  expect((await currentEntitlement(env, "cus_member")).active).toBe(true);
  expect((await currentEntitlement(env, "cus_member")).active).toBe(false);
});
it("keeps a fixed provider origin and sends idempotency only in request headers", async () => {
  const mock = vi.fn(async () => Response.json({ id: "cus_test" }));
  vi.stubGlobal("fetch", mock);
  const body = new URLSearchParams({ "metadata[owner]": "candidate" });
  await stripe(env, "customers", body, "same-operation");
  expect(mock).toHaveBeenCalledWith(
    "https://api.stripe.com/v1/customers",
    expect.objectContaining({
      method: "POST",
      body,
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": "same-operation",
      },
    }),
  );
});
it("reports missing billing configuration or provider failure without exposing credentials", async () => {
  const mock = vi.fn(
    async () => new Response("secret provider internals", { status: 500 }),
  );
  vi.stubGlobal("fetch", mock);
  await expect(stripe({} as Env, "customers")).rejects.toMatchObject({
    status: 503,
  });
  expect(mock).not.toHaveBeenCalled();
  await expect(stripe(env, "customers")).rejects.toMatchObject({
    status: 502,
    message: "Billing provider could not complete the request",
  });
});
it.each(["", "t=bad,v1=deadbeef", "t=1", "v1=deadbeef"])(
  "rejects malformed webhook headers %s",
  async (signature) => {
    expect(await verifyWebhook("{}", signature, "secret")).toBe(false);
  },
);
