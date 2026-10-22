# Source: https://modal.com/docs/guide/sandbox-networking (https://modal.com/docs/guide/sandbox-networking.md),
# code block 13 (python notest), read 18 October 2026.
# Copied verbatim; the only change is Modal's import, to `from withruntime import modal`.
# Modal's guide runs its blocks with modal already imported, so the import is added.
# Names the page leaves to its reader (app, my_app, sb_app) are given by the live runner,
# as Modal's docs harness gives `fixture:sb_app`: an App from modal.App.lookup.

from withruntime import modal

sb = modal.Sandbox.create(
    "python", "-m", "http.server", "8080",
    encrypted_ports=[8080],
    inbound_cidr_allowlist=["203.0.113.0/24"],
    app=app,
)
