import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The SDK and the CLI behind an egress proxy, on Node and on Bun. A real
   HTTPS API (a throwaway certificate, trusted through NODE_EXTRA_CA_CERTS) and
   a real CONNECT proxy that records every tunnel it is asked for. The API is
   addressed as api.runtime.test, a name that resolves nowhere, so only the
   proxy can reach it: a call that succeeds went through the proxy. Each case
   runs the SDK in a child process with nothing in its environment but what
   the case sets, so a proxy on the machine running the tests changes
   nothing. End to end (Node and Bun processes, a certificate made by
   openssl, 1.7 s), so on main's check (.runtime/e2e-files.sh); which proxy an
   address uses is tests/proxy.test.ts. */

const HOST = "api.runtime.test";
let dir: string;
let api: ReturnType<typeof Bun.serve>;
let proxy: Server;
let proxyPort: number;
let closedPort: number;
let refuse = false;
const tunnels: { target: string; auth: string | null }[] = [];
const node = Bun.which("node");

function openssl(args: string[]) {
  const result = Bun.spawnSync(["openssl", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
}

beforeAll(async () => {
  if (!node) throw new Error("These tests run the SDK under Node too: put node on PATH.");
  dir = await mkdtemp(join(tmpdir(), "runtime-proxy-"));
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-days",
    "2",
    "-subj",
    `/CN=${HOST}`,
    "-addext",
    `subjectAltName=DNS:${HOST},DNS:localhost`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: Bun.file(join(dir, "cert.pem")), key: Bun.file(join(dir, "key.pem")) },
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/echo" && server.upgrade(request, { data: undefined }))
        return undefined;
      if (url.pathname === "/v1/me")
        return Response.json({
          orgId: "org-proxy",
          principalId: "agent-proxy",
          credentialId: null,
          apiVersion: "test",
        });
      if (url.pathname === "/api/connect/start") {
        const origin = request.headers.get("host")!;
        return Response.json({
          verificationUri: `https://${origin}/connect?code=ABCD-EF01-2345`,
          deviceCode: "d".repeat(43),
          userCode: "ABCD-EF01-2345",
          expiresAt: Date.now() + 600_000,
        });
      }
      return Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        socket.send(`echo ${String(message)}`);
      },
    },
  });
  proxy = createServer((client: Socket) => {
    client.once("data", (chunk: Buffer) => {
      const head = chunk.toString("latin1");
      const [method, target] = head.split(" ");
      const auth = /^proxy-authorization: *(.+)$/im.exec(head)?.[1]?.trim() ?? null;
      tunnels.push({ target: `${method} ${target}`, auth });
      if (refuse) return void client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      if (method !== "CONNECT") return void client.end("HTTP/1.1 405 CONNECT only\r\n\r\n");
      const [host, port] = target!.split(":");
      const upstream = connect(Number(port), host === HOST ? "127.0.0.1" : host!, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxy.address() as { port: number }).port;
  // A port nothing listens on: bind one, note it, close it.
  const spare = createServer();
  await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
  closedPort = (spare.address() as { port: number }).port;
  await new Promise<void>((resolve) => spare.close(() => resolve()));
  // The SDK as a customer's Node or Bun process loads it: bundled, undici and all.
  for (const entry of ["index", "cli"]) {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, `../src/${entry}.ts`)],
      target: "node",
      format: "esm",
      outdir: join(dir, "sdk"),
    });
    if (!built.success) throw new Error(built.logs.map((log) => log.message).join("\n"));
  }
  /* One process per runtime serves every case: a line in names a case's
     address and environment, a line out is its result. A process each took
     80 ms to start, fourteen of them most of the file's 2.2 s (24 October
     2026). The proxy variables are read at each call, so a case sets them. */
  await writeFile(
    join(dir, "driver.mjs"),
    `import { createInterface } from "node:readline";
import { Runtime } from "./sdk/index.js";
for await (const line of createInterface({ input: process.stdin })) {
  const { baseUrl, socket, env } = JSON.parse(line);
  for (const name of Object.keys(process.env)) if (/_proxy$/i.test(name)) delete process.env[name];
  Object.assign(process.env, env);
  const runtime = new Runtime({ apiKey: "rtcloud_test", baseUrl, maxRetries: 0 });
  try {
    const me = await runtime.me();
    let echoed = null;
    if (socket) {
      const ws = await runtime.transport.websocket("/v1/echo");
      echoed = await new Promise((resolve, reject) => {
        ws.onopen = () => ws.send("hi");
        ws.onmessage = (event) => { resolve(String(event.data)); ws.close(); };
        ws.onerror = (event) => reject(new Error(event.message ?? "websocket error"));
      });
    }
    console.log(JSON.stringify({ ok: true, orgId: me.orgId, echoed }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code, message: error.message, hint: error.hint }));
  }
}
`,
  );
}, 60_000);

