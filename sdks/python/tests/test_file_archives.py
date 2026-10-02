"""Native folder routes, raw archives, explicit guest root and abort safety."""
import asyncio
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from withruntime._async_client import AsyncFiles
from withruntime._errors import ConnectionError
from withruntime._request_scope import current, request_scope
from withruntime._sync_client import Files


class ArchiveTransport:
    def __init__(self, data=b"archive", step=1_048_576, failure=None):
        self.data, self.step, self.failure = data, step, failure
        self.calls, self.reads = [], []
        self.closed = False
        self.abort_deadline = "unset"

    def json(self, method, path, **options):
        self.calls.append((method, path, options))
        if path.endswith("/uploads"):
            return {"uploadId": "a-owned", "chunkBytes": self.step}
        if path.endswith(":abort"):
            self.abort_deadline = current().deadline
            raise OSError("abort failed")
        if "raw" in options and self.failure is not None:
            raise self.failure
        return {"received": len(options.get("raw", b""))}

    def file_chunks(self, path, query):
        self.reads.append((path, query))
        try:
            yield self.data[:3]
            yield self.data[3:]
        finally:
            self.closed = True


class AsyncArchiveTransport:
    def __init__(self, source):
        self.source = source

    async def json(self, *args, **kwargs):
        return self.source.json(*args, **kwargs)

    async def file_chunks(self, *args, **kwargs):
        chunks = self.source.file_chunks(*args, **kwargs)
        try:
            for piece in chunks:
                yield piece
        finally:
            chunks.close()


class FileArchives(unittest.TestCase):
    def check_archive(self, transport, answer):
        self.assertEqual(answer, b"archive")
        self.assertTrue(transport.closed)
        self.assertEqual(transport.reads, [("/v1/sandboxes/s/files/archive", {
            "path": "/root/app", "gzip": False, "user": "root", "exclude": [".staging"],
        })])

    def test_sync_raw_archive_routes_root_and_exclusions(self):
        transport = ArchiveTransport()
        self.check_archive(transport, Files(transport, "s").archive("/root/app", gzip=False, user="root", exclude=[".staging"]))

    def test_async_raw_archive_routes_root_and_exclusions(self):
        async def run():
            transport = ArchiveTransport()
            answer = await AsyncFiles(AsyncArchiveTransport(transport), "s").archive("/root/app", gzip=False, user="root", exclude=[".staging"])
            self.check_archive(transport, answer)
        asyncio.run(run())

    def check_parts(self, transport, payload):
        self.assertEqual(transport.calls[0][2]["body"], {"path": "/root/app", "gzip": False, "user": "root"})
        parts = [options for method, _, options in transport.calls if method == "PUT"]
        self.assertEqual(b"".join(options["raw"] for options in parts), payload)
        self.assertEqual([options["query"]["offset"] for options in parts], [0, 1_048_576])
        self.assertTrue(transport.calls[-1][1].endswith(":commit"))
        self.assertEqual(len({options["idempotency_key"] for _, _, options in transport.calls}), len(transport.calls))

    def test_sync_large_plain_tar_infers_compression_and_keeps_phase_keys_stable(self):
        payload = b"x" * (1_048_576 + 7)
        first = ArchiveTransport()
        Files(first, "s").unarchive("/root/app", payload, user="root", idempotency_key="same")
        self.check_parts(first, payload)
        second = ArchiveTransport()
        Files(second, "s").unarchive("/root/app", payload, user="root", idempotency_key="same")
        self.assertEqual([options["idempotency_key"] for _, _, options in first.calls],
                         [options["idempotency_key"] for _, _, options in second.calls])

    def test_async_large_plain_tar_infers_compression(self):
        async def run():
            payload = b"x" * (1_048_576 + 7)
            transport = ArchiveTransport()
            await AsyncFiles(AsyncArchiveTransport(transport), "s").unarchive("/root/app", payload, user="root")
            self.check_parts(transport, payload)
        asyncio.run(run())

    def test_small_upload_routes_root_and_binary_bytes_without_chunking(self):
        transport = ArchiveTransport()
        payload = b"\x1f\x8b\x00\xff"
        Files(transport, "s").unarchive("/root/app", payload, user="root")
        self.assertEqual(len(transport.calls), 1)
        method, path, options = transport.calls[0]
        self.assertEqual((method, path), ("PUT", "/v1/sandboxes/s/files/archive"))
        self.assertEqual(options["query"], {"path": "/root/app", "user": "root"})
        self.assertEqual(options["raw"], payload)

    def test_invalid_chunk_sizes_abort_instead_of_spinning_or_skipping_data(self):
        for size in (0, -1, True, "bad", 1_048_577):
            with self.subTest(size=size):
                transport = ArchiveTransport(step=size)
                with self.assertRaises(ConnectionError):
                    Files(transport, "s").unarchive("/app", b"x" * 1_048_577)
                self.assertTrue(transport.calls[-1][1].endswith(":abort"))

    def test_abort_failure_preserves_primary_and_clears_expired_scope(self):
        primary = ConnectionError("chunk failed", code="fixture")
        transport = ArchiveTransport(failure=primary)
        with request_scope(10), self.assertRaises(ConnectionError) as caught:
            Files(transport, "s").unarchive("/app", b"x" * 1_048_577)
        self.assertIs(caught.exception, primary)
        self.assertIsNone(transport.abort_deadline)

    def test_async_cancellation_aborts_without_replacing_cancelled_error(self):
        async def run():
            primary = asyncio.CancelledError()
            transport = ArchiveTransport(failure=primary)
            with request_scope(10), self.assertRaises(asyncio.CancelledError) as caught:
                await AsyncFiles(AsyncArchiveTransport(transport), "s").unarchive("/app", b"x" * 1_048_577)
            self.assertIs(caught.exception, primary)
            self.assertTrue(transport.calls[-1][1].endswith(":abort"))
            self.assertIsNone(transport.abort_deadline)
        asyncio.run(run())

    def test_folder_upload_uses_root_route_and_preserves_real_tar_contents(self):
        transport = ArchiveTransport()
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "a.txt").write_text("hello")
            Files(transport, "s").upload(folder, "/root/app", user="root")
            options = transport.calls[0][2]
            self.assertEqual(options["query"]["user"], "root")
            with tarfile.open(fileobj=io.BytesIO(options["raw"]), mode="r:gz") as archive:
                self.assertEqual(archive.extractfile("./a.txt").read(), b"hello")
            with self.assertRaises(ValueError):
                Files(transport, "s").upload(str(Path(folder, "a.txt")), "/root/a.txt", user="root")

    def test_root_folder_download_skips_unprivileged_stat_and_extracts(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w:gz") as archive:
            info = tarfile.TarInfo("./a.txt")
            info.size = 5
            archive.addfile(info, io.BytesIO(b"hello"))
        transport = ArchiveTransport(data=data.getvalue())
        with tempfile.TemporaryDirectory() as folder:
            target = str(Path(folder, "app"))
            Files(transport, "s").download("/root/app", target, user="root")
            self.assertEqual(Path(target, "a.txt").read_text(), "hello")
        self.assertEqual(transport.calls, [])
        self.assertEqual(transport.reads[0][1]["user"], "root")

    def test_explicit_compression_mismatch_fails_before_any_request(self):
        transport = ArchiveTransport()
        with self.assertRaises(ValueError):
            Files(transport, "s").unarchive("/app", b"plain", gzip=True)
        self.assertEqual(transport.calls, [])


if __name__ == "__main__":
    unittest.main()
