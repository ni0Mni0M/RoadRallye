"""Progress bars for the update scripts.

In a console every part of the update gets one line that fills up in place:

     roadsurfer      ███████████░░░░░░░░░░░░░   45%  dates 130/374 · 312 rallies     2:10 left

and stays there with its time when done. Warnings and waits are printed above the bar instead of
breaking it. Only a carriage return is used (no colour codes), so it works in any Windows console.
When the output goes to a file or pipe instead, a plain line is written every 10 % so logs stay readable.

    with progress.bar("roadsurfer") as bar:
        bar.update(0.5, "dates 130/374")
        progress.say("  ! a warning")
        bar.done("686 rallies")

Run this file on its own for a short demo.
"""

import shutil
import sys
import time

LABEL_WIDTH = 15
BAR_WIDTH = 24
REDRAW_SECONDS = 0.1
ETA_AFTER_SECONDS = 3  # too early to guess the time left before this

_active = None  # the bar currently drawn on the console's last line


def fmt_seconds(seconds):
    s = int(round(seconds))
    h, rest = divmod(s, 3600)
    m, sec = divmod(rest, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def can_encode(stream, text):
    try:
        text.encode(getattr(stream, "encoding", None) or "ascii")
        return True
    except (UnicodeEncodeError, LookupError):
        return False


def is_console(stream):
    try:
        return stream.isatty()
    except (AttributeError, ValueError):
        return False


def render(label, fraction, detail="", right="", width=100, fancy=True):
    """One bar line, exactly width - 1 characters long so it never wraps and always covers the last one."""
    fraction = max(0.0, min(1.0, fraction))
    full, empty, more = ("█", "░", "…") if fancy else ("#", "-", "...")
    filled = int(round(fraction * BAR_WIDTH))
    head = f" {label:<{LABEL_WIDTH}} {full * filled}{empty * (BAR_WIDTH - filled)} {fraction * 100:4.0f}%  "
    tail = f"  {right}" if right else ""
    room = max(0, width - 1 - len(head) - len(tail))
    if len(detail) > room:
        detail = detail[: max(0, room - len(more))] + more if room > len(more) else ""
    return (head + detail.ljust(room) + tail)[: max(0, width - 1)]


class Progress:
    """One part of the update. Use progress.bar(label) rather than creating it directly."""

    def __init__(self, label, stream=None, clock=time.monotonic):
        global _active
        self.label = label
        self.stream = stream or sys.stdout
        self.console = is_console(self.stream)
        self.fancy = can_encode(self.stream, "█░✓✗…")
        self.clock = clock
        self.started = clock()
        self.fraction = 0.0
        self.detail = ""
        self.finished = False
        self._drawn_at = None
        self._logged_step = -1
        _active = self
        self._draw(force=True)

    def __enter__(self):
        return self

    def __exit__(self, kind, error, trace):
        if not self.finished:
            if error is not None:
                self.fail(str(error) or kind.__name__)
            else:
                self.done()
        return False  # never swallow the error

    def update(self, fraction, detail=None):
        self.fraction = max(0.0, min(1.0, fraction))
        if detail is not None:
            self.detail = detail
        self._draw()

    def message(self, text):
        """Print a line above the bar and draw the bar again below it."""
        if self.console:
            self._write("\r" + " " * (self._width() - 1) + "\r" + text + "\n")
            self._draw(force=True)
        else:
            self._write(text + "\n")

    def done(self, detail=None):
        self._finish(1.0, detail, f"done in {fmt_seconds(self.clock() - self.started)}")

    def fail(self, reason):
        mark = "✗" if self.fancy else "x"
        self._finish(self.fraction, None, f"{mark} failed: {reason}")

    # ----- drawing -----

    def _finish(self, fraction, detail, right):
        global _active
        self.fraction = fraction
        if detail is not None:
            self.detail = detail
        self.finished = True
        if _active is self:
            _active = None
        if self.console:
            line = render(self.label, self.fraction, self.detail, right, self._width(), self.fancy)
            self._write("\r" + line + "\n")
        else:
            self._write(f"{self.label}: {self.fraction * 100:.0f}%  {self.detail}  {right}".rstrip() + "\n")

    def _right(self):
        elapsed = self.clock() - self.started
        if self.fraction <= 0 or self.fraction >= 1 or elapsed < ETA_AFTER_SECONDS:
            return ""
        return f"{fmt_seconds(elapsed / self.fraction * (1 - self.fraction))} left"

    def _draw(self, force=False):
        if self.console:
            now = self.clock()
            if not force and self._drawn_at is not None and now - self._drawn_at < REDRAW_SECONDS:
                return
            self._drawn_at = now
            self._write("\r" + render(self.label, self.fraction, self.detail, self._right(), self._width(), self.fancy))
        else:
            step = int(self.fraction * 10)
            if step > self._logged_step:
                self._logged_step = step
                self._write(f"{self.label}: {self.fraction * 100:.0f}%  {self.detail}".rstrip() + "\n")

    def _width(self):
        return shutil.get_terminal_size((100, 24)).columns

    def _write(self, text):
        self.stream.write(text)
        self.stream.flush()


def bar(label, stream=None):
    return Progress(label, stream)


def say(text):
    """Print a message; if a bar is being drawn, above it, so the bar stays on the last line."""
    if _active is not None:
        _active.message(text)
    else:
        print(text, flush=True)


def item(label, text, ok=True, stream=None):
    """A part that needs no bar: one finished line such as ' exchange rates  ✓ USD, GBP'."""
    stream = stream or sys.stdout
    fancy = can_encode(stream, "✓✗")
    mark = ("✓" if ok else "✗") if fancy else ("OK" if ok else "x")
    stream.write(f" {label:<{LABEL_WIDTH}} {mark} {text}\n")
    stream.flush()


def demo():
    """A short made-up update, to see what the bars look like in this console."""
    print("RoadRalley data update (demo, nothing is downloaded)\n")
    with bar("roadsurfer") as b:
        for i in range(1, 101):
            b.update(i / 100, f"dates {i * 4}/400 · {i * 2} rallies")
            if i == 60:
                say("  ! 22-31: HTTP Error 500 (example warning)")
            time.sleep(0.04)
        b.done("200 rallies")
    with bar("Imoova") as b:
        for i in range(1, 5):
            b.update(i / 4, f"EU page {i}/4 · {i * 50} relocations")
            time.sleep(0.4)
        b.done("200 relocations")
    item("exchange rates", "USD, GBP")
    with bar("routes") as b:
        for i in range(1, 41):
            b.update(i / 40, f"{i}/40 · Madrid – Valencia")
            if i == 25:
                say("  router.project-osrm.org busy (429), waiting 3s")
                time.sleep(1)
            time.sleep(0.08)
        b.done("40 routes saved")
    item("weather", "all 82 stations already saved")


if __name__ == "__main__":
    demo()
