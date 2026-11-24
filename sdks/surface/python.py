"""sdks/release.sh surface: Python. Prints the package's public surface as JSON: each class's methods and their
parameters, and each name it exports; run once in an environment with the published package, once with the built."""
import dataclasses
import inspect
import json

import withruntime

out = {}
for n in sorted(getattr(withruntime, "__all__", dir(withruntime))):
    o = getattr(withruntime, n, None)
    if not inspect.isclass(o):
        out[n] = {"value": True}
        continue
    for m, v in inspect.getmembers(o):
        # A record's constructor is the SDK's to call, by keyword: its fields' order is no caller's contract.
        if (m.startswith("_") and m != "__init__") or (m == "__init__" and dataclasses.is_dataclass(o)):
            continue
        if not callable(v) or inspect.isclass(v):
            out[f"{n}.{m}"] = {"attr": True}
            continue
        try:
            sig = inspect.signature(v)
        except (TypeError, ValueError):
            continue
        out[f"{n}.{m}"] = {"params": [[p.name, p.kind.name, p.default is inspect.Parameter.empty] for p in sig.parameters.values()]}
print(json.dumps(out))
