import { expect, test } from "bun:test";
import { CommandError, Runtime } from "../src/index";
import { run } from "../src/cli";

/* 9 October 2026: a program killed for memory in a 512 MiB sandbox read as a
   bare exit -9 with empty output. The API now says `outOfMemory`; the SDK
   keeps it on the result, the process and the error, and the CLI prints the
   message and the hint. */

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const info = { id: ID, kind: "sandbox", state: "running", status: "active", labels: {} };
const memory = {
  code: "out_of_memory" as const,
  processesKilled: 1,
  memoryMiB: 512,
  message:
    "The sandbox ran out of its 512 MiB of memory, and Linux's out-of-memory killer ended 1 process of this command.",
  hint: "Give the program more memory: create the sandbox with memoryMiB 1024 or more.",
};
const killed = {
  exitCode: -9,
  stdout: "",
  stderr: "",
  timedOut: false,
  durationMs: 1042,
  outOfMemory: memory,
};
const ndjson = (lines: unknown[]) =>
  new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), {
    headers: { "content-type": "application/x-ndjson" },
  });
const exitEvent = {
  type: "exit",
  exitCode: -9,
  state: "exited",
  timedOut: false,
  outOfMemory: memory,
};

function answer(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(new Request(input, init).url);
  const body =
    typeof init?.body === "string" ? (JSON.parse(init.body) as { stream?: boolean }) : {};
  if (init?.method === "POST" && url.pathname.endsWith(":exec"))
    return body.stream
      ? ndjson([{ type: "start", processId: "p1" }, exitEvent])
      : Response.json(killed);
  return Response.json(info);
}

const runtime = () =>
  new Runtime({
    apiKey: "rk",
    baseUrl: "https://api.example.test",
    fetch: (async (input: string, init: RequestInit = {}) =>
      answer(input, init)) as unknown as typeof fetch,
  });

test("an exec result carries outOfMemory, streamed or not", async () => {
  const sbx = await runtime().sandboxes.get(ID);
  expect((await sbx.exec("node big.js")).outOfMemory).toEqual(memory);
  expect((await sbx.exec("node big.js", { onStdout: () => {} })).outOfMemory).toEqual(memory);
});

test("check: true throws out_of_memory with the hint, and says not to retry", async () => {
  const sbx = await runtime().sandboxes.get(ID);
  const error = (await sbx
    .exec("node big.js", { check: true })
    .catch((e: unknown) => e)) as CommandError;
  expect(error).toBeInstanceOf(CommandError);
  expect(error.code).toBe("out_of_memory");
  expect(error.message).toContain("512 MiB");
  expect(error.hint).toBe(memory.hint);
  expect(error.retryable).toBe(false);
  const plain = new CommandError({ exitCode: 1, stdout: "", stderr: "boom" });
  expect(plain.code).toBe("command_failed");
});

test("the CLI prints the message and the hint, and exits 137", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = answer as unknown as typeof fetch;
  const errors: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    const code = await run(
      ["sandbox", "exec", ID, "--", "node", "big.js"],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: () => {}, error: (t) => errors.push(t) },
    );
    expect(code).toBe(137);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = original;
  }
  expect(errors.join("\n")).toContain(`runtime: ${memory.message}\nHint: ${memory.hint}`);
});

/* Words from an answer never drive the terminal: an escape in them (a forged
   answer, a proxy) prints as its \uXXXX form, as a log line does. */
test("the CLI escapes control characters in the words it prints", async () => {
  const { outOfMemoryLines } = await import("../src/cli");
  const line = outOfMemoryLines({
    ...memory,
    code: "out_of_memory",
    message: "ran out\u001b]52;c;cHduZWQ=\u0007 \u001b[2J",
    hint: "more\u009b31m memory\nrm -rf /",
  })!;
  // Every C0 control but the newline between the two lines, DEL and C1.
  const control = [...line].filter((char) => {
    const code = char.codePointAt(0)!;
    return (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
  });
  expect(control).toEqual([]);
  expect(line.split("\n")).toHaveLength(2);
  expect(line).toContain("\\u001b]52");
  expect(
    outOfMemoryLines({ ...memory, code: "out_of_memory", message: 5 as never }),
  ).toBeUndefined();
});

test("ps escapes the command line a guest reports and marks the kill", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    return url.pathname.endsWith("/processes")
      ? Response.json({
          data: [
            {
              id: "p1",
              kind: "process",
              state: "exited",
              exitCode: -9,
              command: "node \u001b[2Jbig.js",
              outOfMemory: memory,
            },
          ],
          nextCursor: null,
        })
      : Response.json(info);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await run(
      ["sandbox", "ps", ID],
      { RUNTIME_API_KEY: "rk", RUNTIME_API_URL: "https://api.example.test" },
      { json: false, write: (t) => lines.push(t), error: (t) => lines.push(t) },
    );
  } finally {
    globalThis.fetch = original;
  }
  const text = lines.join("\n");
  expect(text).not.toContain("\u001b");
  expect(text).toContain("-9 (out of memory)");
  expect(text).toContain(`Hint: ${memory.hint}`);
});
