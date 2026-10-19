/** Cloudflare's own Sandbox SDK examples, run the way a customer runs them:
 * each is a Worker under `wrangler dev` (local workerd) whose code imports
 * `withruntime/cloudflare` instead of `@cloudflare/sandbox`, and whose
 * getSandbox(env.Sandbox, id) reaches real Runtime sandboxes. The fixtures and
 * what each must answer are in tests/compat/cloudflare-examples.
 *
 * The Workers reach Runtime through a local relay (RUNTIME_API_URL) that only
 * adds limits to each sandbox create: at most 12 sandboxes, each capped at
 * 3 cents and ten minutes. Every sandbox the run creates is deleted at the
 * end; nothing else is touched. Nothing is deployed anywhere.
 *
 *   RUNTIME_API_KEY=... bun scripts/compatibility-cloudflare-live.ts --run
 *   [--only <name substring>] [WRANGLER=<path to a wrangler binary>]
 *
 * Wrangler defaults to `npx -y wrangler@4.147.0`. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Runtime } from "../src/client";
import {
  SKIPPED,
  SNIPPETS,
  WORKERS,
  type Answer,
  type Snippet,
  type SnippetAnswer,
  type WorkerExample,
} from "../tests/compat/cloudflare-examples/fixtures";

if (!process.argv.includes("--run")) {
  console.log(
    "Pass --run to run Cloudflare's examples as local Workers on up to 12 Runtime sandboxes, each capped at $0.03 and ten minutes.",
  );
  process.exit(0);
}
const KEY = process.env.RUNTIME_API_KEY;
if (!KEY?.startsWith("rtcloud_")) throw new Error("Set RUNTIME_API_KEY to a Runtime API key.");
const API = process.env.RUNTIME_API_URL ?? "https://api.withruntime.com";
const PACKAGE = resolve(import.meta.dir, "..");
const FIXTURES = join(PACKAGE, "tests/compat/cloudflare-examples");
/** Cloudflare's files are kept as `<name>.upstream`, so no formatter, linter or
 * type check in this repository touches them: they stay byte for byte. */
const UPSTREAM = ".upstream";
const RUN = crypto.randomUUID().slice(0, 8);
const MAX_SANDBOXES = 12;
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : undefined;

// The package the Workers import is the built one, as a customer installs it.
const build = spawnSync("bun", ["run", "build"], { cwd: PACKAGE, stdio: "inherit" });
if (build.status !== 0) throw new Error("bun run build failed");

/** Sandboxes this run created, with the example that created each. */
const created = new Map<string, string>();
let current = "";
/** Sandboxes the current request reached, from the API paths it called. */
let touched = new Set<string>();
// The relay: forwards every request to Runtime's API as it is, adding a cost
// and time cap and a run label to sandbox creates, and refusing past the cap.
const relay = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, API);
    const reached = /^\/v1\/sandboxes\/([0-9a-f-]{36})/.exec(url.pathname)?.[1];
    if (reached) touched.add(reached);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    let body: BodyInit | null = request.body;
    const creating = request.method === "POST" && url.pathname === "/v1/sandboxes";
    if (creating) {
      if (created.size >= MAX_SANDBOXES)
        return Response.json(
          { error: { code: "live_cap", message: "The live run's sandbox cap is reached." } },
          { status: 429 },
        );
      const input = (await request.json()) as Record<string, unknown>;
      body = JSON.stringify({
        ...input,
        timeoutSeconds: 600,
        maxTotalCostMicros: 30_000,
        labels: { ...(input.labels as object), "compat-run": RUN },
      });
      headers.delete("content-length");
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // @ts-expect-error Bun streams request bodies with duplex half.
      duplex: "half",
    });
    const out = new Headers(response.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    if (creating && response.ok) {
      const text = await response.text();
      const id = (JSON.parse(text) as { id?: string }).id;
      if (id && !created.has(id)) created.set(id, current);
      if (id) touched.add(id);
      return new Response(text, { status: response.status, headers: out });
    }
    return new Response(response.body, { status: response.status, headers: out });
  },
});

