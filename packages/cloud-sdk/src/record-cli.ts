import { spawn } from "node:child_process";
import { RuntimeError } from "./errors.js";
import { named } from "./cli-name.js";
import type { queues, CreateQueue, SendMessage } from "./products/queues.js";
import type { streams, CreateStream, PublishRecords, ReadStream } from "./products/streams.js";
import type { RequestOptions } from "./transport.js";

/** Private until launch. CLOUD.md section 4. cli.ts does not call this module. */
export const RECORD_PRODUCTS = ["queue", "stream"] as const;
export type RecordProduct = (typeof RECORD_PRODUCTS)[number];
export type RecordClient = {
  queues: ReturnType<typeof queues>;
  streams: ReturnType<typeof streams>;
};
type Args = { positional: string[]; flags: Map<string, string[]>; rest?: string[] };
type Out = { json: boolean; write(text: string): void; error(text: string): void };
export const RECORD_HELP: Record<RecordProduct, string> = {
  queue: `runtime queue <command> (private until launch)
  create --name work [--input '{"settings":{"fifo":false}}']
  get <id> | list [--input '{"limit":10}']
  update <id> --input '{"labels":{"team":"orders"}}'
  delete <id> | purge <id>
  send <id> --input '{"body":"hello"}'
  receive <id> [--input '{"max":1,"waitSeconds":20}']
  consume <id> --exec '<command>' [--max 1] [--wait-seconds 20]
    [--visibility-seconds 30]  Body on stdin; exit 0 acknowledges.
    A failure releases the message immediately. max counts attempts, including
    failures. Omit max to run until Ctrl-C. Cancellation releases known receipts.
    --timeout-ms bounds each network call (default 30000); settlement can finish
    after cancellation. Set visibility longer than processing; repeats are possible.
    Consume makes a key per operation; --idempotency-key does not apply.
  ack <id> --input '{"receiptHandles":["receipt"]}'
  retry <id> --input '{"receiptHandle":"receipt","visibilitySeconds":0}'
  wait <id> [--state ready|deleted] [--poll-ms 250]
  Every call: --idempotency-key <key> --timeout-ms <ms>; use --json for JSON.
  Retry a lost reply with the same key and input. Receives also need that key.
  Settings: visibilityTimeoutSeconds, retentionSeconds, maxMessageBytes,
  delaySeconds, fifo, deadLetter {queue,maxReceives}. At most 32 labels.
  Send: body, attributes, delaySeconds, groupId, dedupId. Receive: max 1-10,
  waitSeconds 0-20, visibilitySeconds. get returns the SQS URL.
`,
  stream: `runtime stream <command> (private until launch)
  create --name events [--input '{"partitions":1}']
  get <id> | list [--input '{"limit":10}']
  update <id> --input '{"retentionMs":86400000}' | delete <id>
  publish <id> --input '{"records":[{"key":"order","value":"hello","headers":[]}]}'
  read <id> --input '{"partition":0,"offset":"0","maxBytes":1048576,"waitMs":0}'
  trim <id> --input '{"partition":0,"before":"100"}'
  wait <id> [--state ready|deleted] [--poll-ms 250]
  Every call: --idempotency-key <key> --timeout-ms <ms>; use --json for JSON.
  Retry a lost reply with the same key and input. Offsets and retentionBytes
  are decimal strings. Read takes offset OR time (Unix milliseconds).
  get returns the Kafka bootstrap address and topic. At most 32 labels.
`,
};
function usage(product: RecordProduct, message: string): never {
  throw new RuntimeError({
    code: "usage",
    status: 0,
    message,
    hint: `Run \`${named("runtime")} ${product} help\`.`,
  });
}

