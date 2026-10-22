/** The method and option inventory of each pinned sandbox package against its
 * Runtime adapter. Reads the hash-verified sources from `compat:prepare`
 * without running them: npm declarations through the TypeScript checker,
 * Python sources through Python's own parser.
 *
 * Every public class member, exported function and option key of an
 * upstream entry point is one item. An item is `present` when the adapter
 * declares the same class and member (or option key), `refused` when the
 * adapter's member starts by throwing (TypeScript `CompatibilityError`, Python
 * `raise`), or when the option's key is named in a throw's condition; an
 * export made by `refused()` (TypeScript and Python) refuses all under it. It is
 * `missing` otherwise. Scope lists keep each provider to its sandbox surface:
 * Modal is CPU sandboxes, not Functions or GPUs.
 *
 *   bun scripts/compat-inventory.ts <cache> --write   new pins: rebuild both sides
 *   bun scripts/compat-inventory.ts --write           adapter changed: refresh its side
 *   ... --only freestyle,prime                         only these providers
 *
 * `tests/compat/inventory.test.ts` recomputes the adapter side offline from
 * the committed upstream lists: it fails when an item recorded as present or
 * refused is now missing, and when the committed counts are stale. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

export type Status = "present" | "refused" | "missing";
/** Item key → kind; an option is `Class.member(key)`, a constructor `Class.new(key)`. */
type Surface = Map<string, Status | "upstream">;

type Source = {
  provider: string;
  language: "typescript" | "python";
  /** Upstream package directory below the cache, and its entry. */
  upstream: { dir: string; entry: string };
  /** Runtime adapter entry, relative to the repository. */
  runtime: string;
  /** Exported names and `Class.member` prefixes outside the sandbox
   * contract: other products of the vendor's platform, low-level transports
   * and helpers. Everything else the entry exports is counted. */
  outside: readonly string[];
  /** Classes a caller constructs; other constructors are the SDK's own wiring. */
  constructed: readonly string[];
};

/** Runloop's other products (agents, axons, storage objects, MCP and
 * gateway configs, account secrets, keys and accounts), its raw HTTP verbs,
 * and the aliases that name its client twice. Devboxes, blueprints,
 * snapshots and network policies stay counted. */
const RUNLOOP_PRODUCTS = ["Agent", "Axon", "StorageObject", "McpConfig", "GatewayConfig", "Secret"];
const RUNLOOP_OUTSIDE = [
  "default",
  "RunloopAPI",
  "SecretById",
  "AxonSqlOps",
  ...RUNLOOP_PRODUCTS.flatMap((name) => [
    name,
    `${name}Ops`,
    `RunloopSDK.${name}`,
    `RunloopSDK.${name}Ops`,
  ]),
  "RunloopSDK.SecretById",
  "RunloopSDK.Client",
  ...["agent", "axon", "storageObject", "mcpConfig", "gatewayConfig", "secret"].map(
    (name) => `RunloopSDK.${name}`,
  ),
  ...[
    "Accounts",
    "Agents",
    "Apikeys",
    "Axons",
    "Objects",
    "McpConfigs",
    "GatewayConfigs",
    "Secrets",
    "RestrictedKeys",
  ].flatMap((name) => [`Runloop.${name}`, `Runloop.${name[0]!.toLowerCase()}${name.slice(1)}`]),
  ...[
    "AgentViewsAgentsCursorIDPage",
    "AgentsCursorIDPage",
    "AxonViewsAxonsCursorIDPage",
    "AxonsCursorIDPage",
    "GatewayConfigViewsGatewayConfigsCursorIDPage",
    "GatewayConfigsCursorIDPage",
    "McpConfigViewsMcpConfigsCursorIDPage",
    "McpConfigsCursorIDPage",
    "ObjectViewsObjectsCursorIDPage",
    "ObjectsCursorIDPage",
  ].map((name) => `Runloop.${name}`),
  ...[
    "buildRequest",
    "buildURL",
    "fetchWithTimeout",
    "request",
    "requestAPIList",
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "getAPIList",
  ].map((name) => `Runloop.${name}`),
  // Python's names for the same.
  ...[
    "agents",
    "axons",
    "objects",
    "mcp_configs",
    "gateway_configs",
    "secrets",
    "accounts",
    "api_keys",
    "restricted_keys",
  ].map((name) => `Runloop.${name}`),
];

