"""GENERATED from _async_products/images.py by scripts/generate_sync.py. Do not edit."""
# Custom images: ``image = runtime.images.build(recipe={"pip": ["pandas"]})``,
# or ``runtime.images.build(name="app", dockerfile=text, context_dir=".")``,
# then ``runtime.sandboxes.create(image="app")``.
from __future__ import annotations

import base64
import hashlib
import io
import os
import re
from typing import Any, Callable, Optional, Union
from urllib.parse import quote

from .._errors import RuntimeError

_KEYS = {"max_image_mib": "maxImageMiB", "memory_mib": "memoryMiB", "disk_mib": "diskMiB",
         "cache_mib": "cacheMiB"}
Files = Union[list[dict[str, Any]], dict[str, Union[str, bytes]]]
_UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", re.I)
CONTEXT_BYTES = 100 * 1048576
CONTEXT_FILES = 20_000
CHUNK_BYTES = 1048576


def _key(name: str) -> str:
    if name in _KEYS:
        return _KEYS[name]
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _enc(value: str) -> str:
    return quote(value, safe="")


def _files(files: Files) -> list[dict[str, Any]]:
    """A list of {path, content, encoding?, mode?}, or {path: text or bytes}."""
    if isinstance(files, list):
        return files
    return [{"path": path, "content": base64.b64encode(content).decode(), "encoding": "base64"}
            if isinstance(content, bytes) else {"path": path, "content": content} for path, content in files.items()]


def _camel(value: Any) -> Any:
    if isinstance(value, dict):
        return {_key(k): v for k, v in value.items() if v is not None}
    return value


