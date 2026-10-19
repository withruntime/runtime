/** Cloudflare's own Sandbox SDK 0.x examples, as fixtures for
 * scripts/compatibility-cloudflare-live.ts. Each file under this folder is
 * copied verbatim from its source (named in its first line) with one change:
 * the package name, "@cloudflare/sandbox" -> "withruntime/cloudflare". A
 * wrangler.jsonc also loses its "containers" block, the one config change the
 * switch needs. Source files carry a `.upstream` suffix so no formatter,
 * linter or type check here rewrites them. What each request must answer is written here, from what the
 * source says the example does on Cloudflare. */

/** What a request answered. */
export interface Answer {
  status: number;
  type: string;
  text: string;
  bytes: Uint8Array;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- examples answer free-form JSON
  json?: any;
}
/** One request to a running example Worker. `expect` throws when the answer
 * is not what the example documents, and may return a detail to print. */
export interface Step {
  name: string;
  path: string;
  method?: string;
  body?: unknown;
  headers?: (earlier: Answer[]) => Record<string, string>;
  expect: (answer: Answer, earlier: Answer[]) => string | void;
}
/** A complete Worker from Cloudflare: its folder, entry, and requests. The
 * docs' Workers start from the minimal template, so they use its config. */
export interface WorkerExample {
  name: string;
  dir: string;
  main: string;
  config: string;
  steps: Step[];
}
/** A docs code block that is a fragment, not a Worker. The runner puts it in a
 * route of one Worker, after `prelude` (what the page leaves to the reader:
 * a `sandbox`, a file the block reads) and before `after` (a read-back). */
export interface Snippet {
  file: string;
  prelude?: string;
  after?: string;
  expect: (answer: SnippetAnswer) => string | void;
}
/** A snippet route's answer: its console output, and what it returned or threw. */
export interface SnippetAnswer extends Answer {
  logs: string[];
  error?: { name: string; message: string; code?: string };
  returned?: unknown;
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const json = (a: Answer) => {
  ok(a.status === 200, `HTTP ${a.status}: ${a.text.slice(0, 400)}`);
  return a.json as Record<string, unknown>;
};
const clean = (a: SnippetAnswer) => {
  ok(!a.error, `threw ${a.error?.name}: ${a.error?.message}`);
  ok(a.status === 200, `HTTP ${a.status}: ${a.text.slice(0, 400)}`);
};
const logged = (a: SnippetAnswer, text: string | RegExp) => {
  ok(
    a.logs.some((line) => (typeof text === "string" ? line.includes(text) : text.test(line))),
    `no log ${String(text)} in ${JSON.stringify(a.logs).slice(0, 400)}`,
  );
};
/** SSE `data:` events in a body. */
const events = (text: string) =>
  text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);

const MINIMAL = "minimal/wrangler.jsonc";
const runAndFile = (expected: string): Step[] => [
  {
    name: "GET /run",
    path: "/run",
    expect: (a) => {
      const r = json(a);
      ok(r.output === expected && r.success === true && r.exitCode === 0, JSON.stringify(r));
      return JSON.stringify(r.output);
    },
  },
  {
    name: "GET /file",
    path: "/file",
    expect: (a) => {
      ok(json(a).content === "Hello, Sandbox!", a.text);
      return a.text;
    },
  },
  {
    name: "GET /",
    path: "/",
    expect: (a) => ok(a.text === "Try /run or /file", a.text),
  },
];

