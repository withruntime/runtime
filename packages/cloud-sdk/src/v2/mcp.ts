/* `runtime mcp`: Runtime's MCP tools over stdio, for a client that starts a
   process rather than calling a URL. Each JSON-RPC line read is sent as is
   to the API's own MCP endpoint (POST /mcp, which serves every verb and
   shortcut the spec names) under RUNTIME_API_KEY, and its answer written
   back as one line: the tools are always the server's, never this
   package's, so a verb is a tool the moment it is live. */

import { createInterface } from "node:readline";

export async function serveMcp(baseUrl: string, fetcher: typeof fetch = fetch): Promise<number> {
  const key = process.env["RUNTIME_API_KEY"];
  const endpoint = `${baseUrl}/mcp`;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
  for await (const line of lines) {
    if (!line.trim()) continue;
    let id: unknown = null;
    try {
      id = (JSON.parse(line) as { id?: unknown }).id ?? null;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The line is not JSON." } });
      continue;
    }
    try {
      const res = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: line,
      });
      if (res.status === 202) continue;
      const text = await res.text();
      try {
        write(JSON.parse(text));
      } catch {
        write({ jsonrpc: "2.0", id, error: { code: -32603, message: `The API answered ${res.status}: ${text.slice(0, 200)}` } });
      }
    } catch (e) {
      write({ jsonrpc: "2.0", id, error: { code: -32603, message: `The API did not answer: ${(e as Error).message}` } });
    }
  }
  return 0;
}
