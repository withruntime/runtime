"""Runtime sandbox lifecycle (create, attach, stop) for Deep Agents Code.

Installing this package registers the `runtime` provider under the
`deepagents_code.sandbox_providers` entry point, so `dcode --sandbox runtime`
creates a Runtime sandbox for the session and stops it at the end.
`RuntimeProvider` also works without Deep Agents Code, as a small factory for
`RuntimeSandbox` backends.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from withruntime import NotFoundError, Runtime
from withruntime.deepagents import RuntimeSandbox

WORKING_DIR = "/workspace"
"""`HOME` and the default working directory in a Runtime sandbox."""

EnvResolver = Callable[[str], str | None]


def _default_resolve_env(name: str) -> str | None:
    """Read `name`, letting `DEEPAGENTS_CODE_<name>` override it, as the other providers do."""
    prefixed = f"DEEPAGENTS_CODE_{name}"
    if prefixed in os.environ:
        return os.environ[prefixed] or None
    return os.environ.get(name) or None


def _not_found(sandbox_id: str, cause: BaseException) -> Exception:
    """Deep Agents Code's `SandboxNotFoundError` when it is installed, else `KeyError`."""
    try:
        from deepagents_code.integrations.sandbox_provider import (  # noqa: PLC0415
            SandboxNotFoundError,
        )
    except ImportError:
        error: Exception = KeyError(sandbox_id)
    else:
        error = SandboxNotFoundError(sandbox_id)
    error.__cause__ = cause
    return error


class RuntimeProvider:
    """Create or attach Runtime sandboxes and wrap each in a `RuntimeSandbox`.

    The key comes from `RUNTIME_API_KEY` (or `DEEPAGENTS_CODE_RUNTIME_API_KEY`),
    and otherwise from this machine's `npx withruntime login`. Pass `client` to
    share a `withruntime.Runtime`.
    """

    def __init__(
        self,
        *,
        client: Runtime | None = None,
        api_key: str | None = None,
        resolve_env_var: EnvResolver | None = None,
    ) -> None:
        """Initialize the provider.

        Args:
            client: A `withruntime.Runtime` to use. One is made when omitted.
            api_key: A Runtime API key, when `client` is omitted.
            resolve_env_var: Environment lookup for the key and base URL.
        """
        self._client = client
        self._api_key = api_key
        self._resolve_env = resolve_env_var or _default_resolve_env

    @property
    def client(self) -> Runtime:
        """The Runtime client, made on first use so constructing needs no key."""
        if self._client is None:
            self._client = Runtime(
                api_key=self._api_key or self._resolve_env("RUNTIME_API_KEY"),
                base_url=self._resolve_env("RUNTIME_API_URL"),
            )
        return self._client

    @property
    def metadata(self) -> Any:
        """Deep Agents Code's description of this provider, or `None` without it."""
        try:
            from deepagents_code.integrations.sandbox_provider import (  # noqa: PLC0415
                SandboxInstallHint,
                SandboxProviderMetadata,
            )
        except ImportError:
            return None
        return SandboxProviderMetadata(
            name="runtime",
            working_dir=WORKING_DIR,
            install=SandboxInstallHint(kind="package", name="langchain-withruntime"),
            supports_sandbox_id=True,
            supports_snapshot_name=False,
            backend_module="langchain_withruntime",
        )

    def get_or_create(
        self,
        *,
        sandbox_id: str | None = None,
        timeout: int | None = None,
        command_timeout: int = 1800,
        **fields: Any,
    ) -> RuntimeSandbox:
        """Return a backend on an existing sandbox, or on a new one.

        Args:
            sandbox_id: An existing sandbox to attach to, or `None` to create one.
            timeout: The new sandbox's lease in seconds (`timeout_seconds`).
            command_timeout: Default seconds for a command that names none.
            **fields: Create fields for a new sandbox, as `Sandbox.create`
                takes them: `funding`, `image`, `region`, `vcpu`, `memory_mib`,
                `name`, `labels` and the rest.

        Returns:
            A `RuntimeSandbox` on the sandbox.

        Raises:
            SandboxNotFoundError: `sandbox_id` names no sandbox in this account
                (`KeyError` when Deep Agents Code is not installed).
            TypeError: Create fields were passed with `sandbox_id`.
        """
        if sandbox_id is not None:
            if fields or timeout is not None:
                msg = f"Create fields apply only to a new sandbox: {sorted(fields) or ['timeout']}"
                raise TypeError(msg)
            try:
                sandbox = self.client.sandboxes.get(sandbox_id)
            except NotFoundError as error:
                raise _not_found(sandbox_id, error) from error
            return RuntimeSandbox(sandbox, timeout_seconds=command_timeout)
        if timeout is not None:
            fields["timeout_seconds"] = timeout
        sandbox = self.client.sandboxes.create(**fields)
        return RuntimeSandbox(sandbox, timeout_seconds=command_timeout)

    def delete(self, *, sandbox_id: str, **kwargs: Any) -> None:
        """Stop a sandbox. Its files go with it unless it was created persistent.

        Raises:
            SandboxNotFoundError: `sandbox_id` names no sandbox in this account
                (`KeyError` when Deep Agents Code is not installed).
            TypeError: Unsupported arguments were passed.
        """
        if kwargs:
            msg = f"Received unsupported arguments: {sorted(kwargs)}"
            raise TypeError(msg)
        try:
            self.client.sandboxes.get(sandbox_id).stop()
        except NotFoundError as error:
            raise _not_found(sandbox_id, error) from error

    async def aget_or_create(self, *, sandbox_id: str | None = None, **kwargs: Any) -> RuntimeSandbox:
        """Async `get_or_create`, on a worker thread."""
        import asyncio  # noqa: PLC0415

        return await asyncio.to_thread(self.get_or_create, sandbox_id=sandbox_id, **kwargs)

    async def adelete(self, *, sandbox_id: str, **kwargs: Any) -> None:
        """Async `delete`, on a worker thread."""
        import asyncio  # noqa: PLC0415

        await asyncio.to_thread(self.delete, sandbox_id=sandbox_id, **kwargs)
