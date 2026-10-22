// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-sidecar-volume.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});

const image = await modal.images.fromRegistry("alpine:3.21").build(app);

const volume = await modal.volumes.ephemeral();

const sb = await modal.sandboxes.create(app, image, {
  command: ["sleep", "infinity"],
});
console.log("Started Sandbox:", sb.sandboxId);

try {
  const writer = await sb.experimentalSidecars.create("writer", image, {
    command: [
      "sh",
      "-c",
      "echo 'Hello from the writer sidecar!' > /mnt/volume/message.txt",
    ],
    volumes: { "/mnt/volume": volume },
  });
  console.log("Writer sidecar finished with exit code:", await writer.wait());

  const reader = await sb.experimentalSidecars.create("reader", image, {
    command: ["sleep", "100"],
    volumes: { "/mnt/volume": volume.withMountOptions({ readOnly: true }) },
  });

  const proc = await reader.exec(["cat", "/mnt/volume/message.txt"]);
  const output = await proc.stdout.readText();
  await proc.wait();
  console.log("Reader sidecar output:", output.trim());
} finally {
  await sb.terminate();
  volume.closeEphemeral();
}
