import { RuntimeError } from "../errors.js";
import { terminalSafe } from "../terminal.js";
import type { AlertInput, ObservabilityClient, ViewInput } from "../products/logs.js";
import type { RequestOptions } from "../transport.js";

type Product = "logs" | "traces" | "alerts";
type Args = { positional: string[]; flags: Map<string, string[]> };
type Out = {
  json: boolean;
  tty?: boolean;
  drain?: () => Promise<void>;
  write(text: string): void;
  error(text: string): void;
};
export const LOGS_HELP = `runtime logs tail <selector|app> [--since 1h] [--grep text] [--json] [--raw]
runtime logs query '<LogQL>' [--from <time>] [--to <time>] [--limit <n>]
runtime logs labels | values <label>
runtime logs views ls|get|create|update|delete [id] [--body '<JSON>']
runtime traces get <id> | search '<TraceQL>' | tags
runtime traces views ls|get|create|update|delete [id] [--body '<JSON>']
runtime logs ingest --body '<OTLP JSON>'
runtime traces ingest --body '<OTLP JSON>'
runtime alerts ls|get|create|update|delete|test|silence [id]
  create/update: --body '<JSON: name, labels, query, condition, for, actions>'
  silence: --until <RFC3339> [--reason <text>]
Every command takes --json. Writes take --idempotency-key <key>.
On a terminal, control characters in logs show as \\uXXXX; --raw prints them as written.`;
const usage = (message: string) =>
  new RuntimeError({ code: "usage", status: 0, message, hint: LOGS_HELP });
function since(text: string, now: number) {
  const match = /^(\d+)(s|m|h|d)$/.exec(text);
  if (!match) throw usage("Use --since with seconds, minutes, hours or days, such as 1h.");
  const factors: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const at = now - Number(match[1]) * factors[match[2]!]!;
  if (!Number.isSafeInteger(at) || at < 0)
    throw usage("--since is outside the supported time range.");
  return new Date(at).toISOString();
}
/** Same parsed argument and output ports as the existing CLI. No registration
 * occurs here: the launch owner supplies a client only after launch. */
