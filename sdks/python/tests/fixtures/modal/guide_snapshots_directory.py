# Source: https://modal.com/docs/guide/sandbox-snapshots (https://modal.com/docs/guide/sandbox-snapshots.md),
# code block 8 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb = modal.Sandbox.create(app=app)
# Write some dummy data
sb.exec("bash", "-c", "mkdir /project && echo 'data' > /project/file.txt").wait()

# Snapshot the directory
snapshot = sb.snapshot_directory("/project")

# Ok to throw away the old Sandbox at this point
sb.terminate()

# Mount the snapshot in a new Sandbox
sb2 = modal.Sandbox.create(app=app)
try:
    sb2.mount_image("/project", snapshot)
except modal.exception.NotFoundError:
    # Handle a potential ttl expiry of the old snapshot here
    ...

# The Sandbox now has access to the previous project state
assert sb2.exec("cat", "/project/file.txt").stdout.read().strip() == "data"

