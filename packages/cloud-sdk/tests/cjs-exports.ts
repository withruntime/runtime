/* What each of package.json's exports must hand a CommonJS caller, by name:
   cjs-require.e2e.test.ts requires each from a real build on main's check,
   and package-files.test.ts holds this list to the manifest's exports on
   every pull request's, so a new export without its name here fails there
   and not first on main (withruntime/browsers and /desktops, 25 October
   2026). */

export const expected: Record<string, string> = {
  withruntime: "Sandbox",
  "withruntime/tools": "sandboxTools",
  "withruntime/ai": "runtimeTools",
  "withruntime/ai-harness": "createRuntimeSandbox",
  "withruntime/openai-agents": "RuntimeCloudSandboxClient",
  "withruntime/claude-agent-sdk": "runtimeMcpServer",
  "withruntime/e2b": "Sandbox",
  "withruntime/e2b/code-interpreter": "Sandbox",
  "withruntime/daytona": "Daytona",
  "withruntime/vercel": "Sandbox",
  "withruntime/blaxel": "SandboxInstance",
  "withruntime/runloop": "Runloop",
  "withruntime/codesandbox": "CodeSandbox",
  "withruntime/sprites": "SpritesClient",
  "withruntime/fly": "machinesApi",
  "withruntime/freestyle": "Freestyle",
  "withruntime/morph": "MorphCloudClient",
  "withruntime/modal": "ModalClient",
  "withruntime/cloudflare": "getSandbox",
  "withruntime/sandboxes": "sandboxes",
  "withruntime/snapshots": "snapshots",
  "withruntime/images": "images",
  "withruntime/volumes": "volumes",
  "withruntime/jobs": "jobs",
  "withruntime/domains": "domains",
  "withruntime/ports": "ports",
  "withruntime/ips": "ips",
  "withruntime/networks": "networks",
  "withruntime/agents": "agents",
  "withruntime/containers": "containers",
  "withruntime/apps": "apps",
  "withruntime/builds": "builds",
  "withruntime/ci": "ci",
  "withruntime/browsers": "browsers",
  "withruntime/desktops": "desktops",
};
