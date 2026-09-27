"""The Blaxel adapter against a fake of the withruntime SDK (tests/dropin_fake.py):
the mappings and the refusals, sync and async, and the shell lines every
process runs as, run for real in bash."""
import asyncio
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dropin_fake import BlaxelSandbox, BlaxelWorld  # noqa: E402
from e2b_fake import Result  # noqa: E402

import withruntime  # noqa: E402
import withruntime.blaxel as bl  # noqa: E402
from withruntime.blaxel import (CodeInterpreter, NotSupportedError, ProcessResponseStatus,  # noqa: E402
                                ResponseError, SandboxAPIError, SandboxInstance, SandboxState, SnapshotAPIError,
                                Status, SyncCodeInterpreter, SyncSandboxInstance, SyncSnapshot)
from withruntime.blaxel import _core as core  # noqa: E402
from withruntime.blaxel import _sync_sandbox  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SAVED = dict(os.environ)


def offline() -> None:
    """Any call that escapes the fake fails at once, never reaching the API."""
    os.environ.update(RUNTIME_API_URL="http://localhost:9", RUNTIME_API_KEY="rtcloud_test_never_sent")
    os.environ.pop("BL_API_KEY", None)
    os.environ.pop("BL_REGION", None)


class Base(unittest.TestCase):
    def setUp(self) -> None:
        offline()
        self.world = BlaxelWorld()
        bl.use_client(self.world.client())

    def tearDown(self) -> None:
        bl.use_client(None)
        os.environ.clear()
        os.environ.update(SAVED)

    def create(self, config=None, **kwargs):
        return SyncSandboxInstance.create(config, **kwargs)

    def last_create(self):
        return self.world.called("sandboxes.create")[-1][0]

    def runtime(self, box):
        return self.world.sandboxes[box.withruntime.id]

    def spawned(self):
        return self.world.called("sandbox.spawn")[-1]

    def keep_running(self):
        self.world.program = lambda process: process.emit("stdout", "started\n")


