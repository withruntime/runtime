"""Sprites metadata and deterministic, filter-scoped listing cursors."""
import base64
from datetime import datetime
import json
from . import SpriteConfig
from .types import SpriteInfo, SpriteList


def _time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def info(sandbox):
    data = sandbox.info
    return SpriteInfo(id=sandbox.id, name=data.get("name") or sandbox.id,
        organization=data.get("accountId", ""), status={"paused": "cold"}.get(sandbox.state, sandbox.state),
        config=SpriteConfig(cpus=data.get("vcpu"), ram_mb=data.get("memoryMiB"),
                            storage_gb=data["diskMiB"] / 1024 if "diskMiB" in data else None,
                            region=data.get("region")),
        created_at=_time(data.get("createdAt")), updated_at=_time(data.get("updatedAt")),
        primary_region=data.get("region"), labels=json.loads(data.get("labels", {}).get("compat.labels", "[]")))


def populate(sprite, sandbox):
    value = info(sandbox)
    for name, data in vars(value).items():
        setattr(sprite, "organization_name" if name == "organization" else name, data)
    return sprite


def page(sandboxes, options):
    after = None
    if options.continuation_token:
        try:
            cursor = json.loads(base64.urlsafe_b64decode(options.continuation_token.encode()))
            if cursor["v"] != 1 or cursor["prefix"] != options.prefix:
                raise ValueError()
            after = cursor["after"]
            if not isinstance(after, list) or len(after) != 2 or any(not isinstance(x, str) for x in after):
                raise ValueError()
        except (ValueError, KeyError, TypeError, UnicodeError) as error:
            raise ValueError("Invalid Sprites continuation token for this prefix") from error
    limit = options.max_results
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0):
        raise ValueError("max_results must be a positive integer")
    values = [info(sb) for sb in sandboxes if not options.prefix or (sb.info.get("name") or sb.id).startswith(options.prefix)]
    values.sort(key=lambda item: (item.name, item.id))
    remaining = [item for item in values if after is None or [item.name, item.id] > after]
    selected = remaining if limit is None else remaining[:limit]
    more = len(selected) < len(remaining)
    token = None
    if more:
        last = selected[-1]
        token = base64.urlsafe_b64encode(json.dumps({"v": 1, "prefix": options.prefix,
            "after": [last.name, last.id]}, separators=(",", ":")).encode()).decode()
    return SpriteList(sprites=selected, has_more=more, next_continuation_token=token,
        running=sum(item.status == "running" for item in values),
        warm=sum(item.status == "warm" for item in values), cold=sum(item.status == "cold" for item in values))


def labels(value):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("labels must be a list of strings")
    return json.dumps(value)
