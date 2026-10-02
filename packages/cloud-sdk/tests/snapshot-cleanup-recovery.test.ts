import { expect, test } from "bun:test";
import { Runtime } from "../src/client.js";
import { RuntimeError } from "../src/errors.js";
import { translate as vercelError } from "../src/vercel/errors.js";

const ID = "11111111-2222-4333-8444-555555555555";

async function source(state: "ready" | "failed") {
  let current = "running";
  const runtime = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://snapshot-recovery.invalid",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith(":pause")) current = "paused";
      if (path.endsWith(":snapshot"))
        return Response.json({
          id: "saved-disk",
          sourceSandboxId: ID,
          state,
          mode: "disk",
          error: "Capture failed",
        });
      return Response.json({ id: ID, state: current, labels: {} });
    }) as typeof fetch,
  });
  const box = await runtime.sandboxes.get(ID);
  const wakeFailure = new RuntimeError({
    message: "Restore connection lost",
    code: "wake_failed",
    status: 503,
  });
  box.wake = async () => {
    throw wakeFailure;
  };
  return { box, wakeFailure };
}

test("saved disk IDs survive source restoration failure without changing the wake error", async () => {
  const { box, wakeFailure } = await source("ready");
  try {
    await box.snapshot({ mode: "disk" });
    throw new Error("Expected restoration failure");
  } catch (error) {
    expect(error).toBe(wakeFailure);
    expect(wakeFailure.details).toMatchObject({
      snapshotId: "saved-disk",
      sourceSandboxId: ID,
      sourceWakeError: { code: "wake_failed", message: "Restore connection lost" },
    });
    expect(vercelError(error)).toMatchObject({
      code: "wake_failed",
      json: { error: { details: { snapshotId: "saved-disk", sourceSandboxId: ID } } },
    });
  }
});

test("restoration failure preserves the primary capture failure and both recovery causes", async () => {
  const { box } = await source("failed");
  await expect(box.snapshot({ mode: "disk" })).rejects.toMatchObject({
    code: "snapshot_failed",
    status: 409,
    message: "Capture failed",
    details: {
      snapshotId: "saved-disk",
      sourceSandboxId: ID,
      sourceWakeError: { code: "wake_failed" },
    },
  });
});