class Create(Base):
    def test_blaxel_defaults_and_standby(self):
        box = self.create({"name": "one"})
        self.assertEqual(self.last_create(), {
            "vcpu": 2, "memory_mib": 4096, "timeout_seconds": 3600, "on_lease_end": "pause",
            "idle_pause_seconds": 60, "auto_wake": True, "name": "one",
            "labels": {"blaxel/image": "blaxel/base-image:latest", "blaxel/memory": "4096"}})
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 365)
        self.assertEqual(self.world.called("sandbox.exec"), [])
        self.assertEqual((box.metadata.name, box.status, box.state), ("one", Status.DEPLOYED, SandboxState.RUNNING))
        self.assertEqual((box.spec.runtime.image, box.spec.runtime.memory, box.spec.region),
                         ("blaxel/base-image:latest", 4096, "us-was-1"))
        self.assertIsNone(box.expires_in)
        self.assertEqual(box.metadata.labels, {})

    def test_runtime_fields_pass_through(self):
        self.create({"name": "r"}, runtime_create={"funding": "trial", "vcpu": 4})
        self.assertEqual((self.last_create()["funding"], self.last_create()["vcpu"]), ("trial", 4))

    def test_bad_lifetimes_are_refused_as_blaxel_refuses_them(self):
        for config in ({"ttl": "10 minutes"}, {"ttl": "5"}, {"expires": datetime.now(timezone.utc) - timedelta(hours=1)},
                       {"lifecycle": {"expirationPolicies": [{"type": "ttl-idle"}]}},
                       {"lifecycle": {"expirationPolicies": [{"type": "date", "value": "someday"}]}},
                       {"lifecycle": {"expirationPolicies": [{"type": "weekly", "value": "1d"}]}}):
            with self.assertRaises(SandboxAPIError) as caught:
                self.create(config)
            self.assertEqual(caught.exception.status_code, 400, config)
        self.assertEqual(self.world.called("sandboxes.create"), [])
        self.create({"ttl": "1h30m"})
        self.assertEqual((self.last_create()["on_lease_end"], self.world.called("sandbox.retention")[-1][1]),
                         ("pause", 1))

    def test_iptables_and_volumes(self):
        self.world.volumes.append({"id": "vol-1", "name": "data", "state": "ready"})
        self.create({"extra_args": {"iptables": "enabled"},
                     "volumes": [bl.VolumeBinding("data", "/blaxel/data"), {"name": "data", "mount_path": "/mnt"}]})
        self.assertEqual(self.last_create()["volumes"], [{"volume_id": "vol-1", "path": "/workspace/data"},
                                                         {"volume_id": "vol-1", "path": "/mnt"}])

    def test_a_name_still_held_by_a_deleted_sandbox_is_waited_for(self):
        gone = self.create({"name": "again"})
        self.runtime(gone).info["state"] = "stopping"
        original = type(self.world.client().sandboxes).create
        attempts = []

        def create(self_, **fields):
            attempts.append(fields)
            if len(attempts) == 1:
                raise withruntime.ConflictError("The name is taken.", code="name_taken", status=409,
                                                details={"sandboxId": gone.withruntime.id, "state": "stopping"})
            return original(self_, **fields)
        type(self.world.client().sandboxes).create = create
        try:
            box = self.create({"name": "again"})
        finally:
            type(self.world.client().sandboxes).create = original
        self.assertEqual(len(attempts), 2)
        self.assertEqual(self.world.called("sandbox.wait_for")[-1], (gone.withruntime.id, "stopped"))
        self.assertNotEqual(box.withruntime.id, gone.withruntime.id)
        with self.assertRaises(SandboxAPIError) as caught:
            type(self.world.client().sandboxes).create = lambda self_, **f: (_ for _ in ()).throw(
                withruntime.ConflictError("The name is taken.", code="name_taken", status=409,
                                          details={"sandboxId": "x", "state": "running"}))
            try:
                self.create({"name": "again"})
            finally:
                type(self.world.client().sandboxes).create = original
        self.assertEqual(caught.exception.status_code, 409)

    def test_memory_sets_vcpus(self):
        for memory, vcpu in ((1024, 1), (2048, 1), (3072, 2), (8192, 4), (16384, 8), (65536, 16)):
            self.create({"memory": memory})
            self.assertEqual((self.last_create()["memory_mib"], self.last_create()["vcpu"]), (memory, vcpu))

    def test_envs_are_written_once_on_stdin_never_in_a_command_line(self):
        box = self.create({"name": "e", "envs": [{"name": "TOKEN", "value": "it's $secret"}]})
        [(argv, options)] = [call for call in self.world.called("sandbox.exec")]
        self.assertNotIn("secret", " ".join(argv))
        self.assertIn("install -D -m 0640", argv[-1])
        self.assertEqual(core.parse_env_file(options["stdin"]), {"TOKEN": "it's $secret"})
        self.assertNotIn("blaxel/envs", self.last_create()["labels"])
        box.process.exec({"command": "echo $TOKEN"})
        line, options = self.spawned()
        self.assertNotIn("secret", line)
        self.assertIsNone(options["env"])
        self.assertIn(". /etc/runtime-blaxel/env", line)

    def test_env_names_no_shell_can_hold_are_refused(self):
        with self.assertRaises(NotSupportedError):
            self.create({"envs": [{"name": "BAD-NAME", "value": "x"}]})
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_ttl_and_lifecycle_never_delete_earlier_than_blaxel(self):
        cases = [({"ttl": "30m"}, 1800, "stop", 1), ({"ttl": "1h"}, 3600, "stop", 1),
                 ({"ttl": "2h"}, 3600, "pause", 1), ({"ttl": "2d"}, 3600, "pause", 2),
                 ({"ttl": "30s"}, 60, "stop", 1),
                 ({"lifecycle": {"expirationPolicies": [{"type": "ttl-idle", "value": "30m", "action": "delete"}]}},
                  3600, "pause", 1),
                 ({"lifecycle": {"expiration_policies": [{"type_": "ttl-max-age", "value": "10d"}]}}, 3600, "pause",
                  10),
                 ({"expires": datetime.now(timezone.utc) + timedelta(minutes=20)}, None, "stop", 1)]
        for config, lease, end, days in cases:
            self.create(config)
            fields = self.last_create()
            if lease is not None:
                self.assertEqual(fields["timeout_seconds"], lease, config)
            else:
                self.assertTrue(1100 <= fields["timeout_seconds"] <= 1200)
            self.assertEqual((fields["on_lease_end"], self.world.called("sandbox.retention")[-1][1]), (end, days),
                             config)

    def test_a_trial_account_keeps_runtimes_retention(self):
        def refuse(_self, days):
            raise withruntime.ConflictError("paid pause retention unavailable", code="retention_unavailable",
                                            status=409)
        original = BlaxelSandbox.set_retention
        BlaxelSandbox.set_retention = refuse
        try:
            box = self.create({"name": "trial"})
        finally:
            BlaxelSandbox.set_retention = original
        self.assertEqual(box.status, Status.DEPLOYED)
        self.assertEqual(self.runtime(box).state, "running")

    def test_a_trial_sandbox_is_not_asked_to_change_its_seven_days(self):
        original = BlaxelSandbox.__init__

        def trial(self_, world, sandbox_id, fields):
            original(self_, world, sandbox_id, fields)
            self_.info["funding"] = "trial"
        BlaxelSandbox.__init__ = trial
        try:
            self.create({"name": "t"})
        finally:
            BlaxelSandbox.__init__ = original
        self.assertEqual(self.world.called("sandbox.retention"), [])

    def test_regions(self):
        for region in ("us-pdx-1", "us-was-1", "auto"):
            box = self.create({"region": region})
            self.assertEqual(box.spec.region, region)
        with self.assertRaises(NotSupportedError) as caught:
            self.create({"region": "eu-lon-1"})
        self.assertIn("eu-lon-1", str(caught.exception))
        os.environ["BL_REGION"] = "eu-dub-1"
        with self.assertRaises(NotSupportedError):
            self.create()
        self.assertEqual(len(self.world.called("sandboxes.create")), 3)

    def test_images(self):
        for image in ("blaxel/base-image:latest", "blaxel/py-app", "blaxel/jupyter-server:latest"):
            self.create({"image": image})
            self.assertNotIn("image", self.last_create())
        self.world.images += [{"id": "img-1", "name": "my-template", "state": "ready"},
                              {"id": "img-2", "name": "my-company-agent-image", "tag": "v2", "state": "ready"},
                              {"id": "img-3", "name": "blaxel-vite", "state": "ready"}]
        for image, found in (("my-template:latest", "img-1"), ("my-template", "img-1"),
                             ("my-company/agent-image:v2", "img-2"), ("blaxel/vite:latest", "img-3")):
            self.create({"image": image})
            self.assertEqual(self.last_create()["image"], found, image)
        self.assertEqual(self.world.called("images.resolve")[-1], ("blaxel-vite:latest",))
        # A slash reaches Runtime's name rule no more: a missing image is NotSupportedError, with a command that works.
        for image, name, tag in (("blaxel/nextjs:latest", "blaxel-nextjs", "latest"),
                                 ("my-company/agent-image", "my-company-agent-image", "latest"),
                                 ("registry.example.com:5000/team/app:1.2", "registry.example.com:5000-team-app", "1.2")):
            with self.assertRaises(NotSupportedError) as caught:
                self.create({"image": image})
            self.assertEqual(core.image_ref(image), (name, tag))
            self.assertIn(f"`npx withruntime image build --dockerfile Dockerfile --name {name} -t {name}:{tag}`",
                          caught.exception.alternative)
            self.assertIn(f'The code can keep "{image}"', caught.exception.alternative)

    def test_the_trial_size_cap_in_blaxels_terms(self):
        self.world.trial = True
        with self.assertRaises(SandboxAPIError) as caught:
            self.create({"memory": 8192})
        self.assertEqual(str(caught.exception).splitlines()[0],
                         "A trial sandbox has at most 4096 MB of memory (2 vCPUs); pass memory 4096 or add credit.")
        self.assertNotIn("memoryMiB", str(caught.exception))
        self.assertEqual((caught.exception.status_code, caught.exception.code), (400, "invalid_trial"))

    def test_every_runtime_hint_is_said_in_blaxels_calls(self):
        expected = {
            "is_a_directory": "That path is a directory: list it with sandbox.fs.ls(path), or name a file in it.",
            "cwd_not_found": "Make the directory with sandbox.fs.mkdir(path), or pass an existing working_dir to "
                             "sandbox.process.exec.",
            "sandbox_paused": "Call sandbox.unarchive(), then try again.",
            "not_running": "The sandbox is not running: call sandbox.unarchive() if it was archived, or make a new one "
                           "with SandboxInstance.create if it was deleted.",
            "trial_busy": "The trial's sandboxes are all in use: delete one you no longer need (sandbox.delete()) or "
                          "archive it (sandbox.archive()), then try again. Moving to paid credit is the account "
                          "owner's decision.",
            "public_preview_not_allowed": 'On the trial, share the port privately: sandbox.previews.create({"metadata": '
                                          '{"name": ...}, "spec": {"port": ..., "public": False}}) and a token from '
                                          "preview.tokens.create(expires_at). A public preview needs a paid sandbox, "
                                          "which is the account owner's decision.",
            "busy": "Try again in a moment.", "guest_busy": "Try again in a moment.",
            "rate_limited": "Try again in a moment.",
            "unauthorized": "Set RUNTIME_API_KEY to a Runtime key (https://withruntime.com/account/keys), or run "
                            "`npx withruntime login` once. A Blaxel key (BL_API_KEY) is never sent.",
        }
        runtime_only = ("/v1/", "x-runtime", "Idempotency-Key", "visibility", "urlWithToken", ":wake")
        for code, hint in expected.items():
            for subject in ("sandbox", "process"):
                error = core.translate(withruntime.ConflictError(
                    "Refused.", code=code, status=409, request_id="req_7",
                    hint="Send :wake to /v1/sandboxes/{id} with visibility, urlWithToken, x-runtime-preview-token and "
                         "an Idempotency-Key."), subject)
                self.assertEqual(error.hint, hint, code)
                self.assertEqual((error.status_code, error.code, error.request_id), (409, code, "req_7"))
                self.assertIn("Request: req_7", str(error))
                for name in runtime_only:
                    self.assertNotIn(name, str(error), (code, name))
        other = core.translate(withruntime.ConflictError("Refused.", code="something_else", status=409,
                                                         hint="Runtime's own words."))
        self.assertEqual(other.hint, "Runtime's own words.")

    def test_runtime_hints_speak_blaxel(self):
        taken = core.translate(withruntime.ConflictError("The name is taken.", code="name_taken", status=409,
                                                         hint="Pass getOrCreate: true to reuse it."))
        self.assertNotIn("getOrCreate", str(taken))
        self.assertIn("create_if_not_exists", taken.hint)
        missing = core.translate(withruntime.NotFoundError("No such file.", code="file_not_found", status=404,
                                                           hint="list the directory with GET /v1/.../files/list"),
                                 "file")
        self.assertEqual(missing.hint, "List the directory with sandbox.fs.ls(path).")
        self.assertNotIn("/v1/", str(missing))

    def test_refusals_before_anything_happens(self):
        cases = [({"volumes": [{"name": "v", "mount_path": "/data"}]}, "not a Runtime volume"),
                 ({"volumes": [{"name": "v", "mount_path": "/data", "read_only": True}]}, "Read-only"),
                 ({"volumes": [{"name": "v", "mount_path": "/d", "type": "ephemeral", "size_mb": 9}]}, "Ephemeral"),
                 ({"extra_args": {"gpu": "1"}}, "gpu"),
                 ({"lifecycle": {"expirationPolicies": [{"type": "ttl-idle", "value": "1h", "action": "archive"}]}},
                  "archive"),
                 ({"snapshot_enabled": False}, "snapshots off"),
                 ({"network": {"egress": {"gatewayName": "x"}}}, "egress"),
                 ({"network": {"proxy": {"routing": [{"destinations": ["x"]}]}}}, "routing")]
        for config, text in cases:
            with self.assertRaises(NotSupportedError) as caught:
                self.create(config)
            self.assertIn(text, str(caught.exception))
            self.assertTrue(caught.exception.alternative)
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_network_and_labels_and_external_id(self):
        self.create({"name": "n", "labels": {"env": "dev"}, "external_id": "session-1", "ports": [{"target": 3000}],
                     "network": {"allowedDomains": ["api.openai.com"], "forbidden_domains": ["evil.example"]}})
        fields = self.last_create()
        self.assertEqual(fields["network"], {"internet": True, "allow": ["api.openai.com"], "deny": ["evil.example"]})
        self.assertEqual(fields["labels"]["env"], "dev")
        self.assertEqual(fields["labels"]["blaxel/externalId"], "session-1")
        found = SyncSandboxInstance.get_by_external_id("session-1")
        self.assertEqual((found.metadata.name, found.metadata.external_id, found.metadata.labels),
                         ("n", "session-1", {"env": "dev"}))
        self.assertEqual([one.target for one in found.spec.runtime.ports], [3000])
        self.assertEqual(len(SyncSandboxInstance.list(external_id="session-1")), 1)

    def test_a_whole_sandbox_model_as_input(self):
        box = self.create({"metadata": {"name": "m", "labels": {"a": "b"}},
                           "spec": {"runtime": {"image": "blaxel/base-image:latest", "memory": 8192,
                                                "envs": [{"name": "X", "value": "1"}], "ttl": "3d"}}})
        self.assertEqual((box.metadata.name, self.last_create()["vcpu"], self.last_create()["labels"]["a"]),
                         ("m", 4, "b"))
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 3)
        self.assertEqual(box.spec.runtime.ttl, "3d")

    def test_create_if_not_exists_is_one_sandbox_under_a_race(self):
        first = SyncSandboxInstance.create_if_not_exists({"name": "shared", "envs": [{"name": "A", "value": "1"}]})
        second = SyncSandboxInstance.create_if_not_exists({"name": "shared", "envs": [{"name": "A", "value": "2"}]})
        self.assertEqual(first.withruntime.id, second.withruntime.id)
        self.assertTrue(all(call[0]["get_or_create"] for call in self.world.called("sandboxes.create")))
        # The one that found it set up nothing: the envs and retention are the first's.
        self.assertEqual(len(self.world.called("sandbox.exec")), 1)
        self.assertEqual(len(self.world.called("sandbox.retention")), 1)
        with self.assertRaises(ValueError):
            SyncSandboxInstance.create_if_not_exists({"image": "blaxel/base-image"})

    def test_a_failed_setup_stops_the_sandbox(self):
        self.world.exec = lambda command, _: Result(1, "", "no sudo")
        with self.assertRaises(SandboxAPIError) as caught:
            self.create({"envs": [{"name": "A", "value": "1"}]})
        self.assertEqual(caught.exception.code, "setup_failed")
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)


