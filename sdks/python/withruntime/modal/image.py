"""modal.Image as a Dockerfile Runtime builds.

Each recipe method adds the lines modal 1.6.0's own builder writes for it, on
a registry base. Local files a step copies go into the build context under
`.modal/<n>/`, staged in a temporary folder and uploaded with the build.
"""
from __future__ import annotations
import contextlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import tempfile
import warnings
from pathlib import Path, PurePosixPath
from .._compat import CompatibilityError, dockerfile, reject
from .._errors import RuntimeError as SDKError
from ._dual import Dual, install
from ._object import CONSOLE, _Object
from .exception import ImageBuildError, InvalidError, NotFoundError
from .file_pattern_matcher import NON_PYTHON_FILES, FilePatternMatcher, ignore_fn

GPU_OR_SECRETS = ("Runtime builds images on CPU, without stored secrets: drop gpu, and pass build-time "
                  "values with env=")
REGISTRY_LOGIN = "store the registry login with runtime.images.registries.set(...), then Image.from_registry(tag)"
ADD_PYTHON = "Installing a specific Python into arbitrary images is not supported: use a Python base image"
MICROMAMBA = "mambaorg/micromamba:2.1.1-debian12-slim"


class _AutoDockerIgnore:
    def __repr__(self):
        return "AUTO_DOCKERIGNORE"


AUTO_DOCKERIGNORE = _AutoDockerIgnore()


def _flatten(function, argument, values):
    flat = []
    for value in values:
        if isinstance(value, str):
            flat.append(value)
        elif isinstance(value, list) and all(isinstance(item, str) for item in value):
            flat.extend(value)
        else:
            raise InvalidError(f"{function}: {argument} must only contain strings")
    return flat


def _packages(function, values):
    packages = _flatten(function, "packages", values)
    if any(package.startswith("-") for package in packages):
        raise InvalidError(f"Package list for `Image.{function}` cannot contain other arguments;"
                           " try the `extra_options` parameter instead.")
    return packages


class _BadValue(InvalidError, ValueError):
    """modal raises InvalidError; this adapter raised ValueError before."""


def _line(value, name):
    if not isinstance(value, str) or "\n" in value or "\r" in value:
        raise _BadValue(f"{name} must be one line of text")
    return value


def _version(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+-]*", value):
        raise InvalidError(f"{name} must be a version such as 3.12 or 0.8.4, got {value!r}")
    return value


def _python(value):
    if value is not None and (not isinstance(value, str) or not re.fullmatch(r"3\.\d+(\.\d+)?", value)):
        raise InvalidError(f"Invalid Python version: {value!r}")
    return value


def _exports(env):
    """`export K=V && ` before a build step's commands: modal sets a step's
    env for that step only, never in the finished image."""
    values = {key: value for key, value in (env or {}).items() if value is not None}
    for key, value in values.items():
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\n" in value or "\r" in value:
            raise _BadValue("Image environment needs valid names and single-line string values")
    return "export " + " ".join(f"{key}={shlex.quote(value)}" for key, value in values.items()) + " && " if values else ""


def _with_env(lines, env):
    prefix = _exports(env)
    if not prefix:
        return lines
    out = []
    for line in lines:
        if re.match(r"\s*RUN\s+\[", line, re.I):
            raise CompatibilityError("A step's env applies to shell-form RUN lines; write the exec-form RUN in shell form")
        out.append(re.sub(r"^(\s*RUN\s+)", lambda m: m.group(1) + prefix, line, flags=re.I))
    return out


def _pip_flags(find_links, index_url, extra_index_url, pre, extra_options, *, uv=False):
    flags = [f"{flag} {shlex.quote(value)}" for flag, value in (
        ("--find-links", find_links), ("--index-url", index_url), ("--extra-index-url", extra_index_url))
        if value is not None]
    if pre:
        flags.append("--prerelease allow" if uv else "--pre")
    if extra_options:
        flags.append(_line(extra_options, "extra_options"))
    return " ".join(flags)


def _toml(path):
    try:
        import tomllib
    except ImportError:  # before Python 3.11
        try:
            import tomli as tomllib
        except ImportError as error:
            raise ImportError("Reading pyproject.toml before Python 3.11 needs the `tomli` package") from error
    with open(os.path.expanduser(path), "rb") as handle:
        return tomllib.load(handle)


