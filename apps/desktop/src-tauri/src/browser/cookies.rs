//! Cookie import from the user's other browsers into the panes' data store: Chromium-based browsers (Keychain key,
//! AES-128-CBC), Firefox and Safari. A one-off copy, not a sync. macOS only for now.
//! Port of the Electron app's browser cookies module.

use super::{BrowserProfile, CookieImport};
use tauri::webview::cookie::{Cookie, SameSite, time::OffsetDateTime};

/// Seconds between 1601-01-01, Chromium's epoch, and 1970-01-01
const WINDOWS_EPOCH_OFFSET: i64 = 11_644_473_600;
/// From this cookie database version on, the plaintext starts with a SHA-256 of the cookie's host
const HOST_HASH_VERSION: i64 = 24;
/// Seconds between 1970-01-01 and 2001-01-01, Safari's epoch
const MAC_EPOCH_OFFSET: f64 = 978_307_200.0;
/// How long an imported session cookie lives; many sites keep the login in one
const SESSION_COOKIE_SECONDS: i64 = 30 * 24 * 60 * 60;

/// A cookie to set; `domain` is the source's host key, with a leading dot for domain cookies
#[derive(Debug, Clone, PartialEq)]
struct Imported {
    domain: String,
    name: String,
    value: String,
    path: String,
    secure: bool,
    http_only: bool,
    /// None leaves the browser's default
    same_site: Option<SameSite>,
    expires: i64,
}

impl Imported {
    fn cookie(&self) -> Option<Cookie<'static>> {
        let expires = OffsetDateTime::from_unix_timestamp(self.expires).ok()?;
        let mut cookie = Cookie::build((self.name.clone(), self.value.clone()))
            .domain(self.domain.clone())
            .path(if self.path.is_empty() {
                "/".into()
            } else {
                self.path.clone()
            })
            .secure(self.secure)
            .http_only(self.http_only)
            .expires(expires)
            .build();
        if let Some(same_site) = self.same_site {
            cookie.set_same_site(same_site);
        }
        Some(cookie)
    }
}

