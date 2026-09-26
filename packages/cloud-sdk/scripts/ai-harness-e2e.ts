/* End to end, against the real API: a Vercel AI SDK `HarnessAgent` whose
   sandbox is `createRuntimeSandbox()` from withruntime/ai-harness.

     RUNTIME_API_KEY=... bun scripts/ai-harness-e2e.ts

   No model is called. The harness is `scriptedHarness()` below: an AI SDK
   harness adapter (HarnessV1) whose turn runs a fixed script against the
   sandbox session the agent hands it, and reports what came back as the
   turn's text. Everything between the agent and Runtime is the real code:
   @ai-sdk/harness's HarnessAgent, its bootstrap and session directories, and
   this package's provider.

   What it checks, in order:
   1. A session: create, the bootstrap recipe (onFirstCreate), a turn that runs
      commands (env from the provider, cwd, stdin, a timeout) and writes and
      reads files.
   2. A port: a Bun HTTP and WebSocket server in the sandbox, reached through a
      private preview by its https URL (token in the link) and by WebSocket
      (token in the header), as a bridge harness would.
   3. Network policy: deny-all refuses an outbound request, allow-all brings it back.
   4. Stop and resume: with pauseOnStop, session.stop() pauses the sandbox and a
      new session with resumeFrom wakes the same machine, file still there.
   5. Cleanup: session.destroy() stops the sandbox; then every sandbox carrying
      this run's label is stopped, whatever happened above.

   It creates one trial-sized sandbox (2 vCPU / 2 GiB, a ten-minute lease) on
   the key's default funding: the free trial while it lasts. RUNTIME_API_URL
   points it elsewhere. Not part of `bun test`; tests/ai-harness.test.ts runs
   the same harness against the fake world. */
import type {
  HarnessV1,
  HarnessV1PromptTurnOptions,
  HarnessV1ResumeSessionState,
  HarnessV1Session,
  HarnessV1StartOptions,
  HarnessV1StreamPart,
} from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import {
  createRuntimeSandbox,
  PREVIEW_TOKEN_HEADER,
  type RuntimeNetworkSandboxSession,
  type RuntimeSandboxSettings,
} from "../src/ai-harness/index";
import { Runtime } from "../src/index";

export const SCRIPTED_HARNESS_ID = "runtime-scripted";
/** Where the bootstrap recipe writes, under $HOME/.ai-sdk-harness. */
export const BOOTSTRAP_FILE = "runtime-scripted/bootstrapped.txt";

type SandboxSession = HarnessV1StartOptions["sandboxSession"];

/** What one scripted turn found, reported as the turn's text (JSON). */
export type ScriptedReport = {
  prompt: string;
  sessionWorkDir: string;
  command: { exitCode: number; stdout: string; stderr: string };
  stdin: { exitCode: number; stdout: string } | null;
  timeout: { exitCode: number; stderr: string } | null;
  file: string | null;
  bootstrap: string | null;
};

/** A harness adapter with no model: each turn runs the same commands and file
 * operations in the sandbox session and answers with what it saw. `onStart`
 * sees each session's start options, the sandbox session among them. */
export function scriptedHarness(onStart?: (start: HarnessV1StartOptions) => void): HarnessV1 {
  const resumeState = (): HarnessV1ResumeSessionState => ({
    type: "resume-session",
    harnessId: SCRIPTED_HARNESS_ID,
    specificationVersion: "harness-v1",
    data: {},
  });
  return {
    specificationVersion: "harness-v1",
    harnessId: SCRIPTED_HARNESS_ID,
    builtinTools: {},
    getBootstrap: async () => ({
      harnessId: SCRIPTED_HARNESS_ID,
      bootstrapDir: "runtime-scripted",
      files: [{ path: BOOTSTRAP_FILE, content: "bootstrapped\n" }],
      commands: [{ command: "test -s bootstrapped.txt" }],
    }),
    doStart: async (start) => {
      onStart?.(start);
      const sandbox = start.sandboxSession;
      const session: HarnessV1Session = {
        sessionId: start.sessionId,
        isResume: start.resumeFrom !== undefined,
        doPromptTurn: async (turn) => {
          const done = (async () => {
            const report = await scriptedTurn(sandbox, start.sessionWorkDir, promptText(turn));
            emitText(turn.emit, JSON.stringify(report));
          })();
          done.catch((error: unknown) => turn.emit({ type: "error", error }));
          return { submitToolResult: async () => undefined, done };
        },
        doContinueTurn: async () => ({
          submitToolResult: async () => undefined,
          done: Promise.resolve(),
        }),
        doCompact: async () => undefined,
        doSuspendTurn: async () => ({
          type: "continue-turn",
          harnessId: SCRIPTED_HARNESS_ID,
          specificationVersion: "harness-v1",
          data: {},
        }),
        doDetach: async () => resumeState(),
        doStop: async () => resumeState(),
        doDestroy: async () => undefined,
      };
      return session;
    },
  };
}

