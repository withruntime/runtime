import { NotSupportedError } from "./errors.js";

/** A stand-in for an E2B export Runtime has no counterpart for. Importing it
 * works, so a module that only mentions it still loads; calling it, building
 * it or reading anything from it throws NotSupportedError naming the
 * alternative. */
export type Unsupported = {
  (...args: unknown[]): never;
  new (...args: unknown[]): never;
  readonly [key: string]: (...args: unknown[]) => never;
};

export function unsupportedExport(name: string, alternative: string): Unsupported {
  const fail = (): never => {
    throw new NotSupportedError(`E2B's ${name}`, alternative);
  };
  return new Proxy(function unsupported() {}, {
    apply: fail,
    construct: fail,
    get: (_target, property) => {
      // Let the module system, inspectors and promise checks look at it
      // without tripping: only a real use throws.
      if (typeof property === "symbol" || property === "then" || property === "prototype")
        return undefined;
      return fail();
    },
  }) as unknown as Unsupported;
}

const TEMPLATES =
  "Build a Runtime image instead: `npx withruntime image build --dockerfile e2b.Dockerfile --name <template>` or runtime.images.build({ name, dockerfile | recipe }), then Sandbox.create('<template>').";

export const Template = unsupportedExport("Template builder", TEMPLATES);
export const TemplateBase = unsupportedExport("TemplateBase", TEMPLATES);
export const waitForPort = unsupportedExport("waitForPort (a template ready check)", TEMPLATES);
export const waitForURL = unsupportedExport("waitForURL (a template ready check)", TEMPLATES);
export const waitForProcess = unsupportedExport(
  "waitForProcess (a template ready check)",
  TEMPLATES,
);
export const waitForFile = unsupportedExport("waitForFile (a template ready check)", TEMPLATES);
export const waitForTimeout = unsupportedExport(
  "waitForTimeout (a template ready check)",
  TEMPLATES,
);
export const Volume = unsupportedExport(
  "Volume",
  "Use runtime.volumes (Runtime volumes) and mount one with runtime: { create: { volumes: [{ volumeId, path }] } }.",
);
export const Secret = unsupportedExport(
  "Secret",
  "Use a Runtime secret: `npx withruntime secrets set NAME --host api.example.com`. The sandbox sees a placeholder, and the egress proxy adds the value on HTTPS to that host.",
);
export const SecretPaginator = unsupportedExport(
  "SecretPaginator",
  "List Runtime secrets with `npx withruntime secrets ls` or runtime.secrets.list().",
);
export const Git = unsupportedExport(
  "git module (deprecated by E2B too)",
  "Run git with sandbox.commands.run('git ...'); git is installed.",
);
export const ReadyCmd = unsupportedExport("ReadyCmd (a template ready check)", TEMPLATES);
export const LogEntry = unsupportedExport("LogEntry (template build logs)", TEMPLATES);
export const LogEntryStart = unsupportedExport("LogEntryStart (template build logs)", TEMPLATES);
export const LogEntryEnd = unsupportedExport("LogEntryEnd (template build logs)", TEMPLATES);
export const defaultBuildLogger = unsupportedExport(
  "defaultBuildLogger (template build logs)",
  TEMPLATES,
);
const ENDPOINTS =
  "This package talks only to Runtime's API through the sandbox's own methods; sandbox.runtime is the Runtime sandbox underneath.";
export const ConnectionConfig = unsupportedExport("ConnectionConfig", ENDPOINTS);
export const ApiClient = unsupportedExport("ApiClient (E2B's REST client)", ENDPOINTS);
export const getSignature = unsupportedExport(
  "getSignature (signed file URLs)",
  "Use sandbox.files.read and sandbox.files.write.",
);
/** E2B's "every address" network selector, as E2B defines it. */
export const ALL_TRAFFIC = "0.0.0.0/0";
/** E2B's volume entry types, as E2B defines them. */
export enum VolumeFileType {
  UNKNOWN = "unknown",
  FILE = "file",
  DIRECTORY = "directory",
  SYMLINK = "symlink",
}
