import { expect, spyOn, test } from "bun:test";
import { Transport, sayRenamed } from "../src/transport.js";

/* CLOUD.md section 4: the API answers a call under a renamed product word
 * with a Warning naming the new word. The SDK says it once, on stderr. */

test("an answer's rename warning is said once per process, on stderr", async () => {
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const transport = new Transport({
      apiKey: "rk_test",
      baseUrl: "https://api.example.test",
      fetch: (async () =>
        new Response('{"id":"a1"}', {
          headers: {
            "content-type": "application/json",
            warning: '299 runtime "/v1/addresses is now /v1/ips."',
          },
        })) as unknown as typeof fetch,
    });
    for (let i = 0; i < 3; i++)
      expect(
        await transport.json<{ id: string }>({ method: "GET", path: "/v1/addresses/a1" }),
      ).toEqual({
        id: "a1",
      });
    expect(warned.mock.calls).toEqual([["Runtime: /v1/addresses is now /v1/ips."]]);
  } finally {
    warned.mockRestore();
  }
});

test("no warning, or another kind, says nothing", () => {
  const lines: string[] = [];
  sayRenamed(null, (line) => lines.push(line));
  sayRenamed('199 proxy "stale"', (line) => lines.push(line));
  expect(lines).toEqual([]);
});