class Keys(unittest.TestCase):
    def setUp(self) -> None:
        offline()

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(SAVED)

    def test_a_blaxel_key_is_never_sent(self):
        os.environ.pop("RUNTIME_API_KEY")
        os.environ["BL_API_KEY"] = "bl_workspace_key"
        self.assertIsNone(core.pick_key())
        os.environ["BL_API_KEY"] = "rtcloud_in_bl"
        self.assertEqual(core.pick_key(), "rtcloud_in_bl")
        os.environ["RUNTIME_API_KEY"] = "rtcloud_env"
        self.assertEqual(core.pick_key(), "rtcloud_env")

    def test_the_missing_key_error_says_the_blaxel_key_was_kept(self):
        os.environ["BL_API_KEY"] = "bl_workspace_key"
        error = core.translate(withruntime.RuntimeError("No Runtime key found.", code="missing_api_key"))
        self.assertIn("never sent", str(error))

    def test_the_client_is_made_with_no_blaxel_key(self):
        os.environ.pop("RUNTIME_API_KEY")
        os.environ["BL_API_KEY"] = "bl_workspace_key"
        _sync_sandbox._clients.clear()
        client = _sync_sandbox._client()
        self.assertNotIn("bl_workspace_key", repr(vars(client._t)))
        _sync_sandbox._clients.clear()


class ProcessLines(unittest.TestCase):
    """The lines run for real in bash, with the env file at a temporary path
    and sudo swapped for env, as the TypeScript adapter's tests run them."""

    def run_line(self, line, env_file_text="", env=None, stdin=None):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory, "env")
            env_file.write_text(env_file_text)
            line = line.replace(core.ENV_FILE, str(env_file)).replace("exec sudo -E env", "exec env")
            return subprocess.run(["bash", "-c", line], capture_output=True, text=True, input=stdin,
                                  env={"PATH": os.environ["PATH"], "HOME": "/workspace", **(env or {})}, timeout=20)

    def test_the_exact_line(self):
        self.assertEqual(core.process_line("ls", "n"), (
            ": rt-blaxel 'n'; export HOST=\"${HOST:-0.0.0.0}\"; [ -r /etc/runtime-blaxel/env ] && . "
            "/etc/runtime-blaxel/env; unset RUNTIME_BLAXEL_KEEP; __rt_cmd='ls'; export __rt_cmd; exec sudo -E env "
            "\"PATH=$PATH\" \"HOME=$HOME\" bash -c 'eval \"$__rt_cmd\"'"))
        self.assertIn("'n'; : rt-blaxel-keep; export HOST", core.process_line("ls", "n", keep_alive=True))
        self.assertIn("unset RUNTIME_BLAXEL_KEEP; { [ -e /blaxel ] || sudo ln -s /workspace /blaxel; } 2>/dev/null; "
                      "__rt_cmd=", core.process_line("ls /blaxel", "n", link_home=True))

    def test_envs_home_stdin_and_the_exit_code(self):
        envs = {"A": "from-sandbox", "PORT": "3000", "B": "it's $HOME `x` \"q\""}
        result = self.run_line(core.process_line('echo "$A $PORT $HOME $HOST|$B"; read x; echo got $x; exit 7', "n"),
                               core.env_file_lines(envs), {"PORT": "8080", core.KEEP: ":PORT:"}, "line\n")
        self.assertEqual((result.returncode, result.stdout),
                         (7, "from-sandbox 8080 /workspace 0.0.0.0|it's $HOME `x` \"q\"\ngot line\n"))
        self.assertNotIn(core.KEEP, self.run_line(core.process_line("env", "p"), "", {core.KEEP: ":X:"}).stdout)

    def test_the_restart_note(self):
        result = self.run_line(core.process_line("echo run; exit 2", "r", 1))
        self.assertEqual((result.returncode, result.stdout),
                         (2, "run\n\n[Process failed with exit code 2. Attempting restart 1/1...]\nrun\n"))

    def test_a_forks_appended_envs_win(self):
        text = core.env_file_lines({"A": "1", "B": "1"}) + core.env_file_lines({"A": "2"})
        self.assertEqual(core.parse_env_file(text), {"A": "2", "B": "1"})
        self.assertEqual(self.run_line(core.process_line("echo $A$B", "p"), text).stdout, "21\n")

    def test_a_port_is_ready_only_on_a_non_loopback_listener(self):
        """Blaxel's IsRoutableListener: LISTEN (0A) on an address other than
        loopback, IPv4 or IPv6, from whichever tables exist."""
        head = "  sl  local_address rem_address   st\n"
        cases = [("0: 00000000:0BB8 00000000:0000 0A", True),  # 0.0.0.0:3000
                 ("0: 0100007F:0BB8 00000000:0000 0A", False),  # 127.0.0.1:3000
                 ("0: 00000000:0BB8 0100007F:D431 01", False),  # an established connection
                 ("0: 00000000:1F90 00000000:0000 0A", False),  # another port
                 ("0: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A", False),
                 ("0: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A", False),
                 ("0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A", True)]
        for row, ready in cases:
            with tempfile.TemporaryDirectory() as directory:
                table = Path(directory, "tcp")
                table.write_text(head + row + "\n")
                missing = str(Path(directory, "tcp6"))  # a guest without IPv6
                result = subprocess.run(["bash", "-c", core.port_wait_script([3000], 1, (str(table), missing))[-1]],
                                        capture_output=True, timeout=10)
            self.assertEqual(result.returncode == 0, ready, row)
        with tempfile.TemporaryDirectory() as directory:
            both = (str(Path(directory, "tcp")), str(Path(directory, "tcp6")))
            result = subprocess.run(["bash", "-c", core.port_wait_script([3000], 1, both)[-1]], capture_output=True,
                                    timeout=10)
        self.assertEqual(result.returncode, 1)

    def test_restarts_count_and_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            counter = Path(directory, "n")
            command = f'n=$(cat {counter} 2>/dev/null || echo 0); echo $((n+1)) > {counter}; exit 3'
            result = self.run_line(core.process_line(command, "r", 2))
            self.assertEqual(result.returncode, 3)
            self.assertEqual(counter.read_text().strip(), "3")
            self.assertEqual(core.restarts_in(result.stdout), 2)
        self.assertEqual(self.run_line(core.process_line("true", "r", -1)).returncode, 0)

    def test_the_name_survives_runtimes_256_character_record(self):
        for name in ("server", "it's odd", "a b"):
            command = "echo " + "x" * 400
            recorded = " ".join(["bash", "-c", core.process_line(command, name, None, True)])[:256]
            parsed = core.parse_record(recorded)
            self.assertEqual(parsed.name, name)
            self.assertTrue(len(parsed.command) > 20 and command.startswith(parsed.command))
        short = " ".join(["bash", "-c", core.process_line("echo 'hi'", "x")])
        self.assertEqual(core.parse_record(short).command, "echo 'hi'")
        self.assertIsNone(core.parse_record("bash -c sleep 1"))


