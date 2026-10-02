"""Sandbox request/value surface pinned to prime-sandboxes 0.4.1."""
from dataclasses import dataclass, field
from typing import Optional
from .._compat import Model


def _validate_egress_lists(allowlist, denylist):
    """Reject the same malformed host/IPv4 rules as prime-sandboxes 0.4.1."""
    import ipaddress
    if allowlist is not None and denylist is not None:
        raise ValueError("network_allowlist and network_denylist are mutually exclusive")
    for name, entries in (("network_allowlist", allowlist), ("network_denylist", denylist)):
        if entries is None:
            continue
        if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
            raise ValueError(f"{name} must be a list of strings")
        if len(entries) > 256:
            raise ValueError(f"{name} supports at most 256 entries")
        for entry in entries:
            value = entry.strip()
            if not value:
                raise ValueError(f"{name}: empty entry")
            try:
                address = ipaddress.ip_address(value)
            except ValueError:
                address = None
            if address is not None:
                if address.version != 4:
                    raise ValueError(f"{name}: IPv6 is not supported")
                continue
            if "/" in value:
                try:
                    network = ipaddress.ip_network(value, strict=False)
                except ValueError as error:
                    raise ValueError(f"{name}: invalid IPv4 CIDR") from error
                if network.version != 4:
                    raise ValueError(f"{name}: IPv6 is not supported")
                continue
            domain = value[2:] if value.startswith("*.") else value
            domain = domain.rstrip(".")
            if any(marker in value for marker in ("://", "@", ":", "?")) or not domain or "*" in domain or any(not label for label in domain.split(".")):
                raise ValueError(f"{name}: expected a hostname, leftmost wildcard, or IPv4 rule")


@dataclass
class StartCommand:
    executable: str
    args: list[str] = field(default_factory=list)

    def __post_init__(self):
        if not isinstance(self.executable, str) or not self.executable or "\x00" in self.executable:
            raise ValueError("executable must be a nonempty string without NUL")
        if not isinstance(self.args, list) or any(not isinstance(arg, str) or "\x00" in arg for arg in self.args):
            raise ValueError("args must be strings without NUL")


@dataclass
class CreateSandboxRequest:
    name: str
    docker_image: str
    start_command: Optional[StartCommand] = None
    cpu_cores: float = 1.0
    memory_gb: float = 1.0
    disk_size_gb: float = 5.0
    gpu_count: int = 0
    gpu_type: Optional[str] = None
    network_allowlist: Optional[list[str]] = None
    network_denylist: Optional[list[str]] = None
    timeout_minutes: int = 60
    idle_timeout_minutes: Optional[int] = None
    environment_vars: Optional[dict[str, str]] = None
    secrets: Optional[dict[str, str]] = None
    labels: list[str] = field(default_factory=list)
    team_id: Optional[str] = None
    region: Optional[str] = None
    advanced_configs: Optional[dict] = None
    idempotency_key: Optional[str] = None

    def __post_init__(self):
        if isinstance(self.start_command, dict):
            try:
                self.start_command = StartCommand(**self.start_command)
            except TypeError as error:
                raise ValueError("start_command accepts only executable and args") from error
        if self.start_command is not None and not isinstance(self.start_command, StartCommand):
            raise ValueError("start_command must be a StartCommand or mapping")
        if self.gpu_count > 0 and not self.gpu_type:
            raise ValueError("gpu_type is required when gpu_count is greater than 0")
        if self.gpu_count == 0 and self.gpu_type is not None:
            raise ValueError("gpu_type requires gpu_count greater than 0")
        _validate_egress_lists(self.network_allowlist, self.network_denylist)
        if self.idle_timeout_minutes is not None and (self.idle_timeout_minutes < 1 or
                self.timeout_minutes > 0 and self.idle_timeout_minutes > self.timeout_minutes):
            raise ValueError("idle_timeout_minutes must be positive and no greater than timeout_minutes")

    def model_dump(self, **kwargs):
        from dataclasses import asdict
        result = asdict(self)
        return {k: v for k, v in result.items() if not kwargs.get("exclude_none") or v is not None}


