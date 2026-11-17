# Files

| Call | What it does |
| --- | --- |
| [`PUT /v2/sandboxes/{id}/files`](./reference/sandboxes#write) | Writes the request's bytes to a file as they come, of any size (Content-Length required), its folders made: the file whole when they all came, or as it was. With offset, they are written into it in place. |
| [`GET /v2/sandboxes/{id}/files`](./reference/sandboxes#read) | Returns a file's bytes. |
| [`GET /v2/sandboxes/{id}/files/list`](./reference/sandboxes#listfiles) | Lists a directory's entries in path order, to a depth. |
| [`GET /v2/sandboxes/{id}/files/stat`](./reference/sandboxes#stat) | Returns what is at a path: a file, a directory or a link, or nothing (exists false). With sha256=true, a file's SHA-256 too. |
| [`POST /v2/sandboxes/{id}/files:rename`](./reference/sandboxes#rename) | Moves a file, a link or a directory; refused 409 when something is at its new path, unless overwrite. With sha256 or size, a file written in parts is put in place once whole: its writes ended, then only a file of that size with every byte written and whose bytes hash to it moves; refused 409 `upload_incomplete` or `checksum_mismatch`, nothing moved. With sha256, it is safe to send again: once moved, it returns the same answer while `from` is gone and `to` holds those bytes. |
| [`POST /v2/sandboxes/{id}/files:remove`](./reference/sandboxes#remove) | Removes a file, a link or a directory (recursive for one with contents). One missing is success, removed false. |

A write takes the request's body as it comes, so a file of any size is one `PUT` with its `Content-Length`: the file is replaced whole once every byte came, or left as it was. To send a large file in parts at once, or to go on after a lost connection, write each part with `offset` to a new path, then rename that path over the file with the whole file's `size` and `sha256`: once every part's write ended, the rename moves only a file of that size with every byte written and whose bytes hash to it.

```ts
import { Runtime } from "withruntime";

const runtime = new Runtime();
const sandbox = await runtime.sandboxes.create({});
try {
  await runtime.sandboxes.write(sandbox.id, new TextEncoder().encode("a,b\n1,2\n"), { path: "/tmp/data/input.csv" });
  await runtime.sandboxes.exec(sandbox.id, { cmd: "tail -n 1 /tmp/data/input.csv > /tmp/data/out.csv" });
  const out = new TextDecoder().decode(await runtime.sandboxes.read(sandbox.id, { path: "/tmp/data/out.csv" }));
  console.log(out); // 1,2
  if (out.trim() !== "1,2") throw new Error(out);
} finally {
  await runtime.sandboxes.delete(sandbox.id);
}
```

## Resumable uploads

A resumable upload writes a file in parts to a temporary path, then moves it to its final path in one call. A [session](./reference/sessions) token can make every call below.

1. Write each part with `PUT /v2/sandboxes/{id}/files?path=<temporary path>&offset=<byte offset>`. The part's bytes replace the bytes at that range and leave the rest of the file as it was. Parts may be sent in any order and at the same time.
2. Move the file with `POST /v2/sandboxes/{id}/files:rename` and a body of `from` (the temporary path), `to` (the final path), `size` and `sha256` (of the whole file). The call waits until every write to `from` has ended, then moves the file only if it is `size` bytes long, every byte was written, and its bytes hash to `sha256`. Otherwise it returns `409 upload_incomplete` or `409 checksum_mismatch` and moves nothing.
3. To check a file at any time, call `GET /v2/sandboxes/{id}/files/stat?path=<path>&sha256=true`. The response includes the file's `size` and `sha256`, read from its bytes.

Retries:

- **A part.** Sending the same bytes again at the same offset is safe: the file ends with the same bytes. If a write fails or its response is lost, send the same part again. A write that fails part way may leave its range partly written, which the next send of that part replaces.
- **The rename.** A rename that names `sha256` is safe to send again. If the file was already moved, the call returns `200` with the same response (`from`, `to`, `size`, `sha256`) as long as `from` no longer exists and `to` holds a file of that size whose bytes hash to `sha256`. If it was not moved, the call moves it. Sending the same `Idempotency-Key` is allowed but not needed: the file's own size and hash decide the result. A rename without `sha256` is not safe to retry: once moved, it returns `404` for `from`.
- **Checking the result.** Instead of retrying, you can call stat with `sha256=true` on the final path and compare `size` and `sha256` with your own.

A listed folder gives each entry's type, size, mode and time. A sandbox's files last as long as the sandbox. To keep them after it is deleted, take a [snapshot](./snapshots).

## Give this to your agent

Paste this into your coding agent:

> Read https://withruntime.com/docs/files.md. Move this project's files into and out of Runtime sandboxes with the files calls; a write streams, so a file of any size is one call.
>
> This page as Markdown: https://withruntime.com/docs/files.md
