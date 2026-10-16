import { expect, spyOn, test } from "bun:test";
import { run } from "../src/cli";
import { terminalSafe, terminalSafeLines } from "../src/terminal";

/* A log stream is what a customer's program wrote, and a terminal acts on
   escape sequences in it: clear the screen, set the clipboard (OSC 52), forge
   a link, reverse what is read. `sandbox logs`, `image logs` and `job logs`
   show each such character as \uXXXX on a terminal, print it as written to a
   pipe or with --raw, and keep tabs and line breaks (src/terminal.ts). */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const IMAGE = "3b1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const EVIL = "red \x1b[31m \x1b]52;c;aGk=\x07 \u202eevil\u202c \x9b2J\tok\n";
const SAFE = "red \\u001b[31m \\u001b]52;c;aGk=\\u0007 \\u202eevil\\u202c \\u009b2J\tok\n";
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };

const RUN = {
  id: RUN_ID,
  jobId: "11111111-1111-4111-8111-111111111111",
  occurrenceId: "o",
  attempt: 1,
  scheduledFor: 0,
  resourceId: "r",
  state: "succeeded",
  runGeneration: 1,
  executionEpoch: 1,
  deadlineAt: 2,
  startedAt: 1,
  endedAt: 2,
  exitCode: 0,
  reason: null,
  logBytes: 3,
  logsTruncated: false,
  createdAt: 0,
};
const PROCESS = {
  id: "p1",
  kind: "process",
  state: "exited",
  exitCode: 0,
  command: "printf",
  cwd: "/workspace",
  pty: false,
  stdinOpen: false,
  stdinOffset: 0,
  startedAt: "2026-10-06T12:00:00Z",
  endedAt: "2026-10-06T12:00:01Z",
  timeoutMs: null,
};

function route(url: URL): unknown {
  const path = url.pathname;
  const sandbox = `/v1/sandboxes/${SANDBOX}`;
  if (path === sandbox)
    return { id: SANDBOX, kind: "sandbox", name: "web", state: "running", labels: {} };
  if (path === `${sandbox}/processes/p1`) return PROCESS;
  if (path === `${sandbox}/processes/p1/output`)
    return Number(url.searchParams.get("cursor") ?? 0) === 0
      ? {
          chunks: [
            { stream: "stdout", text: EVIL, offset: 0 },
            { stream: "stderr", text: EVIL, offset: EVIL.length },
          ],
          nextCursor: EVIL.length * 2,
          truncated: false,
          droppedBytes: 0,
          process: PROCESS,
        }
      : {
          chunks: [],
          nextCursor: EVIL.length * 2,
          truncated: false,
          droppedBytes: 0,
          process: PROCESS,
        };
  if (path === `/v1/images/${IMAGE}`) return { id: IMAGE };
  if (path === `/v1/images/${IMAGE}/logs`)
    return url.searchParams.get("after") === "0"
      ? {
          lines: [{ seq: 1, at: "", stream: "build", text: EVIL.trimEnd() }],
          nextAfter: 1,
          state: "ready",
          truncated: false,
          done: true,
        }
      : { lines: [], nextAfter: 1, state: "ready", truncated: false, done: true };
  if (path === `/v1/job-runs/${RUN_ID}/logs`)
    return {
      chunks: [
        { offset: 0, stream: "stdout", text: EVIL },
        { offset: EVIL.length, stream: "stderr", text: EVIL },
      ],
      nextCursor: EVIL.length * 2,
      truncated: false,
      complete: true,
    };
  if (path === `/v1/job-runs/${RUN_ID}`) return RUN;
  return Response.json({ error: { code: "route_not_found", message: path } }, { status: 404 });
}

/** Runs the CLI with stdout and stderr on a terminal, or on a pipe. */
async function shown(argv: string[], tty: boolean) {
  const written: string[] = [];
  const fetch = globalThis.fetch;
  const ttys = [process.stdout, process.stderr].map((s) =>
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  );
  for (const s of [process.stdout, process.stderr])
    Object.defineProperty(s, "isTTY", { value: tty, configurable: true, writable: true });
  const stdout = spyOn(process.stdout, "write").mockImplementation((t) => {
    written.push(String(t));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((t) => {
    written.push(String(t));
    return true;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = route(new URL(new Request(input, init).url));
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof globalThis.fetch;
  try {
    const out = {
      json: false,
      write: (t: string) => void written.push(`${t}\n`),
      error: (t: string) => void written.push(`${t}\n`),
    };
    expect(await run(argv, env, out)).toBe(0);
  } finally {
    globalThis.fetch = fetch;
    stdout.mockRestore();
    stderr.mockRestore();
    [process.stdout, process.stderr].forEach((s, i) => {
      const before = ttys[i];
      if (before) Object.defineProperty(s, "isTTY", before);
      else delete (s as { isTTY?: boolean }).isTTY;
    });
  }
  return written.join("");
}

const COMMANDS = [
  ["sandbox", "logs", SANDBOX, "p1"],
  ["image", "logs", IMAGE],
  ["job", "logs", RUN_ID],
];

test("a log stream on a terminal shows control characters as \\uXXXX, and nothing acts", async () => {
  for (const argv of COMMANDS) {
    const text = await shown(argv, true);
    expect(text).toContain(SAFE.trimEnd());
    for (const char of ["\x1b", "\x07", "\x9b", "\u202e"]) expect(text).not.toContain(char);
  }
});

test("a log stream to a pipe, or with --raw, is printed as written", async () => {
  for (const argv of COMMANDS) {
    expect(await shown(argv, false)).toContain(EVIL.trimEnd());
    expect(await shown([...argv, "--raw"], true)).toContain(EVIL.trimEnd());
  }
});

test("one value escapes its line breaks; a stream of lines keeps them", () => {
  expect(terminalSafe("a\tb\nc\r\x00")).toBe("a\tb\\u000ac\\u000d\\u0000");
  expect(terminalSafeLines("a\tb\nc\r\x00")).toBe("a\tb\nc\\u000d\\u0000");
});
