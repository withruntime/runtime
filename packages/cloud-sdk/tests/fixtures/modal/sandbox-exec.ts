// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-exec.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("python:3.13-slim");

const sb = await modal.sandboxes.create(app, image);
console.log("Started Sandbox:", sb.sandboxId);

try {
  const p = await sb.exec(
    [
      "python",
      "-c",
      `
import time
import sys
for i in range(50000):
    if i % 1000 == 0:
        time.sleep(0.01)
    print(i)
    print(i, file=sys.stderr)`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Read both the stdout and stderr streams.
  const [contentStdout, contentStderr] = await Promise.all([
    p.stdout.readText(),
    p.stderr.readText(),
  ]);
  console.log(
    `Got ${contentStdout.length} bytes stdout and ${contentStderr.length} bytes stderr`,
  );
  console.log("Return code:", await p.wait());

  const secret = await modal.secrets.fromName("libmodal-test-secret", {
    requiredKeys: ["c"],
  });
  const printSecret = await sb.exec(["printenv", "c"], {
    stdout: "pipe",
    secrets: [secret],
  });
  const secretText = await printSecret.stdout.readText();
  console.log(`Got environment variable c=${secretText}`);
} finally {
  await sb.terminate();
}