def _copy_sources(lines):
    """The context patterns a Dockerfile's COPY lines read, as modal 1.6.0's
    extract_copy_command_patterns: continued lines joined, comments skipped,
    `COPY --from` and the --chmod/--chown/--link flags left out."""
    sources, command = set(), ""
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        command = (command + " " if command else "") + line.rstrip("\\").strip()
        if line.endswith("\\"):
            continue
        found, command = re.match(r"^\s*COPY\s+(.+)$", command, re.I), ""
        if not found:
            continue
        parts = shlex.split(found.group(1))
        if any(part.startswith("--from=") for part in parts):
            continue
        parts = [part for part in parts if part != "--link"
                 and not part.startswith(("--chmod=", "--chown=", "--link="))]
        for source in parts[:-1] if len(parts) >= 2 else []:
            if re.match(r"^\s*--|\$\s*", source):
                raise InvalidError(f"COPY command: {source} using special flags/arguments/variables are not supported")
            sources.add("./**" if source == "." else source)
    return sorted(sources)


def _dockerignore(context_dir, dockerfile_path=None):
    candidates = []
    if dockerfile_path is not None:
        path = Path(dockerfile_path)
        candidates += [path.parent / f"{path.name}.dockerignore", path.parent / ".dockerignore"]
    candidates.append(context_dir / ".dockerignore")
    for candidate in candidates:
        if candidate.is_file():
            return FilePatternMatcher(*candidate.read_text("utf8").splitlines())
    return FilePatternMatcher()


def _tree(local_dir, ignore):
    """Every file under `local_dir` the ignore predicate keeps, by relative path."""
    root = Path(os.path.expanduser(str(local_dir))).absolute()
    if not root.is_dir():
        raise FileNotFoundError(f"local dir {root} does not exist")
    excluded = ignore_fn(ignore)
    found = {}
    for directory, names, files in os.walk(root):
        names.sort()
        for name in sorted(files):
            full = Path(directory) / name
            relative = full.relative_to(root)
            if excluded(relative):
                continue
            # A link is followed only inside the folder: one to a file outside
            # it (a key, a credentials file) would put that file in the image.
            if full.is_symlink() and not full.resolve().is_relative_to(root.resolve()):
                raise InvalidError(f"{full} links to {full.resolve()}, outside {root}: add that file with "
                                   "add_local_file, or leave the link out with ignore")
            if full.is_file():
                found[relative.as_posix()] = str(full)
    return found


def _context_of(lines, context_dir, ignore, dockerfile_path=None):
    """modal's implicit context: the files COPY and ADD name, from context_dir
    (the working directory by default), less the ignored ones."""
    sources = _copy_sources(lines)
    if not sources:
        return {}
    root = (Path.cwd() if context_dir is None else Path(os.path.expanduser(str(context_dir)))).absolute()
    for source in sources:
        if not (root / source.lstrip("/")).resolve().is_relative_to(root.resolve()):
            raise InvalidError(f"COPY source {source!r} is outside the build context directory ({str(root)!r}).")
    include = FilePatternMatcher(*sources)
    excluded = _dockerignore(root, dockerfile_path) if ignore is AUTO_DOCKERIGNORE else ignore_fn(ignore)
    return _tree(root, lambda path: not include(path) or excluded(path))


def _need_copy(copy):
    """modal's copy=False adds files when a container starts; Runtime bakes them in."""
    if not copy:
        raise CompatibilityError("Files are added to a Runtime image at build time: pass copy=True "
                                 "(copy=True bakes it into the image)")


def _build_error(error):
    if isinstance(error, SDKError) and error.code == "image_build_failed":
        found = re.search(r"Image (\S+)", str(error))
        return ImageBuildError(str(error), found.group(1) if found else "")
    if isinstance(error, SDKError) and error.code in ("not_found", "image_not_found"):
        return NotFoundError(str(error))
    return error


