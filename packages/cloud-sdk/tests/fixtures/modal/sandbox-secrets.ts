// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-secrets.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");

const secret = await modal.secrets.fromName("libmodal-test-secret", {
  requiredKeys: ["c"],
});

const ephemeralSecret = await modal.secrets.fromObject({
  d: "123",
});

const sb = await modal.sandboxes.create(app, image, {
  command: ["sh", "-lc", "printenv | grep -E '^c|d='"],
  secrets: [secret, ephemeralSecret],
});

console.log("Sandbox created:", sb.sandboxId);

console.log("Sandbox environment variables from Secrets:");
console.log(await sb.stdout.readText());
