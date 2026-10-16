import { expect, spyOn, test } from "bun:test";
import { describeError, run } from "../src/cli";

const ID = "11111111-2222-4333-8444-000000000001";
const INFO = {
  id: ID,
  name: "work",
  kind: "sandbox",
  state: "running",
  funding: "paid",
  region: "us-east",
  vcpu: 2,
  memoryMiB: 4096,
  diskMiB: 4096,
  cpu: "shared",
  timeoutSeconds: 0,
  expiresAt: "2026-10-06T12:30:00Z",
  endsAt: null,
  labels: {},
};
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
type Seen = { method: string; url: URL; body: unknown; key: string | null };
async function withStub(
  route: (request: Seen) => unknown,
  work: (out: ReturnType<typeof output>, seen: Seen[]) => Promise<void>,
  json = false,
) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.text();
    const call = {
      method: request.method,
      url: new URL(request.url),
      body: text ? JSON.parse(text) : undefined,
      key: request.headers.get("Idempotency-Key"),
    };
    seen.push(call);
    const answer = route(call);
    return answer instanceof Response ? answer : Response.json(answer ?? INFO);
  }) as typeof fetch;
  try {
    await work(output(json), seen);
  } finally {
    globalThis.fetch = original;
  }
}
function output(json = false) {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    json,
    lines,
    errors,
    write: (s: string) => lines.push(s),
    error: (s: string) => errors.push(s),
  };
}

for (const name of ["snapshot", "image", "volume", "name", "region", "connect"])
  for (const value of ["", "   "])
    test(`D6: sandbox create refuses blank --${name} ${JSON.stringify(value)} before a request`, async () => {
      await withStub(
        () => INFO,
        async (out, seen) => {
          const error = await run(["sandbox", "create", `--${name}`, value], env, out).catch(
            (e: unknown) => e,
          );
          expect(seen).toHaveLength(0);
          expect(error).toMatchObject({ code: "usage" });
          const said = describeError(error, false);
          expect(said).toContain(`--${name}`);
          expect(said).toContain("Hint:");
        },
      );
    });

test("D6: an empty resource option exits 1 with a structured error", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../src/cli.ts", import.meta.url).pathname,
      "sandbox",
      "create",
      "--snapshot=",
      "--json",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      error: {
        code: "usage",
        message: expect.stringContaining("--snapshot"),
        hint: expect.any(String),
      },
    });
  } finally {
    child.kill();
  }
});
test("D6: supplied resources and empty environment values are preserved", async () => {
  await withStub(
    () => INFO,
    async (out, seen) => {
      expect(
        await run(
          ["sandbox", "create", "--snapshot", ID, "--volume", `${ID}:/data`, "--env", "EMPTY="],
          env,
          out,
        ),
      ).toBe(0);
      expect(seen[0]!.body).toMatchObject({
        snapshot: ID,
        volumes: [{ volumeId: ID, path: "/data", mode: "rw" }],
        env: { EMPTY: "" },
      });
      expect(await run(["sandbox", "create", "--image", "python:latest"], env, out)).toBe(0);
      expect(seen[1]!.body).toMatchObject({ image: "python:latest" });
    },
  );
});

for (const json of [false, true])
  for (const [state, exitCode, reason, expected] of [
    ["failed", 42, "exit", 42],
    ["failed", null, "refused", 1],
    ["failed", null, "timed_out", 1],
    ["canceled", null, "canceled", 1],
    ["unknown", null, "sandbox stopped", 1],
    ["succeeded", 0, null, 0],
  ] as const)
    test(`D7: followed job logs return ${expected} for ${state}/${reason}, json=${json}`, async () => {
      const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      let pages = 0;
      let reads = 0;
      try {
        await withStub(
          ({ url }) => {
            if (url.pathname.endsWith("/logs")) {
              pages++;
              return {
                chunks: [
                  {
                    stream: "stdout",
                    text: pages === 1 ? "first\n" : "last\n",
                    offset: pages === 1 ? 0 : 6,
                  },
                ],
                nextCursor: pages === 1 ? 6 : 11,
                complete: pages === 2,
                truncated: false,
              };
            }
            reads++;
            return {
              id: "run-1",
              state: reads === 1 ? "running" : state,
              exitCode: reads === 1 ? null : exitCode,
              reason,
            };
          },
          async (out, seen) => {
            expect(
              await run(["job", "logs", "run-1", "-f", ...(json ? ["--json"] : [])], env, out),
            ).toBe(expected);
            expect(reads).toBe(2);
            expect(
              seen
                .filter((s) => s.url.pathname.endsWith("/logs"))
                .map((s) => s.url.searchParams.get("cursor")),
            ).toEqual(["0", "6"]);
            if (json) expect(out.lines.map((s) => JSON.parse(s).complete)).toEqual([false, true]);
            else expect(stdout.mock.calls.map((c) => c[0])).toEqual(["first\n", "last\n"]);
          },
          json,
        );
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    });
for (const json of [false, true])
  test(`D7: without follow a failed job still exits 0, json=${json}`, async () => {
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withStub(
        ({ url }) =>
          url.pathname.endsWith("/logs")
            ? { chunks: [], nextCursor: 0, complete: true, truncated: false }
            : { id: "run-1", state: "failed", exitCode: 42, reason: "exit" },
        async (out) => {
          expect(await run(["job", "logs", "run-1"], env, out)).toBe(0);
        },
        json,
      );
    } finally {
      stderr.mockRestore();
    }
  });

