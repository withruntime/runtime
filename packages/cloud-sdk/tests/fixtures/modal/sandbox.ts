// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");

const sb = await modal.sandboxes.create(app, image, { command: ["cat"] });
console.log("Sandbox:", sb.sandboxId);

const sbFromId = await modal.sandboxes.fromId(sb.sandboxId);
console.log("Queried Sandbox from ID:", sbFromId.sandboxId);

await sb.stdin.writeText("this is input that should be mirrored by cat");
await sb.stdin.close();
console.log("output:", await sb.stdout.readText());

await sb.terminate();