export const WORKERS: WorkerExample[] = [
  {
    name: "examples/minimal",
    dir: "minimal",
    main: "src/index.ts",
    config: "minimal/wrangler.jsonc",
    steps: runAndFile("2 + 2 = 4\n"),
  },
  {
    name: "examples/alpine",
    dir: "alpine",
    main: "src/index.ts",
    config: "alpine/wrangler.jsonc",
    steps: runAndFile("2 + 2 = 4\n"),
  },
  {
    name: "docs get-started",
    dir: "docs/get-started",
    main: "src/index.ts",
    config: MINIMAL,
    steps: runAndFile("4\n"),
  },
  {
    name: "docs streaming-output (Worker)",
    dir: "docs/streaming-output-worker",
    main: "src/index.js",
    config: MINIMAL,
    steps: [
      {
        name: "GET / streams npm run build as SSE",
        path: "/",
        expect: (a) => {
          ok(a.status === 200 && a.type.startsWith("text/event-stream"), `${a.status} ${a.type}`);
          const all = events(a.text);
          ok(all[0]?.type === "start", `first event ${JSON.stringify(all[0])}`);
          const done = all.at(-1);
          // No package.json in a new sandbox: npm fails, as it would on Cloudflare.
          ok(done?.type === "complete" && typeof done.exitCode === "number", JSON.stringify(done));
          return `${all.length} events, exit ${String(done.exitCode)}`;
        },
      },
    ],
  },
  {
    name: "docs background-processes (Worker)",
    dir: "docs/background-processes-worker",
    main: "src/index.ts",
    config: MINIMAL,
    steps: [
      {
        name: "GET / runs a keepAlive build, streams its logs, destroys",
        path: "/",
        expect: (a) =>
          ok(a.status === 200 && a.text === "Build completed", `${a.status} ${a.text}`),
      },
    ],
  },
  {
    name: "docs expose-services (Worker)",
    dir: "docs/expose-services-worker",
    main: "src/index.js",
    config: MINIMAL,
    steps: [
      {
        // As the page's `curl http://localhost:8787`: the Worker sees localhost.
        name: "GET http://localhost/ starts a web server and exposes port 8000",
        path: "/",
        headers: () => ({ host: "localhost" }),
        expect: (a) => {
          const { url } = json(a) as { url: string };
          // Cloudflare's SDK builds this exact shape for a local hostname.
          ok(/^http:\/\/8000-my-sandbox-[a-z0-9_]{16}\.localhost\/$/.test(url), url);
          return url;
        },
      },
      {
        name: "GET <preview URL> through proxyToSandbox",
        path: "/",
        headers: (earlier) => ({ host: new URL((earlier[0]!.json as { url: string }).url).host }),
        expect: (a) => {
          ok(a.status === 200, `HTTP ${a.status}: ${a.text.slice(0, 300)}`);
          ok(a.text.includes("Directory listing for /"), a.text.slice(0, 300));
          return "python http.server's directory listing";
        },
      },
    ],
  },
  {
    name: "docs tutorials/automated-testing-pipeline",
    dir: "docs/testing-pipeline",
    main: "src/index.ts",
    config: MINIMAL,
    steps: [
      {
        name: "POST / clones a repository and runs its tests",
        path: "/",
        method: "POST",
        body: { repoUrl: "https://github.com/octocat/Hello-World" },
        expect: (a) => {
          const r = json(a);
          ok(
            r.success === true && r.exitCode === 0 && r.projectType === "unknown",
            JSON.stringify(r),
          );
          return JSON.stringify(r);
        },
      },
    ],
  },
];

const SERVER = `await sandbox.writeFile("/workspace/server.js", "require('http').createServer((q, s) => s.end(q.url === '/health' ? 'ok' : 'hello')).listen(process.env.PORT || 3000, () => console.log('Server listening on ' + (process.env.PORT || 3000)));");`;
/** Each docs page's blocks assume a sandbox of their own: an interpreter page
 * starts with no contexts left by earlier pages, since a Runtime sandbox runs
 * at most four at once (Cloudflare's container has no fixed count). */
const NO_CONTEXTS =
  'for (const c of await getSandbox(env.Sandbox, "my-sandbox").listCodeContexts()) await getSandbox(env.Sandbox, "my-sandbox").deleteCodeContext(c.id);';
const FRESH = 'await getSandbox(env.Sandbox, "my-sandbox").killAllProcesses();';

