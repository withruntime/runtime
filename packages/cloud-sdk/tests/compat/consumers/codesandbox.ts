import { CodeSandbox, type Task, type Step, type CommandStatus } from "@sandbox";
export async function consumer(api: CodeSandbox) {
  const sandbox = await api.sandboxes.create();
  const client = await sandbox.connect();
  const commands = await client.commands.getAll();
  for (const command of commands) {
    const output: string = await command.open({ cols: 90, rows: 35 });
    const status: CommandStatus = command.status;
    command.onOutput((text: string) => text.toUpperCase());
    if (status === "RUNNING") await command.restart();
    console.log(output);
  }
  const tasks: Task[] = await client.tasks.getAll();
  for (const task of tasks) {
    const automatic: boolean = task.runAtStart;
    const status: CommandStatus | "IDLE" = task.status;
    task.onStatusChange((next: CommandStatus | "IDLE") => console.log(next));
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
