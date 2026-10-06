import { expect, test } from "bun:test";
import * as codeInterpreter from "../../src/e2b/code-interpreter";
import * as e2b from "../../src/e2b/index";

/* Every name `e2b` 2.52.1 and `@e2b/code-interpreter` 2.8.0 export, read from
   their published builds on 5 October 2026. An import of any of them must
   resolve after the switch, or code written for E2B fails to load before it
   runs a line: until then GitAuthError, VolumeError, SecretPaginator and
   eighteen more were missing. */
const E2B_2_52_1 = [
  "ALL_TRAFFIC",
  "ApiClient",
  "AuthenticationError",
  "BuildError",
  "CommandExitError",
  "ConnectionConfig",
  "E2B",
  "FileNotFoundError",
  "FileType",
  "FileUploadError",
  "FilesystemEventType",
  "Git",
  "GitAuthError",
  "GitUpstreamError",
  "InvalidArgumentError",
  "LogEntry",
  "LogEntryEnd",
  "LogEntryStart",
  "NotEnoughSpaceError",
  "NotFoundError",
  "RateLimitError",
  "ReadyCmd",
  "Sandbox",
  "SandboxError",
  "SandboxNotFoundError",
  "Secret",
  "SecretError",
  "SecretNotFoundError",
  "SecretPaginator",
  "ServiceBusyError",
  "Template",
  "TemplateBase",
  "TemplateError",
  "TimeoutError",
  "Volume",
  "VolumeError",
  "VolumeFileType",
  "VolumeNotFoundError",
  "VolumePathNotFoundError",
  "default",
  "defaultBuildLogger",
  "getSignature",
  "waitForFile",
  "waitForPort",
  "waitForProcess",
  "waitForTimeout",
  "waitForURL",
];
/* The code interpreter's own names, beside everything e2b exports but ALL_TRAFFIC. */
const CODE_INTERPRETER_2_8_0 = E2B_2_52_1.filter((name) => name !== "ALL_TRAFFIC");

test("withruntime/e2b exports every name e2b 2.52.1 does", () => {
  const ours = new Set(Object.keys(e2b));
  expect(E2B_2_52_1.filter((name) => !ours.has(name))).toEqual([]);
});

test("withruntime/e2b/code-interpreter exports every name @e2b/code-interpreter 2.8.0 does", () => {
  const ours = new Set(Object.keys(codeInterpreter));
  expect(CODE_INTERPRETER_2_8_0.filter((name) => !ours.has(name))).toEqual([]);
});

test("the new errors keep E2B's parents, so a catch written for E2B still catches", () => {
  expect(new e2b.GitAuthError("x")).toBeInstanceOf(e2b.AuthenticationError);
  expect(new e2b.GitUpstreamError("x")).toBeInstanceOf(e2b.SandboxError);
  expect(new e2b.FileUploadError("x")).toBeInstanceOf(e2b.BuildError);
  expect(new e2b.VolumeNotFoundError("x")).toBeInstanceOf(e2b.VolumeError);
  expect(new e2b.VolumePathNotFoundError("x")).toBeInstanceOf(e2b.VolumeError);
  expect(new e2b.SecretNotFoundError("x")).toBeInstanceOf(e2b.SecretError);
  expect(e2b.ALL_TRAFFIC).toBe("0.0.0.0/0");
});
