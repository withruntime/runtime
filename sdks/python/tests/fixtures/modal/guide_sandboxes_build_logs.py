# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 41 (python fixture:sb_app), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

image = modal.Image.debian_slim().pip_install("pandas", "numpy")

with modal.enable_output():
    sb = modal.Sandbox.create(image=image, app=sb_app)
