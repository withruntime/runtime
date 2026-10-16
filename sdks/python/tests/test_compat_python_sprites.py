import asyncio
import builtins
import io
from datetime import datetime
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
from test_compat_new_providers import Base
from dropin_fake import DropInSandbox, DropInSandboxes, DropInSnapshots, FakeNetwork
import e2b_fake
from e2b_fake import Asyncified, FakeFiles, Page, Result, not_found
import withruntime
import withruntime.sprites as sprites
from withruntime.sprites import (SpritesClient, ListOptions, SpriteConfig, URLSettings, NetworkPolicy, PolicyRule,
                                 Checkpoint, Session, StreamMessage, FileStat)
from withruntime.sprites.async_client import AsyncSpritesClient
from withruntime.sprites.control import ControlConnection, OpConn
from withruntime.sprites.exceptions import (SpriteError, AuthenticationError, NotFoundError, FilesystemError,
                                            FileNotFoundError_, IsADirectoryError_, NotADirectoryError_,
                                            PermissionError_, DirectoryNotEmptyError, FileExistsError_)
from withruntime.sprites.types import SpriteInfo, SpriteList
from withruntime._compat import CompatibilityError

# sprites-py 0.7.2's __all__, without __version__.
VENDOR_EXPORTS = (
    "SpritesClient AsyncSpritesClient Sprite AsyncSprite SpriteFilesystem AsyncSpriteFilesystem SpritePath "
    "AsyncSpritePath AsyncCmd ControlConnection OpConn SpriteError NetworkError AuthenticationError NotFoundError "
    "ExecError FilesystemError FileNotFoundError_ IsADirectoryError_ NotADirectoryError_ PermissionError_ "
    "DirectoryNotEmptyError ClientOptions URLSettings SpriteConfig SpawnOptions ExecOptions ExecResult SpriteInfo "
    "ListOptions SpriteList Session Checkpoint StreamMessage PortMapping Service ServiceState ServiceWithState "
    "ServiceRequest ServiceLogEvent PolicyRule NetworkPolicy FileStat DirEntry").split()


