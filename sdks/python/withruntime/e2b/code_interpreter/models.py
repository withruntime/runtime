"""Public E2B-compatible import surface."""
from . import Context, Execution, ExecutionError, Result, MIMEType, Logs, OutputHandler, OutputMessage, RunCodeLanguage

from ..exceptions import NotFoundException, SandboxException, TimeoutException


async def aextract_exception(res):
    if res.is_success:
        return None

    await res.aread()
    return extract_exception(res)


def extract_exception(res):
    if res.is_success:
        return None

    res.read()
    return format_exception(res)


def format_exception(res):
    if res.is_success:
        return None

    if res.status_code == 404:
        return NotFoundException(res.text)
    elif res.status_code == 502:
        return TimeoutException(
            f"{res.text}: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeout' when starting the sandbox or calling '.set_timeout' on the sandbox with the desired timeout."
        )
    else:
        body = res.text.strip()
        return SandboxException(
            f"{res.status_code} {res.reason_phrase}{f': {body}' if body else ''}"
        )
