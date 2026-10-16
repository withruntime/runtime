"""Public E2B-compatible import surface."""
from . import AuthenticationException, FileNotFoundException, GitAuthException, GitUpstreamException, BuildException, FileUploadException, InvalidArgumentException, NotEnoughSpaceException, NotFoundException, RateLimitException, ServiceBusyException, SandboxException, SandboxNotFoundException, SandboxNotRunningException, SandboxUnreachableException, TemplateException, TimeoutException, VolumeException, VolumeNotFoundException, VolumePathNotFoundException, SecretException, SecretNotFoundException


SANDBOX_NOT_FOUND_MESSAGE = "was not found"
SANDBOX_PORT_NOT_OPEN_MESSAGE = "port is not open"


def is_sandbox_not_found_message(message: str) -> bool:
    return SANDBOX_NOT_FOUND_MESSAGE in message


def is_sandbox_port_not_open_message(message: str) -> bool:
    return SANDBOX_PORT_NOT_OPEN_MESSAGE in message


def format_sandbox_unavailable_exception(message: str) -> Exception:
    """Map a 502/UNAVAILABLE answered by the proxy in front of envd: the sandbox was
    not found (killed or reached its timeout) is a ``SandboxNotRunningException``;
    the sandbox running but envd's port not open (e.g. its network is down) a
    ``SandboxUnreachableException``; any other message (e.g. envd ending a stream
    because the connection to the sandbox was lost) a ``SandboxUnreachableException``
    too, with the sandbox state reported as unknown."""
    if is_sandbox_not_found_message(message):
        return SandboxNotRunningException(
            f"{message}: The sandbox was killed or reached its timeout. You can modify the sandbox timeout by passing 'timeout' when starting the sandbox or calling '.set_timeout' on the sandbox with the desired timeout."
        )
    if is_sandbox_port_not_open_message(message):
        return SandboxUnreachableException(
            f"{message}: The sandbox is running but envd inside it could not be reached (e.g. its network is down). Check the sandbox state with 'Sandbox.get_info()'."
        )
    return SandboxUnreachableException(
        f"{message}: The sandbox could not be reached and its state is unknown — it may have been killed or reached its timeout, or the connection to it was lost. Check the sandbox state with 'Sandbox.get_info()'."
    )
