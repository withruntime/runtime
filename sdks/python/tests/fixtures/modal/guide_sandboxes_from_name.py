# Source: https://modal.com/docs/guide/sandboxes (https://modal.com/docs/guide/sandboxes.md),
# code block 57 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb_app = modal.App.lookup("my-app", create_if_missing=True)
sb1 = modal.Sandbox.create(app=sb_app, name="my-name")
# Returns the currently running Sandbox with the name "my-name" from the
# deployed App named "my-app".
sb2 = modal.Sandbox.from_name("my-app", "my-name")
assert sb1.object_id == sb2.object_id # sb1 and sb2 refer to the same Sandbox