test("D8: volume labels use sandbox parsing, including repeats and values containing equals", async () => {
  await withStub(
    () => ({ id: ID }),
    async (out, seen) => {
      expect(
        await run(
          [
            "volume",
            "create",
            "--size-mib",
            "64",
            "--label",
            "run=first",
            "--label",
            "run=last",
            "--label",
            "note=a=b",
            "--label",
            "empty=",
          ],
          env,
          out,
        ),
      ).toBe(0);
      expect(seen[0]!.body).toEqual({
        sizeMiB: 64,
        labels: { run: "last", note: "a=b", empty: "" },
      });
    },
  );
});
for (const label of ["broken", "=value"])
  test(`D8: volume create rejects malformed label ${label} before a request`, async () => {
    await withStub(
      () => undefined,
      async (out, seen) => {
        await expect(
          run(["volume", "create", "--size-mib", "64", "--label", label], env, out),
        ).rejects.toThrow("--label takes KEY=VALUE.");
        expect(seen).toHaveLength(0);
      },
    );
  });
test("D8: volume help advertises repeatable labels; job create does not accept them", async () => {
  const out = output();
  await run(["volume", "help"], env, out);
  expect(out.lines.join("\n")).toContain("[--label k=v]...");
  await expect(
    run(["job", "create", "once", "--label", "run=x", "--at", "now", "--", "true"], env, out),
  ).rejects.toThrow("Unknown option --label");
});

// Advance only polling sleeps. Request deadlines keep real timers so the
// fake clock cannot turn an unanswered request into a successful wait.
async function withClock(work: (now: () => number) => Promise<void>) {
  let elapsed = 0;
  const original = globalThis.setTimeout;
  const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    ms = 0,
    ...args: unknown[]
  ) => {
    if (ms > 0 && ms <= 30_000) {
      elapsed += ms;
      return original(fn, 0, ...args);
    }
    return original(fn, ms, ...args);
  }) as typeof setTimeout);
  try {
    await work(() => elapsed);
  } finally {
    timer.mockRestore();
    clock.mockRestore();
  }
}
const releasing = () =>
  Response.json(
    {
      error: {
        code: "volume_releasing",
        message: "The last sandbox is stopping.",
        hint: "Wait for the volume to be let go.",
      },
    },
    { status: 409 },
  );
for (const argv of [
  ["sandbox", "create", "--volume", `${ID}:/data`],
  ["volume", "delete", ID],
]) {
  test(`D11: ${argv.slice(0, 2).join(" ")} waits through 60 seconds with one message and one key`, async () => {
    await withClock(async (now) => {
      await withStub(
        () => (now() < 60_000 ? releasing() : INFO),
        async (out, seen) => {
          expect(await run(argv, env, out)).toBe(0);
          expect(now()).toBeGreaterThanOrEqual(60_000);
          expect(now()).toBeLessThanOrEqual(90_000);
          expect(out.errors).toHaveLength(1);
          expect(out.errors[0]).toMatch(/waiting.*volume.*let go/i);
          expect(new Set(seen.map((s) => s.key)).size).toBe(1);
          expect(seen[0]!.key).toBeTruthy();
          expect(new Set(seen.map((s) => JSON.stringify(s.body))).size).toBe(1);
        },
      );
    });
  });
  test(`D11: ${argv.slice(0, 2).join(" ")} stops waiting at 90 seconds and keeps the refusal`, async () => {
    await withClock(async (now) => {
      await withStub(releasing, async (out) => {
        await expect(run(argv, env, out)).rejects.toMatchObject({
          code: "volume_releasing",
          status: 409,
        });
        expect(now()).toBe(90_000);
        expect(out.errors).toHaveLength(1);
      });
    });
  });
}
test("D11: a volume attached to a running sandbox is refused without waiting", async () => {
  await withStub(
    () =>
      Response.json(
        { error: { code: "volume_attached", message: "Stop its sandbox first." } },
        { status: 409 },
      ),
    async (out, seen) => {
      await expect(run(["volume", "delete", ID], env, out)).rejects.toMatchObject({
        code: "volume_attached",
      });
      expect(seen).toHaveLength(1);
      expect(out.errors).toHaveLength(0);
    },
  );
});
for (const verb of ["get", "ls", "extend"])
  for (const endsAt of [null, undefined, "2026-10-06T18:00:00Z"])
    test(`D11: sandbox ${verb} shows the actual end ${endsAt}, keeping JSON intact`, async () => {
      const info = { ...INFO, endsAt, timeoutSeconds: endsAt ? 3600 : 0 };
      await withStub(
        () => (verb === "ls" ? { data: [info], nextCursor: null } : info),
        async (out) => {
          const args = [
            "sandbox",
            verb,
            ...(verb === "ls" ? ["--all"] : verb === "extend" ? [ID, "600"] : [ID]),
          ];
          expect(await run(args, env, out)).toBe(0);
          expect(out.lines.join("\n")).toContain(
            endsAt ?? (verb === "extend" ? "no time limit" : "no limit"),
          );
          expect(out.lines.join("\n")).not.toContain(INFO.expiresAt);
          const json = output(true);
          await run([...args, "--json"], env, json);
          const wire = JSON.parse(JSON.stringify(info));
          expect(JSON.parse(json.lines[0]!)).toEqual(verb === "ls" ? [wire] : wire);
        },
      );
    });
