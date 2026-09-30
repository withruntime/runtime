"""Disk snapshot consumers, metadata fencing, and clone behavior on a local model.

Native cold-boot behavior is covered by the host tests; this fixture deliberately
models disk-only copies and rejects any accidental memory snapshot request.
"""
import asyncio
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from withruntime.runloop import RunloopSDK, Runloop, AsyncRunloopSDK
from withruntime.runloop import _snapshots
from withruntime.modal import Sandbox as Modal
from withruntime._compat import CompatibilityError
from withruntime._errors import RuntimeError as NativeError


class RuntimeFixture:
    def __init__(self, **values): self.__dict__.update(values)


class World:
    def __init__(self):
        self.calls, self.saved = [], {}
        self.source = Box(self, 'source', {'/workspace/data': b'bytes'})
        self.runtime = RuntimeFixture(sandboxes=SimpleNamespace(get=lambda _: self.source, create=self.create),
            snapshots=SimpleNamespace(get=self.get, update=self.update, delete=self.delete))
    def get(self, snapshot): return copy.deepcopy(self.saved[snapshot])
    def update(self, snapshot, **fields):
        before = self.saved[snapshot]
        if fields.get('if_labels') != before.get('labels'):
            raise NativeError('changed', code='snapshot_metadata_changed', status=409)
        before['labels'] = fields['labels']
        return self.get(snapshot)
    def delete(self, snapshot): self.saved[snapshot]['state'] = 'deleted'
    def create(self, **options):
        self.calls.append(('create', options))
        data = copy.deepcopy(self.saved[options['snapshot']]['files'])
        return Box(self, 'clone', data)


class Box:
    def __init__(self, world, id, files):
        self.world, self.id, self.info = world, id, {'id': id, 'labels': {}}
        self.data, self.processes = files, []
        self.files = SimpleNamespace(write=lambda path, data, **kw: files.__setitem__(path, data))
    def snapshot(self, **options):
        if options['mode'] != 'disk': raise AssertionError('memory snapshot substituted')
        self.world.calls.append(('snapshot', options))
        value = {'id': 'im-snapshot', 'mode': 'disk', 'state': 'ready', 'createdAt': '2026-09-29T12:00:00Z',
                 'sourceSandboxId': self.id, 'meteredBytes': 10, 'labels': options.get('labels') or {},
                 'files': copy.deepcopy(self.data)}
        self.world.saved[value['id']] = value
        return copy.deepcopy(value)


