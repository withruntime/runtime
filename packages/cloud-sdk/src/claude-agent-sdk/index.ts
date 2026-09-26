/** Runtime sandbox tools for the Claude Agent SDK, as an in-process MCP server:
 *
 *   import { query } from "@anthropic-ai/claude-agent-sdk";
 *   import { Sandbox } from "withruntime";
 *   import { runtimeMcpServer, RUNTIME_TOOL_NAMES } from "withruntime/claude-agent-sdk";
 *
 *   await using sbx = await Sandbox.create();
 *   query({ prompt, options: {
 *     mcpServers: { runtime: runtimeMcpServer(sbx) },
 *     allowedTools: RUNTIME_TOOL_NAMES,
 *     disallowedTools: ["Bash", "Read", "Write", "Edit"], // keep work off this machine
 *   } });
 *
 * Needs `@anthropic-ai/claude-agent-sdk` and `zod` beside this one. For an agent
 * that should create and manage sandboxes itself, connect Runtime's own MCP
 * server instead: `npx -y withruntime mcp`. */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Sandbox } from "../sandbox.js";
import { sandboxTools, type SandboxToolOptions } from "../tools/index.js";

export type { SandboxToolOptions } from "../tools/index.js";

/** The tools' names as the Claude Agent SDK sees them, for `allowedTools`. */
export const RUNTIME_TOOL_NAMES = [
  "mcp__runtime__runtime_exec",
  "mcp__runtime__runtime_read_file",
  "mcp__runtime__runtime_write_file",
  "mcp__runtime__runtime_list_files",
];

const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
});

/** An MCP server named "runtime" whose four tools act on `sandbox`. */
export function runtimeMcpServer(sandbox: Sandbox, options: SandboxToolOptions = {}) {
  const [exec, read, write, list] = sandboxTools(sandbox, options);
  return createSdkMcpServer({
    name: "runtime",
    version: "1.0.0",
    tools: [
      tool(
        exec.name,
        exec.description,
        {
          command: z.string().min(1).describe(exec.inputSchema.properties.command!.description),
          cwd: z.string().optional().describe(exec.inputSchema.properties.cwd!.description),
          timeoutSeconds: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(exec.inputSchema.properties.timeoutSeconds!.description),
        },
        async (input) => text(await exec.execute(input)),
      ),
      tool(
        read.name,
        read.description,
        { path: z.string().describe(read.inputSchema.properties.path!.description) },
        async (input) => text(await read.execute(input)),
      ),
      tool(
        write.name,
        write.description,
        {
          path: z.string().describe(write.inputSchema.properties.path!.description),
          content: z.string().describe(write.inputSchema.properties.content!.description),
        },
        async (input) => text(await write.execute(input)),
      ),
      tool(
        list.name,
        list.description,
        {
          path: z.string().optional().describe(list.inputSchema.properties.path!.description),
          depth: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe(list.inputSchema.properties.depth!.description),
        },
        async (input) => text(await list.execute(input)),
      ),
    ],
  });
}
