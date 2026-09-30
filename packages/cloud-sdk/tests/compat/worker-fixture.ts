import { getSandbox as publishedGetSandbox } from "@compat/cloudflare-published";
import { Sandbox, getSandbox, proxyToSandbox } from "../../src/cloudflare/worker.js";
import type { DurableObjectNamespace } from "@cloudflare/workers-types/index.ts";
export { Sandbox };
export default {
  async fetch(_request: Request, env: { Sandbox: DurableObjectNamespace<Sandbox> }) {
    if (new URL(_request.url).pathname === "/preview") {
      const sb = getSandbox(env.Sandbox, "preview-agent");
      const first = await sb.exposePort(8080, { hostname: "example.test", token: "stable" });
      const second = await sb.exposePort(8080, { hostname: "example.test" });
      let duplicate = false;
      try {
        await sb.exposePort(8081, { hostname: "example.test", token: "stable" });
      } catch {
        duplicate = true;
      }
      const ports = await sb.getExposedPorts("new.example.test");
      const forwarded = await proxyToSandbox(new Request(first.url + "/hello?x=1"), env);
      const denied = await proxyToSandbox(
        new Request(first.url.replace("-stable.", "-wrong.")),
        env,
      );
      return Response.json({
        stable: first.url === second.url,
        duplicate,
        listedDomain: new URL(ports[0]!.url).hostname,
        forwarded: await forwarded!.json(),
        denied: denied!.status,
      });
    }
    const factory = new URL(_request.url).searchParams.has("published")
      ? publishedGetSandbox
      : getSandbox;
    const ids = ["", "x".repeat(64), "-bad", "bad-", "API", "workers"];
    const errors = ids.map((id) => {
      try {
        factory(env.Sandbox, id);
        return null;
      } catch (error) {
        const e = error as { message: string; code: string };
        return { message: e.message, code: e.code };
      }
    });
    const sandbox = factory(
      env.Sandbox,
      new URL(_request.url).searchParams.has("published") ? "worker-reference" : "worker-contract",
    );
    const session = await sandbox.createSession({ id: "agent", cwd: "/workspace" });
    await session.writeFile(".env", "hello");
    const read = await session.readFile(".env", { encoding: "utf8" });
    const result = await session.exec("echo hello");
    const process = await session.startProcess("echo ready");
    const exited = await process.waitForExit();
    return Response.json({
      errors,
      session: session.id,
      text: read.content,
      stdout: result.stdout,
      process: process.id,
      exitCode: exited.exitCode,
    });
  },
};
