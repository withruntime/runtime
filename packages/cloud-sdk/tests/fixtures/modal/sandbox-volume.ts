// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-volume.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");

const volume = await modal.volumes.fromName("libmodal-example-volume", {
  createIfMissing: true,
});

const writerSandbox = await modal.sandboxes.create(app, image, {
  command: [
    "sh",
    "-c",
    "mkdir -p /mnt/volume/data && echo 'Hello from writer Sandbox!' > /mnt/volume/data/message.txt",
  ],
  volumes: { "/mnt/volume": volume },
});
console.log("Writer Sandbox:", writerSandbox.sandboxId);

await writerSandbox.wait();
console.log("Writer finished");

// Mount the Volume read-only and scoped to the /data sub-path, so the reader
// sees the file directly at /mnt/volume/message.txt.
const readerSandbox = await modal.sandboxes.create(app, image, {
  volumes: {
    "/mnt/volume": volume.withMountOptions({
      readOnly: true,
      subPath: "/data",
    }),
  },
});
console.log("Reader Sandbox:", readerSandbox.sandboxId);

const rp = await readerSandbox.exec(["cat", "/mnt/volume/message.txt"]);
console.log("Reader output:", await rp.stdout.readText());

const wp = await readerSandbox.exec([
  "sh",
  "-c",
  "echo 'This should fail' >> /mnt/volume/message.txt",
]);
const wpExitCode = await wp.wait();

console.log("Write attempt exit code:", wpExitCode);
console.log("Write attempt stderr:", await wp.stderr.readText());

await writerSandbox.terminate();
await readerSandbox.terminate();