afterAll(async () => {
  await api?.stop(true);
  proxy?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Runs a script from the bundle under a runtime with only `env` set. */
async function child(runtime: string, args: string[], env: Record<string, string>) {
  const run = Bun.spawn([runtime, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  return { code: await run.exited, stdout, stderr };
}

type Result = {
  ok: boolean;
  orgId?: string;
  echoed?: string | null;
  code?: string;
  message?: string;
  hint?: string;
};

/** A driver process under `runtime`, started with `env`, and how to ask it a case. */
function driver(runtime: string, env: Record<string, string> = {}) {
  const run = Bun.spawn([runtime, "driver.mjs"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      NODE_EXTRA_CA_CERTS: join(dir, "cert.pem"),
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const lines = run.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  async function next(): Promise<string> {
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        return line;
      }
      const { value, done } = await lines.read();
      if (done) throw new Error(`The driver ended with no result: ${buffer}`);
      buffer += value;
    }
  }
  return {
    async ask(baseUrl: string, env: Record<string, string>, socket = false) {
      void run.stdin.write(JSON.stringify({ baseUrl, env, socket }) + "\n");
      void run.stdin.flush();
      return JSON.parse(await next()) as Result;
    },
    stop: () => run.kill(),
  };
}

describe.each(["node", "bun"])("behind a proxy, on %s", (name) => {
  const runtime = () => (name === "node" ? node! : process.execPath);
  let cases: ReturnType<typeof driver>;
  beforeAll(() => void (cases = driver(runtime())));
  afterAll(() => cases?.stop());
  const sdk = (_: string, baseUrl: string, env: Record<string, string>, socket = false) =>
    cases.ask(baseUrl, env, socket);

  test("calls and the terminal's WebSocket go through HTTPS_PROXY, credentials and all", async () => {
    tunnels.length = 0;
    refuse = false;
    const result = await sdk(
      runtime(),
      `https://${HOST}:${api.port}`,
      { HTTPS_PROXY: `http://agent:pa%40ss@127.0.0.1:${proxyPort}` },
      true,
    );
    expect(result).toEqual({ ok: true, orgId: "org-proxy", echoed: "echo hi" });
    expect(tunnels.length).toBeGreaterThanOrEqual(2);
    for (const tunnel of tunnels) {
      expect(tunnel.target).toBe(`CONNECT ${HOST}:${api.port}`);
      expect(tunnel.auth).toBe(`Basic ${Buffer.from("agent:pa@ss").toString("base64")}`);
    }
  });

  test("a host NO_PROXY lists connects directly, and the proxy sees nothing", async () => {
    tunnels.length = 0;
    refuse = false;
    const result = await sdk(
      runtime(),
      `https://localhost:${api.port}`,
      { https_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "example.com, localhost" },
      true,
    );
    expect(result).toEqual({ ok: true, orgId: "org-proxy", echoed: "echo hi" });
    expect(tunnels).toEqual([]);
    // Without the exemption the same address goes through the proxy: in a
    // driver of its own, as Bun's fetch would reuse the direct connection.
    const fresh = driver(runtime());
    const proxied = await fresh
      .ask(`https://localhost:${api.port}`, { https_proxy: `http://127.0.0.1:${proxyPort}` })
      .finally(fresh.stop);
    expect(proxied.ok).toBe(true);
    expect(tunnels.map((tunnel) => tunnel.target)).toEqual([`CONNECT localhost:${api.port}`]);
  });

  test("a proxy that does not answer is named in the error, without its password", async () => {
    const result = await sdk(runtime(), `https://${HOST}:${api.port}`, {
      HTTPS_PROXY: `http://agent:secret@127.0.0.1:${closedPort}`,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("connection_error");
    expect(result.message).toBe(
      `No answer from Runtime at https://${HOST}:${api.port} through the proxy http://127.0.0.1:${closedPort} (HTTPS_PROXY).`,
    );
    expect(result.hint).toBe(
      `Check that the proxy is running and allows CONNECT to ${HOST}:${api.port}, or list ${HOST} in NO_PROXY to connect directly.`,
    );
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("a certificate this machine does not trust is said as that, never as no answer", async () => {
    // As behind a proxy that inspects TLS with its own authority, where Node
    // was not told of it (18 October 2026): the API's certificate untrusted.
    // Node reads NODE_EXTRA_CA_CERTS as it starts: a driver of its own.
    const untrusting = driver(runtime(), { NODE_EXTRA_CA_CERTS: "" });
    const result = await untrusting
      .ask(`https://${HOST}:${api.port}`, { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` })
      .finally(untrusting.stop);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("connection_error");
    expect(result.message).toMatch(
      new RegExp(
        `^Runtime at https://${HOST}:${api.port} through the proxy http://127\\.0\\.0\\.1:${proxyPort} \\(HTTPS_PROXY\\) could not be reached: the TLS certificate presented is not one this machine trusts \\([A-Z_]+\\)\\.$`,
      ),
    );
    expect(result.hint).toContain("NODE_EXTRA_CA_CERTS");
  });

  test("a proxy that refuses the tunnel for want of credentials says so", async () => {
    tunnels.length = 0;
    refuse = true;
    try {
      const result = await sdk(runtime(), `https://${HOST}:${api.port}`, {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toBe(
        `No answer from Runtime at https://${HOST}:${api.port} through the proxy http://127.0.0.1:${proxyPort} (HTTPS_PROXY), which answered HTTP 407 to the tunnel request.`,
      );
      expect(result.hint).toContain("The proxy wants credentials");
      expect(tunnels.length).toBeGreaterThan(0);
    } finally {
      refuse = false;
    }
  });

  test("`withruntime login --no-browser` reaches Runtime through the proxy", async () => {
    tunnels.length = 0;
    refuse = false;
    const origin = `https://localhost:${api.port}`;
    const result = await child(runtime(), ["sdk/cli.js", "login", "--no-browser"], {
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
      RUNTIME_API_URL: origin,
      RUNTIME_AUTH_URL: origin,
    });
    expect(`${result.stdout}${result.stderr}`).toContain(`${origin}/connect?code=ABCD-EF01-2345`);
    expect(tunnels.map((tunnel) => tunnel.target)).toContain(`CONNECT localhost:${api.port}`);
  });
});