class World(Base):
    """Base's fake, plus disk snapshots with labels, network rules that are
    kept, and a pause the network call reports once when asked."""

    def setUp(self):
        super().setUp()
        self.saved, self.rules = {}, {}
        self.snapshot_error = None
        self.paused_once = False
        world, test = self.world, self

        def snapshot(sb, name=None, **options):
            world.record("sandbox.snapshot", sb.id, options)
            if test.snapshot_error is not None:
                raise test.snapshot_error
            record = {"id": world.new_id(), "mode": options.get("mode"), "state": "ready", "sourceSandboxId": sb.id,
                      "labels": dict(options.get("labels") or {}), "createdAt": "2026-10-10T12:00:00Z"}
            test.saved[record["id"]] = record
            return record

        def get(snapshots, snapshot_id):
            world.record("snapshots.get", snapshot_id)
            if snapshot_id not in test.saved:
                raise not_found("not_found", "No such snapshot.")
            return test.saved[snapshot_id]

        def listed(snapshots, **query):
            world.record("snapshots.list", query)
            return Page([one for one in test.saved.values()
                         if query.get("sandbox_id") in (None, one["sourceSandboxId"])], 50)

        def network_get(network):
            world.record("network.get", network._id)
            if test.paused_once:
                test.paused_once = False
                raise withruntime.ConflictError("The sandbox is paused.", code="sandbox_paused", status=409)
            return dict(test.rules.get(network._id, {"internet": True, "allow": [], "deny": [], "connect": []}))

        def network_set(network, **rules):
            world.record("network.set", network._id, rules)
            test.rules[network._id] = {"connect": [], **rules}
            return rules

        async def iterate(page):
            # As AsyncPage: snapshots arrive as plain dictionaries, sandboxes as objects.
            for item in page._target._items:
                yield Asyncified(item) if isinstance(item, e2b_fake._WRAPPED) else item

        for obj, name, method in ((DropInSandbox, "snapshot", snapshot), (DropInSnapshots, "get", get),
                                  (DropInSnapshots, "list", listed), (FakeNetwork, "get", network_get),
                                  (FakeNetwork, "set", network_set), (Asyncified, "__aiter__", iterate)):
            patcher = patch.object(obj, name, method, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def sprite(self, name="one"):
        return SpritesClient(runtime=self.client).create_sprite(name)

    def async_client(self):
        return AsyncSpritesClient(runtime=self.world.async_client())

    def set_calls(self):
        return [rules for _, rules in self.world.called("network.set")]


class Exports(World):
    def test_every_vendor_export_is_importable(self):
        for name in VENDOR_EXPORTS:
            self.assertTrue(hasattr(sprites, name), name)

    def test_data_types_have_the_vendor_fields_and_defaults(self):
        self.assertEqual(sprites.ClientOptions(), sprites.ClientOptions("https://api.sprites.dev", 30.0))
        spawn = sprites.SpawnOptions()
        self.assertEqual((spawn.cwd, spawn.env, spawn.tty, spawn.rows, spawn.cols, spawn.detachable, spawn.session_id,
                          spawn.control_mode), (None, None, False, 24, 80, False, None, False))
        options = sprites.ExecOptions(cwd="/w")
        self.assertIsInstance(options, sprites.SpawnOptions)
        self.assertEqual((options.cwd, options.encoding, options.max_buffer), ("/w", "utf-8", 10 * 1024 * 1024))
        self.assertEqual(sprites.ExecResult(b"o", b"e", 3).exit_code, 3)
        self.assertEqual(sprites.PortMapping(1, 2).remote_host, "localhost")
        service = sprites.ServiceWithState("web", "node")
        self.assertIsInstance(service, sprites.Service)
        self.assertEqual((service.args, service.needs, service.env, service.state), ([], [], {}, None))
        self.assertEqual(sprites.ServiceState("web", "running").restart_count, 0)
        self.assertEqual(sprites.ServiceRequest("node").args, None)
        self.assertEqual(sprites.ServiceLogEvent("stdout").timestamp, 0)
        self.assertEqual(NetworkPolicy().rules, [])
        self.assertEqual(PolicyRule(), PolicyRule(None, None, None))
        self.assertEqual(Checkpoint("c", datetime(2026, 1, 1)).history, None)
        self.assertEqual(StreamMessage("info").data, None)
        entry = sprites.DirEntry("a", "/a", False)
        self.assertEqual((entry.size, entry.mode, entry.mod_time, entry.is_file), (0, "0644", None, True))
        self.assertFalse(FileStat("a", "/a", 1, "0755", datetime(2026, 1, 1), True).is_file)

    def test_exception_hierarchy_is_the_vendors_and_pythons(self):
        for kind, builtin, code in ((FileNotFoundError_, builtins.FileNotFoundError, "ENOENT"),
                                    (IsADirectoryError_, builtins.IsADirectoryError, "EISDIR"),
                                    (NotADirectoryError_, builtins.NotADirectoryError, "ENOTDIR"),
                                    (PermissionError_, builtins.PermissionError, "EACCES"),
                                    (FileExistsError_, builtins.FileExistsError, "EEXIST"),
                                    (DirectoryNotEmptyError, builtins.OSError, "ENOTEMPTY")):
            error = kind("read", "/x")
            self.assertIsInstance(error, FilesystemError)
            self.assertIsInstance(error, SpriteError)
            self.assertIsInstance(error, builtin)
            self.assertEqual((error.operation, error.path, error.code), ("read", "/x", code))
            self.assertTrue(str(error).startswith("read /x: ") and str(error).endswith(f"({code})"))
        self.assertEqual(str(FilesystemError("boom", "copy", "/a")), "copy /a: boom")
        for kind in (AuthenticationError, NotFoundError, sprites.NetworkError):
            self.assertTrue(issubclass(kind, SpriteError))


class Errors(World):
    def test_refused_key_is_authentication_error(self):
        refused = withruntime.AuthenticationError("bad key", code="unauthorized", status=401)
        with patch.object(DropInSandboxes, "list", side_effect=refused):
            with self.assertRaises(AuthenticationError):
                SpritesClient(runtime=self.client).get_sprite("one")
            with self.assertRaises(AuthenticationError):
                SpritesClient(runtime=self.client).list_sprites()

    def test_missing_sprite_is_not_found(self):
        client = SpritesClient(runtime=self.client)
        with self.assertRaises(NotFoundError):
            client.get_sprite("missing")
        sprite = client.create_sprite("gone")
        del self.world.sandboxes[sprite.id]
        with self.assertRaises(NotFoundError):
            sprite.list_sessions()

    def test_file_errors_are_the_vendors(self):
        fs = self.sprite().filesystem("/workspace")
        with self.assertRaises(FileNotFoundError_) as missing:
            (fs / "nothing").read_bytes()
        self.assertEqual((missing.exception.operation, missing.exception.path), ("read", "/workspace/nothing"))
        self.assertIsInstance(missing.exception, builtins.FileNotFoundError)
        with self.assertRaises(FileNotFoundError_):
            (fs / "nothing").stat()
        directory = withruntime.InvalidRequestError("dir", code="is_a_directory", status=400)
        with patch.object(FakeFiles, "read", side_effect=directory):
            with self.assertRaises(IsADirectoryError_):
                (fs / "dir").read_text()
        (fs / "d" / "f").write_bytes(b"x")
        with self.assertRaises(IsADirectoryError_):
            (fs / "d").unlink()
        with self.assertRaises(FileExistsError_):
            (fs / "d" / "f").touch(exist_ok=False)
        with self.assertRaises(FileNotFoundError_):
            (fs / "nothing").unlink()

    def test_command_failures_in_file_operations_are_filesystem_errors(self):
        fs = self.sprite().filesystem("/workspace")
        for stderr, kind in (("rmdir: failed to remove 'd': Directory not empty", DirectoryNotEmptyError),
                             ("chmod: cannot access 'x': No such file or directory", FileNotFoundError_),
                             ("rmdir: failed to remove 'f': Not a directory", NotADirectoryError_),
                             ("chmod: changing permissions of 'x': Operation not permitted", PermissionError_)):
            self.world.exec = lambda command, options, stderr=stderr: Result(1, stderr=stderr)
            with self.assertRaises(kind):
                (fs / "d").rmdir()
        self.world.exec = lambda command, options: Result(1, stderr="strange")
        with self.assertRaises(FilesystemError) as other:
            (fs / "d").chmod(0o700)
        self.assertEqual((other.exception.operation, other.exception.args[0]), ("chmod", "strange"))

    def test_stat_is_a_file_stat(self):
        fs = self.sprite().filesystem("/workspace")
        (fs / "f").write_bytes(b"abc")
        stat = (fs / "f").stat()
        self.assertIsInstance(stat, FileStat)
        self.assertEqual((stat.name, stat.path, stat.size, stat.mode, stat.is_dir, stat.is_file),
                         ("f", "/workspace/f", 3, "0755", False, True))
        self.assertEqual(stat.mod_time.year, 2026)


class Files(World):
    def test_copy_to_runs_a_checked_cp(self):
        fs = self.sprite().filesystem("/workspace")
        copied = (fs / "src" / "a").copy_to("b")
        self.assertEqual(str(copied), "/workspace/src/b")
        self.assertIsInstance(copied, sprites.SpritePath)
        self.assertEqual(self.world.called("sandbox.exec")[-1][0], ["cp", "-p", "-R", "--", "/workspace/src/a", "/workspace/src/b"])
        (fs / "a").copy_to(fs / "elsewhere" / "c", recursive=False)
        self.assertEqual(self.world.called("sandbox.exec")[-1][0], ["cp", "-p", "--", "/workspace/a", "/workspace/elsewhere/c"])
        self.world.exec = lambda command, options: Result(1, stderr="cp: -r not specified; omitting directory 'a'")
        with self.assertRaises(IsADirectoryError_) as error:
            (fs / "a").copy_to("/tmp/a", recursive=False)
        self.assertEqual(error.exception.operation, "copy")

    def test_rename_and_replace_resolve_a_relative_target_beside_the_path(self):
        fs = self.sprite().filesystem("/workspace")
        (fs / "dir" / "old").write_bytes(b"x")
        renamed = (fs / "dir" / "old").replace("new")
        self.assertEqual(str(renamed), "/workspace/dir/new")
        self.assertEqual(self.world.called("files.rename")[-1], ("/workspace/dir/old", "/workspace/dir/new", True))
        self.assertEqual((fs / "dir" / "new").rename("/workspace/top").read_bytes(), b"x")

    def test_async_copy_to_and_replace(self):
        async def run():
            sprite = await self.async_client().create_sprite("a")
            fs = sprite.filesystem("/workspace")
            copied = await (fs / "a").copy_to("b", recursive=False)
            self.assertIsInstance(copied, sprites.AsyncSpritePath)
            self.assertEqual(self.world.called("sandbox.exec")[-1][0], ["cp", "-p", "--", "/workspace/a", "/workspace/b"])
            await (fs / "x").write_bytes(b"1")
            self.assertEqual(str(await (fs / "x").replace("y")), "/workspace/y")
            self.assertEqual(await (fs / "y").read_bytes(), b"1")
            with self.assertRaises(FileNotFoundError_):
                await (fs / "x").read_bytes()
            stat = await (fs / "y").stat()
            self.assertIsInstance(stat, FileStat)
        asyncio.run(run())


class Checkpoints(World):
    def test_create_takes_a_labelled_disk_snapshot_and_streams_its_messages(self):
        sprite = self.sprite()
        messages = list(sprite.create_checkpoint("before upgrade"))
        sandbox, options = self.world.called("sandbox.snapshot")[-1]
        self.assertEqual(sandbox, sprite.id)
        self.assertEqual(options, {"mode": "disk", "timeout_seconds": 300.0,
                                   "labels": {"compat.sprite": sprite.id, "compat.comment": "before upgrade"}})
        snapshot_id = next(iter(self.saved))
        self.assertEqual([message.type for message in messages], ["info", "complete"])
        self.assertTrue(all(isinstance(message, StreamMessage) for message in messages))
        self.assertEqual(messages[1].data, snapshot_id)
        with sprite.create_checkpoint(timeout=12) as stream:
            self.assertEqual(len(list(stream)), 2)
        self.assertEqual(self.world.called("sandbox.snapshot")[-1][1],
                         {"mode": "disk", "timeout_seconds": 12.0, "labels": {"compat.sprite": sprite.id}})

    def test_create_accepts_an_httpx_style_timeout_and_refuses_others(self):
        sprite = self.sprite()

        class Timeout:
            read = 5.0
        list(sprite.create_checkpoint(timeout=Timeout()))
        self.assertEqual(self.world.called("sandbox.snapshot")[-1][1]["timeout_seconds"], 5.0)
        before = len(self.world.called("sandbox.snapshot"))
        for timeout in (0, -1, float("inf"), "300", True, None):
            with self.assertRaises(CompatibilityError):
                sprite.create_checkpoint(timeout=timeout)
        with self.assertRaises(TypeError):
            sprite.create_checkpoint(5)
        self.assertEqual(len(self.world.called("sandbox.snapshot")), before)

    def test_create_failures(self):
        sprite = self.sprite()
        self.snapshot_error = withruntime.ServiceUnavailableError("Capture failed.", code="snapshot_failed", status=503)
        messages = list(sprite.create_checkpoint("x"))
        self.assertEqual([(m.type, m.error) for m in messages], [("error", str(self.snapshot_error))])
        self.snapshot_error = withruntime.AuthenticationError("bad key", status=401)
        with self.assertRaises(AuthenticationError):
            sprite.create_checkpoint()
        self.snapshot_error = None
        with patch.object(DropInSandbox, "snapshot", return_value={"id": "m", "mode": "memory"}):
            with self.assertRaises(CompatibilityError):
                sprite.create_checkpoint()

    def test_list_and_get_only_this_sprites_disk_checkpoints(self):
        client = SpritesClient(runtime=self.client)
        sprite, other = client.create_sprite("one"), client.create_sprite("two")
        list(sprite.create_checkpoint("first"))
        list(other.create_checkpoint("theirs"))
        mine = next(key for key, value in self.saved.items() if value["sourceSandboxId"] == sprite.id)
        theirs = next(key for key, value in self.saved.items() if value["sourceSandboxId"] == other.id)
        self.saved["memory"] = {**self.saved[mine], "id": "memory", "mode": "memory"}
        self.saved["failed"] = {**self.saved[mine], "id": "failed", "state": "failed"}
        listed = sprite.list_checkpoints()
        self.assertEqual([(c.id, c.comment, c.history) for c in listed], [(mine, "first", [])])
        self.assertIsInstance(listed[0], Checkpoint)
        self.assertEqual(listed[0].create_time, datetime.fromisoformat("2026-10-10T12:00:00+00:00"))
        self.assertEqual(sprite.list_checkpoints(history_filter="").__len__(), 1)
        self.assertEqual(sprite.get_checkpoint(mine).comment, "first")
        for missing in (theirs, "memory", "failed", "nope"):
            with self.assertRaises(NotFoundError):
                sprite.get_checkpoint(missing)

    def test_history_filter_and_restore_are_refused_before_any_call(self):
        sprite = self.sprite()
        calls = len(self.world.calls)
        with self.assertRaises(CompatibilityError):
            sprite.list_checkpoints(history_filter="v1")
        with self.assertRaisesRegex(CompatibilityError, r"sandboxes\.create\(snapshot="):
            sprite.restore_checkpoint("cp", timeout=10)
        self.assertEqual(len(self.world.calls), calls)

    def test_async_checkpoints(self):
        async def run():
            sprite = await self.async_client().create_sprite("a")
            stream = await sprite.create_checkpoint("c")
            messages = list(stream)
            self.assertEqual([m.type for m in messages], ["info", "complete"])
            listed = await sprite.list_checkpoints()
            self.assertEqual([c.comment for c in listed], ["c"])
            self.assertEqual((await sprite.get_checkpoint(messages[1].data)).id, messages[1].data)
            with self.assertRaises(NotFoundError):
                await sprite.get_checkpoint("nope")
            with self.assertRaises(CompatibilityError):
                await sprite.list_checkpoints("v1")
            with self.assertRaises(CompatibilityError):
                await sprite.restore_checkpoint(messages[1].data)
            self.snapshot_error = withruntime.ServiceUnavailableError("down", status=503)
            self.assertEqual([m.type for m in await sprite.create_checkpoint()], ["error"])
        asyncio.run(run())


class Network(World):
    def update(self, *rules):
        sprite = self.sprite("net-" + str(len(self.world.sandboxes)))
        sprite.update_network_policy(NetworkPolicy(rules=[PolicyRule(*rule) for rule in rules]))
        return self.set_calls()[-1]

    def test_rules_map_onto_internet_allow_and_deny(self):
        cases = (
            ((), {"internet": True, "allow": [], "deny": []}),
            ((("*", "deny"),), {"internet": False, "allow": [], "deny": []}),
            ((("*", "allow"),), {"internet": True, "allow": [], "deny": []}),
            ((("a.com", "allow"),), {"internet": True, "allow": ["a.com"], "deny": []}),
            ((("a.com", "allow"), ("*.b.com", "allow"), ("*", "deny")),
             {"internet": True, "allow": ["a.com", "*.b.com"], "deny": []}),
            ((("x.com", "deny"),), {"internet": True, "allow": [], "deny": ["x.com"]}),
            ((("*", "deny"), ("x.com", "deny")), {"internet": False, "allow": [], "deny": ["x.com"]}),
            ((("*", "allow"), ("a.com", "allow"), ("x.com", "deny")), {"internet": True, "allow": [], "deny": ["x.com"]}),
            # A deny more specific than an allow wins on both.
            ((("*.x.com", "allow"), ("a.x.com", "deny"), ("*", "deny")),
             {"internet": True, "allow": ["*.x.com"], "deny": ["a.x.com"]}),
            # The apex is not under its own wildcard.
            ((("x.com", "allow"), ("*.x.com", "deny")), {"internet": True, "allow": ["x.com"], "deny": ["*.x.com"]}),
        )
        for rules, expected in cases:
            self.assertEqual(self.update(*rules), expected, rules)

    def test_policies_runtime_would_read_differently_are_refused(self):
        refused = (
            (("a.com", "allow", "github"),),
            ((None, None, "github"),),
            (("a.x.com", "allow"), ("*.x.com", "deny")),
            (("*.a.x.com", "allow"), ("*.X.com", "deny")),
            (("x.com", "allow"), ("x.com", "deny")),
            (("x.com", "block"),),
            (("x.com", None),),
            ((None, "allow"),),
            (("", "allow"),),
            (("*", "allow"), ("*", "deny")),
        )
        sprite = self.sprite()
        for rules in refused:
            with self.assertRaises(CompatibilityError, msg=rules):
                sprite.update_network_policy(NetworkPolicy(rules=[PolicyRule(*rule) for rule in rules]))
        with self.assertRaises(TypeError):
            sprite.update_network_policy([PolicyRule("a.com", "allow")])
        self.assertEqual(self.set_calls(), [])

    def test_runtime_connect_pairs_are_kept(self):
        sprite = self.sprite()
        self.rules[sprite.id] = {"internet": True, "allow": [], "deny": [], "connect": ["db.example.com:5432"]}
        sprite.update_network_policy(NetworkPolicy(rules=[PolicyRule("a.com", "allow")]))
        self.assertEqual(self.set_calls()[-1], {"internet": True, "allow": ["a.com"], "deny": [],
                                                "connect": ["db.example.com:5432"]})

    def test_get_reads_runtime_rules_as_sprites_rules(self):
        sprite = self.sprite()
        self.assertEqual(sprite.get_network_policy(), NetworkPolicy(rules=[]))
        self.rules[sprite.id] = {"internet": False, "allow": ["a.com"], "deny": ["b.com"]}
        self.assertEqual(sprite.get_network_policy().rules, [PolicyRule("*", "deny")])
        self.rules[sprite.id] = {"internet": True, "allow": ["a.com"], "deny": ["b.a.com"]}
        self.assertEqual(sprite.get_network_policy().rules,
                         [PolicyRule("a.com", "allow"), PolicyRule("b.a.com", "deny"), PolicyRule("*", "deny")])
        self.rules[sprite.id] = {"internet": True, "allow": [], "deny": ["b.com"]}
        self.assertEqual(sprite.get_network_policy().rules, [PolicyRule("b.com", "deny")])
        policy = NetworkPolicy(rules=[PolicyRule("a.com", "allow"), PolicyRule("x.a.com", "deny"), PolicyRule("*", "deny")])
        sprite.update_network_policy(policy)
        self.assertEqual(sprite.get_network_policy(), policy)

    def test_a_paused_sprite_is_woken_and_the_call_made_again(self):
        sprite = self.sprite()
        self.paused_once = True
        self.assertEqual(sprite.get_network_policy().rules, [])
        self.assertEqual(self.world.called("sandbox.wake")[-1][0], sprite.id)
        self.assertEqual(len(self.world.called("network.get")), 2)

    def test_async_network_policy(self):
        async def run():
            sprite = await self.async_client().create_sprite("a")
            self.paused_once = True
            await sprite.update_network_policy(NetworkPolicy(rules=[PolicyRule("*", "deny")]))
            self.assertEqual(self.set_calls()[-1], {"internet": False, "allow": [], "deny": []})
            self.assertEqual((await sprite.get_network_policy()).rules, [PolicyRule("*", "deny")])
            with self.assertRaises(CompatibilityError):
                await sprite.update_network_policy(NetworkPolicy(rules=[PolicyRule(include="github")]))
        asyncio.run(run())


class Lifecycle(World):
    def test_url_settings_share_port_8080(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("web")
        self.assertIsNone(sprite.update_url_settings(URLSettings(auth="public")))
        self.assertEqual(self.world.called("previews.create")[-1], (8080, {"visibility": "public"}))
        self.assertTrue(sprite.url.startswith("https://8080-"))
        self.assertEqual(sprite.url_settings, URLSettings(auth="public"))
        client.update_url_settings("web", URLSettings(auth="sprite"))
        self.assertEqual(self.world.called("previews.create")[-1], (8080, {"visibility": "private"}))
        updated = sprite.update(url_settings=URLSettings(auth="public"), labels=["x"])
        self.assertEqual((updated.labels, updated.url_settings.auth), (["x"], "public"))
        calls = len(self.world.called("previews.create"))
        for settings, kind in ((URLSettings(), ValueError), (URLSettings(auth="team"), ValueError),
                               (URLSettings(auth="sprite", private_access="org"), CompatibilityError)):
            with self.assertRaises(kind):
                sprite.update_url_settings(settings)
            with self.assertRaises(kind):
                sprite.update(url_settings=settings, labels=["changed"])
        self.assertEqual(len(self.world.called("previews.create")), calls)
        self.assertEqual(client.get_sprite("web").labels, ["x"])

    def test_create_with_url_settings(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("web", url_settings=URLSettings(auth="public"))
        self.assertEqual(self.world.called("previews.create")[-1], (8080, {"visibility": "public"}))
        self.assertIsNotNone(sprite.url)
        created = len(self.world.called("sandboxes.create"))
        with self.assertRaises(CompatibilityError):
            client.create_sprite("bad", url_settings=URLSettings(auth="public", private_access="x"))
        self.assertEqual(len(self.world.called("sandboxes.create")), created)
        self.world.refuse_public = True
        with self.assertRaises(withruntime.PermissionDeniedError):
            client.create_sprite("trial", url_settings=URLSettings(auth="public"))
        self.assertEqual(self.world.called("sandbox.update")[-1][0], {"persistent": False})

    def test_delete_upgrade_and_sessions(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("one")
        self.assertIsNone(sprite.upgrade())
        self.assertIsNone(client.upgrade_sprite("one"))
        with self.assertRaises(NotFoundError):
            client.upgrade_sprite("missing")
        sb = sprite._sandbox()
        running = sb.spawn(["sleep", "60"], pty={"rows": 24, "cols": 80})
        running.info.update(startedAt="2026-10-10T12:00:00Z", pty=True)
        sb.spawn(["true"]).kill()
        sessions = sprite.list_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertIsInstance(sessions[0], Session)
        self.assertEqual((sessions[0].id, sessions[0].command, sessions[0].workdir, sessions[0].is_active,
                          sessions[0].tty, sessions[0].created.year), (running.id, "sleep 60", "/workspace", True, True, 2026))
        sprite.delete()
        self.assertEqual(self.world.called("sandbox.stop")[-1][0], sprite.id)
        self.assertEqual(self.world.called("sandbox.update")[-1][0], {"persistent": False})
        client.create_sprite("two")
        client.delete_sprite("two")
        self.assertEqual(self.world.called("sandbox.update")[-1][0], {"persistent": False})

    def test_async_lifecycle(self):
        async def run():
            client = self.async_client()
            sprite = await client.create_sprite("a", url_settings=URLSettings(auth="sprite"))
            self.assertEqual(self.world.called("previews.create")[-1], (8080, {"visibility": "private"}))
            await sprite.update_url_settings(URLSettings(auth="public"))
            await client.update_url_settings("a", URLSettings(auth="public"))
            self.assertEqual((await sprite.update(url_settings=URLSettings(auth="sprite"))).url_settings.auth, "sprite")
            self.assertIsNone(await sprite.upgrade())
            self.assertIsNone(await client.upgrade_sprite("a"))
            with self.assertRaises(NotFoundError):
                await client.upgrade_sprite("missing")
            (await sprite._sandbox())._target.spawn(["sleep", "1"])
            self.assertEqual([s.command for s in await sprite.list_sessions()], ["sleep 1"])
            await sprite.delete()
            await client.create_sprite("b")
            await client.delete_sprite("b")
            self.assertEqual(len(self.world.called("sandbox.stop")), 2)
        asyncio.run(run())


class Commands(World):
    def test_command_options_reach_the_process(self):
        sprite = self.sprite()
        sink = io.BytesIO()
        command = sprite.command("cat", env={"A": "b"}, cwd="/srv", timeout=5, stdin=io.BytesIO(b"in"), stdout=sink,
                                 stderr=io.BytesIO(), tty=True, tty_rows=40, tty_cols=100)
        command.run()
        argv, options = self.world.called("sandbox.spawn")[-1]
        self.assertEqual(argv, ["cat"])
        self.assertEqual((options["env"], options["cwd"], options["timeout_ms"], options["stdin"], options["pty"]),
                         ({"A": "b"}, "/srv", 5000, "pipe", {"rows": 40, "cols": 100}))
        self.assertEqual(self.world.called("process.write")[0][1], b"in")
        self.assertIn(b"ran", sink.getvalue())
        sprite.command("pwd", cwd="/tmp", env={"X": "1"}, timeout=2).output()
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["cwd"], "/tmp")
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["env"], {"X": "1"})
        self.assertEqual(self.world.called("sandbox.exec")[-1][1]["timeout_ms"], 2000)
        with self.assertRaises(TypeError):
            sprite.command("x", session_id="s")
        self.assertEqual(sprite.attach_session("proc-1").session_id, "proc-1")

    def test_async_command_options(self):
        async def run():
            sprite = await self.async_client().create_sprite("a")
            sink = io.BytesIO()
            await sprite.command("cat", stdout=sink, tty=True, tty_rows=10, tty_cols=20, cwd="/srv").run()
            options = self.world.called("sandbox.spawn")[-1][1]
            self.assertEqual((options["cwd"], options["pty"]), ("/srv", {"rows": 10, "cols": 20}))
            self.assertIsInstance(sprite.command("x"), sprites.AsyncCmd)
        asyncio.run(run())


class Refusals(World):
    def test_services_are_refused_before_any_call(self):
        sprite = self.sprite()
        calls = len(self.world.calls)
        for method, args in ((sprite.list_services, ()), (sprite.get_service, ("web",)),
                             (sprite.delete_service, ("web",)), (sprite.create_service, ("web", "node", ["s.js"])),
                             (sprite.start_service, ("web", 5)), (sprite.stop_service, ("web", 5)),
                             (sprite.signal_service, ("web", "SIGTERM"))):
            with self.assertRaisesRegex(CompatibilityError, "sprite.command"):
                method(*args)
        self.assertEqual(len(self.world.calls), calls)

    def test_control_mode_is_never_on(self):
        sprite = self.sprite()
        self.assertFalse(sprite.use_control_mode())
        self.assertFalse(sprite.has_control_connection())
        self.assertIsNone(asyncio.run(sprite.close_control_connection()))
        with self.assertRaises(CompatibilityError):
            asyncio.run(sprite.get_control_connection())
        with self.assertRaises(CompatibilityError):
            OpConn(None)
        with self.assertRaises(CompatibilityError):
            ControlConnection(sprite)
        op, cc = object.__new__(OpConn), object.__new__(ControlConnection)
        for call in (op.handle_data, op.handle_text):
            with self.assertRaises(CompatibilityError):
                call(b"x")
        for call in (op.close, op.is_closed, op.get_exit_code, op.get_stdout, op.get_stderr, op.complete, cc.is_closed):
            with self.assertRaises(CompatibilityError):
                call()
        for coroutine in (op.write(b"x"), op.send_eof(), op.resize(80, 24), op.signal("SIGINT"), op.wait(),
                          cc.connect(), cc.start_op("exec", ["ls"]), cc.close()):
            with self.assertRaises(CompatibilityError):
                asyncio.run(coroutine)

    def test_http_client_and_token_exchange_are_refused(self):
        for client in (SpritesClient(runtime=self.client), AsyncSpritesClient(runtime=self.world.async_client())):
            with self.assertRaisesRegex(CompatibilityError, "Runtime client"):
                client.http_client
        with self.assertRaisesRegex(CompatibilityError, "Runtime API key"):
            SpritesClient.create_token("macaroon", "org")
        with self.assertRaises(CompatibilityError):
            asyncio.run(AsyncSpritesClient.create_token("macaroon", "org", invite_code="x"))


class SpritesMetadata(Base):
    def test_labels_replace_and_roundtrip_metadata(self):
        client = SpritesClient(runtime=self.client)
        sprite = client.create_sprite("one", SpriteConfig(cpus=2, ram_mb=1024), labels=["before"])
        self.assertEqual(sprite.labels, ["before"])
        changed = sprite.update(labels=["after", "two"])
        self.assertEqual(changed.labels, ["after", "two"])
        self.assertEqual(client.get_sprite("one").labels, ["after", "two"])
        self.assertEqual(changed.config.cpus, 2)
        self.assertEqual(changed.config.ram_mb, 1024)
        self.assertIsNotNone(changed.created_at)
        self.assertEqual(sprite.update(labels=[]).labels, [])
        with self.assertRaisesRegex(ValueError, "required"):
            sprite.update()
        self.assertEqual(sprite._sandbox().info["labels"]["compat.provider"], "sprites")

    def test_pagination_cursor_filters_and_stable_position(self):
        client = SpritesClient(runtime=self.client)
        for name in ("z-last", "a-first", "m-middle", "other"):
            client.create_sprite(name)
        first = client.list_sprites(ListOptions(max_results=2))
        self.assertIsInstance(first, SpriteList)
        self.assertIsInstance(first.sprites[0], SpriteInfo)
        self.assertEqual([item.name for item in first.sprites], ["a-first", "m-middle"])
        self.assertTrue(first.has_more)
        client.create_sprite("b-added-before-cursor")
        second = client.list_sprites(ListOptions(max_results=2, continuation_token=first.next_continuation_token))
        self.assertEqual([item.name for item in second.sprites], ["other", "z-last"])
        self.assertFalse(second.has_more)
        with self.assertRaisesRegex(ValueError, "token"):
            client.list_sprites(ListOptions(prefix="a", continuation_token=first.next_continuation_token))
        for token in ("garbage", "e30=", "bnVsbA=="):
            with self.assertRaises(ValueError):
                client.list_sprites(ListOptions(continuation_token=token))

    def test_async_labels_and_pagination(self):
        async def run():
            client = AsyncSpritesClient(runtime=self.world.async_client())
            one = await client.create_sprite("a", labels=["before"])
            await client.create_sprite("b")
            self.assertEqual((await one.update(labels=["after"])).labels, ["after"])
            self.assertEqual((await client.get_sprite("a")).labels, ["after"])
            first = await client.list_sprites(ListOptions(max_results=1))
            second = await client.list_sprites(ListOptions(max_results=1, continuation_token=first.next_continuation_token))
            self.assertEqual([item.name for item in first.sprites + second.sprites], ["a", "b"])
        asyncio.run(run())
