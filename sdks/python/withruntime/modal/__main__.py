"""``python -m withruntime.modal deploy app.py``: Modal's ``modal deploy
app.py``, making each function with a schedule a Runtime job."""
import importlib.util
import os
import sys

from ._functions import deploy


def main(argv):
    if len(argv) < 2 or argv[0] != "deploy" or argv[1] in ("-h", "--help"):
        print("usage: python -m withruntime.modal deploy <app file>[::<app variable>]\n\n"
              "Each @app.function(schedule=modal.Cron(...) or modal.Period(...)) becomes a Runtime job on that\n"
              "schedule; deploying again updates the jobs in place. Needs RUNTIME_API_KEY.")
        return 0 if argv[1:2] in (["-h"], ["--help"]) else 2
    path, _, variable = argv[1].partition("::")
    path = os.path.abspath(path)
    sys.path.insert(0, os.path.dirname(path))
    spec = importlib.util.spec_from_file_location(os.path.splitext(os.path.basename(path))[0], path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from .app import App
    apps = [value for key, value in vars(module).items()
            if isinstance(value, App) and (not variable or key == variable)]
    if not apps:
        print(f"{argv[1]} defines no modal.App", file=sys.stderr)
        return 2
    for app in apps:
        deploy(app, path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