class Processes(Base):
    def test_exec_waits_and_maps_the_request(self):
        box = self.create({"name": "p"})
        response = box.process.exec({"command": "ls", "name": "list", "working_dir": "/blaxel/app",
                                     "env": {"B": "2"}, "wait_for_completion": True})
        line, options = self.spawned()
        self.assertTrue(line.startswith(": rt-blaxel 'list';"))
        self.assertEqual(options["cwd"], "/workspace/app")
        self.assertEqual(options["env"], {"B": "2", core.KEEP: ":B:"})
        self.assertEqual(options["timeout_ms"], core.MAX_PROCESS_MS)
        self.assertEqual((response.name, response.status, response.exit_code, response.stdout, response.logs,
                          response.working_dir, response.command),
                         ("list", ProcessResponseStatus.COMPLETED, 0, "ran " + line + "\n", "ran " + line + "\n",
                          "/blaxel/app", "ls"))
        self.assertRegex(response.started_at, r"^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$")

    def test_a_long_output_is_read_whole_across_pages(self):
        def program(process):
            for index in range(7):
                process.emit("stdout" if index % 2 else "stderr", f"{index}\n")
            process.end(2)
        self.world.program = program
        box = self.create()
        response = box.process.exec({"command": "x", "wait_for_completion": True})
        self.assertEqual((response.stdout, response.stderr, response.logs), ("1\n3\n5\n", "0\n2\n4\n6\n",
                                                                             "0\n1\n2\n3\n4\n5\n6\n"))
        self.assertEqual((response.status, response.exit_code), (ProcessResponseStatus.FAILED, 2))
        self.assertTrue(response.name)

    def test_log_callbacks_get_lines(self):
        def program(process):
            process.emit("stdout", "a\nb")
            process.emit("stdout", "c\n")
            process.emit("stderr", "e")
            process.end(0)
        self.world.program = program
        box = self.create()
        seen = {"log": [], "out": [], "err": []}
        response = box.process.exec({"command": "x", "wait_for_completion": True, "on_log": seen["log"].append,
                                     "on_stdout": seen["out"].append, "on_stderr": seen["err"].append})
        self.assertEqual(seen, {"log": ["a", "bc", "e"], "out": ["a", "bc"], "err": ["e"]})
        response.close()
        self.assertEqual(response.stdout, "a\nbc\n")

    def test_a_wait_past_timeout_raises_and_leaves_it_running(self):
        self.keep_running()
        box = self.create()
        started = time.monotonic()
        with self.assertRaises(ResponseError) as caught:
            box.process.exec({"command": "sleep 99", "name": "slow", "wait_for_completion": True, "timeout": 1})
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(str(caught.exception), "Sandbox request failed with status 422: process timed out after 1 seconds")
        self.assertEqual(self.world.called("request")[-1][0], "GET")
        self.assertEqual(box.process.get("slow").status, ProcessResponseStatus.RUNNING)

    def test_keep_alive_holds_standby_for_its_time(self):
        self.keep_running()
        box = self.create({"name": "k"})
        box.process.exec({"command": "npm run dev", "name": "dev", "keep_alive": True})
        self.assertTrue(self.spawned()[0].startswith(": rt-blaxel 'dev'; : rt-blaxel-keep; export HOST="))
        self.assertEqual(self.spawned()[1]["timeout_ms"], 600_000)
        update = self.world.called("sandbox.update")[-1][1]
        self.assertEqual((update["idle_pause_seconds"], update["labels"]["blaxel/idlePauseSeconds"]), (600, "60"))
        self.assertEqual(self.world.called("sandbox.extend"), [])
        box.process.exec({"command": "srv", "keep_alive": True, "timeout": 300})
        self.assertEqual(len(self.world.called("sandbox.update")), 1)
        self.runtime(box).info["expiresAt"] = core.iso(time.time() + 100)
        box.process.exec({"command": "worker", "name": "w", "keep_alive": True, "timeout": 0})
        self.assertEqual(self.spawned()[1]["timeout_ms"], core.MAX_PROCESS_MS)
        update = self.world.called("sandbox.update")[-1][1]
        # The idle pause to give back stays the one before any keep_alive.
        self.assertEqual((update["idle_pause_seconds"], update["labels"]["blaxel/idlePauseSeconds"]), (0, "60"))
        self.assertTrue(3490 <= self.world.called("sandbox.extend")[-1][1] <= 3500)

    def test_the_idle_pause_comes_back_when_the_last_keep_alive_process_ends(self):
        self.keep_running()
        box = self.create({"name": "back"})
        box.process.exec({"command": "a", "name": "a", "keep_alive": True})
        box.process.exec({"command": "b", "name": "b", "keep_alive": True})
        box.process.exec({"command": "plain", "name": "plain"})
        runtime = self.runtime(box)
        a, b, plain = runtime.process_list
        a.end(0)
        box.process.wait("a")
        self.assertEqual(runtime.info["idlePauseSeconds"], 600)  # b still runs
        # A fresh client, with nothing of this one's, sees b run and keeps the hold.
        SyncSandboxInstance.get("back")
        self.assertEqual(runtime.info["idlePauseSeconds"], 600)
        # b hits its limit (Runtime kills it); the next fresh client gives the pause back.
        b.end(-9)
        other = SyncSandboxInstance.get("back")
        self.assertEqual(runtime.info["idlePauseSeconds"], 60)
        self.assertNotIn("blaxel/idlePauseSeconds", runtime.info["labels"])
        self.assertEqual(other.process.get("plain").status, ProcessResponseStatus.RUNNING)
        updates = len(self.world.called("sandbox.update"))
        SyncSandboxInstance.get("back")
        self.assertEqual(len(self.world.called("sandbox.update")), updates)

    def test_a_failed_give_back_never_fails_the_callers_call(self):
        self.keep_running()
        box = self.create({"name": "flaky"})
        box.process.exec({"command": "srv", "name": "srv", "keep_alive": True})
        runtime = self.runtime(box)
        runtime.process_list[0].end(0)

        def down(*_, **__):
            raise withruntime.ServiceUnavailableError("Busy.", code="busy", status=503)
        runtime.processes = down
        self.assertEqual(box.process.get("srv").status, ProcessResponseStatus.COMPLETED)
        SyncSandboxInstance.get("flaky")
        self.assertEqual(runtime.info["labels"]["blaxel/idlePauseSeconds"], "60")
        del runtime.processes
        SyncSandboxInstance.get("flaky")
        self.assertEqual(runtime.info["idlePauseSeconds"], 60)

    def test_killing_the_keep_alive_process_gives_the_idle_pause_back(self):
        self.keep_running()
        box = self.create({"name": "kill"})
        box.process.exec({"command": "srv", "name": "srv", "keep_alive": True, "timeout": 0})
        self.assertEqual(self.runtime(box).info["idlePauseSeconds"], 0)
        SyncSandboxInstance.get("kill").process.kill("srv")  # from a fresh client
        self.assertEqual(self.runtime(box).info["idlePauseSeconds"], 60)
        self.assertNotIn("blaxel/idlePauseSeconds", self.runtime(box).info["labels"])

    def test_a_long_wait_keeps_its_lease_moving(self):
        state = {"reads": 0}

        def later(process):
            state["reads"] += 1
            if state["reads"] > 2:
                process.end(0)
        self.keep_running()
        self.world.finish_on_wait = later
        box = self.create()
        self.runtime(box).info["expiresAt"] = core.iso(time.time() + 120)
        box.process.exec({"command": "long", "wait_for_completion": True})
        self.assertEqual(len(self.world.called("sandbox.extend")), 1)
        self.assertTrue(3470 <= self.world.called("sandbox.extend")[0][1] <= 3480)

    def test_restart_on_failure(self):
        def program(process):
            process.emit("stdout", "boom\n\n[Process failed with exit code 1. Attempting restart 1/3...]\nboom\n"
                                   "\n[Process failed with exit code 1. Attempting restart 2/3...]\n")
            process.end(1)
        self.world.program = program
        box = self.create()
        response = box.process.exec({"command": "flaky", "restart_on_failure": True, "max_restarts": 3,
                                     "wait_for_completion": True})
        self.assertIn("[ $__rt_n -ge 3 ]", self.spawned()[0])
        # Blaxel's maxRestarts defaults to 0: restart_on_failure alone restarts nothing.
        box.process.exec({"command": "flaky", "restart_on_failure": True})
        self.assertIn("[ $__rt_n -ge 0 ] && exit $__rt_c;", self.spawned()[0])
        self.assertEqual((response.restart_count, response.restart_on_failure, response.max_restarts), (2, True, 3))

    def test_a_name_resolves_from_a_fresh_client(self):
        box = self.create({"name": "fresh"})
        box.process.exec({"command": "echo one", "name": "job"})
        box.process.exec({"command": "echo two", "name": "job"})
        other = SyncSandboxInstance.get("fresh")
        found = other.process.get("job")
        self.assertEqual((found.pid, found.command, found.name), ("proc0002", "echo two", "job"))
        self.assertEqual(other.process.get("proc0001").name, "job")
        with self.assertRaises(ResponseError) as caught:
            other.process.get("nope")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(len(other.process.list()), 2)
        box.fs.grep("x", "/blaxel")  # a helper command of the adapter's own
        self.runtime(box).process_list.append(type("Helper", (), {"id": "a" * 32, "info": {
            "id": "a" * 32, "state": "exited", "exitCode": 0, "command": "grep -rnIEs -i -- x ."}})())
        self.assertEqual([one.name for one in other.process.list()], ["job", "job"])

    def test_stop_kill_logs_and_stdin(self):
        self.keep_running()
        box = self.create()
        box.process.exec({"command": "cat", "name": "cat", "stdin": True})
        self.assertEqual(self.spawned()[1]["stdin"], "pipe")
        box.process.write_stdin("cat", "hello\n")
        box.process.close_stdin("cat")
        written = self.runtime(box).process_list[0].written
        self.assertEqual(written, [("hello\n", False), (b"", True)])
        self.assertEqual(box.process.logs("cat", "stdout"), "started\n")
        self.assertEqual(box.process.stop("cat").message, "Process stop requested")
        self.assertEqual((box.process.get("cat").status, box.process.get("cat").exit_code),
                         (ProcessResponseStatus.STOPPED, -1))
        box.process.exec({"command": "sleep 9", "name": "s"})
        self.assertEqual(box.process.kill("s").message, "Process kill requested")
        self.assertEqual(box.process.get("s").status, ProcessResponseStatus.KILLED)
        self.assertEqual([call[2] for call in self.world.called("request") if call[0] == "POST"][-1],
                         {"signal": "SIGKILL"})

    def test_wait(self):
        self.keep_running()
        box = self.create()
        box.process.exec({"command": "sleep 9", "name": "w"})
        with self.assertRaises(TimeoutError):
            box.process.wait("w", max_wait=200, interval=50)
        self.world.finish_on_wait = lambda process: process.end(0)
        self.assertEqual(box.process.wait("w").status, ProcessResponseStatus.COMPLETED)
        with self.assertRaises(ValueError):
            box.process.wait("w", max_wait=-5)

    def test_wait_for_ports(self):
        self.keep_running()
        box = self.create()
        box.process.exec({"command": "npm run dev", "wait_for_ports": [3000]})
        argv, options = self.world.called("sandbox.exec")[-1]
        self.assertIn("for h in 0BB8;", argv[-1])
        self.assertEqual(options["timeout_ms"], 65_000)
        with self.assertRaises(ResponseError) as caught:
            box.process.exec({"command": "x", "wait_for_ports": [70000]})
        self.assertEqual(caught.exception.status_code, 400)
        self.world.exec = lambda command, _: Result(1)
        with self.assertRaises(ResponseError) as caught:
            box.process.exec({"command": "npm run dev", "wait_for_ports": [3000], "timeout": 5})
        self.assertEqual(caught.exception.status_code, 422)

    def test_stream_logs(self):
        box = self.create()
        box.process.exec({"command": "x", "name": "s"})
        lines = []
        with box.process.stream_logs("s", {"on_log": lines.append}) as handle:
            handle.wait(5)
        self.assertEqual(lines, ["ran " + self.spawned()[0]])
        running = box.process.exec({"command": "y", "on_log": lines.append})
        running.close()

    def test_a_sandbox_paused_under_a_call_wakes_and_the_call_runs_once(self):
        box = self.create()
        self.world.pause_next_spawn = True
        box.process.exec({"command": "echo once", "wait_for_completion": True})
        self.assertEqual(len(self.world.called("sandbox.wake")), 1)
        self.assertEqual(len(self.runtime(box).process_list), 1)

    def test_requests_as_objects(self):
        box = self.create()
        seen = []
        box.process.exec(bl.ProcessRequestWithLog(command="echo", wait_for_completion=True, on_log=seen.append))
        box.process.exec(bl.ProcessRequest(command="echo"))
        self.assertEqual(len(seen), 1)
        with self.assertRaises(ValueError):
            box.process.exec({"name": "x"})


