import { NotSupportedError } from "./errors.js";

/** A stand-in for a Blaxel export Runtime has no counterpart for. Importing
 * it works, so a module that only mentions it still loads; calling it,
 * building it or reading anything from it throws NotSupportedError naming the
 * alternative. */
export type Unsupported = {
  (...args: unknown[]): never;
  new (...args: unknown[]): never;
  readonly [key: string]: (...args: unknown[]) => never;
};

export function unsupportedExport(name: string, alternative: string): Unsupported {
  const fail = (): never => {
    throw new NotSupportedError(`Blaxel's ${name}`, alternative);
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

/** A sandbox part Runtime has no counterpart for (`sandbox.sessions`,
 * `sandbox.codegen`, ...): every method answers a rejected promise with
 * NotSupportedError naming the alternative. */
export function unsupportedPart(name: string, alternative: string): UnsupportedPart {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property === "symbol" || property === "then") return undefined;
        return () =>
          Promise.reject(
            new NotSupportedError(`Blaxel's ${name}.${String(property)}`, alternative),
          );
      },
    },
  );
}
export type UnsupportedPart = { readonly [method: string]: (...args: unknown[]) => Promise<never> };

export const SESSIONS =
  "Share a port with sandbox.previews.create({ metadata: { name }, spec: { port, public: false } }) and a token from preview.tokens.create(expiresAt); drive the sandbox itself through this SDK.";
export const CODEGEN =
  "Runtime has no hosted edit or rerank models: apply edits with sandbox.fs.write, and rank files with your own model.";
export const SCHEDULES =
  "Schedule the call from your own scheduler (cron, a queue) and run it with sandbox.process.exec.";
export const SYSTEM =
  "Runtime keeps each sandbox's agent current itself; there is nothing to upgrade.";
export const DRIVES =
  "Use a Runtime volume: create one with runtime.volumes.create({ name }) and pass volumes: [{ name, mountPath }] at create.";
