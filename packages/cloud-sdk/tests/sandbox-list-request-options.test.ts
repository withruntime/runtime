/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Runtime, Sandboxes } from "../src/client";
import { sandboxPage } from "../src/sandbox";
import type { Call, Transport } from "../src/transport";

test("sandbox listing retains request options and filters on every cursor page", async () => {
  for (const timeoutMs of [0, 123]) {
    const calls: Call[] = [];
    const transport = {
      json: async (call: Call) => {
        calls.push(call);
        return { data: [], nextCursor: calls.length < 3 ? `cursor-${calls.length}` : null };
      },
    } as unknown as Transport;
    const options = {
      signal: new AbortController().signal,
      timeoutMs,
      idempotencyKey: "sandbox-list-fixture",
    };
    const page = await new Sandboxes(transport).list(
      { state: ["running"], includeStopped: true, labels: { team: "red" }, name: "app", limit: 5 },
      options,
    );
    expect(await page.toArray()).toEqual([]);
    expect(calls).toHaveLength(3);
    for (const [index, call] of calls.entries()) {
      expect(call.method).toBe("GET");
      expect(call.path).toBe("/v1/sandboxes");
      expect(call.signal).toBe(options.signal);
      expect(call.timeoutMs).toBe(timeoutMs);
      expect(call.idempotencyKey).toBe(options.idempotencyKey);
      expect(call.query).toEqual({
        state: ["running"],
        includeStopped: true,
        label: ["team:red"],
        name: "app",
        limit: 5,
        ...(index > 0 ? { cursor: `cursor-${index}` } : {}),
      });
    }
  }
});

test("sandbox listing and direct sandbox pages retain their historical optional arguments", async () => {
  const calls: Call[] = [];
  const transport = {
    json: async (call: Call) => {
      calls.push(call);
      return { data: [], nextCursor: null };
    },
  } as unknown as Transport;
  expect(await (await new Sandboxes(transport).list()).toArray()).toEqual([]);
  const legacy = sandboxPage(transport, { data: [], nextCursor: "legacy" }, { name: "app" });
  expect(await legacy.next()).not.toBeNull();
  expect(calls.map((call) => call.query)).toEqual([{}, { name: "app", cursor: "legacy" }]);
  expect(calls.every((call) => call.signal === undefined && call.timeoutMs === undefined)).toBe(
    true,
  );
});

test("aborted sandbox lists refuse the initial request and later pages before fetching", async () => {
  let requests = 0;
  const runtime = new Runtime({
    apiKey: "rk_sandbox_list_fixture",
    baseUrl: "https://sandbox-list.example.test",
    maxRetries: 0,
    fetch: (async () => {
      requests++;
      return Response.json({ data: [], nextCursor: "later" });
    }) as unknown as typeof fetch,
  });
  const initial = new AbortController();
  const reason = new Error("The caller stopped listing");
  initial.abort(reason);
  await expect(runtime.sandboxes.list({}, { signal: initial.signal })).rejects.toMatchObject({
    code: "timeout",
    cause: reason,
  });
  expect(requests).toBe(0);
  const later = new AbortController();
  const page = await runtime.sandboxes.list({}, { signal: later.signal });
  expect(requests).toBe(1);
  later.abort(reason);
  await expect(page.next()).rejects.toMatchObject({ code: "timeout", cause: reason });
  expect(requests).toBe(1);
});

test("a later sandbox page applies its request deadline through the real transport", async () => {
  let requests = 0;
  let nextSignal: AbortSignal | undefined;
  const runtime = new Runtime({
    apiKey: "rk_sandbox_list_fixture",
    baseUrl: "https://sandbox-list.example.test",
    maxRetries: 0,
    timeoutMs: 1_000,
    fetch: (async (_input: RequestInfo | URL, options?: RequestInit) => {
      requests++;
      if (requests === 1) return Response.json({ data: [], nextCursor: "later" });
      const signal = options?.signal;
      if (!signal) throw new Error("A cursor page lost its request signal");
      nextSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch,
  });
  const page = await runtime.sandboxes.list({}, { timeoutMs: 100 });
  await expect(page.next()).rejects.toMatchObject({ code: "timeout" });
  expect(requests).toBe(2);
  expect(nextSignal?.aborted).toBe(true);
});