class Files(Base):
    def test_paths_and_shapes(self):
        box = self.create()
        written = box.fs.write("/blaxel/app/config.json", "{}")
        self.assertEqual((written.message, written.path), ("File created successfully", "/blaxel/app/config.json"))
        box.fs.write("notes.txt", "n")
        box.fs.write("/tmp/t.txt", "t")
        files = self.runtime(box).file_map
        self.assertEqual(sorted(files), ["/tmp/t.txt", "/workspace/app/config.json", "/workspace/notes.txt"])
        self.assertEqual(box.fs.read("/blaxel/notes.txt"), "n")
        listing = box.fs.ls("/blaxel")
        self.assertEqual(([one.path for one in listing.files], [one.path for one in listing.subdirectories]),
                         (["/blaxel/notes.txt"], ["/blaxel/app"]))
        self.assertEqual(listing.files[0].permissions, "644")
        with self.assertRaises(ResponseError) as caught:
            box.fs.ls("/blaxel/notes.txt")
        self.assertEqual(caught.exception.status_code, 404)

    def test_blaxels_path_conventions(self):
        cases = {"/blaxel": "/workspace", "/blaxel/a/": "/workspace/a", "a/b": "/workspace/a/b", "./a": "/workspace/a",
                 ".": "/workspace", "~": "/workspace", "~/x": "/workspace/x", "/tmp/x": "/tmp/x", "/app/x": "/app/x",
                 "/blaxelish": "/blaxelish"}
        for given, expected in cases.items():
            self.assertEqual(core.to_runtime_path(given), expected, given)

    def refuse(self, box, method, paths, code="permission_denied"):
        """The files API refuses ``paths`` as the sandbox user, as Runtime's does
        for a path only root may use; returns the undo."""
        files = type(self.runtime(box).files)
        original = getattr(files, method)

        def refusing(self_, path, *args, **kwargs):
            if path in paths:
                error = withruntime.PermissionDeniedError if code == "permission_denied" else withruntime.NotFoundError
                raise error("The sandbox user may not access this path.", code=code,
                            status=403 if code == "permission_denied" else 404)
            return original(self_, path, *args, **kwargs)
        setattr(files, method, refusing)
        return lambda: setattr(files, method, original)

    def test_a_write_only_root_may_make_goes_through_the_workspace_and_sudo(self):
        box = self.create()
        cases = [("/app/config.json", "file_not_found"),  # outside /workspace, parent missing
                 ("/blaxel/root-owned/x.txt", "permission_denied")]  # inside, a directory a root process made
        for path, code in cases:
            target = core.to_runtime_path(path)
            undo = self.refuse(box, "write", {target}, code)
            try:
                box.fs.write(path, "{}")
            finally:
                undo()
            script, (staging, moved_to) = self.world.called("sandbox.sudo")[-1]
            self.assertEqual(script, 'mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"')
            self.assertTrue(staging.startswith("/workspace/.runtime-blaxel-"))
            self.assertEqual((moved_to, self.runtime(box).file_map[target]), (target, b"{}"))
            self.assertNotIn(staging, self.runtime(box).file_map)
        # A refusal of another kind inside /workspace is the caller's error.
        undo = self.refuse(box, "write", {"/workspace/gone/x"}, "file_not_found")
        try:
            with self.assertRaises(ResponseError):
                box.fs.write("/blaxel/gone/x", "y")
        finally:
            undo()

    def test_a_file_only_root_may_read_is_read_through_a_copy_the_user_owns(self):
        box = self.create()
        box.fs.write("/blaxel/secret", "s3cret")
        undo = self.refuse(box, "read", {"/workspace/secret"})
        undo_download = self.refuse(box, "download", {"/workspace/secret"})
        try:
            self.assertEqual(box.fs.read("/blaxel/secret"), "s3cret")
            with tempfile.TemporaryDirectory() as directory:
                box.fs.download("/blaxel/secret", str(Path(directory, "out")))
                self.assertEqual(Path(directory, "out").read_bytes(), b"s3cret")
        finally:
            undo()
            undo_download()
        copies = self.world.called("sandbox.sudo")
        self.assertEqual(len(copies), 2)
        self.assertEqual(copies[0][0], 'install -m 0600 -o "$SUDO_UID" -g "$SUDO_GID" -- "$1" "$2"')
        self.assertTrue(copies[0][1][1].startswith("/tmp/.runtime-blaxel-"))
        self.assertFalse([path for path in self.runtime(box).file_map if path.startswith("/tmp/")])

    def test_binary_tree_download_rm_mkdir_cp(self):
        box = self.create()
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory, "in.bin")
            local.write_bytes(b"\x00\x01")
            box.fs.write_binary("/blaxel/a.bin", str(local))
            box.fs.write_binary("/blaxel/b.bin", bytearray(b"\x02"))
            self.assertEqual(box.fs.read_binary("/blaxel/a.bin"), b"\x00\x01")
            box.fs.download("/blaxel/a.bin", str(Path(directory, "out.bin")), mode=0o600)
            self.assertEqual(Path(directory, "out.bin").read_bytes(), b"\x00\x01")
            self.assertEqual(Path(directory, "out.bin").stat().st_mode & 0o777, 0o600)
        tree = box.fs.write_tree([{"path": "src/app.py", "content": "print(1)"},
                                  bl.SandboxFilesystemFile("README.md", "#")], "/blaxel/app")
        self.assertEqual([one.name for one in tree.files], ["README.md"])
        self.assertEqual(self.runtime(box).file_map["/workspace/app/src/app.py"], b"print(1)")
        box.fs.rm("/blaxel/b.bin")
        argv = self.world.called("sandbox.exec")[-1][0]
        self.assertEqual((argv[:3], argv[3:]), (["bash", "-c", core.RM], ["rm", "/workspace/b.bin", "0"]))
        self.world.exec = lambda command, _: Result(2)
        with self.assertRaises(ResponseError) as caught:
            box.fs.rm("/blaxel/b.bin")
        self.assertEqual(caught.exception.status_code, 404)
        self.world.exec = lambda command, _: Result(0, "ran\n")
        box.fs.mkdir("/blaxel/uploads", permissions="0700")
        self.assertEqual(self.world.called("sandbox.exec")[-1][0], ["chmod", "0700", "--", "/workspace/uploads"])
        with self.assertRaises(ResponseError):
            box.fs.mkdir("/blaxel/x", permissions="rwx")
        box.fs.cp("/blaxel/a.bin", "/tmp/a.bin")
        self.assertEqual(self.world.called("sandbox.exec")[-1][0][-2:], ["/workspace/a.bin", "/tmp/a.bin"])
        self.assertIn("|| sudo cp -r", self.world.called("sandbox.exec")[-1][0][2])

    def test_rm_as_root_where_needed(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "full").mkdir()
            Path(directory, "full", "f").write_text("x")
            Path(directory, "file").write_text("x")
            run = lambda path, recursive: subprocess.run(  # noqa: E731
                ["bash", "-c", core.RM, "rm", str(Path(directory, path)), recursive], capture_output=True, text=True)
            self.assertEqual((run("file", "0").returncode, run("file", "0").returncode), (0, 2))
            self.assertEqual(run("full", "0").returncode, 4)
            self.assertEqual(run("full", "1").stdout, "Directory\n")

    def test_find_and_grep(self):
        box = self.create()
        self.world.exec = lambda command, _: Result(0, "f src/main.go\nd src\n")
        found = box.fs.find("/blaxel/app", type="file", patterns=["*.go", "*.md"], max_results=1,
                            exclude_dirs=["node_modules"], exclude_hidden=True)
        argv = self.world.called("sandbox.exec")[-1][0]
        self.assertEqual(argv[:4], ["find", "/workspace/app", "-mindepth", "1"])
        self.assertIn("node_modules", argv)
        self.assertEqual([(one.path, one.type_) for one in found.matches], [("src/main.go", "file")])
        self.world.exec = lambda command, _: Result(0, "./src/a.py:3:const agentic = 1\n")
        box.fs.write("/blaxel/app/src/a.py", "x\ny\nconst agentic = 1\nz\n")
        result = box.fs.grep("Agentic", "/blaxel/app", context_lines=1, file_pattern="*.py")
        self.assertIn("-i", self.world.called("sandbox.exec")[-1][0])
        self.assertEqual([(one.path, one.line, one.text, one.column, one.context) for one in result.matches],
                         [("src/a.py", 3, "const agentic = 1", 7, "y\nconst agentic = 1\nz")])

    def test_watch(self):
        box = self.create()
        self.world.watch_events = [{"type": "create", "path": "/workspace/app/new.txt"},
                                   {"type": "write", "path": "/workspace/skip/x"}]
        box.fs.write("/blaxel/app/new.txt", "fresh")
        seen = []
        handle = box.fs.watch("/blaxel/**", seen.append, {"with_content": True, "ignore": ["/blaxel/skip"]})
        deadline = time.monotonic() + 5
        while not seen and time.monotonic() < deadline:
            time.sleep(0.01)
        handle["close"]()
        self.assertEqual([(one.op, one.path, one.name, one.content) for one in seen],
                         [("CREATE", "/blaxel/app", "new.txt", "fresh")])
        self.assertEqual(self.world.called("files.watch")[0], ("/workspace", {"recursive": True}))


