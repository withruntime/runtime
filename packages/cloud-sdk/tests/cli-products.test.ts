import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

/* The CLI's product verbs against a stub API: what each sends, and what a
   person or a script gets back. */

const SANDBOX = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
const INFO = {
  id: SANDBOX,
  kind: "sandbox",
  state: "running",
  status: "active",
  labels: {},
  createdAt: "2026-09-22T00:00:00Z",
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

async function withStub(
  routes: (method: string, path: string, body: unknown, request: Request) => unknown,
  work: (lines: string[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const answer = await routes(
      request.method,
      url.pathname,
      text ? JSON.parse(text) : undefined,
      request,
    );
    if (answer instanceof Response) return answer;
    if (answer === undefined)
      return Response.json(
        { error: { code: "route_not_found", message: url.pathname } },
        { status: 404 },
      );
    return Response.json(answer);
  }) as typeof fetch;
  const lines: string[] = [];
  try {
    await work(lines);
  } finally {
    globalThis.fetch = original;
  }
}
const env = { RUNTIME_API_KEY: "rk_cli", RUNTIME_API_URL: "https://api.example.test" };
const out = (lines: string[], json = false) => ({
  json,
  write: (t: string) => lines.push(t),
  error: (t: string) => lines.push(`ERR ${t}`),
});

test("image build sends a folder as the context, as docker build does, and prints the id", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-cli-"));
  const original = globalThis.fetch;
  try {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app", "main.py"), "print(1)\n");
    await writeFile(join(root, "requirements.txt"), "pandas\n");
    await writeFile(join(root, "notes.log"), "left out\n");
    await writeFile(join(root, ".dockerignore"), "*.log\n");
    await writeFile(
      join(root, "Dockerfile"),
      "FROM python:3.12-slim\nCOPY requirements.txt /tmp/\nCOPY --chown=1000 app /app\nRUN pip install -r /tmp/requirements.txt\n",
    );
    let sent: {
      dockerfile?: string;
      name?: string;
      tags?: string[];
      cache?: boolean;
      context?: { files: { path: string }[]; archive: { chunks: string[] } };
      dockerignore?: string;
    } = {};
    const uploaded: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/images/context/missing")
        return Response.json({
          missing: ((await request.json()) as { digests: string[] }).digests,
        });
      if (path.startsWith("/v1/images/context/")) {
        uploaded.push(path.split("/").at(-1)!);
        return Response.json({ sha256: "x", size: 1, stored: true });
      }
      if (request.method === "POST" && path === "/v1/images") {
        sent = (await request.json()) as typeof sent;
        return Response.json({ id: "img-1", state: "queued" });
      }
      if (path === "/v1/images/img-1/logs")
        return Response.json({
          lines: [],
          nextAfter: 0,
          state: "ready",
          truncated: false,
          done: true,
        });
      if (path === "/v1/images/img-1") return Response.json({ id: "img-1", state: "ready" });
      return Response.json({ error: { code: "route_not_found", message: path } }, { status: 404 });
    }) as typeof fetch;
    const lines: string[] = [];
    expect(
      await run(
        ["image", "build", root, "-t", "py:v1", "-t", "py:latest", "--no-cache"],
        env,
        out(lines),
      ),
    ).toBe(0);
    expect(lines.at(-1)).toBe("img-1");
    expect(sent).toMatchObject({ name: "py", tags: ["v1", "latest"], cache: false });
    expect(sent.dockerfile).toContain("FROM python:3.12-slim");
    expect(sent.dockerignore).toBe("*.log\n");
    expect(sent.context!.files.map((f) => f.path).sort()).toEqual([
      ".dockerignore",
      "Dockerfile",
      "app/main.py",
      "requirements.txt",
    ]);
    expect(uploaded).toEqual(sent.context!.archive.chunks);
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("image registry set reads the secret from standard input and never echoes it", async () => {
  let sent: unknown;
  await withStub(
    (method, path, body) => {
      if (method === "POST" && path === "/v1/images/registries") {
        sent = body;
        return { id: "r", registry: "ghcr.io", kind: "basic", username: "me", createdAt: "t" };
      }
    },
    async (lines) => {
      const { imageCommand } = await import("../src/cli");
      expect(
        await imageCommand(
          ["registry", "set", "ghcr.io", "--username", "me"],
          env,
          out(lines),
          async () => "ghp_secret",
        ),
      ).toBe(0);
      expect(lines.join("\n")).not.toContain("ghp_secret");
      expect(lines.at(-1)).toBe("Stored credentials for ghcr.io (me).");
    },
  );
  expect(sent).toEqual({ registry: "ghcr.io", username: "me", password: "ghp_secret" });
});

test("image build refuses two sources, and a recipe needs none", async () => {
  let sent: unknown;
  await withStub(
    (method, path, body) => {
      if (method === "POST" && path === "/v1/images") {
        sent = body;
        return { id: "img-2", state: "ready" };
      }
      if (path === "/v1/images/img-2") return { id: "img-2", state: "ready" };
    },
    async (lines) => {
      await expect(
        run(["image", "build", "--from", "python:3.12", "--pip", "pandas"], env, out(lines)),
      ).rejects.toThrow("exactly one");
      expect(
        await run(
          ["image", "build", "--pip", "pandas,numpy", "--apt", "jq"],
          env,
          out(lines, true),
        ),
      ).toBe(0);
    },
  );
  expect(sent).toEqual({ recipe: { apt: ["jq"], pip: ["pandas", "numpy"] } });
});

test("volume create warns once, and sandbox create attaches it with an image and rules", async () => {
  let created: Record<string, unknown> = {};
  await withStub(
    (method, path, body) => {
      if (method === "POST" && path === "/v1/volumes")
        return { id: "vol-1", state: "ready", attachments: [] };
      if (method === "POST" && path === "/v1/sandboxes") {
        created = body as Record<string, unknown>;
        return INFO;
      }
    },
    async (lines) => {
      expect(await run(["volume", "create", "--size-mib", "1024"], env, out(lines))).toBe(0);
      // Volumes are backed up daily off their server now; nothing to warn about.
      expect(lines).toEqual(["vol-1"]);
      expect(
        await run(
          [
            "sandbox",
            "create",
            "--image",
            "img-1",
            "--volume",
            "vol-1:/data",
            "--volume",
            "vol-2:/seed:snapshot",
            "--no-internet",
          ],
          env,
          out(lines),
        ),
      ).toBe(0);
      expect(lines.at(-1)).toBe(SANDBOX);
    },
  );
  expect(created).toMatchObject({
    image: "img-1",
    volumes: [
      { volumeId: "vol-1", path: "/data", mode: "rw" },
      { volumeId: "vol-2", path: "/seed", mode: "snapshot" },
    ],
    network: { internet: false },
  });
});

test("run-code streams, prints text results and saves charts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-cli-"));
  try {
    const cell = join(root, "cell.py");
    await writeFile(cell, "1 + 1\n");
    await withStub(
      (method, path) => {
        if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) return INFO;
        if (path === `/v1/sandboxes/${SANDBOX}/interpreter:run`)
          return new Response(
            [
              { k: "stdout", text: "working\n" },
              {
                k: "execution",
                execution: {
                  id: "e1",
                  status: "ok",
                  executionCount: 1,
                  results: [
                    { main: false, data: { "image/png": PNG }, refs: {} },
                    { main: true, data: { "text/plain": "2" }, refs: {} },
                  ],
                  error: null,
                },
              },
            ]
              .map((e) => JSON.stringify(e))
              .join("\n") + "\n",
            { headers: { "content-type": "application/x-ndjson" } },
          );
      },
      async (lines) => {
        const code = await run(
          ["sandbox", "run-code", SANDBOX, cell, "--out-dir", root],
          env,
          out(lines),
        );
        expect(code).toBe(0);
        expect(lines).toContain("2");
        expect(lines.some((l) => l.startsWith("Saved ") && l.endsWith("result-1-1.png"))).toBe(
          true,
        );
      },
    );
    expect((await readFile(join(root, "result-1-1.png"))).subarray(0, 4)).toEqual(
      Buffer.from(PNG, "base64"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previews and network rules from the sandbox command", async () => {
  let rules: unknown;
  await withStub(
    (method, path, body) => {
      if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) return INFO;
      if (method === "POST" && path === `/v1/sandboxes/${SANDBOX}/previews`)
        return {
          port: 3000,
          visibility: "public",
          url: "https://3000-x.preview.example/",
          token: null,
        };
      if (method === "PUT" && path === `/v1/sandboxes/${SANDBOX}/network`) {
        rules = body;
        return {
          internet: true,
          allow: ["pypi.org"],
          deny: [],
          connect: [],
          enforced: true,
        };
      }
    },
    async (lines) => {
      expect(await run(["sandbox", "preview", SANDBOX, "3000", "--public"], env, out(lines))).toBe(
        0,
      );
      expect(lines.at(-1)).toBe("https://3000-x.preview.example/");
      expect(
        await run(["sandbox", "network", SANDBOX, "--allow", "pypi.org"], env, out(lines)),
      ).toBe(0);
      expect(lines.at(-1)).toContain("pypi.org");
    },
  );
  expect(rules).toEqual({ internet: true, allow: ["pypi.org"] });
});

