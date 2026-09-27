import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRoute, routeFor } from "../src/proxy";
import { RuntimeError } from "../src/errors";

/* The SDK and the CLI behind an egress proxy, on Node and on Bun. A real
   HTTPS API (a throwaway certificate, trusted through NODE_EXTRA_CA_CERTS) and
   a real CONNECT proxy that records every tunnel it is asked for. The API is
   addressed as api.runtime.test, a name that resolves nowhere, so only the
   proxy can reach it: a call that succeeds went through the proxy. Each case
   runs the SDK in a child process with nothing in its environment but what
   the case sets, so a proxy on the machine running the tests changes
   nothing. */

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
  await writeFile(
    join(dir, "driver.mjs"),
    `import { Runtime } from "./sdk/index.js";
const [baseUrl, socket] = process.argv.slice(2);
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

async function sdk(runtime: string, baseUrl: string, env: Record<string, string>, socket = false) {
  const result = await child(runtime, ["driver.mjs", baseUrl, ...(socket ? ["ws"] : [])], env);
  const line = result.stdout.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as {
      ok: boolean;
      orgId?: string;
      echoed?: string | null;
      code?: string;
      message?: string;
      hint?: string;
    };
  } catch {
    throw new Error(`The driver printed no result: ${result.stdout}\n${result.stderr}`);
  }
}

describe.each(["node", "bun"])("behind a proxy, on %s", (name) => {
  const runtime = () => (name === "node" ? node! : process.execPath);

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
    // Without the exemption the same address goes through the proxy.
    const proxied = await sdk(runtime(), `https://localhost:${api.port}`, {
      https_proxy: `http://127.0.0.1:${proxyPort}`,
    });
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

describe("which proxy an address uses", () => {
  test("lower case wins over upper case, as curl reads them", () => {
    expect(
      routeFor("https://api.withruntime.com", {
        https_proxy: "http://lower:1",
        HTTPS_PROXY: "http://upper:2",
      }),
    ).toEqual({ proxy: "http://lower:1", shown: "http://lower:1", variable: "https_proxy" });
    expect(routeFor("https://api.withruntime.com", { HTTPS_PROXY: "http://upper:2" })).toEqual({
      proxy: "http://upper:2",
      shown: "http://upper:2",
      variable: "HTTPS_PROXY",
    });
  });

  test("HTTP_PROXY is for http:// addresses only, and an HTTPS failure says it was not used", () => {
    expect(routeFor("http://localhost:8080", { HTTP_PROXY: "proxy:3128" })).toMatchObject({
      proxy: "http://proxy:3128",
      variable: "HTTP_PROXY",
    });
    const env = { HTTP_PROXY: "http://proxy:3128" };
    expect(routeFor("https://api.withruntime.com", env)).toEqual({ httpOnly: "HTTP_PROXY" });
    expect(describeRoute("https://api.withruntime.com", new Error("x"), env)).toEqual({
      via: " (directly: no HTTPS proxy is set)",
      hint: "HTTP_PROXY is set but HTTPS_PROXY is not, and api.withruntime.com is HTTPS. Set HTTPS_PROXY to the proxy to use it.",
    });
    expect(routeFor("wss://api.withruntime.com/v1/x", { HTTPS_PROXY: "http://p:1" }).proxy).toBe(
      "http://p:1",
    );
  });

  test("NO_PROXY: a name covers its subdomains, a leading dot, a port, and *", () => {
    const route = (list: string, target = "https://api.withruntime.com") =>
      routeFor(target, { HTTPS_PROXY: "http://p:1", NO_PROXY: list });
    expect(route("withruntime.com").exempt).toBe("withruntime.com");
    expect(route(".withruntime.com").exempt).toBe(".withruntime.com");
    expect(route("API.WithRuntime.com").exempt).toBe("api.withruntime.com");
    expect(route("localhost api.withruntime.com:443").exempt).toBe("api.withruntime.com:443");
    expect(route("*").exempt).toBe("*");
    expect(route("api.withruntime.com:8443").proxy).toBe("http://p:1");
    expect(route("runtime.com").proxy).toBe("http://p:1");
    expect(route("otherwithruntime.com").proxy).toBe("http://p:1");
    expect(route("").proxy).toBe("http://p:1");
    expect(routeFor("https://x.io", { HTTPS_PROXY: "http://p:1", no_proxy: "x.io" })).toEqual({
      exempt: "x.io",
      variable: "no_proxy",
    });
  });

  test("a proxy Runtime cannot speak to is refused by name, not retried", async () => {
    let error: unknown;
    try {
      routeFor("https://api.withruntime.com", { HTTPS_PROXY: "socks5://user:pw@proxy:1080" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("invalid_proxy");
    expect((error as RuntimeError).message).toBe(
      "HTTPS_PROXY (socks5://proxy:1080) is not an HTTP proxy; Runtime connects through http:// and https:// proxies.",
    );
    /* Through a client it fails at once: retrying cannot change a variable.
       In a process of its own, because Bun 1.4 carries a deleted HTTPS_PROXY
       into the next file a --parallel worker runs, and four other files
       then failed on this proxy (26 September 2026). */
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Runtime } = await import(${JSON.stringify(join(import.meta.dir, "../src/index.ts"))});
         const started = performance.now();
         const code = await new Runtime({ apiKey: "rk", baseUrl: "https://${HOST}", maxRetries: 4 })
           .me()
           .then(() => "none", (error) => error.code);
         console.log(JSON.stringify({ code, ms: performance.now() - started }));`,
      ],
      { env: { ...process.env, HTTPS_PROXY: "socks5://proxy:1080" }, stdout: "pipe" },
    );
    const { code, ms } = JSON.parse(await new Response(child.stdout).text()) as {
      code: string;
      ms: number;
    };
    expect(code).toBe("invalid_proxy");
    expect(ms).toBeLessThan(200);
  });
});
