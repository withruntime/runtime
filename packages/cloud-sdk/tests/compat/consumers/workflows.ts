import Runloop from "@compat/runloop";
import { CodeSandbox } from "@compat/codesandbox";
import { SpritesClient } from "@compat/sprites";
import { Freestyle } from "@compat/freestyle";
import { ModalClient } from "@compat/modal";
import type { Sandbox as CloudflareSandbox } from "@compat/cloudflare";

export async function runloop(client: Runloop) {
  const box = await client.devboxes.createAndAwaitRunning({
    environment_variables: { HELLO: "world" },
  });
  await client.devboxes.writeFileContents(box.id, {
    file_path: "/workspace/config.txt",
    contents: "hello",
  });
  const text: string = await client.devboxes.readFileContents(box.id, {
    file_path: "/workspace/config.txt",
  });
  const execution = await client.devboxes.executeAsync(box.id, {
    command: "cat /workspace/config.txt",
    attach_stdin: true,
  });
  const result = await client.devboxes.executions.awaitCompleted(box.id, execution.execution_id);
  const exit: number | null | undefined = result.exit_status;
  await client.devboxes.shutdown(box.id);
  return { text, exit };
}
export async function codesandbox(client: CodeSandbox) {
  const box = await client.sandboxes.create({ title: "agent project", privacy: "public" });
  const session = await box.connect();
  await session.fs.writeTextFile(".env", "HELLO=world");
  const text: string = await session.fs.readTextFile(".env");
  const command = await session.commands.runBackground("echo ready");
  command.onOutput((output: string) => output.toUpperCase());
  const result: string = await command.waitUntilComplete();
  const port = await session.ports.waitForPort(3000, { timeoutMs: 5000 });
  const host: string = port.host;
  await session.disconnect();
  await client.sandboxes.delete(box.id);
  return { text, result, host };
}
export async function sprites(client: SpritesClient) {
  const sprite = await client.createSprite("agent");
  const fs = sprite.filesystem("/workspace");
  await fs.writeFile(".env", "HELLO=world");
  const text: string = await fs.readFile(".env", "utf8");
  const bytes: Buffer = await fs.readFile(".env", null);
  const names = await fs.readdir(".");
  const source: string[] = names.filter((name) => name.endsWith(".ts"));
  const entries = await fs.readdir(".", { withFileTypes: true });
  const directory: boolean | undefined = entries[0]?.isDirectory();
  const command = sprite.spawn("bash", ["-c", "echo hello"]);
  command.stdout.on("data", (chunk: Buffer) => chunk.toString());
  const code: number = await command.wait();
  await sprite.delete();
  return { text, bytes, source, directory, code };
}
export async function freestyle(client: Freestyle) {
  const { vm, vmId } = await client.vms.create({ firewall: { rules: [] } });
  await vm.fs.writeTextFile("/workspace/.env", "HELLO=world");
  const text: string = await vm.fs.readTextFile("/workspace/.env");
  const result = await vm.exec({ command: "echo hello", env: { HELLO: "world" } });
  const status: number | null | undefined = result.statusCode;
  const snapshot = await vm.snapshot();
  const source: string | null = snapshot.sourceVmId;
  const id: string = snapshot.snapshot.id;
  await vm.delete();
  return { vmId, text, status, source, id };
}
export async function modal(client: ModalClient) {
  const app = await client.apps.fromName("agent", { createIfMissing: true });
  const image = client.images
    .fromRegistry("python:3.13")
    .dockerfileCommands(["RUN pip install requests"]);
  const sandbox = await client.sandboxes.create(app, image, {
    timeoutMs: 300000,
    command: ["sleep", "infinity"],
  });
  const process = await sandbox.exec(["cat"]);
  await process.stdin.writeText("hello");
  await process.stdin.close();
  const text: string = await process.stdout.readText();
  const code: number = await process.wait();
  await sandbox.filesystem.writeBytes(new Uint8Array([0, 255]), "/tmp/data");
  const bytes: Uint8Array = await sandbox.filesystem.readBytes("/tmp/data");
  await sandbox.terminate();
  return { text, code, bytes };
}
export async function cloudflare(sandbox: CloudflareSandbox) {
  const result = await sandbox.exec("echo hello", {
    stream: true,
    onOutput: (stream, text) => text.toUpperCase(),
  });
  const code: number = result.exitCode;
  await sandbox.writeFile(".env", "HELLO=world");
  const read = await sandbox.readFile(".env", { encoding: "utf8" });
  const text: string = read.content;
  const session = await sandbox.createSession({ id: "agent", env: { HELLO: "world" } });
  const process = await session.startProcess("echo ready");
  await process.waitForExit(30000);
  await sandbox.destroy();
  return { code, text };
}

