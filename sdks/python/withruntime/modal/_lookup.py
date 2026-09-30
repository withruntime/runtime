"""Shared Modal name and tag semantics over Runtime resource metadata."""
import json
from .exception import InvalidError


def tags(info):
    labels = info.get("labels", {})
    if "modal.tags" in labels:
        return json.loads(labels["modal.tags"])
    return {key: value for key, value in labels.items()
            if not key.startswith("modal.") and key != "compat.provider"}


def validate_tags(value):
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        raise InvalidError("Tags must be a mapping of strings to strings")
    return value


def validate_environment(environment_name):
    if environment_name is not None:
        from .._compat import CompatibilityError
        raise CompatibilityError("Modal environment namespaces are not Runtime account namespaces")
