"""``blaxel.core.secret`` on Runtime (blaxel 0.4.18): the path Blaxel's docs
import from. Blaxel's workspace secrets are refused, naming Runtime secrets."""
from .. import SecretAPIError, SecretInstance, SyncSecretInstance  # noqa: F401

__all__ = ["SecretInstance", "SyncSecretInstance", "SecretAPIError"]
