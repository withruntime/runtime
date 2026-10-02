"""images.delete("afternoon-web") on a name with one version deletes it.

It refused with "no tag latest… use afternoon-web:v1" (live product,
2 October 2026). With several versions, the server's words, which list the
tags, stand; a tag or version that names nothing is never widened.
"""
import unittest

from withruntime._errors import NotFoundError, RuntimeError
from withruntime._sync_products.images import Images

ONE = "11111111-2222-4333-8444-555555555555"
TWO = "11111111-2222-4333-8444-666666666666"


class FakeTransport:
    def __init__(self, versions):
        self.versions, self.seen = versions, []

    def json(self, method, path, query=None, body=None, **_):
        self.seen.append((method, path))
        if path == "/v1/images/resolve":
            raise NotFoundError("afternoon-web is tagged v1: use afternoon-web:v1.", code="image_not_found",
                                status=404)
        if path == "/v1/images":
            return {"data": [{"id": v, "state": "ready", "name": "afternoon-web"} for v in self.versions],
                    "nextCursor": None}
        if path.endswith(":delete"):
            return {"id": path.split("/")[3].split(":")[0], "state": "deleting"}
        raise AssertionError(path)


class ImageDeleteByName(unittest.TestCase):
    def test_one_version_is_deleted(self):
        t = FakeTransport([ONE])
        self.assertEqual(Images(t).delete("afternoon-web"), {"id": ONE, "state": "deleting"})
        self.assertEqual(t.seen[-1], ("POST", f"/v1/images/{ONE}:delete"))

    def test_several_versions_keep_the_servers_words(self):
        t = FakeTransport([ONE, TWO])
        with self.assertRaises(RuntimeError) as caught:
            Images(t).delete("afternoon-web")
        self.assertIn("afternoon-web:v1", caught.exception.message)
        self.assertFalse(any(path.endswith(":delete") for _, path in t.seen))

    def test_a_tag_or_version_is_never_widened(self):
        t = FakeTransport([ONE])
        for ref in ("afternoon-web:v2", "afternoon-web@9"):
            with self.assertRaises(RuntimeError):
                Images(t).delete(ref)
        self.assertEqual([path for _, path in t.seen], ["/v1/images/resolve"] * 2)


if __name__ == "__main__":
    unittest.main()
