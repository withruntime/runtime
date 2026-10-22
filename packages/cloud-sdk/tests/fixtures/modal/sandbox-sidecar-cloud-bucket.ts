// Source: https://github.com/modal-labs/modal-client/blob/js/v0.11.1/js/examples/sandbox-sidecar-cloud-bucket.ts
// Read 18 October 2026: Modal's own example for its JS SDK 0.11.1, the version
// withruntime/modal pins. Copied verbatim; the only change is the import, "modal"
// to "withruntime/modal". Run live by scripts/compatibility-modal-examples-live.ts.
import { ModalClient } from "withruntime/modal";

const modal = new ModalClient();

const app = await modal.apps.fromName("libmodal-example", {
  createIfMissing: true,
});

const image = await modal.images.fromRegistry("alpine:3.21").build(app);

const secret = await modal.secrets.fromName("libmodal-aws-bucket-secret");

const sb = await modal.sandboxes.create(app, image, {
  command: ["sleep", "infinity"],
});
console.log("Started Sandbox:", sb.sandboxId);

try {
  const sidecar = await sb.experimentalSidecars.create("reader", image, {
    command: ["sleep", "100"],
    cloudBucketMounts: {
      "/mnt/s3-bucket": modal.cloudBucketMounts.create("my-s3-bucket", {
        secret,
        keyPrefix: "data/",
        readOnly: true,
      }),
    },
  });

  const proc = await sidecar.exec(["ls", "-la", "/mnt/s3-bucket"]);
  const output = await proc.stdout.readText();
  await proc.wait();
  console.log("Sidecar directory listing of /mnt/s3-bucket:", output);
} finally {
  await sb.terminate();
}
