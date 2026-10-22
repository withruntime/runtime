# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 61 (python fixture:sb_app), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sandbox_v1_1 = modal.Sandbox.create("sleep", "10", app=sb_app)
sandbox_v1_2 = modal.Sandbox.create("sleep", "20", app=sb_app)

sandbox_v1_1.set_tags({"major_version": "1", "minor_version": "1"})
sandbox_v1_2.set_tags({"major_version": "1", "minor_version": "2"})

for sandbox in modal.Sandbox.list(app_id=sb_app.app_id):  # All sandboxes.
    print(sandbox.object_id)

for sandbox in modal.Sandbox.list(
    app_id=sb_app.app_id,
    tags={"major_version": "1"},
):  # Also all sandboxes.
    print(sandbox.object_id)

for sandbox in modal.Sandbox.list(
    app_id=sb_app.app_id,
    tags={"major_version": "1", "minor_version": "2"},
):  # Just the latest sandbox.
    print(sandbox.object_id)
