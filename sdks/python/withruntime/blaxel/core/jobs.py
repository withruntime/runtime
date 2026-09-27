"""``blaxel.core.jobs`` on Runtime: the path Blaxel's docs import from, so replacing
``blaxel.`` with ``withruntime.blaxel.`` keeps working."""
from .. import BlJobWrapper  # noqa: F401
from .._core import unsupported_export

bl_job = unsupported_export("jobs", "Run the job as a process in a Runtime sandbox.")
