import { expect, test } from "bun:test";
import { INVOICE_EXAMPLE } from "../examples/verify-frameworks";

test("the framework invoice example has a fixed useful result", async () => {
  const child = Bun.spawn(["python3", "-c", INVOICE_EXAMPLE], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "750\n", stderr: "" });
  expect(new TextEncoder().encode(INVOICE_EXAMPLE).byteLength).toBe(28);
});
