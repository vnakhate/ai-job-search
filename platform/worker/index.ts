import { createRemoteJWKSet, jwtVerify } from "jose";
import { type Env, HttpError, isDemo } from "./contracts";
import { verifyWebhook, stripe } from "./billing";
export { AccountAgent } from "./account";
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(request: Request, env: Env) {
  if (isDemo(env)) return "local-demo";
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, "Sign in to continue");
  if (!env.OIDC_ISSUER.startsWith("https://") || !env.OIDC_AUDIENCE)
    throw new HttpError(503, "Authentication is not configured");
  let keys = jwks.get(env.OIDC_ISSUER);
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL(".well-known/jwks.json", env.OIDC_ISSUER),
    );
    jwks.set(env.OIDC_ISSUER, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.OIDC_ISSUER,
      audience: env.OIDC_AUDIENCE,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub"],
    });
    if (!payload.sub || payload.sub.length > 250) throw new Error("subject");
    return payload.sub;
  } catch {
    throw new HttpError(401, "Your session has expired; sign in again");
  }
}
async function bodyLimit(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 40000) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (isDemo(env) && !["localhost", "127.0.0.1"].includes(url.hostname))
        throw new HttpError(403, "Demo is restricted to local requests");
      if (
        request.headers.get("origin") &&
        request.headers.get("origin") !== env.APP_ORIGIN
      )
        throw new HttpError(403, "Origin is not allowed");
      if (url.pathname === "/api/config" && request.method === "GET")
        return Response.json({
          demo: isDemo(env),
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          iosClientId: env.OIDC_IOS_CLIENT_ID || "",
          audience: env.OIDC_AUDIENCE,
        });
      if (url.pathname === "/api/health" && request.method === "GET")
        return Response.json({ ok: true, service: "jobpilot" });
      const bytes = await bodyLimit(request);
      if (
        url.pathname === "/api/billing/webhook" &&
        request.method === "POST"
      ) {
        if (!env.STRIPE_WEBHOOK_SECRET)
          throw new HttpError(503, "Webhook is not configured");
        const raw = new TextDecoder().decode(bytes);
        if (
          !(await verifyWebhook(
            raw,
            request.headers.get("stripe-signature") || "",
            env.STRIPE_WEBHOOK_SECRET,
          ))
        )
          throw new HttpError(400, "Invalid webhook signature");
        const evt = JSON.parse(raw);
        const accepted = [
          "checkout.session.completed",
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
          "invoice.paid",
          "invoice.payment_failed",
        ];
        if (accepted.includes(evt.type)) {
          const id = evt.data?.object?.customer;
          if (typeof id !== "string" || !/^cus_[A-Za-z0-9]+$/.test(id))
            throw new HttpError(400, "Missing billing customer");
          const customer = await stripe(env, "customers/" + id);
          const owner = customer.metadata?.owner;
          if (owner) {
            const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner));
            const result = await stub.fetch(
              "https://internal/api/billing/sync",
              { method: "POST" },
            );
            if (!result.ok)
              throw new HttpError(502, "Billing synchronization failed");
          }
        }
        response = Response.json({ received: true });
      } else {
        const owner = await authenticate(request, env);
        const headers = new Headers({
          "content-type": "application/json",
          "x-verified-owner": owner,
        });
        response = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(owner)).fetch(
          new Request(url, {
            method: request.method,
            headers,
            ...(!["GET", "HEAD"].includes(request.method)
              ? { body: bytes }
              : {}),
          }),
        );
      }
    } catch (e) {
      response = Response.json(
        { error: e instanceof HttpError ? e.message : "Request failed" },
        { status: e instanceof HttpError ? e.status : 500 },
      );
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
