from dataclasses import dataclass
from enum import Enum
from typing import Optional

class FileType(Enum):
    FILE = "file"
    DIRECTORY = "directory"
    SYMLINK = "symlink"

class FileWatchEventType(Enum):
    Unknown = "Unknown"
    Access = "Access"
    Create = "Create"
    Modify = "Modify"
    Remove = "Remove"

@dataclass(frozen=True)
class FileInfo:
    name: str
    path: str
    type: FileType
    size: int
    mode: int
    permissions: str
    owner: str
    group: str
    modified_time: float
    symlink_target: Optional[str]

    def is_file(self): return self.type == FileType.FILE
    def is_dir(self): return self.type == FileType.DIRECTORY
    def is_symlink(self): return self.type == FileType.SYMLINK

@dataclass
class FileWatchEvent:
    paths: list[str]
    type: FileWatchEventType