export async function logsProductCommand(
  product: Product,
  argv: string[],
  args: Args,
  out: Out,
  client: () => Promise<ObservabilityClient>,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<number> {
  const verb = argv[0];
  const rest = args.positional.slice(1);
  const flag = (name: string) => args.flags.get(name)?.at(-1);
  const json = out.json || flag("json") === "true";
  // On a terminal, what customers' programs wrote is shown escaped, JSON
  // included (an escape is still valid JSON); --raw prints it as it is.
  const safe = (text: string) => (out.tty && flag("raw") !== "true" ? terminalSafe(text) : text);
  const lines = (text: string) => text.split("\n").map(safe).join("\n");
  const print = (value: unknown, text?: string) =>
    out.write(json ? safe(JSON.stringify(value)) : lines(text ?? JSON.stringify(value, null, 2)));
  const need = (value: string | undefined, name: string) => {
    if (!value) throw usage(`Give ${name}.`);
    return value;
  };
  const body = () => {
    try {
      const value: unknown = JSON.parse(need(flag("body"), "--body with a JSON object"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw usage("--body must be a JSON object.");
      return value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw usage("--body is not valid JSON.");
    }
  };
  const request: RequestOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(flag("idempotency-key") ? { idempotencyKey: flag("idempotency-key")! } : {}),
  };
  if (!verb || verb === "help" || verb === "--help") {
    print({ usage: LOGS_HELP }, LOGS_HELP);
    return 0;
  }
  const runtime = await client();
  if ((product === "logs" || product === "traces") && verb === "views") {
    const views = runtime[product].views;
    const action = need(rest[0], "a views command");
    if (action === "ls") {
      const result = await views.list({}, request);
      print({ data: result.data, nextCursor: result.nextCursor });
    } else if (action === "create") print(await views.create(body() as ViewInput, request));
    else {
      const id = need(rest[1], "a view id");
      if (action === "get") print(await views.get(id, request));
      else if (action === "update") print(await views.update(id, body(), request));
      else if (action === "delete") {
        await views.delete(id, request);
        print({ deleted: id });
      } else throw usage(`Unknown views command: ${action}.`);
    }
    return 0;
  }
  if ((product === "logs" || product === "traces") && verb === "ingest") {
    const input = body();
    if (product === "logs") {
      if (!Array.isArray(input.resourceLogs)) throw usage("OTLP logs need resourceLogs.");
      const resourceLogs = input.resourceLogs as Record<string, unknown>[];
      print(await runtime.logs.ingest({ resourceLogs }, request));
    } else {
      if (!Array.isArray(input.resourceSpans)) throw usage("OTLP spans need resourceSpans.");
      const resourceSpans = input.resourceSpans as Record<string, unknown>[];
      print(await runtime.traces.ingest({ resourceSpans }, request));
    }
    return 0;
  }
  if (product === "logs") {
    if (verb === "tail") {
      const selector = need(rest[0], "a selector or app name");
      let query = selector.trim().startsWith("{") ? selector : `{app=${JSON.stringify(selector)}}`;
      if (flag("grep") !== undefined) query += ` |= ${JSON.stringify(flag("grep"))}`;
      for await (const event of runtime.logs.tail(query, {
        ...request,
        ...(flag("since") ? { start: since(flag("since")!, options.now ?? Date.now()) } : {}),
      })) {
        if (json) out.write(safe(JSON.stringify(event)));
        else if (event.gap) {
          const text = safe(
            `Logs expired between ${event.from} and ${event.to}; continuing from retained logs.`,
          );
          out.write(out.tty ? `\x1b[2m${text}\x1b[0m` : text);
        } else {
          const time = safe(event.time);
          const text = safe(
            typeof event.body === "string" ? event.body : JSON.stringify(event.body),
          );
          out.write(
            `${out.tty ? `\x1b[2m${time}\x1b[0m` : time} ${safe(event.severityText)} ${text}`,
          );
        }
        await out.drain?.();
      }
    } else if (verb === "query") {
      const limit = flag("limit") === undefined ? undefined : Number(flag("limit"));
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
        throw usage("--limit must be a positive integer.");
      print(
        await runtime.logs.queryRange(
          {
            query: need(rest[0], "a LogQL query"),
            ...(flag("from") ? { start: flag("from")! } : {}),
            ...(flag("to") ? { end: flag("to")! } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          request,
        ),
      );
    } else if (verb === "labels") print(await runtime.logs.labels({}, request));
    else if (verb === "values")
      print(await runtime.logs.labelValues(need(rest[0], "a label name"), {}, request));
    else throw usage(`Unknown logs command: ${verb}.`);
  } else if (product === "traces") {
    if (verb === "get") print(await runtime.traces.get(need(rest[0], "a trace id"), request));
    else if (verb === "search")
      print(await runtime.traces.search(need(rest[0], "a TraceQL query"), request));
    else if (verb === "tags") print(await runtime.traces.tags(request));
    else throw usage(`Unknown traces command: ${verb}.`);
  } else {
    if (verb === "ls") {
      const result = await runtime.alerts.list({}, request);
      print({ data: result.data, nextCursor: result.nextCursor });
    } else if (verb === "create") print(await runtime.alerts.create(body() as AlertInput, request));
    else {
      const id = need(rest[0], "an alert id");
      if (verb === "get") print(await runtime.alerts.get(id, request));
      else if (verb === "update") print(await runtime.alerts.update(id, body(), request));
      else if (verb === "delete") {
        await runtime.alerts.delete(id, request);
        print({ deleted: id });
      } else if (verb === "test") print(await runtime.alerts.test(id, request));
      else if (verb === "silence") {
        const until = need(flag("until"), "--until with an RFC3339 time");
        if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(until) || !Number.isFinite(Date.parse(until)))
          throw usage("--until must be an RFC3339 time with timezone.");
        print(
          await runtime.alerts.silence(
            id,
            { until, ...(flag("reason") ? { reason: flag("reason")! } : {}) },
            request,
          ),
        );
      } else throw usage(`Unknown alerts command: ${verb}.`);
    }
  }
  return 0;
}
