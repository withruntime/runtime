"""modal.FilePatternMatcher: Docker's .dockerignore matching, run locally."""
from __future__ import annotations
import os
import re
from functools import cached_property
from pathlib import Path


class Pattern:
    """One cleaned pattern, matched as Docker's patternmatcher does."""

    def __init__(self, cleaned_pattern, exclusion=False):
        self.cleaned_pattern, self.exclusion = cleaned_pattern, exclusion
        self.dirs = cleaned_pattern.split(os.path.sep)
        self.regexp = re.compile(_regex(cleaned_pattern, os.path.sep))

    def __str__(self):
        return self.cleaned_pattern

    def match(self, path):
        return self.regexp.match(path) is not None


def _regex(pattern, separator):
    sep = re.escape(separator)
    out, i = "^", 0
    while i < len(pattern):
        char = pattern[i]
        if char == "*":
            if pattern[i + 1:i + 2] == "*":
                i += 1
                if pattern[i + 1:i + 2] == separator:
                    i += 1
                out += ".*" if i + 1 == len(pattern) else f"(.*{sep})?"
            else:
                out += f"[^{sep}]*"
        elif char == "?":
            out += f"[^{sep}]"
        elif char == "\\" and i + 1 < len(pattern):
            i += 1
            out += re.escape(pattern[i])
        elif char in "[]":
            out += char
        else:
            out += re.escape(char)
        i += 1
    return out + "$"


class _AbstractPatternMatcher:
    def __invert__(self):
        return _CustomPatternMatcher(lambda path: not self(path))

    def can_prune_directories(self):
        return False

    def __call__(self, path):
        raise NotImplementedError


class _CustomPatternMatcher(_AbstractPatternMatcher):
    def __init__(self, predicate):
        self._predicate = predicate

    def __call__(self, path):
        return self._predicate(path)


class FilePatternMatcher(_AbstractPatternMatcher):
    def __init__(self, *pattern):
        self._pattern_strings, self._file_path = pattern, None

    @classmethod
    def from_file(cls, file_path):
        instance = cls.__new__(cls)
        instance._pattern_strings, instance._file_path = None, file_path
        return instance

    @cached_property
    def patterns(self):
        lines = (Path(self._file_path).read_text("utf8").splitlines() if self._file_path is not None
                 else list(self._pattern_strings or []))
        parsed = []
        for line in lines:
            line = line.strip().strip(os.path.sep)
            if not line or line.startswith("#"):
                continue
            line = os.path.normpath(line)
            exclusion = line.startswith("!")
            if exclusion:
                line = line[1:]
                if not line:
                    raise ValueError('Illegal exclusion pattern: "!"')
            parsed.append(Pattern(line, exclusion))
        return parsed

    def can_prune_directories(self):
        return not any(pattern.exclusion for pattern in self.patterns)

    def __call__(self, file_path):
        path = os.path.normpath(str(file_path))
        if path == ".":
            return False
        parent = os.path.dirname(path) or "."
        parents = parent.split(os.path.sep)
        matched = False
        for pattern in self.patterns:
            if pattern.exclusion != matched:
                continue
            hit = pattern.match(path) or (parent != "." and any(
                pattern.match(os.path.sep.join(parents[:n + 1])) for n in range(len(parents))))
            if hit:
                matched = not pattern.exclusion
        return matched


NON_PYTHON_FILES = ~FilePatternMatcher("**/*.py")


def ignore_fn(ignore):
    """A callable that says whether a path is left out, from a list or a callable."""
    return ignore if callable(ignore) else FilePatternMatcher(*ignore)
