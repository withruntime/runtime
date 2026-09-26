"""Code written for Vercel Sandbox's Python SDK, on Runtime Cloud. Change the
import:

    from withruntime.vercel import sandbox  # was: from vercel import sandbox
    from withruntime.vercel.sandbox import sync as sandbox  # was: from vercel.sandbox import sync as sandbox

and set RUNTIME_API_KEY, or run `npx withruntime login` once. A Vercel token is
never sent anywhere. What Runtime cannot do the way Vercel does raises
NotSupportedError, naming what to use."""
from . import api, sandbox

__all__ = ["api", "sandbox"]
