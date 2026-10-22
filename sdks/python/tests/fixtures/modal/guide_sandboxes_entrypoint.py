# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 45 (python fixture:sb_app), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb = modal.Sandbox.create("python", "-m", "http.server", "8080", app=sb_app, timeout=10)
for line in sb.stdout:
    print(line, end="")
