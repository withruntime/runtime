"""``blaxel.core.client.api.workspaces`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from ...._core import api_call

create_workspace = api_call("create_workspace")
delete_workspace = api_call("delete_workspace")