def _body(fields: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {}
    for name, value in fields.items():
        if value is None:
            continue
        if name in ("build", "start") and isinstance(value, dict):
            value = _camel(value)
        elif name == "files":
            value = _files(value)
        elif name == "recipe" and isinstance(value, dict) and "files" in value:
            value = {**value, "files": _files(value["files"])}
        body[_key(name)] = value
    return body


def dockerignore_filter(text: Optional[str]) -> Callable[[str], bool]:
    """A .dockerignore as Docker reads it, the same rules as the server's:
    ``#`` comments, ``!`` re-includes, ``**`` crosses directories, a pattern
    naming a directory excludes what is in it, and the last match decides.
    Returns whether a context path is excluded."""
    if not text or not text.strip():
        return lambda path: False
    rules: list[tuple[bool, re.Pattern[str]]] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        if negate:
            line = line[1:].strip()
        parts = [p for p in line.lstrip("/").split("/") if p not in ("", ".")]
        cleaned: list[str] = []
        for part in parts:
            if part == "..":
                if cleaned:
                    cleaned.pop()
            else:
                cleaned.append(part)
        line = "/".join(cleaned)
        if not line:
            continue
        source = ""
        i = 0
        while i < len(line):
            char = line[i]
            if char == "*" and line[i + 1:i + 2] == "*":
                if line[i + 2:i + 3] == "/":
                    source += "(?:.*/)?"
                    i += 3
                else:
                    source += ".*"
                    i += 2
                continue
            if char == "*":
                source += "[^/]*"
            elif char == "?":
                source += "[^/]"
            elif char == "[":
                end = line.find("]", i + 1)
                if end < 0:
                    source += "\\["
                else:
                    body = line[i + 1:end]
                    if body.startswith("!"):
                        body = "^" + body[1:]
                    source += "[" + body.replace("\\", "\\\\") + "]"
                    i = end
            elif char == "\\" and i + 1 < len(line):
                i += 1
                source += re.escape(line[i])
            else:
                source += re.escape(char)
            i += 1
        rules.append((negate, re.compile(f"^{source}$")))

    def excluded(path: str) -> bool:
        parts = path.split("/")
        result = False
        for negate, regex in rules:
            if any(regex.match("/".join(parts[:n])) for n in range(len(parts), 0, -1)):
                result = not negate
        return result
    return excluded


def pack_context(folder: str, dockerignore: Optional[str] = None,
                 dockerfile: Optional[str] = None) -> dict[str, Any]:
    """A folder as a build context, the way ``docker build`` sends it: every
    file its .dockerignore leaves in, in one gzipped tar archive with no
    times or owners (the same folder gives the same bytes), and the list of
    files with their SHA-256 for the server to resolve COPY against."""
    root = os.path.abspath(folder)
    if dockerignore is None:
        candidates = ([os.path.join(root, dockerfile) + ".dockerignore"] if dockerfile else []) + [
            os.path.join(root, ".dockerignore")]
        for candidate in candidates:
            try:
                with open(candidate, encoding="utf-8") as handle:
                    dockerignore = handle.read()
                break
            except OSError:
                continue
    ignored = dockerignore_filter(dockerignore if dockerignore is not None else ".git\n")
    reincludes = bool(re.search(r"^\s*!", dockerignore or "", re.M))
    files: list[dict[str, Any]] = []
    buffer = io.BytesIO()
    import tarfile  # 10 ms, and only a build that sends a folder needs it
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for directory, names, filenames in os.walk(root):
            names.sort()
            relative_dir = os.path.relpath(directory, root).replace(os.sep, "/")
            prefix = "" if relative_dir == "." else relative_dir + "/"
            if not reincludes:
                names[:] = [n for n in names if not ignored(prefix + n) and not os.path.islink(os.path.join(directory, n))]
            else:
                names[:] = [n for n in names if not os.path.islink(os.path.join(directory, n))]
            for name in sorted(filenames):
                full = os.path.join(directory, name)
                path = prefix + name
                if os.path.islink(full) or not os.path.isfile(full) or ignored(path):
                    continue
                if len(files) >= CONTEXT_FILES:
                    raise RuntimeError(f"The build context has more than {CONTEXT_FILES} files.",
                                       code="context_too_large", hint="Leave some out with a .dockerignore.")
                with open(full, "rb") as handle:
                    data = handle.read()
                mode = os.stat(full).st_mode & 0o777
                info = tarfile.TarInfo(path)
                info.size = len(data)
                info.mode = mode
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
                files.append({"path": path, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                              "mode": mode})
    import gzip
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", compresslevel=6, mtime=0) as zipped:
        zipped.write(buffer.getvalue())
    archive_bytes = compressed.getvalue()
    if len(archive_bytes) > CONTEXT_BYTES:
        raise RuntimeError(
            f"The build context is {len(archive_bytes) // 1048576 + 1} MiB compressed; the most is "
            f"{CONTEXT_BYTES // 1048576} MiB.", code="context_too_large",
            hint="Leave build outputs and dependencies out with a .dockerignore.")
    chunks = [archive_bytes[at:at + CHUNK_BYTES] for at in range(0, len(archive_bytes), CHUNK_BYTES)]
    return {"archive": archive_bytes, "sha256": hashlib.sha256(archive_bytes).hexdigest(), "chunks": chunks,
            "files": files, "dockerignore": dockerignore}


def _sleep(seconds: float) -> None:
    from .._sync_client import sleep  # here, not at the top: that module imports this one
    sleep(seconds)


class Registries:
    """``runtime.images.registries``: credentials builds use to pull private
    images. The secret is sealed on arrival and never returned."""

    def __init__(self, t: Any) -> None:
        self._t = t

    def list(self) -> list[dict[str, Any]]:
        return (self._t.json("GET", "/v1/images/registries"))["data"]

    def set(self, registry: str, *, username: Optional[str] = None, password: Optional[str] = None,
                  access_key_id: Optional[str] = None, secret_access_key: Optional[str] = None) -> dict[str, Any]:
        """A user name and token or password (Docker Hub, GitHub; Google with
        username ``_json_key`` and the key's JSON as password), or for Amazon
        ECR an access key: ``access_key_id`` and ``secret_access_key``."""
        body = {"registry": registry, "username": username, "password": password, "accessKeyId": access_key_id,
                "secretAccessKey": secret_access_key}
        return self._t.json("POST", "/v1/images/registries",
                                  body={k: v for k, v in body.items() if v is not None})

    def delete(self, registry: str) -> dict[str, Any]:
        return self._t.json("POST", "/v1/images/registries:delete", body={"registry": registry})


class Images:
    """``runtime.images``. Give exactly one source: ``image`` (a public or
    private reference such as "python:3.12-slim"), ``dockerfile`` (with
    ``context_dir`` for its folder, or small inline ``files``, and
    ``build_args``, ``target``), or ``recipe`` (base, apt, pip, npm, commands,
    env, files, workdir). ``name`` versions it and ``tags`` (default
    ``latest``) move to it when ready. ``start`` sets what a sandbox from it
    runs ({command, ready_port | ready_command, ready_timeout_seconds});
    ``build`` sets the build's limits."""

    def __init__(self, t: Any) -> None:
        self._t = t
        self.registries = Registries(t)

    def upload_context(self, folder: str, *, dockerignore: Optional[str] = None,
                             dockerfile: Optional[str] = None) -> dict[str, Any]:
        """Pack a folder and upload the chunks the server does not have yet.
        Returns the ``context`` a build names, and the .dockerignore used."""
        packed = pack_context(folder, dockerignore, dockerfile)
        digests = [hashlib.sha256(chunk).hexdigest() for chunk in packed["chunks"]]
        missing = set((self._t.json("POST", "/v1/images/context/missing", body={"digests": digests}))["missing"])
        for digest, chunk in zip(digests, packed["chunks"]):
            if digest in missing:
                self._t.json("PUT", f"/v1/images/context/{digest}", raw=chunk)
                missing.discard(digest)
        return {"context": {"archive": {"sha256": packed["sha256"], "size": len(packed["archive"]), "chunks": digests},
                            "files": packed["files"]},
                "dockerignore": packed["dockerignore"]}

    def create(self, *, image: Optional[str] = None, dockerfile: Optional[str] = None,
                     recipe: Optional[dict[str, Any]] = None, files: Optional[Files] = None,
                     context_dir: Optional[str] = None, context: Optional[dict[str, Any]] = None,
                     dockerignore: Optional[str] = None, target: Optional[str] = None,
                     build_args: Optional[dict[str, str]] = None, name: Optional[str] = None,
                     tags: Optional[list[str]] = None, labels: Optional[dict[str, str]] = None,
                     region: Optional[str] = None, build: Optional[dict[str, Any]] = None,
                     env: Optional[dict[str, str]] = None, start: Optional[dict[str, Any]] = None,
                     no_start: bool = False, cache: Optional[bool] = None,
                     idempotency_key: Optional[str] = None) -> dict[str, Any]:
        """Queues a build and returns at once, state "queued". With
        ``context_dir``, the folder is packed and its missing chunks uploaded
        first. ``no_start=True`` drops a Dockerfile's CMD and HEALTHCHECK."""
        if context_dir is not None:
            uploaded = self.upload_context(context_dir, dockerignore=dockerignore)
            context = uploaded["context"]
            dockerignore = uploaded["dockerignore"]
        body = _body({"image": image, "dockerfile": dockerfile, "recipe": recipe, "files": files,
                      "context": context, "dockerignore": dockerignore, "target": target,
                      "build_args": build_args, "name": name, "tags": tags, "labels": labels, "region": region,
                      "build": build, "env": env, "start": start, "cache": cache})
        if no_start:
            body["start"] = None
        return self._t.json("POST", "/v1/images", body=body, idempotency_key=idempotency_key)

    def follow_logs(self, image_id: str, on_log: Callable[[dict[str, Any]], Any], after: int = 0,
                          poll_seconds: float = 1.0) -> dict[str, Any]:
        """Build log lines as they are written, until the build ends; returns
        the image. Streams when the server can, and polls when it cannot."""
        try:
            while True:
                resume = False
                for event in self._t.events("GET", f"/v1/images/{_enc(image_id)}/logs",
                                                  query={"after": after, "follow": "true"}):
                    kind = event.get("type")
                    if kind == "line":
                        on_log(event)
                        after = event["seq"]
                    elif kind == "done":
                        return event["image"]
                    elif kind == "continue":
                        after = event["after"]
                        resume = True
                    elif kind == "error":
                        raise RuntimeError(event["error"]["message"], code=event["error"].get("code", "error"))
                if not resume:
                    break
        except RuntimeError:
            raise
        except Exception:  # A server that cannot stream: poll instead.
            pass
        while True:
            page = self.logs(image_id, after)
            for line in page["lines"]:
                on_log(line)
            after = page["nextAfter"]
            if page.get("done"):
                return self.get(image_id)
            image = self.get(image_id)
            if image["state"] not in ("queued", "building"):
                for line in (self.logs(image_id, after))["lines"]:
                    on_log(line)
                return image
            _sleep(poll_seconds)

    def build(self, *, on_log: Optional[Callable[[dict[str, Any]], Any]] = None, poll_seconds: float = 1.0,
                    **fields: Any) -> dict[str, Any]:
        """Builds and waits until the image is ready, passing each build log
        line to ``on_log``. Raises with the build's own error when it fails."""
        image = self.create(**fields)
        if on_log is not None:
            image = self.follow_logs(image["id"], on_log, poll_seconds=poll_seconds)
        while image["state"] in ("queued", "building"):
            _sleep(poll_seconds)
            image = self.get(image["id"])
        if image["state"] != "ready":
            raise RuntimeError(f"Image {image['id']} {image['state']}: {image.get('error') or 'no error given'}",
                               code="image_build_failed",
                               hint="Read the whole log with runtime.images.logs(id).")
        return image

    def get(self, image_id: str) -> dict[str, Any]:
        return self._t.json("GET", f"/v1/images/{_enc(image_id)}")

    def resolve(self, image: str) -> dict[str, Any]:
        """An image by id, name (its latest tag), name:tag or name@version."""
        if _UUID.match(image):
            return self.get(image)
        return self._t.json("GET", "/v1/images/resolve", query={"ref": image})

    def _id(self, image: str) -> str:
        return image if _UUID.match(image) else (self.resolve(image))["id"]

    def logs(self, image_id: str, after: int = 0) -> dict[str, Any]:
        """Build log lines after ``after`` (a seq), with ``nextAfter`` and ``done``."""
        return self._t.json("GET", f"/v1/images/{_enc(image_id)}/logs", query={"after": after})

    def list(self, *, state: Optional[str] = None, name: Optional[str] = None,
                   limit: Optional[int] = None) -> Page:
        from .._sync_client import Page  # here, not at the top: that module imports this one
        query: dict[str, Any] = {"state": state, "name": name, "limit": limit}

        def fetch(cursor: Optional[str]) -> Page:
            body = self._t.json("GET", "/v1/images", query={**query, "cursor": cursor})
            return Page(body["data"], body.get("nextCursor"), fetch)
        return fetch(None)

    def versions(self, name: str) -> Page:
        """Every version of a name, newest first."""
        return self.list(name=name, limit=100)

    def tag(self, image: str, tag: str) -> dict[str, Any]:
        """Point ``tag`` of the image's name at this version."""
        return self._t.json("POST", f"/v1/images/{_enc(self._id(image))}:tag", body={"tag": tag})

    def untag(self, image: str, tag: str) -> dict[str, Any]:
        return self._t.json("POST", f"/v1/images/{_enc(self._id(image))}:untag", body={"tag": tag})

    def delete(self, image: str) -> dict[str, Any]:
        """Delete one version (by id, name:tag or name@version) and its tags. A
        bare name deletes its latest tag's version, or its only version when it
        has one and no latest tag; with several, the error names its tags."""
        try:
            image_id = self._id(image)
        except RuntimeError as error:
            if error.code != "image_not_found" or ":" in image or "@" in image:
                raise
            page = self.list(name=image, limit=100)
            live = [found for found in page.data if found.get("state") not in ("deleted", "deleting")]
            if len(live) != 1:
                raise
            image_id = live[0]["id"]
        return self._t.json("POST", f"/v1/images/{_enc(image_id)}:delete", body={})
