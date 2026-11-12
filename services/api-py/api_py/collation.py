"""Sorting as JavaScript's String.prototype.localeCompare sorts (ICU's root collation).

The TypeScript server sorts some lists with localeCompare, and one of them
decides a hub version's fingerprint (skills.py), so both servers have to agree
on the order. This is the Unicode Collation Algorithm (pyuca) with CLDR's root
table, data/allkeys_CLDR.txt.xz: common/uca/allkeys_CLDR.txt of CLDR 48, the
release Node's ICU carries (process.versions.cldr), compressed. Unicode's terms
of use are in the file's header. Update the table with Node's ICU.
"""

from __future__ import annotations

import functools
import lzma
from pathlib import Path

import pyuca
from pyuca.collator import COLL_ELEMENT_PATTERN
from pyuca.utils import hexstrings2int

TABLE = Path(__file__).parent / "data" / "allkeys_CLDR.txt.xz"


class _RootCollator(pyuca.Collator):
    def load(self, filename: str) -> None:
        """pyuca's loader, reading the compressed table."""
        with lzma.open(filename, "rt", encoding="utf-8") as keys:
            for raw in keys:
                line = raw.split("#", 1)[0].rstrip()
                if not line or line.startswith("@version"):
                    continue
                if line.startswith("@implicitweights"):
                    span, base = line[len("@implicitweights") :].split(";")
                    start, end = span.split("..")
                    self.implicit_weights.append([int(start, 16), int(end, 16), int(base, 16)])
                    continue
                chars, elements = line.split(";", 1)
                weights = [hexstrings2int(m.groups()) for m in COLL_ELEMENT_PATTERN.finditer(elements.strip())]
                self.table.add(hexstrings2int(chars.split()), weights)


@functools.cache
def _collator() -> _RootCollator:
    return _RootCollator(str(TABLE))


def collation_key(text: str) -> tuple[int, ...]:
    """A key that sorts as localeCompare does; strings it calls equal get equal keys."""
    return _collator().sort_key(text)
