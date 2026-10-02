import { expect, test } from "bun:test";
import { workerSandboxIdentity } from "../../src/cloudflare/identity.js";

test("same display name in separate Worker namespaces has separate Runtime identities", () => {
  const first = workerSandboxIdentity("a".repeat(64), {});
  const second = workerSandboxIdentity("b".repeat(64), {});
  expect(first).not.toBe(second);
  expect(first).toBe(workerSandboxIdentity("a".repeat(64), {}));
});

test("persisted Runtime identity survives recreation and display-name configuration", () => {
  const nativeSandboxId = workerSandboxIdentity("a".repeat(64), {});
  expect(
    workerSandboxIdentity("a".repeat(64), { nativeSandboxId, sandboxName: { name: "agent" } }),
  ).toBe(nativeSandboxId);
  expect(workerSandboxIdentity("b".repeat(64), { nativeSandboxId: "legacy-owned-resource" })).toBe(
    "legacy-owned-resource",
  );
});

test("ambiguous legacy identities fail without selecting or destroying shared compute", () => {
  expect(() => workerSandboxIdentity("a".repeat(64), { sandboxName: { name: "agent" } })).toThrow(
    "no namespace-safe Runtime identity",
  );
  expect(() => workerSandboxIdentity("invalid", {})).toThrow("Durable Object identity is invalid");
  expect(() => workerSandboxIdentity("a".repeat(64), { nativeSandboxId: "../../other" })).toThrow(
    "stored Runtime sandbox identity is invalid",
  );
});
