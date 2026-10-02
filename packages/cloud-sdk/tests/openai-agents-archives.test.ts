import { expect, test } from "bun:test";
import { Manifest } from "@openai/agents/sandbox";
import type { Runtime } from "../src/client";
import type { Sandbox } from "../src/sandbox";
import { RuntimeCloudSandboxSession } from "../src/openai-agents/index";

function fixture(root = "/workspace") {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  const calls: { method: string; path: string; data?: Uint8Array; options: unknown }[] = [];
  const sandbox = {
    files: {
      async archive(path: string, options: unknown) {
        calls.push({ method: "archive", path, options });
        return bytes;
      },
      async unarchive(path: string, data: Uint8Array, options: unknown) {
        calls.push({ method: "unarchive", path, data, options });
      },
    },
  } as unknown as Sandbox;
  const session = new RuntimeCloudSandboxSession({
    runtime: {} as Runtime,
    sandbox,
    state: {
      manifest: new Manifest({ root }),
      sandboxId: "test-sandbox",
      create: {},
      environment: {},
      previewVisibility: "private",
      pauseOnExit: false,
      execTimeoutMs: 42_000,
    },
  });
  return { session, calls, bytes };
}

test("workspace persistence uses raw archive bytes and excludes adapter staging", async () => {
  const { session, calls, bytes } = fixture();
  expect(await session.persistWorkspace()).toEqual(bytes);
  expect(calls).toEqual([
    {
      method: "archive",
      path: "/workspace",
      options: { gzip: false, exclude: [".openai-agents-staging"], timeoutMs: 42_000 },
    },
  ]);
});

test("workspace archives support manifest roots outside /workspace", async () => {
  const { session, calls, bytes } = fixture("/app");
  await session.persistWorkspace();
  await session.hydrateWorkspace(bytes.buffer);
  expect(calls).toEqual([
    { method: "archive", path: "/app", options: { gzip: false, timeoutMs: 42_000 } },
    {
      method: "unarchive",
      path: "/app",
      data: bytes,
      options: { gzip: false, timeoutMs: 42_000 },
    },
  ]);
});

test("hydration passes binary and string inputs through the folder route", async () => {
  const { session, calls, bytes } = fixture();
  await session.hydrateWorkspace(bytes);
  await session.hydrateWorkspace("héllo");
  expect(calls[0]?.data).toEqual(bytes);
  expect(calls[1]?.data).toEqual(new TextEncoder().encode("héllo"));
});
