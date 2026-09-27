// Blaxel's TypeScript guides for variables, ports, previews and forks
// (docs.blaxel.ai, checked 27 September 2026), as their docs show them; lines
// marked "glue" join the snippets into one program (a server to reach, and a
// copy deleted before the next one takes its name).
// scripts/dropin-e2e.ts runs it on Runtime with only the import changed.
/* global console, fetch */
import { SandboxInstance } from "@blaxel/core";

// Variables and secrets
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest",
  region: "us-pdx-1",
  envs: [
    { name: "NODE_ENV", value: "production" },
    { name: "PORT", value: "3000" },
  ],
});

try {
  // glue: a server answering on $PORT
  await sandbox.fs.write(
    "/blaxel/server.js",
    `require("http").createServer((req, res) => {
       res.setHeader("content-type", "application/json");
       res.end(JSON.stringify({ path: req.url, port: process.env.PORT, env: process.env.NODE_ENV }));
     }).listen(process.env.PORT, "0.0.0.0");`,
  );
  await sandbox.process.exec({
    name: "web",
    command: "node server.js",
    waitForPorts: [3000],
  }); // glue: the sandbox's own PORT, 3000

  const process = await sandbox.process.exec({
    command: "node server.js",
    env: {
      PORT: "8080",
      LOG_LEVEL: "debug",
    },
  });
  console.log("second server", process.status);

  // Ports: fetch a resource on port 3000
  const response = await sandbox.fetch(3000);
  console.log(await response.text());

  // Fetch with a specific path
  const apiResponse = await sandbox.fetch(3000, "/api/health");
  console.log(await apiResponse.json());
  console.log("8080", await (await sandbox.fetch(8080, "/eight")).text()); // glue

  // Previews: a private preview
  const preview = await sandbox.previews.createIfNotExists({
    metadata: { name: "private-preview" },
    spec: {
      port: 3000,
      public: false,
    },
  });

  // Create access token (10 minutes expiry)
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const token = await preview.tokens.create(expiresAt);

  // How to access the preview with the token
  const url = preview.spec?.url;
  const tokenResponse = await fetch(`${url}/health?bl_preview_token=${token.value}`);
  console.log("preview with Blaxel's token parameter:", tokenResponse.status); // glue

  // Forks and snapshots
  const snapshot = await sandbox.snapshots.create("my-snapshot");
  const snapshots = await sandbox.snapshots.list();
  console.log("snapshots", snapshot.name, snapshots.length);

  const result = await sandbox.fork("my-sandbox-copy");
  console.log("fork", result.name);
  await SandboxInstance.delete("my-sandbox-copy"); // glue

  const fromSnapshot = await sandbox.fork("my-sandbox-copy", {
    targetType: "sandbox",
    snapshotId: "my-snapshot",
  });
  console.log("fork from snapshot", fromSnapshot.name, fromSnapshot.snapshotId === snapshot.id);
  await SandboxInstance.delete("my-sandbox-copy"); // glue

  const withEnvs = await sandbox.fork("my-sandbox-copy", {
    envs: [
      { name: "NODE_ENV", value: "staging" },
      { name: "FEATURE_FLAG", value: "1" },
    ],
  });
  const copy = await SandboxInstance.get(withEnvs.name); // glue: the copy's envs
  const env = await copy.process.exec({
    command: "echo $NODE_ENV $FEATURE_FLAG $PORT",
    waitForCompletion: true,
  });
  console.log("fork envs:", env.stdout.trim());
  await copy.delete(); // glue

  await sandbox.snapshots.delete("my-snapshot");
  await sandbox.previews.delete("private-preview");
} finally {
  await sandbox.delete();
}
