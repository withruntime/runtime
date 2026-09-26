import type { Sandbox } from "../sandbox.js";
import type { RequestOptions, Transport } from "../transport.js";

export type McpCatalogEntry = {
  id: string;
  title: string;
  description: string;
  license: string;
  source: string;
  version: string;
  env: {
    name: string;
    description: string;
    required: boolean;
    secret: boolean;
    hosts?: string[];
  }[];
  options: { name: string; description: string; required: boolean }[];
  egress: string[];
  checked: string;
};
export type McpServerRequest =
  | {
      /** A catalog id, e.g. "github". */
      id: string;
      name?: string;
      /** A secret setting to the Runtime secret that fills it. */
      secrets?: Record<string, string>;
      env?: Record<string, string>;
      options?: Record<string, string>;
    }
  | { name: string; command: string[]; env?: Record<string, string> };
export type McpGateway = {
  running: boolean;
  port: number | null;
  /** Send it as `Authorization: Bearer <token>`. */
  token?: string | null;
  headers?: Record<string, string>;
  urlExpiresAt?: string | null;
  servers: {
    name: string;
    status: "installing" | "ready" | "failed";
    message?: string | null;
    /** Its Streamable HTTP endpoint. */
    url: string | null;
  }[];
  warnings: string[];
};

/** `runtime.mcp`: the catalog of MCP servers a sandbox can run. */
export function mcp(t: Transport) {
  return {
    catalog: async (options?: RequestOptions) =>
      (
        await t.json<{ data: McpCatalogEntry[] }>({
          method: "GET",
          path: "/v1/mcp/catalog",
          ...options,
        })
      ).data,
  };
}

/** `sbx.mcp`: catalog MCP servers running inside the sandbox, at URLs an
 * agent connects to.
 *
 *   const gw = await sbx.mcp.start([{ id: "github", secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_TOKEN" } }]);
 *   // gw.servers[0].url with gw.headers, in any MCP client
 */
export function sandboxMcp(t: Transport, sandbox: Sandbox) {
  const path = () => `/v1/sandboxes/${encodeURIComponent(sandbox.id)}/mcp`;
  return {
    start: (
      servers: McpServerRequest[],
      input: { port?: number; replace?: boolean } = {},
      options?: RequestOptions,
    ) =>
      t.json<McpGateway>({ method: "POST", path: path(), body: { servers, ...input }, ...options }),
    /** Their state, and fresh URLs. */
    get: (options?: RequestOptions) =>
      t.json<McpGateway>({ method: "GET", path: path(), ...options }),
    /** Wait until every server is ready (or one failed). */
    async ready(input: { timeoutMs?: number; intervalMs?: number } = {}): Promise<McpGateway> {
      const deadline = Date.now() + (input.timeoutMs ?? 600_000);
      for (;;) {
        const state = await t.json<McpGateway>({ method: "GET", path: path() });
        if (!state.running || state.servers.every((server) => server.status !== "installing"))
          return state;
        if (Date.now() > deadline) return state;
        await new Promise((resolve) => setTimeout(resolve, input.intervalMs ?? 2_000));
      }
    },
    stop: (options?: RequestOptions) =>
      t.json<{ stopped: boolean }>({ method: "DELETE", path: path(), ...options }),
  };
}
