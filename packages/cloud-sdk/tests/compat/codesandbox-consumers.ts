/** Identical typed statements against Runtime and the pinned published SDK. */
import ts from "typescript";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const source = `import { CodeSandbox, type Task, type Step, type CommandStatus } from '@sandbox';
export async function consumer(api: CodeSandbox) {
  const sandbox = await api.sandboxes.create();
  const client = await sandbox.connect();
  const commands = await client.commands.getAll();
  for (const command of commands) {
    const output: string = await command.open({ cols: 90, rows: 35 });
    const status: CommandStatus = command.status;
    command.onOutput((text: string) => text.toUpperCase());
    if (status === 'RUNNING') await command.restart();
    console.log(output);
  }
  const tasks: Task[] = await client.tasks.getAll();
  for (const task of tasks) {
    const automatic: boolean = task.runAtStart;
    const status: CommandStatus | 'IDLE' = task.status;
    task.onStatusChange((next: CommandStatus | 'IDLE') => console.log(next));
    await task.run();
    const output: string = await task.open({ cols: 100, rows: 40 });
    const port: { port: number; url: string } = await task.waitForPort(1000);
    await task.restart();
    await task.stop();
    console.log(automatic, status, output, port);
  }
  await client.setup.run();
  const steps: Step[] = client.setup.getSteps();
  for (const step of steps) {
    step.onOutput((text: string) => console.log(text));
    const output: string = await step.open({ cols: 100, rows: 40 });
    await step.waitUntilComplete();
    console.log(output);
  }
  await client.setup.waitUntilComplete();
  await client.disconnect();
  await client.reconnect();
}
`;
export async function checkCodeSandboxConsumers(reference?: string) {
  if (reference) {
    const pkg = JSON.parse(
      await readFile(resolve(reference, "node_modules/@codesandbox/sdk/package.json"), "utf8"),
    ) as { name: string; version: string };
    if (pkg.name !== "@codesandbox/sdk" || pkg.version !== "2.4.2")
      throw new Error("Expected pinned @codesandbox/sdk 2.4.2");
  }
  const directory = await mkdtemp(join(tmpdir(), "runtime-codesandbox-consumer-"));
  try {
    const fixture = join(directory, "consumer.ts");
    await writeFile(fixture, source);
    const entry = reference
      ? resolve(reference, "node_modules/@codesandbox/sdk/dist/esm/index.d.ts")
      : fileURLToPath(new URL("../../src/codesandbox/index.ts", import.meta.url));
    const program = ts.createProgram([fixture], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: { "@sandbox": [entry] },
      types: [],
    });
    const errors = ts.getPreEmitDiagnostics(program);
    if (errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => directory,
          getNewLine: () => "\n",
        }),
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  await checkCodeSandboxConsumers(process.argv[2]);
  console.log("CodeSandbox task/setup/command consumer declarations match.");
}
