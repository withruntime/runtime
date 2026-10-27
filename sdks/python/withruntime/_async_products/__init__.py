"""HOW A LANE ADDS A PRODUCT TO THE PYTHON SDK

1. Write withruntime/_async_products/<name>.py with an async class:

       class AsyncImages:
           def __init__(self, t): self._t = t
           async def create(self, **fields): return await self._t.json("POST", "/v1/images", body=fields)

   and, for methods on a sandbox (sbx.previews.create(3000)), a class taking (t, sandbox).
2. Add ONE line below: CLIENT["images"] = AsyncImages, or SANDBOX["previews"] = AsyncPreviews.
3. Run python3 scripts/generate_sync.py: the sync twin appears in _sync_products/.

Both Runtime and AsyncRuntime (and every Sandbox) install them with the shared
auth, retries, idempotency keys and typed errors.
"""
from typing import Any

from .agents import AsyncAgents
from .apps import AsyncApps, AsyncFunctions
from .audit import AsyncAudit
from .browser import AsyncBrowser
from .browsers import AsyncBrowsers
from .builds import AsyncBuilds
from .ci import AsyncCi
from .containers import AsyncContainers
from .desktop import AsyncDesktop
from .images import AsyncImages
from .jobs import AsyncJobs
from .mounts import AsyncMounts
from .interpreter import AsyncInterpreter
from .limits import AsyncLimits
from .mcp import AsyncMcp, AsyncSandboxMcp
from .network import AsyncNetwork
from .network_products import AsyncAccountNetwork, AsyncAddresses, AsyncDomains, AsyncPorts
from .observability import AsyncEvents, AsyncMetrics, AsyncOtel, AsyncWebhooks
from .plans import AsyncPlans
from .previews import AsyncPreviews
from .referrals import AsyncReferrals
from .reservations import AsyncReservations
from .billing import AsyncBilling
from .secrets import AsyncSecrets
from .sso import AsyncSso
from .switching import AsyncSwitching
from .tailscale import AsyncTailscale
from .volumes import AsyncVolumes

CLIENT: dict[str, Any] = {}
SANDBOX: dict[str, Any] = {}
CLIENT["images"] = AsyncImages
CLIENT["volumes"] = AsyncVolumes
CLIENT["jobs"] = AsyncJobs
CLIENT["apps"] = AsyncApps
CLIENT["functions"] = AsyncFunctions
CLIENT["builds"] = AsyncBuilds
CLIENT["ci"] = AsyncCi
CLIENT["containers"] = AsyncContainers
CLIENT["agents"] = AsyncAgents
CLIENT["browsers"] = AsyncBrowsers
CLIENT["referrals"] = AsyncReferrals
CLIENT["plans"] = AsyncPlans
CLIENT["billing"] = AsyncBilling
CLIENT["limits"] = AsyncLimits
CLIENT["reservations"] = AsyncReservations
CLIENT["sso"] = AsyncSso
CLIENT["switching"] = AsyncSwitching
CLIENT["secrets"] = AsyncSecrets
CLIENT["webhooks"] = AsyncWebhooks
CLIENT["otel"] = AsyncOtel
CLIENT["events"] = AsyncEvents
CLIENT["audit"] = AsyncAudit
CLIENT["mcp"] = AsyncMcp
CLIENT["domains"] = AsyncDomains
CLIENT["ports"] = AsyncPorts
CLIENT["ips"] = AsyncAddresses
CLIENT["networks"] = AsyncAccountNetwork
SANDBOX["interpreter"] = AsyncInterpreter
SANDBOX["previews"] = AsyncPreviews
SANDBOX["network"] = AsyncNetwork
SANDBOX["desktop"] = AsyncDesktop
SANDBOX["browser"] = AsyncBrowser
SANDBOX["mounts"] = AsyncMounts
SANDBOX["tailscale"] = AsyncTailscale
SANDBOX["metrics"] = AsyncMetrics
SANDBOX["mcp"] = AsyncSandboxMcp