const ROOT = resolve(import.meta.dir, "../../..");
export const SOURCES: readonly Source[] = [
  {
    provider: "codesandbox",
    language: "typescript",
    upstream: { dir: "npm/%40codesandbox%2Fsdk@2.4.2/package", entry: "dist/esm/index.d.ts" },
    runtime: "packages/cloud-sdk/src/codesandbox/index.ts",
    constructed: ["CodeSandbox"],
    // API is the generated REST client the SDK wraps.
    outside: ["API", "DEFAULT_SUBSCRIPTIONS", "DEFAULT_SHELL_SIZE"],
  },
  {
    provider: "sprites",
    language: "typescript",
    upstream: { dir: "npm/%40fly%2Fsprites@0.2.3/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/sprites/index.ts",
    constructed: ["SpritesClient"],
    outside: ["ERR_CODE_CREATION_RATE_LIMITED", "ERR_CODE_CONCURRENT_LIMIT_EXCEEDED"],
  },
  {
    provider: "sprites-python",
    language: "python",
    upstream: { dir: "pypi/sprites-py@0.7.2", entry: "sprites" },
    runtime: "sdks/python/withruntime/sprites",
    constructed: ["SpritesClient", "AsyncSpritesClient"],
    outside: [],
  },
  {
    provider: "freestyle",
    language: "typescript",
    upstream: { dir: "npm/freestyle@0.2.20/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/freestyle/index.ts",
    constructed: ["Freestyle"],
    // Domains and identities are Freestyle's hosting and IAM products;
    // FreestyleClient and segment are its raw HTTP layer.
    outside: [
      "FreestyleClient",
      "segment",
      "DEFAULT_BASE_URL",
      "API_VERSION_PREFIX",
      "DomainsNamespace",
      "DomainVerificationsNamespace",
      "DomainCertificatesNamespace",
      "DomainPlaceholderNamespace",
      "IdentityTokensNamespace",
      "IdentityVmPermissionsNamespace",
      "Identity",
      "IdentitiesNamespace",
      "hasIdentity",
      "Freestyle.domains",
      "Freestyle.identities",
    ],
  },
  {
    provider: "morph",
    language: "typescript",
    upstream: { dir: "npm/morphcloud@0.0.20/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/morph/index.ts",
    constructed: ["MorphCloudClient"],
    outside: [],
  },
  {
    provider: "morph-python",
    language: "python",
    // The package's root exports only the client; Morph's own examples import
    // its classes from morphcloud.api, the module counted here.
    upstream: { dir: "pypi/morphcloud@0.1.115", entry: "morphcloud/api.py" },
    runtime: "sdks/python/withruntime/morph/api.py",
    constructed: ["MorphCloudClient"],
    // ApiClient and AsyncApiClient are its raw HTTP layer, copy_into_or_from_instance
    // the SFTP helper behind upload and download; the rest are the models of
    // the account's API keys, secrets, SSH keys and usage (UserAPI, refused).
    outside: [
      "ApiClient",
      "AsyncApiClient",
      "copy_into_or_from_instance",
      "APIKey",
      "CreateAPIKeyResponse",
      "Secret",
      "SecretList",
      "CreateSecretRequest",
      "UserSSHKey",
      "ManagedSSHKeyStatus",
      "ManagedSSHKey",
      "ManagedSSHKeyList",
      "ManagedSSHKeyCreateRequest",
      "ManagedSSHKeyPatchRequest",
      "ManagedSSHKeyError",
      "UserInstanceUsage",
      "UserSnapshotUsage",
      "UserUsageOverview",
    ],
  },
  {
    provider: "prime",
    language: "python",
    upstream: { dir: "pypi/prime-sandboxes@0.4.7", entry: "prime_sandboxes" },
    runtime: "sdks/python/withruntime/prime",
    constructed: ["APIClient", "AsyncAPIClient", "SandboxClient", "AsyncSandboxClient"],
    outside: ["Config"],
  },
  {
    provider: "modal",
    language: "typescript",
    upstream: { dir: "npm/modal@0.11.1/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/modal/index.ts",
    constructed: ["ModalClient"],
    // The approved Modal scope is CPU sandboxes, not Functions, classes,
    // queues or GPUs.
    outside: [
      "Cls",
      "ClsInstance",
      "ClsService",
      "FunctionCall",
      "FunctionCallLogsManager",
      "FunctionCallService",
      "FunctionLogsManager",
      "FunctionMetricsManager",
      "FunctionService",
      "FunctionTimeoutError",
      "Function_",
      "Queue",
      "QueueEmptyError",
      "QueueFullError",
      "QueueService",
      "Retries",
      "checkForRenamedParams",
      "ModalClient.cls",
      "ModalClient.functions",
      "ModalClient.functionCalls",
      "ModalClient.queues",
    ],
  },
  {
    provider: "modal-python",
    language: "python",
    upstream: { dir: "pypi/modal@1.6.2", entry: "modal" },
    runtime: "sdks/python/withruntime/modal",
    constructed: [],
    outside: [
      "Client",
      "Cluster",
      "Cls",
      "Cron",
      "Dict",
      "Environment",
      "Function",
      "FunctionCall",
      "NetworkFileSystem",
      "Period",
      "Queue",
      "Retries",
      "SchedulerPlacement",
      "Server",
      "Workspace",
      "Stub",
      "asgi_app",
      "batched",
      "billing",
      "clustered",
      "concurrent",
      "current_function_call_id",
      "current_input_id",
      "enable_output",
      "enter",
      "exit",
      "experimental",
      "fastapi_endpoint",
      "is_local",
      "interact",
      "method",
      "parameter",
      "sessioned",
      "types",
      "web_endpoint",
      "web_server",
      "wsgi_app",
      "App.function",
      "App.cls",
      "App.server",
      "App.local_entrypoint",
    ],
  },
  {
    provider: "e2b",
    language: "typescript",
    upstream: { dir: "npm/e2b@2.56.0/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/e2b/index.ts",
    constructed: [],
    // ApiClient is the generated REST transport, ConnectionConfig its
    // settings; `default` is Sandbox again.
    outside: ["ApiClient", "ConnectionConfig", "default"],
  },
  {
    provider: "e2b-code-interpreter",
    language: "typescript",
    upstream: { dir: "npm/%40e2b%2Fcode-interpreter@2.9.0/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/e2b/code-interpreter.ts",
    constructed: [],
    outside: ["ApiClient", "ConnectionConfig", "default"],
  },
  {
    provider: "e2b-python",
    language: "python",
    upstream: { dir: "pypi/e2b@2.56.0", entry: "e2b" },
    runtime: "sdks/python/withruntime/e2b",
    constructed: [],
    outside: ["ApiClient", "ConnectionConfig"],
  },
  {
    provider: "e2b-code-interpreter-python",
    language: "python",
    upstream: { dir: "pypi/e2b-code-interpreter@2.11.0", entry: "e2b_code_interpreter" },
    runtime: "sdks/python/withruntime/e2b/code_interpreter",
    constructed: [],
    outside: ["ApiClient", "ConnectionConfig"],
  },
  {
    provider: "daytona",
    language: "typescript",
    upstream: { dir: "npm/%40daytona%2Fsdk@0.225.0/package", entry: "cjs/index.d.ts" },
    runtime: "packages/cloud-sdk/src/daytona/index.ts",
    constructed: ["Daytona"],
    outside: [],
  },
  {
    provider: "daytona-python",
    language: "python",
    upstream: { dir: "pypi/daytona@0.225.0", entry: "daytona" },
    runtime: "sdks/python/withruntime/daytona",
    constructed: ["Daytona", "AsyncDaytona"],
    outside: [],
  },
  {
    provider: "vercel",
    language: "typescript",
    upstream: { dir: "npm/%40vercel%2Fsandbox@3.8.0/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/vercel/index.ts",
    constructed: [],
    outside: [],
  },
  {
    provider: "vercel-python",
    language: "python",
    upstream: { dir: "pypi/vercel-sandbox@0.9.1", entry: "vercel/sandbox" },
    runtime: "sdks/python/withruntime/vercel",
    constructed: [],
    outside: [],
  },
  {
    provider: "blaxel",
    language: "typescript",
    upstream: { dir: "npm/%40blaxel%2Fcore@0.3.30/package", entry: "dist/cjs/types/index.d.ts" },
    runtime: "packages/cloud-sdk/src/blaxel/index.ts",
    constructed: [],
    // Blaxel's other products: agents, models, tools, jobs, MCP, hosted
    // applications, drives, volumes and images, and the generated
    // control-plane client. The sandbox SDK is the rest.
    outside: [
      "ApplicationInstance",
      "BLModel",
      "BLTools",
      "BlaxelMcpClientTransport",
      "BlaxelMcpServerTransport",
      "DriveInstance",
      "ImageInstance",
      "VolumeInstance",
      "blAgent",
      "blJob",
      "blModel",
      "blStartJob",
      "blTool",
      "blTools",
      "getAgentMetadata",
      "getModelMetadata",
      "getTool",
    ],
  },
  {
    provider: "blaxel-python",
    language: "python",
    upstream: { dir: "pypi/blaxel@0.4.18", entry: "blaxel/core" },
    runtime: "sdks/python/withruntime/blaxel",
    constructed: [],
    outside: [],
  },
  {
    provider: "runloop",
    language: "typescript",
    upstream: { dir: "npm/%40runloop%2Fapi-client@2.0.0/package", entry: "sdk.d.ts" },
    runtime: "packages/cloud-sdk/src/runloop/index.ts",
    constructed: ["Runloop", "RunloopSDK"],
    outside: RUNLOOP_OUTSIDE,
  },
  {
    provider: "runloop-python",
    language: "python",
    upstream: { dir: "pypi/runloop-api-client@2.0.0", entry: "runloop_api_client" },
    runtime: "sdks/python/withruntime/runloop",
    constructed: ["Runloop", "AsyncRunloop", "RunloopSDK", "AsyncRunloopSDK"],
    outside: RUNLOOP_OUTSIDE,
  },
  {
    provider: "cloudflare",
    language: "typescript",
    upstream: { dir: "npm/%40cloudflare%2Fsandbox@0.12.10/package", entry: "dist/index.d.ts" },
    runtime: "packages/cloud-sdk/src/cloudflare/index.ts",
    constructed: [],
    // The per-feature HTTP clients are the container's internal transport.
    outside: [
      "BackupClient",
      "CommandClient",
      "FileClient",
      "GitClient",
      "InterpreterClient",
      "PortClient",
      "ProcessClient",
      "SandboxClient",
      "UtilityClient",
      "ContainerProxy",
      "RPCTransportError",
      "isDurableObjectCodeUpdateReset",
      "isPlatformTransientError",
      "asyncIterableToSSEStream",
      "responseToAsyncIterable",
    ],
  },
];

const outside = (source: Source, key: string) =>
  (/^\w+\.new\b/.test(key) && !source.constructed.includes(key.split(".")[0]!)) ||
  source.outside.some(
    (name) => key === name || key.startsWith(`${name}.`) || key.startsWith(`${name}(`),
  );

// TypeScript ------------------------------------------------------------------

const hidden = (name: string) => name.startsWith("_") || name.startsWith("#");
/** Declared only by the language's own library: Error's message and stack. */
const builtIn = (symbol: ts.Symbol | undefined) =>
  !!symbol?.declarations?.length &&
  symbol.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib);
function isError(checker: ts.TypeChecker, type: ts.Type): boolean {
  for (const base of checker.getBaseTypes(type as ts.InterfaceType) ?? [])
    if ((builtIn(base.getSymbol()) && base.getSymbol()?.name === "Error") || isError(checker, base))
      return true;
  return false;
}

function optionKeys(checker: ts.TypeChecker, parameter: ts.Symbol, at: ts.Node): string[] {
  const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(parameter, at));
  const parts = type.isUnion() ? type.types : [type];
  const keys = new Set<string>();
  for (const part of parts) {
    if (part.getCallSignatures().length || checker.isArrayType(part)) continue;
    if (!(part.flags & ts.TypeFlags.Object) && !part.isIntersection()) continue;
    // Built-in classes (AbortSignal, Uint8Array, ReadableStream) are values, not options.
    // So are other classes: a constructor's internal client is not an option.
    if (builtIn(part.getSymbol()) || (part.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class)
      continue;
    for (const property of part.getProperties())
      if (!hidden(property.name)) keys.add(property.name);
  }
  return [...keys];
}

/** The keys a body refuses: identifiers and strings in the condition of an
 * `if` whose consequence throws a CompatibilityError, plus strings passed to
 * one directly. */
function refusedKeys(body: ts.Node | undefined): Set<string> {
  const keys = new Set<string>();
  if (!body) return keys;
  const throwsCompatibility = (node: ts.Node): boolean => {
    let found = false;
    const visit = (child: ts.Node) => {
      if (
        ts.isNewExpression(child) &&
        ts.isIdentifier(child.expression) &&
        REFUSALS.has(child.expression.text)
      )
        found = true;
      else ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const words = (node: ts.Node) => {
    const visit = (child: ts.Node) => {
      if (ts.isPropertyAccessExpression(child)) keys.add(child.name.text);
      if (ts.isIdentifier(child)) keys.add(child.text);
      if (ts.isStringLiteralLike(child)) keys.add(child.text);
      ts.forEachChild(child, visit);
    };
    visit(node);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && throwsCompatibility(node.thenStatement)) words(node.expression);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      REFUSALS.has(node.expression.text)
    )
      for (const argument of node.arguments ?? []) words(argument);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return keys;
}

/** The body passes its options to `only(provider, options, [...keys])`,
 * which throws a CompatibilityError for every other key before any effect. */
function checksOptions(body: ts.Node | undefined): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "only" &&
      node.arguments[1] &&
      ts.isIdentifier(node.arguments[1])
    )
      found = true;
    else ts.forEachChild(node, visit);
  };
  if (body) visit(body);
  return found;
}

/** Errors an adapter throws to refuse: compat/core.ts's, and the
 * NotSupportedError of the E2B, Daytona, Vercel and Blaxel adapters. */
const REFUSALS = new Set(["CompatibilityError", "NotSupportedError"]);

/** `declare readonly name: Refused` (compat/core.ts `refuse`), a variable
 * typed Refused, or `export const Name = unsupportedExport(...)`. */
function declaredRefused(declaration: ts.Declaration | undefined): boolean {
  if (!declaration) return false;
  const typed =
    ts.isPropertyDeclaration(declaration) || ts.isVariableDeclaration(declaration)
      ? declaration.type
      : undefined;
  if (
    typed &&
    ts.isTypeReferenceNode(typed) &&
    ts.isIdentifier(typed.typeName) &&
    ["Refused", "RefusedAsync"].includes(typed.typeName.text)
  )
    return true;
  const value = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
  return (
    !!value &&
    ts.isCallExpression(value) &&
    ts.isIdentifier(value.expression) &&
    ["unsupportedExport", "refused"].includes(value.expression.text)
  );
}

function startsWithThrow(declaration: ts.Declaration | undefined): boolean {
  if (!declaration) return false;
  const body = (declaration as ts.FunctionLikeDeclarationBase).body;
  if (!body) return false;
  if (!ts.isBlock(body)) return false;
  const first = body.statements[0];
  return !!first && ts.isThrowStatement(first);
}

function bodyOf(declaration: ts.Declaration | undefined): ts.Node | undefined {
  return declaration ? (declaration as ts.FunctionLikeDeclarationBase).body : undefined;
}

function memberItems(
  checker: ts.TypeChecker,
  owner: string,
  name: string,
  symbol: ts.Symbol,
  at: ts.Node,
  runtime: boolean,
  out: Surface,
) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const modifiers = declaration ? ts.getCombinedModifierFlags(declaration) : 0;
  if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return;
  const key = owner ? `${owner}.${name}` : name;
  const throwsFirst = runtime && (startsWithThrow(declaration) || declaredRefused(declaration));
  out.set(key, runtime ? (throwsFirst ? "refused" : "present") : "upstream");
  if (throwsFirst) out.set(`${key}(*)`, "refused");
  const type = checker.getTypeOfSymbolAtLocation(symbol, at);
  const refused = runtime ? refusedKeys(bodyOf(declaration)) : new Set<string>();
  if (runtime && checksOptions(bodyOf(declaration))) out.set(`${key}(*)`, "refused");
  for (const signature of type.getCallSignatures())
    for (const parameter of signature.getParameters())
      for (const option of optionKeys(checker, parameter, at)) {
        const item = `${key}(${option})`;
        if (!runtime) out.set(item, "upstream");
        else if (out.get(item) !== "present")
          out.set(item, throwsFirst || refused.has(option) ? "refused" : "present");
      }
}

function classItems(
  checker: ts.TypeChecker,
  name: string,
  symbol: ts.Symbol,
  at: ts.Node,
  runtime: boolean,
  out: Surface,
) {
  out.set(name, runtime ? "present" : "upstream");
  const instance = checker.getDeclaredTypeOfSymbol(symbol);
  for (const member of checker.getPropertiesOfType(instance))
    if (!hidden(member.name) && !builtIn(member))
      memberItems(checker, name, member.name, member, at, runtime, out);
  const constructor = checker.getTypeOfSymbolAtLocation(symbol, at);
  for (const member of checker.getPropertiesOfType(constructor))
    if (!hidden(member.name) && member.name !== "prototype")
      memberItems(checker, name, member.name, member, at, runtime, out);
  const declaration = symbol.valueDeclaration;
  const refused = runtime ? refusedKeys(declaration) : new Set<string>();
  // An error is thrown by the SDK, not built by its caller.
  const signatures = isError(checker, instance) ? [] : constructor.getConstructSignatures();
  for (const signature of signatures)
    for (const parameter of signature.getParameters())
      for (const option of optionKeys(checker, parameter, at)) {
        const item = `${name}.new(${option})`;
        if (!runtime) out.set(item, "upstream");
        else if (out.get(item) !== "present")
          out.set(item, refused.has(option) ? "refused" : "present");
      }
}

export function typescriptSurface(entry: string, names: readonly string[] | null) {
  const runtime = names !== null;
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    skipLibCheck: true,
    noEmit: true,
    strict: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  if (!file) throw new Error(`Cannot read ${entry}`);
  const module = checker.getSymbolAtLocation(file);
  if (!module) throw new Error(`${entry} exports nothing`);
  const out: Surface = new Map();
  for (const exported of checker.getExportsOfModule(module)) {
    if (names && !names.includes(exported.name)) continue;
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (symbol.flags & ts.SymbolFlags.Class)
      classItems(checker, exported.name, symbol, file, runtime, out);
    else if (symbol.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable))
      memberItems(checker, "", exported.name, symbol, file, runtime, out);
  }
  return out;
}

// Python ----------------------------------------------------------------------

const PYTHON = String.raw`
import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1]); wanted = json.loads(sys.argv[2])
# An entry that is one module (morphcloud/api.py) counts what that module defines.
module = root if root.is_file() else None
classes, functions, aliases, assigned, refused_exports = {}, {}, {}, {}, set()
for path in [module] if module else sorted(root.rglob("*.py")):
    try: tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError: continue
    for node in tree.body:
        if isinstance(node, ast.ClassDef): classes.setdefault(node.name, []).append(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)): functions.setdefault(node.name, node)
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.asname: aliases[alias.asname] = alias.name
        # Class.method = helper after the class body.
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
                    assigned.setdefault(target.value.id, set()).add(target.attr)
                # Name = refused(...) (_compat.py): an export the adapter refuses.
                if (isinstance(target, ast.Name) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                        and node.value.func.id.lstrip("_") == "refused"):
                    refused_exports.add(target.id)
if wanted is None and module:
    wanted = [n for n in [*classes, *functions] if not n.startswith("_")]
if wanted is None:
    init = ast.parse((root / "__init__.py").read_text(encoding="utf-8"))
    wanted = []
    for node in init.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
            wanted = [e.value for e in node.value.elts if isinstance(e, ast.Constant)]
    if not wanted:
        for node in init.body:
            if isinstance(node, ast.ImportFrom): wanted += [a.asname or a.name for a in node.names]
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)): wanted.append(node.name)
        wanted = [n for n in wanted if not n.startswith("_")]
def strip(fn):
    return [s for s in fn.body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
def refused(fn):
    body = strip(fn)
    return bool(body) and isinstance(body[0], ast.Raise)
def raised_keys(fn):
    keys = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.If) and any(isinstance(s, ast.Raise) for s in node.body):
            for word in ast.walk(node.test):
                if isinstance(word, ast.Name): keys.add(word.id)
                if isinstance(word, ast.Attribute): keys.add(word.attr)
                if isinstance(word, ast.Constant) and isinstance(word.value, str): keys.add(word.value)
    return sorted(keys)
def params(fn):
    a = fn.args
    return [p.arg for p in a.posonlyargs + a.args + a.kwonlyargs if p.arg not in ("self", "cls")]
def validator(fn):
    """Pydantic validators run inside the model; callers never call them."""
    for decorator in fn.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        name = target.id if isinstance(target, ast.Name) else target.attr if isinstance(target, ast.Attribute) else ""
        if name in ("field_validator", "model_validator", "validator", "root_validator", "field_serializer", "model_serializer"): return True
    return False
def checks(fn):
    """**options passed to reject(), which raises for every key it is given."""
    if not fn.args.kwarg: return False
    rest = fn.args.kwarg.arg
    return any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "reject" and n.args and isinstance(n.args[0], ast.Name) and n.args[0].id == rest for n in ast.walk(fn))
def describe(fn):
    return {"refused": refused(fn), "params": params(fn), "raised": raised_keys(fn), "checks": checks(fn)}
def members(name, seen):
    out = {}
    for node in classes.get(name, []):
        if id(node) in seen: continue
        seen.add(id(node))
        for base in node.bases:
            base_name = base.id if isinstance(base, ast.Name) else base.attr if isinstance(base, ast.Attribute) else None
            if base_name: out.update(members(aliases.get(base_name, base_name), seen))
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                key = "new" if item.name == "__init__" else item.name
                if not key.startswith("_") and not validator(item): out[key] = describe(item)
            # A model whose fields are listed: _required = ("id", ...), _defaults = {"name": None}.
            elif isinstance(item, ast.Assign) and any(isinstance(t, ast.Name) and t.id in ("_required", "_defaults") for t in item.targets):
                values = item.value.elts if isinstance(item.value, (ast.Tuple, ast.List)) else item.value.keys if isinstance(item.value, ast.Dict) else []
                for value in values:
                    if isinstance(value, ast.Constant) and isinstance(value.value, str):
                        out.setdefault(value.value, {"refused": False, "params": [], "raised": []})
            elif isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name) and not item.target.id.startswith("_"):
                out.setdefault(item.target.id, {"refused": False, "params": [], "raised": []})
    for attr in assigned.get(name, ()):
        if not attr.startswith("_"): out.setdefault(attr, {"refused": False, "params": [], "raised": []})
    return out
result = {}
for name in wanted:
    found = name if name in classes else "_" + name if "_" + name in classes else None
    if name in refused_exports: result[name] = {"kind": "refused"}
    elif found: result[name] = {"kind": "class", "members": members(found, set())}
    elif name in functions: result[name] = {"kind": "function", **describe(functions[name])}
print(json.dumps(result))
`;

type PythonEntry =
  | { kind: "class"; members: Record<string, PythonMember> }
  | { kind: "refused" }
  | ({ kind: "function" } & PythonMember);
type PythonMember = { refused: boolean; params: string[]; raised: string[]; checks?: boolean };

export function pythonSurface(dir: string, names: readonly string[] | null) {
  const raw = execFileSync("python3", ["-I", "-c", PYTHON, dir, JSON.stringify(names)], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const runtime = names !== null;
  const out: Surface = new Map();
  const member = (key: string, info: PythonMember, constructor: boolean) => {
    if (!constructor) out.set(key, runtime ? (info.refused ? "refused" : "present") : "upstream");
    if (runtime && info.checks) out.set(`${key}(*)`, "refused");
    for (const option of info.params)
      out.set(
        `${key}(${option})`,
        !runtime
          ? "upstream"
          : info.refused || info.raised.includes(option)
            ? "refused"
            : "present",
      );
  };
  for (const [name, entry] of Object.entries(JSON.parse(raw) as Record<string, PythonEntry>)) {
    if (entry.kind === "function") {
      member(name, entry, false);
      continue;
    }
    if (entry.kind === "refused") {
      out.set(name, runtime ? "refused" : "upstream");
      continue;
    }
    out.set(name, runtime ? "present" : "upstream");
    for (const [key, info] of Object.entries(entry.members)) member(`${name}.${key}`, info, false);
  }
  return out;
}

// Comparison ------------------------------------------------------------------

export type ProviderInventory = {
  upstream: string;
  counts: Record<Status, number> & { total: number };
  /** Every upstream item and the adapter's status for it. */
  items: Record<string, Status>;
};

/** The adapter's side, for the names the upstream inventory exports. */
export function runtimeSurface(source: Source, names: readonly string[]): Surface {
  const path = join(ROOT, source.runtime);
  return source.language === "typescript"
    ? typescriptSurface(path, names)
    : pythonSurface(path, names);
}

export function compare(upstream: Iterable<string>, runtime: Surface) {
  const items: Record<string, Status> = {};
  const counts = { present: 0, refused: 0, missing: 0, total: 0 };
  for (const key of [...upstream].sort()) {
    const checked = key.match(/^(.+)\([^)]*\)$/);
    // A refused export refuses everything under it: a class's members too.
    const top = key.split(/[.(]/)[0]!;
    const status =
      (runtime.get(key) as Status | undefined) ??
      ((checked && runtime.get(`${checked[1]}(*)`) === "refused") ||
      (top !== key && runtime.get(top) === "refused")
        ? "refused"
        : "missing");
    items[key] = status;
    counts[status]++;
    counts.total++;
  }
  return { items, counts };
}

/** Top-level names of an inventory: classes and functions. */
export const exportedNames = (keys: Iterable<string>) => [
  ...new Set([...keys].map((key) => key.split(/[.(]/)[0]!)),
];

export const INVENTORY = join(ROOT, "packages/cloud-sdk/compat-inventory.json");

const line = (provider: string, counts: ProviderInventory["counts"]) =>
  `${provider.padEnd(15)} ${String(counts.present).padStart(5)} present ${String(counts.refused).padStart(5)} refused ${String(counts.missing).padStart(5)} missing of ${counts.total}`;

/** Recompute the adapter side against the committed upstream lists. */
export function refresh(saved: Record<string, ProviderInventory>, only?: readonly string[]) {
  const result: Record<string, ProviderInventory> = { ...saved };
  for (const source of SOURCES) {
    if (only && !only.includes(source.provider)) continue;
    const previous = saved[source.provider];
    if (!previous) throw new Error(`${source.provider} is not in ${INVENTORY}; run with the cache`);
    const keys = Object.keys(previous.items);
    const { items, counts } = compare(keys, runtimeSurface(source, exportedNames(keys)));
    result[source.provider] = { upstream: previous.upstream, counts, items };
  }
  return result;
}

export const readInventory = () =>
  JSON.parse(readFileSync(INVENTORY, "utf8")) as Record<string, ProviderInventory>;
export const formatInventory = (inventory: Record<string, ProviderInventory>) =>
  JSON.stringify(inventory, null, 2) + "\n";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  // --only a,b: recompute these providers and keep the rest as committed,
  // so a session commits only its own adapters' counts.
  const at = args.indexOf("--only");
  const only = at >= 0 ? args[at + 1]?.split(",") : undefined;
  if (only?.some((name) => !SOURCES.some((source) => source.provider === name)))
    throw new Error(`--only takes providers from: ${SOURCES.map((s) => s.provider).join(", ")}`);
  const cache = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1);
  let result: Record<string, ProviderInventory> = {};
  if (!cache) result = refresh(readInventory(), only);
  else
    for (const source of SOURCES) {
      if (only && !only.includes(source.provider)) {
        result[source.provider] = readInventory()[source.provider]!;
        continue;
      }
      const dir = resolve(cache, source.upstream.dir);
      if (!existsSync(dir)) throw new Error(`Missing ${dir}; run compat:prepare`);
      const entry = join(dir, source.upstream.entry);
      const surface =
        source.language === "typescript"
          ? typescriptSurface(entry, null)
          : pythonSurface(entry, null);
      const keys = [...surface.keys()].filter((key) => !outside(source, key));
      const { items, counts } = compare(keys, runtimeSurface(source, exportedNames(keys)));
      result[source.provider] = { upstream: source.upstream.dir, counts, items };
    }
  for (const [provider, { counts }] of Object.entries(result)) console.log(line(provider, counts));
  if (write) {
    writeFileSync(INVENTORY, formatInventory(result));
    console.log(`wrote ${INVENTORY}`);
  }
}
