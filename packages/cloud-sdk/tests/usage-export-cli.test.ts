import { expect, test } from "bun:test";
import { Runtime } from "../src/client";
import { run } from "../src/cli";
import { PermissionDeniedError, RuntimeError } from "../src/errors";

const since = "2026-09-01T00:00:00Z";
const until = "2026-10-01T00:00:00Z";
const env = { RUNTIME_API_KEY: "rk_export_test", RUNTIME_API_URL: "https://api.example.test" };

test("the account export keeps exact server CSV, range, cursor and authentication", async () => {
  let seen: Request | undefined;
  const page = { since, until, data: [], nextCursor: null, csv: 'charged\n"9007199254740993"\n' };
  const runtime = new Runtime({
    apiKey: env.RUNTIME_API_KEY,
    baseUrl: env.RUNTIME_API_URL,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Request(input, init);
      return Response.json(page);
    }) as typeof fetch,
  });
  expect(
    await runtime.usageExport({ since, until, cursor: "opaque/cursor+=", limit: 500 }),
  ).toEqual(page);
  const request = seen!;
  const url = new URL(request.url);
  expect(url.pathname).toBe("/v1/usage/export");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    since,
    until,
    cursor: "opaque/cursor+=",
    limit: "500",
  });
  expect(request.headers.get("authorization")).toBe("Bearer rk_export_test");
});

async function exportCli(
  argv: string[],
  answer: (request: Request, url: URL) => Response,
  drain?: () => Promise<void>,
) {
  const original = globalThis.fetch;
  const lines: string[] = [];
  const requests: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return answer(request, new URL(request.url));
  }) as typeof fetch;
  try {
    const code = await run(argv, env, {
      json: argv.includes("--json"),
      write: (text) => lines.push(text),
      error: () => {},
      ...(drain ? { drain } : {}),
    });
    return { code, lines, requests, error: undefined };
  } catch (error) {
    return { code: 1, lines, requests, error };
  } finally {
    globalThis.fetch = original;
  }
}

const command = ["usage", "export", "--since", since, "--until", until];

test("CLI exports every settlement beyond the newest hundred using the server CSV", async () => {
  const chunks = [
    "server_header\n" + "first,500\n".repeat(500),
    "second,500\n".repeat(500),
    "last,201\n".repeat(201),
  ];
  const result = await exportCli(command, (_request, url) => {
    const cursor = url.searchParams.get("cursor");
    const page = cursor === null ? 0 : cursor === "page-two" ? 1 : 2;
    return Response.json({
      since,
      until,
      data: [],
      nextCursor: ["page-two", "page-three", null][page],
      csv: chunks[page],
    });
  });
  expect(result.code).toBe(0);
  expect(result.lines).toEqual(chunks);
  expect(result.lines.join("").split("\n").filter(Boolean)).toHaveLength(1202);
  expect(result.requests).toHaveLength(3);
  expect(result.requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual(
    [null, "page-two", "page-three"],
  );
  for (const request of result.requests) {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/usage/export");
    expect(url.searchParams.get("since")).toBe(since);
    expect(url.searchParams.get("until")).toBe(until);
    expect(url.searchParams.get("limit")).toBe("500");
  }
});

test("CLI JSON exports retain exact server pages", async () => {
  const page = {
    since,
    until,
    data: [{ chargedMicros: "9007199254740993" }],
    nextCursor: null,
    csv: "server_csv\n",
  };
  const result = await exportCli([...command, "--json"], () => Response.json(page));
  expect(result.code).toBe(0);
  expect(result.lines.map((line) => JSON.parse(line) as unknown)).toEqual([page]);
});

test("empty CSV exports keep the server header and stop after one page", async () => {
  const result = await exportCli(command, () =>
    Response.json({ since, until, data: [], nextCursor: null, csv: "server_header\n" }),
  );
  expect(result.code).toBe(0);
  expect(result.lines).toEqual(["server_header\n"]);
  expect(result.requests).toHaveLength(1);
});

test("the next export page waits for slow output to drain", async () => {
  let resolve!: () => void;
  const held = new Promise<void>((done) => {
    resolve = done;
  });
  let started!: () => void;
  const waiting = new Promise<void>((done) => {
    started = done;
  });
  let calls = 0;
  let drains = 0;
  const pending = exportCli(
    command,
    () => {
      calls++;
      return Response.json({
        since,
        until,
        data: [],
        nextCursor: calls === 1 ? "next" : null,
        csv: `page${calls}\n`,
      });
    },
    async () => {
      drains++;
      if (drains === 1) {
        started();
        await held;
      }
    },
  );
  await waiting;
  try {
    expect(calls).toBe(1);
  } finally {
    resolve();
  }
  const result = await pending;
  expect(result.code).toBe(0);
  expect(calls).toBe(2);
  expect(drains).toBe(2);
});

test("missing ranges fail before reading usage", async () => {
  for (const argv of [
    ["usage", "export", "--since", since],
    ["usage", "export", "--until", until],
    [...command, "extra"],
  ]) {
    const result = await exportCli(argv, () => Response.json({}));
    expect(result.error).toBeInstanceOf(RuntimeError);
    expect(result.error).toMatchObject({ code: "usage" });
    expect(result.requests).toEqual([]);
  }
});

test("permission failures on a continuation keep the export incomplete", async () => {
  const result = await exportCli(command, (_request, url) =>
    url.searchParams.has("cursor")
      ? Response.json(
          { error: { code: "forbidden", message: "Permission was revoked." } },
          { status: 403 },
        )
      : Response.json({
          since,
          until,
          data: [],
          nextCursor: "continuation",
          csv: "header\nfirst\n",
        }),
  );
  expect(result.error).toBeInstanceOf(PermissionDeniedError);
  expect(result.code).toBe(1);
  expect(result.lines).toEqual(["header\nfirst\n"]);
});

test("repeated cursors fail explicitly instead of exporting duplicated pages forever", async () => {
  const result = await exportCli(command, () =>
    Response.json({ since, until, data: [], nextCursor: "same", csv: "one\n" }),
  );
  expect(result.error).toMatchObject({ code: "usage_export_incomplete" });
  expect(result.requests).toHaveLength(2);
  expect(result.lines).toEqual(["one\n"]);
});
