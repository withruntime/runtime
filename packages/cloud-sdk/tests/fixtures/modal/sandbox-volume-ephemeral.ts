// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-volume-ephemeral.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");

const volume = await modal.volumes.ephemeral();

const writerSandbox = await modal.sandboxes.create(app, image, {
  command: [
    "sh",
    "-c",
    "echo 'Hello from writer Sandbox!' > /mnt/volume/message.txt",
  ],
  volumes: { "/mnt/volume": volume },
});
console.log("Writer Sandbox:", writerSandbox.sandboxId);

await writerSandbox.wait();
console.log("Writer finished");
await writerSandbox.terminate();

const readerSandbox = await modal.sandboxes.create(app, image, {
  command: ["cat", "/mnt/volume/message.txt"],
  volumes: { "/mnt/volume": volume.withMountOptions({ readOnly: true }) },
});
console.log("Reader Sandbox:", readerSandbox.sandboxId);
console.log("Reader output:", await readerSandbox.stdout.readText());

await readerSandbox.terminate();
volume.closeEphemeral();
