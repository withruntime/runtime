"""Unpacks a directory download without letting the archive write outside it.

The archive comes from a sandbox, whose contents the customer's untrusted code
controls. Checking each name before extracting is not enough: a link
``x -> ../outside`` followed by ``x/file`` passes that check and writes through
the link, and ``tarfile``'s own ``data`` filter depends on the interpreter's
patch release. So no write ever passes through a link, links are made only after
every file and directory is in place, and each link is then walked through the
finished tree and removed, failing the unpack, if it leads out. The JavaScript
SDK's ``unpackArchive`` in ``packages/cloud-sdk/src/tar.ts`` keeps the same rules.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import zlib
from typing import Optional

from ._errors import RuntimeError


def _refuse(message: str) -> RuntimeError:
    return RuntimeError(message, code="unsafe_archive")


def _inside(root: str, path: str) -> bool:
    return path == root or path.startswith(root + os.sep)


def _assert_plain(root: str, destination: str, name: str) -> None:
    """Refuses unless ``destination`` is inside ``root`` and no part of the way
    to it, itself included, is a link."""
    if not _inside(root, destination):
        raise _refuse(f"Refusing an archive entry outside the target: {name}")
    path = root
    for part in os.path.relpath(destination, root).split(os.sep):
        if part in ("", "."):
            continue
        path = os.path.join(path, part)
        if os.path.islink(path):
            raise _refuse(f"Refusing an archive entry that passes through a link: {name}")


def _link_stays_inside(root: str, directory: str, link: str) -> bool:
    """Whether following ``link`` from ``directory`` stays in ``root`` without
    turning at a link before its last step. The last step may be a link; that
    link is checked on its own."""
    if os.path.isabs(link):
        return False
    parts = [part for part in link.split("/") if part not in ("", ".")]
    path = directory
    for index, part in enumerate(parts):
        path = os.path.dirname(path) if part == ".." else os.path.join(path, part)
        if not _inside(root, path):
            return False
        if index < len(parts) - 1 and part != ".." and os.path.islink(path):
            return False
    return True


def _cut_short() -> RuntimeError:
    """A folder that did not arrive whole: tar in the sandbox stopped part way
    (a file it may not read, one that changed as it was read), which ends the
    gzip stream short, or the connection was lost."""
    return RuntimeError(
        "The folder's archive arrived cut short: tar in the sandbox stopped part way, or the "
        "connection was lost. Nothing was written.",
        code="download_incomplete",
        hint="Try again. If it fails the same way, a file in the folder cannot be read by the "
             "sandbox user or changes as it is read.")


def _text(field: bytes) -> str:
    return field.split(b"\0", 1)[0].decode("utf-8", "surrogateescape")


def _size(field: bytes) -> int:
    """An octal size, or GNU's base-256 one for a file of 8 GiB or more."""
    if field[0] & 0x80:
        if field[0] & 0x40:
            raise ValueError("negative size")
        return int.from_bytes(field[1:], "big")
    return int(_text(field).strip() or "0", 8)


def _pax(body: bytes) -> dict[str, str]:
    """A pax header's records, ``<length> <key>=<value>\\n`` each."""
    out: dict[str, str] = {}
    while body:
        try:
            length = int(body.split(b" ", 1)[0])
        except ValueError as error:
            raise _refuse("The archive contains invalid path metadata.") from error
        if length <= 0 or length > len(body) or b" " not in body[:length] or not body[:length].endswith(b"\n"):
            raise _refuse("The archive contains invalid path metadata.")
        key, _, value = body[:length].split(b" ", 1)[1].rstrip(b"\n").partition(b"=")
        out[key.decode()] = value.decode("utf-8", "surrogateescape")
        body = body[length:]
    return out


