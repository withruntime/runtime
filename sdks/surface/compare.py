"""sdks/release.sh surface: whether NEW keeps every method OLD has, with arguments a caller of OLD still passes.
Python: by keyword, and positional only where OLD took it positionally; Ruby: the same over its parameter kinds.
"""
import json
import sys

old, new = (json.load(open(p)) for p in sys.argv[1:3])
breaks = []
for k, a in old.items():
    if k not in new:
        breaks.append(f"{k}: removed")
        continue
    b = new[k]
    if "params" not in a or "params" not in b:
        continue
    bp = {p[0]: p for p in b["params"]}
    rest = any(p[1] in ("VAR_KEYWORD", "keyrest") for p in b["params"])
    pos = lambda ps: [p[0] for p in ps if p[1] in ("POSITIONAL_ONLY", "POSITIONAL_OR_KEYWORD", "req", "opt")]
    if pos(b["params"])[: len(pos(a["params"]))] != pos(a["params"]):
        breaks.append(f"{k}: positional arguments {pos(a['params'])} became {pos(b['params'])}")
    for p in a["params"]:
        if p[0] not in bp and not rest and p[1] not in ("VAR_POSITIONAL", "rest", "block"):
            breaks.append(f"{k}: argument {p[0]} removed")
    names = {p[0] for p in a["params"]}
    for p in b["params"]:
        if p[2] and p[0] not in names and p[1] in ("POSITIONAL_OR_KEYWORD", "KEYWORD_ONLY", "POSITIONAL_ONLY", "req", "keyreq"):
            breaks.append(f"{k}: new required argument {p[0]}")
print("\n".join(breaks))
sys.exit(1 if breaks else 0)