class _Value(Model):
    _required = ()
    _defaults = {}
    _aliases = {}
    _dates = ()
    _nested = {}
    _allow_extra = False

    def __init__(self, **data):
        import copy
        from datetime import datetime
        for name, alias in self._aliases.items():
            if alias in data:
                data[name] = data.pop(alias)
        missing = [name for name in self._required if name not in data]
        if missing:
            raise ValueError("Missing required fields: " + ", ".join(missing))
        allowed = {*self._required, *self._defaults}
        super().__init__({**copy.deepcopy(self._defaults), **{k: v for k, v in data.items() if self._allow_extra or k in allowed}})
        object.__setattr__(self, "_provided", set(data))
        for name, (kind, many) in self._nested.items():
            value = self.get(name)
            if value is None:
                continue
            model = globals()[kind]
            def convert(item):
                return item if isinstance(item, model) else model(**item)
            self[name] = [convert(item) for item in value] if many else convert(value)
        for name in self._dates:
            if isinstance(self.get(name), str):
                self[name] = datetime.fromisoformat(self[name].replace("Z", "+00:00"))

    @classmethod
    def model_validate(cls, value):
        return value if isinstance(value, cls) else cls(**value)

    @classmethod
    def model_validate_json(cls, value):
        import json
        return cls.model_validate(json.loads(value))

    def model_dump(self, *, by_alias=False, exclude_none=False, exclude_unset=False,
                   include=None, exclude=None, mode="python"):
        from datetime import datetime
        from enum import Enum
        def convert(value):
            if isinstance(value, _Value):
                return value.model_dump(by_alias=by_alias, exclude_none=exclude_none, mode=mode)
            if isinstance(value, StartCommand):
                from dataclasses import asdict
                return asdict(value)
            if isinstance(value, (list, tuple)):
                return [convert(item) for item in value]
            if isinstance(value, dict):
                return {key: convert(item) for key, item in value.items()}
            if mode == "json" and isinstance(value, datetime):
                return value.isoformat()
            if isinstance(value, Enum):
                return value.value if mode == "json" else value
            return value
        return {(self._aliases.get(key, key) if by_alias else key): convert(value)
                for key, value in self.items() if (not exclude_none or value is not None)
                and (not exclude_unset or key in self._provided)
                and (include is None or key in include) and (exclude is None or key not in exclude)}

    def model_copy(self, *, update=None, deep=False):
        import copy
        values = copy.deepcopy(dict(self)) if deep else dict(self)
        return type(self)(**{**values, **(update or {})})

    dict = model_dump


from enum import Enum
class SandboxStatus(str, Enum):
    PENDING = "PENDING"
    PROVISIONING = "PROVISIONING"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    ERROR = "ERROR"
    TERMINATED = "TERMINATED"
    TIMEOUT = "TIMEOUT"


class SandboxEgressPolicy(_Value):
    _required = ()
    _defaults = {'allowlist': None, 'denylist': None}
    _aliases = {}
    _dates = ()


class EgressPolicyStatus(_Value):
    _required = ('policy', 'generation', 'applied_generation', 'applied')
    _defaults = {}
    _aliases = {}
    _dates = ()
    _nested = {'policy': ('SandboxEgressPolicy', False)}


class SSHSession(_Value):
    _required = ('session_id', 'sandbox_id', 'host', 'port', 'expires_at', 'ttl_seconds')
    _defaults = {}
    _aliases = {}
    _dates = ('expires_at',)


class AdvancedConfigs(_Value):
    _required = ()
    _defaults = {}
    _aliases = {}
    _dates = ()
    _allow_extra = True


class Sandbox(_Value):
    _required = ('id', 'name', 'docker_image', 'cpu_cores', 'memory_gb', 'disk_size_gb', 'disk_mount_path', 'gpu_count', 'status', 'timeout_minutes', 'created_at', 'updated_at')
    _defaults = {'start_command': None, 'gpu_type': None, 'vm': False, 'network_allowlist': None, 'network_denylist': None, 'idle_timeout_minutes': None, 'termination_reason': None, 'environment_vars': None, 'secrets': None, 'advanced_configs': None, 'labels': [], 'started_at': None, 'terminated_at': None, 'exit_code': None, 'error_type': None, 'error_message': None, 'user_id': None, 'team_id': None, 'region': None, 'pending_image_build_id': None}
    _aliases = {'docker_image': 'dockerImage', 'start_command': 'startCommand', 'cpu_cores': 'cpuCores', 'memory_gb': 'memoryGB', 'disk_size_gb': 'diskSizeGB', 'disk_mount_path': 'diskMountPath', 'gpu_count': 'gpuCount', 'gpu_type': 'gpuType', 'network_allowlist': 'networkAllowlist', 'network_denylist': 'networkDenylist', 'timeout_minutes': 'timeoutMinutes', 'idle_timeout_minutes': 'idleTimeoutMinutes', 'termination_reason': 'terminationReason', 'environment_vars': 'environmentVars', 'secrets': 'secrets', 'advanced_configs': 'advancedConfigs', 'created_at': 'createdAt', 'updated_at': 'updatedAt', 'started_at': 'startedAt', 'terminated_at': 'terminatedAt', 'exit_code': 'exitCode', 'error_type': 'errorType', 'error_message': 'errorMessage', 'user_id': 'userId', 'team_id': 'teamId', 'pending_image_build_id': 'pendingImageBuildId'}
    _dates = ('created_at', 'updated_at', 'started_at', 'terminated_at')
    _nested = {'start_command': ('StartCommand', False), 'advanced_configs': ('AdvancedConfigs', False)}


