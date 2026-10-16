import type { Transport } from "../transport.js";
import { resource, type ResourceRecord } from "./resources.js";

/** Private until launch: load balancers and the inbound firewall
 * (packages/cloud/src/api/products/balancers.ts). A change answers
 * `applying`; it is `active` once every router serves it, and `waitingOn`
 * names any router that does not yet. */
export type AddressState = "applying" | "active" | "failed" | "deleting" | "deleted";
type Common = ResourceRecord & {
  name: string | null;
  labels: Record<string, string>;
  state: AddressState;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Routers that do not yet serve the newest change. */
  waitingOn: string[];
};
/** A sandbox with the port it serves on, or an App or Function by id. */
export type BalancerTarget = { id: string; port?: number };
export type Balancer = Common & { hostname: string; targets: BalancerTarget[] };
export type CreateBalancer = {
  name?: string;
  labels?: Record<string, string>;
  /** Up to 1000, all the organization's own. */
  targets?: BalancerTarget[];
};
export type UpdateBalancer = {
  name?: string | null;
  labels?: Record<string, string>;
  /** Replaces the whole list. */
  targets?: BalancerTarget[];
};
export type FirewallRule = Common & {
  address: string;
  effect: "allow" | "deny" | "limit";
  source?: string;
  ports?: string;
  requests?: number;
  seconds?: number;
  burst?: number;
  priority: number;
};
export type CreateFirewallRule = {
  name?: string;
  labels?: Record<string, string>;
  /** The load balancer it guards. */
  address: string;
  priority?: number;
} & (
  | { effect: "allow" | "deny"; source?: string; ports?: string }
  | { effect: "limit"; requests: number; seconds: number; burst?: number }
);
export type UpdateFirewallRule = { name?: string | null; labels?: Record<string, string> };

const SETTLED: AddressState[] = ["failed", "deleted"];

export function balancers(t: Transport) {
  return resource<Balancer, CreateBalancer, UpdateBalancer>(t, "balancers", SETTLED);
}

export function firewall(t: Transport) {
  return resource<FirewallRule, CreateFirewallRule, UpdateFirewallRule>(
    t,
    "firewall/rules",
    SETTLED,
  );
}
