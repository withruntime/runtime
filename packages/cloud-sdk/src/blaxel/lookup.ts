import type { Runtime } from "../client.js";
import { RuntimeError } from "../errors.js";
import type { RuntimeCreate, RuntimeSandbox } from "./client.js";

/* Finding a Blaxel sandbox on Runtime, and the labels that carry what Runtime
   has no field for. The labels are the adapter's own: `metadata.labels`
   shows only the caller's. */

/** Labels the adapter keeps on a sandbox, under this prefix; the Python
 * adapter uses the same keys, so either reads what the other wrote: image,
 * memory, ports ("3000,8080"), region, ttl, expires (ISO), lifecycle (JSON),
 * externalId, displayName, archived ("1"), preview.<name> (its port) and
 * idlePauseSeconds (the idle pause to give back after keepAlive processes). */
export const LABEL = "blaxel/";
export const EXTERNAL_ID = `${LABEL}externalId`;
export const DISPLAY_NAME = `${LABEL}displayName`;
export const ARCHIVED = `${LABEL}archived`;
export const IDLE_PAUSE = `${LABEL}idlePauseSeconds`;
/** A named preview: `blaxel/preview.<name>` holds its port. */
export const PREVIEW = `${LABEL}preview.`;
const OWN = /^blaxel\//;

/** The caller's labels, without the adapter's. */
export function userLabels(labels: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !OWN.test(key)));
}
/** The adapter's labels, without the caller's. */
export function ownLabels(labels: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => OWN.test(key)));
}

/** How a Blaxel sandbox behaves on Runtime: it pauses (Blaxel's standby)
 * after the shortest idle time Runtime allows, wakes by itself on the next
 * call, and pauses rather than ends when its lease runs out. */
export const STANDBY = {
  idlePauseSeconds: 60,
  autoWake: true,
} satisfies Partial<RuntimeCreate>;
/** Runtime's longest time limit. A sandbox made before 0300 has it, and the
 * adapter renews it while the sandbox is used; one made since has none. */
export const LEASE_SECONDS = 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The live sandbox with this name (or Runtime id): one call. A 404 when
 * there is none, as Blaxel answers. */
export async function findSandbox(client: Runtime, name: string): Promise<RuntimeSandbox> {
  if (UUID.test(name)) return client.sandboxes.get(name);
  const page = await client.sandboxes.list({ name });
  const found = page.data.filter((one) => one.state !== "stopped").at(-1);
  if (!found) throw notFound(`Sandbox ${name} was not found.`);
  return found;
}

/** The newest live sandbox carrying `externalId`. */
export async function findByExternalId(
  client: Runtime,
  externalId: string,
): Promise<RuntimeSandbox> {
  const page = await client.sandboxes.list({ labels: { [EXTERNAL_ID]: externalId } });
  const found = page.data.filter((one) => one.state !== "stopped").at(-1);
  if (!found) throw notFound(`No sandbox has the external id ${externalId}.`);
  return found;
}

/** Runs a create or fork that names a sandbox. When the name is still held
 * by a sandbox that is stopping (deleted a moment ago, by this client or
 * another), waits for it to stop, up to 30 seconds, and runs it once more.
 * This reconciles Runtime's stopping-name conflicts. Blaxel 0.3.25 delegates
 * createIfNotExists reconciliation to its control plane without client polling. */
export async function whenNameFree<T>(client: Runtime, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const holder = error instanceof RuntimeError ? error.details?.sandboxId : undefined;
    if (
      !(error instanceof RuntimeError) ||
      error.code !== "name_taken" ||
      error.details?.state !== "stopping" ||
      typeof holder !== "string"
    )
      throw error;
    const stopping = await client.sandboxes.get(holder);
    await stopping.waitFor("stopped", { timeoutSeconds: 30 });
    return work();
  }
}

function notFound(message: string) {
  return new RuntimeError({
    message,
    code: "not_found",
    status: 404,
    hint: "SandboxInstance.createIfNotExists({ name }) makes it when it is missing.",
  });
}
