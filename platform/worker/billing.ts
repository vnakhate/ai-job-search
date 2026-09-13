import { type Env, type Entitlement, HttpError } from "./contracts";
export async function stripe(
  env: Env,
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<any> {
  if (!env.STRIPE_SECRET_KEY)
    throw new HttpError(503, "Billing has not been configured");
  const response = await fetch("https://api.stripe.com/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok)
    throw new HttpError(502, "Billing provider could not complete the request");
  return response.json();
}
export async function verifyWebhook(
  raw: string,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  const parts = signature.split(",").map((s) => s.split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > 300)
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const [, value] of parts.filter((p) => p[0] === "v1")) {
    if (!/^[a-f0-9]{64}$/i.test(value || "")) continue;
    const sig = Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        sig,
        new TextEncoder().encode(`${t}.${raw}`),
      )
    )
      return true;
  }
  return false;
}
export async function currentEntitlement(
  env: Env,
  customerId: string,
): Promise<Entitlement> {
  // Fetch current provider state instead of trusting webhook order or checkout redirects.
  const subscriptions = await stripe(
    env,
    `subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`,
  );
  const valid = subscriptions.data.filter(
    (s: any) =>
      ["active", "trialing"].includes(s.status) &&
      s.items.data.some((i: any) => i.price.id === env.STRIPE_PRICE_ID),
  );
  const expiresAt = Math.max(
    0,
    ...valid.map(
      (s: any) =>
        Number(
          s.current_period_end ||
            Math.max(
              ...s.items.data
                .filter((i: any) => i.price.id === env.STRIPE_PRICE_ID)
                .map((i: any) => i.current_period_end || 0),
            ),
        ) * 1000,
    ),
  );
  return {
    customerId,
    active: expiresAt > Date.now(),
    expiresAt,
    status: expiresAt > Date.now() ? "active" : "inactive",
  };
}
