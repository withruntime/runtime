/** Desktops: a Linux desktop on its own sandbox, billed at the sandbox rates
 * (packages/cloud/src/api/products/desktops.ts), at /v1/desktops, with a
 * private live view and computer use: screenshot and act. In a private beta:
 * an account outside it is refused with product_in_beta (403), and retrying
 * does not change it. */
import type { RequestOptions, Transport } from "../transport.js";
import { enc, resource, type ResourceRecord } from "./resources.js";

export type DesktopState = "starting" | "running" | "paused" | "stopped" | "failed" | "deleted";
export type Desktop = ResourceRecord & {
  name: string | null;
  labels: Record<string, string>;
  state: DesktopState;
  sandboxId: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  memoryMiB: number;
  vcpu: number;
  width: number;
  height: number;
  timeoutSeconds: number;
  idlePauseSeconds: number;
  /** Opens the live desktop in a browser; carries a private preview token. */
  liveViewUrl?: string;
  /** When liveViewUrl's token ends; get the desktop again for a fresh one. */
  expiresAt: string | null;
  actions: { screenshot: string; act: string; record: string };
};
export type CreateDesktop = {
  /** 1024–16384 MiB; the server defaults to 2048. */
  memoryMiB?: number;
  /** The server defaults to 2 vCPU. */
  vcpu?: number;
  /** The screen, 640x480 to 3840x2160; 1280x800 by default. */
  width?: number;
  height?: number;
  timeoutSeconds?: number;
  idlePauseSeconds?: number;
  name?: string;
  labels?: Record<string, string>;
};
/** Only the name and labels change; a null name clears it. */
export type UpdateDesktop = { name?: string | null; labels?: Record<string, string> };
/** One computer-use step, as POST /v1/desktops/{id}:act takes it. */
export type DesktopAct = { action: string } & Record<string, unknown>;

/** A wait ends at its target or at one of these, with the desktop's error. */
const SETTLED: DesktopState[] = ["failed", "deleted"];

export function desktops(t: Transport) {
  return {
    ...resource<Desktop, CreateDesktop, UpdateDesktop>(t, "desktops", SETTLED),
    /** The screen as PNG (or JPEG) bytes. A write: it runs in the desktop's
     * sandbox and wakes a paused one, so a read-only key is refused it. */
    screenshot(
      id: string,
      shot: { format?: "png" | "jpeg"; quality?: number } = {},
      options?: RequestOptions,
    ) {
      return t.bytes({
        method: "POST",
        path: `/v1/desktops/${enc(id)}:screenshot`,
        body: shot,
        ...options,
      });
    },
    /** Move, click, drag, scroll, type, press keys, open a URL or launch a program. */
    act(id: string, step: DesktopAct, options?: RequestOptions) {
      return t.json<Record<string, unknown>>({
        method: "POST",
        path: `/v1/desktops/${enc(id)}:act`,
        body: step,
        ...options,
      });
    },
  };
}
