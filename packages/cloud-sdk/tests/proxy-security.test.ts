import { expect, test } from "bun:test";
import { routeFor } from "../src/proxy.js";

test("a malformed proxy address does not appear in a public error", () => {
  const value = "http://fixture-user:fixture-password@[invalid";
  try {
    routeFor("https://api.example.com", { HTTPS_PROXY: value });
    throw new Error("Expected invalid proxy configuration");
  } catch (error) {
    expect(String(error)).toContain("HTTPS_PROXY");
    expect(String(error)).not.toContain("fixture-password");
    expect(String(error)).not.toContain("fixture-user");
  }
});
