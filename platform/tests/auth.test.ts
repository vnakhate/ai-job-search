import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { login, callback, token, logout } from "../web/auth";
const config = {
  demo: false,
  issuer: "https://issuer.example/",
  clientId: "public-client",
  audience: "jobpilot-api",
};
let storage: Map<string, string>;
let assign: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  storage = new Map();
  assign = vi.fn();
  replace = vi.fn();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("location", {
    origin: "https://jobpilot.example",
    search: "",
    assign,
  });
  vi.stubGlobal("history", { replaceState: replace });
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
describe("browser OAuth PKCE contract", () => {
  it("redirects with an S256 challenge matching the privately stored verifier", async () => {
    await login(config);
    const first = JSON.parse(storage.get("oauth")!);
    const url = new URL(assign.mock.calls[0][0]);
    const digest = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(first.verifier),
      ),
    ).toString("base64url");
    expect(url.origin).toBe("https://issuer.example");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("code_challenge")).toBe(digest);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://jobpilot.example/",
    );
    expect(url.search).not.toContain(first.verifier);
    await login(config);
    expect(JSON.parse(storage.get("oauth")!).state).not.toBe(first.state);
  });
  it("rejects mismatched callback state before any token exchange", async () => {
    storage.set(
      "oauth",
      JSON.stringify({ state: "expected", verifier: "private" }),
    );
    location.search = "?code=code&state=attacker";
    await expect(callback(config)).rejects.toThrow("state did not match");
    expect(fetch).not.toHaveBeenCalled();
    expect(storage.has("oauth")).toBe(false);
    expect(token()).toBeNull();
    expect(replace).toHaveBeenCalledWith({}, "", "/");
  });
  it("consumes state and exchanges the exact callback code and verifier once", async () => {
    storage.set(
      "oauth",
      JSON.stringify({ state: "expected", verifier: "private" }),
    );
    location.search = "?code=the-code&state=expected";
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ access_token: "signed-token" }),
    );
    await callback(config);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://issuer.example/oauth/token");
    expect(JSON.parse(init!.body as string)).toEqual({
      grant_type: "authorization_code",
      client_id: "public-client",
      code: "the-code",
      code_verifier: "private",
      redirect_uri: "https://jobpilot.example/",
    });
    expect(token()).toBe("signed-token");
    expect(storage.has("oauth")).toBe(false);
    await expect(callback(config)).rejects.toThrow("state did not match");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 401, body: {} },
    { status: 200, body: {} },
    { status: 200, body: { access_token: 42 } },
  ])(
    "never stores a token for failed/malformed exchange %j",
    async ({ status, body }) => {
      storage.set("oauth", JSON.stringify({ state: "s", verifier: "v" }));
      location.search = "?code=c&state=s";
      vi.mocked(fetch).mockResolvedValue(Response.json(body, { status }));
      await expect(callback(config)).rejects.toThrow();
      expect(token()).toBeNull();
    },
  );
  it("handles denied sign-in without exchanging credentials", async () => {
    location.search = "?error=access_denied";
    await expect(callback(config)).rejects.toThrow("cancelled or denied");
    expect(fetch).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({}, "", "/");
  });
  it("refuses incomplete sign-in configuration", async () => {
    await expect(login({ ...config, clientId: "" })).rejects.toThrow(
      "configured",
    );
    expect(assign).not.toHaveBeenCalled();
  });
  it("signs out by removing the stored token", () => {
    storage.set("access_token", "secret");
    logout();
    expect(token()).toBeNull();
    expect(assign).toHaveBeenCalledWith("/");
  });
});
