// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-prewarm.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
// We use `Image.build` to create an Image object on Modal
// that eagerly pulls from the registry. The first Sandbox created with this Image
// will ues this "pre-warmed" Image and will start faster.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});

// With `.build(app)`, we create an Image object on Modal that eagerly pulls
// from the registry.
const image = await modal.images.fromRegistry("alpine:3.21").build(app);
console.log("image id:", image.imageId);

const imageId = image.imageId;
// You can save the Image ID and create a new Image object that referes to it.
const image2 = await modal.images.fromId(imageId);

const sb = await modal.sandboxes.create(app, image2, { command: ["cat"] });
console.log("Sandbox:", sb.sandboxId);

await sb.terminate();
