// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/image-building.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});

const curlVersionSecret = await modal.secrets.fromObject({
  CURL_VERSION: "8.12.1-r1",
});
const image = modal.images
  .fromRegistry("alpine:3.21")
  .dockerfileCommands(["RUN apk add --no-cache curl=$CURL_VERSION"], {
    secrets: [curlVersionSecret],
  })
  .dockerfileCommands(["ENV SERVER=ipconfig.me"]);

const sb = await modal.sandboxes.create(app, image, {
  command: ["sh", "-c", "curl -Ls $SERVER"],
});
console.log("Created Sandbox with ID:", sb.sandboxId);

console.log("Sandbox output:", await sb.stdout.readText());
await sb.terminate();
