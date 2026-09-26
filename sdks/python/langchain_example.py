"""Use this tool in LangChain create_agent or a LangGraph ToolNode."""
from langchain_core.tools import tool
from withruntime import Sandbox


def runtime_tool(sandbox: Sandbox):
    """One tool bound to a sandbox the application created: the model picks the
    command, never the sandbox or the tenant."""
    @tool
    def runtime_exec(command: str) -> dict:
        """Run a shell command in the application's Runtime sandbox; returns exitCode, stdout and stderr."""
        return sandbox.exec(command).to_dict()
    return runtime_exec