class Image(_Object):
    force_build: bool = False
    inside_exceptions: list = []

    def __init__(self, source, snapshot_id=None, *, force_build=False, context=None, build_args=None, ref=None):
        self._dockerfile, self._snapshot_id, self._ref = source, snapshot_id, ref
        self._context, self._build_args = dict(context or {}), dict(build_args or {})
        self.force_build, self.inside_exceptions = force_build, []
        self._object_id = snapshot_id

    # Building ---------------------------------------------------------------

    def _append(self, lines, *, context=None, build_args=None, force_build=False):
        if self._snapshot_id or self._ref:
            raise CompatibilityError("An image from a filesystem snapshot, from_id or from_name cannot be extended: "
                                     "build one recipe from a registry base or Dockerfile")
        merged = dict(self._context)
        for key, value in (context or {}).items():
            if merged.get(key, value) != value:
                raise CompatibilityError(f"Two build steps both put {key} at the root of the build context")
            merged[key] = value
        args = dict(self._build_args)
        for key, value in (build_args or {}).items():
            if args.get(key, value) != value:
                raise CompatibilityError(f"Two build steps give build arg {key} different values")
            args[key] = value
        return Image(self._dockerfile + "".join(line + "\n" for line in lines), force_build=self.force_build or force_build,
                     context=merged, build_args=args)

    def _slot(self):
        """A fresh context folder for one step's files."""
        return f".modal/{len({key.split('/')[1] for key in self._context if key.startswith('.modal/')})}"

    def _fields(self, stage):
        fields = {"dockerfile": self._dockerfile}
        if self._build_args:
            fields["build_args"] = dict(self._build_args)
        if self.force_build:
            fields["cache"] = False
        if self._context:
            for relative, source in self._context.items():
                target = Path(stage) / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            fields.update(context_dir=stage, dockerignore="")
        return fields

    def _load(self, runtime):
        if self._object_id is not None:
            return
        try:
            if self._ref is not None:
                self._object_id = runtime.images.resolve(self._ref)["id"]
                return
            with tempfile.TemporaryDirectory(prefix="modal-image-") as stage:
                self._object_id = runtime.images.build(**self._fields(stage))["id"]
        except SDKError as error:
            raise _build_error(error) from error

    async def _load_aio(self, runtime):
        if self._object_id is not None:
            return
        try:
            if self._ref is not None:
                self._object_id = (await runtime.images.resolve(self._ref))["id"]
                return
            with tempfile.TemporaryDirectory(prefix="modal-image-") as stage:
                self._object_id = (await runtime.images.build(**self._fields(stage)))["id"]
        except SDKError as error:
            raise _build_error(error) from error

    def _source(self, runtime):
        if self._snapshot_id:
            return {"snapshot": self._snapshot_id}
        self._load(runtime)
        return {"image": self._object_id}

    async def _source_aio(self, runtime):
        if self._snapshot_id:
            return {"snapshot": self._snapshot_id}
        await self._load_aio(runtime)
        return {"image": self._object_id}

    def build(self, app):
        return self.hydrate()

    def get_dashboard_url(self):
        if self._snapshot_id:
            raise CompatibilityError("An image from a filesystem snapshot is a Runtime snapshot, with no image page")
        self.hydrate()
        return f"{CONSOLE}/images/{self._object_id}"

    @property
    def logs(self):
        raise CompatibilityError("Read an image's build log with the native runtime.images.logs(image_id)")

    @contextlib.contextmanager
    def imports(self):
        try:
            yield
        except Exception as error:  # noqa: BLE001 - modal records what fails to import locally
            if self._object_id is None:
                self.inside_exceptions.append(error)
            if not isinstance(error, ImportError):
                warnings.warn(f"Warning: caught a non-ImportError exception in an `imports()` block: {error!r}")

    def pipe(self, func, *args, **kwargs):
        return func(self, *args, **kwargs)

    # Bases ------------------------------------------------------------------

    @staticmethod
    def from_registry(tag, secret=None, *, setup_dockerfile_commands=[], force_build=False, add_python=None, **kwargs):
        reject(kwargs, "Modal Image.from_registry")
        if secret is not None:
            raise CompatibilityError(REGISTRY_LOGIN)
        if add_python is not None:
            raise CompatibilityError(ADD_PYTHON)
        lines = _flatten("from_registry", "setup_dockerfile_commands", setup_dockerfile_commands)
        return Image(dockerfile(tag) + "".join(line + "\n" for line in lines), force_build=force_build)

    @staticmethod
    def from_aws_ecr(tag, secret=None, *, setup_dockerfile_commands=[], force_build=False, add_python=None, **kwargs):
        raise CompatibilityError(REGISTRY_LOGIN)

    @staticmethod
    def from_gcp_artifact_registry(tag, secret=None, *, setup_dockerfile_commands=[], force_build=False,
                                   add_python=None, **kwargs):
        raise CompatibilityError(REGISTRY_LOGIN)

    @staticmethod
    def debian_slim(python_version=None, force_build=False):
        version = _python(python_version) or "3.12"
        return Image.from_registry(f"python:{version}-slim-bookworm", force_build=force_build)

    @staticmethod
    def from_scratch(force_build=False):
        raise CompatibilityError("Runtime sandboxes need a Linux userland: start from Image.debian_slim() "
                                 "or Image.from_registry(tag)")

    @staticmethod
    def micromamba(python_version=None, force_build=False):
        version = _python(python_version) or "3.12"
        return Image(dockerfile(MICROMAMBA) + 'SHELL ["/usr/local/bin/_dockerfile_shell.sh"]\n'
                     "ENV MAMBA_DOCKERFILE_ACTIVATE=1\n"
                     f"RUN micromamba install -n base -y python={version} pip -c conda-forge\n",
                     force_build=force_build)

    @staticmethod
    def from_dockerfile(path, *, force_build=False, context_dir=None, env=None, secrets=None, gpu=None,
                        add_python=None, build_args={}, ignore=AUTO_DOCKERIGNORE):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        if add_python is not None:
            raise CompatibilityError(ADD_PYTHON)
        with open(os.path.expanduser(str(path)), encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        context = _context_of(lines, context_dir, ignore, Path(os.path.expanduser(str(path))))
        return Image("", force_build=force_build)._append(_with_env(lines, env), context=context,
                                                          build_args=build_args)

    @staticmethod
    def from_id(image_id, client=None):
        image = Image(None, ref=_line(image_id, "image_id"))
        image._client = client
        return image

    @staticmethod
    def from_name(name, *, environment_name=None, client=None):
        if environment_name is not None:
            raise CompatibilityError("Modal environment namespaces are not Runtime account namespaces")
        image = Image(None, ref=_line(name, "name"))
        image._client = client
        return image

    def publish(self, name, *, environment_name=None, experimental_options=None, client=None):
        raise CompatibilityError("Build with a name instead: runtime.images.build(name=..., dockerfile=...)")

    # Steps ------------------------------------------------------------------

    def apt_install(self, *packages, force_build=False, env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        names = _packages("apt_install", packages)
        if not names:
            return self
        return self._append([f"RUN {_exports(env)}apt-get update && apt-get install -y -- {shlex.join(names)}"],
                            force_build=force_build)

    def pip_install(self, *packages, find_links=None, index_url=None, extra_index_url=None, pre=False,
                    extra_options="", force_build=False, env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        names = _packages("pip_install", packages)
        if not names:
            return self
        flags = _pip_flags(find_links, index_url, extra_index_url, pre, extra_options)
        return self._append([f"RUN {_exports(env)}python -m pip install {flags + ' ' if flags else ''}-- "
                             f"{shlex.join(sorted(names))}"], force_build=force_build)

    def pip_install_private_repos(self, *repositories, git_user, find_links=None, index_url=None,
                                  extra_index_url=None, pre=False, extra_options="", gpu=None, env=None,
                                  secrets=None, force_build=False):
        raise CompatibilityError("Runtime builds keep no git token: vendor the repositories with "
                                 "add_local_dir(copy=True), or pip_install from a package index")

    def pip_install_from_requirements(self, requirements_txt, find_links=None, *, index_url=None,
                                      extra_index_url=None, pre=False, extra_options="", force_build=False,
                                      env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        source = os.path.expanduser(requirements_txt)
        slot = self._slot()
        flags = _pip_flags(find_links, index_url, extra_index_url, pre, extra_options)
        return self._append([f"COPY {slot}/requirements.txt /.requirements.txt",
                             f"RUN {_exports(env)}python -m pip install -r /.requirements.txt{' ' + flags if flags else ''}"],
                            context={f"{slot}/requirements.txt": _file(source)}, force_build=force_build)

    def pip_install_from_pyproject(self, pyproject_toml, optional_dependencies=[], *, find_links=None,
                                   index_url=None, extra_index_url=None, pre=False, extra_options="",
                                   force_build=False, env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        config = _toml(pyproject_toml)
        project = config.get("project", {})
        if "dependencies" not in project:
            raise ValueError("No [project.dependencies] section in pyproject.toml file. If your pyproject.toml "
                             "instead declares [tool.poetry.dependencies], use `Image.poetry_install_from_file()`.")
        dependencies = list(project["dependencies"])
        optionals = project.get("optional-dependencies", {})
        for group in optional_dependencies:
            dependencies.extend(optionals.get(group, []))
        if not dependencies:
            return self
        flags = _pip_flags(find_links, index_url, extra_index_url, pre, extra_options)
        return self._append([f"RUN {_exports(env)}python -m pip install {flags + ' ' if flags else ''}-- "
                             f"{shlex.join(sorted(dependencies))}"], force_build=force_build)

    def uv_pip_install(self, *packages, requirements=None, find_links=None, index_url=None, extra_index_url=None,
                       pre=False, extra_options="", force_build=False, uv_version=None, env=None, secrets=None,
                       gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        names = _packages("uv_pip_install", packages)
        files = _requirement_list(requirements)
        if not names and not files:
            return self
        slot = self._slot()
        context, copies, args = {}, [], ["--python $(command -v python)", "--compile-bytecode"]
        flags = _pip_flags(find_links, index_url, extra_index_url, pre, extra_options, uv=True)
        if flags:
            args.append(flags)
        for index, requirement in enumerate(files):
            base = os.path.basename(requirement)
            context[f"{slot}/{index}_{base}"] = _file(os.path.expanduser(requirement))
            copies.append(f"COPY {slot}/{index}_{base} /.uv/{index}/{base}")
            args.append(f"--requirements /.uv/{index}/{base}")
        args += [shlex.quote(name) for name in sorted(names)]
        return self._append([_uv(uv_version), *copies, f"RUN {_exports(env)}/.uv/uv pip install {' '.join(args)}"],
                            context=context, force_build=force_build)

    def poetry_install_from_file(self, poetry_pyproject_toml, poetry_lockfile=None, *, ignore_lockfile=False,
                                 force_build=False, with_=[], without=[], only=[], poetry_version="latest",
                                 old_installer=False, env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        slot = self._slot()
        prefix = _exports(env)
        context = {f"{slot}/pyproject.toml": _file(os.path.expanduser(poetry_pyproject_toml))}
        lines = []
        if poetry_version is not None:
            spec = "" if poetry_version == "latest" else "==" + _version(poetry_version, "poetry_version")
            lines.append(f"RUN {prefix}python -m pip install poetry{spec}")
        if old_installer:
            lines.append("RUN poetry config experimental.new-installer false")
        if not ignore_lockfile:
            lockfile = poetry_lockfile
            if lockfile is None:
                inferred = Path(os.path.expanduser(poetry_pyproject_toml)).parent / "poetry.lock"
                if not inferred.exists():
                    raise NotFoundError(f"poetry.lock not found at inferred location: {inferred.absolute()}. "
                                        "If a lockfile is not needed, `ignore_lockfile=True` can be used.")
                lockfile = inferred.as_posix()
            context[f"{slot}/poetry.lock"] = _file(os.path.expanduser(lockfile))
            lines.append(f"COPY {slot}/poetry.lock /tmp/poetry/poetry.lock")
        command = "poetry install --no-root" + "".join(
            f" --{flag} {shlex.quote(','.join(groups))}" for flag, groups in (("with", with_), ("without", without),
                                                                              ("only", only)) if groups)
        lines += [f"COPY {slot}/pyproject.toml /tmp/poetry/pyproject.toml",
                  f"RUN {prefix}cd /tmp/poetry && poetry config virtualenvs.create false && {command} --compile"]
        return self._append(lines, context=context, force_build=force_build)

    def uv_sync(self, uv_project_dir="./", *, force_build=False, groups=None, extras=None, frozen=True,
                extra_options="", uv_version=None, env=None, secrets=None, gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        groups, extras = _names(groups, "groups"), _names(extras, "extras")
        project = os.path.expanduser(uv_project_dir)
        pyproject = os.path.join(project, "pyproject.toml")
        if not os.path.exists(pyproject):
            raise InvalidError(f"Expected {pyproject} to exist")
        if "workspace" in _toml(pyproject).get("tool", {}).get("uv", {}):
            raise InvalidError("uv workspaces are not supported")
        slot = self._slot()
        args = ["--project=/.uv", "--no-install-workspace", "--compile-bytecode",
                *(f"--group={shlex.quote(group)}" for group in groups), *(f"--extra={shlex.quote(extra)}" for extra in extras)]
        if extra_options:
            args.append(_line(extra_options, "extra_options"))
        context = {f"{slot}/pyproject.toml": _file(pyproject)}
        lines = [_uv(uv_version), f"COPY {slot}/pyproject.toml /.uv/pyproject.toml"]
        lock = os.path.join(project, "uv.lock")
        if os.path.exists(lock):
            context[f"{slot}/uv.lock"] = _file(lock)
            lines.append(f"COPY {slot}/uv.lock /.uv/uv.lock")
            if frozen:
                args.append("--frozen")
        lines += [f"RUN {_exports(env)}/.uv/uv sync {' '.join(args)}", "ENV PATH=/.uv/.venv/bin:$PATH"]
        return self._append(lines, context=context, force_build=force_build)

    def micromamba_install(self, *packages, spec_file=None, channels=[], force_build=False, env=None, secrets=None,
                           gpu=None):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        names = _flatten("micromamba_install", "packages", packages)
        if not names and spec_file is None:
            return self
        lines, context, args = [], {}, [shlex.join(names)] if names else []
        if spec_file is not None:
            slot = self._slot()
            base = os.path.basename(spec_file)
            context[f"{slot}/{base}"] = _file(os.path.expanduser(spec_file))
            lines.append(f"COPY {slot}/{base} /{base}")
            args.append(f"-f {shlex.quote('/' + base)} -n base")
        args += [f"-c {shlex.quote(channel)}" for channel in channels]
        lines.append(f"RUN {_exports(env)}micromamba install {' '.join(args)} --yes")
        return self._append(lines, context=context, force_build=force_build)

    def run_commands(self, *commands, env=None, secrets=None, volumes=None, gpu=None, force_build=False):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        if volumes:
            raise CompatibilityError("Runtime image builds mount no volumes: copy the files in with add_local_dir(copy=True)")
        prefix = _exports(env)
        return self._append([f"RUN {prefix}{line}" for line in _flatten("run_commands", "commands", commands)],
                            force_build=force_build)

    def dockerfile_commands(self, *dockerfile_commands, context_files={}, env=None, secrets=None, gpu=None,
                            context_dir=None, force_build=False, ignore=AUTO_DOCKERIGNORE, build_args={}):
        if gpu is not None or secrets:
            raise CompatibilityError(GPU_OR_SECRETS)
        lines = _flatten("dockerfile_commands", "dockerfile_commands", dockerfile_commands)
        if not lines:
            return self
        context = _context_of(lines, context_dir, ignore)
        for remote, source in context_files.items():
            context[remote.lstrip("/")] = _file(os.path.expanduser(source))
        return self._append(_with_env(lines, env), context=context, build_args=build_args, force_build=force_build)

    def run_function(self, raw_f, *, env=None, secrets=None, volumes={}, network_file_systems={}, gpu=None, cpu=None,
                     memory=None, timeout=3600, cloud=None, region=None, force_build=False, args=(), kwargs={},
                     include_source=True):
        raise CompatibilityError("Runtime builds run no Python function: do the work in run_commands(...) "
                                 "or in the sandbox after it starts")

    def env(self, vars):
        _exports(vars)
        return self._append([f"ENV {key}={json.dumps(value)}" for key, value in vars.items() if value is not None])

    def workdir(self, path):
        return self._append(["WORKDIR " + _line(str(path), "workdir")])

    def cmd(self, cmd):
        return self._append(["CMD " + json.dumps(_flatten("cmd", "cmd", [list(cmd)]))])

    def entrypoint(self, entrypoint_commands):
        return self._append(["ENTRYPOINT " + json.dumps(_flatten("entrypoint", "entrypoint_commands",
                                                                [list(entrypoint_commands)]))])

    def shell(self, shell_commands):
        return self._append(["SHELL " + json.dumps(_flatten("shell", "shell_commands", [list(shell_commands)]))])

    def add_local_file(self, local_path, remote_path, *, copy=False):
        _need_copy(copy)
        remote = _remote(remote_path, "add_local_file")
        source = _file(os.path.expanduser(str(local_path)))
        if remote.endswith("/"):
            remote += os.path.basename(source)
        slot = self._slot()
        name = os.path.basename(source)
        return self._append([f"COPY {slot}/{name} {remote}"], context={f"{slot}/{name}": source})

    def add_local_dir(self, local_path, remote_path, *, copy=False, ignore=[]):
        _need_copy(copy)
        remote = _remote(remote_path, "add_local_dir").rstrip("/") or "/"
        slot = self._slot()
        files = _tree(local_path, ignore)
        if not files:
            return self._append([f"RUN mkdir -p {shlex.quote(remote)}"])
        return self._append([f"COPY {slot}/ {remote}/"],
                            context={f"{slot}/{relative}": source for relative, source in files.items()})

    def add_local_python_source(self, *modules, copy=False, ignore=NON_PYTHON_FILES):
        _need_copy(copy)
        image = self
        for module in modules:
            if not isinstance(module, str):
                raise InvalidError("Local Python modules must be specified as strings.")
            spec = importlib.util.find_spec(module)
            if spec is None or spec.origin is None and not spec.submodule_search_locations:
                raise ModuleNotFoundError(f"No local module named {module!r}")
            if spec.submodule_search_locations:
                root = Path(list(spec.submodule_search_locations)[0])
                excluded = ignore_fn(ignore)
                keep = lambda path: _hidden(path) or excluded(path)  # noqa: E731
                files = _tree(root, keep)
                slot = image._slot()
                image = image._append([f"COPY {slot}/ /root/{'/'.join(module.split('.'))}/"],
                                      context={f"{slot}/{relative}": source for relative, source in files.items()})
            else:
                name = os.path.basename(spec.origin)
                slot = image._slot()
                image = image._append([f"COPY {slot}/{name} /root/{name}"], context={f"{slot}/{name}": spec.origin})
        return image


def _hidden(path):
    parts = Path(path).parts
    return any(part.startswith(".") or part == "__pycache__" for part in parts) or str(path).endswith(".pyc")


def _file(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(f"local file {path} does not exist")
    return os.path.abspath(path)


def _remote(path, function):
    path = str(PurePosixPath(path)) + ("/" if str(path).endswith("/") else "")
    if not path.startswith("/"):
        raise InvalidError(f"image.{function}() currently only supports absolute remote_path values")
    return _line(path, "remote_path")


def _names(items, name):
    if items is None:
        return []
    if not isinstance(items, list):
        raise InvalidError(f"{name} must be None or a list of strings")
    return items


def _requirement_list(requirements):
    if requirements is not None and not isinstance(requirements, list):
        raise InvalidError("requirements must be None or a list of strings")
    return requirements or []


def _uv(version):
    tag = "latest" if version is None else _version(version, "uv_version")
    return f"COPY --from=ghcr.io/astral-sh/uv:{tag} /uv /.uv/uv"


async def _build_aio(self, app):
    return await self.hydrate.aio()


async def _dashboard_aio(self):
    if self._snapshot_id:
        return self.get_dashboard_url()
    await self.hydrate.aio()
    return f"{CONSOLE}/images/{self._object_id}"


Image.build = Dual(Image.build, _build_aio)
Image.get_dashboard_url = Dual(Image.__dict__["get_dashboard_url"], _dashboard_aio)
install(Image, ("publish",), refused=True)
install(Image, ("from_id",), static=("from_id",))
