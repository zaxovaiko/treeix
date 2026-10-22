//! Serializes a terminal's screen and scrollback into ANSI bytes that rebuild it in a fresh terminal.

use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, CursorStyle};
use std::io::Write;

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
pub fn serialize<T>(term: &mut Term<T>, max_history: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 * 1024);
    out.extend_from_slice(b"\x1bc");
    if term.mode().contains(TermMode::ALT_SCREEN) {
        // The primary grid is only reachable by swapping; swapping back would wipe the
        // alternate grid, so it is restored from a copy.
        let alt = term.grid().clone();
        term.swap_alt();
        write_grid(&mut out, term.grid(), max_history);
        write_cursor(&mut out, term.grid());
        term.swap_alt();
        *term.grid_mut() = alt;
        out.extend_from_slice(b"\x1b[?1049h\x1b[0m\x1b[H");
        write_grid(&mut out, term.grid(), 0);
    } else {
        write_grid(&mut out, term.grid(), max_history);
    }
    write_cursor(&mut out, term.grid());
    write_modes(&mut out, *term.mode(), term.cursor_style());
    out
}

fn write_grid(out: &mut Vec<u8>, grid: &Grid<Cell>, max_history: usize) {
    let history = grid.history_size().min(max_history) as i32;
    let cols = grid.columns();
    let mut pen = Style::of(&Cell::default());
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
                write_cell(out, &mut pen, cell);
            }
        }
        prev_wrapped = wrapped;
    }
    out.extend_from_slice(b"\x1b[0m");
}

fn write_cell(out: &mut Vec<u8>, pen: &mut Style, cell: &Cell) {
    let style = Style::of(cell);
    if style != *pen {
        write_sgr(out, &style);
        *pen = style;
    }
    let c = if cell.c == '\t' { ' ' } else { cell.c };
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    for c in cell.zerowidth().unwrap_or_default() {
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
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

fn write_cursor(out: &mut Vec<u8>, grid: &Grid<Cell>) {
    let cursor = &grid.cursor;
    let line = cursor.point.line.0 + 1;
    if cursor.input_needs_wrap {
        // Rewriting the last cell leaves the receiver with the same pending wrap
        let last = grid.last_column();
        let _ = write!(out, "\x1b[{line};{}H", last.0 + 1);
        let cell = &grid[cursor.point.line][last];
        if !cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            write_cell(out, &mut Style::of(&Cell::default()), cell);
        }
    } else {
        let _ = write!(out, "\x1b[{line};{}H", cursor.point.column.0 + 1);
    }
    write_sgr(out, &Style::of(&cursor.template));
}

fn write_modes(out: &mut Vec<u8>, mode: TermMode, cursor: CursorStyle) {
    let private = [
        (TermMode::APP_CURSOR, 1),
        (TermMode::ORIGIN, 6),
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
    if !mode.contains(TermMode::LINE_WRAP) {
        out.extend_from_slice(b"\x1b[?7l");
    }
    if !mode.contains(TermMode::SHOW_CURSOR) {
        out.extend_from_slice(b"\x1b[?25l");
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
        assert_eq!(a.cursor.point, b.cursor.point, "cursor");
        assert_eq!(
            a.cursor.input_needs_wrap, b.cursor.input_needs_wrap,
            "pending wrap"
        );
        assert!(
            Style::of(&a.cursor.template) == Style::of(&b.cursor.template),
            "pen"
        );
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
}