class SandboxListResponse(_Value):
    _required = ('sandboxes', 'total', 'page', 'per_page', 'has_next')
    _defaults = {}
    _aliases = {'per_page': 'perPage', 'has_next': 'hasNext'}
    _dates = ()
    _nested = {'sandboxes': ('Sandbox', True)}


class SandboxStatusSnapshot(_Value):
    _required = ('sandbox_id', 'status')
    _defaults = {'error_type': None, 'error_message': None, 'pending_image_build_id': None}
    _aliases = {}
    _dates = ()

    def __init__(self, **data):
        super().__init__(**data)
        self['status'] = SandboxStatus(self['status'])


class SandboxStatusLookupError(_Value):
    _required = ('sandbox_id', 'code', 'message')
    _defaults = {}
    _aliases = {}
    _dates = ()

    def __init__(self, **data):
        super().__init__(**data)
        if self['code'] not in ('NOT_FOUND', 'FORBIDDEN', 'MANAGED'):
            raise ValueError("Invalid sandbox lookup error code")


class BatchSandboxStatusResponse(_Value):
    _required = ('statuses', 'errors')
    _defaults = {}
    _aliases = {}
    _dates = ()
    _nested = {'statuses': ('SandboxStatusSnapshot', True), 'errors': ('SandboxStatusLookupError', True)}


class CommandResponse(_Value):
    _required = ('stdout', 'stderr', 'exit_code')
    _defaults = {}
    _aliases = {}
    _dates = ()


class FileUploadResponse(_Value):
    _required = ('success', 'path', 'size', 'timestamp')
    _defaults = {}
    _aliases = {}
    _dates = ('timestamp',)


class ReadFileResponse(_Value):
    _required = ('content', 'size')
    _defaults = {'total_size': None, 'offset': None, 'truncated': None}
    _aliases = {}
    _dates = ()


class SandboxLogsResponse(_Value):
    _required = ('logs',)
    _defaults = {}
    _aliases = {}
    _dates = ()


class BulkDeleteSandboxRequest(_Value):
    _required = ()
    _defaults = {'sandbox_ids': None, 'labels': None, 'team_id': None, 'user_id': None, 'all_users': False}
    _aliases = {}
    _dates = ()


class BulkDeleteSandboxResponse(_Value):
    _required = ('succeeded', 'failed', 'message')
    _defaults = {}
    _aliases = {}
    _dates = ()


class BackgroundJob(_Value):
    _required = ('job_id', 'sandbox_id', 'stdout_log_file', 'stderr_log_file', 'exit_file')
    _defaults = {}
    _aliases = {}
    _dates = ()


class BackgroundJobStatus(_Value):
    _required = ('job_id', 'completed')
    _defaults = {'exit_code': None, 'stdout': None, 'stderr': None, 'stdout_error': None, 'stderr_error': None, 'stdout_truncated': False, 'stderr_truncated': False}
    _aliases = {}
    _dates = ()


class BackgroundJobStatusSnapshot(_Value):
    _required = ('sandbox_id', 'job_id', 'completed')
    _defaults = {'exit_code': None}
    _aliases = {}
    _dates = ()


class BackgroundJobStatusLookupError(_Value):
    _required = ('sandbox_id', 'job_id', 'code', 'message')
    _defaults = {}
    _aliases = {}
    _dates = ()

    def __init__(self, **data):
        super().__init__(**data)
        if self['code'] not in ('NOT_FOUND', 'FORBIDDEN', 'MANAGED', 'NOT_VM', 'NOT_RUNNING', 'RUNTIME_ERROR'):
            raise ValueError("Invalid background job lookup error code")


class BatchBackgroundJobStatusResponse(_Value):
    _required = ('statuses', 'errors')
    _defaults = {}
    _aliases = {}
    _dates = ()
    _nested = {'statuses': ('BackgroundJobStatusSnapshot', True), 'errors': ('BackgroundJobStatusLookupError', True)}
