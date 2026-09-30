"""Durable snapshot metadata shared byte-for-byte with the TypeScript adapter."""
from datetime import datetime
import json
from .._compat import CompatibilityError, Model

PREFIX = 'compat.runloop.snapshot.'


def options(name=None, metadata=None, commit_message=None):
    if name is not None and not isinstance(name, str):
        raise TypeError('name must be a string')
    if commit_message is not None and (not isinstance(commit_message, str) or len(commit_message.encode('utf-16-le')) // 2 > 1000):
        raise TypeError('commit_message must be a string of at most 1000 characters')
    if metadata is not None and (not isinstance(metadata, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in metadata.items())):
        raise TypeError('metadata must contain string keys and values')
    payload = json.dumps({'name': name, 'metadata': metadata or {}, 'commit_message': commit_message}, ensure_ascii=False, separators=(',', ':'))
    parts, chunk, count = [], '', 0
    for char in payload:
        size = len(char.encode('utf-16-le')) // 2
        if count + size > 256:
            parts.append(chunk)
            chunk, count = '', 0
        chunk, count = chunk + char, count + size
    if chunk: parts.append(chunk)
    if len(parts) > 31:
        raise CompatibilityError("Runloop snapshot metadata exceeds Runtime's 31 label chunks")
    labels = {'compat.provider': 'runloop', **{PREFIX + str(i).zfill(2): part for i, part in enumerate(parts)}}
    if len(json.dumps(labels, ensure_ascii=False).encode()) > 4096:
        raise CompatibilityError("Runloop snapshot metadata exceeds Runtime's 4096-byte label bound")
    return {'mode': 'disk', 'labels': labels}


def view(snapshot):
    if snapshot.get('mode') != 'disk':
        raise CompatibilityError('Runloop disk snapshots cannot restore memory snapshots')
    labels = snapshot.get('labels') or {}
    payload = ''.join(labels[key] for key in sorted(labels) if key.startswith(PREFIX))
    body = json.loads(payload) if payload else {'name': snapshot.get('name'), 'metadata': {k: v for k, v in labels.items() if not k.startswith('compat.')}}
    created = datetime.fromisoformat(snapshot['createdAt'].replace('Z', '+00:00'))
    return Model(id=snapshot['id'], create_time_ms=int(created.timestamp() * 1000),
                 metadata=body.get('metadata') or {}, source_devbox_id=snapshot['sourceSandboxId'],
                 commit_message=body.get('commit_message'), name=body.get('name'),
                 size_bytes=snapshot.get('meteredBytes'), source_blueprint_id=snapshot.get('sourceImageId'))


def status(snapshot):
    return Model(status={'ready': 'complete', 'failed': 'error', 'deleted': 'deleted', 'deleting': 'deleted'}.get(snapshot['state'], 'in_progress'),
                 error_message=snapshot.get('error'), snapshot=view(snapshot))
