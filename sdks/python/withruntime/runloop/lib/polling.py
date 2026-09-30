from dataclasses import dataclass
from typing import Optional


@dataclass
class PollingConfig:
    interval_seconds: float = 1.0
    max_attempts: int = 120
    timeout_seconds: Optional[float] = None


class PollingTimeout(Exception):
    def __init__(self, message, last_value):
        self.last_value = last_value
        super().__init__(f"{message}. Last retrieved value: {last_value}")
