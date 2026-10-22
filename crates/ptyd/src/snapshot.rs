//! Serializes a terminal's screen and scrollback into ANSI bytes that rebuild it in a fresh terminal.

use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::{Charsets, Cursor, Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags, Hyperlink};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{
    CharsetIndex, Color, CursorShape, CursorStyle, Handler, NamedPrivateMode, PrivateMode,
    StandardCharset,
};
use serde::Serialize;
use std::io::Write;
use std::ops::Range;

const STYLE_FLAGS: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

#[derive(Clone, PartialEq)]
struct Style {
    fg: Color,
    bg: Color,
    flags: Flags,
    underline: Option<Color>,
}

impl Style {
    fn of(cell: &Cell) -> Self {
        Self {
            fg: cell.fg,
            bg: cell.bg,
            flags: cell.flags & STYLE_FLAGS,
            underline: cell.underline_color(),
        }
    }

    fn is_default(&self) -> bool {
        *self == Self::of(&Cell::default())
    }
}

/// `max_history` caps the scrollback lines; the alternate screen has none
pub fn serialize<T: EventListener>(term: &mut Term<T>, max_history: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 * 1024);
    out.extend_from_slice(b"\x1bc");
    if term.mode().contains(TermMode::ALT_SCREEN) {
        // The primary grid is only reachable by swapping; swapping back would wipe the
        // alternate grid, so it is restored from a copy.
        let alt = term.grid().clone();
        term.swap_alt();
        write_grid(&mut out, term.grid(), max_history);
        let primary = &term.grid().cursor;
        write_cursor(&mut out, primary, term.grid(), 0);
        let reset_charsets = primary.charsets != Charsets::default();
        term.swap_alt();
        *term.grid_mut() = alt;
        // 1049h saves the primary cursor, as it did in the original
        out.extend_from_slice(b"\x1b[?1049h\x1b[0m\x1b[H");
        if reset_charsets {
            write_charsets(&mut out, Charsets::default());
        }
        write_grid(&mut out, term.grid(), 0);
    } else {
        write_grid(&mut out, term.grid(), max_history);
    }
    let grid = term.grid();
    if grid.saved_cursor != Cursor::default() {
        write_cursor(&mut out, &grid.saved_cursor, grid, 0);
        out.extend_from_slice(b"\x1b7");
        if grid.saved_cursor.charsets != Charsets::default() {
            write_charsets(&mut out, Charsets::default());
        }
    }
    // Both home the cursor, so they go before it
    let region = scroll_region(term);
    let grid = term.grid();
    if region != (0..grid.screen_lines() as i32) {
        let _ = write!(out, "\x1b[{};{}r", region.start + 1, region.end);
    }
    let origin = term.mode().contains(TermMode::ORIGIN);
    if origin {
        out.extend_from_slice(b"\x1b[?6h");
    }
    write_cursor(
        &mut out,
        &grid.cursor,
        grid,
        if origin { region.start } else { 0 },
    );
    write_modes(&mut out, *term.mode(), term.cursor_style());
    out
}

/// DECSTBM as screen lines. Term keeps it private; origin mode reveals it through where the cursor
/// lands, then the cursor and mode are put back
fn scroll_region<T: EventListener>(term: &mut Term<T>) -> Range<i32> {
    let cursor = term.grid().cursor.clone();
    let origin = PrivateMode::Named(NamedPrivateMode::Origin);
    let was_origin = term.mode().contains(TermMode::ORIGIN);
    term.set_private_mode(origin);
    let top = term.grid().cursor.point.line.0;
    term.goto(term.screen_lines() as i32, 0);
    let bottom = term.grid().cursor.point.line.0;
    if !was_origin {
        term.unset_private_mode(origin);
    }
    term.grid_mut().cursor = cursor;
    top..bottom + 1
}

fn write_grid(out: &mut Vec<u8>, grid: &Grid<Cell>, max_history: usize) {
    let history = grid.history_size().min(max_history) as i32;
    let cols = grid.columns();
    let mut pen = Style::of(&Cell::default());
    let mut link = None;
    let mut prev_wrapped = false;
    for line in -history..grid.screen_lines() as i32 {
        let row = &grid[Line(line)];
        let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
        let end = if wrapped {
            cols
        } else {
            (0..cols)
                .rev()
                .find(|&c| row[Column(c)] != Cell::default())
                .map_or(0, |c| c + 1)
        };
        if line > -history && !(prev_wrapped && end > 0) {
            if !pen.is_default() {
                out.extend_from_slice(b"\x1b[0m");
                pen = Style::of(&Cell::default());
            }
            out.extend_from_slice(b"\r\n");
        }
        for col in 0..end {
            let cell = &row[Column(col)];
            if !cell
                .flags
                .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                write_cell(out, &mut pen, &mut link, cell);
            }
        }
        prev_wrapped = wrapped;
    }
    if link.is_some() {
        write_link(out, None);
    }
    out.extend_from_slice(b"\x1b[0m");
}

