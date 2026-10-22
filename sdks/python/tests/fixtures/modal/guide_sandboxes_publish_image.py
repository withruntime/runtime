# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 37 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

# build_sandbox_image.py
app = modal.App.lookup("sandbox-app", create_if_missing=True)

# Method-chained image
image = modal.Image.debian_slim().pip_install("pandas")

# Or, for an external registry image with a fixed tag:
# image = modal.Image.from_registry("ubuntu:24.04")

with modal.enable_output():
    image.build(app=app).publish("sandbox-runtime")

# sandbox_app.py
app = modal.App.lookup("sandbox-app", create_if_missing=True)

image = modal.Image.from_name("sandbox-runtime")
modal.Sandbox.create(app=app, image=image)