class Unpacker:
    """Unpacks a gzipped tar fed to it a chunk at a time into ``target``,
    refusing any entry that would land outside it, and holding no more than a
    chunk. It unpacks into a folder beside the target and moves it into place
    only once the whole archive arrived (``finish``), so an archive cut short
    leaves nothing behind that could pass for the folder. A target that exists
    is merged into, files of the same name replaced. ``discard`` removes what
    was unpacked if ``finish`` was never reached."""

    def __init__(self, target: str) -> None:
        self._final = os.path.abspath(target)
        os.makedirs(os.path.dirname(self._final), exist_ok=True)
        self._staging = tempfile.mkdtemp(prefix=os.path.basename(self._final) + ".runtime-partial-",
                                         dir=os.path.dirname(self._final))
        self._root = os.path.realpath(self._staging)
        self._inflate = zlib.decompressobj(wbits=31)
        self._held = bytearray()
        self._links: list[tuple[str, str, str]] = []
        self._ended = False
        self._zero_blocks = 0
        # What the bytes after the header are: ("file", handle, path, mode),
        # ("long", key, parts) or ("skip",), with how many are left of the
        # entry's body and then of its padding.
        self._entry: Optional[tuple] = None
        self._left = 0
        self._padding = 0
        self._long: dict[str, str] = {}

    def feed(self, data: bytes) -> None:
        try:
            while True:
                part = self._inflate.decompress(data, 65_536)
                self._held += part
                while self._step():
                    pass
                data = self._inflate.unconsumed_tail
                if not data and len(part) < 65_536:
                    break
        except zlib.error as error:
            raise _cut_short() from error

    def _step(self) -> bool:
        if self._ended:
            self._held.clear()
            return False
        if self._entry is None:
            if len(self._held) < 512:
                return False
            header = bytes(self._held[:512])
            del self._held[:512]
            if not any(header):
                self._zero_blocks += 1
                self._ended = self._zero_blocks == 2
                return True
            if self._zero_blocks:
                raise _cut_short()
            self._begin(header)
            return True
        if self._left:
            if not self._held:
                return False
            part = bytes(self._held[:self._left])
            del self._held[:len(part)]
            self._left -= len(part)
            kind = self._entry[0]
            if kind == "file":
                self._entry[1].write(part)
            elif kind == "long":
                self._entry[2].append(part)
            if self._left:
                return False
            self._end_body()
            return True
        if self._padding:
            if not self._held:
                return False
            taken = min(self._padding, len(self._held))
            del self._held[:taken]
            self._padding -= taken
            if self._padding:
                return False
        self._entry = None
        return True

    def _begin(self, header: bytes) -> None:
        try:
            expected = int(_text(header[148:156]).strip(), 8)
            checked = header[:148] + b" " * 8 + header[156:]
            if expected not in (sum(checked), sum(byte if byte < 128 else byte - 256 for byte in checked)):
                raise ValueError("invalid checksum")
            size = _size(header[124:136])
            if size < 0:
                raise ValueError("negative size")
        except ValueError as error:
            raise _refuse("The archive contains an invalid header.") from error
        kind = chr(header[156]) if header[156] else "0"
        prefix = _text(header[345:500])
        name = self._long.pop("path", None) or (f"{prefix}/{_text(header[:100])}" if prefix else _text(header[:100]))
        link = self._long.pop("linkpath", None) or _text(header[157:257])
        self._long.clear()
        mode = int(_text(header[100:108]).strip() or "644", 8)
        self._left, self._padding = size, -size % 512
        if kind in ("L", "K", "x"):
            if size > 65_536:
                raise _refuse("The archive contains oversized path metadata.")
            self._entry = ("long", kind, [])
        else:
            self._entry = ("skip",)
            while name.startswith("./"):
                name = name[2:]
            if name not in ("", ".", "./"):
                destination = os.path.normpath(os.path.join(self._root, name))
                _assert_plain(self._root, destination, name)
                if kind == "5":
                    os.makedirs(destination, exist_ok=True)
                elif kind == "2":
                    self._links.append((destination, link, name))
                elif kind in ("0", "7"):
                    os.makedirs(os.path.dirname(destination), exist_ok=True)
                    self._entry = ("file", open(destination, "wb"), destination, mode)
        if not self._left:
            self._end_body()

    def _end_body(self) -> None:
        entry = self._entry
        assert entry is not None
        if entry[0] == "file":
            entry[1].close()
            os.chmod(entry[2], entry[3] & 0o777)
        elif entry[0] == "long":
            body = b"".join(entry[2])
            if entry[1] == "x":
                self._long.update(_pax(body))
            else:
                self._long["path" if entry[1] == "L" else "linkpath"] = _text(body)
        self._entry = ("skip",)

    def finish(self) -> None:
        """Checks the archive arrived whole, makes its links and puts it in place."""
        if not self._inflate.eof or not self._ended:
            raise _cut_short()
        root = self._root
        for destination, link, name in self._links:
            _assert_plain(root, destination, name)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            try:
                os.symlink(link, destination)
            except FileExistsError:
                pass
        for destination, link, name in self._links:
            if _link_stays_inside(root, os.path.dirname(destination), link):
                continue
            try:
                os.unlink(destination)
            except OSError:
                pass
            raise _refuse(f"Refusing an archive link that leads outside the target: {name} -> {link}")
        if not os.path.lexists(self._final):
            os.rename(self._staging, self._final)
        else:
            final = os.path.realpath(self._final)
            for destination, link, name in self._links:
                if not _merged_link_stays_inside(root, final, destination, link):
                    raise _refuse(f"Refusing an archive link that leads outside the target: {name}")
            _merge(root, final, final)

    def discard(self) -> None:
        if self._entry is not None and self._entry[0] == "file":
            self._entry[1].close()
        shutil.rmtree(self._staging, ignore_errors=True)


def _merged_link_stays_inside(staging: str, root: str, destination: str, link: str) -> bool:
    """Checks a link against staged entries and the existing destination tree."""
    path = os.path.dirname(os.path.join(root, os.path.relpath(destination, staging)))
    pending = link.split("/")
    followed: set[str] = set()
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        path = os.path.dirname(path) if part == ".." else os.path.join(path, part)
        if not _inside(root, path):
            return False
        staged = os.path.join(staging, os.path.relpath(path, root))
        actual = staged if os.path.lexists(staged) else path
        if not os.path.islink(actual):
            continue
        if path in followed:
            return False
        followed.add(path)
        next_link = os.readlink(actual)
        if os.path.isabs(next_link):
            if not _inside(root, next_link):
                return False
            path = root
            pending[:0] = os.path.relpath(next_link, root).split(os.sep)
        else:
            path = os.path.dirname(path)
            pending[:0] = next_link.split("/")
    return True


def _merge(source_dir: str, target_dir: str, root: str) -> None:
    """Moves what was unpacked into ``target_dir``, merging with what is there
    and replacing files of the same name, never through a link in it."""
    for name in os.listdir(source_dir):
        source = os.path.join(source_dir, name)
        destination = os.path.join(target_dir, name)
        _assert_plain(root, destination, os.path.relpath(destination, root))
        if os.path.isdir(source) and not os.path.islink(source) and os.path.isdir(destination):
            _merge(source, destination, root)
        else:
            os.replace(source, destination)


def unpack_archive(data: bytes, target: str) -> None:
    """Unpacks a whole gzipped tar held in memory, by the same rules."""
    unpacker = Unpacker(target)
    try:
        unpacker.feed(data)
        unpacker.finish()
    finally:
        unpacker.discard()
