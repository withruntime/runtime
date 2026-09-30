"""Filesystem snapshot inputs, without silently changing image retention."""
import builtins
from .._compat import CompatibilityError, positive
from .exception import InvalidError


def plan(timeout, ttl):
    try:
        positive(timeout, 'timeout')
    except (TypeError, ValueError) as error:
        raise InvalidError(str(error)) from error
    if ttl is None:
        raise CompatibilityError('Indefinite Modal image retention requires indefinite native snapshot retention')
    if isinstance(ttl, bool) or not isinstance(ttl, int) or ttl <= 0:
        raise InvalidError('ttl must be a positive integer or None')
    if ttl % 86400 or not 1 <= ttl // 86400 <= 365:
        raise CompatibilityError('Modal snapshot ttl currently requires a whole number of days from 1 to 365')
    return {'mode': 'disk', 'retention_days': ttl // 86400}


def translate(error):
    from .exception import TimeoutError, ExecutionError
    if isinstance(error, builtins.TimeoutError) or getattr(error, 'code', None) in ('snapshot_timeout', 'request_timeout'):
        return TimeoutError('Filesystem snapshot exceeded its timeout')
    if getattr(error, 'code', None) in ('snapshot_failed', 'snapshot_mode_mismatch'):
        return ExecutionError(str(error))
    return error


def checked(snapshot):
    if snapshot.get('mode') != 'disk':
        raise CompatibilityError('Modal filesystem-only snapshots cannot substitute a memory snapshot')
    return snapshot