class Previews(Base):
    def test_create_get_tokens_delete(self):
        box = self.create({"name": "web"})
        preview = box.previews.create({"metadata": {"name": "app"}, "spec": {"port": 3000, "public": False}})
        self.assertEqual((preview.name, preview.spec.port, preview.spec.public), ("app", 3000, False))
        self.assertTrue(preview.spec.url.startswith("https://3000-"))
        self.assertEqual(self.world.called("previews.create")[-1], (3000, "private"))
        other = SyncSandboxInstance.get("web")
        self.assertEqual(other.previews.get("app").spec.port, 3000)
        self.assertEqual([one.name for one in other.previews.list()], ["app"])
        token = preview.tokens.create(datetime.now(timezone.utc) + timedelta(minutes=10))
        self.assertEqual(token.value, "tok-1")
        self.assertTrue(595 <= self.world.called("previews.get")[-1][1] <= 600)
        with self.assertRaises(NotSupportedError):
            preview.tokens.list()
        with self.assertRaises(NotSupportedError) as caught:
            preview.tokens.delete("t")
        self.assertIn("rotate", caught.exception.alternative)
        again = box.previews.create_if_not_exists({"metadata": {"name": "app"}, "spec": {"port": 3000}})
        self.assertEqual(len(self.world.called("previews.create")), 1)
        self.assertEqual(again.spec.port, 3000)
        box.previews.delete("app")
        self.assertNotIn("blaxel/preview.app", self.runtime(box).info["labels"])
        with self.assertRaises(SandboxAPIError) as caught:
            box.previews.get("app")
        self.assertEqual(caught.exception.status_code, 404)

    def test_what_a_runtime_preview_cannot_do(self):
        box = self.create()
        for field in ("responseHeaders", "customDomain", "ttl"):
            with self.assertRaises(NotSupportedError):
                box.previews.create({"metadata": {"name": "x"}, "spec": {"port": 1, field: {"A": "b"}}})
        self.assertEqual(self.world.called("previews.create"), [])

    def test_fetch_goes_through_a_private_preview_with_its_token(self):
        box = self.create()
        sent = []

        class Pool:
            def __init__(self, origin):
                self.origin = origin

            def send(self, method, target, headers, body, timeout):
                sent.append((self.origin, method, target, headers, body))
                return type("Reply", (), {"status": 200, "headers": {"content-type": "application/json"},
                                          "read": lambda self: b'{"ok": true}'})()

            def close(self):
                return None
        original = _sync_sandbox.http
        _sync_sandbox.http = Pool
        try:
            reply = box.fetch(3000, "health", params={"a": "1"}, json={"x": 1})
            box.fetch(3000, method="POST")
        finally:
            _sync_sandbox.http = original
        self.assertEqual((reply.status_code, reply.json(), reply.is_success), (200, {"ok": True}, True))
        origin, method, target, headers, body = sent[0]
        self.assertTrue(origin.startswith("https://3000-"))
        self.assertEqual((method, target, headers["x-runtime-preview-token"], body), ("GET", "/health?a=1", "tok-1",
                                                                                     b'{"x": 1}'))
        self.assertEqual(len(self.world.called("previews.create")), 1)
        with self.assertRaises(NotSupportedError):
            box.fetch(3000, follow_redirects=True)


