"""The Modal drop-in's whole pinned surface: what it serves on Runtime, and what
it refuses before any request (modal 1.6.0, compat-inventory.json)."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import e2b_fake  # noqa: E402
from dropin_fake import DropInImages, DropInSandbox, DropInVolumes  # noqa: E402
from e2b_fake import FakePreviews, Result, not_found  # noqa: E402
from test_compat_new_providers import Base  # noqa: E402
import withruntime  # noqa: E402
from withruntime._compat import ENV_PATH, CompatibilityError  # noqa: E402
import withruntime.modal as modal  # noqa: E402
from withruntime.modal import (App, CloudBucketMount, FilePatternMatcher, Image, Probe, Proxy, Sandbox,  # noqa: E402
                               SandboxSnapshot, Secret, Tunnel, Volume)
from withruntime.modal import exception  # noqa: E402
from withruntime.modal.exception import (ClientClosed, ConflictError, ImageBuildError, InvalidError,  # noqa: E402
                                         NotFoundError, TimeoutError as ModalTimeout)


class FakeMounts:
    def __init__(self, world, sandbox):
        self._w, self._s = world, sandbox

    def add(self, **fields):
        self._w.record("mounts.add", self._s.id, fields)
        return fields


e2b_fake._WRAPPED = e2b_fake._WRAPPED + (FakeMounts,)


class World(Base):
    def setUp(self):
        super().setUp()
        world = self.world
        world.build_error = None
        shared = {}

        def build(images, on_log=None, **fields):
            staged = {}
            if fields.get("context_dir"):
                root = fields["context_dir"]
                for folder, _, files in os.walk(root):
                    for name in files:
                        full = os.path.join(folder, name)
                        staged[os.path.relpath(full, root)] = Path(full).read_bytes()
            world.record("images.staged", staged)
            if world.build_error:
                raise world.build_error
            return original_build(images, **fields)
        original_build = DropInImages.build

        def resolve(images, ref):
            world.record("images.resolve", ref)
            for image in world.images:
                if ref in (image["id"], image.get("name")):
                    return image
            raise not_found("image_not_found", f"No image is named {ref}.")

        def volume_get(volumes, volume_id):
            world.record("volumes.get", volume_id)
            for volume in world.volumes:
                if volume["id"] == volume_id:
                    return volume
            raise not_found("volume_not_found", "No such volume.")

        def preview(previews, port, **options):
            world.record("previews.create", port, options)
            shared.setdefault(previews._s.id, []).append({"port": port, "visibility": options.get("visibility", "private"),
                                                          "url": f"https://{port}-{previews._s.id[-4:]}.runtimehost.com/"})
            return shared[previews._s.id][-1]

        def previews_list(previews):
            world.record("previews.list", previews._s.id)
            return list(shared.get(previews._s.id, []))

        async def iterate(page):
            # As AsyncPage: records stay dicts; only SDK objects are async.
            for item in page._target._items:
                yield e2b_fake.Asyncified(item) if isinstance(item, e2b_fake._WRAPPED) else item

        for obj, name, method in ((e2b_fake.Asyncified, "__aiter__", iterate),
                                  (DropInImages, "build", build), (DropInImages, "resolve", resolve),
                                  (DropInVolumes, "get", volume_get), (FakePreviews, "create", preview),
                                  (FakePreviews, "list", previews_list),
                                  (DropInSandbox, "mounts", property(lambda sb: FakeMounts(sb._w, sb)))):
            patcher = patch.object(obj, name, method, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def requests(self):
        return [call for call in self.world.calls if call[0] != "images.staged"]


# Errors and patterns --------------------------------------------------------------------------


class Errors(unittest.TestCase):
    def test_hierarchy_matches_modal(self):
        self.assertTrue(issubclass(ConflictError, InvalidError))
        self.assertTrue(issubclass(exception.SandboxTimeoutError, ModalTimeout))
        self.assertTrue(issubclass(ImageBuildError, exception.RemoteError))
        for name in ("ClientClosed", "InternalFailure", "ResourceExhaustedError", "SnapshotCreationError",
                     "ExecTimeoutError", "AuthError", "PermissionDeniedError"):
            self.assertTrue(issubclass(getattr(exception, name), modal.Error), name)
        self.assertEqual(ImageBuildError("failed", "im-1").image_id, "im-1")


class Patterns(unittest.TestCase):
    def test_docker_rules_inversion_and_files(self):
        matcher = FilePatternMatcher("**/*.py", "!keep/**", "build")
        self.assertTrue(matcher(Path("a/b/c.py")))
        self.assertTrue(matcher(Path("build/out.bin")))
        self.assertFalse(matcher(Path("readme.md")))
        self.assertFalse(matcher.can_prune_directories())
        self.assertTrue((~FilePatternMatcher("*.md"))(Path("x.py")))
        self.assertTrue(FilePatternMatcher("*.md").can_prune_directories())
        self.assertEqual([str(p) for p in matcher.patterns], ["**/*.py", "keep/**", "build"])
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "ignore").write_text("*.log\n\n")
            loaded = FilePatternMatcher.from_file(Path(folder, "ignore"))
            self.assertTrue(loaded(Path("x.log")))
            self.assertFalse(loaded(Path("x.txt")))
        with self.assertRaises(ValueError):
            FilePatternMatcher("!")(Path("x"))


# Images ----------------------------------------------------------------------------------------


class Images(World):
    def build(self, image, **options):
        Sandbox.create(image=image, client=self.client, **options)
        return self.world.called("images.build")[-1][0], self.world.called("images.staged")[-1][0]

    def test_pip_flags_env_and_force_build(self):
        image = Image.debian_slim(force_build=True).pip_install(
            "b", ["a"], index_url="https://pypi.example/simple", extra_index_url="https://x", find_links="/w",
            pre=True, extra_options="--no-deps", env={"TOKEN": "a b", "UNSET": None})
        fields, _ = self.build(image)
        self.assertIn("RUN export TOKEN='a b' && python -m pip install --find-links /w --index-url "
                      "https://pypi.example/simple --extra-index-url https://x --pre --no-deps -- a b", fields["dockerfile"])
        self.assertIs(fields["cache"], False)
        self.assertNotIn("TOKEN", fields["dockerfile"].split("RUN")[0])

    def test_step_values_are_checked(self):
        with self.assertRaises(InvalidError):
            Image.debian_slim().pip_install("--index-url=evil")
        with self.assertRaises(InvalidError):
            Image.debian_slim().pip_install("x", extra_options="--a\nRUN evil")
        with self.assertRaises(ValueError):
            Image.debian_slim().workdir("/a\nRUN evil")
        with self.assertRaises(InvalidError):
            Image.debian_slim().uv_pip_install("x", uv_version="1; rm -rf /")
        with self.assertRaises(InvalidError):
            Image.debian_slim("three")
        with self.assertRaises(InvalidError):
            Image.debian_slim().apt_install(["git", 3])

    def test_metadata_lines(self):
        image = (Image.debian_slim().env(vars={"A": "1"}).workdir("/app").cmd(["python", "-m", "http.server"])
                 .entrypoint(["/bin/tini", "--"]).shell(["/bin/bash", "-c"]))
        text = image._dockerfile
        for line in ('ENV A="1"', "WORKDIR /app", 'CMD ["python", "-m", "http.server"]',
                     'ENTRYPOINT ["/bin/tini", "--"]', 'SHELL ["/bin/bash", "-c"]'):
            self.assertIn(line, text)
        self.assertIs(Image.debian_slim().pipe(lambda image, tag: image.run_commands(f"echo {tag}"), "x")._dockerfile.endswith(
            "RUN echo x\n"), True)

    def test_registry_setup_and_micromamba(self):
        image = Image.from_registry("ubuntu:24.04", setup_dockerfile_commands=["RUN apt-get update"], force_build=True)
        self.assertEqual(image._dockerfile, "FROM ubuntu:24.04\nRUN apt-get update\n")
        self.assertTrue(image.force_build)
        mamba = Image.micromamba("3.11").micromamba_install("numpy", channels=["conda-forge"])
        self.assertIn("RUN micromamba install -n base -y python=3.11 pip -c conda-forge", mamba._dockerfile)
        self.assertIn("RUN micromamba install numpy -c conda-forge --yes", mamba._dockerfile)
        self.assertIs(mamba.micromamba_install(), mamba)
        with tempfile.TemporaryDirectory() as folder:
            spec = Path(folder, "env.yml")
            spec.write_text("dependencies: [numpy]\n")
            fields, staged = self.build(Image.micromamba().micromamba_install(spec_file=str(spec)))
        self.assertIn("COPY .modal/0/env.yml /env.yml", fields["dockerfile"])
        self.assertIn("-f /env.yml -n base", fields["dockerfile"])
        self.assertEqual(staged[".modal/0/env.yml"], b"dependencies: [numpy]\n")

    def test_requirement_files_uv_and_poetry(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "requirements.txt").write_text("requests\n")
            Path(folder, "dev.txt").write_text("pytest\n")
            Path(folder, "pyproject.toml").write_text('[project]\nname = "x"\ndependencies = ["httpx"]\n')
            image = (Image.debian_slim()
                     .pip_install_from_requirements(str(Path(folder, "requirements.txt")), index_url="https://i")
                     .uv_pip_install("rich", requirements=[str(Path(folder, "dev.txt"))], uv_version="0.8.4", pre=True))
            fields, staged = self.build(image)
            self.assertIn("COPY .modal/0/requirements.txt /.requirements.txt", fields["dockerfile"])
            self.assertIn("RUN python -m pip install -r /.requirements.txt --index-url https://i", fields["dockerfile"])
            self.assertIn("COPY --from=ghcr.io/astral-sh/uv:0.8.4 /uv /.uv/uv", fields["dockerfile"])
            self.assertIn("COPY .modal/1/0_dev.txt /.uv/0/dev.txt", fields["dockerfile"])
            self.assertIn("/.uv/uv pip install --python $(command -v python) --compile-bytecode --prerelease allow "
                          "--requirements /.uv/0/dev.txt rich", fields["dockerfile"])
            self.assertEqual(staged[".modal/1/0_dev.txt"], b"pytest\n")
            with self.assertRaises(NotFoundError):
                Image.debian_slim().poetry_install_from_file(str(Path(folder, "pyproject.toml")))
            poetry = Image.debian_slim().poetry_install_from_file(str(Path(folder, "pyproject.toml")), ignore_lockfile=True,
                                                                  with_=["dev"], poetry_version="1.8.3")
            self.assertIn("RUN python -m pip install poetry==1.8.3", poetry._dockerfile)
            self.assertIn("poetry install --no-root --with dev --compile", poetry._dockerfile)
            Path(folder, "uv.lock").write_text("lock")
            synced = Image.debian_slim().uv_sync(folder, groups=["dev"], extras=["cli"])
            self.assertIn("/.uv/uv sync --project=/.uv --no-install-workspace --compile-bytecode --group=dev "
                          "--extra=cli --frozen", synced._dockerfile)
            self.assertIn("ENV PATH=/.uv/.venv/bin:$PATH", synced._dockerfile)
            with self.assertRaises(InvalidError):
                Image.debian_slim().uv_sync(os.path.join(folder, "missing"))
            with self.assertRaises(InvalidError):
                Image.debian_slim().uv_sync(folder, groups="dev")
            try:
                import tomllib  # noqa: F401
            except ImportError:
                return
            Path(folder, "pyproject.toml").write_text(
                '[project]\nname = "x"\ndependencies = ["httpx"]\n[project.optional-dependencies]\ntest = ["pytest"]\n')
            from_project = Image.debian_slim().pip_install_from_pyproject(str(Path(folder, "pyproject.toml")), ["test"])
            self.assertIn("python -m pip install -- httpx pytest", from_project._dockerfile)
            Path(folder, "pyproject.toml").write_text('[tool.uv.workspace]\nmembers = []\n')
            with self.assertRaises(InvalidError):
                Image.debian_slim().uv_sync(folder)
            with self.assertRaises(ValueError):
                Image.debian_slim().pip_install_from_pyproject(str(Path(folder, "pyproject.toml")))

    def test_local_files_need_copy_and_are_staged(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "a.txt").write_text("A")
            Path(folder, "skip.log").write_text("no")
            Path(folder, "sub").mkdir()
            Path(folder, "sub", "b.txt").write_text("B")
            for call in (lambda: Image.debian_slim().add_local_file(str(Path(folder, "a.txt")), "/x"),
                         lambda: Image.debian_slim().add_local_dir(folder, "/data"),
                         lambda: Image.debian_slim().add_local_python_source("json")):
                with self.assertRaisesRegex(CompatibilityError, "copy=True"):
                    call()
            with self.assertRaises(InvalidError):
                Image.debian_slim().add_local_file(str(Path(folder, "a.txt")), "relative", copy=True)
            image = (Image.debian_slim().add_local_file(str(Path(folder, "a.txt")), "/etc/", copy=True)
                     .add_local_dir(folder, "/data", copy=True, ignore=["*.log"]))
            fields, staged = self.build(image)
        self.assertIn("COPY .modal/0/a.txt /etc/a.txt", fields["dockerfile"])
        self.assertIn("COPY .modal/1/ /data/", fields["dockerfile"])
        self.assertEqual(staged, {".modal/0/a.txt": b"A", ".modal/1/a.txt": b"A", ".modal/1/sub/b.txt": b"B"})
        self.assertEqual(fields["dockerignore"], "")

    def test_links_out_of_a_local_folder_are_refused_before_any_read(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as folder:
            Path(outside, "id_rsa").write_text("secret")
            Path(folder, "a.txt").write_text("A")
            Path(folder, "inside.txt").symlink_to(Path(folder, "a.txt"))
            Path(folder, "key").symlink_to(Path(outside, "id_rsa"))
            Path(folder, "Dockerfile").write_text("FROM python:3.13\nCOPY . /app\n")
            with self.assertRaisesRegex(InvalidError, "outside"):
                Image.debian_slim().add_local_dir(folder, "/data", copy=True)
            with self.assertRaisesRegex(InvalidError, "outside"):
                Image.from_dockerfile(str(Path(folder, "Dockerfile")), context_dir=folder)
            image = Image.debian_slim().add_local_dir(folder, "/data", copy=True, ignore=["key"])
            fields, staged = self.build(image)
        self.assertEqual(staged, {".modal/0/Dockerfile": b"FROM python:3.13\nCOPY . /app\n", ".modal/0/a.txt": b"A",
                                  ".modal/0/inside.txt": b"A"})

    def test_python_source_copies_only_python_files(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder, "modal_dropin_pkg")
            (package / "__pycache__").mkdir(parents=True)
            (package / "__init__.py").write_text("X = 1\n")
            (package / "data.json").write_text("{}")
            (package / "__pycache__" / "x.pyc").write_bytes(b"\0")
            sys.path.insert(0, folder)
            self.addCleanup(sys.path.remove, folder)
            fields, staged = self.build(Image.debian_slim().add_local_python_source("modal_dropin_pkg", copy=True))
        self.assertIn("COPY .modal/0/ /root/modal_dropin_pkg/", fields["dockerfile"])
        self.assertEqual(staged, {".modal/0/__init__.py": b"X = 1\n"})
        with self.assertRaises(InvalidError):
            Image.debian_slim().add_local_python_source(3, copy=True)

    def test_dockerfile_commands_context_and_dockerfile(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "app.py").write_text("print(1)")
            Path(folder, "secret.env").write_text("x")
            Path(folder, ".dockerignore").write_text("*.env\n")
            Path(folder, "extra.cfg").write_text("cfg")
            image = Image.debian_slim().dockerfile_commands(
                ["COPY . /app", "RUN ls /app"], context_dir=folder, env={"MODE": "x"}, build_args={"V": "1"},
                context_files={"/cfg/extra.cfg": str(Path(folder, "extra.cfg"))})
            fields, staged = self.build(image)
            self.assertIn("RUN export MODE=x && ls /app", fields["dockerfile"])
            self.assertEqual(fields["build_args"], {"V": "1"})
            self.assertIn("app.py", staged)
            self.assertNotIn("secret.env", staged)
            self.assertEqual(staged["cfg/extra.cfg"], b"cfg")
            with self.assertRaises(CompatibilityError):
                image.dockerfile_commands("ARG V", build_args={"V": "2"})
            with self.assertRaises(CompatibilityError):
                Image.debian_slim().dockerfile_commands('RUN ["ls"]', env={"A": "b"})
            with self.assertRaises(InvalidError):
                Image.debian_slim().dockerfile_commands("COPY ../x /x", context_dir=folder)
            Path(folder, "Dockerfile").write_text("FROM python:3.12\nCOPY app.py /app.py\nRUN python /app.py\n")
            fields, staged = self.build(Image.from_dockerfile(str(Path(folder, "Dockerfile")), context_dir=folder))
            self.assertTrue(fields["dockerfile"].startswith("FROM python:3.12\nCOPY app.py /app.py\n"))
            self.assertEqual(set(staged), {"app.py"})

    def test_named_images_hydrate_and_cannot_be_extended(self):
        self.world.images.append({"id": "00000000-0000-4000-8000-000000000999", "name": "base", "state": "ready"})
        named = Image.from_name("base", client=self.client)
        with self.assertRaises(CompatibilityError):
            named.pip_install("x")
        box = Sandbox.create(image=named, client=self.client)
        self.assertEqual(self.created()["image"], "00000000-0000-4000-8000-000000000999")
        self.assertEqual(named.object_id, "00000000-0000-4000-8000-000000000999")
        self.assertEqual(named.get_dashboard_url(), "https://withruntime.com/account/images/00000000-0000-4000-8000-000000000999")
        self.assertIsNotNone(box)
        with self.assertRaises(NotFoundError):
            Image.from_id("missing").hydrate(self.client)
        with self.assertRaises(CompatibilityError):
            Image.from_name("x", environment_name="prod")

    def test_build_and_hydrate_build_once(self):
        image = Image.debian_slim()
        with self.assertRaises(AttributeError):
            image.object_id
        with patch("withruntime.Runtime", lambda: self.client):
            self.assertIs(image.build(App("a")), image)
        self.assertIs(image.client, self.client)
        built = image.object_id
        image.hydrate(self.client)
        Sandbox.create(image=image, client=self.client)
        self.assertEqual(len(self.world.called("images.build")), 1)
        self.assertEqual(self.created()["image"], built)
        image2 = Image.debian_slim().apt_install("curl")
        asyncio.run(image2.hydrate.aio(self.world.async_client()))
        self.assertIsNotNone(image2.object_id)

    def test_build_failure_is_image_build_error(self):
        self.world.build_error = withruntime.RuntimeError("Image im-7 failed: exit 1", code="image_build_failed")
        with self.assertRaises(ImageBuildError) as caught:
            Sandbox.create(image=Image.debian_slim().run_commands("false"), client=self.client)
        self.assertEqual(caught.exception.image_id, "im-7")
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_imports_records_failures(self):
        image = Image.debian_slim()
        with image.imports():
            import modal_dropin_not_installed  # noqa: F401
        self.assertIsInstance(image.inside_exceptions[0], ImportError)

    def test_refusals_before_any_request(self):
        base = Image.debian_slim()
        calls = [
            lambda: Image.from_registry("ubuntu", secret=Secret.from_dict({})),
            lambda: Image.from_registry("ubuntu", add_python="3.12"),
            lambda: Image.from_registry("ubuntu", platform="arm64"),
            lambda: Image.from_aws_ecr("x"), lambda: Image.from_gcp_artifact_registry("x"),
            lambda: Image.from_scratch(), lambda: base.publish("x"), lambda: base.run_function(print),
            lambda: base.pip_install_private_repos("github.com/a/b", git_user="me"),
            lambda: base.run_commands("ls", volumes={"/v": Volume.from_name("v")}),
            lambda: Image.from_dockerfile("Dockerfile", add_python="3.12"),
            lambda: base.logs,
        ]
        for method in ("apt_install", "pip_install", "uv_pip_install", "micromamba_install", "run_commands",
                       "dockerfile_commands"):
            calls.append(lambda method=method: getattr(base, method)("x", gpu="T4"))
            calls.append(lambda method=method: getattr(base, method)("x", secrets=[Secret.from_dict({"A": "b"})]))
        for path_method in ("pip_install_from_requirements", "pip_install_from_pyproject", "poetry_install_from_file",
                            "uv_sync"):
            calls.append(lambda m=path_method: getattr(base, m)("x", gpu="T4"))
        for call in calls:
            with self.assertRaises(CompatibilityError):
                call()
        with self.assertRaises(CompatibilityError):
            asyncio.run(base.publish.aio("x"))
        self.assertEqual(self.requests(), [])


# Secrets ---------------------------------------------------------------------------------------


class Secrets(World):
    def test_from_dict_local_environ_and_dotenv_reach_the_env_file(self):
        with self.assertRaises(InvalidError):
            Secret.from_dict({"A": 1})
        with self.assertRaises(InvalidError):
            Secret.from_dict(["A"])
        with patch.dict(os.environ, {"LOCAL_A": "1"}):
            local = Secret.from_local_environ(["LOCAL_A"])
            with self.assertRaises(InvalidError):
                Secret.from_local_environ(["LOCAL_MISSING_X"])
        dotenv = types.ModuleType("dotenv")
        seen = []
        dotenv.find_dotenv = lambda filename, usecwd=False: seen.append(("find", filename)) or "/cwd/.env"
        dotenv.dotenv_values = lambda path: seen.append(("read", path)) or {"FROM_FILE": "v", "EMPTY": None}
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "custom.env").write_text("")
            Path(folder, "sub").mkdir()
            with patch.dict(sys.modules, {"dotenv": dotenv}):
                lazy = Secret.from_dotenv()
                self.assertEqual(seen, [])
                box = Sandbox.create(secrets=[Secret.from_dict({"A": "x", "B": None}), local, lazy], client=self.client)
                walked = Secret.from_dotenv(Path(folder, "sub"), filename="custom.env").hydrate(self.client)
                self.assertEqual(walked._values, {"FROM_FILE": "v", "EMPTY": ""})
        self.assertEqual(seen[0], ("find", ".env"))
        self.assertEqual(seen[-1], ("read", os.path.join(folder, "custom.env")))
        written = json.loads(self.world.sandboxes[box.object_id].files.read(ENV_PATH))
        self.assertEqual(written, {"A": "x", "LOCAL_A": "1", "FROM_FILE": "v", "EMPTY": ""})
        with patch.dict(sys.modules, {"dotenv": None}):
            with self.assertRaises(ImportError):
                Secret.from_dotenv().hydrate(self.client)

    def test_named_secrets_are_refused(self):
        secret = Secret.from_dict({"A": "b"})
        for call in (lambda: Secret.from_name("x"), lambda: secret.info(), lambda: secret.update({"A": "c"}),
                     lambda: Secret.objects, lambda: secret.object_id, lambda: secret.get_dashboard_url()):
            with self.assertRaises(CompatibilityError):
                call()
        with self.assertRaises(CompatibilityError):
            Secret.from_name.aio("x")
        self.assertIsNone(secret.name)
        self.assertEqual(self.requests(), [])


# Volumes and buckets ---------------------------------------------------------------------------


class Volumes(World):
    def test_named_volume_mounts_and_read_only_copy(self):
        self.world.volumes.append({"id": "vol-1", "name": "data", "state": "ready"})
        volume = Volume.from_name("data")
        self.assertEqual(volume.name, "data")
        box = Sandbox.create(volumes={"/data": volume, Path("/ro"): volume.read_only()}, client=self.client)
        self.assertEqual(self.created()["volumes"], [{"volume_id": "vol-1", "path": "/data"},
                                                     {"volume_id": "vol-1", "path": "/ro", "mode": "snapshot"}])
        self.assertEqual(volume.object_id, "vol-1")
        with self.assertRaises(CompatibilityError):
            box.reload_volumes()
        writable = Sandbox.create(volumes={"/data": Volume.from_name("data")}, client=self.client)
        self.assertIsNone(writable.reload_volumes())
        with self.assertRaises(InvalidError):
            writable.reload_volumes(timeout=0)
        self.assertTrue(Volume.from_name("data").with_mount_options(read_only=True)._read_only)

    def test_missing_volumes_fail_before_the_sandbox(self):
        with self.assertRaises(NotFoundError):
            Sandbox.create(volumes={"/data": Volume.from_name("gone")}, client=self.client)
        with self.assertRaisesRegex(CompatibilityError, "fixed size"):
            Sandbox.create(volumes={"/data": Volume.from_name("gone", create_if_missing=True)}, client=self.client)
        with self.assertRaises(NotFoundError):
            Volume.from_id("vol-x").hydrate(self.client)
        with self.assertRaises(InvalidError):
            Sandbox.create(volumes={"relative": Volume.from_name("x")}, client=self.client)
        self.assertEqual(self.world.called("sandboxes.create"), [])

    def test_async_volume_lookup(self):
        self.world.volumes.append({"id": "vol-2", "name": "async", "state": "ready"})

        async def run():
            client = self.world.async_client()
            box = await Sandbox.create.aio(volumes={"/v": Volume.from_name("async")}, client=client)
            self.assertIsNone(await box.reload_volumes.aio())
            self.assertEqual((await Volume.from_id("vol-2").hydrate.aio(client)).object_id, "vol-2")
        asyncio.run(run())
        self.assertEqual(self.created()["volumes"], [{"volume_id": "vol-2", "path": "/v"}])

    def test_volume_refusals(self):
        volume = Volume.from_name("v")
        calls = [lambda: Volume.from_name("v", version=2), lambda: Volume.from_name("v", create_options={}),
                 lambda: Volume.from_name("v", environment_name="e"), lambda: Volume.ephemeral(),
                 lambda: Volume.rename("a", "b"), lambda: Volume.objects, lambda: volume.with_mount_options(sub_path="/a"),
                 lambda: volume.get_dashboard_url()]
        for name, args in (("info", ()), ("commit", ()), ("reload", ()), ("iterdir", ("/",)), ("listdir", ("/",)),
                           ("read_file", ("/a",)), ("read_file_into_fileobj", ("/a", None)), ("remove_file", ("/a",)),
                           ("copy_files", (["/a"], "/b")), ("batch_upload", ())):
            calls.append(lambda name=name, args=args: getattr(volume, name)(*args))
            calls.append(lambda name=name, args=args: getattr(volume, name).aio(*args))
        for call in calls:
            with self.assertRaises(CompatibilityError):
                call()
        self.assertEqual(self.requests(), [])

    def test_bucket_mounts(self):
        box = Sandbox.create(volumes={
            "/s3": CloudBucketMount("public", key_prefix="data/", read_only=True),
            "/gcs": CloudBucketMount("g", bucket_endpoint_url="https://storage.googleapis.com"),
            "/r2": CloudBucketMount("r", bucket_endpoint_url="https://acct123.r2.cloudflarestorage.com"),
            "/minio": CloudBucketMount("m", bucket_endpoint_url="https://minio.example.com")}, client=self.client)
        added = {fields["path"]: fields for _, fields in self.world.called("mounts.add")}
        self.assertEqual(added["/s3"], {"provider": "s3", "bucket": "public", "path": "/s3", "prefix": "data/",
                                        "read_only": True})
        self.assertEqual(added["/gcs"]["provider"], "gcs")
        self.assertEqual(added["/r2"], {"provider": "r2", "account_id": "acct123", "bucket": "r", "path": "/r2"})
        self.assertEqual(added["/minio"]["endpoint"], "https://minio.example.com")
        self.assertIsNotNone(box)
        mount = CloudBucketMount("b", key_prefix="p/", read_only=True)
        self.assertEqual((mount.bucket_name, mount.key_prefix, mount.read_only, mount.bucket_endpoint_url),
                         ("b", "p/", True, None))
        with self.assertRaises(ValueError):
            CloudBucketMount("b", key_prefix="no-slash")
        for options in ({"secret": Secret.from_dict({})}, {"oidc_auth_role_arn": "arn"}, {"requester_pays": True},
                        {"force_path_style": True}):
            with self.assertRaises(CompatibilityError):
                CloudBucketMount("b", **options)
        for name in ("secret", "oidc_auth_role_arn", "requester_pays", "force_path_style"):
            with self.assertRaises(CompatibilityError):
                getattr(mount, name)

    def test_failed_bucket_mount_stops_the_sandbox(self):
        with patch.object(FakeMounts, "add", side_effect=withruntime.InvalidRequestError("bad", code="bad", status=400)):
            with self.assertRaises(withruntime.InvalidRequestError):
                Sandbox.create(volumes={"/b": CloudBucketMount("b")}, client=self.client)
        self.assertEqual(len(self.world.called("sandbox.stop")), 1)


# Sandboxes -------------------------------------------------------------------------------------


class Sandboxes(World):
    def test_create_refusals_before_any_request(self):
        refused = {"network_file_systems": {"/n": object()}, "idle_timeout": 60, "cloud": "aws", "region": "us-east",
                   "h2_ports": [8000], "unencrypted_ports": [22], "custom_domain": "x.example.com", "proxy": object(),
                   "include_oidc_identity_token": True, "verbose": True, "experimental_options": {"a": 1},
                   "_experimental_enable_snapshot": True, "_experimental_outbound_policy": object(),
                   "inbound_cidr_allowlist": ["1.2.3.4/32"], "outbound_cidr_allowlist": ["10.0.0.0/8"],
                   "cidr_allowlist": ["10.0.0.0/8"], "pty_info": object(), "environment_name": "prod",
                   "runtime": "gvisor"}
        for name, value in refused.items():
            with self.assertRaises(CompatibilityError, msg=name):
                Sandbox.create(client=self.client, **{name: value})
            with self.assertRaises(CompatibilityError, msg=name):
                asyncio.run(Sandbox.create.aio(client=self.world.async_client(), **{name: value}))
        with self.assertRaises(InvalidError):
            Sandbox.create(runtime="kata", client=self.client)
        with self.assertRaises(InvalidError):
            Sandbox.create(encrypted_ports=[0], client=self.client)
        with self.assertRaises(InvalidError):
            Sandbox.create(readiness_probe="tcp", client=self.client)
        with self.assertRaises(InvalidError):
            Sandbox.create("echo", 3, client=self.client)
        self.assertEqual(self.requests(), [])
        Sandbox.create(runtime="vm", client=self.client)

    def test_network_rules_are_never_wider_than_modals(self):
        cases = [({}, {"internet": True}), ({"block_network": True}, {"internet": False}),
                 # An empty list blocks all egress; native rules read an empty allow list as the public web.
                 ({"outbound_domain_allowlist": []}, {"internet": False}),
                 ({"outbound_domain_allowlist": ["*"]}, {"internet": True}),
                 ({"outbound_domain_allowlist": ["pypi.org"]}, {"internet": True, "allow": ["pypi.org"]})]
        for options, network in cases:
            Sandbox.create(client=self.client, **options)
            self.assertEqual(self.world.called("sandboxes.create")[-1][0]["network"], network, msg=options)
        made = len(self.world.called("sandboxes.create"))
        with self.assertRaises(InvalidError):
            Sandbox.create(block_network=True, outbound_domain_allowlist=["pypi.org"], client=self.client)
        self.assertEqual(len(self.world.called("sandboxes.create")), made)

    def test_encrypted_ports_become_public_previews_and_tunnels(self):
        box = Sandbox.create("python3", "-m", "http.server", encrypted_ports=[8000, 9000], client=self.client)
        self.assertEqual([call[1] for call in self.world.called("previews.create")], [{"visibility": "public"}] * 2)
        box._sandbox.previews.create(7000)  # a private preview made natively is no Modal tunnel
        tunnels = box.tunnels()
        self.assertEqual(set(tunnels), {8000, 9000})
        tunnel = tunnels[8000]
        self.assertEqual(tunnel.port, 443)
        self.assertEqual(tunnel.url, f"https://{tunnel.host}")
        self.assertEqual(tunnel.tls_socket, (tunnel.host, 443))
        self.assertIsNone(tunnel.unencrypted_host)
        with self.assertRaises(InvalidError):
            tunnel.tcp_socket
        self.assertIs(box.tunnels(), tunnels)
        again = Sandbox.from_id(box.object_id, client=self.client)
        self.assertEqual(set(again.tunnels()), {8000, 9000})
        self.assertEqual(Sandbox.create(client=self.client).tunnels(), {})
        self.assertEqual(Tunnel("h", 8443).url, "https://h:8443")

    def test_async_tunnels(self):
        async def run():
            box = await Sandbox.create.aio(encrypted_ports=[8080], client=self.world.async_client())
            self.assertEqual(list(await box.tunnels.aio()), [8080])
        asyncio.run(run())

    def test_readiness_probe(self):
        attempts = []

        def probe(command, options):
            attempts.append((command, options))
            return Result(0 if len(attempts) >= 3 else 1)
        self.world.exec = probe
        box = Sandbox.create("server", readiness_probe=Probe.with_tcp(8080, interval_ms=1), client=self.client)
        box.wait_until_ready(timeout=5)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(attempts[0][0], ["bash", "-c", "</dev/tcp/127.0.0.1/8080"])
        attempts.clear()
        again = Sandbox.from_id(box.object_id, client=self.client)
        again.wait_until_ready()
        self.assertEqual(len(attempts), 3)
        self.world.exec = lambda command, options: Result(1)
        failing = Sandbox.create(readiness_probe=Probe.with_exec("test", "-f", "/ready", interval_ms=5), client=self.client)
        with self.assertRaises(ModalTimeout):
            failing.wait_until_ready(timeout=0.05)
        with self.assertRaises(InvalidError):
            failing.wait_until_ready(timeout=0)
        with self.assertRaises(InvalidError):
            Sandbox.create(client=self.client).wait_until_ready()

    def test_async_readiness_probe(self):
        calls = []
        self.world.exec = lambda command, options: calls.append(command) or Result(0)

        async def run():
            box = await Sandbox.create.aio(readiness_probe=Probe.with_exec("true"), client=self.world.async_client())
            await box.wait_until_ready.aio(timeout=1)
        asyncio.run(run())
        self.assertEqual(calls, [["true"]])

    def test_probe_validation(self):
        for call in (lambda: Probe.with_tcp(0), lambda: Probe.with_tcp("80"), lambda: Probe.with_tcp(80, interval_ms=0),
                     lambda: Probe.with_exec(), lambda: Probe.with_exec("a", 1), lambda: Probe(),
                     lambda: Probe.with_exec("x", interval_ms=1.5)):
            with self.assertRaises(InvalidError):
                call()
        probe = Probe.with_exec("a", "b", interval_ms=7)
        self.assertEqual((probe.exec_argv, probe.interval_ms, probe.tcp_port), (("a", "b"), 7, None))

    def test_handle_members(self):
        box = Sandbox.create(client=self.client)
        self.assertIs(box.client, self.client)
        self.assertIs(box.hydrate(), box)
        self.assertIs(asyncio.run(box.hydrate.aio()), box)
        self.assertEqual(box.get_dashboard_url(), f"https://withruntime.com/account/sandboxes/{box.object_id}")
        self.assertEqual(box.stdout.read(), "")
        self.assertEqual(list(box.stderr), [])
        with self.assertRaises(InvalidError):
            box.stdin.write("x")
        self.assertIsNone(box.returncode)
        self.assertEqual(box.terminate(wait=True), 137)
        self.assertEqual(box.poll(), 137)
        with self.assertRaises(CompatibilityError):
            box.logs

    def test_terminate_without_wait_and_entrypoint_code(self):
        box = Sandbox.create("true", client=self.client)
        box._entrypoint.wait()
        self.assertIsNone(box.terminate())
        self.assertEqual(box.returncode, 0)

    def test_detach_closes_the_handle(self):
        box = Sandbox.create(client=self.client)
        box.detach()
        for call in (lambda: box.exec("ls"), lambda: box.filesystem, lambda: box.stdout, lambda: box.terminate(),
                     lambda: box.tunnels(), lambda: box.get_tags(), lambda: box.reload_volumes()):
            with self.assertRaises(ClientClosed):
                call()
        asyncio.run(box.detach.aio())
        self.assertIsNotNone(Sandbox.from_id(box.object_id, client=self.client).exec("ls"))

    def test_pty_entrypoint_and_exec_buffering(self):
        box = Sandbox.create("bash", pty=True, client=self.client)
        self.assertEqual(self.world.called("sandbox.spawn")[0][1]["pty"], {"rows": 24, "cols": 80})
        with self.assertRaises(ValueError):
            box.exec("ls", bufsize=1, text=False)
        with self.assertRaises(ValueError):
            box.exec("ls", bufsize=0)

    def test_refused_sandbox_methods(self):
        box = Sandbox.create(client=self.client)
        before = len(self.world.calls)
        calls = [lambda: box.create_connect_token(), lambda: box.snapshot_directory("/a"),
                 lambda: box.mount_image("/a", Image.debian_slim()), lambda: box.unmount_image("/a"),
                 lambda: box.create_connect_token.aio(), lambda: box.snapshot_directory.aio("/a"),
                 lambda: box.exec("ls", stdout="devnull")]
        for call in calls:
            with self.assertRaises(CompatibilityError):
                call()
        self.assertEqual(len(self.world.calls), before)


# App, Proxy, snapshots -------------------------------------------------------------------------


class Apps(World):
    def test_app_members(self):
        app = App("jobs")
        self.assertEqual((app.name, app.app_id, app.description), ("jobs", "jobs", "jobs"))
        app.description = "nightly"
        self.assertEqual(app.description, "nightly")
        self.assertEqual(App.lookup("x", client=self.client).name, "x")
        self.assertEqual(asyncio.run(App.lookup.aio("y")).name, "y")
        calls = [lambda: App.lookup("x", environment_name="e"), lambda: app.deploy(), lambda: app.run(),
                 lambda: app.include(App("b")), lambda: app.set_tags({"a": "b"}), lambda: app.get_tags(),
                 lambda: app.info(), lambda: app.logs, lambda: app.registered_functions, lambda: app.registered_classes,
                 lambda: app.registered_entrypoints, lambda: app.registered_web_endpoints,
                 lambda: app.get_dashboard_url(), lambda: app.run.aio(), lambda: app.deploy.aio()]
        for call in calls:
            with self.assertRaises(CompatibilityError):
                call()

    def test_proxy_is_refused(self):
        proxy = Proxy()
        for call in (lambda: Proxy.from_name("p"), lambda: Proxy.from_name.aio("p"), lambda: proxy.object_id,
                     lambda: proxy.client, lambda: proxy.hydrate(), lambda: proxy.get_dashboard_url()):
            with self.assertRaisesRegex(CompatibilityError, "egress"):
                call()
        self.assertEqual(self.requests(), [])

    def test_sandbox_snapshot_from_id(self):
        box = Sandbox.create(client=self.client)
        snapshot_id = box._sandbox.snapshot(mode="disk")["id"]
        found = SandboxSnapshot.from_id(snapshot_id, client=self.client)
        self.assertEqual(found.object_id, snapshot_id)
        self.assertIs(found.client, self.client)
        with self.assertRaises(NotFoundError):
            SandboxSnapshot.from_id("gone", client=self.client)
        with self.assertRaises(CompatibilityError):
            found.get_dashboard_url()

        async def run():
            client = self.world.async_client()
            self.assertEqual((await SandboxSnapshot.from_id.aio(snapshot_id, client=client)).object_id, snapshot_id)
            with self.assertRaises(NotFoundError):
                await SandboxSnapshot.from_id.aio("gone", client=client)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
