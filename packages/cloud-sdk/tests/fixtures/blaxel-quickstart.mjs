// Blaxel's TypeScript "Get started" and its process, log-streaming and
// file-system guides (docs.blaxel.ai, checked 27 September 2026), as their
// docs show them; lines marked "glue" join the snippets into one program.
// scripts/dropin-e2e.ts runs it on Runtime with only the import changed.
/* global console, Buffer */
import { SandboxInstance } from "@blaxel/core";
import fs from "node:fs"; // glue: the guide's writeBinary snippet reads a local file

// Get started
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest", // public or custom image
  memory: 4096, // in MB
  ports: [{ target: 3000, protocol: "HTTP" }], // ports to expose
  labels: { env: "dev", project: "my-project" }, // labels
  region: "us-pdx-1", // deployment region
});
console.log("Sandbox created: ", sandbox.metadata.name);

try {
  // Processes: execute a command, with a working directory, by name
  await sandbox.process.exec({
    command: "echo 'Hello, World!'",
  });
  await sandbox.process.exec({
    workingDir: "/blaxel",
    command: "ls -al",
  });
  const process = await sandbox.process.exec({
    name: "hello-process",
    command: "echo 'Hello, World!'",
  });
  const processInfo = await sandbox.process.get("hello-process");
  console.log("process", process.name, processInfo.name);
  const completedProcess = await sandbox.process.wait("hello-process"); // glue: let it finish
  if (completedProcess.status === "completed") {
    console.log("exit code", completedProcess.exitCode);
  }

  // Log streaming
  const waited = await sandbox.process.exec({
    name: "hello-process",
    command: "echo 'Hello, World!'",
    waitForCompletion: true,
  });
  console.log(waited.logs);
  const logs = await sandbox.process.logs("hello-process");
  const errorLogs = await sandbox.process.logs("hello-process", "stderr");
  const allLogs = await sandbox.process.logs("hello-process", "all");
  console.log("logs", JSON.stringify([logs, errorLogs, allLogs]));

  await sandbox.process.exec({
    name: "streaming-demo",
    command: "echo 'Starting process'; sleep 2; echo 'Processing...'; sleep 2; echo 'Completed!'",
    onLog: (log) => {
      console.log(`LOG: ${JSON.stringify(log)}`);
    },
  });
  await sandbox.process.wait("streaming-demo"); // glue: let it finish

  // Start a long-running process
  await sandbox.process.exec({
    name: "stream-demo",
    command: "sh -c 'for i in $(seq 1 5); do echo \"Output $i\"; sleep 1; done'",
  });

  const stream = sandbox.process.streamLogs("stream-demo", {
    onLog: (log) => console.log("Log:", log),
    onStdout: (stdout) => console.log("Stdout:", stdout),
    onStderr: (stderr) => console.log("Stderr:", stderr),
  });

  // Wait for completion and cleanup
  await sandbox.process.wait("stream-demo");
  stream.close();

  const build = await sandbox.process.exec({
    name: "build-process",
    command: "npm run build",
    waitForCompletion: true,
    timeout: 60, // 60 seconds
  });
  console.log("build", build.status, build.exitCode);

  await sandbox.process.exec({
    name: "long-task",
    command: "sleep 10",
  });

  // Wait for completion (max 10 minutes, check every 5 seconds)
  await sandbox.process.wait("long-task", {
    maxWait: 600000,
    interval: 5000,
  });
  console.log("long-task", (await sandbox.process.get("long-task")).status); // glue

  // File system
  await sandbox.fs.mkdir("/blaxel/app/uploads");
  await sandbox.fs.write("/blaxel/app/config.json", "{}");
  const content = await sandbox.fs.read("/blaxel/app/config.json");
  console.log("read", content);

  const files = [
    { path: "src/app.js", content: "console.log('Hello');" },
    { path: "src/utils.js", content: "export const helper = () => {};" },
    { path: "package.json", content: '{"name": "my-app"}' },
    { path: "docs/README.md", content: "# My App" },
  ];
  await sandbox.fs.writeTree(files, "/blaxel/app");

  const { subdirectories, files: listed } = await sandbox.fs.ls("/blaxel/app");
  console.log(
    "ls",
    subdirectories.map((d) => d.name).join(","),
    listed.map((f) => f.name).join(","),
  );

  fs.writeFileSync("./image.webp", Buffer.from([82, 73, 70, 70])); // glue: a local file to upload
  const binaryData = fs.readFileSync("./image.webp");
  await sandbox.fs.writeBinary("/blaxel/app/assets/image.webp", binaryData);
  await sandbox.fs.cp("/blaxel/app/assets/image.webp", "/tmp/image.webp"); // glue
  const readBack = await sandbox.fs.readBinary("/tmp/image.webp");
  console.log("binary", readBack.size);

  await sandbox.fs.cp("/blaxel/app/config.json", "/blaxel/app/config.backup.json");
  await sandbox.fs.rm(`/blaxel/app/config.json`);
  console.log("after rm", (await sandbox.fs.ls("/blaxel/app")).files.map((f) => f.name).join(",")); // glue
} finally {
  await sandbox.delete();
}
