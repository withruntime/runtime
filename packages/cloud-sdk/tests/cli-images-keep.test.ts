import { expect, test } from "bun:test";
import { imageCommand } from "../src/cli";

/* `runtime images build --keep n`: once the build is ready, the name's
   versions older than its newest n are deleted, so a name rebuilt on each
   merge keeps a few, not every one (21 October 2026: our website's
   App, rebuilt from main on each merge, held 221 images on one host). One an
   App still needs is refused by the API and kept; one still building is
   never touched. */

const image = (version: number, state = "ready") => ({
  id: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
  kind: "image",
  status: "active",
  state,
  name: "web",
  version,
  tags: [],
  labels: {},
  region: "us-east",
});

async function run(args: string[], versions: ReturnType<typeof image>[], inUse: number[] = []) {
  const original = globalThis.fetch;
  const asked: string[] = [];
  const built = image(9);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    asked.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method === "POST" && url.pathname === "/v1/images") return Response.json(built);
    // The log follow, which finds the build already over.
    if (url.pathname === `/v1/images/${built.id}/logs`)
      return url.searchParams.get("follow")
        ? new Response("", { status: 404 })
        : Response.json({ lines: [], nextAfter: 0, done: true });
    if (url.pathname === `/v1/images/${built.id}`) return Response.json(built);
    if (request.method === "GET" && url.pathname === "/v1/images")
      return Response.json({ data: [built, ...versions], nextCursor: null });
    const deleting = url.pathname.match(/^\/v1\/images\/([^/]+):delete$/);
    if (deleting) {
      const found = versions.find((v) => v.id === decodeURIComponent(deleting[1]!))!;
      if (inUse.includes(found.version))
        return Response.json(
          {
            error: {
              code: "image_in_use",
              status: 409,
              message: "App 4c1f runs this image, or is deploying it, or keeps it to roll back to.",
            },
          },
          { status: 409 },
        );
      return Response.json({ ...found, state: "deleting" });
    }
    return Response.json({ error: { code: "route_not_found", message: "none" } }, { status: 404 });
  }) as typeof fetch;
  const lines: string[] = [];
  const errors: string[] = [];
  let code: number | string;
  try {
    code = await imageCommand(
      ["build", ...args],
      { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: (t) => lines.push(t), error: (t) => errors.push(t) },
    ).catch((error: Error) => `ERROR ${error.message}`);
  } finally {
    globalThis.fetch = original;
  }
  const deleted = asked
    .filter((a) => a.endsWith(":delete"))
    .map((a) => Number(a.match(/-0*(\d+):delete$/)![1]));
  return { code, out: lines.join("\n"), errors, deleted, asked };
}

test("--keep 3 deletes all but the newest three, the new build among them", async () => {
  const older = [8, 7, 6, 5, 4].map((v) => image(v));
  const { code, out, errors, deleted } = await run(
    ["--from", "node:22", "-t", "web:abc", "--keep", "3"],
    older,
  );
  expect(code).toBe(0);
  expect(out).toBe(image(9).id);
  expect(deleted).toEqual([6, 5, 4]);
  expect(errors).toEqual(["Deleted web@6", "Deleted web@5", "Deleted web@4"]);
});

test("a version an App still needs is kept and said, and the rest still go", async () => {
  const older = [8, 7, 6, 5, 4].map((v) => image(v));
  const { code, errors, deleted } = await run(
    ["--from", "node:22", "--name", "web", "--keep", "2"],
    older,
    [6],
  );
  expect(code).toBe(0);
  expect(deleted).toEqual([7, 6, 5, 4]);
  expect(errors).toEqual([
    "Deleted web@7",
    "Kept web@6: App 4c1f runs this image, or is deploying it, or keeps it to roll back to.",
    "Deleted web@5",
    "Deleted web@4",
  ]);
});

test("a build of the name still running, or one already going, is never touched", async () => {
  const older = [image(8), image(7, "building"), image(6, "deleting"), image(5, "failed")];
  const { deleted } = await run(["--from", "node:22", "-t", "web", "--keep", "1"], older);
  expect(deleted).toEqual([8, 5]);
});

test("without --keep nothing is listed or deleted, as before", async () => {
  const { asked } = await run(["--from", "node:22", "-t", "web"], [image(8)]);
  expect(asked.filter((a) => !a.includes(image(9).id))).toEqual(["POST /v1/images"]);
});

test("--keep needs a name and at least 1, refused before anything is built", async () => {
  for (const args of [
    ["--from", "node:22", "--keep", "2"],
    ["--from", "node:22", "-t", "web", "--keep", "0"],
  ]) {
    const { code, asked } = await run(args, []);
    expect(String(code)).toContain("--keep takes 1 or more");
    expect(asked).toEqual([]);
  }
});
