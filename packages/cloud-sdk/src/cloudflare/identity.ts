/** A Durable Object ID includes its namespace; a display name does not. */
export function workerSandboxIdentity(
  objectId: string,
  stored: { nativeSandboxId?: string; sandboxName?: { name: string } },
): string {
  if (stored.nativeSandboxId !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(stored.nativeSandboxId))
      throw new Error("The stored Runtime sandbox identity is invalid");
    return stored.nativeSandboxId;
  }
  if (stored.sandboxName)
    throw new Error(
      "This legacy Durable Object has no namespace-safe Runtime identity. Retain its existing sandbox and migrate its identity explicitly before using it.",
    );
  if (!/^[a-f0-9]{64}$/.test(objectId)) throw new Error("The Durable Object identity is invalid");
  return `cf-do-${objectId}`;
}
