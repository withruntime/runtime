import { test } from "bun:test";
import { checkConsumers } from "./check-consumers.js";
test("unchanged typed sandbox consumer bodies compile against all ten providers and the E2B interpreter", async () => {
  await checkConsumers();
}, 30000);