class Lifecycle(Base):
    def test_standby_archive_and_status(self):
        box = self.create({"name": "life"})
        self.runtime(box).info.update(state="paused", pausedExpiresAt=core.iso(time.time() + 86_400))
        found = SyncSandboxInstance.get("life")
        self.assertEqual((found.status, found.state), (Status.DEPLOYED, SandboxState.STANDBY))
        self.assertTrue(86_000 < found.expires_in <= 86_400)
        self.runtime(box).info["state"] = "running"
        SyncSandboxInstance.archive("life")
        self.assertEqual(self.world.called("sandbox.pause")[-1], (self.runtime(box).id,))
        archived = SyncSandboxInstance.get("life")
        self.assertEqual((archived.status, archived.state), (Status.ARCHIVED, SandboxState.STANDBY))
        archived.unarchive()
        self.assertEqual((archived.status, archived.state), (Status.DEPLOYED, SandboxState.RUNNING))

    def test_a_lease_that_ends_the_sandbox_is_its_expiry(self):
        box = self.create({"ttl": "20m"})
        self.assertTrue(1100 < box.expires_in <= 1200)

    def test_delete_then_use(self):
        box = self.create({"name": "gone"})
        model = box.delete()
        self.assertEqual(model.status, Status.TERMINATED)
        for call in (lambda: box.process.exec({"command": "ls"}), lambda: box.fs.read("/blaxel/x"),
                     lambda: box.previews.list()):
            with self.assertRaises(SandboxAPIError) as caught:
                call()
            self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(SandboxAPIError):
            SyncSandboxInstance.get("gone")
        self.create({"name": "other"})
        SyncSandboxInstance.delete("other")
        self.assertEqual(len(self.world.called("sandbox.stop")), 2)

    def test_updates(self):
        box = self.create({"name": "u", "labels": {"a": "1"}})
        updated = SyncSandboxInstance.update_metadata("u", bl.SandboxUpdateMetadata(labels={"b": "2"},
                                                                                      display_name="U"))
        self.assertEqual((updated.metadata.labels, updated.metadata.display_name), ({"a": "1", "b": "2"}, "U"))
        SyncSandboxInstance.update_ttl("u", "3d")
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 3)
        self.assertEqual(SyncSandboxInstance.get("u").spec.runtime.ttl, "3d")
        SyncSandboxInstance.update_ttl("u", None)
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 365)
        SyncSandboxInstance.update_lifecycle("u", bl.SandboxLifecycle.from_dict(
            {"expirationPolicies": [{"type": "ttl-idle", "value": "8d"}]}))
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 8)
        SyncSandboxInstance.update_network("u", bl.SandboxUpdateNetwork({"allowedDomains": ["pypi.org"]}))
        self.assertEqual(self.world.called("network.set")[-1][1], {"internet": True, "allow": ["pypi.org"]})
        self.assertEqual(box.wait(), box)

    def test_list_pages(self):
        for name in ("a", "b", "c"):
            self.create({"name": name})
        page = SyncSandboxInstance.list(limit=2)
        self.assertEqual(([one.metadata.name for one in page.data], page.has_more), (["a", "b"], True))
        self.assertEqual([one.metadata.name for one in page.auto_paging_iter()], ["a", "b", "c"])
        with self.assertRaises(NotSupportedError):
            SyncSandboxInstance.list(cursor="abc")

    def test_fork_and_snapshots(self):
        box = self.create({"name": "src", "envs": [{"name": "A", "value": "1"}], "ttl": "5d"})
        result = box.fork("copy", envs=[{"name": "B", "value": "2"}])
        self.assertEqual((result.name, result.type_), ("copy", "sandbox"))
        self.assertEqual(self.world.called("sandbox.fork")[-1][1]["labels"]["blaxel/ttl"], "5d")
        argv, options = self.world.called("sandbox.exec")[-1]
        self.assertIn("cat >> /etc/runtime-blaxel/env", argv[-1])
        self.assertEqual(core.parse_env_file(options["stdin"]), {"B": "2"})
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 5)
        copy = SyncSandboxInstance.get("copy")
        self.assertEqual(copy.metadata.name, "copy")
        snapshot = box.snapshots.create("snap")
        self.assertEqual((snapshot.name, snapshot.status, snapshot.source.name), ("snap", "ready", "src"))
        self.assertEqual([one.name for one in box.snapshots.list()], ["snap"])
        self.assertEqual(box.snapshots.get(snapshot.id).name, "snap")
        with self.assertRaises(NotSupportedError) as caught:
            box.snapshots.restore("snap")
        self.assertIn("fork", caught.exception.alternative)
        box.fork("from-snap", snapshot_id=snapshot.id)
        self.assertEqual(self.last_create()["snapshot"], snapshot.id)
        self.assertEqual(SyncSnapshot.get(snapshot.id).name, "snap")
        self.assertEqual(len(SyncSnapshot.list()), 1)
        SyncSnapshot.get(snapshot.id).fork("from-workspace-snap")
        self.assertEqual(self.last_create()["name"], "from-workspace-snap")
        box.snapshots.delete("snap")
        self.assertEqual(box.snapshots.list(), [])
        with self.assertRaises(SnapshotAPIError) as caught:
            SyncSnapshot.get(snapshot.id)
        self.assertEqual(caught.exception.status_code, 404)
        for kwargs in ({"target_type": "application"}, {"port": 3000}):
            with self.assertRaises(NotSupportedError):
                box.fork("x", **kwargs)