/// A run of same-styled text for the phone page: text, fg, bg, and flags (bold 1, italic 2, underline 4,
/// inverse 8, dim 16, strike 32, hidden 64)
#[derive(Debug, PartialEq, Serialize)]
pub struct Span(String, Option<Paint>, Option<Paint>, u8);

/// None is the theme's default; palette index 0-255 or `#rrggbb`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Paint {
    Index(u8),
    Rgb(String),
}

/// The screen and up to `max_history` scrollback lines, a list of spans per row, trailing blanks dropped
pub fn spans(grid: &Grid<Cell>, max_history: usize) -> Vec<Vec<Span>> {
    let history = grid.history_size().min(max_history) as i32;
    let cols = grid.columns();
    (-history..grid.screen_lines() as i32)
        .map(|line| {
            let row = &grid[Line(line)];
            let end = (0..cols)
                .rev()
                .find(|&c| row[Column(c)] != Cell::default())
                .map_or(0, |c| c + 1);
            let mut spans: Vec<Span> = vec![];
            for col in 0..end {
                let cell = &row[Column(col)];
                if cell
                    .flags
                    .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                let (fg, bg, flags) = (paint(cell.fg), paint(cell.bg), span_flags(cell.flags));
                if !spans
                    .last()
                    .is_some_and(|s| s.1 == fg && s.2 == bg && s.3 == flags)
                {
                    spans.push(Span(String::new(), fg, bg, flags));
                }
                if let Some(span) = spans.last_mut() {
                    span.0.push(if cell.c == '\t' { ' ' } else { cell.c });
                    span.0.extend(cell.zerowidth().unwrap_or_default());
                }
            }
            spans
        })
        .collect()
}

fn paint(color: Color) -> Option<Paint> {
    match color {
        Color::Named(n) if (n as usize) < 16 => Some(Paint::Index(n as u8)),
        Color::Named(_) => None,
        Color::Indexed(i) => Some(Paint::Index(i)),
        Color::Spec(c) => Some(Paint::Rgb(format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b))),
    }
}

fn span_flags(flags: Flags) -> u8 {
    [
        (Flags::BOLD, 1),
        (Flags::ITALIC, 2),
        (Flags::ALL_UNDERLINES, 4),
        (Flags::INVERSE, 8),
        (Flags::DIM, 16),
        (Flags::STRIKEOUT, 32),
        (Flags::HIDDEN, 64),
    ]
    .into_iter()
    .filter(|(flag, _)| flags.intersects(*flag))
    .fold(0, |bits, (_, bit)| bits | bit)
}

