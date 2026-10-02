"""GENERATED from _async_products/__init__.py by scripts/generate_sync.py. Do not edit."""
from typing import Any

from .audit import Audit
from .browser import Browser
from .desktop import Desktop
from .images import Images
from .jobs import Jobs
from .mounts import Mounts
from .interpreter import Interpreter
from .limits import Limits
from .mcp import Mcp, SandboxMcp
from .network import Network
from .network_products import AccountNetwork, Addresses, Domains, Ports, Tunnel
from .observability import Events, Metrics, Otel, Webhooks
from .previews import Previews
from .referrals import Referrals
from .billing import Billing
from .secrets import Secrets
from .sso import Sso
from .switching import Switching
from .tailscale import Tailscale
from .volumes import Volumes

CLIENT: dict[str, Any] = {}
SANDBOX: dict[str, Any] = {}
CLIENT["images"] = Images
CLIENT["volumes"] = Volumes
CLIENT["jobs"] = Jobs
CLIENT["referrals"] = Referrals
CLIENT["billing"] = Billing
CLIENT["limits"] = Limits
CLIENT["sso"] = Sso
CLIENT["switching"] = Switching
CLIENT["secrets"] = Secrets
CLIENT["webhooks"] = Webhooks
CLIENT["otel"] = Otel
CLIENT["events"] = Events
CLIENT["audit"] = Audit
CLIENT["mcp"] = Mcp
CLIENT["domains"] = Domains
CLIENT["ports"] = Ports
CLIENT["addresses"] = Addresses
CLIENT["tunnel"] = Tunnel
CLIENT["network"] = AccountNetwork
SANDBOX["interpreter"] = Interpreter
SANDBOX["previews"] = Previews
SANDBOX["network"] = Network
SANDBOX["desktop"] = Desktop
SANDBOX["browser"] = Browser
SANDBOX["mounts"] = Mounts
SANDBOX["tailscale"] = Tailscale
SANDBOX["metrics"] = Metrics
SANDBOX["mcp"] = SandboxMcp
