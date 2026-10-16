"""modal.App as a label on the sandboxes created with it."""
from __future__ import annotations
from .._compat import CompatibilityError, reject
from ._dual import install

NO_APP = "Runtime sandboxes need no deployed app: create them with Sandbox.create(app=app)"


class App:
    def __init__(self, name=None):
        self._name, self._description = name, name

    @property
    def name(self):
        return self._name

    @property
    def app_id(self):
        return self._name

    @property
    def description(self):
        return self._description

    @description.setter
    def description(self, value):
        self._description = value

    @staticmethod
    def lookup(name, *, client=None, environment_name=None, create_if_missing=False, **options):
        reject(options, "Modal App.lookup")
        if environment_name is not None:
            raise CompatibilityError("Modal environment namespaces are not Runtime account namespaces")
        return App(name)

    def get_dashboard_url(self):
        raise CompatibilityError("Runtime has no app page; each sandbox has one at https://withruntime.com/account")

    def run(self, *, name=None, client=None, detach=False, interactive=False, environment_name=None):
        raise CompatibilityError(NO_APP)

    def deploy(self, *, name=None, environment_name=None, tag="", client=None, strategy="rolling"):
        raise CompatibilityError(NO_APP)

    def include(self, other_app, inherit_tags=True):
        raise CompatibilityError(NO_APP)

    def set_tags(self, tags, *, client=None):
        raise CompatibilityError("Runtime has no app object to tag: tag the sandboxes with Sandbox.set_tags")

    def get_tags(self, *, client=None):
        raise CompatibilityError("Runtime has no app object to tag: read a sandbox's with Sandbox.get_tags")

    def info(self, refresh=False):
        raise CompatibilityError(NO_APP)

    @property
    def logs(self):
        raise CompatibilityError("Read a sandbox's output from sandbox.stdout and sandbox.stderr")

    @property
    def registered_functions(self):
        raise CompatibilityError(NO_APP)

    @property
    def registered_classes(self):
        raise CompatibilityError(NO_APP)

    @property
    def registered_entrypoints(self):
        raise CompatibilityError(NO_APP)

    @property
    def registered_web_endpoints(self):
        raise CompatibilityError(NO_APP)


install(App, ("get_dashboard_url", "run", "deploy", "set_tags", "get_tags", "info"), refused=True)
install(App, ("lookup",), static=("lookup",))
