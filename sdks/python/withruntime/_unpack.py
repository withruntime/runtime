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

import io
import os
import tarfile

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


def unpack_archive(data: bytes, target: str) -> None:
    """Unpacks a gzipped tar into ``target``, refusing any entry that would
    land outside it."""
    os.makedirs(target, exist_ok=True)
    root = os.path.realpath(target)
    links: list[tuple[str, str, str]] = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            if name in ("", "."):
                continue
            destination = os.path.normpath(os.path.join(root, name))
            _assert_plain(root, destination, name)
            if member.isdir():
                os.makedirs(destination, exist_ok=True)
            elif member.issym():
                links.append((destination, member.linkname, name))
            elif member.isfile():
                os.makedirs(os.path.dirname(destination), exist_ok=True)
                source = archive.extractfile(member)
                with open(destination, "wb") as out:
                    out.write(source.read() if source else b"")
                os.chmod(destination, member.mode & 0o777)
    for destination, link, name in links:
        _assert_plain(root, destination, name)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        try:
            os.symlink(link, destination)
        except FileExistsError:
            pass
    for destination, link, name in links:
        if _link_stays_inside(root, os.path.dirname(destination), link):
            continue
        try:
            os.unlink(destination)
        except OSError:
            pass
        raise _refuse(f"Refusing an archive link that leads outside the target: {name} -> {link}")
