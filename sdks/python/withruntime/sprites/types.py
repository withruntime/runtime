"""Sprites options import path."""
from . import URLSettings, ListOptions, SpriteConfig
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


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
