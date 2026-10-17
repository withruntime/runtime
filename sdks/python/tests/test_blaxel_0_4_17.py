"""What blaxel 0.4.17 added over 0.4.13, on Runtime: BlaxelError as the base
of the API errors with is_blaxel_error, the preview shorthand
(SandboxPreviewCreateConfiguration), preview.url and token.name,
tokens.create_if_expired (async and sync), and settings.integration. Before,
the names did not import, the shorthand raised "A preview needs spec.port"
and settings.integration raised NotSupportedError."""
import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dropin_fake import BlaxelWorld  # noqa: E402

import withruntime  # noqa: E402
import withruntime.blaxel as bl  # noqa: E402
from withruntime.blaxel import (_async_sandbox, _sync_sandbox, NotSupportedError, ResponseError,  # noqa: E402
                                SandboxAPIError, SandboxCreationTimeoutError, SandboxInstance,
                                SyncSandboxInstance)
from withruntime.blaxel import _core as core  # noqa: E402
from withruntime.blaxel.core import (BlaxelError, SandboxPreviewCreateConfiguration, VolumeAPIError,  # noqa: E402
                                     is_blaxel_error)

SAVED = dict(os.environ)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.update(RUNTIME_API_URL="http://localhost:9", RUNTIME_API_KEY="rtcloud_test_never_sent")
        os.environ.pop("BL_INTEGRATION", None)
        self.world = BlaxelWorld()
        bl.use_client(self.world.client())
        _sync_sandbox.SandboxPreviewTokens._made.clear()
        _async_sandbox.AsyncSandboxPreviewTokens._made.clear()

    def tearDown(self) -> None:
        bl.use_client(None)
        os.environ.clear()
        os.environ.update(SAVED)


class Errors(Base):
    def test_the_import_paths_of_0_4_17_load(self):
        from withruntime.blaxel.core.common import BlaxelError as FromCommon
        from withruntime.blaxel.core.errors import BlaxelError as FromErrors
        from withruntime.blaxel.core.errors import (BlaxelActionErrorBody, BlaxelApiErrorBody,  # noqa: F401
                                                    BlaxelErrorCode, BlaxelErrorCodeValue, BlaxelPlatformErrorBody,
                                                    BlaxelSandboxApiErrorBody)
        from withruntime.blaxel.core.sandbox import BlaxelError as FromSandbox
        from withruntime.blaxel.core.sandbox import ResponseError as SandboxResponseError
        from withruntime.blaxel.core.sandbox import SandboxPreviewCreateConfiguration as FromSandboxShorthand
        from withruntime.blaxel.core.sandbox.types import SandboxPreviewCreateConfiguration as FromTypes
        self.assertIs(FromCommon, BlaxelError)
        self.assertIs(FromErrors, BlaxelError)
        self.assertIs(FromSandbox, BlaxelError)
        self.assertIs(SandboxResponseError, ResponseError)
        self.assertIs(FromSandboxShorthand, SandboxPreviewCreateConfiguration)
        self.assertIs(FromTypes, SandboxPreviewCreateConfiguration)
        self.assertTrue(issubclass(VolumeAPIError, BlaxelError))

    def test_every_api_error_is_a_blaxel_error_with_status_code_and_request_id(self):
        failure = withruntime.NotFoundError("Sandbox not found.", code="not_found", status=404, request_id="req_1")
        sandbox_error = core.translate(failure)
        process_error = core.translate(failure, "process")
        for error, cls in ((sandbox_error, SandboxAPIError), (process_error, ResponseError)):
            self.assertIsInstance(error, cls)
            self.assertIsInstance(error, BlaxelError)
            self.assertTrue(is_blaxel_error(error))
            self.assertTrue(is_blaxel_error(error, "not_found"))
            self.assertTrue(is_blaxel_error(error, ["other", "not_found"]))
            self.assertFalse(is_blaxel_error(error, "TOKEN_REVOKED"))
            self.assertEqual((error.status, error.code, error.request_id, error.retryable), (404, "not_found",
                                                                                              "req_1", False))
            self.assertIsNone(error.docs_url)
        self.assertEqual(sandbox_error.status_code, 404)
        self.assertEqual(process_error.response.status_code, 404)
        self.assertIs(process_error.body, process_error.data)
        busy = core.translate(withruntime.RuntimeError("Busy.", code="busy", status=503))
        self.assertTrue(busy.retryable)
        timeout = SandboxCreationTimeoutError("box", 5, "creating")
        self.assertTrue(is_blaxel_error(timeout, "CREATION_TIMEOUT"))
        self.assertEqual(timeout.status, 408)
        for other in (ValueError("x"), "text", {"error": "x", "code": 400}, None):
            self.assertFalse(is_blaxel_error(other))
        # Blaxel's wrapper for its generated client's responses: that client is not on Runtime.
        with self.assertRaises(NotSupportedError):
            ResponseError.from_api_response(object())


