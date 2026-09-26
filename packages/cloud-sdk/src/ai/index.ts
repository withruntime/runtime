/** Runtime sandbox tools for the Vercel AI SDK, and for Mastra, whose agents
 * take AI SDK tools as they are:
 *
 *   import { generateText, stepCountIs } from "ai";
 *   import { Sandbox } from "withruntime";
 *   import { runtimeTools } from "withruntime/ai";
 *
 *   await using sbx = await Sandbox.create();
 *   await generateText({ model, tools: runtimeTools(sbx), stopWhen: stepCountIs(10), prompt });
 *
 * Needs the `ai` package (version 5 or newer) beside this one. */
import { jsonSchema, type Schema, type ToolSet } from "ai";
import type { Sandbox } from "../sandbox.js";
import {
  sandboxTools,
  type ExecInput,
  type ExecOutput,
  type ListEntry,
  type SandboxTool,
  type SandboxToolOptions,
} from "../tools/index.js";

export type { SandboxToolOptions } from "../tools/index.js";

/** One tool, typed so that both the AI SDK's `tools` and Mastra's accept it.
 *
 * ai 7's own `Tool` type is not assignable to Mastra's `tools` (checked with
 * @mastra/core 1.71.0): ai 7 lets a description be a function, forbids an `id`
 * and wants `context` in the call options, and Mastra wants a string
 * description, an `id` or the older `parameters` field, and passes no
 * `context`. This shape is the part both agree on. `parameters` is the same
 * schema object as `inputSchema`: Mastra reads whichever it finds and the AI
 * SDK reads only `inputSchema`. */
export type RuntimeTool<I, O> = {
  type?: undefined;
  description: string;
  inputSchema: Schema<I>;
  parameters: Schema<I>;
  execute: (input: I, options?: unknown) => Promise<O>;
};

/** `{ runtime_exec, runtime_read_file, runtime_write_file, runtime_list_files }`, bound to `sandbox`. */
export type RuntimeTools = {
  runtime_exec: RuntimeTool<ExecInput, ExecOutput>;
  runtime_read_file: RuntimeTool<{ path: string }, string>;
  runtime_write_file: RuntimeTool<{ path: string; content: string }, string>;
  runtime_list_files: RuntimeTool<
    { path?: string; depth?: number },
    ListEntry[] | { error: string }
  >;
};

function aiTool<I, O>(source: SandboxTool<I, O>): RuntimeTool<I, O> {
  const schema = jsonSchema<I>(source.inputSchema);
  return {
    description: source.description,
    inputSchema: schema,
    parameters: schema,
    execute: (input) => source.execute(input),
  };
}

export function runtimeTools(sandbox: Sandbox, options: SandboxToolOptions = {}): RuntimeTools {
  const [exec, read, write, list] = sandboxTools(sandbox, options);
  return {
    runtime_exec: aiTool(exec),
    runtime_read_file: aiTool(read),
    runtime_write_file: aiTool(write),
    runtime_list_files: aiTool(list),
  } satisfies ToolSet;
}
