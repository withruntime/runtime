# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 33 (python fixture:sb_app), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

secret = modal.Secret.from_dict({"MY_SECRET": "hello"})

sb = modal.Sandbox.create(
    secrets=[secret],
    app=sb_app,
)
p = sb.exec("bash", "-c", "echo $MY_SECRET")
print(p.stdout.read())
