import { afterEach, expect, test } from "bun:test";
import { traceHeaders, Transport } from "../src/transport";

/* A call carries the W3C trace context of the caller's active OpenTelemetry
   span, so Runtime's span of it (an export with "traces") sits inside the
   caller's own trace. @opentelemetry/api version 1 keeps its registered
   context manager and propagator on globalThis under this symbol; this
   stands in for them in the shape the API registers. Checked against the
   real @opentelemetry/api 1.9.0 with the SDK's W3CTraceContextPropagator
   and AsyncHooksContextManager on 26 October 2026. */

const KEY = Symbol.for("opentelemetry.js.api.1");
const PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const global = globalThis as Record<symbol, unknown>;
afterEach(() => {
  delete global[KEY];
});
function register(active: unknown) {
  global[KEY] = {
    version: "1.9.0",
    context: { active: () => active },
    propagation: {
      inject(
        context: unknown,
        carrier: Record<string, string>,
        setter: { set(c: Record<string, string>, k: string, v: string): void },
      ) {
        if (context !== active) throw new Error("not the active context");
        setter.set(carrier, "traceparent", PARENT);
        setter.set(carrier, "tracestate", "vendor=1");
        setter.set(carrier, "baggage", "user=someone");
      },
    },
  };
}

test("without OpenTelemetry a call carries no trace context", () => {
  expect(traceHeaders()).toEqual({});
});

test("a call carries the active span's traceparent and tracestate, nothing else of the carrier", async () => {
  register({ span: "active" });
  expect(traceHeaders()).toEqual({ traceparent: PARENT, tracestate: "vendor=1" });
  let sent: Headers | undefined;
  const transport = new Transport({
    apiKey: "rk_test",
    fetch: (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch,
  });
  await transport.json({ method: "GET", path: "/v1/me" });
  expect(sent?.get("traceparent")).toBe(PARENT);
  expect(sent?.get("tracestate")).toBe("vendor=1");
  expect(sent?.has("baggage")).toBe(false);
});

test("a propagator that throws, or no active context, costs the call nothing", () => {
  global[KEY] = {
    context: { active: () => ({}) },
    propagation: {
      inject() {
        throw new Error("a propagator's bug");
      },
    },
  };
  expect(traceHeaders()).toEqual({});
  register(undefined);
  expect(traceHeaders()).toEqual({});
});
