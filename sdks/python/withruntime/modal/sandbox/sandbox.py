"""``modal.sandbox.sandbox`` (modal 1.6.2), where ``SandboxFilesystem`` and
``SandboxSnapshot`` now live; ``modal.sandbox_fs`` and ``modal.snapshot`` stay
for code written against 1.6.0."""
from .. import Sandbox
from ..sandbox_fs import SandboxFilesystem
from ..snapshot import SandboxSnapshot

__all__ = ["Sandbox", "SandboxFilesystem", "SandboxSnapshot"]