class Interpreter(Base):
    def test_run_code_and_contexts(self):
        interpreter = SyncCodeInterpreter.create({"name": "ci", "envs": [{"name": "K", "value": "v"}]})
        self.assertNotIn("image", self.last_create())
        self.assertEqual(self.world.called("sandbox.retention")[-1][1], 1)
        seen = []
        execution = interpreter.run_code("1 + 1", on_stdout=lambda message: seen.append(message.text))
        self.assertEqual(self.world.called("contexts.create")[0][0]["env"], {"K": "v"})
        self.assertEqual((execution.logs.stdout, seen), (["out 1 + 1\n"], ["out 1 + 1\n"]))
        self.assertEqual((execution.results[0].text, execution.results[0].is_main_result), ("2", True))
        self.assertEqual(execution.execution_count, 1)
        again = SyncCodeInterpreter.get("ci")
        again.run_code("x")
        self.assertEqual(again.withruntime.info["id"], interpreter.withruntime.info["id"])
        context = interpreter.create_code_context(cwd="/blaxel/nb")
        self.assertEqual(self.world.called("contexts.create")[-1][0]["cwd"], "/workspace/nb")
        interpreter.run_code("y", context=context)
        self.assertEqual(self.world.called("interpreter.run")[-1][1]["context"], context.id)
        with self.assertRaises(NotSupportedError):
            interpreter.run_code("z", envs={"A": "1"})
        with self.assertRaises(ValueError):
            interpreter.run_code("z", language="python", context=context)


class Unsupported(Base):
    def test_every_gap_is_importable_and_names_its_alternative(self):
        box = self.create()
        calls = [lambda: box.sessions.create(), lambda: box.codegen.fastapply("a", "b"), lambda: box.system.upgrade(),
                 lambda: box.drives.mount("d", "/d"), lambda: box.schedules.list(),
                 lambda: SyncSandboxInstance.from_session({}), lambda: bl.BlAgent("x"), lambda: bl.bl_model("m"),
                 lambda: bl.settings.region, lambda: bl.SyncVolumeInstance.create({}),
                 lambda: bl.ImageInstance.build(), lambda: bl.verify_webhook_signature("a", "b", "c"),
                 lambda: bl.ApplicationInstance.get("a"), lambda: bl.BlaxelMcpServerTransport()]
        for call in calls:
            with self.assertRaises(NotSupportedError) as caught:
                call()
            self.assertTrue(caught.exception.alternative)
        bl.autoload()
        from withruntime.blaxel.core import SandboxInstance as FromCore
        self.assertIs(FromCore, SandboxInstance)

    def test_runtime_errors_keep_blaxels_classes_and_runtimes_detail(self):
        box = self.create()

        def fail(*_, **__):
            raise withruntime.RateLimitError("Slow down.", code="rate_limited", status=429, hint="Wait.",
                                             request_id="req_9")
        self.runtime(box).spawn = fail
        with self.assertRaises(ResponseError) as caught:
            box.process.exec({"command": "ls"})
        self.assertEqual((caught.exception.status_code, caught.exception.code, caught.exception.hint,
                          caught.exception.request_id, caught.exception.response.status_code),
                         (429, "rate_limited", "Try again in a moment.", "req_9", 429))
        error = core.translate(withruntime.ServiceUnavailableError("Off.", code="fork_unavailable", status=503,
                                                                   hint="Later."))
        self.assertIsInstance(error, NotSupportedError)
        self.assertIsInstance(core.translate(withruntime.NotFoundError("x", status=404)), SandboxAPIError)


class Async(unittest.TestCase):
    def setUp(self) -> None:
        offline()
        self.world = BlaxelWorld()
        bl.use_client(self.world.async_client())

    def tearDown(self) -> None:
        bl.use_client(None)
        os.environ.clear()
        os.environ.update(SAVED)

    def test_the_async_api(self):
        async def scenario():
            box = await SandboxInstance.create({"name": "a", "envs": [{"name": "A", "value": "1"}]})
            lines = []

            async def on_log(line):
                lines.append(line)
            response = await box.process.exec({"command": "echo", "name": "e", "wait_for_completion": True,
                                               "on_log": on_log})
            self.assertEqual(response.status, ProcessResponseStatus.COMPLETED)
            self.assertEqual(len(lines), 1)
            await box.fs.write("/blaxel/x.txt", "x")
            self.assertEqual(await box.fs.read("x.txt"), "x")
            fresh = await SandboxInstance.get("a")
            self.assertEqual((await fresh.process.get("e")).name, "e")
            streamed = []
            async with fresh.process.stream_logs("e", {"on_stdout": streamed.append}) as handle:
                await handle.wait(5)
            self.assertEqual(len(streamed), 1)
            page = await SandboxInstance.list()
            self.assertEqual([one.metadata.name async for one in page.auto_paging_iter()], ["a"])
            preview = await box.previews.create({"metadata": {"name": "p"}, "spec": {"port": 8000}})
            self.assertEqual(preview.spec.port, 8000)
            interpreter = await CodeInterpreter.create({"name": "ci"})
            execution = await interpreter.run_code("1")
            self.assertEqual(execution.results[0].text, "2")
            await SandboxInstance.delete("a")
            with self.assertRaises(SandboxAPIError):
                await SandboxInstance.get("a")
        asyncio.run(scenario())
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)


class ImportPaths(unittest.TestCase):
    # Every path Blaxel's README and docs import from (blaxel-ai/docs at
    # 17fb3bbe, sdk-python README at 8015ae82), with "blaxel." made
    # "withruntime.blaxel.", and a name each imports.
    PATHS = {
        "": "settings", "core": "SandboxInstance", "core.agents": "bl_agent", "core.client": "client",
        "core.client.api.applications.list_application_revisions": "asyncio",
        "core.client.api.compute.get_sandbox": "asyncio", "core.client.api.compute.update_sandbox": "asyncio",
        "core.client.api.functions.create_function": "asyncio", "core.client.api.images": "list_images",
        "core.client.api.workspaces": "create_workspace", "core.client.client": "client",
        "core.client.models": "Env", "core.client.models.create_job_execution_request": "CreateJobExecutionRequest",
        "core.client.models.create_job_execution_request_env": "CreateJobExecutionRequestEnv",
        "core.client.models.env": "Env", "core.client.models.function": "Function",
        "core.client.models.function_runtime": "FunctionRuntime", "core.client.models.function_spec": "FunctionSpec",
        "core.client.models.metadata": "Metadata", "core.client.models.workspace": "Workspace",
        "core.client.types": "Unset", "core.common": "autoload", "core.drive": "DriveInstance", "core.jobs": "bl_job",
        "core.sandbox": "SandboxInstance", "core.sandbox.types": "SandboxUpdateNetwork", "crewai": "bl_tools",
        "googleadk": "bl_tools", "langgraph": "bl_model", "livekit": "bl_tools", "llamaindex": "bl_tools",
        "openai": "bl_tools", "pydantic": "bl_model", "telemetry": None,
    }

    def test_every_path_blaxels_docs_import_from(self):
        import importlib
        for path, name in self.PATHS.items():
            module = importlib.import_module("withruntime.blaxel" + (f".{path}" if path else ""))
            if name is not None:
                self.assertTrue(hasattr(module, name), f"{path}.{name}")

    def test_the_real_classes_come_through_and_the_rest_names_an_alternative(self):
        from withruntime.blaxel.core.client.models.env import Env
        from withruntime.blaxel.core.sandbox import SandboxInstance as FromSandbox
        self.assertIs(Env, bl.Env)
        self.assertIs(FromSandbox, SandboxInstance)
        from withruntime.blaxel.core.client.api.compute.update_sandbox import asyncio as update_sandbox
        from withruntime.blaxel.langgraph import bl_model
        for refused in (lambda: update_sandbox("s"), lambda: bl_model("m")):
            with self.assertRaises(NotSupportedError) as caught:
                refused()
            self.assertTrue(caught.exception.alternative)


class Generated(unittest.TestCase):
    def test_the_sync_adapter_is_generated_from_the_async_one(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "generate_dropin_sync.py"), "--check"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
