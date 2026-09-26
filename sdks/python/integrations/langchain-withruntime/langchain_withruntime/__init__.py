"""Runtime sandbox integration for LangChain Deep Agents.

Runtime (https://withruntime.com) runs each sandbox in a Firecracker microVM.
`RuntimeSandbox` is a Deep Agents `BaseSandbox`, so the agent's `execute`,
`ls`, `read_file`, `write_file`, `edit_file`, `glob` and `grep` tools run in
the sandbox::

    from deepagents import create_deep_agent
    from withruntime import Sandbox

    from langchain_withruntime import RuntimeSandbox

    with Sandbox.create() as sbx:
        agent = create_deep_agent(backend=RuntimeSandbox(sbx))

The backend is maintained in the Runtime SDK as `withruntime.deepagents`; this
package installs it under the `langchain-<provider>` name the other Deep Agents
sandbox packages use, and adds `RuntimeProvider`, which creates and stops
sandboxes for Deep Agents Code (`dcode --sandbox runtime`).
"""

from withruntime.deepagents import RuntimeSandbox

from langchain_withruntime._version import __version__
from langchain_withruntime.provider import RuntimeProvider

__all__ = ["RuntimeProvider", "RuntimeSandbox", "__version__"]
