"""Run with: python -m unittest discover -s tests"""

import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))

import progress  # noqa: E402


class Console(io.StringIO):
    """A fake console window: isatty() is true and it can show any character."""

    encoding = "utf-8"

    def isatty(self):
        return True


class Ascii(io.StringIO):
    """A redirected output that only takes plain Windows characters."""

    encoding = "cp1252"


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Render(unittest.TestCase):
    def test_line_fills_the_width_without_wrapping(self):
        line = progress.render("roadsurfer", 0.5, "dates 130/374", "2:10 left", width=100)
        self.assertEqual(len(line), 99)
        self.assertTrue(line.endswith("2:10 left"))
        self.assertIn("  50%", line)
        self.assertEqual(line.count("█"), 12)
        self.assertEqual(line.count("░"), 12)

    def test_long_detail_is_shortened(self):
        line = progress.render("routes", 0.1, "x" * 300, "", width=80)
        self.assertEqual(len(line), 79)
        self.assertTrue(line.endswith("…"))

    def test_plain_characters_when_the_output_cannot_show_blocks(self):
        line = progress.render("Imoova", 0.25, "EU page 1/4", width=80, fancy=False)
        self.assertIn("######------------------", line)
        self.assertNotIn("█", line)

    def test_fraction_is_kept_between_0_and_1(self):
        self.assertIn(" 100%", progress.render("x", 1.7, width=80))
        self.assertIn("   0%", progress.render("x", -1, width=80))

    def test_times(self):
        self.assertEqual(progress.fmt_seconds(65), "1:05")
        self.assertEqual(progress.fmt_seconds(3725), "1:02:05")


class InAConsole(unittest.TestCase):
    def test_redraws_the_same_line_and_ends_it_when_done(self):
        out, clock = Console(), FakeClock()
        b = progress.Progress("roadsurfer", out, clock)
        clock.now = 10
        b.update(0.5, "dates 130/374")
        b.done("686 rallies")
        text = out.getvalue()
        self.assertEqual(text.count("\n"), 1)  # one finished line, every update drew over the same one
        self.assertTrue(text.startswith("\r"))
        self.assertIn("done in 0:10", text)
        self.assertIn("686 rallies", text)

    def test_time_left_from_the_speed_so_far(self):
        out, clock = Console(), FakeClock()
        b = progress.Progress("routes", out, clock)
        clock.now = 60
        b.update(0.25)
        self.assertIn("3:00 left", out.getvalue())

    def test_messages_go_above_the_bar(self):
        out = Console()
        with progress.Progress("routes", out):
            progress.say("  ! Madrid - Valencia: timed out")
        lines = out.getvalue().split("\n")
        self.assertIn("! Madrid - Valencia: timed out", lines[0])
        self.assertIn("routes", lines[1])  # the bar drawn again below the message

    def test_an_error_marks_the_part_failed_and_is_not_swallowed(self):
        out = Console()
        with self.assertRaises(RuntimeError):
            with progress.Progress("Imoova", out):
                raise RuntimeError("HTTP 503")
        self.assertIn("failed: HTTP 503", out.getvalue())
        self.assertTrue(out.getvalue().endswith("\n"))


class InALogFile(unittest.TestCase):
    def test_plain_line_every_10_percent(self):
        out = io.StringIO()
        b = progress.Progress("weather", out)
        for i in range(1, 101):
            b.update(i / 100, f"{i}/100")
        b.done()
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 12)  # 0 %, ten steps, done
        self.assertNotIn("\r", out.getvalue())
        self.assertEqual(lines[1], "weather: 10%  10/100")

    def test_say_without_a_bar_just_prints(self):
        out = io.StringIO()
        old, sys.stdout = sys.stdout, out
        try:
            progress.say("hello")
        finally:
            sys.stdout = old
        self.assertEqual(out.getvalue(), "hello\n")


class Item(unittest.TestCase):
    def test_finished_line_with_a_tick(self):
        out = Console()
        progress.item("exchange rates", "USD, GBP", stream=out)
        self.assertEqual(out.getvalue(), " exchange rates  ✓ USD, GBP\n")

    def test_plain_mark_when_ticks_cannot_be_shown(self):
        out = Ascii()
        progress.item("exchange rates", "failed", ok=False, stream=out)
        self.assertEqual(out.getvalue(), " exchange rates  x failed\n")


if __name__ == "__main__":
    unittest.main()
