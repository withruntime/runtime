/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Runtime, Sandboxes } from "../src/client";
import type { Call, Transport } from "../src/transport";

test("sandbox create preserves HTTP request options in its fallback running poll", async () => {
  for (const timeoutMs of [0, 123]) {
    const calls: Call[] = [];
    const transport = {
      waitForCapacityMs: 0,
      json: async (call: Call) => {
        calls.push(call);
        return { id: "fixture", state: calls.length === 1 ? "starting" : "running" };
      },
    } as unknown as Transport;
    const options = {
      signal: new AbortController().signal,
      timeoutMs,
      idempotencyKey: "sandbox-create-fixture",
      waitForCapacityMs: 1234,
      onCapacityWait: () => {},
    };
    expect((await new Sandboxes(transport).create({}, options)).state).toBe("running");
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["POST", "/v1/sandboxes"],
      ["GET", "/v1/sandboxes/fixture"],
    ]);
    for (const call of calls) {
      expect(call.signal).toBe(options.signal);
      expect(call.idempotencyKey).toBe(options.idempotencyKey);
    }
    // The create's one deadline: the poll gets what the create left of it.
    expect(calls[0]!.timeoutMs).toBe(timeoutMs);
    if (timeoutMs === 0) expect(calls[1]!.timeoutMs).toBe(0);
    else {
      expect(calls[1]!.timeoutMs).toBeGreaterThan(0);
      expect(calls[1]!.timeoutMs).toBeLessThanOrEqual(timeoutMs);
    }
    expect(calls[1]!.query).toEqual({ waitFor: "running", timeoutSeconds: 60 });
    expect(calls[1]!.waitForCapacityMs).toBeUndefined();
    expect(calls[1]!.onCapacityWait).toBeUndefined();
  }
});

test("aborting a held create fallback poll retains the cause and never destroys the created sandbox", async () => {
  const entered = Promise.withResolvers<void>();
  const calls: Array<[string, string]> = [];
  const controller = new AbortController();
  const reason = new Error("The caller stopped waiting for creation");
  const runtime = new Runtime({
    apiKey: "rk_create_request_fixture",
    baseUrl: "https://sandbox-create.example.test",
    maxRetries: 0,
    timeoutMs: 1_000,
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(input, options);
      const method = request.method;
      const path = new URL(request.url).pathname;
      calls.push([method, path]);
      if (method === "POST" && path === "/v1/sandboxes")
        return Response.json({ id: "fixture", state: "starting" });
      if (method !== "GET" || path !== "/v1/sandboxes/fixture")
        throw new Error("Cancellation attempted an unexpected mutation");
      const signal = request.signal;
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch,
  });
  const pending = runtime.sandboxes.create({}, { signal: controller.signal });
  await entered.promise;
  controller.abort(reason);
  await expect(pending).rejects.toMatchObject({ code: "timeout", cause: reason });
  expect(calls).toEqual([
    ["POST", "/v1/sandboxes"],
    ["GET", "/v1/sandboxes/fixture"],
  ]);
});

test("legacy create still waits by default and wait false skips the fallback poll", async () => {
  for (const wait of [undefined, false]) {
    const calls: Call[] = [];
    const transport = {
      waitForCapacityMs: 0,
      json: async (call: Call) => {
        calls.push(call);
        return { id: "fixture", state: calls.length === 1 ? "starting" : "running" };
      },
    } as unknown as Transport;
    const sandboxes = new Sandboxes(transport);
    const sandbox =
      wait === undefined ? await sandboxes.create() : await sandboxes.create({ wait });
    expect(sandbox.state).toBe(wait === false ? "starting" : "running");
    expect(calls).toHaveLength(wait === false ? 1 : 2);
    expect(calls[0]!.wait).toBe(wait === false ? 0 : 60);
  }
});

test("a held create fallback poll ends at its HTTP request deadline", async () => {
  const calls: Array<[string, string]> = [];
  let pollSignal: AbortSignal | undefined;
  const runtime = new Runtime({
    apiKey: "rk_create_request_fixture",
    baseUrl: "https://sandbox-create.example.test",
    maxRetries: 0,
    timeoutMs: 1_000,
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(input, options);
      const method = request.method;
      const path = new URL(request.url).pathname;
      calls.push([method, path]);
      if (method === "POST" && path === "/v1/sandboxes")
        return Response.json({ id: "fixture", state: "starting" });
      if (method !== "GET" || path !== "/v1/sandboxes/fixture")
        throw new Error("A request deadline attempted an unexpected mutation");
      const signal = request.signal;
      pollSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch,
  });
  await expect(runtime.sandboxes.create({}, { timeoutMs: 100 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(pollSignal?.aborted).toBe(true);
  expect(calls).toEqual([
    ["POST", "/v1/sandboxes"],
    ["GET", "/v1/sandboxes/fixture"],
  ]);
});

test("a create's explicit deadline covers its wait for running, not just the create", async () => {
  // The 1 October 2026 audit: two 70 ms answers finished a 100 ms create in 143 ms.
  const runtime = new Runtime({
    apiKey: "rk_create_request_fixture",
    baseUrl: "https://sandbox-create.example.test",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      const request = new Request(input, options);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 70);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.signal!.reason);
          },
          { once: true },
        );
      });
      return Response.json({
        id: "fixture",
        state: request.method === "POST" ? "starting" : "running",
      });
    }) as typeof fetch,
  });
  const began = performance.now();
  await expect(
    runtime.sandboxes.create({}, { timeoutMs: 100, waitForCapacityMs: 0 }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(performance.now() - began).toBeLessThan(135);
});