class DiskSnapshots(unittest.TestCase):
    def test_runloop_snapshot_metadata_clone_and_low_level_shapes(self):
        world = World()
        sdk = RunloopSDK(runtime=world.runtime)
        snapshot = sdk.devbox.from_id('source').snapshot_disk(name='checkpoint', metadata={'branch': 'main'}, commit_message='😀' * 300)
        result = snapshot.get_info()
        self.assertEqual(result.status, 'complete')
        self.assertEqual(result.snapshot.commit_message, '😀' * 300)
        updated = snapshot.update(name='renamed')
        self.assertEqual(updated.metadata, {'branch': 'main'})
        self.assertEqual(updated.name, 'renamed')
        clone = snapshot.create_devbox()
        self.assertEqual(clone.id, 'clone')
        self.assertEqual(world.calls[-1][1]['snapshot'], snapshot.id)
        raw = Runloop(runtime=world.runtime).devboxes.snapshot_disk('source', name='low-level')
        self.assertEqual(raw.source_devbox_id, 'source')
        self.assertFalse(hasattr(raw, 'status'))
        self.assertEqual(sdk.snapshot.from_id(snapshot.id).id, snapshot.id)
        snapshot.delete()
        self.assertEqual(snapshot.get_info().status, 'deleted')

    def test_snapshot_update_retries_without_losing_concurrent_fields(self):
        world = World()
        snapshot = RunloopSDK(runtime=world.runtime).devbox.from_id('source').snapshot_disk(name='old')
        real, calls = world.runtime.snapshots.update, []
        def update(id, **fields):
            calls.append(fields)
            if len(calls) == 1:
                world.saved[id]['labels'] = _snapshots.options(name='concurrent', metadata={'writer': 'other'})['labels']
                raise NativeError('changed', code='snapshot_metadata_changed', status=409)
            return real(id, **fields)
        world.runtime.snapshots.update = update
        result = snapshot.update(commit_message='saved')
        self.assertEqual((result.name, result.metadata), ('concurrent', {'writer': 'other'}))
        self.assertEqual(len(calls), 2)

    def test_memory_clone_and_oversized_metadata_refused_before_create(self):
        world = World()
        sdk = RunloopSDK(runtime=world.runtime)
        world.saved['memory'] = {'mode': 'memory'}
        with self.assertRaises(CompatibilityError): sdk.devbox.create_from_snapshot('memory')
        with self.assertRaises(CompatibilityError): sdk.devbox.from_id('source').snapshot_disk(metadata={'a': 'x' * 10000})
        self.assertEqual(world.calls, [])

    def test_modal_image_snapshot_default_ttl_and_disk_clone(self):
        world = World()
        sandbox = Modal(world.runtime, world.source)
        image = sandbox.snapshot_filesystem()
        self.assertEqual(image.object_id, 'im-snapshot')
        self.assertEqual(world.calls[0][1], {'mode': 'disk', 'retention_days': 30})
        clone = Modal.create(image=image, client=world.runtime)
        self.assertEqual(clone._sandbox.data, world.source.data)
        self.assertEqual(clone._sandbox.processes, [])
        before = len(world.calls)
        for ttl in (None, 60):
            with self.assertRaises(CompatibilityError): sandbox.snapshot_filesystem(ttl=ttl)
        self.assertEqual(len(world.calls), before)

    def test_async_snapshot_image_and_runloop_same_contract(self):
        async def run():
            world = World()
            async def snapshot(**options): return world.source.snapshot(**options)
            async_box = SimpleNamespace(id='source', info={}, snapshot=snapshot)
            async def get(_): return async_box
            async def read(id): return world.get(id)
            runtime = RuntimeFixture(sandboxes=SimpleNamespace(get=get), snapshots=SimpleNamespace(get=read))
            snap = await AsyncRunloopSDK(runtime=runtime).devbox.from_id('source').snapshot_disk(name='async')
            self.assertEqual((await snap.get_info()).snapshot.name, 'async')
            sandbox = Modal(runtime, async_box)
            sandbox._async_mode = True
            image = await sandbox.snapshot_filesystem.aio(ttl=86400)
            self.assertEqual(image.object_id, snap.id)
            self.assertEqual(world.calls[-1][1]['retention_days'], 1)
        asyncio.run(run())

    def test_snapshot_catalog_pages_filter_provider_and_preserve_cursor(self):
        world = World()
        sdk = RunloopSDK(runtime=world.runtime)
        sdk.devbox.from_id('source').snapshot_disk(metadata={'key': 'keep'})
        base = world.saved.pop('im-snapshot')
        for number in range(5):
            value = copy.deepcopy(base)
            value['id'] = str(number)
            world.saved[value['id']] = value
        world.saved['3']['mode'] = 'memory'
        world.saved['4']['labels']['compat.provider'] = 'other'
        world.runtime.snapshots.list = lambda **kw: list(world.saved.values())
        page = sdk.api.devboxes.disk_snapshots.list(limit=2, metadata_key='keep')
        self.assertEqual([item.id for item in page.snapshots], ['0', '1'])
        self.assertEqual(page.total_count, 3)
        self.assertTrue(page.has_next_page())
        self.assertEqual([item.id for item in page], ['0', '1', '2'])
        self.assertEqual([item.id for item in sdk.snapshot.list(limit=2)], ['0', '1'])
        with self.assertRaisesRegex(ValueError, 'starting_after'):
            sdk.api.devboxes.disk_snapshots.list(starting_after='absent')

    def test_runloop_generated_twin_stays_current(self):
        path = Path(__file__).parents[1] / 'scripts/generate_runloop_sync.py'
        spec = importlib.util.spec_from_file_location('runloop_generator', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual((module.ROOT / '_sync.py').read_text(), module.generate())