fn write_cell(out: &mut Vec<u8>, pen: &mut Style, link: &mut Option<Hyperlink>, cell: &Cell) {
    let style = Style::of(cell);
    if style != *pen {
        write_sgr(out, &style);
        *pen = style;
    }
    let cell_link = cell.hyperlink();
    if cell_link != *link {
        write_link(out, cell_link.as_ref());
        *link = cell_link;
    }
    let c = if cell.c == '\t' { ' ' } else { cell.c };
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    for c in cell.zerowidth().unwrap_or_default() {
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
}

/// OSC 8; the id keeps cells of one link together, and alacritty made one up when the program gave none
fn write_link(out: &mut Vec<u8>, link: Option<&Hyperlink>) {
    let _ = match link {
        Some(link) => write!(out, "\x1b]8;id={};{}\x1b\\", link.id(), link.uri()),
        None => write!(out, "\x1b]8;;\x1b\\"),
    };
}

fn write_sgr(out: &mut Vec<u8>, style: &Style) {
    out.extend_from_slice(b"\x1b[0");
    let flags = [
        (Flags::BOLD, ";1"),
        (Flags::DIM, ";2"),
        (Flags::ITALIC, ";3"),
        (Flags::UNDERLINE, ";4"),
        (Flags::DOUBLE_UNDERLINE, ";4:2"),
        (Flags::UNDERCURL, ";4:3"),
        (Flags::DOTTED_UNDERLINE, ";4:4"),
        (Flags::DASHED_UNDERLINE, ";4:5"),
        (Flags::INVERSE, ";7"),
        (Flags::HIDDEN, ";8"),
        (Flags::STRIKEOUT, ";9"),
    ];
    for (flag, code) in flags {
        if style.flags.contains(flag) {
            out.extend_from_slice(code.as_bytes());
        }
    }
    write_color(out, style.fg, 30, 90, 38);
    write_color(out, style.bg, 40, 100, 48);
    if let Some(color) = style.underline {
        write_color(out, color, 58, 58, 58);
    }
    out.push(b'm');
}

/// `base` for colors 0-7, `bright` for 8-15, `extended` for 256 and truecolor. Default colors write nothing.
fn write_color(out: &mut Vec<u8>, color: Color, base: u8, bright: u8, extended: u8) {
    let _ = match color {
        // Underline color has no short form
        Color::Named(n) if (n as usize) < 16 && base == extended => {
            write!(out, ";{extended};5;{}", n as usize)
        }
        Color::Named(n) if (n as usize) < 8 => write!(out, ";{}", base as usize + n as usize),
        Color::Named(n) if (n as usize) < 16 => {
            write!(out, ";{}", bright as usize + n as usize - 8)
        }
        Color::Named(_) => Ok(()),
        Color::Indexed(i) => write!(out, ";{extended};5;{i}"),
        Color::Spec(c) => write!(out, ";{extended};2;{};{};{}", c.r, c.g, c.b),
    };
}

/// Positions `cursor` (line relative to `top` under origin mode) and sets its pen, link and charsets
fn write_cursor(out: &mut Vec<u8>, cursor: &Cursor<Cell>, grid: &Grid<Cell>, top: i32) {
    let line = cursor.point.line.0 - top + 1;
    if cursor.input_needs_wrap {
        // Rewriting the last cell leaves the receiver with the same pending wrap
        let last = grid.last_column();
        let _ = write!(out, "\x1b[{line};{}H", last.0 + 1);
        let cell = &grid[cursor.point.line][last];
        if !cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            let mut link = None;
            write_cell(out, &mut Style::of(&Cell::default()), &mut link, cell);
            if link.is_some() {
                write_link(out, None);
            }
        }
    } else {
        let _ = write!(out, "\x1b[{line};{}H", cursor.point.column.0 + 1);
    }
    write_sgr(out, &Style::of(&cursor.template));
    if let Some(link) = cursor.template.hyperlink() {
        write_link(out, Some(&link));
    }
    if cursor.charsets != Charsets::default() {
        write_charsets(out, cursor.charsets);
    }
}

/// G0-G3 designations; the active set is not reachable, so a shifted-out G1 (SO) comes back as G0
fn write_charsets(out: &mut Vec<u8>, charsets: Charsets) {
    let sets = [
        (CharsetIndex::G0, '('),
        (CharsetIndex::G1, ')'),
        (CharsetIndex::G2, '*'),
        (CharsetIndex::G3, '+'),
    ];
    for (index, intro) in sets {
        let set = match charsets[index] {
            StandardCharset::Ascii => 'B',
            StandardCharset::SpecialCharacterAndLineDrawing => '0',
        };
        let _ = write!(out, "\x1b{intro}{set}");
    }
}

