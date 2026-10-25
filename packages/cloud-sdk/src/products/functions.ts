/* runtime.functions: Apps whose copies all sleep when idle, on the same
 * calls under /v1/functions (apps.ts holds both kinds). A private beta
 * (PRODUCT_BETAS): an account outside it is refused with product_in_beta
 * until Functions launches. */
export { functions } from "./apps.js";
export type { CreateFunction, RuntimeFunction, UpdateFunction } from "./apps.js";
