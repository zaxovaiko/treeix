# IME checklist (Treeix Next)

Run on every release candidate, by hand, in both webviews:

- macOS: WKWebView, the signed DMG build.
- Linux: WebKitGTK, the AppImage on Ubuntu 22.04 (GNOME, IBus) and one Fcitx5 desktop.

Each check runs in a plain zsh pane and again inside Claude Code (`claude`), which draws its own input line. A check passes when:

- the composed text reaches the shell exactly once, with no stray Latin letters or doubled characters
- the candidate window sits at the cursor, not at the pane's top-left corner
- Enter, Backspace and Escape while composing act on the composition, not on the shell (no early command run, no deleted prompt characters)
- after committing, normal typing and shortcuts (Cmd+T, Cmd+D, Cmd+K, Shift+Cmd+K, Cmd+F) work again

Tick each box for macOS and Linux. Note the input method version next to any failure.

## Japanese

- [ ] macOS Japanese - Romaji: type `nihongo`, Space to convert, Enter to commit: `日本語`
- [ ] Linux Mozc: same
- [ ] Space cycles candidates and Enter commits without running the command line
- [ ] Shift+Enter while composing does not send a newline to Claude Code
- [ ] Backspace mid-composition shortens the composition, not the prompt

## Korean

- [ ] macOS 2-Set Korean: type `gksrmf` -> `한글`; the last syllable commits when you type Space or punctuation
- [ ] Linux IBus Hangul or fcitx5-hangul: same
- [ ] Arrow keys right after a syllable commit it and move the cursor once (no lost or doubled syllable)
- [ ] Enter right after a syllable commits it and runs the line once

## Chinese

- [ ] macOS Pinyin - Simplified: type `zhongwen`, 1 to pick: `中文`
- [ ] Linux IBus Pinyin or fcitx5-chinese-addons: same
- [ ] Number keys pick candidates and are not sent to the shell
- [ ] Shift toggles Chinese/English mode without sending anything

## Dead keys

- [ ] Polish Programmers: Option+a `ą`, Option+s `ś`, Option+z `ż`, Option+x `ź` (macOS); AltGr on Linux
- [ ] Polish Pro, Option+e: `ę`, Option+Shift+a: `Ą`
- [ ] Ukrainian (macOS Ukrainian - PC and Linux ua): `ґ`, `є`, `ї`, `і` and the apostrophe `ʼ` type correctly
- [ ] US International (Linux) / ABC Extended (macOS): `'` then `e` gives `é`; `'` then Space gives `'`
- [ ] A dead key followed by a key it can't combine with types both characters

## macOS Option composition

- [ ] ABC layout: Option+e then e gives `é`, Option+u then o gives `ö`, Option+n then n gives `ñ`
- [ ] Option+Left and Option+Right still jump a word in zsh and Claude Code
- [ ] Option+Backspace still deletes a word

## Emoji and character pickers

- [ ] macOS Ctrl+Cmd+Space (or Fn+E): pick an emoji; it lands once, at the cursor
- [ ] Search inside the picker does not type into the terminal
- [ ] Linux GNOME Ctrl+. (or Ctrl+;) emoji picker: same
- [ ] A ZWJ emoji (`👩‍💻`) and a flag (`🇺🇦`) take two cells and don't shift the following text

## Dictation and paste

- [ ] macOS Dictation (press Fn twice): spoken text arrives once, with no duplicate when dictation ends
- [ ] Cmd+V (macOS) / Ctrl+Shift+V (Linux) pastes CJK text intact, without a Paste callout on macOS

## Find in pane

- [ ] Cmd+F (Ctrl+Shift+F on Linux), compose `日本` in the find field: it searches for the composed text and Enter while composing doesn't jump to the next match