/** Parsed like networkProductCommand; never obtains credentials for help or bad flags. */
export async function recordCommand(
  product: RecordProduct,
  args: Args,
  out: Out,
  client: () => Promise<RecordClient>,
  signal?: AbortSignal,
): Promise<number> {
  if (args.rest?.length) usage(product, "This command takes no arguments after --.");
  const [given = "help", id, ...extra] = args.positional;
  const verb = given === "ls" ? "list" : given === "rm" ? "delete" : given;
  const actions =
    product === "queue"
      ? ["send", "receive", "ack", "retry", "purge", "consume"]
      : ["publish", "read", "trim"];
  if (!["help", "create", "get", "list", "update", "delete", "wait", ...actions].includes(verb))
    usage(product, `Unknown command ${given}.`);
  const hasInput = [
    "create",
    "list",
    "update",
    "send",
    "receive",
    "ack",
    "retry",
    "publish",
    "read",
    "trim",
  ].includes(verb);
  const allowed = new Set([
    ...(verb === "consume" ? [] : ["idempotency-key"]),
    "timeout-ms",
    ...(hasInput ? ["input"] : []),
    ...(verb === "create" ? ["name"] : []),
    ...(verb === "wait" ? ["state", "poll-ms"] : []),
    ...(verb === "consume" ? ["exec", "max", "wait-seconds", "visibility-seconds"] : []),
  ]);
  for (const [flag, values] of args.flags) {
    if (!allowed.has(flag)) usage(product, `Unknown option --${flag} for ${verb}.`);
    if (values.length !== 1 || !values[0])
      usage(product, `Give --${flag} exactly once with a value.`);
  }
  if (extra.length || (["help", "create", "list"].includes(verb) && id))
    usage(product, "Unexpected positional argument.");
  if (verb === "help") {
    out.write(named(RECORD_HELP[product]));
    return 0;
  }
  if (!["create", "list"].includes(verb) && !id) usage(product, "Give the resource id.");
  const flag = (key: string) => args.flags.get(key)?.[0];
  const number = (key: string) => {
    const text = flag(key);
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value))
      usage(product, `--${key} needs a nonnegative safe integer.`);
    return value;
  };
  let input: Record<string, unknown> = {};
  if (flag("input") !== undefined) {
    try {
      input = JSON.parse(flag("input")!) as Record<string, unknown>;
    } catch {
      usage(product, "--input needs a JSON object.");
    }
    if (!input || Array.isArray(input) || typeof input !== "object")
      usage(product, "--input needs a JSON object.");
  }
  if (flag("name")) {
    if (Object.hasOwn(input, "name")) usage(product, "Give name in --name or --input, not both.");
    input.name = flag("name");
  }
  if (verb === "create" && (typeof input.name !== "string" || !input.name.trim()))
    usage(product, "Give a name with --name or --input.");
  if (
    ["update", "send", "ack", "retry", "publish", "read", "trim"].includes(verb) &&
    !flag("input")
  )
    usage(product, `${verb} needs --input.`);
  const state = flag("state") ?? "ready";
  if (verb === "wait" && state !== "ready" && state !== "deleted")
    usage(product, "--state must be ready or deleted.");
  const timeoutMs = number("timeout-ms");
  const pollMs = number("poll-ms");
  const options: RequestOptions = {
    idempotencyKey: flag("idempotency-key") ?? crypto.randomUUID(),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const consumeOptions =
    verb === "consume"
      ? {
          ...(number("max") === undefined ? {} : { max: number("max")! }),
          ...(number("wait-seconds") === undefined ? {} : { waitSeconds: number("wait-seconds")! }),
          ...(number("visibility-seconds") === undefined
            ? {}
            : { visibilitySeconds: number("visibility-seconds")! }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }
      : {};
  if (verb === "consume") {
    if (!flag("exec")?.trim()) usage(product, "consume needs --exec with a command.");
    if ((consumeOptions.waitSeconds ?? 20) > 20) usage(product, "--wait-seconds must be 0 to 20.");
    if ((consumeOptions.visibilitySeconds ?? 30) > 43_200)
      usage(product, "--visibility-seconds must be 0 to 43200.");
    if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > 2_147_483_647))
      usage(product, "consume --timeout-ms must be 1 to 2147483647.");
  }
  const api = await client();
  const resource = product === "queue" ? api.queues : api.streams;
  let result: unknown;
  switch (verb) {
    case "consume": {
      const stopped = new AbortController();
      const interrupt = () => stopped.abort();
      const combined = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      try {
        const consumed = await api.queues.consume(
          id!,
          (message, running) => executeMessage(flag("exec")!, message.body, running, out),
          { ...consumeOptions, signal: combined },
        );
        out.write(JSON.stringify(consumed, null, out.json ? undefined : 2));
        return consumed.aborted ? 130 : consumed.retried ? 1 : 0;
      } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
      }
    }
    case "create":
      result =
        product === "queue"
          ? await api.queues.create(input as CreateQueue, options)
          : await api.streams.create(input as CreateStream, options);
      break;
    case "update":
      result =
        product === "queue"
          ? await api.queues.update(id!, input, options)
          : await api.streams.update(id!, input, options);
      break;
    case "list":
      result = await resource.list(input, options);
      break;
    case "get":
      result = await resource.get(id!, options);
      break;
    case "delete":
      result = await resource.delete(id!, options);
      break;
    case "wait":
      result = await resource.wait(id!, state as "ready" | "deleted", {
        ...options,
        ...(pollMs === undefined ? {} : { pollMs }),
      });
      break;
    case "send":
      result = await api.queues.send(id!, input as SendMessage, options);
      break;
    case "receive":
      result = await api.queues.receive(id!, input, options);
      break;
    case "ack": {
      const receipts = await api.queues.ack(id!, input as { receiptHandles: string[] }, options);
      if (receipts.failed.length)
        throw new RuntimeError({
          code: receipts.failed[0]!.code,
          status: 0,
          message: receipts.failed[0]!.message,
          hint: receipts.failed[0]!.hint,
          details: { ...receipts },
          idempotencyKey: options.idempotencyKey,
        });
      result = receipts;
      break;
    }
    case "retry":
      result = await api.queues.retry(
        id!,
        input as { receiptHandle: string; visibilitySeconds: number },
        options,
      );
      break;
    case "purge":
      result = await api.queues.purge(id!, options);
      break;
    case "publish":
      result = await api.streams.publish(id!, input as PublishRecords, options);
      break;
    case "read":
      result = await api.streams.read(id!, input as ReadStream, options);
      break;
    case "trim":
      result = await api.streams.trim(id!, input as { partition: number; before: string }, options);
      break;
  }
  // Include cursors, receipt failures and endpoint settings in either output mode.
  out.write(JSON.stringify(result, null, out.json ? undefined : 2));
  return 0;
}

