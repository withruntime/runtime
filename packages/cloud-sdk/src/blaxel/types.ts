import type { WithRuntime } from "./client.js";
import type { Env } from "./snapshot.js";

/* Blaxel's sandbox shapes, as `@blaxel/core` 0.3.23 declares them, and its
   three normalize helpers, which behave as Blaxel's do. */

export type Status =
  | "DELETING"
  | "TERMINATED"
  | "FAILED"
  | "DEACTIVATED"
  | "DEACTIVATING"
  | "UPLOADING"
  | "BUILDING"
  | "DEPLOYING"
  | "DEPLOYED"
  | "BUILT"
  | "ARCHIVING"
  | "ARCHIVED"
  | "UNARCHIVING";
export type Port = { name?: string; protocol?: "HTTP" | "TCP" | "UDP" | "TLS"; target: number };
export type EnvVar = { name: string; value: string };
export type ExpirationPolicy = {
  action?: "delete";
  type?: "ttl-idle" | "ttl-max-age" | "date";
  value?: string;
};
export type SandboxLifecycle = {
  expirationPolicies?: Array<ExpirationPolicy>;
  terminatedRetention?: string;
};
export type SandboxNetwork = {
  allowedDomains?: Array<string>;
  egress?: unknown;
  firewall?: unknown;
  forbiddenDomains?: Array<string>;
  proxy?: unknown;
  subnet?: string;
};
export type VolumeBinding = {
  name: string;
  mountPath: string;
  readOnly?: boolean;
  type?: "persistent" | "ephemeral";
  sizeMb?: number;
};
export type VolumeAttachment = {
  mountPath?: string;
  name?: string;
  readOnly?: boolean;
  sizeMb?: number;
  type?: "persistent" | "ephemeral";
};
export type Metadata = {
  name: string;
  displayName?: string;
  externalId?: string;
  labels?: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  updatedBy?: string;
  readonly plan?: string;
  readonly url?: string;
  readonly workspace?: string;
};
export type SandboxRuntime = {
  envs?: Array<Env>;
  expires?: string;
  extraArgs?: { [key: string]: string };
  image?: string;
  memory?: number;
  ports?: Array<Port>;
  terminationGracePeriodSeconds?: number;
  ttl?: string;
};
export type SandboxSpec = {
  enabled?: boolean;
  lifecycle?: SandboxLifecycle;
  network?: SandboxNetwork;
  region?: string;
  runtime?: SandboxRuntime;
  volumes?: Array<VolumeAttachment>;
  vpc?: string;
};
export type CoreEvent = {
  canaryRevision?: string;
  message?: string;
  revision?: string;
  status?: string;
  time?: string;
  type?: string;
};
export type Sandbox = {
  events?: Array<CoreEvent>;
  readonly expiresIn?: number;
  readonly lastUsedAt?: string;
  metadata: Metadata;
  spec: SandboxSpec;
  state?: "RUNNING" | "STANDBY";
  status?: Status;
};
export type SandboxConfiguration = {
  forceUrl?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
} & Sandbox;
export type SandboxCreateConfiguration = {
  name?: string;
  /** A Blaxel stock image (Runtime's stock image) or a ready Runtime image's name. */
  image?: string;
  /** MB; vCPUs follow as memory / 2048, at least 1. */
  memory?: number;
  ports?: (Port | Record<string, unknown>)[];
  envs?: EnvVar[];
  volumes?: (VolumeBinding | VolumeAttachment)[];
  ttl?: string;
  expires?: Date;
  region?: string;
  lifecycle?: SandboxLifecycle;
  network?: SandboxNetwork;
  snapshotEnabled?: boolean;
  labels?: Record<string, string>;
  extraArgs?: Record<string, string>;
  externalId?: string;
  /** Runtime-only: an explicit client, or fields for the create. */
  withruntime?: WithRuntime;
};
export type SandboxUpdateMetadata = {
  labels?: Record<string, string>;
  displayName?: string;
  externalId?: string;
};
export type SandboxUpdateNetwork = { network?: SandboxNetwork };
export interface SessionCreateOptions {
  expiresAt?: Date;
  responseHeaders?: Record<string, string>;
  requestHeaders?: Record<string, string>;
}
export interface SessionWithToken {
  name: string;
  url: string;
  token: string;
  expiresAt: Date;
}

/** Ports as Port objects, HTTP by default. */
export function normalizePorts(ports?: (Port | Record<string, unknown>)[]): Port[] | undefined {
  if (!ports || ports.length === 0) return undefined;
  return ports.map((port) => {
    if (
      typeof port !== "object" ||
      port === null ||
      !("name" in port || "target" in port || "protocol" in port)
    )
      throw new Error(
        `Invalid port type: ${typeof port}. Expected Port object or object with port properties.`,
      );
    if (typeof port.target !== "number")
      throw new Error(`Port target must be a number: ${JSON.stringify(port)}`);
    return {
      ...(typeof port.name === "string" ? { name: port.name } : {}),
      target: port.target,
      protocol: (typeof port.protocol === "string" ? port.protocol : "HTTP") as Port["protocol"],
    };
  });
}

/** Envs checked for a string name and value. */
export function normalizeEnvs(envs?: EnvVar[]): EnvVar[] | undefined {
  if (!envs || envs.length === 0) return undefined;
  return envs.map((env) => {
    if (typeof env !== "object" || env === null)
      throw new Error(
        `Invalid env type: ${typeof env}. Expected object with 'name' and 'value' keys.`,
      );
    if (!("name" in env) || !("value" in env))
      throw new Error(
        `Environment variable object must have 'name' and 'value' keys: ${JSON.stringify(env)}`,
      );
    if (typeof env.name !== "string" || typeof env.value !== "string")
      throw new Error(
        `Environment variable 'name' and 'value' must be strings: ${JSON.stringify(env)}`,
      );
    return { name: env.name, value: env.value };
  });
}

/** Volume bindings as attachments. */
export function normalizeVolumes(
  volumes?: (VolumeBinding | VolumeAttachment)[],
): VolumeAttachment[] | undefined {
  if (!volumes || volumes.length === 0) return undefined;
  return volumes.map((volume) => {
    if (typeof volume !== "object" || volume === null)
      throw new Error(
        `Invalid volume type: ${typeof volume}. Expected object with 'name' and 'mountPath' keys.`,
      );
    if (!("name" in volume) || !("mountPath" in volume))
      throw new Error(
        `Volume binding object must have 'name' and 'mountPath' keys: ${JSON.stringify(volume)}`,
      );
    if (typeof volume.name !== "string" || typeof volume.mountPath !== "string")
      throw new Error(
        `Volume binding 'name' and 'mountPath' must be strings: ${JSON.stringify(volume)}`,
      );
    const out: VolumeAttachment = {
      name: volume.name,
      mountPath: volume.mountPath,
      readOnly: volume.readOnly ?? false,
    };
    if (volume.type) out.type = volume.type;
    if (out.type === "ephemeral") {
      if (typeof volume.sizeMb !== "number" || !(volume.sizeMb > 0))
        throw new Error(
          `Ephemeral volume '${volume.name}' must have a positive 'sizeMb': ${JSON.stringify(volume)}`,
        );
      out.sizeMb = volume.sizeMb;
    } else if (typeof volume.sizeMb === "number") out.sizeMb = volume.sizeMb;
    return out;
  });
}