export const SNIPPETS: Snippet[] = [
  // Execute commands
  {
    file: "execute-commands-1.js",
    expect: (a) => {
      clean(a);
      ok(a.logs.length === 3, JSON.stringify(a.logs));
      return a.logs.join(" | ");
    },
  },
  {
    file: "execute-commands-9.js",
    expect: (a) => {
      clean(a);
      logged(a, "Sum: 15");
      return a.logs.join(" | ");
    },
  },
  {
    // After block 9 wrote analyze.py, `python analyze.py` (no argument) fails
    // with exit 1, which the block turns into "Invalid input data".
    file: "execute-commands-5.js",
    expect: (a) => {
      ok(a.error?.message === "Invalid input data", JSON.stringify(a.error ?? a.returned));
      logged(a, "Exit code: 1");
      return a.error.message;
    },
  },
  {
    file: "execute-commands-7.js",
    expect: (a) => {
      clean(a);
      logged(a, /^Python files: \d+$/);
      return a.logs.join(" | ");
    },
  },
  { file: "execute-commands-11.js", expect: clean },
  { file: "execute-commands-13.js", expect: clean },
  {
    file: "execute-commands-15.js",
    expect: (a) => {
      clean(a);
      ok(a.logs.length === 0, `logged ${JSON.stringify(a.logs)}`);
    },
  },
  // Stream output
  {
    file: "streaming-output-1.js",
    expect: (a) => {
      clean(a);
      logged(a, /^Exit code: \d+$/);
      return a.logs.at(-1);
    },
  },
  {
    file: "streaming-output-7.js",
    prelude: FRESH,
    expect: (a) => {
      clean(a);
      // No server.js yet: node exits, and the log stream ends with it.
      logged(a, "Cannot find module");
    },
  },
  {
    file: "streaming-output-9.js",
    expect: (a) => {
      ok(/^Build failed with exit code \d+$/.test(a.error?.message ?? ""), JSON.stringify(a.error));
      return a.error!.message;
    },
  },
  // Manage files
  {
    file: "manage-files-3.js",
    prelude: 'const imageUrl = "https://developers.cloudflare.com/favicon.png";',
    expect: clean,
  },
  {
    file: "manage-files-5.js",
    expect: (a) => {
      ok(a.status === 200 && a.type === "image/png", `${a.status} ${a.type}`);
      ok(a.bytes[0] === 0x89 && a.bytes[1] === 0x50 && a.bytes[2] === 0x4e, "not a PNG");
      logged(a, "console.log('Hello from sandbox!');");
      return `${a.bytes.length} PNG bytes, ${a.type}`;
    },
  },
  {
    file: "manage-files-7.js",
    prelude:
      'await sandbox.writeFile("/workspace/draft.txt", "draft"); await sandbox.writeFile("/tmp/download.txt", "download"); await sandbox.writeFile("/workspace/temp.txt", "temp");',
    after:
      'return { final: (await sandbox.readFile("/workspace/final.txt")).content, data: (await sandbox.readFile("/workspace/data.txt")).content, temp: (await sandbox.exists("/workspace/temp.txt")).exists };',
    expect: (a) => {
      clean(a);
      const r = a.returned as Record<string, unknown>;
      ok(r.final === "draft" && r.data === "download" && r.temp === false, JSON.stringify(r));
      return JSON.stringify(r);
    },
  },
  {
    file: "manage-files-9.js",
    after: 'return (await sandbox.readFile("/workspace/src/utils.js")).content;',
    expect: (a) => {
      clean(a);
      ok(a.returned === 'console.log("utils");', JSON.stringify(a.returned));
    },
  },
  {
    file: "manage-files-11.js",
    prelude: "const session = await sandbox.createSession();",
    expect: clean,
  },
  {
    file: "manage-files-17.js",
    prelude: 'const base64data = btoa("binary\\u0000data");',
    after: "return file;",
    expect: (a) => {
      clean(a);
      const file = a.returned as { content: string; encoding: string };
      ok(
        file.content === btoa("binary\u0000data") && file.encoding === "base64",
        JSON.stringify(file),
      );
    },
  },
  {
    // The write is refused, as Cloudflare's is. Across the Durable Object's
    // RPC an error keeps only its message (on Cloudflare too), so error.code
    // is undefined in a Worker and the block logs nothing.
    file: "manage-files-19.js",
    expect: (a) => {
      clean(a);
      ok(a.logs.length === 0, JSON.stringify(a.logs));
    },
  },
  {
    file: "manage-files-1.js",
    prelude:
      'const code = "console.log(1)"; await sandbox.mkdir("/workspace/my-project", { recursive: true });',
    after: 'return (await sandbox.readFile("/workspace/my-project/src/index.js")).content;',
    expect: (a) => {
      clean(a);
      ok(a.returned === "console.log(1)", JSON.stringify(a.returned));
    },
  },
  // Background processes
  {
    file: "background-processes-1.js",
    prelude: FRESH,
    expect: (a) => {
      clean(a);
      logged(a, "Status: running");
      // Cloudflare's pid is optional; Runtime does not report one.
      logged(a, /^PID: /);
      return a.logs.join(" | ");
    },
  },
  {
    file: "background-processes-5.js",
    prelude: 'const processId = "none";',
    expect: (a) => {
      clean(a);
      logged(a, /^Running \d+ processes:$/);
      return a.logs[0];
    },
  },
  {
    file: "background-processes-7.js",
    prelude: `${FRESH} ${SERVER}`,
    expect: (a) => {
      clean(a);
      logged(a, "Server is ready");
    },
  },
  {
    file: "background-processes-9.js",
    prelude: FRESH,
    expect: (a) => {
      clean(a);
      logged(a, "Server is ready: Server listening on 3000");
    },
  },
  {
    file: "background-processes-13.js",
    prelude: `${FRESH} const server = await sandbox.startProcess("node server.js"); await server.waitForLog("Server listening");`,
    expect: (a) => {
      clean(a);
      logged(a, "Logs:");
    },
  },
  {
    file: "background-processes-15.js",
    prelude: `${FRESH} const server = await sandbox.startProcess("node server.js"); await server.waitForLog("Server listening");`,
    after: "return (await sandbox.listProcesses()).filter((p) => p.status === 'running').length;",
    expect: (a) => {
      clean(a);
      ok(a.returned === 0, `running after killAllProcesses: ${String(a.returned)}`);
    },
  },
  { file: "background-processes-17.js", expect: clean },
  {
    // redis-server is not in either image: the wait ends when the process does.
    file: "background-processes-19.js",
    prelude: FRESH,
    expect: (a) => {
      ok(
        /Process exited with code \d+ before becoming ready\. Waiting for: port 6379 \(TCP\)$/.test(
          a.error?.message ?? "",
        ),
        JSON.stringify(a.error),
      );
      return a.error!.message;
    },
  },
  { file: "background-processes-23.js", prelude: FRESH, expect: clean },
  {
    file: "background-processes-25.js",
    after: "return (await server.waitForLog('Server listening')).line;",
    expect: (a) => {
      clean(a);
      ok(a.returned === "Server listening on 3000", JSON.stringify(a.returned));
    },
  },
  // Code interpreter
  {
    file: "interpreter-2.js",
    prelude: NO_CONTEXTS,
    after: "return ctx.language;",
    expect: (a) => {
      clean(a);
      ok(a.returned === "python", JSON.stringify(a.returned));
    },
  },
  {
    file: "interpreter-5.js",
    expect: (a) => {
      clean(a);
      logged(a, "78.53981633974483");
    },
  },
  {
    file: "interpreter-7.js",
    expect: (a) => {
      clean(a);
      logged(a, '["Sum: 15\\n"]');
      logged(a, "15");
      return a.logs.join(" | ");
    },
  },
  {
    file: "interpreter-9.js",
    expect: (a) => {
      clean(a);
      logged(a, "ZeroDivisionError");
      logged(a, "division by zero");
    },
  },
  {
    file: "interpreter-13.js",
    expect: (a) => {
      clean(a);
      logged(a, "30");
    },
  },
  {
    file: "interpreter-16.js",
    expect: (a) => {
      clean(a);
      logged(a, /^Found \d+ contexts$/);
      return a.logs[0];
    },
  },
  // The page's blocks so far hold four contexts; this one makes a fifth.
  { file: "interpreter-19.js", prelude: NO_CONTEXTS, expect: clean },
  {
    file: "interpreter-21.js",
    expect: (a) => {
      ok(
        a.status === 200 && a.type === "image/png",
        `${a.status} ${a.type} ${a.text.slice(0, 300)}`,
      );
      ok(a.bytes[0] === 0x89 && a.bytes[1] === 0x50, "not a PNG");
      return `${a.bytes.length} PNG bytes`;
    },
  },
  {
    file: "interpreter-23.js",
    expect: (a) => {
      ok(
        a.status === 200 && a.type === "text/html",
        `${a.status} ${a.type} ${a.text.slice(0, 300)}`,
      );
      ok(a.text.includes("Alice") && a.text.includes("<table"), a.text.slice(0, 300));
      return "a pandas DataFrame as an HTML table";
    },
  },
  {
    file: "code-execution-1.js",
    prelude: NO_CONTEXTS,
    expect: (a) => {
      clean(a);
      logged(a, "Language: python");
    },
  },
  { file: "code-execution-13.js", expect: clean },
  {
    file: "code-execution-15.js",
    prelude: 'const context = await sandbox.createCodeContext({ language: "python" });',
    after: "return (await sandbox.listCodeContexts()).length;",
    expect: (a) => {
      clean(a);
      logged(a, "All contexts deleted");
      ok(a.returned === 0, `contexts left: ${String(a.returned)}`);
    },
  },
  // Preview URLs
  {
    // Cloudflare's tokens are at most 16 of a-z, 0-9 and _; "api-v1" is refused.
    file: "expose-services-4.js",
    expect: (a) => {
      ok(
        a.error?.message.endsWith(
          "Custom token must contain only lowercase letters (a-z), numbers (0-9), and underscores (_). Invalid token provided.",
        ),
        JSON.stringify(a.error ?? a.returned),
      );
      return a.error!.message;
    },
  },
  // Sessions
  {
    file: "sessions-2.js",
    prelude:
      'await sandbox.mkdir("/workspace/prod", { recursive: true }); await sandbox.mkdir("/workspace/test", { recursive: true });',
    after: "return { prod: prodResult.exitCode, test: testResult.exitCode };",
    expect: clean,
  },
  { file: "sessions-8.js", expect: clean },
  {
    file: "sessions-11.js",
    after: 'return (await sandbox.exec("echo $NODE_ENV")).stdout;',
    expect: (a) => {
      clean(a);
      ok(a.returned === "production\n", JSON.stringify(a.returned));
    },
  },
];