fn write_modes(out: &mut Vec<u8>, mode: TermMode, cursor: CursorStyle) {
    let private = [
        (TermMode::APP_CURSOR, 1),
        (TermMode::MOUSE_REPORT_CLICK, 1000),
        (TermMode::MOUSE_DRAG, 1002),
        (TermMode::MOUSE_MOTION, 1003),
        (TermMode::FOCUS_IN_OUT, 1004),
        (TermMode::UTF8_MOUSE, 1005),
        (TermMode::SGR_MOUSE, 1006),
        (TermMode::BRACKETED_PASTE, 2004),
    ];
    for (flag, code) in private {
        if mode.contains(flag) {
            let _ = write!(out, "\x1b[?{code}h");
        }
    }
    if mode.contains(TermMode::INSERT) {
        out.extend_from_slice(b"\x1b[4h");
    }
    if mode.contains(TermMode::APP_KEYPAD) {
        out.extend_from_slice(b"\x1b=");
    }
    if mode.contains(TermMode::LINE_FEED_NEW_LINE) {
        out.extend_from_slice(b"\x1b[20h");
    }
    let default_on = [
        (TermMode::LINE_WRAP, 7),
        (TermMode::SHOW_CURSOR, 25),
        (TermMode::ALTERNATE_SCROLL, 1007),
        (TermMode::URGENCY_HINTS, 1042),
    ];
    for (flag, code) in default_on {
        if !mode.contains(flag) {
            let _ = write!(out, "\x1b[?{code}l");
        }
    }
    if cursor != CursorStyle::default() {
        let shape = match cursor.shape {
            CursorShape::Underline => 3,
            CursorShape::Beam => 5,
            _ => 1,
        };
        let _ = write!(out, "\x1b[{} q", shape + u8::from(!cursor.blinking));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;

    struct Size(usize, usize);
    impl Dimensions for Size {
        fn total_lines(&self) -> usize {
            self.1
        }
        fn screen_lines(&self) -> usize {
            self.1
        }
        fn columns(&self) -> usize {
            self.0
        }
    }

    fn term(input: &[u8]) -> Term<VoidListener> {
        let mut term = Term::new(Config::default(), &Size(40, 10), VoidListener);
        Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new().advance(&mut term, input);
        term
    }

    /// Every line of history and screen, both grids, as (text, cells)
    fn grids(term: &mut Term<VoidListener>) -> Vec<Grid<Cell>> {
        let active = term.grid().clone();
        if !term.mode().contains(TermMode::ALT_SCREEN) {
            return vec![active];
        }
        term.swap_alt();
        let primary = term.grid().clone();
        term.swap_alt();
        *term.grid_mut() = active.clone();
        vec![primary, active]
    }

    fn assert_same_grid(a: &Grid<Cell>, b: &Grid<Cell>) {
        assert_eq!(a.history_size(), b.history_size(), "history size");
        for line in -(a.history_size() as i32)..a.screen_lines() as i32 {
            for col in 0..a.columns() {
                let (x, y) = (&a[Line(line)][Column(col)], &b[Line(line)][Column(col)]);
                assert_eq!(x, y, "cell at line {line} col {col}");
            }
        }
        // Position, pending wrap, pen, link and charsets
        assert_eq!(a.cursor, b.cursor, "cursor");
        assert_eq!(a.saved_cursor, b.saved_cursor, "saved cursor");
    }

    fn round_trip(input: &[u8]) {
        let mut original = term(input);
        let snapshot = serialize(&mut original, 5000);
        let mut restored = term(&snapshot);
        let (a, b) = (grids(&mut original), grids(&mut restored));
        assert_eq!(a.len(), b.len(), "alt screen state");
        for (a, b) in a.iter().zip(&b) {
            assert_same_grid(a, b);
        }
        assert_eq!(original.mode(), restored.mode());
        assert_eq!(original.cursor_style(), restored.cursor_style());
        assert_eq!(
            scroll_region(&mut original),
            scroll_region(&mut restored),
            "scroll region"
        );
        // Serializing must not disturb the original
        assert_eq!(serialize(&mut original, 5000), snapshot);
    }

    fn colored_history() -> Vec<u8> {
        let mut input = Vec::new();
        for i in 0..30 {
            input.extend_from_slice(
                format!(
                    "\x1b[31mred{i}\x1b[0m \x1b[1;3;4;38;5;200mbold\x1b[0m \x1b[48;2;10;20;30;9mtrue\x1b[0m \
                     \x1b[2;7m dim \x1b[4:3;58:2::1:2:3mcurl\x1b[0m 日本\r\n"
                )
                .as_bytes(),
            );
        }
        input.extend_from_slice(&[b'w'; 95]);
        input.extend_from_slice("\r\n\x1b[44m bg to eol\x1b[K\x1b[0m\r\nwide at edge: ".as_bytes());
        input.extend_from_slice(&[b'x'; 25]);
        input.extend_from_slice("界e\u{301}\r\n$ \x1b[32m".as_bytes());
        input
    }

    #[test]
    fn spans_carry_colors_flags_and_wide_chars_once() {
        let term = term(b"plain \x1b[1;31mred\x1b[0m \x1b[38;2;1;2;3mrgb\x1b[0m \xe4\xb8\xad!\r\n");
        let rows = spans(term.grid(), 0);
        assert_eq!(
            rows[0],
            vec![
                Span("plain ".into(), None, None, 0),
                Span("red".into(), Some(Paint::Index(1)), None, 1),
                Span(" ".into(), None, None, 0),
                Span("rgb".into(), Some(Paint::Rgb("#010203".into())), None, 0),
                Span(" \u{4e2d}!".into(), None, None, 0),
            ]
        );
        assert!(rows[1].is_empty());
    }

    #[test]
    fn primary_screen_round_trips() {
        round_trip(&colored_history());
    }

    #[test]
    fn pending_wrap_round_trips() {
        let mut input = colored_history();
        input.extend_from_slice(&[b'z'; 38]);
        round_trip(&input);
    }

    #[test]
    fn vim_like_alt_screen_round_trips() {
        let mut input = colored_history();
        input.extend_from_slice(
            b"\x1b[?1049h\x1b[2J\x1b[H\x1b[?1h\x1b=\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[6 q\
              \x1b[1;34m  1 \x1b[0mfn main() {}\r\n\x1b[1;34m  2 \x1b[0m\x1b[3;1H~\r\n~\
              \x1b[10;1H\x1b[7mNORMAL  main.rs\x1b[K\x1b[0m\x1b[1;9H",
        );
        round_trip(&input);
        let mut snapshot_term = term(&input);
        let snapshot = serialize(&mut snapshot_term, 5000);
        // Leaving the alt screen in the restored terminal shows the primary screen and cursor
        let mut original = term(&[input.as_slice(), b"\x1b[?1049l"].concat());
        let mut restored = term(&[snapshot.as_slice(), b"\x1b[?1049l"].concat());
        assert_same_grid(&grids(&mut original)[0], &grids(&mut restored)[0]);
    }

    #[test]
    fn hidden_cursor_and_no_wrap_round_trip() {
        round_trip(b"hello\x1b[?25l\x1b[?7l\x1b[4h\x1b[3;5H");
    }

    #[test]
    fn tui_modes_round_trip() {
        // Claude Code / Codex: bracketed paste, focus reporting, SGR mouse with motion, app cursor
        // keys and keypad, a hidden steady bar cursor, LNM, no alternate scroll or urgency hints
        round_trip(
            b"prompt> \x1b[?2004h\x1b[?1004h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b=\x1b[?25l\x1b[6 q\
              \x1b[20h\x1b[?1007l\x1b[?1042l\x1b[1;38;2;200;100;0mpen",
        );
        round_trip(b"\x1b[?1000h\x1b[?1005h\x1b[3 q");
        round_trip(b"\x1b[?1002h\x1b[4 q");
    }

    #[test]
    fn scroll_region_and_origin_round_trip() {
        // htop / less style: a status line pinned under a scrolling region
        let mut input = colored_history();
        input.extend_from_slice(b"\x1b[2;8r\x1b[9;1Hstatus\x1b[8;1Hlast\r\nscrolled");
        round_trip(&input);
        input.extend_from_slice(b"\x1b[?6h\x1b[3;4Hin region");
        round_trip(&input);
        // In the alternate screen too, with a pending wrap inside the region
        let mut alt = colored_history();
        alt.extend_from_slice(b"\x1b[?1049h\x1b[3;6r\x1b[?6h\x1b[2;31H");
        alt.extend_from_slice(&[b'r'; 10]);
        round_trip(&alt);
    }

    #[test]
    fn saved_cursor_charsets_and_links_round_trip() {
        let mut input = colored_history();
        // DECSC with a pen and line drawing, then a G1 designation and a box in G0
        input.extend_from_slice(
            b"\x1b[5;7H\x1b[1;35m\x1b(0\x1b7\x1b(B\x1b[0m\x1b[2;1H\x1b)0\x1b(0lqqk\x1b(B\r\n",
        );
        // OSC 8 links with and without an id, one spanning a wrapped line, one left open
        input.extend_from_slice(
            b"\x1b]8;id=a;https://a.example\x1b\\link a\x1b]8;;\x1b\\ \x1b]8;;file:///tmp/b\x1b\\",
        );
        input.extend_from_slice(&[b'b'; 50]);
        input.extend_from_slice(b"\x1b]8;;\x1b\\ plain \x1b]8;;https://open.example\x1b\\\x1b(0");
        round_trip(&input);
        // The same inside vim: its own DECSC, and leaving it restores the primary's
        let mut alt = input.clone();
        alt.extend_from_slice(
            b"\x1b[?1049h\x1b(B\x1b[3;3H\x1b7\x1b[H\x1b]8;;https://alt.example\x1b\\alt",
        );
        round_trip(&alt);
        // Links without an id got one made up per terminal, so the original is the snapshotted one
        let mut original = term(&alt);
        let snapshot = serialize(&mut original, 5000);
        let leave = |term: &mut Term<VoidListener>| {
            Processor::<alacritty_terminal::vte::ansi::StdSyncHandler>::new()
                .advance(term, b"\x1b[?1049l");
        };
        leave(&mut original);
        let mut restored = term(&snapshot);
        leave(&mut restored);
        assert_same_grid(&grids(&mut original)[0], &grids(&mut restored)[0]);
    }
}
