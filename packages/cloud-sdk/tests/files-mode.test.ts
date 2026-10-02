import { expect, test } from "bun:test";
import { Runtime } from "../src/index";

const ID = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f";
async function fixture(kind: "modern" | "legacy" | "old-api" | "denied") {
  const calls: { path: string; body: Record<string, unknown>; key: string | null }[] = [];
  let accepted = 0;
  const runtime = new Runtime({
    apiKey: "rt_test",
    baseUrl: "http://localhost",
    maxRetries: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init),
        path = new URL(request.url).pathname;
      if (request.method === "GET")
        return Response.json({ id: ID, kind: "sandbox", state: "running", status: "active" });
      const body = request.headers.get("content-type")?.includes("json")
        ? ((await request.json()) as Record<string, unknown>)
        : {};
      calls.push({ path, body, key: request.headers.get("idempotency-key") });
      if (path.endsWith("/uploads")) {
        if (kind === "denied" || (kind === "legacy" && body.mode))
          return Response.json(
            {
              error: {
                code: kind === "denied" ? "forbidden" : "guest_upgrade_required",
                message: "fixture",
              },
            },
            { status: kind === "denied" ? 403 : 409 },
          );
        accepted = 0;
        return Response.json({
          uploadId: "upload-1",
          chunkBytes: 1048576,
          ...(kind === "modern" ? { mode: body.mode } : {}),
        });
      }
      if (request.method === "PUT" && path.includes("/uploads/")) {
        accepted += (await request.arrayBuffer()).byteLength;
        return Response.json({ received: accepted });
      }
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { files: (await runtime.sandboxes.get(ID)).files, calls };
}
for (const kind of ["modern", "legacy", "old-api"] as const)
  test(`large file mode with ${kind} server`, async () => {
    const { files, calls } = await fixture(kind);
    await files.write("/workspace/run", new Uint8Array(1048577), {
      mode: 0o755,
      idempotencyKey: "repeat-this",
    });
    const begins = calls.filter((c) => c.path.endsWith("/uploads"));
    expect(begins).toHaveLength(kind === "legacy" ? 2 : 1);
    expect(calls.filter((c) => c.path.endsWith("/files:chmod"))).toHaveLength(
      kind === "modern" ? 0 : 1,
    );
    if (kind === "legacy") {
      expect(begins[1]!.body).not.toHaveProperty("mode");
      expect(begins[1]!.key).not.toBe(begins[0]!.key);
      const firstKey = begins[1]!.key;
      await files.write("/workspace/run", new Uint8Array(1048577), {
        mode: 0o755,
        idempotencyKey: "repeat-this",
      });
      expect(calls.filter((c) => c.path.endsWith("/uploads"))[3]!.key).toBe(firstKey);
    }
  });
test("other begin refusals never retry without mode", async () => {
  const { files, calls } = await fixture("denied");
  await expect(
    files.write("/workspace/run", new Uint8Array(1048577), { mode: 0o755 }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(calls).toHaveLength(1);
});
