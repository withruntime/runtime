# Source: https://modal.com/docs/guide/sandbox-snapshots (https://modal.com/docs/guide/sandbox-snapshots.md),
# code block 18 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

app = modal.App.lookup("sandbox-snapshot-lifecycle", create_if_missing=True)
snapshot_store = modal.Dict.from_name("sandbox-snapshots", create_if_missing=True)
session_id = "sess_a1b2c3d4"

# Restore from snapshot, or use base image
if session_id in snapshot_store:
    image = modal.Image.from_id(snapshot_store[session_id])
else:
    image = modal.Image.debian_slim()

sb = modal.Sandbox.create(image=image, app=app)

# Run agent which exits when ready to be snapshotted
p = sb.exec("python", "agent.py")
p.wait()

# Snapshot and store the object_id
snapshot_store[session_id] = sb.snapshot_filesystem().object_id
sb.terminate()
