/* eslint-disable @typescript-eslint/prefer-promise-reject-errors -- fakes reject with the abort signal's reason, exactly as fetch does. */
import { expect, test } from "bun:test";
import { Runtime } from "../../src/client";
import { request } from "../../src/e2b/client";
import { Sandbox } from "../../src/e2b/sandbox";
import type { RequestOptions } from "../../src/transport";
import { FakeWorld } from "./fake";

test("E2B request options distinguish an omitted timeout from explicit unlimited", () => {
  expect(request()).toEqual({});
  expect(request({ requestTimeoutMs: 0 })).toEqual({ timeoutMs: 0 });
});

test("pre-aborted template create makes no lookup or sandbox request", async () => {
  const world = new FakeWorld();
  await expect(
    Sandbox.create("custom", {
      signal: AbortSignal.abort(new Error("cancelled before lookup")),
      runtime: { client: world.client() },
    }),
  ).rejects.toThrow("cancelled before lookup");
  expect(world.calls).toEqual([]);
});

test("named and UUID templates forward signal and zero timeout to lookup and create", async () => {
  const world = new FakeWorld();
  const id = "11111111-2222-4333-8444-555555555555";
  world.images.push({ id, name: "custom", state: "ready" });
  const client = world.client();
  const lookups: RequestOptions[] = [];
  const list = client.images.list.bind(client.images);
  const get = client.images.get.bind(client.images);
  client.images.list = async (query, options) => {
    lookups.push(options ?? {});
    return list(query, options);
  };
  client.images.get = async (imageId, options) => {
    lookups.push(options ?? {});
    return get(imageId, options);
  };
  const signal = new AbortController().signal;
  for (const template of ["custom", id])
    await Sandbox.create(template, { requestTimeoutMs: 0, signal, runtime: { client } });
  expect(lookups).toEqual([
    { timeoutMs: 0, signal },
    { timeoutMs: 0, signal },
  ]);
  for (const call of world.called("sandboxes.create"))
    expect(call[1]).toEqual({ timeoutMs: 0, signal });
});

test("cancellation during image lookup prevents the later sandbox create", async () => {
  const world = new FakeWorld();
  const client = world.client();
  const controller = new AbortController();
  client.images.list = async () => {
    controller.abort(new Error("cancelled during lookup"));
    return { data: [{ id: "image", state: "ready" }] } as Awaited<
      ReturnType<typeof client.images.list>
    >;
  };
  await expect(
    Sandbox.create("custom", { signal: controller.signal, runtime: { client } }),
  ).rejects.toThrow("cancelled during lookup");
  expect(world.called("sandboxes.create")).toEqual([]);
});

function stalledResponse(request: Request, response: Record<string, unknown>) {
  return new Promise<Response>((resolve, reject) => {
    request.signal.throwIfAborted();
    const timer = setTimeout(() => resolve(Response.json(response)), 150);
    request.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(request.signal.reason);
      },
      { once: true },
    );
  });
}

test("a template lookup deadline cancels native HTTP before sandbox creation", async () => {
  const calls: Request[] = [];
  const client = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      return stalledResponse(req, { data: [], nextCursor: null });
    }) as typeof fetch,
  });
  await expect(
    Sandbox.create("custom", { requestTimeoutMs: 10, runtime: { client } }),
  ).rejects.toBeInstanceOf(Error);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe("/v1/images");
  expect(calls[0]!.signal.aborted).toBe(true);
});

test("E2B pagination applies request deadlines on following native HTTP pages", async () => {
  const calls: Request[] = [];
  const client = new Runtime({
    apiKey: "rtcloud_fixture",
    baseUrl: "https://fixture.invalid",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      calls.push(req);
      if (calls.length === 1) return Response.json({ data: [], nextCursor: "next" });
      return stalledResponse(req, { data: [], nextCursor: null });
    }) as typeof fetch,
  });
  const paginator = Sandbox.list({ requestTimeoutMs: 10, runtime: { client } });
  expect(await paginator.nextItems()).toEqual([]);
  await expect(paginator.nextItems()).rejects.toBeInstanceOf(Error);
  expect(calls).toHaveLength(2);
  expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("next");
  expect(calls[1]!.signal.aborted).toBe(true);
});

test("pre-aborted pagination makes no native list request", async () => {
  const world = new FakeWorld();
  const paginator = Sandbox.list({
    signal: AbortSignal.abort(new Error("cancelled page")),
    runtime: { client: world.client() },
  });
  await expect(paginator.nextItems()).rejects.toThrow("cancelled page");
  expect(world.calls).toEqual([]);
});
