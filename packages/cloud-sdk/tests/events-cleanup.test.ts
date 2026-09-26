import { expect, test } from "bun:test";
import { Transport } from "../src/transport";

function streaming(text: string, cancelError?: Error) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
      if (cancelError) throw cancelError;
    },
  });
  const transport = new Transport({
    apiKey: "test",
    fetch: (async () => new Response(stream)) as unknown as typeof fetch,
  });
  return { transport, cancelled: () => cancelled };
}

test("leaving an event iterator cancels its HTTP response body", async () => {
  const fixture = streaming('{"cursor":1}\n');
  for await (const event of fixture.transport.events({ method: "GET", path: "/events" })) {
    expect(event).toEqual({ cursor: 1 });
    break;
  }
  expect(fixture.cancelled()).toBe(true);
});

test("event cleanup preserves the parsing error when cancellation also fails", async () => {
  const fixture = streaming("invalid json\n", new Error("cancel failed"));
  const iterator = fixture.transport.events({ method: "GET", path: "/events" });
  await expect(iterator.next()).rejects.toBeInstanceOf(SyntaxError);
  expect(fixture.cancelled()).toBe(true);
});
