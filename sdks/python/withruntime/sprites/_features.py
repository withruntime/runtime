"""Checkpoints, network policy, sessions, URL settings and file stats on
Runtime: the translations both the sync and the async client use."""
from datetime import datetime
import math
import posixpath
from .._compat import CompatibilityError
from .types import Checkpoint, FileStat, NetworkPolicy, PolicyRule, Session, StreamMessage

CHECKPOINT_TIMEOUT = 300.0

# Sprites serves a sprite's URL from port 8080.
SPRITE_PORT = 8080

RESTORE = ("Runtime does not restore a sandbox in place; start a new sandbox from the checkpoint: "
           "runtime.sandboxes.create(snapshot=<checkpoint id>)")
SERVICES = ("Sprites services have no Runtime equivalent; run it as a process with sprite.command(...) "
            "or an image start command")
CONTROL = "Sprites control mode is not available on Runtime; sprite.command(...) runs each command directly"
TOKEN = "Fly macaroon token exchange is not available on Runtime; create a Runtime API key in the console"
HTTP_CLIENT = "The Sprites HTTP client is not available on Runtime; use the Runtime client"


def _time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


# ---- checkpoints: Runtime disk snapshots of the sprite's sandbox ----

def checkpoint_seconds(timeout):
    """Seconds, or an httpx.Timeout's read deadline, as sprites-py accepts."""
    value = getattr(timeout, "read", timeout)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise CompatibilityError("A Sprites checkpoint timeout must be a finite number of seconds on Runtime")
    return float(value)


def checkpoint_labels(sandbox_id, comment):
    if comment is None:
        comment = ""
    if not isinstance(comment, str):
        raise TypeError("comment must be a string")
    labels = {"compat.sprite": sandbox_id}
    if comment:
        labels["compat.comment"] = comment
    return labels


def is_checkpoint(snapshot, sandbox_id):
    return (snapshot.get("sourceSandboxId") == sandbox_id and snapshot.get("mode") == "disk"
            and snapshot.get("state") not in ("failed", "deleting", "deleted"))


def checkpoint(snapshot):
    return Checkpoint(id=snapshot["id"], create_time=_time(snapshot.get("createdAt")) or datetime.now(),
                      comment=(snapshot.get("labels") or {}).get("compat.comment"), history=[])


def created(snapshot):
    if snapshot.get("mode") != "disk":
        raise CompatibilityError("Runtime answered with a memory snapshot; a Sprites checkpoint is disk only")
    return CheckpointStream([StreamMessage(type="info", data=f"Checkpoint {snapshot['id']} created"),
                             StreamMessage(type="complete", data=snapshot["id"])])


def failed(error):
    return CheckpointStream([StreamMessage(type="error", error=str(error))])


class CheckpointStream:
    """The messages of a finished checkpoint, as sprites-py's stream iterates them."""

    def __init__(self, messages):
        self._messages, self._index = list(messages), 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._index >= len(self._messages):
            raise StopIteration
        self._index += 1
        return self._messages[self._index - 1]

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


# ---- network policy: Sprites rules as Runtime's internet, allow and deny ----

def _covers(deny, allow):
    """Whether a deny rule matches every host an allow rule names."""
    deny, allow = deny.lower(), allow.lower()
    return deny == allow or (deny.startswith("*.") and allow.endswith(deny[1:]))


def runtime_rules(policy):
    """Sprites: [] allows everything; the most specific rule wins. Runtime: allow,
    when not empty, is the only reachable set, and deny always wins. A policy
    whose meaning would change between the two is refused."""
    rules = getattr(policy, "rules", None)
    if not isinstance(rules, (list, tuple)):
        raise TypeError("policy must be a NetworkPolicy")
    allow, deny, every = [], [], set()
    for rule in rules:
        domain, action, include = (getattr(rule, "domain", None), getattr(rule, "action", None),
                                   getattr(rule, "include", None))
        if include is not None:
            raise CompatibilityError("Sprites policy presets (include) have no Runtime equivalent; "
                                     "list the domains as rules")
        if not isinstance(domain, str) or not domain:
            raise CompatibilityError("Each Sprites policy rule needs a domain on Runtime")
        if action not in ("allow", "deny"):
            raise CompatibilityError(f"Sprites policy action {action!r} has no Runtime equivalent; use allow or deny")
        if domain == "*":
            every.add(action)
        elif domain not in (allow if action == "allow" else deny):
            (allow if action == "allow" else deny).append(domain)
    if len(every) == 2:
        raise CompatibilityError("A Sprites policy cannot both allow and deny every domain")
    for allowed in allow:
        for denied in deny:
            if _covers(denied, allowed):
                raise CompatibilityError(f"Sprites lets {allowed} through the deny rule {denied}; on Runtime a deny "
                                         "always wins. Remove one of the two rules")
    if "deny" in every and not allow:
        return {"internet": False, "allow": [], "deny": deny}
    return {"internet": True, "allow": [] if "allow" in every else allow, "deny": deny}


def sprites_policy(rules):
    if not rules.get("internet", True):
        return NetworkPolicy(rules=[PolicyRule(domain="*", action="deny")])
    allow = [PolicyRule(domain=domain, action="allow") for domain in rules.get("allow") or []]
    deny = [PolicyRule(domain=domain, action="deny") for domain in rules.get("deny") or []]
    return NetworkPolicy(rules=allow + deny + ([PolicyRule(domain="*", action="deny")] if allow else []))


def network_fields(rules, current):
    """Runtime's connect pairs are not Sprites rules: a policy update keeps them."""
    connect = current.get("connect")
    return {**rules, "connect": connect} if connect else rules


# ---- sessions: Runtime processes that are running ----

def sessions(processes):
    return [Session(id=info["id"], command=info.get("command", ""), workdir=info.get("cwd", ""),
                    created=_time(info.get("startedAt")) or datetime.now(), bytes_per_second=0,
                    is_active=True, tty=bool(info.get("pty")), last_activity=None)
            for info in processes if info.get("state") == "running"]


# ---- URL settings: a Runtime preview of port 8080 ----

def visibility(settings):
    if getattr(settings, "private_access", None) is not None:
        raise CompatibilityError("Sprites private_access has no Runtime equivalent; a private Runtime preview "
                                 "needs its token")
    auth = getattr(settings, "auth", None)
    if auth not in ("public", "sprite"):
        raise ValueError("url_settings.auth must be public or sprite")
    return "public" if auth == "public" else "private"


def preview_url(preview):
    return preview.get("urlWithToken") or preview.get("url")


def paused(error):
    return getattr(error, "code", None) == "sandbox_paused"


# ---- files ----

def file_stat(info, path):
    mode = info.get("mode", "0644")
    return FileStat(name=info.get("name") or posixpath.basename(path), path=info.get("path") or path,
                    size=info.get("size") or 0, mode=format(mode, "04o") if isinstance(mode, int) else str(mode),
                    mod_time=_time(info.get("modifiedAt")) or datetime.now(), is_dir=info.get("type") == "directory")


def copy_args(source, target, recursive):
    return ["cp", "-p", *(["-R"] if recursive else []), "--", source, target]