test("preview rotate refuses a private port's earlier tokens and prints the new one", async () => {
  const calls: string[] = [];
  await withStub(
    (method, path) => {
      calls.push(`${method} ${path}`);
      if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) return INFO;
      if (method === "POST" && path === `/v1/sandboxes/${SANDBOX}/previews/3000:rotate`)
        return {
          port: 3000,
          visibility: "private",
          url: "https://3000-x.preview.example/",
          urlWithToken: "https://3000-x.preview.example/?runtime_preview_token=tok2",
          token: "tok2",
          tokenExpiresAt: "2026-09-26T00:00:00Z",
        };
    },
    async (lines) => {
      expect(await run(["sandbox", "preview", "rotate", SANDBOX, "3000"], env, out(lines))).toBe(0);
      expect(lines.at(-1)).toContain("Every earlier token for port 3000 is refused.");
      expect(lines.at(-1)).toContain("x-runtime-preview-token: tok2");
    },
  );
  expect(calls).toContain(`POST /v1/sandboxes/${SANDBOX}/previews/3000:rotate`);
  expect(calls.some((c) => c.endsWith("/previews"))).toBe(false);
});

test("preview rotate on a public port says there was no token to refuse", async () => {
  await withStub(
    (method, path) => {
      if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) return INFO;
      if (method === "POST" && path === `/v1/sandboxes/${SANDBOX}/previews/8080:rotate`)
        return { port: 8080, visibility: "public", url: "https://8080-x.preview.example/" };
    },
    async (lines) => {
      expect(await run(["sandbox", "preview", "rotate", SANDBOX, "8080"], env, out(lines))).toBe(0);
      expect(lines.at(-1)).toBe(
        "Port 8080 is public: it takes no token, so there was none to refuse.",
      );
    },
  );
});

