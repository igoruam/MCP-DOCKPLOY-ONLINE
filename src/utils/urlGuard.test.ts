import { afterEach, describe, expect, it } from "vitest";
import { assertSafeDokployUrl, isPrivateAddress } from "./urlGuard.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])("treats %s as private", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "172.32.0.1",
    "1.1.1.1",
    "2606:4700:4700::1111",
  ])("treats %s as public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("assertSafeDokployUrl", () => {
  afterEach(() => {
    delete process.env.DOKPLOY_ALLOWED_HOSTS;
    delete process.env.DOKPLOY_ALLOW_HTTP;
    delete process.env.DOKPLOY_ALLOW_PRIVATE_HOSTS;
  });

  it("accepts a public https URL", () => {
    expect(assertSafeDokployUrl("https://server.bigdevlab.it").hostname).toBe(
      "server.bigdevlab.it",
    );
  });

  it.each([
    "not a url",
    "http://server.bigdevlab.it",
    "https://user:pw@server.bigdevlab.it",
    "https://localhost",
    "https://127.0.0.1",
    "https://169.254.169.254/latest",
    "https://[::1]",
    "file:///etc/passwd",
  ])("rejects %s", (url) => expect(() => assertSafeDokployUrl(url)).toThrow());

  it("enforces DOKPLOY_ALLOWED_HOSTS", () => {
    process.env.DOKPLOY_ALLOWED_HOSTS = "a.example.com";
    expect(() => assertSafeDokployUrl("https://b.example.com")).toThrow(/not allowed/);
    expect(assertSafeDokployUrl("https://a.example.com").hostname).toBe("a.example.com");
  });

  it("allows http/private only with explicit flags", () => {
    process.env.DOKPLOY_ALLOW_HTTP = "1";
    process.env.DOKPLOY_ALLOW_PRIVATE_HOSTS = "1";
    expect(assertSafeDokployUrl("http://127.0.0.1:3000").port).toBe("3000");
  });
});
