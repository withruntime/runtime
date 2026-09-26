import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { pipeShellInput } from "../src/cli-extras";

/* 25 September 2026: `echo | runtime sandbox shell <id>` waited forever: the
   end of piped input never reached the shell. It now arrives as Ctrl-D, as a
   terminal (and ssh) would send it. */

function feed(chunks: string[], tty = false) {
  const stdin = Object.assign(new PassThrough(), tty ? { isTTY: true } : {});
  const sent: string[] = [];
  const unhook = pipeShellInput(stdin, {
    write: (data) => sent.push(typeof data === "string" ? data : new TextDecoder().decode(data)),
  });
  return new Promise<string[]>((resolve) => {
    stdin.on("end", () => setTimeout(() => (unhook(), resolve(sent)), 0));
    for (const chunk of chunks) stdin.write(chunk);
    stdin.end();
    stdin.resume();
  });
}

test("piped input that ends closes the shell with Ctrl-D", async () => {
  expect((await feed(["ls\n", "exit_code=$?\n"])).join("")).toBe("ls\nexit_code=$?\n\x04");
  expect((await feed([])).join("")).toBe("\x04"); // `echo -n | runtime sandbox shell`
});

test("a last line with no newline is run before the Ctrl-D", async () => {
  expect((await feed(["ls"])).join("")).toBe("ls\n\x04");
});

test("a keyboard's input is passed through and never closed for it", async () => {
  expect((await feed(["ls\n"], true)).join("")).toBe("ls\n");
});
