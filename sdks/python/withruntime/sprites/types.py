"""Sprites data types, with sprites-py 0.7.2's fields and defaults."""
from . import URLSettings, ListOptions, SpriteConfig
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional


@dataclass
class ClientOptions:
    base_url: str = "https://api.sprites.dev"
    timeout: float = 30.0


@dataclass
class SpawnOptions:
    cwd: Optional[str] = None
    env: Optional[Dict[str, str]] = None
    tty: bool = False
    rows: int = 24
    cols: int = 80
    detachable: bool = False
    session_id: Optional[str] = None
    control_mode: bool = False


@dataclass
class ExecOptions(SpawnOptions):
    encoding: str = "utf-8"
    max_buffer: int = 10 * 1024 * 1024


@dataclass
class ExecResult:
    stdout: bytes
    stderr: bytes
    exit_code: int


@dataclass
class SpriteInfo:
    id: str
    name: str
    organization: str
    status: str
    config: Optional[SpriteConfig] = None
    environment: Optional[dict[str, str]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    bucket_name: Optional[str] = None
    primary_region: Optional[str] = None
    url: Optional[str] = None
    url_settings: Optional[URLSettings] = None
    version: Optional[str] = None
    environment_version: Optional[str] = None
    labels: list[str] = field(default_factory=list)
    last_running_at: Optional[datetime] = None
    last_warming_at: Optional[datetime] = None


@dataclass
class SpriteList:
    sprites: list[SpriteInfo]
    has_more: bool
    next_continuation_token: Optional[str] = None
    running: int = 0
    warm: int = 0
    cold: int = 0


@dataclass
class Session:
    id: str
    command: str
    workdir: str
    created: datetime
    bytes_per_second: float
    is_active: bool
    tty: bool
    last_activity: Optional[datetime] = None


@dataclass
class Checkpoint:
    id: str
    create_time: datetime
    comment: Optional[str] = None
    history: Optional[List[str]] = None


@dataclass
class StreamMessage:
    type: str
    data: Optional[str] = None
    error: Optional[str] = None


@dataclass
class PortMapping:
    local_port: int
    remote_port: int
    remote_host: str = "localhost"


@dataclass
class Service:
    name: str
    cmd: str
    args: List[str] = field(default_factory=list)
    needs: List[str] = field(default_factory=list)
    http_port: Optional[int] = None
    env: Dict[str, str] = field(default_factory=dict)
    dir: Optional[str] = None


@dataclass
class ServiceState:
    name: str
    status: str
    pid: Optional[int] = None
    started_at: Optional[datetime] = None
    error: Optional[str] = None
    restart_count: int = 0
    next_restart_at: Optional[datetime] = None


@dataclass
class ServiceWithState(Service):
    state: Optional[ServiceState] = None


@dataclass
class ServiceRequest:
    cmd: str
    args: Optional[List[str]] = None
    needs: Optional[List[str]] = None
    http_port: Optional[int] = None
    env: Optional[Dict[str, str]] = None
    dir: Optional[str] = None


@dataclass
class ServiceLogEvent:
    type: str
    data: Optional[str] = None
    exit_code: Optional[int] = None
    timestamp: int = 0
    log_files: Optional[Dict[str, str]] = None


@dataclass
class PolicyRule:
    domain: Optional[str] = None
    action: Optional[str] = None
    include: Optional[str] = None


@dataclass
class NetworkPolicy:
    rules: List[PolicyRule] = field(default_factory=list)


@dataclass
class FileStat:
    name: str
    path: str
    size: int
    mode: str
    mod_time: datetime
    is_dir: bool

    @property
    def is_file(self) -> bool:
        return not self.is_dir


@dataclass
class DirEntry:
    name: str
    path: str
    is_dir: bool
    size: int = 0
    mode: str = "0644"
    mod_time: Optional[datetime] = None

    @property
    def is_file(self) -> bool:
        return not self.is_dir
