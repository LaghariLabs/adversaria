//! Calendar integration — OAuth + PKCE + token storage + provider-specific
//! API reads.
//!
//! - `oauth` — PKCE helpers + OAuth flow (authorize URL, code exchange,
//!   token refresh, revoke).
//! - `tokens` — OS keychain round-trip via `keyring` (client creds + tokens).
//! - `google` — Google Calendar v3 reads (upcoming events, event-at-time).
//! - `eventkit` — macOS EventKit local calendar reads (no sign-in, no OAuth).

pub mod google;
pub mod oauth;
pub mod tokens;

#[cfg(target_os = "macos")]
pub mod eventkit;
