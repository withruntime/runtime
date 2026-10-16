import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, Runtime } from "../src/index";

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const PREFIX = `/v1/sandboxes/${ID}`;
const CONTENT = "#!/bin/sh\necho hi\n";
let directory: string;
let localPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "rt-upload-not-found-"));
  localPath = join(directory, "run.sh");
  await writeFile(localPath, CONTENT);
  await chmod(localPath, 0o755);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(reply: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname === PREFIX)
        return Response.json({ id: ID, kind: "sandbox", state: "running", status: "active" });
      calls.push(request.clone());
      return reply(request);
    }) as typeof fetch,
  });
  return { files: (await runtime.sandboxes.get(ID)).files, calls };
}

for (const code of ["not_found", "route_not_found", "transfer_not_found"])
  test(`upload preserves ${code} without making a parent`, async () => {
    const error = {
      code,
      status: 404,
      message: `No sandbox with the id ${ID} is visible to this key.`,
      hint: "Check the id. List what this key can see with GET /v1/sandboxes or `npx withruntime ls`. A key sees only what its own agent made, unless an owner or admin made it account-wide: something made with another of the account's keys answers 404 here. Switch a key to account-wide at https://withruntime.com/account/keys.",
      requestId: "req_upload_not_found",
    };
    const { files, calls } = await fixture((request) => {
      if (new URL(request.url).pathname === `${PREFIX}/files/content`)
        return Response.json({ error }, { status: 404 });
      return Response.json(
        { error: { code: "invalid_request", message: "Refusing the root of a tree" } },
        { status: 400 },
      );
    });

    const failure = await files.upload(localPath, "/workspace/x").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NotFoundError);
    expect(failure).toMatchObject(error);
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `PUT ${PREFIX}/files/content`,
    ]);
  });

for (const code of ["file_not_found", "path_not_found"])
  test(`upload makes a missing parent on ${code} and retries the same file`, async () => {
    let writes = 0;
    const remotePath = "/workspace/new/run.sh";
    const { files, calls } = await fixture((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT" && path === `${PREFIX}/files/content`) {
        if (++writes === 1)
          return Response.json(
            { error: { code, message: "No such file or directory." } },
            { status: 404 },
          );
        return Response.json({ path: remotePath, size: CONTENT.length });
      }
      if (request.method === "POST" && path === `${PREFIX}/files:mkdir`)
        return Response.json({ path: "/workspace/new", created: true });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    });

    await files.upload(localPath, remotePath);
    expect(calls.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `PUT ${PREFIX}/files/content`,
      `POST ${PREFIX}/files:mkdir`,
      `PUT ${PREFIX}/files/content`,
    ]);
    expect(await calls[1]!.json()).toEqual({ path: "/workspace/new", parents: true });
    for (const request of [calls[0]!, calls[2]!]) {
      const query = new URL(request.url).searchParams;
      expect(query.get("path")).toBe(remotePath);
      expect(query.get("mode")).toBe("755");
      expect(await request.text()).toBe(CONTENT);
    }
  });
