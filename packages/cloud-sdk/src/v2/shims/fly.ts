/* withruntime/fly: Fly's Machines API on Runtime, as a local HTTP server (`npx
   withruntime fly-api`, then point FLY_API_HOSTNAME at it) or a fetch handler. A
   machine is a sandbox: create, get, list, exec, stop (pause), start (wake), wait
   and delete; an app is a label. */

import type { Runtime, SandboxInfo } from "../../generated/index.js";
import { type RuntimeOptions, client, run } from "./base.js";

const STATE: Record<string, string> = { starting: "starting", running: "started", paused: "stopped", deleted: "destroyed", error: "failed" };

function machine(s: SandboxInfo, app: string): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name ?? s.id,
    state: STATE[s.state] ?? s.state,
    region: "us-east",
    instance_id: s.id,
    created_at: s.createdAt,
    config: { guest: { cpus: s.vcpu, memory_mb: s.memoryGB === undefined ? undefined : Math.round(s.memoryGB * 1024) }, metadata: { app } },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The Machines API's calls as a fetch handler, over `k`. */
export function machinesApi(k: Runtime): (req: Request) => Promise<Response> {
  return async (req) => {
    const u = new URL(req.url);
    const m = u.pathname.match(/^\/v1\/apps\/([^/]+)\/machines(?:\/([^/]+))?(?:\/([a-z]+))?$/);
    if (!m) return json(404, { error: "not found" });
    const [, app = "", id, action] = m;
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};
    try {
      if (!id && req.method === "POST") {
        const g = body["config"]?.["guest"] ?? {};
        const s = await k.sandboxes.create({
          ...(body["name"] ? { name: body["name"] } : {}),
          ...(body["config"]?.["image"] ? { image: body["config"]["image"] } : {}),
          ...(g.cpus ? { vcpu: g.cpus } : {}),
          ...(g.memory_mb ? { memoryGB: g.memory_mb / 1024 } : {}),
          labels: { "fly-app": app },
        });
        return json(200, machine(s.info, app));
      }
      if (!id) return json(200, (await k.sandboxes.list({ label: [`fly-app:${app}`] })).items.map((s) => machine(s, app)));
      if (!action && req.method === "GET") return json(200, machine((await k.sandboxes.get(id)).info, app));
      if (!action && req.method === "DELETE") return json(200, { ok: true, ...machine(await k.sandboxes.delete(id), app) });
      if (action === "exec") {
        const cmd = body["command"] ?? body["cmd"];
        const r = await run(k, id, cmd, { timeoutMs: body["timeout"] ? body["timeout"] * 1000 : undefined });
        return json(200, { exit_code: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr });
      }
      if (action === "stop" || action === "suspend") return json(200, { ok: true, ...machine(await k.sandboxes.pause(id), app) });
      if (action === "start") return json(200, { ok: true, ...machine(await k.sandboxes.resume(id), app) });
      if (action === "wait") {
        const want = u.searchParams.get("state") ?? "started";
        const until = Date.now() + Number(u.searchParams.get("timeout") ?? 60) * 1000;
        for (;;) {
          const s = machine((await k.sandboxes.get(id)).info, app);
          if (s["state"] === want) return json(200, { ok: true });
          if (Date.now() > until) return json(408, { error: `machine did not reach ${want}` });
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      return json(404, { error: `no ${req.method} ${action ?? ""}` });
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      return json(err.status && err.status >= 400 ? err.status : 500, { error: err.message ?? String(e), code: err.code });
    }
  };
}

/** `npx withruntime fly-api [--port 4280]`: the Machines API on localhost. */
export async function serveMachinesApi(port = 4280, o: RuntimeOptions = {}): Promise<number> {
  const { createServer } = await import("node:http");
  const handle = machinesApi(client(o));
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await handle(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, "127.0.0.1");
  process.stderr.write(`Fly Machines API on http://127.0.0.1:${port} (FLY_API_HOSTNAME=http://127.0.0.1:${port})\n`);
  return new Promise(() => undefined);
}
