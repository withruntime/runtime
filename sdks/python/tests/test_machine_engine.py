"""The machine engine's client is written once for every product that runs
code (CLOUD.md section 2): ``Machine`` and ``Machines`` hold the shared verbs,
and a product names its path and adds what only it does. A second product
built on them reaches only its own paths, so nothing shared is a sandbox in
disguise, and the sandbox product still reaches /v1/sandboxes through them."""
import asyncio
import unittest
from withruntime._async_client import AsyncMachine, AsyncMachines, AsyncSandbox, AsyncSandboxes
from withruntime._errors import RuntimeError
from withruntime._sync_client import Machine, Machines, Sandbox, Sandboxes


class Server(Machine):
    _plural = "servers"
    _noun = "Server"


class Servers(Machines[Server]):
    _machine = Server


class AsyncServer(AsyncMachine):
    _plural = "servers"
    _noun = "Server"


class AsyncServers(AsyncMachines[AsyncServer]):
    _machine = AsyncServer


def answer(calls, method, path, state):
    calls.append(f"{method} {path}")
    if method == "GET" and path.endswith("s"):
        return {"data": [{"id": "m1", "state": state}], "nextCursor": None}
    if method == "DELETE":
        return {"id": "m1"}
    if path.endswith(":snapshot"):
        return {"id": "snap1", "state": "ready"}
    return {"id": "m1", "state": state}


class Transport:
    wait_for_capacity = 0.0

    def __init__(self, state="running"):
        self.calls, self.state = [], state

    def json(self, method, path, **kwargs):
        return answer(self.calls, method, path, self.state)


class AsyncTransport(Transport):
    async def json(self, method, path, **kwargs):
        return answer(self.calls, method, path, self.state)


class MachineEngine(unittest.TestCase):
    def test_a_second_product_reaches_only_its_own_paths(self):
        t = Transport()
        servers = Servers(t)
        server = servers.create(name="web")
        self.assertIsInstance(server, Server)
        servers.get("m1")
        servers.get_or_create("web")
        self.assertEqual([s.id for s in servers.list(labels={"app": "web"})], ["m1"])
        server.refresh()
        server.wait_for("running")
        server.update(name="api")
        server.extend(60)
        server.set_retention(7)
        server.switch_image("ubuntu")
        server.resize(vcpu=2)
        server.pause()
        server.wake()
        server.restart()
        server.stop()
        server.snapshot()
        server.delete()
        servers.delete("m1")
        self.assertEqual(servers.stop_all(labels={"app": "web"}), {"stopped": ["m1"], "failed": []})
        for call in t.calls:
            self.assertRegex(call, r" /v1/(servers|snapshots)\b")
        for call in ("POST /v1/servers", "POST /v1/servers/m1:resize", "POST /v1/servers/m1:snapshot",
                     "DELETE /v1/servers/m1"):
            self.assertIn(call, t.calls)
        self.assertEqual(repr(server), "Server(id='m1', state='running')")

    def test_its_refusals_name_it(self):
        servers = Servers(Transport("stopped"))
        with self.assertRaises(RuntimeError) as caught:
            servers.create()
        self.assertEqual(str(caught.exception.args[0]), "Server m1 is stopped, not running.")
        self.assertEqual(caught.exception.hint, "Read it with runtime.servers.get(id); stopReason says why.")
        with self.assertRaises(RuntimeError) as caught:
            servers.stop_all(labels={})
        self.assertEqual(caught.exception.hint, "Stop one server with server.stop(), or label the ones to stop together.")

    def test_async_reaches_its_own_paths_too(self):
        t = AsyncTransport()

        async def run():
            server = await AsyncServers(t).create(name="web")
            await server.stop()
            return server
        self.assertIsInstance(asyncio.run(run()), AsyncServer)
        self.assertEqual(t.calls, ["POST /v1/servers", "POST /v1/servers/m1:stop"])

    def test_the_sandbox_product_is_the_engine_with_its_path_and_words(self):
        t = Transport("stopped")
        with self.assertRaises(RuntimeError) as caught:
            Sandboxes(t).create()
        self.assertEqual(str(caught.exception.args[0]), "Sandbox m1 is stopped, not running.")
        sandbox = Sandboxes(t).get("m1")
        self.assertIsInstance(sandbox, Sandbox)
        sandbox.stop()
        self.assertEqual(t.calls, ["POST /v1/sandboxes", "GET /v1/sandboxes/m1", "GET /v1/sandboxes/m1",
                                   "POST /v1/sandboxes/m1:stop"])
        self.assertEqual(repr(sandbox), "Sandbox(id='m1', state='stopped')")
        self.assertIs(AsyncSandboxes._machine, AsyncSandbox)


if __name__ == "__main__":
    unittest.main()
