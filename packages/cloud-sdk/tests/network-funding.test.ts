import { expect, test } from "bun:test";
import type { EgressAddress, Tunnel } from "../src/products/network-products";
import { Runtime } from "../src/client";
import { networkProductCommand } from "../src/network-cli";
const quote = {
  funded: false,
  fundedUntil: "2026-09-24T00:00:00.000Z",
  rateMicros: 5_000_000,
  rateUnit: "unit_month" as const,
};
const address: EgressAddress = {
  ...quote,
  id: "address-1",
  address: "203.0.113.10",
  family: 4,
  createdAt: "2026-09-24T00:00:00.000Z",
};
const tunnel: Tunnel = {
  ...quote,
  id: "tunnel-1",
  endpoint: "edge.test:51820",
  subnet: "10.250.0.0/16",
  gatewayAddress: "10.250.0.1",
  gatewayPublicKey: null,
  disabled: false,
  peers: [],
  sandboxes: [],
  createdAt: address.createdAt,
};
function client() {
  return new Runtime({
    apiKey: "rt_test",
    baseUrl: "https://api.test",
    maxRetries: 0,
    fetch: (async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const value =
        url.pathname === "/v1/tunnel"
          ? tunnel
          : init?.method === "POST"
            ? address
            : { data: [address], nextCursor: null };
      return Response.json(value);
    }) as typeof fetch,
  });
}
test("SDK retains network funding fields and CLI never calls an unfunded reservation active", async () => {
  const runtime = client();
  expect(await runtime.addresses.reserve()).toEqual(address);
  expect((await runtime.addresses.list())[0]).toEqual(address);
  expect(await runtime.tunnel.get()).toEqual(tunnel);
  for (const [product, verb] of [
    ["address", "ls"],
    ["address", "reserve"],
    ["tunnel", "get"],
  ] as const) {
    const output: string[] = [];
    await networkProductCommand(
      product,
      [verb],
      { positional: [verb], flags: new Map() },
      { json: false, write: (t) => output.push(t), error: (t) => output.push(t) },
      async () => runtime,
    );
    expect(output.join("\n")).toContain(
      "Traffic disabled. Check balance, spending limits and account permissions. Reservation kept until you release it.",
    );
    expect(output.join("\n")).not.toContain("now sends from it");
  }
});
test("CLI JSON returns the funding and quote without changing it", async () => {
  const output: string[] = [];
  await networkProductCommand(
    "tunnel",
    ["get"],
    { positional: ["get"], flags: new Map() },
    { json: true, write: (t) => output.push(t), error: () => {} },
    async () => client(),
  );
  expect(JSON.parse(output[0]!)).toEqual(tunnel);
});