/// Chromium and Firefox share these codes; anything else leaves the browser's default
fn same_site(code: i64) -> Option<SameSite> {
    match code {
        0 => Some(SameSite::None),
        1 => Some(SameSite::Lax),
        2 => Some(SameSite::Strict),
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
struct ChromiumRow {
    host_key: String,
    name: String,
    path: String,
    expires_utc: i64,
    is_secure: bool,
    is_httponly: bool,
    samesite: i64,
    has_expires: bool,
}

/// Expired cookies are skipped; session cookies come along for a month, since Chrome holds on to them too
fn chromium_cookie(row: &ChromiumRow, value: String, now: i64) -> Option<Imported> {
    let expires = if row.has_expires {
        row.expires_utc / 1_000_000 - WINDOWS_EPOCH_OFFSET
    } else {
        now + SESSION_COOKIE_SECONDS
    };
    (expires > now).then(|| Imported {
        domain: row.host_key.clone(),
        name: row.name.clone(),
        value,
        path: row.path.clone(),
        secure: row.is_secure,
        http_only: row.is_httponly,
        same_site: same_site(row.samesite),
        expires,
    })
}

#[derive(Debug, Clone, Default)]
struct FirefoxRow {
    host: String,
    name: String,
    value: String,
    path: String,
    expiry: i64,
    is_secure: bool,
    is_http_only: bool,
    same_site: i64,
}

fn firefox_cookie(row: &FirefoxRow, now: i64) -> Option<Imported> {
    // Newer Firefox stores expiry in milliseconds
    let expires = if row.expiry > 100_000_000_000 {
        row.expiry / 1000
    } else {
        row.expiry
    };
    (expires > now).then(|| Imported {
        domain: row.host.clone(),
        name: row.name.clone(),
        value: row.value.clone(),
        path: row.path.clone(),
        secure: row.is_secure,
        http_only: row.is_http_only,
        // Firefox stores 0 both for SameSite=None and for no attribute; WebKit drops None without Secure
        same_site: if row.same_site == 0 && !row.is_secure {
            None
        } else {
            same_site(row.same_site)
        },
        expires,
    })
}

/// Safari's Cookies.binarycookies: "cook", a big-endian page count and page sizes, then pages whose own numbers are
/// little-endian. Each cookie holds flags, offsets to its null-terminated strings, and an expiry in seconds since
/// 2001. Expired ones come back as None.
fn safari_cookies(file: &[u8], now: i64) -> Result<Vec<Option<Imported>>, String> {
    const SECURE: u32 = 1;
    const HTTP_ONLY: u32 = 4;
    let broken = || "Not a Safari cookies file".to_string();
    let bytes = |data: &[u8], at: usize, len: usize| {
        data.get(at..at + len)
            .map(<[u8]>::to_vec)
            .ok_or_else(broken)
    };
    let be = |data: &[u8], at| {
        bytes(data, at, 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let le =
        |data: &[u8], at| bytes(data, at, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let string = |data: &[u8], at: usize| -> Result<String, String> {
        let rest = data.get(at..).ok_or_else(broken)?;
        let end = rest.iter().position(|&b| b == 0).ok_or_else(broken)?;
        Ok(String::from_utf8_lossy(&rest[..end]).into_owned())
    };
    if file.get(..4) != Some(b"cook") {
        return Err(broken());
    }
    let pages = be(file, 4)?;
    let mut start = 8 + pages * 4;
    let mut cookies = Vec::new();
    for page in 0..pages {
        let size = be(file, 8 + page * 4)?;
        let data = file.get(start..start + size).ok_or_else(broken)?;
        for index in 0..le(data, 4)? as usize {
            let cookie = data
                .get(le(data, 8 + index * 4)? as usize..)
                .ok_or_else(broken)?;
            let field = |at| le(cookie, at).map(|offset| offset as usize);
            let flags = le(cookie, 8)?;
            let expiry = bytes(cookie, 40, 8)?;
            let expiry = f64::from_le_bytes(expiry.try_into().map_err(|_| broken())?);
            let expires = (expiry + MAC_EPOCH_OFFSET).floor() as i64;
            cookies.push(if expires <= now {
                None
            } else {
                Some(Imported {
                    domain: string(cookie, field(16)?)?,
                    name: string(cookie, field(20)?)?,
                    path: string(cookie, field(24)?)?,
                    value: string(cookie, field(28)?)?,
                    secure: flags & SECURE != 0,
                    http_only: flags & HTTP_ONLY != 0,
                    same_site: None,
                    expires,
                })
            });
        }
        start += size;
    }
    Ok(cookies)
}

/// Chromium stores meta values as text; older databases may hold integers
fn meta_version(value: &serde_json::Value) -> i64 {
    match value {
        serde_json::Value::String(text) => text.trim().parse().unwrap_or(0),
        serde_json::Value::Number(number) => number.as_i64().unwrap_or(0),
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
pub use mac::{cookie_profiles, import_cookies};

#[cfg(not(target_os = "macos"))]
pub fn cookie_profiles() -> Result<Vec<BrowserProfile>, String> {
    Ok(Vec::new())
}

#[cfg(not(target_os = "macos"))]
pub fn import_cookies(app: &tauri::AppHandle, profile: &str) -> Result<CookieImport, String> {
    let _ = (app, profile);
    Err("Cookie import is macOS only for now".into())
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use serde_json::Value;
    use std::ffi::c_void;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::AppHandle;

    const CHROMIUM: [(&str, &str, &str); 6] = [
        ("Chrome", "Google/Chrome", "Chrome Safe Storage"),
        ("Arc", "Arc/User Data", "Arc Safe Storage"),
        ("Brave", "BraveSoftware/Brave-Browser", "Brave Safe Storage"),
        ("Edge", "Microsoft Edge", "Microsoft Edge Safe Storage"),
        ("Chromium", "Chromium", "Chromium Safe Storage"),
        ("Vivaldi", "Vivaldi", "Vivaldi Safe Storage"),
    ];

    enum Kind {
        Chromium { keychain: &'static str },
        Firefox,
        Safari,
    }

    /// `folder` is the profile's folder, the stable part of its key; `name` is what the browser shows
    struct Source {
        kind: Kind,
        browser: &'static str,
        folder: String,
        name: String,
        cookies: PathBuf,
    }

    impl Source {
        fn key(&self) -> String {
            format!("{}:{}", self.browser, self.folder)
        }
    }

    enum Found {
        Source(Source),
        /// macOS keeps the browser's files from Treeix
        Blocked(&'static str),
    }

    fn home() -> PathBuf {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
    }

    fn blocked(error: &std::io::Error) -> bool {
        error.kind() == ErrorKind::PermissionDenied
    }

    fn chromium(support: &Path, found: &mut Vec<Found>) {
        for (browser, dir, keychain) in CHROMIUM {
            let root = support.join(dir);
            let state = match std::fs::read(root.join("Local State")) {
                Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or_default(),
                Err(error) if blocked(&error) => {
                    found.push(Found::Blocked(browser));
                    continue;
                }
                Err(_) => continue,
            };
            let Some(cache) = state["profile"]["info_cache"].as_object() else {
                continue;
            };
            for (folder, info) in cache {
                let cookies = [
                    root.join(folder).join("Network/Cookies"),
                    root.join(folder).join("Cookies"),
                ]
                .into_iter()
                .find(|path| path.exists());
                if let Some(cookies) = cookies {
                    found.push(Found::Source(Source {
                        kind: Kind::Chromium { keychain },
                        browser,
                        folder: folder.clone(),
                        name: info["name"].as_str().unwrap_or(folder).to_string(),
                        cookies,
                    }));
                }
            }
        }
    }

    fn firefox(support: &Path, found: &mut Vec<Found>) {
        let root = support.join("Firefox");
        let ini = match std::fs::read_to_string(root.join("profiles.ini")) {
            Ok(ini) => ini,
            Err(error) if blocked(&error) => return found.push(Found::Blocked("Firefox")),
            Err(_) => return,
        };
        for section in ini
            .split("\n[")
            .filter(|s| s.trim_start_matches('[').starts_with("Profile"))
        {
            let field = |name: &str| {
                section
                    .lines()
                    .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
                    .map_or("", str::trim)
            };
            let folder = field("Path");
            if folder.is_empty() {
                continue;
            }
            let dir = if field("IsRelative") == "1" {
                root.join(folder)
            } else {
                PathBuf::from(folder)
            };
            let cookies = dir.join("cookies.sqlite");
            if cookies.exists() {
                let name = if field("Name").is_empty() {
                    folder
                } else {
                    field("Name")
                };
                found.push(Found::Source(Source {
                    kind: Kind::Firefox,
                    browser: "Firefox",
                    folder: folder.into(),
                    name: name.into(),
                    cookies,
                }));
            }
        }
    }

    /// Safari's cookies sit in its sandbox container, which macOS only opens with Full Disk Access
    fn safari(found: &mut Vec<Found>) {
        let cookies = home()
            .join("Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies");
        match std::fs::File::open(&cookies) {
            Ok(_) => found.push(Found::Source(Source {
                kind: Kind::Safari,
                browser: "Safari",
                folder: "Default".into(),
                name: "Default".into(),
                cookies,
            })),
            Err(error) if blocked(&error) => found.push(Found::Blocked("Safari")),
            Err(_) => {}
        }
    }

    fn sources() -> Vec<Found> {
        let support = home().join("Library/Application Support");
        let mut found = Vec::new();
        chromium(&support, &mut found);
        firefox(&support, &mut found);
        safari(&mut found);
        found
    }

    /// Installed browsers and their profiles; a browser macOS won't let us read shows up once, blocked
    pub fn cookie_profiles() -> Result<Vec<BrowserProfile>, String> {
        Ok(sources()
            .into_iter()
            .map(|found| match found {
                Found::Source(source) => BrowserProfile {
                    key: source.key(),
                    browser: source.browser.into(),
                    name: source.name,
                    blocked: false,
                },
                Found::Blocked(browser) => BrowserProfile {
                    key: format!("{browser}:"),
                    browser: browser.into(),
                    name: "All profiles".into(),
                    blocked: true,
                },
            })
            .collect())
    }

    /// Copies the profile's cookies into the panes' shared data store
    pub fn import_cookies(app: &AppHandle, profile: &str) -> Result<CookieImport, String> {
        let failed = |error: String| CookieImport {
            imported: 0,
            skipped: 0,
            error: Some(error),
        };
        let source = sources().into_iter().find_map(|found| match found {
            Found::Source(source) if source.key() == profile => Some(source),
            _ => None,
        });
        let Some(source) = source else {
            return Ok(failed("That browser profile is gone".into()));
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs() as i64);
        let cookies = match read(&source, now) {
            Ok(cookies) => cookies,
            Err(error) => return Ok(failed(error)),
        };
        let mut skipped = 0;
        let valid: Vec<Cookie<'static>> = cookies
            .iter()
            .filter_map(|cookie| {
                let cookie = cookie.as_ref().and_then(Imported::cookie);
                skipped += u32::from(cookie.is_none());
                cookie
            })
            .collect();
        let imported = super::super::with_store(app, |webview| {
            let mut imported = 0;
            for cookie in valid {
                match webview.set_cookie(cookie) {
                    Ok(()) => imported += 1,
                    Err(_) => skipped += 1,
                }
            }
            Ok(imported)
        })?;
        Ok(CookieImport {
            imported,
            skipped,
            error: None,
        })
    }

    fn read(source: &Source, now: i64) -> Result<Vec<Option<Imported>>, String> {
        let browser = source.browser;
        let io = |error: std::io::Error| {
            if blocked(&error) {
                let hint = if browser == "Safari" {
                    "Give Treeix Full Disk Access in System Settings > Privacy & Security, reopen Treeix"
                } else {
                    "Allow Treeix under System Settings > Privacy & Security"
                };
                format!("macOS blocked access to {browser}. {hint}, then import again")
            } else {
                format!("Couldn't read {browser}'s cookies")
            }
        };
        if let Kind::Safari = source.kind {
            return safari_cookies(&std::fs::read(&source.cookies).map_err(io)?, now);
        }
        // The browser keeps its database locked while running, so read a copy, with the recent writes in its log
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        let dir =
            std::env::temp_dir().join(format!("treeix-cookies-{}-{nanos}", std::process::id()));
        let result = (|| {
            std::fs::create_dir_all(&dir).map_err(io)?;
            let copy = dir.join("cookies.sqlite");
            std::fs::copy(&source.cookies, &copy).map_err(io)?;
            let mut wal = source.cookies.clone().into_os_string();
            wal.push("-wal");
            let _ = std::fs::copy(wal, dir.join("cookies.sqlite-wal"));
            let unreadable = |_| format!("Couldn't read {browser}'s cookies");
            match source.kind {
                Kind::Firefox => Ok(firefox_rows(&copy)
                    .map_err(unreadable)?
                    .iter()
                    .map(|row| firefox_cookie(row, now))
                    .collect()),
                Kind::Chromium { keychain } => {
                    let key = keychain_password(keychain)
                        .map(|password| chromium_key(&password))
                        .ok_or_else(|| format!("Treeix couldn't read {browser}'s cookie key"))?;
                    let version = query(&copy, "SELECT value FROM meta WHERE key = 'version'")
                        .map_err(unreadable)?
                        .first()
                        .map_or(0, |row| meta_version(&row["value"]));
                    Ok(chromium_rows(&copy)
                        .map_err(unreadable)?
                        .into_iter()
                        .map(|(row, value, encrypted)| {
                            let value = if value.is_empty() {
                                decrypt_chromium_value(&encrypted, &key, version)?
                            } else {
                                value
                            };
                            chromium_cookie(&row, value, now)
                        })
                        .collect())
                }
                Kind::Safari => Ok(Vec::new()),
            }
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    /// Rows as JSON objects through the system's sqlite3
    fn query(db: &Path, sql: &str) -> Result<Vec<Value>, String> {
        let output = Command::new("/usr/bin/sqlite3")
            .arg("-json")
            .arg(db)
            .arg(sql)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        if output.stdout.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
    }

    fn text(row: &Value, name: &str) -> String {
        row[name].as_str().unwrap_or_default().to_string()
    }

    fn int(row: &Value, name: &str) -> i64 {
        row[name].as_i64().unwrap_or_default()
    }

    fn firefox_rows(db: &Path) -> Result<Vec<FirefoxRow>, String> {
        // Container tabs keep their own cookies under the same names; only the default ones are imported
        let sql = "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies WHERE originAttributes = ''";
        Ok(query(db, sql)?
            .iter()
            .map(|row| FirefoxRow {
                host: text(row, "host"),
                name: text(row, "name"),
                value: text(row, "value"),
                path: text(row, "path"),
                expiry: int(row, "expiry"),
                is_secure: int(row, "isSecure") == 1,
                is_http_only: int(row, "isHttpOnly") == 1,
                same_site: int(row, "sameSite"),
            })
            .collect())
    }

    /// Rows with their plain value and encrypted bytes
    fn chromium_rows(db: &Path) -> Result<Vec<(ChromiumRow, String, Vec<u8>)>, String> {
        let sql = "SELECT host_key, name, value, hex(encrypted_value) AS encrypted, path, expires_utc, is_secure, is_httponly, samesite, has_expires FROM cookies";
        Ok(query(db, sql)?
            .iter()
            .map(|row| {
                let hex = text(row, "encrypted");
                let encrypted = (0..hex.len() / 2)
                    .filter_map(|at| u8::from_str_radix(hex.get(at * 2..at * 2 + 2)?, 16).ok())
                    .collect();
                let parsed = ChromiumRow {
                    host_key: text(row, "host_key"),
                    name: text(row, "name"),
                    path: text(row, "path"),
                    expires_utc: int(row, "expires_utc"),
                    is_secure: int(row, "is_secure") == 1,
                    is_httponly: int(row, "is_httponly") == 1,
                    samesite: int(row, "samesite"),
                    has_expires: int(row, "has_expires") == 1,
                };
                (parsed, text(row, "value"), encrypted)
            })
            .collect())
    }

    /// macOS asks the user once whether Treeix may read this item; the password stays in the importer
    fn keychain_password(service: &str) -> Option<String> {
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-w", "-s", service])
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    #[link(name = "System", kind = "dylib")]
    unsafe extern "C" {
        fn CCKeyDerivationPBKDF(
            algorithm: u32,
            password: *const u8,
            password_len: usize,
            salt: *const u8,
            salt_len: usize,
            prf: u32,
            rounds: u32,
            derived_key: *mut u8,
            derived_key_len: usize,
        ) -> i32;
        fn CCCrypt(
            op: u32,
            alg: u32,
            options: u32,
            key: *const c_void,
            key_length: usize,
            iv: *const c_void,
            data_in: *const c_void,
            data_in_length: usize,
            data_out: *mut c_void,
            data_out_available: usize,
            data_out_moved: *mut usize,
        ) -> i32;
    }

    const IV: [u8; 16] = [b' '; 16];

    /// macOS Chromium: PBKDF2-SHA1 over the Keychain password, salt "saltysalt", 1003 rounds, 16 bytes
    pub(super) fn chromium_key(password: &str) -> [u8; 16] {
        let mut key = [0u8; 16];
        let salt = b"saltysalt";
        // SAFETY: every pointer comes with its buffer's length
        unsafe {
            CCKeyDerivationPBKDF(
                2,
                password.as_ptr(),
                password.len(),
                salt.as_ptr(),
                salt.len(),
                1,
                1003,
                key.as_mut_ptr(),
                key.len(),
            );
        }
        key
    }

    /// AES-128-CBC with PKCS7 padding; `encrypt` is for tests
    pub(super) fn aes(encrypt: bool, key: &[u8; 16], data: &[u8]) -> Option<Vec<u8>> {
        let mut out = vec![0u8; data.len() + 16];
        let mut moved = 0usize;
        // SAFETY: every pointer comes with its buffer's length; CCCrypt writes at most `out.len()` bytes
        let status = unsafe {
            CCCrypt(
                u32::from(!encrypt),
                0,
                1,
                key.as_ptr().cast(),
                key.len(),
                IV.as_ptr().cast(),
                data.as_ptr().cast(),
                data.len(),
                out.as_mut_ptr().cast(),
                out.len(),
                &mut moved,
            )
        };
        (status == 0).then(|| {
            out.truncate(moved);
            out
        })
    }

    pub(super) fn decrypt_chromium_value(
        encrypted: &[u8],
        key: &[u8; 16],
        version: i64,
    ) -> Option<String> {
        let body = encrypted
            .strip_prefix(b"v10")
            .or_else(|| encrypted.strip_prefix(b"v11"))?;
        let plain = aes(false, key, body)?;
        let plain = if version >= HOST_HASH_VERSION {
            plain.get(32..)?
        } else {
            &plain[..]
        };
        String::from_utf8(plain.to_vec()).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn imported(domain: &str, secure: bool, same_site: Option<SameSite>, expires: i64) -> Imported {
        Imported {
            domain: domain.into(),
            name: "sid".into(),
            value: "v".into(),
            path: "/".into(),
            secure,
            http_only: true,
            same_site,
            expires,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn decrypt_chromium_value_reads_v10_values_stripping_the_host_hash_on_newer_databases() {
        use mac::{aes, chromium_key, decrypt_chromium_value};
        let key = chromium_key("test-password");
        let encrypt =
            |plain: &[u8]| [b"v10".as_slice(), &aes(true, &key, plain).expect("encrypt")].concat();
        assert_eq!(
            decrypt_chromium_value(&encrypt(b"abc123"), &key, 23).as_deref(),
            Some("abc123")
        );
        let hashed = [[7u8; 32].as_slice(), b"abc123"].concat();
        assert_eq!(
            decrypt_chromium_value(&encrypt(&hashed), &key, 24).as_deref(),
            Some("abc123")
        );
        assert_eq!(decrypt_chromium_value(&[], &key, 24), None);
        assert_eq!(decrypt_chromium_value(b"v20xxxx", &key, 24), None);
        // Known PBKDF2-SHA1 output, so the key matches Chromium's
        assert_eq!(
            key,
            [
                0xc0, 0xff, 0xe4, 0xc2, 0x5f, 0x07, 0xf6, 0x2b, 0xfc, 0x6a, 0xb0, 0x11, 0xd9, 0xef,
                0xa5, 0x4e
            ]
        );
    }

    #[test]
    fn chromium_cookie_maps_rows_keeps_session_cookies_for_a_month_and_skips_expired_ones() {
        let row = ChromiumRow {
            host_key: ".example.com".into(),
            name: "sid".into(),
            path: "/".into(),
            expires_utc: (NOW + 3600 + WINDOWS_EPOCH_OFFSET) * 1_000_000,
            is_secure: true,
            is_httponly: true,
            samesite: 1,
            has_expires: true,
        };
        assert_eq!(
            chromium_cookie(&row, "v".into(), NOW),
            Some(imported(
                ".example.com",
                true,
                Some(SameSite::Lax),
                NOW + 3600
            ))
        );
        let host = ChromiumRow {
            host_key: "app.example.com".into(),
            is_secure: false,
            samesite: -1,
            ..row.clone()
        };
        assert_eq!(
            chromium_cookie(&host, "v".into(), NOW),
            Some(imported("app.example.com", false, None, NOW + 3600))
        );
        let session = ChromiumRow {
            has_expires: false,
            expires_utc: 0,
            ..row.clone()
        };
        assert_eq!(
            chromium_cookie(&session, "v".into(), NOW).map(|c| c.expires),
            Some(NOW + SESSION_COOKIE_SECONDS)
        );
        let expired = ChromiumRow {
            expires_utc: (NOW - 1 + WINDOWS_EPOCH_OFFSET) * 1_000_000,
            ..row
        };
        assert_eq!(chromium_cookie(&expired, "v".into(), NOW), None);
    }

    #[test]
    fn meta_version_reads_text_or_integers() {
        assert_eq!(meta_version(&"24".into()), 24);
        assert_eq!(meta_version(&24.into()), 24);
        assert_eq!(meta_version(&"abc".into()), 0);
        assert_eq!(meta_version(&serde_json::Value::Null), 0);
    }

    #[test]
    fn firefox_cookie_maps_rows_with_expiry_in_seconds_or_milliseconds() {
        let row = FirefoxRow {
            host: ".example.com".into(),
            name: "a".into(),
            value: "b".into(),
            path: "/".into(),
            expiry: NOW + 60,
            is_secure: true,
            is_http_only: false,
            same_site: 2,
        };
        let expected = Imported {
            domain: ".example.com".into(),
            name: "a".into(),
            value: "b".into(),
            path: "/".into(),
            secure: true,
            http_only: false,
            same_site: Some(SameSite::Strict),
            expires: NOW + 60,
        };
        assert_eq!(firefox_cookie(&row, NOW), Some(expected));
        let millis = FirefoxRow {
            expiry: (NOW + 60) * 1000,
            ..row.clone()
        };
        assert_eq!(
            firefox_cookie(&millis, NOW).map(|c| c.expires),
            Some(NOW + 60)
        );
        assert_eq!(
            firefox_cookie(
                &FirefoxRow {
                    expiry: NOW - 1,
                    ..row.clone()
                },
                NOW
            ),
            None
        );
        let unset = FirefoxRow {
            same_site: 0,
            is_secure: false,
            ..row.clone()
        };
        assert_eq!(firefox_cookie(&unset, NOW).and_then(|c| c.same_site), None);
        let none = FirefoxRow {
            same_site: 0,
            ..row
        };
        assert_eq!(
            firefox_cookie(&none, NOW).and_then(|c| c.same_site),
            Some(SameSite::None)
        );
    }

    /// One cookie record: 56-byte header, then host, name, path and value strings
    fn record(
        flags: u32,
        host: &str,
        name: &str,
        path: &str,
        value: &str,
        expires: i64,
    ) -> Vec<u8> {
        let strings: Vec<Vec<u8>> = [host, name, path, value]
            .iter()
            .map(|s| [s.as_bytes(), &[0]].concat())
            .collect();
        let mut header = vec![0u8; 56];
        let total = 56 + strings.iter().map(Vec::len).sum::<usize>();
        header[0..4].copy_from_slice(&(total as u32).to_le_bytes());
        header[8..12].copy_from_slice(&flags.to_le_bytes());
        let mut offset = 56u32;
        for (index, part) in strings.iter().enumerate() {
            header[16 + index * 4..20 + index * 4].copy_from_slice(&offset.to_le_bytes());
            offset += part.len() as u32;
        }
        header[40..48].copy_from_slice(&(expires as f64 - MAC_EPOCH_OFFSET).to_le_bytes());
        [header, strings.concat()].concat()
    }

    fn file(records: &[Vec<u8>]) -> Vec<u8> {
        let mut head = vec![0u8; 8 + records.len() * 4 + 4];
        head[0..4].copy_from_slice(&0x100u32.to_be_bytes());
        head[4..8].copy_from_slice(&(records.len() as u32).to_le_bytes());
        let mut at = head.len() as u32;
        for (index, cookie) in records.iter().enumerate() {
            head[8 + index * 4..12 + index * 4].copy_from_slice(&at.to_le_bytes());
            at += cookie.len() as u32;
        }
        let page = [head, records.concat()].concat();
        [
            b"cook".as_slice(),
            &1u32.to_be_bytes(),
            &(page.len() as u32).to_be_bytes(),
            &page,
        ]
        .concat()
    }

    #[test]
    fn safari_cookies_reads_records_flags_and_domains_skipping_expired_ones() {
        let cookies = safari_cookies(
            &file(&[
                record(5, ".example.com", "a", "/", "b", NOW + 60),
                record(0, "host.test", "c", "/x", "d", NOW + 60),
                record(0, "old.test", "e", "/", "f", NOW - 1),
            ]),
            NOW,
        )
        .expect("cookies");
        let cookie = |domain: &str, name: &str, path: &str, value: &str, secure| Imported {
            domain: domain.into(),
            name: name.into(),
            value: value.into(),
            path: path.into(),
            secure,
            http_only: secure,
            same_site: None,
            expires: NOW + 60,
        };
        assert_eq!(
            cookies,
            vec![
                Some(cookie(".example.com", "a", "/", "b", true)),
                Some(cookie("host.test", "c", "/x", "d", false)),
                None
            ]
        );
        assert!(safari_cookies(b"nope", NOW).is_err());
        assert!(safari_cookies(b"cook\0\0\0\x09", NOW).is_err());
    }

    #[test]
    fn imported_cookies_become_webview_cookies() {
        let cookie = imported(".example.com", true, Some(SameSite::Lax), NOW)
            .cookie()
            .expect("cookie");
        assert_eq!(cookie.domain(), Some("example.com"));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert_eq!(cookie.secure(), Some(true));
        assert!(imported("x", false, None, i64::MAX).cookie().is_none());
    }
}
