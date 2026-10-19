/** Containers: one OCI image's process on its own microVM, billed at the
 * sandbox rates (packages/cloud/src/api/products/containers.ts), at
 * /v1/containers. In a private beta: an account outside it is refused with
 * product_in_beta (403), and retrying does not change it. */
import type { Transport } from "../transport.js";
import { resource, type ResourceRecord } from "./resources.js";

export type ContainerState =
  "waiting" | "running" | "sleeping" | "stopped" | "failed" | "deleting" | "deleted";
export type Container = ResourceRecord & {
  name: string | null;
  labels: Record<string, string>;
  state: ContainerState;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** The image it runs, pinned to its digest (name@sha256:...). */
  image: string;
  entrypoint: string[];
  command: string[];
  workingDir: string;
  user: string;
  /** The TCP port it serves on, or null when it serves none. */
  port: number | null;
  /** The image's exposed ports, as N/tcp or N/udp. */
  exposedPorts: string[];
  onExit: "restart" | "stop";
  sleep: boolean;
  vcpu: number;
  memoryMiB: number;
  /** The environment's names. Values are never answered: they may be secrets. */
  envNames: string[];
};
export type CreateContainer = {
  /** An OCI image reference; the answer pins its digest. */
  image: string;
  /** 1 to 16. */
  vcpu: number;
  /** 128 to 65536 MiB. */
  memoryMiB: number;
  name?: string;
  labels?: Record<string, string>;
  /** Replaces the image's Entrypoint and drops its Cmd. */
  entrypoint?: string[];
  /** Replaces the image's Cmd; keeps the effective entrypoint. */
  command?: string[];
  /** Set over the image's own environment. */
  env?: Record<string, string>;
  /** An absolute path; the image's, else /. */
  workingDir?: string;
  /** The image's, else root. */
  user?: string;
  /** 1 to 65535. Required when the image exposes several TCP ports. */
  port?: number;
  /** Default: restart when it serves a port, otherwise stop. */
  onExit?: "restart" | "stop";
  /** Sleep when idle; false by default. */
  sleep?: boolean;
};
/** Only the name and labels change; a null name clears it. */
export type UpdateContainer = { name?: string | null; labels?: Record<string, string> };

/** A wait ends at its target or at one of these, with the container's error. */
const SETTLED: ContainerState[] = ["failed", "deleted"];

export function containers(t: Transport) {
  return resource<Container, CreateContainer, UpdateContainer>(t, "containers", SETTLED);
}