function promptText(turn: HarnessV1PromptTurnOptions): string {
  const prompt = turn.prompt as unknown;
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

async function scriptedTurn(
  sandbox: SandboxSession,
  sessionWorkDir: string,
  prompt: string,
): Promise<ScriptedReport> {
  const command = await sandbox.run({
    command: 'echo "$GREETING from $(pwd)"; echo "to stderr" >&2',
    workingDirectory: sessionWorkDir,
    env: { GREETING: "hello" },
  });
  // stdin and timeoutMs are Runtime's additions; a plain SandboxSession has neither.
  const extended = sandbox as SandboxSession & {
    run(options: { command: string; stdin?: string; timeoutMs?: number }): Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  };
  const isRuntime = sandbox.description.startsWith("Runtime Cloud sandbox");
  const stdin = isRuntime ? await extended.run({ command: "tr a-z A-Z", stdin: "shout" }) : null;
  const timeout = isRuntime ? await extended.run({ command: "sleep 30", timeoutMs: 1_000 }) : null;
  await sandbox.writeTextFile({ path: `${sessionWorkDir}/notes.md`, content: `${prompt}\n` });
  const file = await sandbox.readTextFile({ path: `${sessionWorkDir}/notes.md` });
  const home = (await sandbox.run({ command: 'printf %s "$HOME"' })).stdout || "/workspace";
  const bootstrap = await sandbox.readTextFile({
    path: `${home}/.ai-sdk-harness/${BOOTSTRAP_FILE}`,
  });
  return {
    prompt,
    sessionWorkDir,
    command,
    stdin: stdin && { exitCode: stdin.exitCode, stdout: stdin.stdout },
    timeout: timeout && { exitCode: timeout.exitCode, stderr: timeout.stderr },
    file,
    bootstrap,
  };
}

function emitText(emit: (part: HarnessV1StreamPart) => void, text: string) {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
  emit({ type: "stream-start", modelId: "scripted" });
  emit({ type: "text-start", id: "t1" });
  emit({ type: "text-delta", id: "t1", delta: text });
  emit({ type: "text-end", id: "t1" });
  emit({
    type: "finish-step",
    finishReason: { unified: "stop", raw: "end" },
    usage,
  });
  emit({
    type: "finish",
    finishReason: { unified: "stop", raw: "end" },
    totalUsage: usage,
  });
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${what}`);
  console.log(`ok  ${what}`);
}

async function main() {
  if (!process.env.RUNTIME_API_KEY) {
    console.error("Set RUNTIME_API_KEY to a Runtime key (a test key). Nothing was created.");
    process.exit(2);
  }
  const runtime = new Runtime();
  const label = `ai-harness-e2e-${Date.now().toString(36)}`;
  const settings: RuntimeSandboxSettings = {
    runtime,
    create: { vcpu: 2, memoryMiB: 2048, timeoutSeconds: 600, labels: { e2e: label } },
    env: { FROM_PROVIDER: "yes" },
    ports: [4000],
    pauseOnStop: true,
  };
  const provider = createRuntimeSandbox(settings);
  let sandboxSession: RuntimeNetworkSandboxSession | undefined;
  const harness = scriptedHarness((start) => {
    sandboxSession = start.sandboxSession as RuntimeNetworkSandboxSession;
  });
  const agent = new HarnessAgent({ harness, sandbox: provider });
  const sessionId = `e2e-${label}`;
  const started = Date.now();
  try {
    // 1. A session and a turn.
    const session = await agent.createSession({ sessionId });
    const result = await agent.generate({ session, prompt: "write the notes" });
    const report = JSON.parse(result.text) as ScriptedReport;
    check(
      report.command.exitCode === 0 && /^hello from \//.test(report.command.stdout),
      "run: env and cwd",
    );
    check(report.command.stderr === "to stderr\n", "run: stderr kept apart");
    check(report.stdin?.stdout === "SHOUT", "run: stdin");
    check(report.timeout?.exitCode === 124, "run: a timeout exits 124");
    check(report.file === "write the notes\n", "files: write then read");
    check(report.bootstrap === "bootstrapped\n", "bootstrap recipe applied");

    // 2. A port, as a bridge harness reaches it.
    if (!sandboxSession) throw new Error("the harness was never started");
    const env = await sandboxSession.run({ command: 'printf %s "$FROM_PROVIDER"' });
    check(env.stdout === "yes", "provider env reaches every command");
    const server = await sandboxSession.spawn({
      command:
        'bun -e \'Bun.serve({port:4000,hostname:"0.0.0.0",fetch(r,s){if(s.upgrade(r))return;return new Response("hi from runtime")},websocket:{message(ws,m){ws.send("echo:"+m)}}})\'',
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const https = await sandboxSession.getPortEndpoint({ port: 4000, protocol: "https" });
    check(
      https.url.includes("runtime_preview_token="),
      "https endpoint carries its token in the link",
    );
    const page = await fetch(https.url, { headers: https.headers });
    check(
      page.ok && (await page.text()) === "hi from runtime",
      "https endpoint reaches the server",
    );
    const bare = await fetch(https.url.split("?")[0]!, { redirect: "manual" });
    check(bare.status === 401, "a private preview refuses a request without the token");
    const ws = await sandboxSession.getPortEndpoint({ port: 4000, protocol: "ws" });
    check(ws.headers?.[PREVIEW_TOKEN_HEADER], "ws endpoint carries its token in a header");
    const echoed = await new Promise<string>((resolve, reject) => {
      // Bun's WebSocket takes headers, as the `ws` package the harness uses does.
      const socket = new WebSocket(ws.url, { headers: ws.headers } as unknown as string[]);
      const timer = setTimeout(() => reject(new Error("no WebSocket echo in 15 s")), 15_000);
      socket.onopen = () => socket.send("ping");
      socket.onmessage = (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    check(echoed === "echo:ping", "ws endpoint reaches the server");
    // Not a check: whether the edge takes a WebSocket with the token in its
    // query. Read from the edge's code, it answers such a GET with a redirect,
    // which is why the provider sends the token as a header for ws.
    const inQuery = new URL(ws.url);
    inQuery.searchParams.set("runtime_preview_token", ws.headers[PREVIEW_TOKEN_HEADER]);
    const queryOutcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(inQuery.toString());
      const timer = setTimeout(() => resolve("no answer in 10 s"), 10_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve("opened");
        socket.close();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        resolve("refused");
      };
    });
    console.log(`note: a WebSocket with the token in its query: ${queryOutcome}`);
    await server.kill();

    // 3. Network policy.
    const probe = "curl -sS -o /dev/null -m 8 -w '%{http_code}' https://example.com";
    await sandboxSession.setNetworkPolicy({ mode: "deny-all" });
    check((await sandboxSession.run({ command: probe })).exitCode !== 0, "deny-all refuses egress");
    await sandboxSession.setNetworkPolicy({ mode: "allow-all" });
    check(
      (await sandboxSession.run({ command: probe })).exitCode === 0,
      "allow-all restores egress",
    );

    // 4. Stop (pause) and resume.
    const firstId = sandboxSession.id;
    const marker = crypto.randomUUID();
    await sandboxSession.writeTextFile({ path: "/workspace/e2e-marker.txt", content: marker });
    const resumeFrom = await session.stop();
    const paused = await runtime.sandboxes.get(sandboxSession.id);
    check(
      ["paused", "pausing"].includes(paused.state),
      `session.stop() paused it (${paused.state})`,
    );
    const resumed = await agent.createSession({ sessionId, resumeFrom });
    const again = JSON.parse(
      (await agent.generate({ session: resumed, prompt: "again" })).text,
    ) as ScriptedReport;
    check(again.file === "again\n", "a turn runs in the resumed session");
    check(sandboxSession.id === firstId, "resumeSession found the same sandbox");
    const kept = await sandboxSession.readTextFile({ path: "/workspace/e2e-marker.txt" });
    check(kept === marker, "its files survived the pause");

    // 5. Destroy.
    await resumed.destroy();
    const ended = await runtime.sandboxes.get(sandboxSession.id);
    check(
      ["stopped", "stopping"].includes(ended.state),
      `session.destroy() stopped it (${ended.state})`,
    );
    console.log(`\nAll checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  } finally {
    const left = await runtime.sandboxes.list({ labels: { e2e: label } });
    for (const sandbox of left.data) {
      await sandbox.stop({ wait: false }).catch((error: unknown) => console.error(error));
      console.log(`stopped ${sandbox.id}, left ${sandbox.state}`);
    }
  }
}

if (import.meta.main) await main();
