"""modal.Secret as values written to the sandbox's 0600 environment file."""
from __future__ import annotations
import os
from .._compat import CompatibilityError
from ._dual import classproperty, install
from ._object import _Object
from .exception import InvalidError

NAMED = ("Runtime secrets are used without being seen: runtime.secrets.set(name, value=..., hosts=[...]); "
         "or pass the values with Secret.from_dict")
WRONG_TYPE = "the env_dict argument to Secret has to be a dict[str, Union[str, None]]"


def _checked(values):
    if not isinstance(values, dict):
        raise InvalidError(WRONG_TYPE)
    kept = {key: value for key, value in values.items() if value is not None}
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in kept.items()):
        raise InvalidError(WRONG_TYPE)
    return kept


def _walk_up(path):
    current = os.path.abspath(path)
    if os.path.isfile(current):
        current = os.path.dirname(current)
    while True:
        yield current
        parent = os.path.dirname(current)
        if parent == current:
            return
        current = parent


class Secret(_Object):
    def __init__(self, values=None, *, load=None, client=None):
        self._loaded = None if values is None else dict(values)
        self._loader, self._client = load, client

    @property
    def _values(self):
        if self._loaded is None:
            self._loaded = _checked(self._loader())
        return self._loaded

    def _load(self, runtime):
        self._values

    async def _load_aio(self, runtime):
        self._values

    @property
    def name(self):
        return None

    @property
    def object_id(self):
        raise CompatibilityError("A Secret's values go straight into the sandbox; Runtime keeps no secret object "
                                 "for it. " + NAMED)

    @classproperty
    def objects(cls):
        raise CompatibilityError(NAMED)

    @staticmethod
    def from_dict(env_dict={}):
        return Secret(_checked(env_dict))

    @staticmethod
    def from_local_environ(env_keys):
        missing = [key for key in env_keys if key not in os.environ]
        if missing:
            raise InvalidError(f"Could not find local environment variable '{missing[0]}' for Secret.from_local_environ")
        return Secret.from_dict({key: os.environ[key] for key in env_keys})

    @staticmethod
    def from_dotenv(path=None, *, filename=".env", client=None):
        def load():
            try:
                from dotenv import dotenv_values, find_dotenv
            except ImportError:
                raise ImportError("Need the `dotenv` package installed. You can install it by running "
                                  "`pip install python-dotenv`.") from None
            if path is not None:
                found = next((os.path.join(folder, filename) for folder in _walk_up(os.fspath(path))
                              if os.path.isfile(os.path.join(folder, filename))), "")
            else:
                found = find_dotenv(filename, usecwd=True)
            return {key: value or "" for key, value in dotenv_values(found).items()}
        return Secret(load=load, client=client)

    @staticmethod
    def from_name(name, *, environment_name=None, required_keys=[], client=None):
        """In a scheduled function's job: each of ``required_keys`` is bound
        from the Runtime jobs secret of that name. A sandbox has no named
        secrets to read."""
        if not required_keys:
            raise CompatibilityError(NAMED + ". For a scheduled function run as a job, name its variables with "
                                     "required_keys=[...]: each is the Runtime jobs secret of that name")

        def load():
            raise CompatibilityError(NAMED)
        secret = Secret(load=load, client=client)
        secret._job_keys = list(required_keys)
        return secret

    def info(self):
        raise CompatibilityError(NAMED)

    def update(self, env_dict):
        raise CompatibilityError(NAMED)


install(Secret, ("info", "update"), refused=True)
install(Secret, ("from_name",), static=("from_name",))
