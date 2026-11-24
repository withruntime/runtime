# App API reference

A machine that keeps a web app in /app running on port 8080 (its Procfile's `web:`, else `npm start`, else `python3 app.py`, as Render and Heroku start one), reached at its preview. It never pauses for being idle.

Base URL: `https://api.withruntime.com`. [Authentication, idempotency and errors](./overview) work the same way for every product.

Its states: `starting`, `running`, `paused`, `deleted`, `error`.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v2/apps` | [Create a app](#create-a-app) |
| `GET` | `/v2/apps/{id}` | [Get a app](#get-a-app) |
| `GET` | `/v2/apps` | [List apps](#list-apps) |
| `DELETE` | `/v2/apps/{id}` | [Delete a app](#delete-a-app) |
| `POST` | `/v2/apps/{id}:pause` | [pause](#pause) |
| `POST` | `/v2/apps/{id}:resume` | [resume](#resume) |
| `POST` | `/v2/apps/{id}:exec` | [exec](#exec) |
| `GET` | `/v2/apps/{id}/files` | [read](#read) |
| `PUT` | `/v2/apps/{id}/files` | [write](#write) |
| `GET` | `/v2/apps/{id}/processes/{process}/output` | [processOutput](#processoutput) |
| `POST` | `/v2/apps/{id}/processes/{process}:write` | [writeProcess](#writeprocess) |
| `POST` | `/v2/apps/{id}/processes/{process}:signal` | [signalProcess](#signalprocess) |
| `POST` | `/v2/apps/{id}/processes/{process}:resize` | [resizeProcess](#resizeprocess) |
| `GET` | `/v2/apps/{id}/processes` | [listProcesses](#listprocesses) |
| `POST` | `/v2/apps/{id}/files:remove` | [remove](#remove) |
| `GET` | `/v2/apps/{id}/files/stat` | [stat](#stat) |
| `GET` | `/v2/apps/{id}/files/list` | [listFiles](#listfiles) |
| `GET` | `/v2/apps/{id}/files/archive` | [downloadFolder](#downloadfolder) |
| `PUT` | `/v2/apps/{id}/files/archive` | [uploadFolder](#uploadfolder) |
| `POST` | `/v2/apps/{id}/files/archive/uploads` | [beginFolderUpload](#beginfolderupload) |
| `PUT` | `/v2/apps/{id}/files/archive/uploads/{upload}` | [writeFolderUpload](#writefolderupload) |
| `POST` | `/v2/apps/{id}/files/archive/uploads/{upload}:commit` | [commitFolderUpload](#commitfolderupload) |
| `POST` | `/v2/apps/{id}/files/archive/uploads/{upload}:abort` | [abortFolderUpload](#abortfolderupload) |
| `POST` | `/v2/apps/{id}/files:mkdir` | [mkdir](#mkdir) |
| `POST` | `/v2/apps/{id}/files:rename` | [rename](#rename) |
| `POST` | `/v2/apps/{id}/files:link` | [link](#link) |
| `POST` | `/v2/apps/{id}/files:revokeLinks` | [revokeLinks](#revokelinks) |
| `GET` | `/v2/apps/{id}/network` | [getNetwork](#getnetwork) |
| `GET` | `/v2/apps/{id}/metrics` | [metrics](#metrics) |
| `PUT` | `/v2/apps/{id}/network` | [setNetwork](#setnetwork) |
| `POST` | `/v2/apps/{id}:fork` | [fork](#fork) |
| `POST` | `/v2/apps/{id}:snapshot` | [snapshot](#snapshot) |
| `POST` | `/v2/apps/{id}:update` | [update](#update) |
| `GET` | `/v2/apps/{id}/screenshot` | [screenshot](#screenshot) |
| `POST` | `/v2/apps/{id}:act` | [act](#act) |
| `POST` | `/v2/apps/{id}:runCode` | [runCode](#runcode) |

## Create a app

`POST /v2/apps`

Creates an app. Asked again with the same Idempotency-Key, it returns the same app.

Its action, for a key's grant: `apps:create`.

Body: a [SandboxCreate](#sandboxcreate).

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.create();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.create()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.create
```

```bash title="CLI"
runtime apps create
```

## Get a app

`GET /v2/apps/{id}`

Returns an app.

Its action, for a key's grant: `apps:get`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `wait` | number | No | Seconds to wait, at most 60, for its state to differ from `ifState`; it answers once it does, or as it is when the wait ends. At least 0. At most 60. |
| `ifState` | string | No | The state the caller last read, which `wait` waits for it to leave. |

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.get("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.get("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.get("APP_ID")
```

```bash title="CLI"
runtime apps get APP_ID
```

## List apps

`GET /v2/apps`

Lists the project's apps, newest first.

Its action, for a key's grant: `apps:list`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | string | No | Only those in these states, comma-separated. |
| `name` | string | No | Only the app of this name. |
| `label` | list of string | No | Only those with every label given (repeat it for several): key:value, or a key for any value. |
| `cursor` | string | No | Where the page starts: a page's `next`. |
| `limit` | integer | No | The most items the page holds. At least 1. At most 200. Default: 50. |

Returns a page: `items`, each a [Sandbox](#sandbox), and `next`, where the next page starts, none on the last.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.list();
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.list()
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.list
```

```bash title="CLI"
runtime apps list
```

## Delete a app

`DELETE /v2/apps/{id}`

Deletes an app, its memory and its disk.

Its action, for a key's grant: `apps:delete`.

Path: `id`.

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X DELETE "https://api.withruntime.com/v2/apps/APP_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.delete("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.delete("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.delete("APP_ID")
```

```bash title="CLI"
runtime apps delete APP_ID
```

## `pause`

`POST /v2/apps/{id}:pause`

Pauses an app with its memory and disk kept. A call to it resumes it.

Its action, for a key's grant: `apps:pause`.

Path: `id`.

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:pause" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.pause("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.pause("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.pause("APP_ID")
```

```bash title="CLI"
runtime apps pause APP_ID
```

## `resume`

`POST /v2/apps/{id}:resume`

Resumes a paused app where it was, its memory and processes as they were.

Its action, for a key's grant: `apps:wake`.

Path: `id`.

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:resume" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.resume("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.resume("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.resume("APP_ID")
```

```bash title="CLI"
runtime apps resume APP_ID
```

## `exec`

`POST /v2/apps/{id}:exec`

Runs a command as a process and returns it once it ended, with its output; with wait false, at once, while it runs. A paused app is resumed first. Asked again with the same Idempotency-Key, it runs nothing more: it returns the first run's process, waiting for its end while it runs.

Its action, for a key's grant: `apps:exec`.

Path: `id`.

Body: a [ExecRequest](#execrequest).

Returns a [Process](#process).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:exec" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "cmd": "echo hello" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.exec("APP_ID", { cmd: "echo hello" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.exec("APP_ID", cmd="echo hello")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.exec("APP_ID", cmd: "echo hello")
```

```bash title="CLI"
runtime apps exec APP_ID -- echo hello
```

## `read`

`GET /v2/apps/{id}/files`

Returns a file's bytes.

Its action, for a key's grant: `apps:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The file's path in the machine. |

Returns the bytes, `application/octet-stream`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/files?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -o out.bin
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.read("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.read("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.read("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps read APP_ID --path /tmp/hello.txt
```

## `write`

`PUT /v2/apps/{id}/files`

Writes the request's bytes to a file as they come, of any size (Content-Length required), its folders made: the file whole when they all came, or as it was. With offset, they are written into it in place.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The file's path in the machine. |
| `mode` | string | No | Its mode, in octal (`644`). |
| `offset` | integer | No | Write the bytes into the file in place from this byte, keeping the bytes before and after them (the file is made when there is none); one that fails part way may leave its range written in part, so send it again. Parts of one file may be written so at once and in any order: write them to a new path, then rename it with its size and sha256 to put it in place whole. At least 0. |
| `sha256` | string | No | The bytes' SHA-256 in hex: refused 409 `checksum_mismatch`, the file as it was, when they differ. Not with offset. |

Body: the bytes, `application/octet-stream`.

Returns a [FileWritten](#filewritten).

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/apps/APP_ID/files?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary 'hello'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.write("APP_ID", new TextEncoder().encode("hello\n"), { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.write("APP_ID", b"hello\n", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.write("APP_ID", "hello\n", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps write APP_ID --path /tmp/hello.txt < hello.txt
```

## `processOutput`

`GET /v2/apps/{id}/processes/{process}/output`

Returns a process's output after a cursor, and the cursor to read on from. The latest 1 MiB is kept; truncated says when the cursor fell behind.

Its action, for a key's grant: `apps:exec`.

Path: `id`, `process`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | integer | No | Output after this byte. At least 0. Default: 0. |
| `waitSeconds` | number | No | Seconds to wait for output past the cursor or its exit, at most 8. At least 0. At most 8. |
| `maxBytes` | integer | No | At most this many bytes. At least 4096. At most 196608. Default: 65536. |
| `follow` | boolean | No | Answer as NDJSON events from the cursor until it exits (stdout, stderr, truncated, exit; continue with the cursor to follow on from), as `Accept: application/x-ndjson` does. |

Returns a [ProcessOutput](#processoutput).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/processes/PROCESS_ID/output" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.processOutput("APP_ID", "PROCESS_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.process_output("APP_ID", "PROCESS_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.process_output("APP_ID", "PROCESS_ID")
```

```bash title="CLI"
runtime apps process-output APP_ID PROCESS_ID
```

## `writeProcess`

`POST /v2/apps/{id}/processes/{process}:write`

Sends input to a process started with stdinOpen or a pty, and returns how much of its input it has taken.

Its action, for a key's grant: `apps:exec`.

Path: `id`, `process`.

Body: a [ProcessInput](#processinput).

Returns a [ProcessWritten](#processwritten).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/processes/PROCESS_ID:write" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.writeProcess("APP_ID", "PROCESS_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.write_process("APP_ID", "PROCESS_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.write_process("APP_ID", "PROCESS_ID")
```

```bash title="CLI"
runtime apps write-process APP_ID PROCESS_ID
```

## `signalProcess`

`POST /v2/apps/{id}/processes/{process}:signal`

Sends a signal to a process and its group; a process that ended is not signalled, so a retry is safe.

Its action, for a key's grant: `apps:exec`.

Path: `id`, `process`.

Body: a [ProcessSignal](#processsignal).

Returns a [Process](#process).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/processes/PROCESS_ID:signal" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.signalProcess("APP_ID", "PROCESS_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.signal_process("APP_ID", "PROCESS_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.signal_process("APP_ID", "PROCESS_ID")
```

```bash title="CLI"
runtime apps signal-process APP_ID PROCESS_ID
```

## `resizeProcess`

`POST /v2/apps/{id}/processes/{process}:resize`

Resizes the terminal of a process started with a pty (its window's columns and rows, which the process is told by SIGWINCH), and returns the process; refused 409 for a process without one. A process that ended is left as it is, so a retry is safe.

Its action, for a key's grant: `apps:exec`.

Path: `id`, `process`.

Body: a [Terminal](#terminal).

Returns a [Process](#process).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/processes/PROCESS_ID:resize" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "cols": 1, "rows": 1 }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.resizeProcess("APP_ID", "PROCESS_ID", { cols: 1, rows: 1 });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.resize_process("APP_ID", "PROCESS_ID", cols=1, rows=1)
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.resize_process("APP_ID", "PROCESS_ID", cols: 1, rows: 1)
```

```bash title="CLI"
runtime apps resize-process APP_ID PROCESS_ID --cols 1 --rows 1
```

## `listProcesses`

`GET /v2/apps/{id}/processes`

Lists an app's processes, newest first: those running and those that ended lately.

Its action, for a key's grant: `apps:exec`.

Path: `id`.

Returns a [ProcessList](#processlist).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/processes" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.listProcesses("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.list_processes("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.list_processes("APP_ID")
```

```bash title="CLI"
runtime apps list-processes APP_ID
```

## `remove`

`POST /v2/apps/{id}/files:remove`

Removes a file, a link or a directory (recursive for one with contents). One missing is success, removed false.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Body: a [FileRemove](#fileremove).

Returns a [FileRemoved](#fileremoved).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files:remove" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/hello.txt" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.remove("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.remove("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.remove("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps remove APP_ID --path /tmp/hello.txt
```

## `stat`

`GET /v2/apps/{id}/files/stat`

Returns what is at a path: a file, a directory or a link, or nothing (exists false). With sha256=true, a file's SHA-256 too.

Its action, for a key's grant: `apps:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The file's path in the machine. |
| `sha256` | boolean | No | Also return a file's SHA-256, read from its bytes: to check a file you put in place (files:rename with sha256) is whole. Default: false. |

Returns a [FileInfo](#fileinfo).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/files/stat?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.stat("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.stat("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.stat("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps stat APP_ID --path /tmp/hello.txt
```

## `listFiles`

`GET /v2/apps/{id}/files/list`

Lists a directory's entries in path order, to a depth.

Its action, for a key's grant: `apps:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | No | The directory. Default: "/workspace". |
| `depth` | integer | No | How deep to list. At least 1. At most 10. Default: 1. |
| `limit` | integer | No | At most this many entries. At least 1. At most 2000. Default: 2000. |
| `hidden` | boolean | No | List entries whose names start with a dot. Default: true. |
| `glob` | string | No | Only entries whose path relative to the directory matches: `*` within a name, `**` across folders, `?` one character, `{a,b}` either (`**/*.py`); at most 512 characters, 32 wildcards and 64 texts in braces. The listing then reaches as deep as the glob does (10 folders for `**`) unless depth says, and is searched past its first 2,000 entries, up to 50,000. At most 512 characters. |

Returns a [FileList](#filelist).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/files/list" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.listFiles("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.list_files("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.list_files("APP_ID")
```

```bash title="CLI"
runtime apps list-files APP_ID
```

## `downloadFolder`

`GET /v2/apps/{id}/files/archive`

Returns a folder as a tar archive (`application/x-tar`, or `application/gzip` with gzip), packed by tar in the app as it streams, of any size; its entries are relative to the folder (`./a.txt`). A folder that fails part way (a file it may not read, or one that changes as it is read) ends as an archive every tar reader refuses, never as a short one that reads whole. At most 4 at once in an app. A paused app is woken first.

Its action, for a key's grant: `apps:read`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The folder, absolute, such as `/workspace/app`. |
| `gzip` | boolean | No | Compress the archive with gzip. Default: false. |
| `user` | one of `runtime`, `root` | No | Who packs it: `runtime` or `root`; the app's `user` when omitted. |
| `exclude` | string | No | Paths in the folder to leave out, relative to it and comma-separated (`node_modules,.cache`): plain names, no wildcards, at most 32. |

Returns the bytes, `application/octet-stream`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/files/archive?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -o out.bin
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.downloadFolder("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.download_folder("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.download_folder("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps download-folder APP_ID --path /tmp/hello.txt
```

## `uploadFolder`

`PUT /v2/apps/{id}/files/archive`

Unpacks the request's tar archive (gzip-compressed or not, told by its first bytes) into a folder, made with its parents, by tar in the app as the bytes arrive, of any size, nothing of it kept on disk but what tar writes; returns once tar has ended, or 400 `invalid_archive` with what tar said. A paused app is woken first.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The folder, absolute, such as `/workspace/app`: made with its parents. |
| `user` | one of `runtime`, `root` | No | Who unpacks it: `runtime` or `root`; the app's `user` when omitted. |

Body: the bytes, `application/octet-stream`.

Returns a [FolderUnpacked](#folderunpacked).

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/apps/APP_ID/files/archive?path=/tmp/hello.txt" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary 'hello'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.uploadFolder("APP_ID", new TextEncoder().encode("hello\n"), { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.upload_folder("APP_ID", b"hello\n", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.upload_folder("APP_ID", "hello\n", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps upload-folder APP_ID --path /tmp/hello.txt < hello.txt
```

## `beginFolderUpload`

`POST /v2/apps/{id}/files/archive/uploads`

Begins a folder's upload in parts: tar starts in the app, unpacking into the folder each part as it arrives. Send the parts in order by offset (writeFolderUpload), then commitFolderUpload; an upload no call names for 10 minutes is ended. A paused app is woken first.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Body: a [FolderUploadBegin](#folderuploadbegin).

Returns a [FolderUpload](#folderupload).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files/archive/uploads" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/hello.txt" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.beginFolderUpload("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.begin_folder_upload("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.begin_folder_upload("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps begin-folder-upload APP_ID --path /tmp/hello.txt
```

## `writeFolderUpload`

`PUT /v2/apps/{id}/files/archive/uploads/{upload}`

Sends the request's bytes, a part of the archive at its offset, into tar's input as they arrive, of any size, and returns the bytes received in all once tar took them. A part past them is refused 409 `upload_incomplete`, naming them: send the parts in order.

Its action, for a key's grant: `apps:write`.

Path: `id`, `upload`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `offset` | integer | No | Where the part starts in the archive: at most the bytes received so far. Bytes before them were taken already and are skipped, so a part sent again is never unpacked twice. At least 0. Default: 0. |

Body: the bytes, `application/octet-stream`.

Returns a [FolderUploadReceived](#folderuploadreceived).

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/apps/APP_ID/files/archive/uploads/UPLOAD_ID" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/octet-stream" \
  --data-binary 'hello'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.writeFolderUpload("APP_ID", "UPLOAD_ID", new TextEncoder().encode("hello\n"));
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.write_folder_upload("APP_ID", "UPLOAD_ID", b"hello\n")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.write_folder_upload("APP_ID", "UPLOAD_ID", "hello\n")
```

```bash title="CLI"
runtime apps write-folder-upload APP_ID UPLOAD_ID < hello.txt
```

## `commitFolderUpload`

`POST /v2/apps/{id}/files/archive/uploads/{upload}:commit`

Ends a folder upload's input and returns once tar has ended, as an exec returns once its command has: the folder, or 400 `invalid_archive` with what tar said. A front that restarts meanwhile returns 503 `run_goes_on`; sent again, it returns how tar ended. An upload no call has named for 10 minutes since its last part or commit is ended.

Its action, for a key's grant: `apps:write`.

Path: `id`, `upload`.

Returns a [FolderUnpacked](#folderunpacked).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files/archive/uploads/UPLOAD_ID:commit" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.commitFolderUpload("APP_ID", "UPLOAD_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.commit_folder_upload("APP_ID", "UPLOAD_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.commit_folder_upload("APP_ID", "UPLOAD_ID")
```

```bash title="CLI"
runtime apps commit-folder-upload APP_ID UPLOAD_ID
```

## `abortFolderUpload`

`POST /v2/apps/{id}/files/archive/uploads/{upload}:abort`

Stops a folder upload's tar; what it unpacked so far stays.

Its action, for a key's grant: `apps:write`.

Path: `id`, `upload`.

Returns a [FolderUploadAborted](#folderuploadaborted).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files/archive/uploads/UPLOAD_ID:abort" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.abortFolderUpload("APP_ID", "UPLOAD_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.abort_folder_upload("APP_ID", "UPLOAD_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.abort_folder_upload("APP_ID", "UPLOAD_ID")
```

```bash title="CLI"
runtime apps abort-folder-upload APP_ID UPLOAD_ID
```

## `mkdir`

`POST /v2/apps/{id}/files:mkdir`

Makes a directory, and its parents unless parents is false. One there already is success, created false.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Body: a [FileMkdir](#filemkdir).

Returns a [FileMade](#filemade).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files:mkdir" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/hello.txt" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.mkdir("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.mkdir("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.mkdir("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps mkdir APP_ID --path /tmp/hello.txt
```

## `rename`

`POST /v2/apps/{id}/files:rename`

Moves a file, a link or a directory; refused 409 when something is at its new path, unless overwrite. With sha256 or size, a file written in parts is put in place once whole: its writes ended, then only a file of that size with every byte written and whose bytes hash to it moves; refused 409 `upload_incomplete` or `checksum_mismatch`, nothing moved. With sha256, it is safe to send again: once moved, it returns the same answer while `from` is gone and `to` holds those bytes.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Body: a [FileRename](#filerename).

Returns a [FileRenamed](#filerenamed).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files:rename" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "from": "example", "to": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.rename("APP_ID", { from: "example", to: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.rename("APP_ID", from="example", to="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.rename("APP_ID", from: "example", to: "example")
```

```bash title="CLI"
runtime apps rename APP_ID --from example --to example
```

## `link`

`POST /v2/apps/{id}/files:link`

Makes an expiring address for one file that anyone may open with no API key, from a browser, curl or another service: GET downloads it (Range works, so videos play and downloads resume; archive: true downloads a folder as .tar.gz), PUT with the raw body uploads it (up to maxBytes, written whole; Content-Length required). The link acts as the key that made it: an upload link needs write, and the link ends with its key, with revokeLinks or with its app. A paused app is woken for it unless wake is false.

Its action, for a key's grant: `apps:read`.

Path: `id`.

Body: a [FileLinkCreate](#filelinkcreate).

Returns a [FileLink](#filelink).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files:link" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "path": "/tmp/hello.txt" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.link("APP_ID", { path: "/tmp/hello.txt" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.link("APP_ID", path="/tmp/hello.txt")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.link("APP_ID", path: "/tmp/hello.txt")
```

```bash title="CLI"
runtime apps link APP_ID --path /tmp/hello.txt
```

## `revokeLinks`

`POST /v2/apps/{id}/files:revokeLinks`

Ends every file link made for an app so far; links made after work.

Its action, for a key's grant: `apps:write`.

Path: `id`.

Returns a [FileLinksRevoked](#filelinksrevoked).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID/files:revokeLinks" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.revokeLinks("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.revoke_links("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.revoke_links("APP_ID")
```

```bash title="CLI"
runtime apps revoke-links APP_ID
```

## `getNetwork`

`GET /v2/apps/{id}/network`

Returns where an app may connect out.

Its action, for a key's grant: `apps:get`.

Path: `id`.

Returns a [SandboxNetwork](#sandboxnetwork).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/network" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.getNetwork("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.get_network("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.get_network("APP_ID")
```

```bash title="CLI"
runtime apps get-network APP_ID
```

## `metrics`

`GET /v2/apps/{id}/metrics`

Returns an app's CPU, memory, disks and pressure, as its host reads them from the app's own cgroup over a fifth of a second: never a call into the app, so it does not wake a paused one nor keep one from its idle pause. One that is not running has no reading.

Its action, for a key's grant: `apps:get`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `range` | one of `15m`, `1h`, `6h`, `24h`, `7d`, `30d` | No | The window: `15m`, `1h`, `6h`, `24h`, `7d` or `30d`. Default: "1h". |

Returns a [SandboxMetrics](#sandboxmetrics).

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/metrics" \
  -H "Authorization: Bearer $RUNTIME_API_KEY"
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.metrics("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.metrics("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.metrics("APP_ID")
```

```bash title="CLI"
runtime apps metrics APP_ID
```

## `setNetwork`

`PUT /v2/apps/{id}/network`

Replaces where an app may connect out, for its next connection and within a second for its open ones: those the new rules refuse are cut.

Its action, for a key's grant: `apps:network`.

Path: `id`.

Body: a [NetworkRules](#networkrules).

Returns a [SandboxNetwork](#sandboxnetwork).

Examples:

```bash title="curl"
curl -X PUT "https://api.withruntime.com/v2/apps/APP_ID/network" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.setNetwork("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.set_network("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.set_network("APP_ID")
```

```bash title="CLI"
runtime apps set-network APP_ID
```

## `fork`

`POST /v2/apps/{id}:fork`

Copies an app as it is now, memory and disk, into `count` copies of its own, each running on its host. Asked again with the same Idempotency-Key, it returns the same copies.

Its action, for a key's grant: `apps:fork`.

Path: `id`.

Body: a [ForkRequest](#forkrequest).

Returns a [Forked](#forked).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:fork" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.fork("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.fork("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.fork("APP_ID")
```

```bash title="CLI"
runtime apps fork APP_ID
```

## `snapshot`

`POST /v2/apps/{id}:snapshot`

Keeps an app's memory and disk as they are now, a snapshot to start apps from; with `image`, its disk alone as that image's next version. The app runs on. Asked again with the same Idempotency-Key, it returns the same snapshot.

Its action, for a key's grant: `apps:snapshot`.

Path: `id`.

Body: a [SnapshotRequest](#snapshotrequest).

Returns a [Stored](#stored).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:snapshot" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.snapshot("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.snapshot("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.snapshot("APP_ID")
```

```bash title="CLI"
runtime apps snapshot APP_ID
```

## `update`

`POST /v2/apps/{id}:update`

Changes its name, labels, idle pause, maxCost, autoWake, lifetime, delete protection, environment or sizes; each field left out stays as it is. A lifetime (`deleteAfterSeconds`) sent again before its end moves the end to that many seconds from now; 0 takes it off. A lifetime is refused (409 `delete_protected`) while `deleteProtection` is true. A running one holds a changed environment before this answers (a paused one's at its wake): each process it starts after the answer has it, and its running processes keep the one they started with. Its vCPUs, memory and disk grow while it runs, its commands running on. One paused or stopped is not woken for it: judged at once as a live resize is (past the vCPUs it was made with 409, over its organization's limits `quota_exceeded`), its new sizes are returned at once, and its next wake grows it to them before the call that woke it runs. A smaller size, or a machine starting or failed, is refused 409 naming why, and nothing is changed. With If-Match, made only while its revision is that one, else 412. Sent again with the same Idempotency-Key and body while it is the latest change, it returns the current state and changes nothing; the same key with a different body returns 409 idempotency_key_reused.

Its action, for a key's grant: `apps:update`.

Path: `id`.

Body: a [MachineUpdate](#machineupdate).

Returns a [Sandbox](#sandbox).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:update" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.update("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.update("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.update("APP_ID")
```

```bash title="CLI"
runtime apps update APP_ID
```

## `screenshot`

`GET /v2/apps/{id}/screenshot`

Returns what an app's screen shows now, as `image/png` (or `image/jpeg`): its X display `:1`, whole. Refused 409 `display_not_running` when no display runs. A paused app is resumed first.

Its action, for a key's grant: `apps:exec`.

Path: `id`.

Query:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `format` | one of `png`, `jpeg` | No | `png`, or `jpeg`: smaller and quicker to send, for a model that reads it. Default: "png". |
| `quality` | integer | No | A jpeg's quality, 1 to 100. At least 1. At most 100. Default: 80. |

Returns the bytes, `application/octet-stream`.

Examples:

```bash title="curl"
curl -X GET "https://api.withruntime.com/v2/apps/APP_ID/screenshot" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -o out.bin
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.screenshot("APP_ID");
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.screenshot("APP_ID")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.screenshot("APP_ID")
```

```bash title="CLI"
runtime apps screenshot APP_ID
```

## `act`

`POST /v2/apps/{id}:act`

Moves, clicks, drags and scrolls the mouse and types on the keyboard of an app's screen (its X display `:1`), each step in turn as one command, and returns where the mouse is then. It stops at the first step that fails, refused 409 `act_failed` naming it; refused 409 `display_not_running` when no display runs. A paused app is resumed first.

Its action, for a key's grant: `apps:exec`.

Path: `id`.

Body: a [ActRequest](#actrequest).

Returns a [Acted](#acted).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:act" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "actions": [{ "type": "move" }] }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.act("APP_ID", { actions: [{ type: "move" }] });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.act("APP_ID", actions=[{"type": "move"}])
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.act("APP_ID", actions: [{ type: "move" }])
```

```bash title="CLI"
runtime apps act APP_ID --actions '{ "type": "move" }'
```

## `runCode`

`POST /v2/apps/{id}:runCode`

Runs a cell of Python in an app as a notebook does, in a Jupyter kernel it keeps running for the cell's `context`: variables, imports and functions stay for the next cell. Returns what it printed, its values and displays (text, HTML, images such as charts), and its exception with its traceback. The context's kernel starts on its first cell. A cell past `timeoutSeconds` is interrupted and its context kept. Refused 409 `kernel_not_installed` when the image has no ipykernel. A paused app is resumed first.

Its action, for a key's grant: `apps:exec`.

Path: `id`.

Body: a [RunCode](#runcode).

Returns a [CodeRun](#coderun).

Examples:

```bash title="curl"
curl -X POST "https://api.withruntime.com/v2/apps/APP_ID:runCode" \
  -H "Authorization: Bearer $RUNTIME_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "code": "example" }'
```

```ts title="TypeScript"
import { Runtime } from "withruntime";

const runtime = new Runtime(); // RUNTIME_API_KEY from the environment
const result = await runtime.apps.runCode("APP_ID", { code: "example" });
```

```python title="Python"
from withruntime import Runtime

runtime = Runtime()  # RUNTIME_API_KEY from the environment
result = runtime.apps.run_code("APP_ID", code="example")
```

```ruby title="Ruby"
require "withruntime"

runtime = Withruntime::Runtime.new # RUNTIME_API_KEY from the environment
result = runtime.apps.run_code("APP_ID", code: "example")
```

```bash title="CLI"
runtime apps run-code APP_ID --code example
```

## Objects

### MachineStart

A command a machine starts at every fresh boot.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cmd` | string (run by `bash -lc`) or list of strings (the program and its arguments) | Yes | The command: text, run by `bash -lc`, or the program and its arguments as a list, run without a shell. |
| `cwd` | string | No | The directory it runs in; the user's home when omitted. |
| `env` | object of strings | No | Environment variables to add. |
| `readyPort` | integer | No | A port it listens on once ready: a create answers once something listens there. At least 1. At most 65535. |
| `readyCommand` | string | No | A shell command that exits 0 once it is ready, run by `/bin/sh -c` in `cwd` until it does: a create answers once it has. |
| `readyTimeoutSeconds` | integer | No | How long a create waits for `readyPort` or `readyCommand`, 1 to 300 seconds: 60 when omitted. At least 1. At most 300. |

### VolumeMount

A volume a machine attaches at its create, mounted read-write in it, one machine at a time; detached when the machine is deleted.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `volume` | string | Yes | The volume, by name or ID, in the machine's project. |
| `path` | string | Yes | Where it is mounted, such as `/data`: an absolute path, not under `/proc`, `/sys`, `/dev`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib` or `/boot`. |

### SandboxRun

A command a machine runs once it starts: when it ends, the machine stops.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cmd` | string (run by `bash -lc`) or list of strings (the program and its arguments) | Yes | The command: text, run by `bash -lc`, or the program and its arguments as a list, run without a shell. |
| `cwd` | string | No | The directory it runs in; the user's home when omitted. |
| `env` | object of strings | No | Environment variables to add. |
| `timeoutSeconds` | number | No | Seconds it may run before it is stopped (`1.5` for 1,500 ms); no limit when omitted or 0. At least 0. |

### NetworkRules

Where a machine may connect out, past the walls every machine has.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `allowOutbound` | list of string | No | The only places it may reach, each a host, `*.` and a name for every name under it, an address or a CIDR (`[` and `]` around an IPv6 address), every port when it names none; `:port` for that port alone, on a host name for a port beyond 80 and 443, which go together. `*` is every public host. Every public host when omitted; nothing when empty. |
| `denyOutbound` | list of string | No | Places it may never reach, written as in allowOutbound with no port: a deny wins over every allow. |

### SandboxSettings

A machine's settings: what a create sets on it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vcpu` | integer | No | Its vCPUs; its product's default when omitted. At least 1. |
| `memoryGB` | number | No | Its memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`1.5`). Its product's default when omitted. At least 1. |
| `diskGB` | number | No | Its disk in GB (1 GB is 1,024 MiB), to the MiB. When omitted, its product's default or its image's size, whichever is larger. At least 1. |
| `image` | string | No | The image it boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `secrets` | list of string | No | The secrets it may get, by name, at most 64: only those of them whose scope admits it; [] none; every one whose scope admits it when omitted. A name with no secret yet takes effect once that secret is created. Fixed for its life: a fork or a copy of a snapshot keeps it. At most 64 items. |
| `start` | [MachineStart](#machinestart) | No | The command it starts at every fresh boot and keeps running, as a service: a web server, a runner, a desktop. A wake with its memory kept does not start it again. Its image's when omitted. |
| `user` | one of `runtime`, `root` | No | Who every command, process, terminal and code run in it runs as when the call names no `user`: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |

### SandboxCreate

A machine to create.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vcpu` | integer | No | Its vCPUs; its product's default when omitted. At least 1. |
| `memoryGB` | number | No | Its memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`1.5`). Its product's default when omitted. At least 1. |
| `diskGB` | number | No | Its disk in GB (1 GB is 1,024 MiB), to the MiB. When omitted, its product's default or its image's size, whichever is larger. At least 1. |
| `image` | string | No | The image it boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `secrets` | list of string | No | The secrets it may get, by name, at most 64: only those of them whose scope admits it; [] none; every one whose scope admits it when omitted. A name with no secret yet takes effect once that secret is created. Fixed for its life: a fork or a copy of a snapshot keeps it. At most 64 items. |
| `start` | [MachineStart](#machinestart) | No | The command it starts at every fresh boot and keeps running, as a service: a web server, a runner, a desktop. A wake with its memory kept does not start it again. Its image's when omitted. |
| `user` | one of `runtime`, `root` | No | Who every command, process, terminal and code run in it runs as when the call names no `user`: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |
| `volumes` | list of [VolumeMount](#volumemount) | No | Volumes it attaches and mounts at its create, at most one; detached when it is deleted, to attach to another. |
| `run` | [SandboxRun](#sandboxrun) | No | A command it runs once it starts. When the command ends, the machine is `paused` with its disk kept (exitCode says how it ended) and a call starts it again. Needs the `exec` permission too. |
| `name` | string | No | Its name, unique in its project. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels to find it by. |
| `getOrCreate` | boolean | No | With a name: the machine of that name when there is one, else a new one. |
| `maxCost` | string (US dollars, decimal) | No | The most it may cost in all, in US dollars (`"5.00"`): once it has cost that it pauses, and starts again only once its maxCost is raised (`update`); what a key's per-request and spend caps count. When omitted under a key with a per-request or spend cap, the most that key's caps leave. |
| `idlePauseSeconds` | integer | No | Seconds with nothing happening before it pauses, 60 to 86400; 0 never; its product's default when omitted (300 for a sandbox). A fork keeps its source's, except 0: a copy never pauses only when its fork asks. At least 0. At most 86400. |
| `from` | string | No | What it starts as, by ID or name: a snapshot (a copy of it running, at its sizes, in its project, with its secrets) or an image (as `image` takes it). A name is a snapshot's when the project has one of that name, else an image's. Not with `image`. Running copies of a sandbox are `fork`'s. |
| `snapshot` | string | No | Deprecated: SDK 1.0.x's name for `from` with a snapshot, read as `from` ([`snapshot_is_from`]). Not with `from`. |
| `network` | [NetworkRules](#networkrules) | No | Where it may connect out from its first start, as setNetwork takes it; the open internet behind every machine's walls when omitted. |
| `env` | object of strings | No | Environment variables for every command and process in it and its start, at most 32 and 32768 bytes of names and values; values are never answered. A copy keeps them. |
| `autoWake` | boolean | No | Whether a call that reaches it paused (an exec, a file, a terminal, a preview's visitor) resumes it; true when omitted. false: such a call answers 409 sandbox_paused and it stays paused until its own `:resume`. A fork's copies keep it. |
| `deleteAfterSeconds` | integer | No | Seconds until Runtime deletes it, as its delete does: final at once, its memory and disk gone and no longer billed; it can't be undone. 0 or omitted: kept until deleted. Its owner renews it with update; a copy, snapshot or image made from it sets its own. At least 0. At most 315360000. |
| `deleteProtection` | boolean | No | Whether its delete is refused (409 `delete_protected`) until an update turns this off; false when omitted. Not with `deleteAfterSeconds`. While true, its time limit pauses it instead of deleting it; only its organization's close deletes it. A copy, snapshot or image made from it sets its own. |

### MachineReady

How a create's wait for its start's ready check (`start.readyPort`, `start.readyCommand`) went.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | one of `ready`, `timeout`, `not_running` | Yes | `ready` (the check passed), `timeout` (not within `readyTimeoutSeconds`), or `not_running` (it never ran). |
| `waitedMs` | integer | Yes | How long it waited, in milliseconds. |

### Sandbox

A machine.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vcpu` | integer | No | Its vCPUs; its product's default when omitted. At least 1. |
| `memoryGB` | number | No | Its memory in GB (1 GB is 1,024 MiB); a fraction is taken to the MiB (`1.5`). Its product's default when omitted. At least 1. |
| `diskGB` | number | No | Its disk in GB (1 GB is 1,024 MiB), to the MiB. When omitted, its product's default or its image's size, whichever is larger. At least 1. |
| `image` | string | No | The image it boots, by name (its newest version), `name:version` or ID; Runtime's default image when omitted. |
| `secrets` | list of string | No | The secrets it may get, by name, at most 64: only those of them whose scope admits it; [] none; every one whose scope admits it when omitted. A name with no secret yet takes effect once that secret is created. Fixed for its life: a fork or a copy of a snapshot keeps it. At most 64 items. |
| `start` | [MachineStart](#machinestart) | No | The command it starts at every fresh boot and keeps running, as a service: a web server, a runner, a desktop. A wake with its memory kept does not start it again. Its image's when omitted. |
| `user` | one of `runtime`, `root` | No | Who every command, process, terminal and code run in it runs as when the call names no `user`: `runtime` (uid 1000, with passwordless sudo) or `root`. Its image's when omitted, else `runtime`. |
| `id` | string | Yes | Its ID. |
| `object` | one of `sandbox`, `function`, `app`, `site`, `ci`, `browser`, `desktop`, `notebook`, `workspace`, `container`, `build`, `agent.session` | Yes | Its product's kind: `sandbox` for a sandbox, `app` for an app, and so on. |
| `name` | string | No | Its name, unique in its project. |
| `state` | one of `starting`, `running`, `paused`, `deleted`, `error` | Yes | Where it is. |
| `labels` | labels (keys under `runtime.` are Runtime's) | Yes | Its labels. |
| `createdAt` | string (RFC 3339) | No | When it was created. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer alone. |
| `revision` | integer | No | Its revision, changed by every change to it: what an update's If-Match names. |
| `idlePauseSeconds` | integer | No | Seconds with nothing happening before it pauses; 0 never. Default: 300. |
| `maxCost` | string (US dollars, decimal) | No | The most it may cost in all, in US dollars; none when it has no such cap. |
| `autoWake` | boolean | No | Whether a call that reaches it paused resumes it; false: only its own resume does, and such a call answers 409 sandbox_paused. Default: true. |
| `exitCode` | integer | No | Its run's exit code, once its run ended; none for one a signal or its timeout ended. |
| `endedAt` | string (RFC 3339) | No | When its run ended. |
| `pausedAt` | string (RFC 3339) | No | When its pause began (or its run ended), while it is paused. |
| `ready` | [MachineReady](#machineready) | No | A create's answer alone, for a start with a ready check: how its wait went. |
| `deleteAt` | string (RFC 3339) | No | When Runtime deletes it (`deleteAfterSeconds`), finally: it can't be undone, as its delete can't; none: kept until deleted. |
| `deleteProtection` | boolean | No | Whether its delete is refused (409 `delete_protected`) until an update turns this off. |

### Terminal

A terminal's size.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cols` | integer | Yes | Its columns. At least 1. At most 65535. |
| `rows` | integer | Yes | Its rows. At least 1. At most 65535. |

### ExecRequest

A command to run: to its end, or started and answered at once (`wait: false`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cmd` | string (run by `bash -lc`) or list of strings (the program and its arguments) | Yes | The command: text, run by `bash -lc` (`"npm test"`), or a list, the program and its arguments run without a shell (`["npm", "test"]`). |
| `cwd` | string | No | The directory it runs in; the user's home when omitted. |
| `env` | object of strings | No | Environment variables to add. |
| `stdin` | string (base64) | No | Bytes sent to its standard input. |
| `timeoutSeconds` | number | No | Seconds it may run before it is stopped (`1.5` for 1,500 ms); it runs to its end when omitted or 0. At least 0. |
| `stream` | boolean | No | Answer as NDJSON events while it runs (start, stdout, stderr, exit), as `Accept: application/x-ndjson` does. |
| `wait` | boolean | No | Wait for it to end and return it with its output. False returns it at once, running: read its output with processes.output, send it input with processes.write and signals with processes.signal. Default: true. |
| `stdinOpen` | boolean | No | Keep its standard input open for processes.write; not with stdin, and not with a wait for its end. |
| `outputEncoding` | one of `utf8`, `base64` | No | How processes.output answers its output. Default: "utf8". |
| `pty` | [Terminal](#terminal) | No | Run it on a terminal of this size: its input, output and controlling terminal; not with a wait for its end. |
| `user` | one of `runtime`, `root` | No | Who it runs as: `runtime` (uid 1000, with passwordless sudo) or `root`; the machine's `user` when omitted. |

### Process

A process.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `process` | Yes | Always `process`. |
| `state` | one of `running`, `exited`, `killed`, `timed_out` | Yes | Where it is. |
| `exitCode` | integer | No | Its exit code once it exited; negative when a signal ended it. |
| `command` | string | Yes | The command it runs. |
| `cwd` | string | No | The directory it runs in. |
| `pty` | boolean | Yes | It runs on a terminal. |
| `stdinOpen` | boolean | Yes | Its standard input is open for processes.write. |
| `stdinOffset` | integer | Yes | Bytes of input it has taken. |
| `outputEncoding` | one of `utf8`, `base64` | Yes | How its output is answered. |
| `startedAt` | string (RFC 3339) | Yes | When it started. |
| `endedAt` | string (RFC 3339) | No | When it ended. |
| `timeoutSeconds` | number | No | Seconds it may run before it is killed. |
| `outputBytes` | integer | Yes | Bytes of output it has written: the cursor past its last. |
| `firstOffset` | integer | Yes | The oldest byte of its output still kept. |
| `stdout` | string | No | What it wrote to standard output, as UTF-8: given once an exec waited for its end. |
| `stderr` | string | No | What it wrote to standard error, as UTF-8: given once an exec waited for its end. |
| `stdoutTruncated` | boolean | No | stdout holds only part of what it wrote (its first 1 MiB). |
| `stderrTruncated` | boolean | No | stderr holds only part of what it wrote (its first 1 MiB). |
| `durationSeconds` | number | No | How long it ran, in seconds, to the millisecond, once it ended. |

### ExecEventError

A failed read of an exec's events: the error the API would have answered, and where to follow on from.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | Yes | The error's code. |
| `message` | string | No | What went wrong. |
| `status` | integer | No | The status the API answered. |
| `processId` | string | No | The process. |
| `cursor` | integer | No | The cursor to follow its output on from (processes.output). |

### ExecEvent

One event of an exec asked for its events (`stream: true`, or `Accept: application/x-ndjson`), one JSON object a line: `start`, then `stdout` and `stderr` as the output comes, `truncated` when output was dropped before it was read, and `exit`; or `continue` (follow on with processes.output from `cursor`) or `error`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | one of `start`, `stdout`, `stderr`, `truncated`, `exit`, `continue`, `error` | Yes | `start`, `stdout`, `stderr`, `truncated`, `exit`, `continue` or `error`. |
| `processId` | string | No | The process: `start` and `continue`. |
| `replayed` | boolean | No | `start`: this Idempotency-Key ran it before, and these are that run's events again. |
| `data` | string | No | `stdout` and `stderr`: the output, as text. |
| `base64` | string | No | `stdout` and `stderr`: the output's bytes, in base64, with outputEncoding `base64`. |
| `offset` | integer | No | `stdout` and `stderr`: where in the process's output these bytes start. |
| `droppedBytes` | integer | No | `truncated`: how many bytes were dropped. |
| `resumeAt` | integer | No | `truncated`: where the output read on from. |
| `exitCode` | integer | No | `exit`: its exit code. |
| `state` | one of `running`, `exited`, `killed`, `timed_out` | No | `exit`: how it ended. |
| `timedOut` | boolean | No | `exit`: it was stopped at its timeout. |
| `durationSeconds` | number | No | `exit`: how long it ran. |
| `cursor` | integer | No | `continue`: the cursor to follow its output on from (processes.output). |
| `error` | [ExecEventError](#execeventerror) | No | `error`: what failed. |

### FileWritten

A file written.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `size` | integer | Yes | Its size in bytes, after the write. |
| `sha256` | string | No | Its SHA-256 in hex: given for a file written whole. |
| `offset` | integer | No | Where the bytes were written: given for a write at an offset. |

### OutputChunk

Some of a process's output.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `offset` | integer | Yes | Where it starts in the process's output. |
| `stream` | one of `stdout`, `stderr` | Yes | The stream it was written to. |
| `text` | string | Yes | It, as text. |
| `base64` | string (base64) | No | It, as bytes, when the process answers base64. |

### ProcessOutput

A process's output after a cursor.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `chunks` | list of [OutputChunk](#outputchunk) | Yes | The output, in the order it was written. |
| `nextCursor` | integer | Yes | The cursor to read on from. |
| `truncated` | boolean | Yes | Output past the cursor was dropped before it was read. |
| `droppedBytes` | integer | Yes | How many bytes were dropped. |
| `process` | [Process](#process) | No | The process. |

### ProcessInput

Input to send a process.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `data` | string (base64) | No | The bytes. |
| `offset` | integer | No | Bytes of input sent before these (its stdinOffset): a resend is then never taken twice. They go after every other write when omitted. |
| `eof` | boolean | No | Close its input after these (^D on a terminal). |

### ProcessWritten

Input a process took.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `offset` | integer | Yes | Bytes of input it has taken in all. |
| `process` | [Process](#process) | No | The process. |

### ProcessSignal

A signal to send a process and its group.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `signal` | one of `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGUSR1`, `SIGUSR2`, `SIGKILL` | No | The signal; SIGTERM when omitted. |

### ProcessList

A machine's processes, newest first.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `items` | list of [Process](#process) | Yes | Each process. |

### FileRemove

A file, a link or a directory to remove.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `recursive` | boolean | No | A directory with its contents; refused for a directory with contents when omitted. |

### FileRemoved

A file, a link or a directory removed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `removed` | boolean | Yes | It was there and is removed; false when it was missing. |

### FileInfo

A path in a machine: what is there, if anything.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `exists` | boolean | Yes | Something is there. |
| `name` | string | No | Its last part. |
| `type` | one of `file`, `directory`, `symlink`, `other` | No | What it is: `file`, `directory`, `symlink` or `other`. |
| `size` | integer | No | Its size in bytes. |
| `mode` | string | No | Its permissions, in octal (`0644`). |
| `modifiedAt` | string (RFC 3339) | No | When it last changed. |
| `uid` | integer | No | Its owner's user ID. |
| `gid` | integer | No | Its group's ID. |
| `symlinkTarget` | string | No | Where a link points. |
| `sha256` | string | No | A file's SHA-256 in hex, read from its bytes: given when asked (`sha256=true`). |

### FileList

What a directory holds, in path order.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `items` | list of [FileInfo](#fileinfo) | Yes | Each entry. |
| `truncated` | boolean | Yes | There were more entries than limit. |

### FolderUnpacked

A folder unpacked.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The folder. |
| `received` | integer | Yes | The archive's bytes tar took. |

### FolderUploadBegin

A folder upload to begin: a tar archive sent in parts, unpacked into a folder as they arrive.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The folder, absolute and plain, such as `/workspace/app`: made with its parents. |
| `gzip` | boolean | No | The archive is gzip-compressed (`.tar.gz`). Default: false. |
| `user` | one of `runtime`, `root` | No | Who unpacks it: `runtime` or `root`; the machine's `user` when omitted. |

### FolderUpload

A folder upload begun: its parts go to it in order, then its commit.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `uploadId` | string | Yes | Its ID, which its parts, its commit and its abort name. |
| `path` | string | Yes | The folder it unpacks into. |
| `gzip` | boolean | Yes | The archive is gzip-compressed. |
| `chunkBytes` | integer | Yes | The most bytes a part should carry. |

### FolderUploadReceived

A folder upload's part taken.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `received` | integer | Yes | The archive's bytes tar has taken so far: the next part's offset. |

### FolderUploadAborted

A folder upload ended unfinished.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `aborted` | boolean | Yes | Always true: tar was stopped; what it unpacked stays. |

### FileMkdir

A directory to make.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `parents` | boolean | No | Its parents are made too; true when omitted. |

### FileMade

A directory made.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Its path. |
| `created` | boolean | Yes | It was made; false when it was there already. |

### FileRename

A file, a link or a directory to move.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | Yes | Where it is. |
| `to` | string | Yes | Where it goes. |
| `overwrite` | boolean | No | Replace what is at `to`; refused 409 when something is there and this is omitted. |
| `sha256` | string | No | The file's SHA-256 in hex: only a file whose bytes hash to it moves. With it, a rename sent again after it moved returns the same answer. |
| `size` | integer | No | The file's size in bytes: only a file of this size, every byte of it written, moves. At least 0. |

### FileRenamed

A file, a link or a directory moved.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string | Yes | Where it was. |
| `to` | string | Yes | Where it is now. |
| `size` | integer | No | Its size in bytes: given for a move checked by sha256. |
| `sha256` | string | No | Its SHA-256 in hex: given for a move checked by sha256. |

### FileLinkCreate

A file link to make: an expiring address for one file of a machine (or, with `archive`, a folder) that anyone may open with no API key.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | The file's absolute path in the machine. For GET it must exist when the link is made. |
| `method` | one of `GET`, `PUT` | No | `GET` (default): a download link. `PUT`: an upload link; the request's body becomes the file. |
| `expiresInSeconds` | integer | No | How long the link works, in seconds. At least 60. At most 604800. Default: 3600. |
| `filename` | string | No | Download as this name (`Content-Disposition: attachment`). Without it a picture, video, sound or plain text shows in the browser; anything else downloads. |
| `maxBytes` | integer | No | PUT only: the largest body the link takes, in bytes; 5 GiB by default and at most. At least 0. At most 5368709120. |
| `wake` | boolean | No | false: a paused machine is not woken for the link, which answers 409 `sandbox_paused`. Unset or true: it is woken. |
| `archive` | boolean | No | GET only: `path` is a folder, downloaded as a `.tar.gz`. Default: false. |

### FileLink

A file link.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | Yes | Its address, opened with no key: GET to download, PUT the file's bytes to upload. |
| `method` | one of `GET`, `PUT` | Yes | `GET` or `PUT`. |
| `path` | string | Yes | The file's path in the machine. |
| `sandboxId` | string | Yes | The machine. |
| `expiresAt` | string (RFC 3339) | Yes | When it stops working. |
| `filename` | string | No | The name it downloads as. |
| `maxBytes` | integer | No | The largest body an upload link takes. |
| `archive` | boolean | No | It downloads a folder as a `.tar.gz`. |

### FileLinksRevoked

A machine's file links ended.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxId` | string | Yes | The machine. |
| `revokedAt` | string (RFC 3339) | Yes | When they ended: every link made before it. |

### SandboxNetwork

Where a machine may connect out.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `allowOutbound` | list of string | No | The only places it may reach, each a host, `*.` and a name for every name under it, an address or a CIDR (`[` and `]` around an IPv6 address), every port when it names none; `:port` for that port alone, on a host name for a port beyond 80 and 443, which go together. `*` is every public host. Every public host when omitted; nothing when empty. |
| `denyOutbound` | list of string | No | Places it may never reach, written as in allowOutbound with no port: a deny wins over every allow. |
| `id` | string | Yes | The machine's ID. |

### MetricPoint

A machine's CPU and memory as its host measures them from the machine's own cgroup, never by a call into the machine, so reading them does not wake it or keep it awake. Either the current reading (over the host's last 5 seconds, with disk and pressure) or one step of a window (averaged over the time the machine ran in it).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `at` | string (RFC 3339) | Yes | When it was read; for a step, where the step starts. |
| `cpuPercent` | number | Yes | Its CPU, as a percent of all its vCPUs (0 to 100). |
| `cpuCores` | number | No | The same as a number of cores. |
| `cpuPeakPercent` | number | No | Its busiest minute, as a percent of all its vCPUs. |
| `cpuWaitPercent` | number | No | Percent of the last 10 seconds some task of it waited for a CPU. |
| `memoryStallPercent` | number | No | Percent of the last 10 seconds some task of it waited for memory. |
| `memoryBytes` | integer | Yes | Memory it holds, in bytes: its resident memory on its host. |
| `memoryPeakBytes` | integer | No | The most memory it has held, in bytes; for a step, its highest minute's average. |
| `samples` | integer | Yes | How many measures it is made of: two reads for the reading now; for a step, the minutes the host measured it in. |
| `diskReadBytesPerSecond` | number | No | Bytes its disks read a second. |
| `diskWriteBytesPerSecond` | number | No | Bytes its disks wrote a second. |
| `diskReadOpsPerSecond` | number | No | Reads its disks completed a second. |
| `diskWriteOpsPerSecond` | number | No | Writes its disks completed a second. |

### MetricsBase

A machine's CPU and memory over a time window, in steps, and its current reading (with disk and pressure) while it runs. Steps are returned in every state, including paused and stopped. Ranges: `15m` and `1h` in 60-second steps, `6h` in 120-second steps, `24h` in 480-second steps, `7d` and `30d` in 1-hour steps. Defaults to `1h`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | one of `starting`, `running`, `paused`, `deleted`, `error` | Yes | Its state. |
| `range` | one of `15m`, `1h`, `6h`, `24h`, `7d`, `30d` | Yes | The window asked for. |
| `stepSeconds` | integer | Yes | The window's step, in seconds. |
| `since` | string (RFC 3339) | Yes | Where the window starts: the start of the step that holds the range's start. |
| `until` | string (RFC 3339) | Yes | Where it ends: now. |
| `vcpu` | integer | Yes | Its vCPUs. |
| `memoryLimitBytes` | integer | Yes | Its memory, in bytes. |
| `diskLimitBytes` | integer | Yes | Its disk, in bytes. |
| `latest` | [MetricPoint](#metricpoint) | No | The reading taken now; none when it is not running or its host could not read it. |
| `points` | list of [MetricPoint](#metricpoint) | Yes | The window's steps, oldest first, each averaged over the time the machine ran in it. Steps in which it did not run are omitted. A minute appears about a minute after it ends; `latest` holds the current reading. |

### SandboxMetrics

A machine's metrics.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | one of `starting`, `running`, `paused`, `deleted`, `error` | Yes | Its state. |
| `range` | one of `15m`, `1h`, `6h`, `24h`, `7d`, `30d` | Yes | The window asked for. |
| `stepSeconds` | integer | Yes | The window's step, in seconds. |
| `since` | string (RFC 3339) | Yes | Where the window starts: the start of the step that holds the range's start. |
| `until` | string (RFC 3339) | Yes | Where it ends: now. |
| `vcpu` | integer | Yes | Its vCPUs. |
| `memoryLimitBytes` | integer | Yes | Its memory, in bytes. |
| `diskLimitBytes` | integer | Yes | Its disk, in bytes. |
| `latest` | [MetricPoint](#metricpoint) | No | The reading taken now; none when it is not running or its host could not read it. |
| `points` | list of [MetricPoint](#metricpoint) | Yes | The window's steps, oldest first, each averaged over the time the machine ran in it. Steps in which it did not run are omitted. A minute appears about a minute after it ends; `latest` holds the current reading. |
| `id` | string | Yes | The machine's ID. |

### ForkRequest

Copies of a machine to make, as it is now.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `count` | integer | No | How many. At least 1. At most 100. Default: 1. |
| `name` | string | No | Its name, for a fork of one. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels each copy gets. |
| `secrets` | list of string | No | The secrets each copy gets, by name: only these, never one its source may not use; its source's when omitted. At most 64 items. |
| `maxCost` | string (US dollars, decimal) | No | The most each may cost in all, in US dollars (`"5.00"`): once one has cost that it pauses, as a create's maxCost. When omitted, the least of its key's caps and its source's maxCost. |
| `idlePauseSeconds` | integer | No | Seconds with nothing happening before each copy pauses, 60 to 86400; 0 never. When omitted, its source's, unless its source never pauses (0): then its product's default, 300 for a sandbox. At least 0. At most 86400. |
| `vcpu` | integer | No | The vCPUs each copy may use, at most its source's; its source's when omitted. A copy keeps its source's vCPUs online and is held to this many vCPUs of CPU time, which it is placed and billed by. Its memory is its source's. At least 1. |
| `deleteAfterSeconds` | integer | No | Seconds until Runtime deletes each copy, as its delete does: final, and it can't be undone. 0 or omitted: kept until deleted; a copy never takes its source's. At least 0. At most 315360000. |
| `deleteProtection` | boolean | No | Whether each copy's delete is refused (409 `delete_protected`) until an update turns this off; false when omitted. Not with `deleteAfterSeconds`; a copy never takes its source's. |

### Forked

The copies a fork made, each running.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sandboxes` | list of [Sandbox](#sandbox) | Yes | The copies, in the order made. |

### SnapshotRequest

A snapshot of a machine to take.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Its name, unique among the project's snapshots. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Labels to find it by. |
| `image` | string | No | Keeps its disk alone, synced, as the next version of the image of this name (`name:1`, `name:2`, ...) in place of a snapshot: an image machines are created from, each booting fresh over a disk of its own. Its memory is not kept; name is ignored. |
| `start` | [MachineStart](#machinestart) | No | With image: the command each machine created from the image starts at every fresh boot; the machine's own when omitted. |
| `deleteAfterSeconds` | integer | No | Seconds until Runtime deletes the snapshot (or, with image, that image version), as its delete does: final, and it can't be undone. 0 or omitted: kept until deleted. At least 0. At most 315360000. |
| `deleteProtection` | boolean | No | Whether the snapshot's (or, with image, that image version's) delete is refused (409 `delete_protected`) until an update turns this off; false when omitted. Not with `deleteAfterSeconds`. |

### Stored

Stored data: a snapshot, an image or a volume.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | Yes | Its ID. |
| `object` | one of `snapshot`, `image`, `volume` | Yes | Its kind: `snapshot`, `image` or `volume`. |
| `name` | string | No | Its name, unique in its project among its kind. |
| `state` | one of `making`, `ready`, `failed`, `deleted` | Yes | Where it is. |
| `labels` | labels (keys under `runtime.` are Runtime's) | Yes | Its labels. |
| `sizeBytes` | integer | Yes | What it was made to hold, in bytes. |
| `storedBytes` | integer | Yes | What it holds now, in bytes. |
| `parentId` | string | No | What it was made from (a snapshot's machine, an image's base), if anything. |
| `attachedTo` | string | No | The machine it is attached to now, if any. |
| `createdAt` | string (RFC 3339) | No | When it was made. |
| `version` | integer | No | An image's version of its name: each build or keep of a name is its next. |
| `tags` | list of string | No | An image's tags, each `name:tag`. |
| `error` | string | No | Why an image's build failed. |
| `deletedAt` | string (RFC 3339) | No | When it was deleted: a delete's answer, its state `deleted`. |
| `deleteAt` | string (RFC 3339) | No | When Runtime deletes it (`deleteAfterSeconds`), finally: it can't be undone, as its delete can't; none: kept until deleted. |
| `deleteWaitsFor` | string | No | Once `deleteAt` has passed, what its delete waits for: the App that boots this image, or the machine this volume is attached to, by its ID. It is deleted as soon as that one no longer does. |
| `deleteProtection` | boolean | No | Whether its delete is refused (409 `delete_protected`) until an update turns this off. |

### MachineUpdate

A change to a machine's settings: each field left out stays as it is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | Its name, unique in its project. |
| `labels` | labels (keys under `runtime.` are Runtime's) | No | Its labels, in place of its own; those under `runtime.` are kept. |
| `idlePauseSeconds` | integer | No | Seconds with nothing happening before it pauses, 60 to 86400; 0 never. Nothing happening means no call or command running, no traffic, almost no CPU, and no outbound connection it opened still open. |
| `vcpu` | integer | No | Its vCPUs, grown while it runs; a running machine's vCPUs only grow. At least 1. |
| `memoryGB` | number | No | Its memory in GB (1 GB is 1,024 MiB), grown while it runs; a running machine's memory only grows. At least 1. |
| `diskGB` | number | No | Its disk in GB (1 GB is 1,024 MiB), grown while it runs, its file system with it; a disk only grows. At least 1. |
| `user` | one of `runtime`, `root` | No | Who its commands run as from now when a call names no `user`: `runtime` or `root`. Running ones keep theirs. |
| `env` | object of strings | No | Environment variables to set, each over its own value, the others kept: the update answers once a running one holds the change (a paused one is given it at its wake), so each process, command and terminal it starts after the answer has them; processes already running keep the environment they started with. At most 32 variables and 32768 bytes of names and values in all, as a create's; values are never answered. |
| `removeEnv` | list of string | No | Names of environment variables to take out, the same way: gone from the next process it starts; processes already running keep them. |
| `maxCost` | string (US dollars, decimal) | No | The most it may cost in all, in US dollars (`"5.00"`), in place of its own: one paused at its old maxCost wakes at its next call under a higher one. |
| `autoWake` | boolean | No | Whether a call that reaches it paused (an exec, a file, a terminal, a preview's visitor) resumes it from now. false: such a call answers 409 sandbox_paused and it stays paused until its own `:resume`. |
| `deleteAfterSeconds` | integer | No | Seconds from now until Runtime deletes it, as its delete does: final, and it can't be undone. Sent again before then, it renews it; 0 takes its end off (kept until deleted). At least 0. At most 315360000. |
| `deleteProtection` | boolean | No | true refuses its delete (409 `delete_protected`) until an update sends false; while true, its time limit pauses it instead of deleting it. Not while it has a `deleteAt`, unless the same update sends `deleteAfterSeconds` 0. |

### Action

One step of an act: a mouse move, click, drag or scroll, typed text, a key chord, or a wait.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | one of `move`, `click`, `mouseDown`, `mouseUp`, `drag`, `scroll`, `type`, `key`, `wait` | Yes | What it does: `move` to `x`,`y`; `click` (at `x`,`y` when given, `count` times, with `keys` held); `mouseDown` and `mouseUp` of `button`; `drag` from `x`,`y` to `toX`,`toY`; `scroll` by `dx`,`dy` wheel clicks (at `x`,`y` when given); `type` `text`; `key` the chords in `keys`; `wait` `ms`. |
| `x` | integer | No | Pixels from the screen's left edge. At least 0. At most 16384. |
| `y` | integer | No | Pixels from the screen's top edge. At least 0. At most 16384. |
| `toX` | integer | No | A drag's end, from the left edge. At least 0. At most 16384. |
| `toY` | integer | No | A drag's end, from the top edge. At least 0. At most 16384. |
| `button` | one of `left`, `middle`, `right` | No | The mouse button of a click, a drag, a mouseDown or a mouseUp. Default: "left". |
| `count` | integer | No | A click's count: 2 a double click, 3 a triple click. At least 1. At most 3. Default: 1. |
| `dx` | integer | No | A scroll's wheel clicks to the right (negative to the left). At least -100. At most 100. |
| `dy` | integer | No | A scroll's wheel clicks down (negative up). At least -100. At most 100. |
| `text` | string | No | The text a `type` types, as it is: any Unicode, newlines and tabs. At most 8192 characters. |
| `keys` | string | No | For `key`, chords pressed in turn, space-separated, each keys joined by `+` in X keysym names (`ctrl+l`, `Return`, `ctrl+shift+t`); for `click` and `scroll`, the modifiers held during it (`shift`, `ctrl+alt`). At most 1000 characters. |
| `ms` | integer | No | A wait's milliseconds. At least 0. At most 10000. |

### ActRequest

Steps of the mouse and keyboard, run in order as one command.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `actions` | list of [Action](#action) | Yes | The steps, in order; the act stops at the first that fails. At least 1 item. At most 100 items. |

### Point

A point on the screen, in pixels from its top left corner.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `x` | integer | Yes |  |
| `y` | integer | Yes |  |

### ScreenSize

The screen's size, in pixels.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `width` | integer | Yes |  |
| `height` | integer | Yes |  |

### Acted

The screen once an act's steps ran.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cursor` | [Point](#point) | Yes | Where the mouse is. |
| `screen` | [ScreenSize](#screensize) | Yes | The screen's size. |

### RunCode

A cell to run.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | Yes | The code. At most 1048576 characters. |
| `language` | one of `python` | No | Its language: `python`. Default: "python". |
| `context` | string | No | The context it runs in, each its own kernel and state, started on its first cell (`a-z`, `0-9`, `-`, at most 63); `default` when omitted. At least 1 character. At most 63 characters. |
| `timeoutSeconds` | integer | No | Seconds it may run before it is interrupted, its context kept: 1 to 50, 45 when omitted. Run longer work as a process (exec with `wait: false`). At least 1. At most 50. |

### CodeResult

One value a cell returned or displayed, in each form it gave.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `main` | boolean | Yes | The cell's own value (its last expression), rather than a display. |
| `text` | string | No | As plain text (`text/plain`). |
| `html` | string | No | As HTML (`text/html`): a table, for a DataFrame. |
| `markdown` | string | No | As Markdown (`text/markdown`). |
| `json` | string | No | As JSON text (`application/json`). |
| `png` | string (base64) | No | As a PNG image (`image/png`): a chart. |
| `jpeg` | string (base64) | No | As a JPEG image (`image/jpeg`). |
| `svg` | string | No | As an SVG image (`image/svg+xml`). |
| `latex` | string | No | As LaTeX (`text/latex`). |

### CodeError

The exception a cell raised.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Its name (`ZeroDivisionError`). |
| `value` | string | Yes | Its message. |
| `traceback` | string | Yes | Its traceback, as text. |

### CodeRun

A cell that ran.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | string | Yes | The context it ran in. |
| `language` | one of `python` | Yes | Its language. |
| `status` | one of `ok`, `error`, `timeout` | Yes | `ok`; `error`, an exception (`error`); `timeout`, interrupted at its time, its context kept. |
| `executionCount` | integer | No | Its number in its context, as a notebook counts cells. |
| `stdout` | string | Yes | What it printed. |
| `stderr` | string | Yes | What it wrote to standard error. |
| `results` | list of [CodeResult](#coderesult) | Yes | The values it returned and displayed, in order. |
| `error` | [CodeError](#codeerror) | No | The exception it raised. |
| `started` | boolean | Yes | Whether its context's kernel was started for it: its first cell, or one after the kernel ended. |
| `durationSeconds` | number | Yes | How long it ran, in seconds. |