class Previews(Base):
    def test_the_shorthand_makes_a_private_preview_named_by_its_port(self):
        box = SyncSandboxInstance.create({"name": "web"})
        plain = box.previews.create({"port": 3000})
        self.assertEqual((plain.name, plain.spec.port, plain.spec.public), ("preview-3000", 3000, False))
        self.assertTrue(plain.url.startswith("https://3000-"))
        self.assertEqual(plain.url, plain.spec.url)
        named = box.previews.create(SandboxPreviewCreateConfiguration(8080, name="api", public=True))
        self.assertEqual((named.name, named.spec.public), ("api", True))
        self.assertEqual(self.world.called("previews.create"), [(3000, "private"), (8080, "public")])
        self.assertEqual(SyncSandboxInstance.get("web").previews.get("preview-3000").spec.port, 3000)

    def test_a_bad_shorthand_is_refused_with_blaxels_value_error_before_anything_is_shared(self):
        box = SyncSandboxInstance.create({"name": "web"})
        before = len(self.world.calls)
        for bad in ({"port": 0}, {"port": 70000}, {"port": True}, {"port": "3000"}, {"port": 3000, "name": ""},
                    {"port": 3000, "public": "yes"}):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    box.previews.create(bad)
                with self.assertRaises(ValueError):
                    box.previews.create_if_not_exists(bad)
        self.assertEqual(len(self.world.calls), before)

    def test_create_if_not_exists_answers_an_existing_preview_as_it_is(self):
        box = SyncSandboxInstance.create({"name": "web"})
        box.previews.create({"metadata": {"name": "preview-3000"}, "spec": {"port": 3000, "public": True}})
        found = box.previews.create_if_not_exists({"port": 3000})
        self.assertTrue(found.spec.public)
        self.assertEqual(len(self.world.called("previews.create")), 1)
        made = box.previews.create_if_not_exists(SandboxPreviewCreateConfiguration(4000))
        self.assertEqual((made.spec.port, made.spec.public), (4000, False))


class CreateIfExpired(Base):
    def test_reuses_the_token_it_made_while_it_lasts_and_stays_under_the_ceiling(self):
        box = SyncSandboxInstance.create({"name": "web"})
        preview = box.previews.create({"port": 3000})
        ceiling = datetime.now(timezone.utc) + timedelta(hours=2)
        first = preview.tokens.create_if_expired(ceiling)
        self.assertTrue(first.name.startswith("token-"))
        self.assertIs(preview.tokens.create_if_expired(ceiling), first)
        self.assertIs(box.previews.get("preview-3000").tokens.create_if_expired(ceiling), first)
        self.assertEqual(len(self.world.called("previews.get")), 2)  # one token, one lookup
        lower = preview.tokens.create_if_expired(datetime.now(timezone.utc) + timedelta(minutes=90))
        self.assertIsNot(lower, first)
        longer = preview.tokens.create_if_expired(datetime.now(timezone.utc) + timedelta(hours=3),
                                                  min_validity=timedelta(minutes=100))
        self.assertIsNot(longer, lower)
        # A naive datetime is UTC, as in Blaxel.
        naive = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=2)
        asked = preview.tokens.create_if_expired(naive)
        self.assertEqual(self.world.called("previews.get")[-1][2],
                         naive.replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"))
        self.assertIsNotNone(asked)

    def test_checks_its_arguments_and_refuses_a_public_preview_before_any_request(self):
        box = SyncSandboxInstance.create({"name": "web"})
        preview = box.previews.create({"port": 3000})
        public = box.previews.create({"port": 4000, "public": True})
        before = len(self.world.calls)
        now = datetime.now(timezone.utc)
        for expires_at, min_validity in ((now - timedelta(seconds=1), timedelta(hours=1)),
                                         (now + timedelta(minutes=30), timedelta(hours=1)),
                                         ("tomorrow", timedelta(hours=1)),
                                         (now + timedelta(hours=2), timedelta(seconds=-1)),
                                         (now + timedelta(hours=2), 60)):
            with self.subTest(expires_at=expires_at, min_validity=min_validity), self.assertRaises(ValueError):
                preview.tokens.create_if_expired(expires_at, min_validity)
        with self.assertRaises(ValueError) as caught:
            public.tokens.create_if_expired()
        self.assertEqual(str(caught.exception), "Cannot create or reuse a token for a public preview")
        self.assertEqual(len(self.world.calls), before)

    def test_async_with_no_expiry_asks_for_a_day(self):
        bl.use_client(self.world.async_client())

        async def scenario():
            box = await SandboxInstance.create({"name": "web"})
            preview = await box.previews.create({"port": 3000})
            before = datetime.now(timezone.utc)
            token = await preview.tokens.create_if_expired()
            self.assertIs(await preview.tokens.create_if_expired(), token)
            asked = datetime.fromisoformat(self.world.called("previews.get")[-1][2].replace("Z", "+00:00"))
            self.assertAlmostEqual((asked - before).total_seconds(), 86_400, delta=5)
            self.assertEqual(len(self.world.called("previews.get")), 1)
        asyncio.run(scenario())


class Integration(Base):
    def test_settings_integration_is_kept_and_checked_as_blaxel_does(self):
        settings = bl.settings
        try:
            self.assertEqual(settings.integration, "")
            os.environ["BL_INTEGRATION"] = "my-harness/1.2.3"
            self.assertEqual(settings.integration, "my-harness/1.2.3")
            settings.integration = "other/0.1.0-beta.1"
            self.assertEqual(settings.integration, "other/0.1.0-beta.1")
            settings.integration = "Not Valid"
            with self.assertLogs("withruntime.blaxel", "WARNING") as logs:
                self.assertEqual(settings.integration, "")
                self.assertEqual(settings.integration, "")
            self.assertEqual(len(logs.records), 1)
            with self.assertRaises(NotSupportedError):
                settings.workspace = "w"
            with self.assertRaises(NotSupportedError):
                settings.user_agent
        finally:
            settings.integration = None


if __name__ == "__main__":
    unittest.main()
