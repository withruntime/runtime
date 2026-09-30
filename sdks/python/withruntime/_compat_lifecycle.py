"""Serialize adapter lifecycle operations across handles sharing one client."""
import asyncio
import threading
import weakref

_guard = threading.Lock()
_sync = weakref.WeakKeyDictionary()
_async = weakref.WeakKeyDictionary()


def _get(store, runtime, resource_id, factory):
    with _guard:
        locks = store.setdefault(runtime, {})
        if resource_id not in locks:
            locks[resource_id] = factory()
        return locks[resource_id]


def LifecycleLock(runtime, resource_id):
    return _get(_sync, runtime, resource_id, threading.RLock)


def AsyncLifecycleLock(runtime, resource_id):
    return _get(_async, runtime, resource_id, asyncio.Lock)
