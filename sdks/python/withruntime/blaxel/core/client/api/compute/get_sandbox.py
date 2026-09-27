"""``blaxel.core.client.api.compute.get_sandbox`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from ....._core import api_call

asyncio = asyncio_detailed = sync = sync_detailed = api_call("get_sandbox")
