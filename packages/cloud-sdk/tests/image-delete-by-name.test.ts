import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

/* `runtime image rm afternoon-web` refused with "no tag latest… use
   afternoon-web:v1" though the name had one version (live product, 2 October
   2026). A bare name with one version deletes it; with several, the server's
   words, which list its tags, stand. */

const ONE = "11111111-2222-4333-8444-555555555555";
const TWO = "11111111-2222-4333-8444-666666666666";
const notFound = () =>
  Response.json(
    {
      error: {
        code: "image_not_found",
        status: 404,
        message: "afternoon-web is tagged v1: use afternoon-web:v1.",
        requestId: "req_test",
        hint: "",
      },
    },
    { status: 404 },
  );

function api(versions: { id: string; state: string }[]) {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/v1/images/resolve") return notFound();
    if (url.pathname === "/v1/images")
      return Response.json({
        data: versions.map((v) => ({ ...v, name: "afternoon-web" })),
        nextCursor: null,
      });
    const deleted = /^\/v1\/images\/([^/]+):delete$/.exec(url.pathname);
    if (deleted) return Response.json({ id: deleted[1], state: "deleting" });
    return Response.json(
      { error: { code: "route_not_found", status: 404, message: "?" } },
      { status: 404 },
    );
  }) as typeof fetch;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    fetch: fetcher,
    maxRetries: 0,
  });
  return { runtime, seen };
}

test("a bare name with one version and no latest tag deletes that version", async () => {
  const { runtime, seen } = api([{ id: ONE, state: "ready" }]);
  expect(await runtime.images.delete("afternoon-web")).toMatchObject({
    id: ONE,
    state: "deleting",
  });
  expect(seen.at(-1)).toBe(`POST /v1/images/${ONE}:delete`);
});

test("a bare name with several versions deletes nothing and keeps the server's words", async () => {
  const { runtime, seen } = api([
    { id: ONE, state: "ready" },
    { id: TWO, state: "ready" },
  ]);
  const error = await runtime.images.delete("afternoon-web").catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "image_not_found" });
  expect(String((error as Error).message)).toContain("afternoon-web:v1");
  expect(seen.some((line) => line.endsWith(":delete"))).toBe(false);
});

test("a tag or version that names nothing is never widened to the whole name", async () => {
  const { runtime, seen } = api([{ id: ONE, state: "ready" }]);
  for (const ref of ["afternoon-web:v2", "afternoon-web@9"])
    expect(await runtime.images.delete(ref).catch((e: unknown) => e)).toMatchObject({
      code: "image_not_found",
    });
  expect(seen.some((line) => line.endsWith(":delete") || line.startsWith("GET /v1/images?"))).toBe(
    false,
  );
});
