import { afterEach, describe, expect, it } from "vitest";
import { resolveRequestOrigin } from "./base-url";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const opts = { fallback: "https://fallback.example", logContext: "test" };

describe("resolveRequestOrigin", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    delete process.env.ALLOWED_INVITE_HOSTS;
  });

  it("prefers NEXT_PUBLIC_SITE_URL over everything else, trailing slash stripped", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://crm.example.com/";
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", { host: "internal:3000" }),
      opts,
    );
    expect(out).toBe("https://crm.example.com");
  });

  it("uses x-forwarded-host + x-forwarded-proto when present", () => {
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", {
        "x-forwarded-host": "crm.agenciakibo.com",
        "x-forwarded-proto": "https",
      }),
      opts,
    );
    expect(out).toBe("https://crm.agenciakibo.com");
  });

  it("defaults forwarded-host to https when no proto header is sent", () => {
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", { "x-forwarded-host": "crm.agenciakibo.com" }),
      opts,
    );
    expect(out).toBe("https://crm.agenciakibo.com");
  });

  it("takes the first value from a comma-separated forwarded-host chain", () => {
    // Multiple proxies each append their own hop; the client-facing one is first.
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", {
        "x-forwarded-host": "crm.agenciakibo.com, internal-lb",
      }),
      opts,
    );
    expect(out).toBe("https://crm.agenciakibo.com");
  });

  it("falls back to Host + request protocol when there is no proxy", () => {
    const out = resolveRequestOrigin(
      req("http://localhost:3100/x", { host: "localhost:3100" }),
      opts,
    );
    expect(out).toBe("http://localhost:3100");
  });

  it("returns the fallback when no Host header is present at all", () => {
    const out = resolveRequestOrigin(req("http://internal:3000/x"), opts);
    expect(out).toBe("https://fallback.example");
  });

  it("permissive by default: any host is accepted with no ALLOWED_INVITE_HOSTS set", () => {
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", { "x-forwarded-host": "anything.example" }),
      opts,
    );
    expect(out).toBe("https://anything.example");
  });

  it("rejects a non-allow-listed forwarded-host and falls back", () => {
    process.env.ALLOWED_INVITE_HOSTS = "crm.agenciakibo.com,crm-staging.agenciakibo.com";
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", { "x-forwarded-host": "phishing.example" }),
      opts,
    );
    expect(out).toBe("https://fallback.example");
  });

  it("accepts an allow-listed forwarded-host case-insensitively", () => {
    process.env.ALLOWED_INVITE_HOSTS = "crm.agenciakibo.com";
    const out = resolveRequestOrigin(
      req("http://internal:3000/x", {
        "x-forwarded-host": "CRM.AgenciaKibo.com",
        "x-forwarded-proto": "https",
      }),
      opts,
    );
    expect(out).toBe("https://CRM.AgenciaKibo.com");
  });

  it("falls through from a rejected forwarded-host to an allow-listed Host header", () => {
    process.env.ALLOWED_INVITE_HOSTS = "crm.agenciakibo.com";
    const out = resolveRequestOrigin(
      req("https://crm.agenciakibo.com/x", {
        "x-forwarded-host": "spoofed.example",
        host: "crm.agenciakibo.com",
      }),
      opts,
    );
    expect(out).toBe("https://crm.agenciakibo.com");
  });
});
