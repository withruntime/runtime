// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-proxy.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine/curl:8.14.1");

const proxy = await modal.proxies.fromName("libmodal-test-proxy", {
  environment: "libmodal",
});
console.log("Using Proxy with ID:", proxy.proxyId);

const sb = await modal.sandboxes.create(app, image, {
  proxy,
});
console.log("Created Sandbox with Proxy:", sb.sandboxId);

try {
  const p = await sb.exec(["curl", "-s", "ifconfig.me"]);
  const ip = await p.stdout.readText();

  console.log("External IP:", ip.trim());
} finally {
  await sb.terminate();
}
