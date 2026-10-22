import { DELIBERATE, type RuntimeError } from "./errors.js";

/** A product switched off on this deployment, by its `<product>_unavailable`
 * code: a 501, or a 503 with a deliberate code from an older server (whose
 * host_unavailable and api_unavailable are 503s too, and pass). */
export function productSwitchedOff(error: RuntimeError): boolean {
  return (
    error.code.endsWith("_unavailable") &&
    (error.status === 501 || (error.status === 503 && DELIBERATE.has(error.code)))
  );
}
