export interface Config {
  demo: boolean;
  issuer: string;
  clientId: string;
  audience: string;
}
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export function token() {
  return sessionStorage.getItem("access_token");
}
export function logout() {
  sessionStorage.removeItem("access_token");
  location.assign("/");
}
export async function login(c: Config) {
  if (!c.clientId || !c.issuer)
    throw new Error("Sign-in must be configured before launch");
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32))),
    state = b64(crypto.getRandomValues(new Uint8Array(24)));
  sessionStorage.setItem("oauth", JSON.stringify({ verifier, state }));
  const challenge = b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const u = new URL("authorize", c.issuer);
  u.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: location.origin + "/",
    response_type: "code",
    scope: "openid profile email",
    audience: c.audience,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  location.assign(u.href);
}
export async function callback(c: Config) {
  const p = new URLSearchParams(location.search);
  if (p.get("error")) {
    history.replaceState({}, "", "/");
    throw new Error("Sign-in was cancelled or denied");
  }
  if (!p.has("code")) return;
  const saved = JSON.parse(sessionStorage.getItem("oauth") || "null");
  sessionStorage.removeItem("oauth");
  history.replaceState({}, "", "/");
  if (!saved || saved.state !== p.get("state"))
    throw new Error("Sign-in state did not match. Please sign in again.");
  const r = await fetch(new URL("oauth/token", c.issuer), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: c.clientId,
      code: p.get("code"),
      code_verifier: saved.verifier,
      redirect_uri: location.origin + "/",
    }),
  });
  if (!r.ok) throw new Error("Sign-in failed");
  const body = (await r.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string")
    throw new Error("Missing access token");
  sessionStorage.setItem("access_token", body.access_token);
}
