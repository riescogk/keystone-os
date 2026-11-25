"""Shared data model for Word tables and comparison results."""
from __future__ import annotations
from dataclasses import dataclass, field
from .normalize import key_of, clean


@dataclass
class WCell:
    text: str
    x0: float
    x1: float
    y: float
    h: float
    row: int = 0
    key: str = ''
    bold: bool = False
    col_hint: int | None = None      # native-table column index when known
    merged_lines: int = 1
    parts: list | None = None        # original text fragments when several lines were folded into this cell

    def __post_init__(self):
        self.text = clean(self.text)
        if not self.key: self.key = key_of(self.text)

    @property
    def xc(self): return (self.x0 + self.x1) / 2


@dataclass
class WTable:
    tid: str
    kind: str                      # vector | native | raster_ocr | docx_native
    order: int                     # Nth table-like object in document order
    cp: int | None
    rows: list                     # list[list[WCell]]
    width: float = 0
    height: float = 0
    sha: str = ''
    before: str = ''               # nearest preceding paragraph text
    after: str = ''                # nearest following paragraph text
    title: str = ''                # first/title row text
    meta: dict = field(default_factory=dict)
    duplicate_of: str | None = None

    @property
    def cell_count(self): return sum(len(r) for r in self.rows)
