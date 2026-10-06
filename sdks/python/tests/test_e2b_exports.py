"""Every name e2b 2.52.1 exports (its ``__all__``, read 5 October 2026) imports
from withruntime.e2b, and from withruntime.e2b.code_interpreter as
e2b_code_interpreter 2.10.1 re-exports them: an import that fails stops code
written for E2B before it runs a line. Until then 79 were missing. The modules
E2B defines them in import too: until 6 October 2026, 31 of 36 did not."""
import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import withruntime.e2b as e2b  # noqa: E402
import withruntime.e2b.code_interpreter as code_interpreter  # noqa: E402

E2B_2_52_1 = """
ALL_TRAFFIC ApiClient ApiParams AsyncCommandHandle AsyncSandbox AsyncSandboxPaginator AsyncSecret
AsyncSecretPaginator AsyncSnapshotPaginator AsyncTemplate AsyncVolume AsyncWatchHandle AuthenticationException
BuildException BuildInfo BuildStatusReason CommandExitException CommandHandle CommandResult ConnectionConfig
CopyItem E2B E2BClientParams EntryInfo FileNotFoundException FileType FileUploadException FilesystemEvent
FilesystemEventType Git GitAuthException GitBranches GitFileStatus GitHubMcpServer GitHubMcpServerConfig
GitResetMode GitStatus GitUpstreamException HttpVersion InvalidArgumentException LogEntry LogEntryEnd
LogEntryLevel LogEntryStart McpServer NotEnoughSpaceException NotFoundException OutputHandler ProcessInfo
ProxyTypes PtyOutput PtySize RateLimitException ReadyCmd Sandbox SandboxEgressProxyInfo SandboxEgressProxyOpts
SandboxException SandboxIamOpts SandboxIamToken SandboxIamTokenType SandboxInfo SandboxInfoLifecycle
SandboxLifecycle SandboxListOrder SandboxMetrics SandboxNetworkInfo SandboxNetworkOpts SandboxNetworkRule
SandboxNetworkRuleInfo SandboxNetworkRules SandboxNetworkSelector SandboxNetworkSelectorContext
SandboxNetworkTransform SandboxNetworkTransformContext SandboxNetworkTransformResolver SandboxNetworkUpdate
SandboxNotFoundException SandboxOnResume SandboxOnTimeout SandboxPaginator SandboxQuery SandboxState Secret
SecretException SecretInfo SecretNotFoundException SecretPaginator ServiceBusyException SnapshotInfo
SnapshotPaginator Stderr Stdout Template TemplateBase TemplateBuildStatus TemplateBuildStatusResponse
TemplateClass TemplateException TemplateTag TemplateTagInfo TimeoutException Username Volume VolumeAndToken
VolumeApiParams VolumeConnectionConfig VolumeEntryStat VolumeException VolumeFileType VolumeInfo
VolumeNotFoundException VolumePathNotFoundException WatchHandle WriteInfo client default_build_logger
get_signature wait_for_file wait_for_port wait_for_process wait_for_timeout wait_for_url
""".split()

