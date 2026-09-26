import { expect, test } from "bun:test";
import { run } from "../src/cli";
import type { RuntimeError } from "../src/errors";

/* Every command declares the options it takes, and refuses any other before a
   request is sent. Until 0.7.0 an unknown option was taken silently: on
   25 September 2026 `runtime sandbox create --bogus 1` created a sandbox, so
   `--memory-mib 8192` for `--memory` meant a sandbox at the default size, and
   `sandbox create --help --vcpu 2` created one too. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const info = {
  id: SANDBOX,
  kind: "sandbox",
  state: "running",
  status: "active",
  labels: {},
  vcpu: 2,
  memoryMiB: 4096,
};

async function cli(argv: string[]) {
  const original = globalThis.fetch;
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> | undefined }> =
    [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    sent.push({
      method: request.method,
      path: url.pathname,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    });
    return Response.json(info);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    const code = await run(argv, env, {
      json: false,
      write: (t) => lines.push(t),
      error: (t) => lines.push(`ERR ${t}`),
    });
    return { code, text: lines.join("\n"), sent, error: undefined };
  } catch (error) {
    return { code: 1, text: lines.join("\n"), sent, error: error as RuntimeError };
  } finally {
    globalThis.fetch = original;
  }
}

test("a misspelled option is refused with the one that was meant, and nothing is created", async () => {
  const { error, sent } = await cli(["sandbox", "create", "--memory-mib", "8192"]);
  expect(sent).toEqual([]);
  expect(error?.code).toBe("usage");
  expect(error?.message).toStartWith("Unknown option --memory-mib. Did you mean --memory?");
  expect(error?.hint).toBe("Run `runtime sandbox help`.");
  const bogus = await cli(["sandbox", "create", "--bogus", "1"]);
  expect(bogus.sent).toEqual([]);
  expect(bogus.error?.message).toMatch(
    /^Unknown option --bogus\. This command takes --name, --label, .*, --trial, --paid/,
  );
});

test("--help anywhere before -- prints the product's help and runs nothing", async () => {
  for (const argv of [
    ["sandbox", "create", "--help", "--vcpu", "2"],
    ["sandbox", "run", "-h", "--", "echo"],
    ["image", "build", "--help"],
  ]) {
    const { code, text, sent } = await cli(argv);
    expect(sent).toEqual([]);
    expect(code).toBe(0);
    expect(text).toContain(`runtime ${argv[0]} <command>`);
  }
  // After --, it belongs to the command.
  const { sent } = await cli(["sandbox", "exec", SANDBOX, "--", "ls", "--help"]);
  expect(sent.length).toBeGreaterThan(0);
});

test("an option of the command itself points after --", async () => {
  const { error, sent } = await cli(["sandbox", "run", "python3", "-c", "print(1)"]);
  expect(sent).toEqual([]);
  expect(error?.message).toBe(
    "Unknown option -c. If it belongs to the command, put the command after --: runtime sandbox run -- python3 -c 'print(6*7)'",
  );
});

test("create takes the SDK's CPU and cost options, checked before sending", async () => {
  const { sent } = await cli([
    "sandbox",
    "create",
    "--cpu",
    "reserved",
    "--cpu-floor",
    "500",
    "--max-cost",
    "0.50",
    "--max-total-cost",
    "25",
    "--on-timeout",
    "stop",
  ]);
  expect(sent[0]?.body).toMatchObject({
    cpu: "reserved",
    cpuFloorMillis: 500,
    maxCostMicros: 500_000,
    maxTotalCostMicros: 25_000_000,
    onLeaseEnd: "stop",
  });
  const cpu = await cli(["sandbox", "create", "--cpu", "fast"]);
  expect(cpu.sent).toEqual([]);
  expect(cpu.error?.message).toBe("--cpu takes shared or reserved.");
  const cost = await cli(["sandbox", "create", "--max-cost", "$5"]);
  expect(cost.error?.message).toBe("--max-cost takes dollars, such as 25 or 2.50.");
});

test("a mistyped command is matched only when it is close", async () => {
  expect((await cli(["sandbox", "exce"])).error?.message).toBe(
    "Unknown sandbox command exce. Did you mean exec?",
  );
  expect((await cli(["sandbox", "bogus"])).error?.message).toBe("Unknown sandbox command bogus.");
  expect((await cli(["snapshot", "lst"])).error?.message).toBe(
    "Unknown snapshot command lst. Did you mean ls?",
  );
});

test("cp takes -r as cp does, and copies directories either way", async () => {
  const { error } = await cli(["sandbox", "cp", "-r", "./nowhere-at-all", `${SANDBOX}:/workspace`]);
  expect(error?.message ?? "").not.toContain("Unknown option");
});

test("a create waiting for a trial slot says so on standard error, once", async () => {
  const original = globalThis.fetch;
  let refusals = 2;
  globalThis.fetch = (async () =>
    refusals-- > 0
      ? Response.json(
          {
            error: {
              code: "trial_busy",
              message: "All eight trial slots are running.",
              retryAfterMs: 5,
            },
          },
          { status: 409 },
        )
      : Response.json(info)) as unknown as typeof fetch;
  const lines: string[] = [];
  try {
    const code = await run(["sandbox", "create"], env, {
      json: false,
      write: (t) => lines.push(t),
      error: (t) => lines.push(`ERR ${t}`),
    });
    expect(code).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
  expect(lines).toEqual([
    "ERR All eight trial slots are running. Waiting for room, up to 2 minutes; Ctrl-C stops.",
    SANDBOX,
  ]);
});

test("the user lane's typos are each refused with the option meant", async () => {
  for (const [argv, meant] of [
    [["sandbox", "create", "--trial", "--vcpus", "4"], "--vcpu"],
    [["sandbox", "create", "--memry", "8192"], "--memory"],
    [["sandbox", "create", "--trail"], "--trial"],
    [["sandbox", "exec", SANDBOX, "--tiemout", "3", "--", "sleep", "9"], "--timeout"],
  ] as const) {
    const { error, sent } = await cli([...argv]);
    expect(sent).toEqual([]);
    expect(error?.message).toContain(`Did you mean ${meant}?`);
  }
});

test("a refusal of what was sent names its request but invites no report; a failure of ours does", async () => {
  const { describeError } = await import("../src/cli");
  const { RuntimeError } = await import("../src/errors");
  const refused = new RuntimeError({
    message: "No API key was sent.",
    code: "unauthorized",
    status: 401,
    requestId: "req_1",
  });
  expect(describeError(refused, false)).toBe(
    "Error [unauthorized]: No API key was sent.\nRequest: req_1",
  );
  const ours = new RuntimeError({
    message: "x",
    code: "internal",
    status: 500,
    requestId: "req_2",
  });
  expect(describeError(ours, false)).toContain(
    'report it: runtime feedback "..." --request-id req_2',
  );
});

test("`sandbox network` with the internet off allows nothing, and says so", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({
      internet: false,
      allow: [],
      deny: [],
      connect: [],
      enforced: true,
    })) as unknown as typeof fetch;
  const lines: string[] = [];
  try {
    await run(["sandbox", "network", SANDBOX], env, {
      json: false,
      write: (t) => lines.push(t),
      error: (t) => lines.push(t),
    });
  } finally {
    globalThis.fetch = original;
  }
  expect(lines.join("\n")).toMatch(/^allow\s+\(nothing\)$/m);
});
