"""``blaxel.pydantic`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from . import bl_model, bl_tools  # noqa: F401
