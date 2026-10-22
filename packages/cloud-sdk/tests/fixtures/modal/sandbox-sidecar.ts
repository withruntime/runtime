// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-sidecar.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});

const image = await modal.images.fromRegistry("alpine:3.21").build(app);

const sb = await modal.sandboxes.create(app, image, {
  command: ["sleep", "infinity"],
});
console.log("Started Sandbox:", sb.sandboxId);

try {
  const container = await sb.experimentalSidecars.create("worker", image, {
    command: ["sleep", "100"],
  });
  console.log("Started sidecar:", container.containerId);

  const proc = await container.exec(
    ["sh", "-c", `echo "$GREETING from sidecar"`],
    { env: { GREETING: "hello" } },
  );
  const output = await proc.stdout.readText();
  await proc.wait();
  console.log("Sidecar said:", output.trim());

  await container.filesystem.writeText("snapshot state", "/tmp/state");
  const snapshot = await container.snapshotFilesystem();
  const restored = await sb.experimentalSidecars.create("restored", snapshot, {
    command: ["sleep", "100"],
  });
  console.log(
    "Restored state:",
    await restored.filesystem.readText("/tmp/state"),
  );

  const exitCode = await container.terminate({ wait: true });
  console.log("Sidecar terminated with exit code:", exitCode);
} finally {
  await sb.terminate();
}
