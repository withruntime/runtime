"""Runtime Cloud sandboxes for the OpenAI Agents SDK.

``RuntimeCloudSandboxClient`` is a sandbox client for ``SandboxAgent``, like
the SDK's Docker, E2B or Modal clients: every command, file edit and terminal
session the agent runs happens in a Runtime Cloud microVM with its own kernel.

The implementation lives in the ``withruntime`` SDK (``withruntime.openai_agents``)
so it is released and tested with the API it calls; this package gives it the
name the Agents SDK's users look for and installs both with the right versions.
"""
from withruntime.openai_agents import (
    RuntimeCloudSandboxClient,
    RuntimeCloudSandboxClientOptions,
    RuntimeCloudSandboxSession,
    RuntimeCloudSandboxSessionState,
)

__all__ = [
    "RuntimeCloudSandboxClient",
    "RuntimeCloudSandboxClientOptions",
    "RuntimeCloudSandboxSession",
    "RuntimeCloudSandboxSessionState",
]
__version__ = "0.1.0"
