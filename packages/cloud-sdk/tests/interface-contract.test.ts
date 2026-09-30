import { expect, spyOn, test } from "bun:test";
import { run } from "../src/cli";
import { Runtime } from "../src/client";
import { RuntimeError } from "../src/errors";

/* Where the SDK and CLI disagree with what the API answers, against a stub
   API. Found in the interface sweep of 30 September 2026. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const INFO = { id: SANDBOX, kind: "sandbox", state: "running", status: "active", labels: {} };
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

async function withStub(
  answer: (method: string, url: URL) => unknown,
  work: (seen: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    const value = await answer(request.method, url);
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
  try {
    await work(seen);
  } finally {
    globalThis.fetch = original;
  }
}

/* The guest reports a command its signal ended as the negative signal number
   (Python's returncode: -9 after SIGKILL, as the out-of-memory killer sends,
   -15 after SIGTERM). `runtime sandbox exec` clamped it to 0 and exited 0, so
   a script took a killed command for a success. The shell's convention is
   128 + the signal. */
test("`runtime sandbox exec` exits 128 + the signal for a command a signal ended, never 0", async () => {
  for (const [exitCode, expected] of [
    [-9, 137],
    [-15, 143],
  ] as const) {
    await withStub(
      (_method, url) => {
        if (url.pathname === `/v1/sandboxes/${SANDBOX}`) return INFO;
        if (url.pathname === `/v1/sandboxes/${SANDBOX}:exec`)
          return {
            exitCode,
            stdout: "",
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
      },
      async () => {
        const lines: string[] = [];
        const code = await run(
          ["sandbox", "exec", SANDBOX, "--json", "--", "python3", "big.py"],
          env,
          {
            json: true,
            write: (t: string) => lines.push(t),
            error: (t: string) => lines.push(t),
          },
        );
        expect(code).toBe(expected);
      },
    );
  }
  // Streamed, the exit event carries the same code.
  await withStub(
    (_method, url) => {
      if (url.pathname === `/v1/sandboxes/${SANDBOX}`) return INFO;
      if (url.pathname === `/v1/sandboxes/${SANDBOX}:exec`)
        return new Response(
          [
            { type: "start", processId: "p1" },
            { type: "exit", exitCode: -9, timedOut: false },
          ]
            .map((event) => `${JSON.stringify(event)}\n`)
            .join(""),
          { headers: { "content-type": "application/x-ndjson" } },
        );
    },
    async () => {
      const write = spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const code = await run(["sandbox", "exec", SANDBOX, "--", "python3", "big.py"], env, {
          json: false,
          write: () => {},
          error: () => {},
        });
        expect(code).toBe(137);
      } finally {
        write.mockRestore();
      }
    },
  );
});

/* The API answers a product switched off on this deployment with a fixed 503
   (`serverFault` "off" in packages/cloud/src/api/respond.ts). Retrying cannot
   change it, and the SDK knew three of those codes: the other five were
   retried four times with backoff, some fifteen seconds, and reported
   retryable. The list is the SDK's own (`DELIBERATE`), held here to the
   server's. */
const OFF_CODES = [
  "unavailable",
  "unsupported",
  "fork_unavailable",
  "previews_unavailable",
  "network_unavailable",
  "network_rules_unavailable",
  "secrets_unavailable",
  "identity_unavailable",
  "env_unavailable",
];
test("a product switched off answers at once and is not retryable, for every code the API uses for it", async () => {
  for (const code of OFF_CODES) {
    expect({
      code,
      retryable: new RuntimeError({ message: "off", code, status: 503 }).retryable,
    }).toEqual({
      code,
      retryable: false,
    });
    await withStub(
      () =>
        Response.json(
          { error: { code, status: 503, message: "off", requestId: "r", hint: "h" } },
          { status: 503 },
        ),
      async (seen) => {
        const runtime = new Runtime({
          apiKey: "rk_x",
          baseUrl: "https://api.example.test",
          maxRetries: 2,
        });
        await expect(runtime.limits.get()).rejects.toMatchObject({ code });
        expect({ code, calls: seen.length }).toEqual({ code, calls: 1 });
      },
    );
  }
});