test("a port that is not a port is a usage error before any call", async () => {
  const calls: string[] = [];
  await withStub(
    (method, path) => {
      calls.push(`${method} ${path}`);
      return INFO;
    },
    async (lines) => {
      for (const argv of [
        ["sandbox", "preview", "rotate", SANDBOX, "http"],
        ["sandbox", "preview", "rotate", SANDBOX],
        ["sandbox", "preview", SANDBOX, "70000"],
        ["sandbox", "unshare", SANDBOX, "30.5"],
      ]) {
        await expect(run(argv, env, out(lines))).rejects.toMatchObject({
          code: "usage",
          message: expect.stringMatching(/port/),
        });
      }
    },
  );
  expect(calls).toEqual([]);
});

test("the desktop from the sandbox command saves a screenshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "rt-cli-"));
  try {
    await withStub(
      (method, path) => {
        if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) return INFO;
        if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}/desktop/screenshot`)
          return new Response(Buffer.from(PNG, "base64"), {
            headers: { "content-type": "image/png" },
          });
        if (method === "POST" && path === `/v1/sandboxes/${SANDBOX}/desktop:act`)
          return { ok: true };
      },
      async (lines) => {
        const file = join(root, "screen.png");
        expect(
          await run(["sandbox", "desktop", SANDBOX, "screenshot", file], env, out(lines)),
        ).toBe(0);
        expect(
          await run(["sandbox", "desktop", SANDBOX, "click", "10", "20"], env, out(lines)),
        ).toBe(0);
        expect((await readFile(file)).subarray(0, 4)).toEqual(Buffer.from(PNG, "base64"));
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a mistyped command names the one that was meant, and points at its product's help", async () => {
  await expect(run(["sandboxs", "ls"], env, out([]))).rejects.toMatchObject({
    message: "Unknown command sandboxs. Did you mean sandbox?",
    hint: "Run `runtime help`.",
  });
  await expect(run(["image", "biuld"], env, out([]))).rejects.toMatchObject({
    message: "Unknown image command biuld. Did you mean build?",
    hint: "Run `runtime image help`.",
  });
  await expect(run(["acount"], env, out([]))).rejects.toMatchObject({
    message: "Unknown command acount. Did you mean account?",
  });
  await expect(run(["audt"], env, out([]))).rejects.toMatchObject({
    message: "Unknown command audt. Did you mean audit?",
  });
  await expect(run(["sandbox", "exec", SANDBOX], env, out([]))).rejects.toMatchObject({
    message: "Give the command after --: runtime sandbox exec <id> -- ls -la",
  });
});

test("run surfaces failed cleanup instead of returning success", async () => {
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "42\n", stderr: "", exitCode: 0, timedOut: false };
      if (path === `/v1/sandboxes/${SANDBOX}:stop`)
        return Response.json(
          { error: { code: "permission_denied", message: "Stop refused" } },
          { status: 403 },
        );
    },
    async (lines) => {
      expect(
        await run(["sandbox", "run", "--json", "--", "echo", "42"], env, out(lines, true)),
      ).toBe(1);
      expect(lines.join("\n")).toContain("cleanup_failed");
      expect(lines.join("\n")).toContain(`sandbox stop ${SANDBOX}`);
    },
  );
});

test("run waits for stopped state after cleanup is accepted", async () => {
  let waited = false;
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (path === `/v1/sandboxes/${SANDBOX}:stop`) return { ...INFO, state: "stopping" };
      if (method === "GET" && path === `/v1/sandboxes/${SANDBOX}`) {
        waited = true;
        return { ...INFO, state: "stopped" };
      }
    },
    async (lines) => {
      expect(await run(["sandbox", "run", "--", "true"], env, out(lines, true))).toBe(0);
      expect(waited).toBe(true);
    },
  );
});

test("run preserves a failed command's exit code while reporting cleanup failure", async () => {
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "", stderr: "command failed", exitCode: 7, timedOut: false };
      if (path === `/v1/sandboxes/${SANDBOX}:stop`)
        return Response.json(
          { error: { code: "permission_denied", message: "Stop refused" } },
          { status: 403 },
        );
    },
    async (lines) => {
      expect(await run(["sandbox", "run", "--", "false"], env, out(lines, true))).toBe(7);
      expect(lines.join("\n")).toContain("cleanup_failed");
    },
  );
});

test("run preserves execution errors and still attempts cleanup", async () => {
  let stopped = false;
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return Response.json(
          { error: { code: "execution_failed", message: "Exec failed" } },
          { status: 500 },
        );
      if (path === `/v1/sandboxes/${SANDBOX}:stop`) {
        stopped = true;
        return Response.json(
          { error: { code: "permission_denied", message: "Stop refused" } },
          { status: 403 },
        );
      }
    },
    async (lines) => {
      await expect(
        run(["sandbox", "run", "--", "true"], env, out(lines, true)),
      ).rejects.toMatchObject({
        code: "execution_failed",
      });
      expect(stopped).toBe(true);
      expect(lines.join("\n")).toContain("cleanup_failed");
    },
  );
});

test("run refuses to report cleanup success when the wait returns stopping", async () => {
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (path === `/v1/sandboxes/${SANDBOX}:stop` || path === `/v1/sandboxes/${SANDBOX}`)
        return { ...INFO, state: "stopping" };
    },
    async (lines) => {
      expect(await run(["sandbox", "run", "--", "true"], env, out(lines, true))).toBe(1);
      expect(lines.join("\n")).toContain("still stopping");
    },
  );
});

test("run retries a temporary stop failure, and keep leaves its sandbox alone", async () => {
  let stops = 0;
  await withStub(
    (method, path) => {
      if (method === "POST" && path === "/v1/sandboxes") return INFO;
      if (path === `/v1/sandboxes/${SANDBOX}:exec`)
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      if (path === `/v1/sandboxes/${SANDBOX}:stop`) {
        stops++;
        return stops === 1
          ? Response.json(
              { error: { code: "temporarily_unavailable", message: "Retry" } },
              { status: 503 },
            )
          : { ...INFO, state: "stopped" };
      }
    },
    async (lines) => {
      expect(await run(["sandbox", "run", "--", "true"], env, out(lines, true))).toBe(0);
      expect(stops).toBe(2);
      expect(await run(["sandbox", "run", "--keep", "--", "true"], env, out(lines, true))).toBe(0);
      expect(stops).toBe(2);
      expect(lines.join("\n")).toContain(`Kept sandbox ${SANDBOX}`);
    },
  );
});

test("Ctrl-C stops only its own sandbox once and exits 130 during concurrent completion", async () => {
  let execStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    execStarted = resolve;
  });
  let completeExec: ((response: Response) => void) | undefined;
  let stops = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/sandboxes") return Response.json(INFO);
      if (path === `/v1/sandboxes/${SANDBOX}:exec`) {
        execStarted();
        return new Promise<Response>((resolve) => {
          completeExec = resolve;
        });
      }
      if (path === `/v1/sandboxes/${SANDBOX}:stop`) {
        stops++;
        completeExec?.(Response.json({ stdout: "", stderr: "", exitCode: 0, timedOut: false }));
        return Response.json({ ...INFO, state: "stopped" });
      }
      return new Response(null, { status: 404 });
    },
  });
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../src/cli.ts", import.meta.url).pathname,
      "sandbox",
      "run",
      "--json",
      "--",
      "true",
    ],
    {
      env: { ...process.env, ...env, RUNTIME_API_URL: `http://127.0.0.1:${server.port}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 4000);
  try {
    await Promise.race([
      started,
      child.exited.then(() => {
        throw new Error("CLI exited before exec started");
      }),
    ]);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(stops).toBe(1);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
    completeExec?.(new Response(null, { status: 500 }));
    await server.stop(true);
  }
});

test("run cleanup's absolute deadline cancels a stop that never answers", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    originalTimeout(ms === 30_000 ? 10 : ms),
  );
  let cancelled = false;
  try {
    await withStub(
      (method, path, _body, request) => {
        if (method === "POST" && path === "/v1/sandboxes") return INFO;
        if (path === `/v1/sandboxes/${SANDBOX}:exec`)
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        if (path === `/v1/sandboxes/${SANDBOX}:stop`)
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("Stop request aborted"));
              },
              { once: true },
            );
          });
      },
      async (lines) => {
        expect(await run(["sandbox", "run", "--", "true"], env, out(lines, true))).toBe(1);
        expect(cancelled).toBe(true);
        expect(lines.join("\n")).toContain("cleanup_failed");
      },
    );
  } finally {
    timeout.mockRestore();
  }
});
