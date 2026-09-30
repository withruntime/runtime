"""A directory download cannot write outside its target (26 September 2026).

The archive comes from the sandbox, so its contents are the customer's untrusted
code's to choose. The old check looked at each name before extracting, while the
archive's own links did not exist yet: a link ``x -> ../outside`` followed by
``x/pwned.txt`` passed it and wrote outside. These archives are the ones a
hostile sandbox would send."""
import io
import os
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


if __name__ == "__main__":
    unittest.main()