# The modules e2b 2.52.1's own __init__ imports those names from, and
# e2b_code_interpreter 2.10.1's: code that imports a name from where E2B defines
# it (``from e2b.exceptions import TimeoutException``) keeps working when only
# ``e2b`` becomes ``withruntime.e2b``. Leaves out api, client and sandbox._git,
# which are E2B's HTTP internals and a private module.
E2B_PATHS = {
    "connection_config": "ApiParams ConnectionConfig HttpVersion ProxyTypes Username",
    "volume.connection_config": "VolumeApiParams VolumeConnectionConfig",
    "exceptions": "AuthenticationException FileNotFoundException GitAuthException GitUpstreamException BuildException"
    " FileUploadException InvalidArgumentException NotEnoughSpaceException NotFoundException RateLimitException"
    " ServiceBusyException SandboxException SandboxNotFoundException TemplateException TimeoutException VolumeException"
    " VolumeNotFoundException VolumePathNotFoundException SecretException SecretNotFoundException",
    "sandbox.commands.command_handle": "CommandExitException CommandResult PtyOutput PtySize Stderr Stdout",
    "sandbox.commands.main": "ProcessInfo",
    "sandbox.filesystem.filesystem": "EntryInfo FileType WriteInfo WriteEntry",
    "sandbox.filesystem.watch_handle": "FilesystemEvent FilesystemEventType",
    "sandbox_sync.git": "Git",
    "sandbox.network": "ALL_TRAFFIC",
    "sandbox.signature": "get_signature",
    "sandbox.sandbox_api": "GitHubMcpServer McpServer SandboxInfo SandboxMetrics SandboxNetworkOpts SandboxNetworkUpdate"
    " SandboxQuery SandboxState SnapshotInfo SandboxLifecycle SandboxListOrder",
    "sandbox_async.commands.command_handle": "AsyncCommandHandle",
    "sandbox_async.filesystem.filesystem": "WriteEntry",
    "sandbox_async.filesystem.watch_handle": "AsyncWatchHandle",
    "sandbox_async.main": "AsyncSandbox",
    "sandbox_async.paginator": "AsyncSandboxPaginator AsyncSnapshotPaginator",
    "sandbox_async.utils": "OutputHandler",
    "secret": "AsyncSecret AsyncSecretPaginator Secret SecretInfo SecretPaginator",
    "sandbox_sync.commands.command_handle": "CommandHandle",
    "sandbox_sync.filesystem.filesystem": "WriteEntry",
    "sandbox_sync.filesystem.watch_handle": "WatchHandle",
    "sandbox_sync.main": "Sandbox",
    "sandbox_sync.paginator": "SandboxPaginator SnapshotPaginator",
    "template.logger": "LogEntry LogEntryEnd LogEntryLevel LogEntryStart default_build_logger",
    "template.main": "TemplateBase TemplateClass",
    "template.readycmd": "ReadyCmd wait_for_file wait_for_port wait_for_process wait_for_timeout wait_for_url",
    "template.types": "BuildInfo BuildStatusReason CopyItem TemplateBuildStatus TemplateTag TemplateTagInfo",
    "template_async.main": "AsyncTemplate",
    "template_sync.main": "Template",
    "volume.volume_sync": "Volume",
    "volume.volume_async": "AsyncVolume",
    "volume.types": "VolumeInfo VolumeAndToken VolumeEntryStat VolumeFileType",
    "code_interpreter.code_interpreter_sync": "Sandbox",
    "code_interpreter.code_interpreter_async": "AsyncSandbox",
    "code_interpreter.models": "Context Execution ExecutionError Result MIMEType Logs OutputMessage RunCodeLanguage",
}


class Exports(unittest.TestCase):
    def test_every_e2b_name_imports(self):
        self.assertEqual([name for name in E2B_2_52_1 if not hasattr(e2b, name)], [])
        self.assertEqual([name for name in E2B_2_52_1 if name not in e2b.__all__], [])

    def test_the_code_interpreter_re_exports_them(self):
        names = [*E2B_2_52_1, "RunCodeLanguage"]
        self.assertEqual([name for name in names if not hasattr(code_interpreter, name)], [])
        self.assertEqual([name for name in names if name not in code_interpreter.__all__], [])

    def test_every_name_imports_from_the_module_e2b_defines_it_in(self):
        missing = []
        for path, names in E2B_PATHS.items():
            top = code_interpreter if path.startswith("code_interpreter.") else e2b
            try:
                module = importlib.import_module(f"withruntime.e2b.{path}")
            except ImportError:
                missing.append(path)
                continue
            for name in names.split():
                expected = sys.modules["withruntime.e2b._core"].WriteEntry if name == "WriteEntry" else getattr(top, name)
                if getattr(module, name, None) is not expected:
                    missing.append(f"{path}.{name}")
        self.assertEqual(missing, [])

    def test_write_entry_is_the_typed_dict_write_files_takes(self):
        from withruntime.e2b.sandbox.filesystem.filesystem import WriteEntry
        self.assertEqual(WriteEntry(path="a.txt", data="hi"), {"path": "a.txt", "data": "hi"})
        self.assertEqual(set(WriteEntry.__annotations__), {"path", "data"})

    def test_the_new_errors_keep_e2b_parents(self):
        self.assertTrue(issubclass(e2b.GitAuthException, e2b.AuthenticationException))
        self.assertTrue(issubclass(e2b.GitUpstreamException, e2b.SandboxException))
        self.assertTrue(issubclass(e2b.FileUploadException, e2b.BuildException))
        self.assertTrue(issubclass(e2b.VolumeNotFoundException, e2b.NotFoundException))
        self.assertTrue(issubclass(e2b.VolumePathNotFoundException, e2b.NotFoundException))
        self.assertTrue(issubclass(e2b.SecretNotFoundException, e2b.SecretException))
        self.assertEqual((e2b.ALL_TRAFFIC, e2b.SandboxState.RUNNING.value), ("0.0.0.0/0", "running"))

    def test_what_would_act_says_what_to_use(self):
        with self.assertRaises(e2b.NotSupportedException) as caught:
            e2b.Git()
        self.assertIn("commands.run", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
