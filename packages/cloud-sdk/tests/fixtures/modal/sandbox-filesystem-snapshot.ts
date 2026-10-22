// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-filesystem-snapshot.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const baseImage = modal.images.fromRegistry("alpine:3.21");

const sb = await modal.sandboxes.create(app, baseImage);
console.log("Started Sandbox:", sb.sandboxId);

await (await sb.exec(["mkdir", "-p", "/app/data"])).wait();
await (
  await sb.exec([
    "sh",
    "-c",
    "echo 'This file was created in the first Sandbox' > /app/data/info.txt",
  ])
).wait();
console.log("Created file in first Sandbox");

const snapshotImage = await sb.snapshotFilesystem();
console.log(
  "Filesystem snapshot created with Image ID:",
  snapshotImage.imageId,
);

await sb.terminate();
console.log("Terminated first Sandbox");

// Create new Sandbox from the snapshot Image
const sb2 = await modal.sandboxes.create(app, snapshotImage);
console.log("\nStarted new Sandbox from snapshot:", sb2.sandboxId);

const proc = await sb2.exec(["cat", "/app/data/info.txt"]);
const info = await proc.stdout.readText();
console.log("File data read in second Sandbox:", info);

await sb2.terminate();
