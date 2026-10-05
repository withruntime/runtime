"""A directory download cannot write outside its target (26 September 2026).

The archive comes from the sandbox, so its contents are the customer's untrusted
code's to choose. The old check looked at each name before extracting, while the
archive's own links did not exist yet: a link ``x -> ../outside`` followed by
``x/pwned.txt`` passed it and wrote outside. These archives are the ones a
hostile sandbox would send."""
import io
import gzip
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest

from withruntime._errors import RuntimeError
from withruntime._unpack import unpack_archive


def archive(*entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, kind, value in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif kind == "link":
                info.type, info.linkname = tarfile.SYMTYPE, value
                tar.addfile(info)
            elif kind == "hard":
                info.type, info.linkname = tarfile.LNKTYPE, value
                tar.addfile(info)
            else:
                body = value.encode()
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


class Unpack(unittest.TestCase):
    def setUp(self):
        self.base = tempfile.TemporaryDirectory()
        self.target = os.path.join(self.base.name, "target")
        self.outside = os.path.join(self.base.name, "outside")
        os.mkdir(self.outside)

    def tearDown(self):
        self.base.cleanup()

    def refused(self, data, pattern):
        with self.assertRaisesRegex(RuntimeError, pattern) as caught:
            unpack_archive(data, self.target)
        self.assertEqual(caught.exception.code, "unsafe_archive")

    def test_a_folder_streams_in_chunks_merges_and_a_cut_leaves_the_target_as_it_was(self):
        from withruntime._unpack import Unpacker
        os.mkdir(self.target)
        for name, body in (("kept.txt", "mine"), ("a.txt", "old")):
            with open(os.path.join(self.target, name), "w") as out:
                out.write(body)
        deep = "sub/" + "d" * 120 + "/b.txt"  # a pax header carries the long name
        whole = archive(("a.txt", "file", "new"), (deep, "file", "b" * 5000))

        def feed(chunks):
            unpacker = Unpacker(self.target)
            try:
                for chunk in chunks:
                    unpacker.feed(chunk)
                unpacker.finish()
            finally:
                unpacker.discard()
        with self.assertRaises(RuntimeError) as caught:
            feed([whole[:40], whole[40:-12]])
        self.assertEqual(caught.exception.code, "download_incomplete")
        with open(os.path.join(self.target, "a.txt")) as got:
            self.assertEqual(got.read(), "old")
        self.assertEqual(sorted(os.listdir(self.base.name)), ["outside", "target"])
        feed(whole[at:at + 1] for at in range(len(whole)))
        for name, body in (("a.txt", "new"), ("kept.txt", "mine"), (deep, "b" * 5000)):
            with open(os.path.join(self.target, name)) as got:
                self.assertEqual(got.read(), body)
        self.assertEqual(sorted(os.listdir(self.base.name)), ["outside", "target"])

    def test_an_archive_cut_short_raises_download_incomplete_and_writes_nothing(self):
        # A tar that fails part way in the sandbox ends its gzip stream short.
        whole = archive(("a.txt", "file", "a"))
        with self.assertRaises(RuntimeError) as caught:
            unpack_archive(whole[:-12], self.target)
        self.assertEqual(caught.exception.code, "download_incomplete")
        self.assertFalse(os.path.exists(self.target))

    def test_a_link_then_a_file_through_it_cannot_write_outside(self):
        self.refused(archive(("x", "link", "../outside"), ("x/pwned.txt", "file", "owned")), "outside the target")
        self.assertFalse(os.path.exists(os.path.join(self.outside, "pwned.txt")))

    def test_an_absolute_link_is_refused_and_removed(self):
        self.refused(archive(("etc", "link", "/etc")), "leads outside the target")
        self.assertFalse(os.path.lexists(os.path.join(self.target, "etc")))

    def test_a_link_that_climbs_out_through_another_link_is_refused(self):
        # Lexically d/up/.. is d; followed, d/up is the target and .. leaves it.
        self.refused(archive(("d", "dir", None), ("d/up", "link", ".."), ("x", "link", "d/up/..")), "x -> d/up/..")
        self.assertFalse(os.path.lexists(os.path.join(self.target, "x")))

    def test_a_file_is_never_written_through_a_link_already_there(self):
        os.mkdir(self.target)
        os.symlink(self.outside, os.path.join(self.target, "cache"))
        self.refused(archive(("cache/pwned.txt", "file", "owned")), "passes through a link")
        self.assertFalse(os.path.exists(os.path.join(self.outside, "pwned.txt")))

    def test_links_that_stay_inside_land_intact(self):
        unpack_archive(archive(("./node_modules/pkg/cli.js", "file", "run()"),
                               ("./node_modules/.bin/tool", "link", "../pkg/cli.js"),
                               ("./current", "link", "node_modules/.bin")), self.target)
        with open(os.path.join(self.target, "current", "tool")) as tool:
            self.assertEqual(tool.read(), "run()")

    def test_hard_linked_files_land_with_their_content(self):
        # tar writes a file's first name as a file and every other as a hard
        # link to it: a folder holding one file twice (1 October 2026 audit).
        source = os.path.join(self.base.name, "source")
        os.makedirs(os.path.join(source, "sub"))
        with open(os.path.join(source, "original.txt"), "w") as out:
            out.write("same bytes")
        os.link(os.path.join(source, "original.txt"), os.path.join(source, "sub", "copy.txt"))
        packed = subprocess.run(["tar", "-czf", "-", "-C", source, "."], capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(packed)) as made:
            self.assertIn(tarfile.LNKTYPE, [member.type for member in made.getmembers()])
        unpack_archive(packed, self.target)
        for name in ("original.txt", "sub/copy.txt"):
            with open(os.path.join(self.target, name)) as got:
                self.assertEqual(got.read(), "same bytes")
        # A later entry of the first name replaces it without changing the link's copy.
        unpack_archive(archive(("a.txt", "file", "first"), ("b.txt", "hard", "./a.txt"),
                               ("a.txt", "file", "second")), self.target)
        with open(os.path.join(self.target, "a.txt")) as got:
            self.assertEqual(got.read(), "second")
        with open(os.path.join(self.target, "b.txt")) as got:
            self.assertEqual(got.read(), "first")

    def test_a_hard_link_must_name_a_file_the_archive_already_carried(self):
        with open(os.path.join(self.outside, "secret.txt"), "w") as out:
            out.write("theirs")
        self.refused(archive(("x", "hard", "../outside/secret.txt")), "leads outside the target")
        self.refused(archive(("x", "hard", "/etc/hosts")), "leads outside the target")
        self.refused(archive(("x", "hard", "later.txt"), ("later.txt", "file", "a")), "does not carry")
        self.refused(archive(("d", "link", "../outside"), ("x", "hard", "d/secret.txt")), "does not carry")
        self.refused(archive(("d", "dir", None), ("x", "hard", "d")), "does not carry")
        self.assertFalse(os.path.exists(self.target))

    def test_header_checksum_is_required_before_publishing(self):
        body = bytearray(gzip.decompress(archive(("a.txt", "file", "hello"))))
        body[0] = ord("b")
        self.refused(gzip.compress(body), "invalid header")
        self.assertFalse(os.path.exists(self.target))

    def test_two_end_blocks_are_required(self):
        body = gzip.decompress(archive(("a.txt", "file", "hello")))[:1536]
        with self.assertRaises(RuntimeError) as caught:
            unpack_archive(gzip.compress(body), self.target)
        self.assertEqual(caught.exception.code, "download_incomplete")
        self.assertFalse(os.path.exists(self.target))

    def test_path_record_length_must_advance(self):
        from withruntime._unpack import _pax
        # A regression must fail in bounded time even against the former loop.
        try:
            result = subprocess.run([sys.executable, "-c",
                "from withruntime._unpack import _pax; _pax(b'0 a=b\\n')"],
                capture_output=True, timeout=2, check=False)
        except subprocess.TimeoutExpired:
            self.fail("A zero-length path record did not stop within two seconds")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"invalid path metadata", result.stderr)
        for body in (b"-1 a=b\n", b"99 a=b\n", b"bad a=b\n"):
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                _pax(body)

    def test_merged_link_is_checked_against_existing_tree_before_publication(self):
        os.mkdir(self.target)
        os.symlink("../outside", os.path.join(self.target, "old"))
        self.refused(archive(("new", "link", "old/a.txt")), "leads outside")
        self.assertFalse(os.path.lexists(os.path.join(self.target, "new")))

    def test_safe_existing_link_is_retained_when_merging(self):
        os.mkdir(self.target)
        with open(os.path.join(self.target, "a.txt"), "w") as output:
            output.write("kept")
        os.symlink("a.txt", os.path.join(self.target, "old"))
        unpack_archive(archive(("new", "link", "old")), self.target)
        with open(os.path.join(self.target, "new")) as output:
            self.assertEqual(output.read(), "kept")

    def test_one_compressed_chunk_is_consumed_in_bounded_inflated_pieces(self):
        from withruntime._unpack import Unpacker
        data = archive(("large", "file", "a" * 2_000_000))
        unpacker = Unpacker(self.target)
        original = unpacker._step
        held = []
        def observed():
            held.append(len(unpacker._held))
            return original()
        unpacker._step = observed
        try:
            unpacker.feed(data)
            unpacker.finish()
            self.assertLessEqual(max(held), 65_536 + 511)
            self.assertEqual(os.path.getsize(os.path.join(self.target, "large")), 2_000_000)
        finally:
            unpacker.discard()


if __name__ == "__main__":
    unittest.main()