/** What was not run, and why. */
export const SKIPPED: { name: string; reason: string }[] = [
  {
    name: "examples/code-interpreter",
    reason:
      "calls Workers AI (env.AI), a Cloudflare service; its sandbox calls (createCodeContext, runCode) run in the interpreter-* docs blocks",
  },
  {
    name: "examples/git-repo-per-sandbox",
    reason: "needs Cloudflare Artifacts (env.ARTIFACTS) for the remote repository",
  },
  {
    name: "examples/claude-code, codex, opencode, openai-agents, codex-app-server",
    reason:
      "need a model provider's key; claude-code also subclasses Sandbox with Cloudflare's outbound interception, which the drop-in refuses naming Runtime's secrets",
  },
  {
    name: "examples/authentication",
    reason: "needs Anthropic, GitHub and R2 credentials and Cloudflare's outbound interception",
  },
  {
    name: "examples/s3-mount",
    reason: "needs an R2 bucket and its keys; mountBucket is covered by unit tests",
  },
  {
    name: "examples/time-machine",
    reason: "createBackup/restoreBackup, which the drop-in refuses naming Runtime snapshots",
  },
  {
    name: "examples/vite-sandbox",
    reason: "tunnels.get (Cloudflare Tunnel), which the drop-in refuses naming exposePort",
  },
  {
    name: "examples/websocket-tunnel, collaborative-terminal",
    reason: "wsConnect and terminals over a Durable Object WebSocket, which the drop-in refuses",
  },
  {
    name: "examples/typescript-validator",
    reason: "a React app plus a second Durable Object (Compiler) and a static-assets build",
  },
  {
    name: "docs blocks with placeholder repositories (gitCheckout github.com/user/repo)",
    reason: "the repositories do not exist; tutorials/automated-testing-pipeline clones a real one",
  },
  {
    name: "docs guides/code-execution blocks 3-11",
    reason:
      "written against an API 0.12.10 does not have (context: context.id, result.output, result.formats, stream/onOutput); api/interpreter's blocks run instead",
  },
  {
    name: "docs guides/expose-services block 14",
    reason: "destructures { ports, count }, but 0.12.10's getExposedPorts returns an array",
  },
  {
    name: "docs guides/background-processes block 11",
    reason:
      "streams a running server's logs with no end; streaming-output block 7 runs the same calls",
  },
];
