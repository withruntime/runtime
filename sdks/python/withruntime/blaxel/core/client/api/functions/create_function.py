"""``blaxel.core.client.api.functions.create_function`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from ....._core import api_call

asyncio = asyncio_detailed = sync = sync_detailed = api_call("create_function")