const wranglerCommand = process.env.WRANGLER
  ? [process.env.WRANGLER]
  : ["npx", "-y", "wrangler@4.147.0"];
let nextPort = 18787;

/** A Worker project as a customer has it: the example's files, its switched
 * wrangler.jsonc, withruntime installed, and the key in .dev.vars. */
function project(name: string, files: Record<string, string>, config: string, main: string) {
  const dir = mkdtempSync(join(tmpdir(), `runtime-cf-${name.replace(/[^a-z0-9]+/gi, "-")}-`));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    readFileSync(join(FIXTURES, config), "utf8").replace(
      '"main": "src/index.ts"',
      `"main": "${main}"`,
    ),
  );
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(PACKAGE, join(dir, "node_modules/withruntime"), "dir");
  writeFileSync(
    join(dir, ".dev.vars"),
    `RUNTIME_API_KEY=${KEY}\nRUNTIME_API_URL=${relay.url.origin}\n`,
  );
  return dir;
}

async function start(dir: string) {
  const port = nextPort++;
  const [command, ...args] = wranglerCommand;
  const child = spawn(
    command!,
    [
      ...args,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(dir, ".state"),
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: dir,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  const deadline = Date.now() + 120_000;
  while (!output.includes("Ready on")) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw new Error(`wrangler dev did not start:\n${output}`);
    await Bun.sleep(200);
  }
  return { child, port, output: () => output };
}
function stop(child: ChildProcess) {
  child.kill("SIGINT");
  return new Promise<void>((done) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(force);
      done();
    });
  });
}

async function answer(response: Response): Promise<Answer> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    text,
    bytes,
    json,
  };
}

const results: { example: string; step: string; ok: boolean; detail: string; ms: number }[] = [];
function record(example: string, step: string, ok: boolean, detail: string, ms: number) {
  const ids = [...touched];
  touched = new Set();
  results.push({ example, step, ok, detail, ms });
  console.log(
    `${ok ? "pass" : "FAIL"}  ${example} | ${step} | ${ms} ms | sandbox ${ids.join(", ") || "-"}${detail ? ` | ${detail}` : ""}`,
  );
}

