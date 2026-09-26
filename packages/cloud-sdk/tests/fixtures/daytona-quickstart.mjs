// Daytona's TypeScript quickstart and its process, session and file-system
// guides (daytona.io/docs, checked 23 September 2026), as their docs show them.
// scripts/dropin-e2e.ts runs it on Runtime with only the import changed.
/* global Buffer, console */
import { Daytona } from "@daytona/sdk";

const daytona = new Daytona();
const sandbox = await daytona.create({ language: "typescript" });

try {
  let response = await sandbox.process.codeRun('console.log("Hello from TypeScript")');
  console.log(response.result);

  response = await sandbox.process.executeCommand('echo "Hello, World!"');
  console.log(response.exitCode, response.result);

  await sandbox.fs.uploadFile(Buffer.from("Hello, World!"), "example.txt");
  const content = await sandbox.fs.downloadFile("example.txt");
  console.log(content.toString());

  const sessionId = "interactive-session";
  await sandbox.process.createSession(sessionId);
  await sandbox.process.executeSessionCommand(sessionId, { command: "export STEP=two" });
  const command = await sandbox.process.executeSessionCommand(sessionId, {
    command: "echo step one && sleep 1 && echo step $STEP",
    runAsync: true,
  });
  await sandbox.process.getSessionCommandLogs(
    sessionId,
    command.cmdId,
    (stdout) => console.log("[STDOUT]:", stdout.trim()),
    (stderr) => console.log("[STDERR]:", stderr.trim()),
  );
  await sandbox.process.deleteSession(sessionId);
} finally {
  await sandbox.delete();
}
