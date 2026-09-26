import { expect, test } from "bun:test";
import pkg from "../package.json";
import server from "../server.json";

test("the MCP registry entry names the package and version npm will have", () => {
  expect(pkg.mcpName).toBe(server.name);
  expect(server.version).toBe(pkg.version);
  const [npm] = server.packages;
  expect(npm).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version });
});
