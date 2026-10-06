"""The handoff note: the only prose a session passes to the next one.

The format is fixed so that every model hands over the same kind of information in the
same amount of space: three sections, each a list of short items. Whatever a session
writes outside this format is dropped, and the amount dropped is recorded.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

SECTIONS: tuple[tuple[str, str], ...] = (
    ("proved", "Proved lemmas"),
    ("open_goals", "Open goals"),
    ("failed", "Failed approaches"),
)

MAX_ITEMS_PER_SECTION = 30
MAX_ITEM_CHARS = 400

HANDOFF_FILENAME = "HANDOFF.md"

HANDOFF_TEMPLATE = """# Handoff

## Proved lemmas
- (none yet)

## Open goals
- (none yet)

## Failed approaches
- (none yet)
"""

HANDOFF_FORMAT_DESCRIPTION = f"""\
The note has exactly three sections, each a list of `- ` items of at most {MAX_ITEM_CHARS} characters
(at most {MAX_ITEMS_PER_SECTION} items per section):

## Proved lemmas
- <lemma name>: <what it states, in one line>

## Open goals
- <what remains to be proved, most important first>

## Failed approaches
- <what was tried and why it did not work>

Text outside these three sections is not passed on."""

_PLACEHOLDER = re.compile(r"^\(?\s*none( yet)?\s*\)?\.?$", re.IGNORECASE)
_HEADING = re.compile(r"^#{1,6}\s*(.+?)\s*#*\s*$")
_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$")


@dataclass
class Handoff:
    """A parsed handoff note."""

    proved: list[str] = field(default_factory=list)
    open_goals: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    #: sections that were present in the text
    sections_found: list[str] = field(default_factory=list)
    #: characters of the source that did not fit the format and were dropped
    dropped_chars: int = 0
    #: items cut because a section had more than the allowed number
    dropped_items: int = 0
    #: items shortened to the per-item limit
    truncated_items: int = 0

    @property
    def is_empty(self) -> bool:
        return not (self.proved or self.open_goals or self.failed)

    @property
    def well_formed(self) -> bool:
        """All three sections present and nothing dropped or cut."""
        return len(self.sections_found) == len(SECTIONS) and self.dropped_chars == 0 and self.dropped_items == 0 and self.truncated_items == 0

    def stats(self) -> dict:
        d = asdict(self)
        return {
            "items": {key: len(d[key]) for key, _ in SECTIONS},
            "sections_found": self.sections_found,
            "dropped_chars": self.dropped_chars,
            "dropped_items": self.dropped_items,
            "truncated_items": self.truncated_items,
            "well_formed": self.well_formed,
            "empty": self.is_empty,
        }


def _section_key(heading: str) -> str | None:
    h = re.sub(r"[^a-z ]", "", heading.lower()).strip()
    if h.startswith("proved") or h.startswith("proven"):
        return "proved"
    if h.startswith("open goal") or h.startswith("open") or h.startswith("remaining goal"):
        return "open_goals"
    if h.startswith("failed") or h.startswith("approaches that failed"):
        return "failed"
    return None


def parse_handoff(text: str | None) -> Handoff:
    """Read a handoff note. Never raises: a note that does not follow the format yields fewer items."""
    note = Handoff()
    if not text:
        return note
    current: str | None = None
    items: dict[str, list[str]] = {key: [] for key, _ in SECTIONS}
    open_item = False  # an indented line directly below an item continues it
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            open_item = False
            continue
        heading = _HEADING.match(line)
        if heading:
            key = _section_key(heading.group(1))
            if key is None:
                # A title such as "# Handoff" carries no content; any other heading ends the section.
                if heading.group(1).strip().lower() not in ("handoff", "handoff note"):
                    note.dropped_chars += len(line)
                current = None
            else:
                current = key
                if key not in note.sections_found:
                    note.sections_found.append(key)
            open_item = False
            continue
        if current is None:
            note.dropped_chars += len(line)
            continue
        item = _ITEM.match(line)
        if item:
            items[current].append(item.group(1).strip())
            open_item = True
        elif open_item and line[:1].isspace():
            items[current][-1] = f"{items[current][-1]} {line.strip()}"
        else:
            # Prose between or after the items is not part of the format.
            note.dropped_chars += len(line)
            open_item = False
    for key, _ in SECTIONS:
        kept: list[str] = []
        for it in items[key]:
            if not it or _PLACEHOLDER.match(it):
                continue
            if len(it) > MAX_ITEM_CHARS:
                it = it[: MAX_ITEM_CHARS - 1].rstrip() + "…"
                note.truncated_items += 1
            kept.append(it)
        if len(kept) > MAX_ITEMS_PER_SECTION:
            note.dropped_items += len(kept) - MAX_ITEMS_PER_SECTION
            kept = kept[:MAX_ITEMS_PER_SECTION]
        setattr(note, key, kept)
    return note


def render_handoff(note: Handoff) -> str:
    """The note as the next session reads it: always the same three sections."""
    parts = ["# Handoff", ""]
    for key, title in SECTIONS:
        parts.append(f"## {title}")
        entries = getattr(note, key)
        parts.extend(f"- {e}" for e in entries) if entries else parts.append("- (none)")
        parts.append("")
    return "\n".join(parts).rstrip() + "\n"
