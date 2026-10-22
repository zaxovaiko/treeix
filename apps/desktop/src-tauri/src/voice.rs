//! Dictation and call recording through the Swift helpers in apps/desktop/native/voice, shipped as externalBin
//! sidecars: `treeix-voice` (hotkey, microphone, Parakeet, its own HUD, pasting) and `treeix-meetings` (call
//! audio, transcript with speakers). Both speak JSON lines over stdin/stdout (Electron's dictation and meetings
//! protocol.ts). Recordings go to settings.recording.folder as `<date> <title>/` with transcript.md and note.md.
//! Contract: docs/next/phase67-contract.md. Owner: V7

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use treeix_core::settings::{self, Settings};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HelperState {
    Starting,
    Running,
    /// The sidecar isn't in the bundle (a dev build without `swift build`)
    Missing,
    Crashed,
    /// Not an Apple silicon Mac on macOS 14 or later
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModelPhase {
    Missing,
    Downloading,
    Downloaded,
    Loading,
    Ready,
    Error,
}

/// A speech model, `parakeet-v3` or `parakeet-v2`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModel {
    pub id: String,
    pub phase: ModelPhase,
    /// 0-1 while Downloading
    pub progress: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Access {
    Granted,
    Denied,
    NotAsked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AccessKind {
    Microphone,
    /// Pasting into other apps
    Accessibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DictationPhase {
    Idle,
    Listening,
    Transcribing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub helper: HelperState,
    pub models: Vec<VoiceModel>,
    pub microphone: Access,
    pub accessibility: Access,
    pub phase: DictationPhase,
    /// The last thing that went wrong, for Settings
    pub error: Option<String>,
}

/// One dictation, for Settings' history
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictationEntry {
    /// Unix ms
    pub at: u64,
    /// What the model heard
    pub raw: String,
    /// What was inserted, after vocabulary
    pub text: String,
    /// The app it went into
    pub app: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordingPhase {
    Idle,
    Recording,
    Paused,
    /// Stopped; the transcript and note are being written
    Saving,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub helper: HelperState,
    pub phase: RecordingPhase,
    pub title: Option<String>,
    /// Unix ms; the title bar's REC timer counts from it
    pub started_at: Option<u64>,
    /// Ms recorded before the last pause
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLine {
    /// Ms from the start
    pub at: u64,
    /// `Me`, `Speaker 2`; None before diarization
    pub speaker: Option<String>,
    pub text: String,
}

/// A saved recording
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    /// Folder name; what `recording_read` takes
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub duration_ms: u64,
    pub folder: String,
    pub has_note: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingNote {
    pub info: RecordingInfo,
    pub transcript: Vec<TranscriptLine>,
    /// Markdown summary and action items; None until written
    pub note: Option<String>,
}

/// Pushed to every window
#[derive(Debug, Clone, Serialize, Type, tauri_specta::Event)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VoiceEvent {
    Dictation {
        status: DictationStatus,
    },
    /// Words so far, for the title bar while Listening
    Partial {
        text: String,
    },
    Dictated {
        entry: DictationEntry,
    },
    Recording {
        status: RecordingStatus,
    },
    /// A live transcript line while Recording
    #[expect(
        dead_code,
        reason = "treeix-meetings transcribes after stop, so no live lines yet"
    )]
    Transcript {
        line: TranscriptLine,
    },
    /// Transcript and note written; the toast's "Open notes"
    Saved {
        recording: RecordingInfo,
    },
}

/// A helper that ran this long counts as healthy, so its next crash restarts fast again
const HEALTHY: Duration = Duration::from_secs(60);
const HISTORY_LIMIT: usize = 50;
const META: &str = "meeting.json";
const NOTE_TIMEOUT: Duration = Duration::from_secs(120);
const NOTE_PROMPT: &str = "Write notes for the meeting transcript below, in its language, as markdown: `## Summary` with a few \
sentences, then `## Action items` as `- [ ] Who: what` lines, or `None`. Reply with the notes only.\n\n";
/// Modifiers the voice helper knows, by `KeyboardEvent.code`
const MODIFIERS: [&str; 9] = [
    "MetaLeft",
    "MetaRight",
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "ShiftLeft",
    "ShiftRight",
    "Fn",
];
/// Bundle id prefix and title of the call apps whose audio a recording taps.
/// ponytail: first app on the microphone wins; Electron's URL rules and calendar titles when two calls overlap
const CALL_APPS: [(&str, &str); 5] = [
    ("us.zoom.xos", "Zoom"),
    ("com.microsoft.teams2", "Microsoft Teams"),
    ("com.tinyspeck.slackmacgap", "Slack huddle"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.google.Chrome", "Google Meet"),
];

/// A sidecar kept running: restarted on exit with backoff (Electron's superviseHelper). Dropping it stops the helper.
pub(crate) struct Supervisor {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
    stop: Option<mpsc::Sender<()>>,
}

impl Supervisor {
    /// None when the binary isn't there. `on_line` gets each stdout line, `on_down` why it stopped before a restart.
    pub(crate) fn start(
        path: PathBuf,
        on_line: impl Fn(&str) + Send + 'static,
        on_down: impl Fn(String) + Send + 'static,
    ) -> Option<Self> {
        if !path.is_file() {
            return None;
        }
        let (stop, stopped) = mpsc::channel::<()>();
        let stdin = Arc::new(Mutex::new(None));
        let child = Arc::new(Mutex::new(None));
        let (stdin_slot, child_slot) = (stdin.clone(), child.clone());
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let is_stopped = move |rx: &mpsc::Receiver<()>| {
            matches!(
                rx.try_recv(),
                Ok(()) | Err(mpsc::TryRecvError::Disconnected)
            )
        };
        std::thread::spawn(move || {
            let mut failures = 0u32;
            loop {
                let started = Instant::now();
                let reason = match Command::new(&path)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .spawn()
                {
                    Ok(mut process) => {
                        let stdout = process.stdout.take();
                        *lock(&stdin_slot) = process.stdin.take();
                        *lock(&child_slot) = Some(process);
                        if is_stopped(&stopped) {
                            if let Some(mut process) = lock(&child_slot).take() {
                                let _ = process.kill();
                                let _ = process.wait();
                            }
                            return;
                        }
                        if let Some(stdout) = stdout {
                            for line in BufReader::new(stdout).lines().map_while(io::Result::ok) {
                                on_line(&line);
                            }
                        }
                        *lock(&stdin_slot) = None;
                        let status = lock(&child_slot).take().map(|mut p| p.wait());
                        match status {
                            Some(Ok(status)) => match status.code() {
                                Some(code) => format!("exit {code}"),
                                None => "killed".into(),
                            },
                            Some(Err(e)) => e.to_string(),
                            None => "killed".into(),
                        }
                    }
                    Err(e) => e.to_string(),
                };
                if is_stopped(&stopped) {
                    return;
                }
                on_down(format!("The {name} helper stopped ({reason}), restarting"));
                if started.elapsed() > HEALTHY {
                    failures = 0;
                }
                let backoff = Duration::from_millis((500u64 << failures.min(6)).min(30_000));
                failures += 1;
                if !matches!(
                    stopped.recv_timeout(backoff),
                    Err(mpsc::RecvTimeoutError::Timeout)
                ) {
                    return;
                }
            }
        });
        Some(Self {
            stdin,
            child,
            stop: Some(stop),
        })
    }

    /// One JSON line on the helper's stdin
    pub(crate) fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = lock(&self.stdin);
        let pipe = stdin.as_mut().ok_or("The helper isn't running")?;
        writeln!(pipe, "{message}")
            .and_then(|()| pipe.flush())
            .map_err(|e| e.to_string())
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(child) = lock(&self.child).as_mut() {
            let _ = child.kill();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the voice helper prints
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum VoiceMessage {
    Ready,
    Models {
        models: Vec<HelperModel>,
    },
    /// `continues`: a later piece of a dictation still being spoken
    Transcript {
        id: i64,
        text: String,
        app: Option<String>,
        #[serde(default)]
        continues: bool,
    },
    Phase {
        phase: DictationPhase,
    },
    Permissions {
        microphone: Access,
        accessibility: bool,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, PartialEq, Deserialize)]
struct HelperModel {
    id: String,
    state: ModelPhase,
    progress: Option<f64>,
    error: Option<String>,
}

/// What the meetings helper prints; calendar replies are ignored
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum MeetingsMessage {
    Ready,
    /// Bundle ids using the microphone
    Mic {
        apps: Vec<String>,
    },
    Stopped {
        folder: String,
    },
    Transcript {
        folder: String,
        utterances: Vec<Utterance>,
    },
    Error {
        message: String,
        folder: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Utterance {
    speaker: String,
    /// Seconds from the start
    start: f64,
    text: String,
}

/// meeting.json in each recording folder
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meeting {
    title: String,
    started_at: u64,
    duration_ms: u64,
    /// recording, transcribing, done or failed
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Voice {
    dictation: Mutex<DictationStatus>,
    dictation_helper: Mutex<Option<Supervisor>>,
    recording: Mutex<RecordingStatus>,
    /// The folder of the recording in progress or being saved
    folder: Mutex<Option<PathBuf>>,
    meetings_helper: Mutex<Option<Supervisor>>,
    mic_apps: Mutex<Vec<String>>,
}

fn voice(app: &AppHandle) -> &Voice {
    app.state::<Voice>().inner()
}

fn emit(app: &AppHandle, event: VoiceEvent) {
    if let Err(e) = event.emit(app) {
        tracing::warn!("voice event: {e}");
    }
}

fn update_dictation(app: &AppHandle, change: impl FnOnce(&mut DictationStatus)) {
    let status = {
        let mut status = lock(&voice(app).dictation);
        change(&mut status);
        status.clone()
    };
    emit(app, VoiceEvent::Dictation { status });
}

fn update_recording(app: &AppHandle, change: impl FnOnce(&mut RecordingStatus)) -> RecordingStatus {
    let status = {
        let mut status = lock(&voice(app).recording);
        change(&mut status);
        status.clone()
    };
    emit(
        app,
        VoiceEvent::Recording {
            status: status.clone(),
        },
    );
    status
}

/// Apple silicon on macOS 14 (Darwin 23) or later, what FluidAudio needs
fn supported() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        // SAFETY: utsname is plain data and uname only writes into it
        let mut name: libc::utsname = unsafe { std::mem::zeroed() };
        // SAFETY: a valid pointer for the call
        if unsafe { libc::uname(&mut name) } != 0 {
            return false;
        }
        // SAFETY: uname wrote a NUL-terminated string
        let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) };
        release
            .to_string_lossy()
            .split('.')
            .next()
            .and_then(|major| major.parse::<u32>().ok())
            .is_some_and(|major| major >= 23)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    false
}

fn sidecar(name: &str) -> PathBuf {
    std::env::current_exe()
        .map(|exe| exe.with_file_name(name))
        .unwrap_or_default()
}

fn models_path() -> String {
    treeix_proto::data_dir()
        .join("models")
        .to_string_lossy()
        .into_owned()
}

/// The saved chord when every key is one the helper knows, else the default
fn hotkey(saved: &[String]) -> Vec<String> {
    if !saved.is_empty() && saved.iter().all(|key| MODIFIERS.contains(&key.as_str())) {
        saved.to_vec()
    } else {
        settings::Dictation::default().hotkey
    }
}

fn configure_dictation(saved: &Settings) -> Value {
    let dictation = &saved.dictation;
    json!({
        "type": "configure",
        "hotkey": hotkey(&dictation.hotkey),
        "tapToToggle": dictation.tap_to_toggle,
        "sounds": dictation.sounds,
        "model": dictation.model,
        "formatting": false,
        "modelsPath": models_path(),
    })
}

/// In setup: starts the helpers whose feature is on, and restarts them when settings change
pub fn setup(app: &AppHandle) {
    let helper = if supported() {
        HelperState::Starting
    } else {
        HelperState::Unsupported
    };
    app.manage(Voice {
        dictation: Mutex::new(DictationStatus {
            helper,
            models: Vec::new(),
            microphone: Access::NotAsked,
            accessibility: Access::NotAsked,
            phase: DictationPhase::Idle,
            error: None,
        }),
        dictation_helper: Mutex::new(None),
        recording: Mutex::new(RecordingStatus {
            helper,
            phase: RecordingPhase::Idle,
            title: None,
            started_at: None,
            elapsed_ms: 0,
            error: None,
        }),
        folder: Mutex::new(None),
        meetings_helper: Mutex::new(None),
        mic_apps: Mutex::new(Vec::new()),
    });
    apply(app, &settings::load(&treeix_proto::data_dir()));
    let handle = app.clone();
    crate::commands::SettingsChanged::listen_any(app, move |event| {
        apply(&handle, &event.payload.settings);
    });
}

/// Starts or stops each helper by its feature and passes the dictation settings on
fn apply(app: &AppHandle, saved: &Settings) {
    if !supported() {
        return;
    }
    let state = voice(app);
    {
        let mut slot = lock(&state.dictation_helper);
        if !saved.features.dictation {
            *slot = None;
        } else if let Some(helper) = slot.as_ref() {
            let _ = helper.send(&configure_dictation(saved));
        } else {
            let (lines, down) = (app.clone(), app.clone());
            *slot = Supervisor::start(
                sidecar("treeix-voice"),
                move |line| on_voice_line(&lines, line),
                move |reason| {
                    update_dictation(&down, |s| {
                        s.helper = HelperState::Crashed;
                        s.phase = DictationPhase::Idle;
                        s.error = Some(reason);
                    });
                },
            );
            let helper = if slot.is_some() {
                HelperState::Starting
            } else {
                HelperState::Missing
            };
            drop(slot);
            update_dictation(app, |s| s.helper = helper);
        }
    }
    let mut slot = lock(&state.meetings_helper);
    if !saved.features.recording {
        *slot = None;
    } else if slot.is_none() {
        let (lines, down) = (app.clone(), app.clone());
        *slot = Supervisor::start(
            sidecar("treeix-meetings"),
            move |line| on_meetings_line(&lines, line),
            move |reason| {
                *lock(&voice(&down).folder) = None;
                update_recording(&down, |s| {
                    *s = RecordingStatus {
                        helper: HelperState::Crashed,
                        phase: RecordingPhase::Idle,
                        title: None,
                        started_at: None,
                        elapsed_ms: 0,
                        error: Some(reason),
                    };
                });
            },
        );
        let helper = if slot.is_some() {
            HelperState::Starting
        } else {
            HelperState::Missing
        };
        drop(slot);
        update_recording(app, |s| s.helper = helper);
    }
}

fn send_dictation(app: &AppHandle, message: &Value) -> Result<(), String> {
    lock(&voice(app).dictation_helper)
        .as_ref()
        .ok_or("Dictation is off")?
        .send(message)
}

fn send_meetings(app: &AppHandle, message: &Value) -> Result<(), String> {
    lock(&voice(app).meetings_helper)
        .as_ref()
        .ok_or("Meeting recording is off")?
        .send(message)
}

fn on_voice_line(app: &AppHandle, line: &str) {
    let Ok(message) = serde_json::from_str::<VoiceMessage>(line) else {
        return;
    };
    match message {
        VoiceMessage::Ready => {
            update_dictation(app, |s| {
                s.helper = HelperState::Running;
                s.error = None;
            });
            let _ = send_dictation(
                app,
                &configure_dictation(&settings::load(&treeix_proto::data_dir())),
            );
        }
        VoiceMessage::Models { models } => update_dictation(app, |s| {
            s.models = models
                .into_iter()
                .map(|m| VoiceModel {
                    id: m.id,
                    phase: m.state,
                    progress: m.progress,
                    error: m.error,
                })
                .collect();
        }),
        VoiceMessage::Phase { phase } => update_dictation(app, |s| s.phase = phase),
        VoiceMessage::Permissions {
            microphone,
            accessibility,
        } => update_dictation(app, |s| {
            s.microphone = microphone;
            s.accessibility = if accessibility {
                Access::Granted
            } else {
                Access::NotAsked
            };
        }),
        VoiceMessage::Error { message } => update_dictation(app, |s| s.error = Some(message)),
        VoiceMessage::Transcript {
            id,
            text: raw,
            app: target,
            continues,
        } => {
            let saved = settings::load(&treeix_proto::data_dir());
            let text = apply_vocabulary(&raw, &saved.dictation.vocabulary);
            let _ = send_dictation(app, &json!({ "type": "insert", "id": id, "text": text }));
            let entry =
                match record_dictation(&history_path(), now_ms(), raw, text, target, continues) {
                    Ok(entry) => entry,
                    Err(e) => {
                        update_dictation(app, |s| {
                            s.error = Some(format!("Couldn't save history: {e}"))
                        });
                        return;
                    }
                };
            if lock(&voice(app).dictation).phase == DictationPhase::Listening {
                emit(
                    app,
                    VoiceEvent::Partial {
                        text: entry.text.clone(),
                    },
                );
            }
            emit(app, VoiceEvent::Dictated { entry });
        }
    }
}

fn history_path() -> PathBuf {
    treeix_proto::data_dir()
        .join("dictation")
        .join("history.json")
}

fn read_history(path: &Path) -> Vec<DictationEntry> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Adds a dictation to the history, newest first; pieces of one dictation are one entry
fn record_dictation(
    path: &Path,
    at: u64,
    raw: String,
    text: String,
    app: Option<String>,
    continues: bool,
) -> io::Result<DictationEntry> {
    let mut history = read_history(path);
    match history.first_mut() {
        Some(last) if continues => {
            last.raw = format!("{} {raw}", last.raw);
            last.text = format!("{} {text}", last.text);
        }
        _ => {
            history.insert(0, DictationEntry { at, raw, text, app });
            history.truncate(HISTORY_LIMIT);
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec(&history)?)?;
    Ok(history.swap_remove(0))
}

/// Replaces each term's aliases, and the term in any case, with the term as written; whole words only, in any script
fn apply_vocabulary(input: &str, terms: &[settings::VocabularyTerm]) -> String {
    let mut replacements: Vec<(String, &str)> = Vec::new();
    for term in terms {
        for alias in term.aliases.iter().chain([&term.text]) {
            let key = alias.trim().to_lowercase();
            if key.is_empty() {
                continue;
            }
            replacements.retain(|(existing, _)| *existing != key);
            replacements.push((key, &term.text));
        }
    }
    // Longest first, so "git hub" wins over "git"
    replacements.sort_by_key(|(key, _)| std::cmp::Reverse(key.chars().count()));
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let mut previous: Option<char> = None;
    'scan: while let Some(first) = rest.chars().next() {
        if !previous.is_some_and(char::is_alphanumeric) {
            for (key, text) in &replacements {
                if let Some(len) = match_ignoring_case(rest, key)
                    && !rest[len..]
                        .chars()
                        .next()
                        .is_some_and(char::is_alphanumeric)
                {
                    out.push_str(text);
                    previous = rest[..len].chars().last();
                    rest = &rest[len..];
                    continue 'scan;
                }
            }
        }
        out.push(first);
        previous = Some(first);
        rest = &rest[first.len_utf8()..];
    }
    out
}

/// Bytes of `input` that spell `lower` (already lowercase) in any case
fn match_ignoring_case(input: &str, lower: &str) -> Option<usize> {
    let mut wanted = lower.chars();
    let mut len = 0;
    for c in input.chars() {
        if wanted.as_str().is_empty() {
            break;
        }
        for l in c.to_lowercase() {
            if wanted.next() != Some(l) {
                return None;
            }
        }
        len += c.len_utf8();
    }
    wanted.as_str().is_empty().then_some(len)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// `YYYY-MM-DD HHMM` in local time
fn local_stamp(ms: u64) -> String {
    let seconds = (ms / 1000) as libc::time_t;
    // SAFETY: tm is plain data
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: both pointers are valid for the call
    unsafe { libc::localtime_r(&seconds, &mut tm) };
    format!(
        "{:04}-{:02}-{:02} {:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min
    )
}

fn folder_name(title: &str, stamp: &str) -> String {
    let title: String = title
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .collect();
    format!("{stamp} {}", title.trim()).trim().to_string()
}

/// `**[00:01:05] Speaker 1:** text` lines under the title
fn render_transcript(title: &str, utterances: &[Utterance]) -> String {
    let lines: Vec<String> = utterances
        .iter()
        .map(|u| {
            let s = u.start.max(0.0) as u64;
            format!(
                "**[{:02}:{:02}:{:02}] {}:** {}",
                s / 3600,
                s / 60 % 60,
                s % 60,
                u.speaker,
                u.text
            )
        })
        .collect();
    format!("# {title}\n\n{}\n", lines.join("\n\n"))
}

fn recordings_root() -> PathBuf {
    let saved = settings::load(&treeix_proto::data_dir());
    match saved.recording.folder.filter(|f| !f.trim().is_empty()) {
        Some(folder) => match (folder.strip_prefix("~/"), std::env::var_os("HOME")) {
            (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
            _ => PathBuf::from(folder),
        },
        None => treeix_proto::data_dir().join("recordings"),
    }
}

/// A new folder for a recording; two in the same minute with the same title get ` 2`, ` 3`
fn create_meeting(root: &Path, meeting: &Meeting) -> io::Result<PathBuf> {
    let name = folder_name(&meeting.title, &local_stamp(meeting.started_at));
    let mut folder = root.join(&name);
    let mut copy = 2;
    while folder.exists() {
        folder = root.join(format!("{name} {copy}"));
        copy += 1;
    }
    std::fs::create_dir_all(&folder)?;
    write_meeting(&folder, meeting)?;
    Ok(folder)
}

fn write_meeting(folder: &Path, meeting: &Meeting) -> io::Result<()> {
    std::fs::write(folder.join(META), serde_json::to_vec_pretty(meeting)?)
}

fn read_meeting(folder: &Path) -> Option<Meeting> {
    serde_json::from_slice(&std::fs::read(folder.join(META)).ok()?).ok()
}

/// The folder for an id, refusing anything that isn't a plain folder name
fn meeting_folder(root: &Path, id: &str) -> Result<PathBuf, String> {
    let plain = !id.is_empty()
        && !id.starts_with('.')
        && Path::new(id).file_name() == Some(std::ffi::OsStr::new(id))
        && !id.contains(['/', '\\']);
    if plain {
        Ok(root.join(id))
    } else {
        Err(format!("Not a recording: {id}"))
    }
}

fn info(folder: &Path, meeting: &Meeting) -> RecordingInfo {
    RecordingInfo {
        id: folder
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned()),
        title: meeting.title.clone(),
        started_at: meeting.started_at,
        duration_ms: meeting.duration_ms,
        folder: folder.to_string_lossy().into_owned(),
        has_note: folder.join("note.md").is_file(),
    }
}

fn on_meetings_line(app: &AppHandle, line: &str) {
    let Ok(message) = serde_json::from_str::<MeetingsMessage>(line) else {
        return;
    };
    match message {
        MeetingsMessage::Ready => {
            update_recording(app, |s| {
                s.helper = HelperState::Running;
                s.error = None;
            });
            let _ = send_meetings(
                app,
                &json!({ "type": "configure", "modelsPath": models_path() }),
            );
            recover(app);
        }
        MeetingsMessage::Mic { apps } => *lock(&voice(app).mic_apps) = apps,
        MeetingsMessage::Stopped { folder } => {
            let language = settings::load(&treeix_proto::data_dir()).recording.language;
            let _ = send_meetings(
                app,
                &json!({ "type": "transcribe", "folder": folder, "language": language }),
            );
        }
        MeetingsMessage::Transcript { folder, utterances } => {
            tauri::async_runtime::spawn(save(app.clone(), PathBuf::from(folder), utterances));
        }
        MeetingsMessage::Error { message, folder } => {
            let failed = folder.map(PathBuf::from);
            if let Some(folder) = &failed
                && let Some(mut meeting) = read_meeting(folder)
            {
                meeting.status = "failed".into();
                meeting.error = Some(message.clone());
                let _ = write_meeting(folder, &meeting);
            }
            let current = lock(&voice(app).folder).clone();
            let ends = failed.is_some() && failed == current;
            if ends {
                *lock(&voice(app).folder) = None;
            }
            update_recording(app, |s| {
                if ends {
                    s.phase = RecordingPhase::Idle;
                    s.title = None;
                    s.started_at = None;
                    s.elapsed_ms = 0;
                }
                s.error = Some(message);
            });
        }
    }
}

/// Recordings left recording or transcribing by a crash or quit are transcribed now
fn recover(app: &AppHandle) {
    let current = lock(&voice(app).folder).clone();
    let Ok(entries) = std::fs::read_dir(recordings_root()) else {
        return;
    };
    let language = settings::load(&treeix_proto::data_dir()).recording.language;
    for folder in entries.flatten().map(|e| e.path()) {
        let unfinished = read_meeting(&folder)
            .is_some_and(|m| m.status == "recording" || m.status == "transcribing");
        if unfinished && Some(&folder) != current.as_ref() {
            let _ = send_meetings(
                app,
                &json!({ "type": "transcribe", "folder": folder, "language": language }),
            );
        }
    }
}

/// Writes the transcript and the note, then tells every window
async fn save(app: AppHandle, folder: PathBuf, utterances: Vec<Utterance>) {
    let Some(mut meeting) = read_meeting(&folder) else {
        return;
    };
    let markdown = render_transcript(&meeting.title, &utterances);
    let written = serde_json::to_vec(&utterances)
        .map_err(io::Error::from)
        .and_then(|bytes| std::fs::write(folder.join("transcript.json"), bytes))
        .and_then(|()| std::fs::write(folder.join("transcript.md"), &markdown));
    let mut error = written
        .err()
        .map(|e| format!("Couldn't save the transcript: {e}"));
    if error.is_none() && !utterances.is_empty() {
        match write_note(&markdown).await {
            Ok(note) => {
                if let Err(e) = std::fs::write(folder.join("note.md"), note) {
                    error = Some(format!("Couldn't save the note: {e}"));
                }
            }
            Err(e) => error = Some(format!("Couldn't write the note: {e}")),
        }
    }
    meeting.status = "done".into();
    meeting.error.clone_from(&error);
    let _ = write_meeting(&folder, &meeting);
    let ends = lock(&voice(&app).folder).as_ref() == Some(&folder);
    if ends {
        *lock(&voice(&app).folder) = None;
    }
    update_recording(&app, |s| {
        if ends {
            s.phase = RecordingPhase::Idle;
            s.title = None;
            s.started_at = None;
            s.elapsed_ms = 0;
        }
        s.error = error;
    });
    emit(
        &app,
        VoiceEvent::Saved {
            recording: info(&folder, &meeting),
        },
    );
}

/// Summary and action items from `claude -p` in the login shell, so PATH matches the terminal
async fn write_note(transcript: &str) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = tokio::process::Command::new(shell)
        .args([
            "-lc",
            "claude -p --model haiku --no-session-persistence --tools ''",
        ])
        .current_dir(std::env::temp_dir())
        .env_remove("CLAUDECODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{NOTE_PROMPT}{transcript}").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(NOTE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "claude took too long".to_string())?
        .map_err(|e| e.to_string())?;
    let note = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !note.is_empty() {
        Ok(format!("{note}\n"))
    } else {
        Err("claude gave no notes; is it installed and signed in?".into())
    }
}

/// On exit: stops the helpers (a recording in progress is saved first)
pub fn exit(app: &AppHandle) {
    let Some(state) = app.try_state::<Voice>() else {
        return;
    };
    let recording = lock(&state.folder).is_some();
    if recording {
        // The audio is flushed on stop; the next start transcribes it
        let _ = send_meetings(app, &json!({ "type": "stop" }));
        std::thread::sleep(Duration::from_millis(500));
    }
    *lock(&state.meetings_helper) = None;
    *lock(&state.dictation_helper) = None;
}

pub fn dictation_status(app: &AppHandle) -> Result<DictationStatus, String> {
    let _ = send_dictation(app, &json!({ "type": "permissions" }));
    Ok(lock(&voice(app).dictation).clone())
}

/// Starts or ends listening, like a tap on the hotkey (the title bar's mic)
pub fn dictation_toggle(app: &AppHandle) -> Result<(), String> {
    send_dictation(app, &json!({ "type": "toggle" }))
}

pub fn model_download(app: &AppHandle, model: &str) -> Result<(), String> {
    send_dictation(app, &json!({ "type": "download", "model": model }))
}

pub fn model_delete(app: &AppHandle, model: &str) -> Result<(), String> {
    send_dictation(app, &json!({ "type": "delete", "model": model }))
}

/// Asks for the permission, or opens its System Settings pane once it was denied
pub fn request_access(app: &AppHandle, kind: AccessKind) -> Result<(), String> {
    let kind = match kind {
        AccessKind::Microphone => "microphone",
        AccessKind::Accessibility => "accessibility",
    };
    send_dictation(app, &json!({ "type": "request", "kind": kind }))
}

/// Newest first
pub fn dictation_history() -> Result<Vec<DictationEntry>, String> {
    Ok(read_history(&history_path()))
}

pub fn recording_status(app: &AppHandle) -> Result<RecordingStatus, String> {
    Ok(lock(&voice(app).recording).clone())
}

pub fn recording_start(app: &AppHandle, title: Option<String>) -> Result<RecordingStatus, String> {
    let current = recording_status(app)?;
    if current.helper != HelperState::Running {
        return Err("The recording helper isn't running".into());
    }
    if current.phase != RecordingPhase::Idle {
        return Err("Already recording".into());
    }
    let call = {
        let mic = lock(&voice(app).mic_apps);
        CALL_APPS
            .iter()
            .find(|(bundle, _)| mic.iter().any(|app| app.starts_with(bundle)))
            .copied()
    };
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| call.map(|(_, name)| name.to_string()))
        .unwrap_or_else(|| "Recording".into());
    let started_at = now_ms();
    let meeting = Meeting {
        title: title.clone(),
        started_at,
        duration_ms: 0,
        status: "recording".into(),
        error: None,
    };
    let folder = create_meeting(&recordings_root(), &meeting)
        .map_err(|e| format!("Couldn't create the recording folder: {e}"))?;
    send_meetings(
        app,
        &json!({ "type": "record", "folder": folder, "app": call.map_or("", |(bundle, _)| bundle) }),
    )?;
    *lock(&voice(app).folder) = Some(folder);
    Ok(update_recording(app, |s| {
        s.phase = RecordingPhase::Recording;
        s.title = Some(title);
        s.started_at = Some(started_at);
        s.elapsed_ms = 0;
        s.error = None;
    }))
}

/// Ms recorded so far
fn elapsed(status: &RecordingStatus, now: u64) -> u64 {
    status.elapsed_ms + status.started_at.map_or(0, |at| now.saturating_sub(at))
}

pub fn recording_pause(app: &AppHandle, paused: bool) -> Result<RecordingStatus, String> {
    let current = recording_status(app)?;
    if !matches!(
        current.phase,
        RecordingPhase::Recording | RecordingPhase::Paused
    ) {
        return Err("Not recording".into());
    }
    if paused == (current.phase == RecordingPhase::Paused) {
        return Ok(current);
    }
    send_meetings(app, &json!({ "type": "pause", "paused": paused }))?;
    let now = now_ms();
    Ok(update_recording(app, |s| {
        if paused {
            s.elapsed_ms = elapsed(s, now);
            s.started_at = None;
            s.phase = RecordingPhase::Paused;
        } else {
            s.started_at = Some(now);
            s.phase = RecordingPhase::Recording;
        }
    }))
}

/// Ends the recording; `Saved` follows once the transcript and note are written
pub fn recording_stop(app: &AppHandle) -> Result<RecordingStatus, String> {
    let current = recording_status(app)?;
    if !matches!(
        current.phase,
        RecordingPhase::Recording | RecordingPhase::Paused
    ) {
        return Err("Not recording".into());
    }
    send_meetings(app, &json!({ "type": "stop" }))?;
    let duration_ms = elapsed(&current, now_ms());
    if let Some(folder) = lock(&voice(app).folder).as_ref()
        && let Some(mut meeting) = read_meeting(folder)
    {
        meeting.duration_ms = duration_ms;
        meeting.status = "transcribing".into();
        let _ = write_meeting(folder, &meeting);
    }
    Ok(update_recording(app, |s| {
        s.phase = RecordingPhase::Saving;
        s.elapsed_ms = duration_ms;
        s.started_at = None;
    }))
}

/// Newest first
pub fn recordings() -> Result<Vec<RecordingInfo>, String> {
    Ok(list_recordings(&recordings_root()))
}

fn list_recordings(root: &Path) -> Vec<RecordingInfo> {
    let mut found: Vec<RecordingInfo> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| read_meeting(&e.path()).map(|m| info(&e.path(), &m)))
                .collect()
        })
        .unwrap_or_default();
    found.sort_by_key(|r| std::cmp::Reverse(r.started_at));
    found
}

/// Refuses an id that is not a folder name in the recordings folder
pub fn recording_read(id: &str) -> Result<RecordingNote, String> {
    read_recording(&recordings_root(), id)
}

fn read_recording(root: &Path, id: &str) -> Result<RecordingNote, String> {
    let folder = meeting_folder(root, id)?;
    let meeting = read_meeting(&folder).ok_or_else(|| format!("No recording {id}"))?;
    let utterances: Vec<Utterance> = std::fs::read(folder.join("transcript.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    Ok(RecordingNote {
        info: info(&folder, &meeting),
        transcript: utterances
            .into_iter()
            .map(|u| TranscriptLine {
                at: (u.start.max(0.0) * 1000.0) as u64,
                speaker: Some(u.speaker),
                text: u.text,
            })
            .collect(),
        note: std::fs::read_to_string(folder.join("note.md")).ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("treeix-voice-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn term(text: &str, aliases: &[&str]) -> settings::VocabularyTerm {
        settings::VocabularyTerm {
            text: text.into(),
            aliases: aliases.iter().map(|a| (*a).into()).collect(),
        }
    }

    #[test]
    fn vocabulary_replaces_whole_words_in_any_case_and_script_longest_first() {
        let terms = [
            term("GitHub", &["git hub"]),
            term("Treeix", &["трікс", "tricks"]),
            term("Claude", &[]),
        ];
        assert_eq!(
            apply_vocabulary("Open Git Hub and claude", &terms),
            "Open GitHub and Claude"
        );
        assert_eq!(
            apply_vocabulary("Відкрий Трікс, будь ласка", &terms),
            "Відкрий Treeix, будь ласка"
        );
        assert_eq!(
            apply_vocabulary("magic tricksters трікса", &terms),
            "magic tricksters трікса"
        );
        assert_eq!(apply_vocabulary("a (b) c", &[term("B", &["(b)"])]), "a B c");
        assert_eq!(apply_vocabulary("nothing here", &[]), "nothing here");
    }

    #[test]
    fn helper_lines_parse_and_the_rest_is_ignored() {
        let parse = |line: &str| serde_json::from_str::<VoiceMessage>(line).ok();
        assert_eq!(parse(r#"{"type":"ready"}"#), Some(VoiceMessage::Ready));
        assert_eq!(
            parse(
                r#"{"type":"models","models":[{"id":"parakeet-v3","state":"downloading","progress":0.5}]}"#
            ),
            Some(VoiceMessage::Models {
                models: vec![HelperModel {
                    id: "parakeet-v3".into(),
                    state: ModelPhase::Downloading,
                    progress: Some(0.5),
                    error: None,
                }]
            })
        );
        assert_eq!(
            parse(r#"{"type":"transcript","id":3,"text":"hi","app":null,"continues":true}"#),
            Some(VoiceMessage::Transcript {
                id: 3,
                text: "hi".into(),
                app: None,
                continues: true,
            })
        );
        assert_eq!(
            parse(r#"{"type":"permissions","microphone":"notAsked","accessibility":true}"#),
            Some(VoiceMessage::Permissions {
                microphone: Access::NotAsked,
                accessibility: true,
            })
        );
        assert_eq!(parse(r#"{"type":"transcript","id":"x","text":"hi"}"#), None);
        assert_eq!(parse("FluidAudio: loading"), None);
        assert_eq!(parse(r#"{"type":"calendar","event":null}"#), None);
        assert!(
            serde_json::from_str::<MeetingsMessage>(
                r#"{"type":"mic","apps":["us.zoom.xos"],"camera":false}"#
            )
            .is_ok()
        );
        assert!(
            serde_json::from_str::<MeetingsMessage>(r#"{"type":"events","events":[]}"#).is_err()
        );
    }

    #[test]
    fn hotkey_keeps_known_modifiers_else_the_default() {
        let keys = |k: &[&str]| k.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(hotkey(&keys(&["AltLeft", "Fn"])), keys(&["AltLeft", "Fn"]));
        assert_eq!(hotkey(&keys(&["KeyA"])), keys(&["MetaLeft", "AltRight"]));
        assert_eq!(hotkey(&[]), keys(&["MetaLeft", "AltRight"]));
    }

    #[test]
    fn history_merges_pieces_and_keeps_the_newest() {
        let path = scratch("history").join("dictation/history.json");
        let first = record_dictation(&path, 1, "hello".into(), "Hello".into(), None, false);
        assert_eq!(first.map(|e| e.text).ok(), Some("Hello".into()));
        let merged = record_dictation(&path, 2, "there".into(), "there".into(), None, true);
        assert_eq!(
            merged.map(|e| (e.at, e.text)).ok(),
            Some((1, "Hello there".into()))
        );
        for at in 0..60 {
            let _ = record_dictation(&path, at, "x".into(), "x".into(), None, false);
        }
        let history = read_history(&path);
        assert_eq!(history.len(), HISTORY_LIMIT);
        assert_eq!(history[0].at, 59);
    }

    #[test]
    fn folders_transcripts_and_ids() {
        assert_eq!(
            folder_name("Design / review: v2", "2026-10-14 0905"),
            "2026-10-14 0905 Design - review- v2"
        );
        let utterances = [
            Utterance {
                speaker: "Me".into(),
                start: 3.7,
                text: "Hi".into(),
            },
            Utterance {
                speaker: "Speaker 1".into(),
                start: 3725.0,
                text: "Hello".into(),
            },
        ];
        assert_eq!(
            render_transcript("Daily", &utterances),
            "# Daily\n\n**[00:00:03] Me:** Hi\n\n**[01:02:05] Speaker 1:** Hello\n"
        );

        let root = scratch("store");
        let meeting = Meeting {
            title: "Daily".into(),
            started_at: 1_000,
            duration_ms: 0,
            status: "done".into(),
            error: None,
        };
        let first = create_meeting(&root, &meeting).expect("first");
        let second = create_meeting(
            &root,
            &Meeting {
                started_at: 2_000,
                ..meeting.clone()
            },
        )
        .expect("second");
        let stamp = local_stamp(1_000);
        assert_eq!(first, root.join(format!("{stamp} Daily")));
        if local_stamp(2_000) == stamp {
            assert_eq!(second, root.join(format!("{stamp} Daily 2")));
        }
        std::fs::write(
            first.join("transcript.json"),
            serde_json::to_vec(&utterances).expect("json"),
        )
        .expect("transcript");
        std::fs::write(first.join("note.md"), "- ship it\n").expect("note");

        let listed = list_recordings(&root);
        assert_eq!(
            listed.iter().map(|r| r.started_at).collect::<Vec<_>>(),
            [2_000, 1_000]
        );
        let id = listed[1].id.clone();
        let note = read_recording(&root, &id).expect("read");
        assert!(note.info.has_note);
        assert_eq!(note.note.as_deref(), Some("- ship it\n"));
        assert_eq!(note.transcript[1].at, 3_725_000);
        for bad in ["../elsewhere", "a/b", "..", ".hidden", ""] {
            assert!(read_recording(&root, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn supervisor_restarts_a_crashed_helper_until_dropped() {
        let dir = scratch("supervisor");
        let script = dir.join("fake-helper");
        std::fs::write(&script, "#!/bin/sh\necho '{\"type\":\"ready\"}'\nexit 3\n")
            .expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        assert!(Supervisor::start(dir.join("missing"), |_| {}, |_| {}).is_none());

        let (lines, got_line) = mpsc::channel();
        let (downs, got_down) = mpsc::channel();
        let helper = Supervisor::start(
            script,
            move |line| {
                let _ = lines.send(line.to_string());
            },
            move |reason| {
                let _ = downs.send(reason);
            },
        )
        .expect("helper");
        let wait = Duration::from_secs(5);
        assert_eq!(
            got_line.recv_timeout(wait).ok().as_deref(),
            Some(r#"{"type":"ready"}"#)
        );
        assert_eq!(
            got_down.recv_timeout(wait).ok().as_deref(),
            Some("The fake-helper helper stopped (exit 3), restarting")
        );
        // Restarted after the backoff
        assert!(got_line.recv_timeout(wait).is_ok());
        drop(helper);
        std::thread::sleep(Duration::from_millis(1_500));
        while got_line.try_recv().is_ok() {}
        std::thread::sleep(Duration::from_millis(1_500));
        assert!(got_line.try_recv().is_err(), "no restart after drop");
    }
}