/** Only the requested command is shell code. Message bytes go through stdin.
 * Output goes to stderr so stdout keeps the CLI's JSON result parseable. */
function executeMessage(
  command: string,
  body: string,
  signal: AbortSignal,
  out: Out,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (message: string) =>
      new RuntimeError({
        code: "command_failed",
        status: 0,
        message,
        hint: "Fix the consumer command; the message will be made visible again.",
      });
    if (signal.aborted) {
      reject(failed("Consumer command cancelled."));
      return;
    }
    const grouped = process.platform !== "win32";
    const child = spawn(command, {
      shell: true,
      detached: grouped,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const abort = () => {
      if (grouped && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (bytes: Buffer) => out.error(bytes.toString("utf8")));
    child.stderr.on("data", (bytes: Buffer) => out.error(bytes.toString("utf8")));
    let inputError: Error | undefined;
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        inputError = error;
        abort();
      }
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      const failure = failed(`Consumer could not start: ${error.message}`);
      out.error(`${failure.code}: ${failure.message} ${failure.hint}`);
      reject(failure);
    });
    child.once("close", (code, killed) => {
      signal.removeEventListener("abort", abort);
      if (code === 0 && !signal.aborted && !inputError) {
        resolve();
        return;
      }
      const failure = failed(
        inputError?.message ?? `Consumer exited ${code ?? killed ?? "without a status"}.`,
      );
      out.error(`${failure.code}: ${failure.message} ${failure.hint}`);
      reject(failure);
    });
    child.stdin.end(body);
  });
}