import { Sandbox as E2BSandbox } from "@compat/e2b";
import { Sandbox as InterpreterSandbox } from "@compat/e2b-interpreter";
import { Daytona } from "@compat/daytona";
import { Sandbox as VercelSandbox } from "@compat/vercel";
import { SandboxInstance } from "@compat/blaxel";

export async function e2b() {
  const sandbox = await E2BSandbox.create({ timeoutMs: 300000, envs: { HELLO: "world" } });
  await sandbox.files.write("/home/user/.env", "HELLO=world");
  const text: string = await sandbox.files.read("/home/user/.env");
  const bytes: Uint8Array = await sandbox.files.read("/home/user/.env", { format: "bytes" });
  const watcher = await sandbox.files.watchDir("/home/user", (event) => {
    const path: string = event.name;
    return void path;
  });
  const command = await sandbox.commands.run("echo hello", {
    background: true,
    onStdout: (text) => {
      text.toUpperCase();
    },
  });
  const result = await command.wait();
  const code: number = result.exitCode;
  await watcher.stop();
  await sandbox.kill();
  return { text, bytes, code };
}
export async function interpreter() {
  const sandbox = await InterpreterSandbox.create();
  const context = await sandbox.createCodeContext({ language: "python" });
  const execution = await sandbox.runCode("x = 2; x + 3", {
    context,
    onStdout: (output) => {
      const text: string = output.line;
      return void text;
    },
  });
  const logs: string[] = execution.logs.stdout;
  await sandbox.removeCodeContext(context);
  await sandbox.kill();
  return logs;
}
export async function daytona(client: Daytona) {
  const sandbox = await client.create({ language: "python", envVars: { HELLO: "world" } });
  await sandbox.fs.uploadFile(Buffer.from("hello"), "/home/daytona/.env");
  const bytes: Buffer = await sandbox.fs.downloadFile("/home/daytona/.env");
  const result = await sandbox.process.executeCommand(
    "echo hello",
    "/home/daytona",
    { HELLO: "world" },
    30,
  );
  const code: number = result.exitCode;
  await sandbox.process.createSession("agent");
  const command = await sandbox.process.executeSessionCommand("agent", {
    command: "echo hello",
    runAsync: true,
  });
  const id: string | undefined = command.cmdId;
  await sandbox.process.deleteSession("agent");
  await client.delete(sandbox);
  return { bytes, code, id };
}
export async function vercel() {
  const sandbox = await VercelSandbox.create({ runtime: "node24", timeout: 300000 });
  await sandbox.writeFiles([{ path: "/vercel/sandbox/.env", content: Buffer.from("hello") }]);
  const bytes: Buffer | null = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/.env" });
  const command = await sandbox.runCommand({ cmd: "echo", args: ["hello"], detached: true });
  const result = await command.wait();
  const code: number = result.exitCode;
  const output: string = await result.stdout();
  await sandbox.stop();
  return { bytes, code, output };
}
export async function blaxel() {
  const sandbox = await SandboxInstance.create({ name: "agent" });
  await sandbox.fs.write("/workspace/.env", "hello");
  const text: string = await sandbox.fs.read("/workspace/.env");
  await sandbox.fs.writeBinary("/workspace/data", Uint8Array.of(0, 255));
  const bytes: Blob = await sandbox.fs.readBinary("/workspace/data");
  const watcher = sandbox.fs.watch(
    "/workspace",
    (event) => {
      const name: string = event.name;
      return void name;
    },
    { withContent: true },
  );
  const command = await sandbox.process.exec({ command: "echo hello", waitForCompletion: false });
  const result = await sandbox.process.wait(command.pid);
  const code: number = result.exitCode;
  watcher.close();
  await sandbox.delete();
  return { text, bytes, code };
}
