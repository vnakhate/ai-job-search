import { readFile } from "node:fs/promises";
import ts from "typescript";
const parsed = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
if (parsed.error) throw new Error("Invalid wrangler.jsonc");
const config = parsed.config;
const v = config.vars;
for (const key of [
  "APP_ORIGIN",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_IOS_CLIENT_ID",
  "OIDC_AUDIENCE",
  "STRIPE_PRICE_ID",
]) {
  if (!v[key] || v[key].includes("configure-your"))
    throw new Error(`Configure ${key} in wrangler.jsonc before deploying`);
}
if (
  v.DEMO_MODE !== "false" ||
  !v.APP_ORIGIN.startsWith("https://") ||
  !v.OIDC_ISSUER.startsWith("https://")
)
  throw new Error("Production requires HTTPS and demo mode disabled");
console.log(
  "Public configuration checked. Stripe secrets must already be installed with wrangler secret put.",
);
