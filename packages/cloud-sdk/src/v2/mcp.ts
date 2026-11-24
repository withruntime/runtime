/* `runtime mcp`: Runtime's MCP tools over stdio, for a client that starts a
   process rather than calling a URL. Each JSON-RPC line read is sent as is
   to the API's own MCP endpoint (POST /mcp, which serves every verb and
   shortcut the spec names) under RUNTIME_API_KEY, and its answer written
   back as one line: the tools are always the server's, never this
   package's, so a verb is a tool the moment it is live.

   With no key (none set, none saved by `runtime login`), the bridge answers
   itself with one tool, runtime_connect, which signs this computer in as
   `runtime login` does, from inside the agent; once approved, the server's
   tools are listed. 24 Nov 2026: without a key every message was refused,
   `initialize` too, so a client added before `npx withruntime login` showed
   the server as failed and nothing said what to do. */

import { createInterface } from "node:readline";
import { type LoginOptions, login, savedKey } from "./login.js";

const CONNECT = "runtime_connect";

const NOT_CONNECTED =
  "Runtime is not connected on this computer. Call runtime_connect to sign in: it returns a link and a code for the person you work for to approve in a browser, and Runtime's tools are listed once they have. With RUNTIME_API_KEY set, or after `npx withruntime login`, the server starts connected.";

const connectTool = {
  name: CONNECT,
  title: "Connect this computer to Runtime",
  description:
    "Signs this computer in to Runtime with a browser approval, with no key to copy. The first call returns a link and a code: show both to the person you work for and ask them to approve. Call it again after they have; it waits up to 45 seconds for the approval, then Runtime's tools are listed.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

/** How long a call of runtime_connect after the first waits for the approval. */
const WAIT_MS = 45_000;

type Message = { id?: unknown; method?: unknown; params?: { name?: unknown; protocolVersion?: unknown } };

/** The bridge: `handle` takes one line a client sent, and each answer goes to `write`. */
export function bridge(
  baseUrl: string,
  write: (m: unknown) => void,
  fetcher: typeof fetch = fetch,
  connect: LoginOptions = {},
): (line: string) => Promise<void> {
  const env = connect.env ?? process.env;
  let key = env["RUNTIME_API_KEY"] || undefined;
  let pending: { link: string; code: string; done: Promise<string> } | undefined;

  /** Starts a sign-in, resolved with its link and code once the API gave them; its `done` is the error, or "". */
  const begin = () =>
    new Promise<{ link: string; code: string; done: Promise<string> }>((started, failed) => {
      const said: string[] = [];
      const done = login(baseUrl, {
        fetch: fetcher,
        ...connect,
        env,
        tty: () => false,
        say: (l) => void (said.push(l), process.stderr.write(`${l}\n`)),
        started: (link, code) => started({ link, code, done }),
      }).then((code) => {
        const saved = code === 0 ? savedKey(baseUrl, env) : undefined;
        if (saved) {
          key = saved;
          write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
          return "";
        }
        pending = undefined;
        const why = said.at(-1)?.replace(/^runtime login: /, "") ?? "the sign-in ended.";
        failed(new Error(why));
        return why;
      });
    });

  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
  const ask = (p: { link: string; code: string }) =>
    `Open ${p.link} and check that the page shows the code ${p.code}, then choose Connect. Show the link and code to the person you work for. When they have approved, call runtime_connect again.`;

  async function connectCall(): Promise<unknown> {
    if (key) return text("Connected. Runtime's tools are listed.");
    if (!pending) {
      try {
        pending = await begin();
      } catch (e) {
        return text(`The sign-in could not start: ${(e as Error).message}`, true);
      }
      return text(ask(pending));
    }
    const p = pending;
    const why = await Promise.race([p.done, new Promise<null>((r) => setTimeout(() => r(null), WAIT_MS).unref())]);
    if (why === "") return text("Connected. Runtime's tools are listed.");
    if (why === null) return text(`Not approved yet. ${ask(p)}`);
    return text(`The sign-in ended: ${why} Call runtime_connect for a new link.`, true);
  }

  /** The answer to `m` while no key is held. */
  async function unconnected(m: Message): Promise<unknown> {
    switch (m.method) {
      case "initialize":
        return {
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "runtime-cloud", version: "not connected" },
          instructions: NOT_CONNECTED,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: [connectTool] };
      case "tools/call":
        return m.params?.name === CONNECT ? connectCall() : text(NOT_CONNECTED, true);
      default:
        throw new Error(NOT_CONNECTED);
    }
  }

  return async (line: string) => {
    if (!line.trim()) return;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The line is not JSON." } });
      return;
    }
    const id = m.id ?? null;
    if (!key || (m.method === "tools/call" && m.params?.name === CONNECT)) {
      if (m.id === undefined) return; // a notification
      try {
        write({ jsonrpc: "2.0", id, result: await (key ? connectCall() : unconnected(m)) });
      } catch (e) {
        write({ jsonrpc: "2.0", id, error: { code: -32001, message: (e as Error).message } });
      }
      return;
    }
    try {
      const res = await fetcher(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key}`,
        },
        body: line,
      });
      if (res.status === 202) return;
      const body = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        write({ jsonrpc: "2.0", id, error: { code: -32603, message: `The API answered ${res.status}: ${body.slice(0, 200)}` } });
        return;
      }
      if (res.ok) {
        write(parsed);
        return;
      }
      // A refusal of the call itself (a bad key, a limit) is the API's error body, not a JSON-RPC answer: the client
      // is told it as this request's error, or it waits for an answer that never comes.
      const api = (parsed as { error?: { code?: string; message?: string; hint?: string } }).error;
      const message = `${api?.code ?? res.status}: ${api?.message ?? body.slice(0, 200)}${api?.hint ? ` ${api.hint}` : ""}`;
      write({ jsonrpc: "2.0", id, error: { code: -32001, message, data: { status: res.status, ...api } } });
    } catch (e) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: `The API did not answer: ${(e as Error).message}` } });
    }
  };
}

export async function serveMcp(baseUrl: string, fetcher: typeof fetch = fetch): Promise<number> {
  const handle = bridge(baseUrl, (m) => process.stdout.write(`${JSON.stringify(m)}\n`), fetcher);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Each line at once: a runtime_connect that waits for an approval holds up no other call.
  const running = new Set<Promise<void>>();
  for await (const line of lines) {
    const p = handle(line).finally(() => running.delete(p));
    running.add(p);
  }
  await Promise.all(running);
  return 0;
}
