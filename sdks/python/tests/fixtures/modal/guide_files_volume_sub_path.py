# Source: https://modal.com/docs/guide/sandbox-files (https://modal.com/docs/guide/sandbox-files.md),
# code block 11 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb_app = modal.App.lookup("my-app", create_if_missing=True)

vol = modal.Volume.from_name("shared-volume", create_if_missing=True)

# Each Sandbox only sees its own subdirectory of the Volume.
sb = modal.Sandbox.create(
    volumes={"/data": vol.with_mount_options(sub_path="/users/user_123")},
    app=sb_app,
)
# /data inside the Sandbox maps to /users/user_123 in the Volume.
# The Sandbox cannot see or modify files belonging to other users.
p = sb.exec("bash", "-c", "echo hello > /data/output.txt")
p.wait()
sb.terminate(wait=True)
