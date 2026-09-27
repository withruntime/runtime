"""``blaxel.core.client.api.images`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from ...._core import api_call

list_images = api_call("list_images")
list_image_tags = api_call("list_image_tags")
