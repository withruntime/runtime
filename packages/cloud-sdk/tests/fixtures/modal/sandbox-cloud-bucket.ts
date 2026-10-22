// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-cloud-bucket.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});
const image = modal.images.fromRegistry("alpine:3.21");

const secret = await modal.secrets.fromName("libmodal-aws-bucket-secret");

const sb = await modal.sandboxes.create(app, image, {
  command: ["sh", "-c", "ls -la /mnt/s3-bucket"],
  cloudBucketMounts: {
    "/mnt/s3-bucket": modal.cloudBucketMounts.create("my-s3-bucket", {
      secret,
      keyPrefix: "data/",
      readOnly: true,
    }),
  },
});

console.log("S3 Sandbox:", sb.sandboxId);
console.log(
  "Sandbox directory listing of /mnt/s3-bucket:",
  await sb.stdout.readText(),
);

await sb.terminate();