async function runWorker(example: WorkerExample) {
  current = example.name;
  const root = join(FIXTURES, example.dir);
  const files: Record<string, string> = {};
  files[example.main] = readFileSync(join(root, `${example.main}${UPSTREAM}`), "utf8");
  const dir = project(example.name, files, example.config, example.main);
  const server = await start(dir);
  const earlier: Answer[] = [];
  try {
    for (const step of example.steps) {
      const started = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}${step.path}`, {
          method: step.method ?? "GET",
          headers: {
            ...(step.body ? { "content-type": "application/json" } : {}),
            ...step.headers?.(earlier),
          },
          body: step.body ? JSON.stringify(step.body) : undefined,
          signal: AbortSignal.timeout(180_000),
        });
        const a = await answer(response);
        earlier.push(a);
        record(
          example.name,
          step.name,
          true,
          step.expect(a, earlier) ?? "",
          Math.round(performance.now() - started),
        );
      } catch (error) {
        record(
          example.name,
          step.name,
          false,
          String(error),
          Math.round(performance.now() - started),
        );
        console.log(server.output().slice(-3000));
      }
    }
  } finally {
    await stop(server.child);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One Worker with a route per docs fragment: the fragment's own import is
 * hoisted, `console` is captured, and the route answers what it logged and
 * returned or threw (or the Response it returned, logs in a header). */
function snippetWorker(snippets: Snippet[]) {
  const names = new Set<string>(["getSandbox"]);
  const routes = snippets.map((s) => {
    const text = readFileSync(join(FIXTURES, "docs/snippets", `${s.file}${UPSTREAM}`), "utf8");
    const body = text
      .split("\n")
      .filter((line) => {
        const m = /^import \{([^}]*)\} from "withruntime\/cloudflare";$/.exec(line);
        if (!m) return true;
        for (const n of m[1]!.split(",")) {
          const name = n.trim().replace(/^type\s+/, "");
          if (name && !n.trim().startsWith("type ")) names.add(name);
        }
        return false;
      })
      .join("\n");
    const sandbox = /const sandbox = getSandbox/.test(body)
      ? ""
      : 'const sandbox = getSandbox(env.Sandbox, "my-sandbox");';
    // The route body is the fragment between the reader's setup and a read-back.
    return `  ${JSON.stringify("/" + s.file)}: async (request, env, console) => {\n${s.prelude?.includes("const sandbox") ? "" : sandbox}\n${s.prelude ?? ""}\n{\n${body}\n${s.after ?? ""}\n}\n},`;
  });
  return `import { ${[...names].join(", ")} } from "withruntime/cloudflare";
export { Sandbox } from "withruntime/cloudflare";
const routes = {
${routes.join("\n")}
};
export default {
  async fetch(request, env) {
    const logs = [];
    const line = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    const console = { log: line, error: line, warn: line, info: line };
    const route = routes[new URL(request.url).pathname];
    if (!route) return new Response("no route", { status: 404 });
    try {
      const returned = await route(request, env, console);
      if (returned instanceof Response) {
        const headers = new Headers(returned.headers);
        headers.set("x-logs", encodeURIComponent(JSON.stringify(logs)));
        return new Response(returned.body, { status: returned.status, headers });
      }
      return Response.json({ logs, returned });
    } catch (error) {
      return Response.json({ logs, error: { name: error?.name, message: error?.message, code: error?.code } }, { status: 500 });
    }
  },
};
`;
}

async function runSnippets(snippets: Snippet[]) {
  current = "docs snippets";
  const dir = project(
    "docs-snippets",
    { "src/index.js": snippetWorker(snippets) },
    "minimal/wrangler.jsonc",
    "src/index.js",
  );
  const server = await start(dir);
  try {
    for (const s of snippets) {
      const started = performance.now();
      const name = `docs ${s.file.replace(/-(\d+)\.js$/, " block $1")}`;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/${s.file}`, {
          signal: AbortSignal.timeout(180_000),
        });
        const header = response.headers.get("x-logs");
        const a = (await answer(response)) as SnippetAnswer;
        const parsed = (a.json ?? {}) as Partial<SnippetAnswer>;
        a.logs = header
          ? (JSON.parse(decodeURIComponent(header)) as string[])
          : (parsed.logs ?? []);
        if (!header) {
          a.error = parsed.error;
          a.returned = parsed.returned;
        }
        record(current, name, true, s.expect(a) ?? "", Math.round(performance.now() - started));
      } catch (error) {
        record(current, name, false, String(error), Math.round(performance.now() - started));
      }
    }
  } finally {
    await stop(server.child);
    rmSync(dir, { recursive: true, force: true });
  }
}

const runtime = new Runtime({ apiKey: KEY, baseUrl: API });
const deleted = new Set<string>();
/** Deletes what the run made so far, so one example's sandboxes run at a time. */
async function sweep() {
  for (const id of created.keys())
    if (!deleted.has(id))
      await runtime.sandboxes.delete(id).then(
        () => deleted.add(id),
        (error: unknown) => console.log(`could not delete ${id}: ${String(error)}`),
      );
}
try {
  for (const example of WORKERS)
    if (!only || example.name.includes(only)) {
      await runWorker(example);
      await sweep();
    }
  const snippets = SNIPPETS.filter(
    (s) => !only || s.file.includes(only) || "docs snippets".includes(only),
  );
  if (snippets.length) await runSnippets(snippets);
} finally {
  void relay.stop(true);
  await sweep();
  // A backstop: anything else carrying this run's label (only this run's creates do).
  const swept = await runtime.sandboxes.deleteAll({ labels: { "compat-run": RUN } });
  console.log(
    `\n${created.size} sandboxes created, all deleted${swept.failed.length ? `; ${swept.failed.length} failed to delete` : ""}.`,
  );
}
for (const s of SKIPPED) console.log(`skip  ${s.name}: ${s.reason}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
if (failed.length) process.exit(1);
