//! PKCE (Proof Key for Code Exchange) helpers — RFC 7636 §4.
//!
//! Phase 0: generates `code_verifier` + `code_challenge` (S256) and a
//! random `state` for CSRF protection. No network code yet.

use rand::Rng;
use sha2::{Digest, Sha256};

/// Unreserved characters per RFC 7636 §4.1.
const UNRESERVED: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/// Generate a cryptographically random PKCE `code_verifier` (43–128 chars)
/// from the unreserved character set.
pub fn code_verifier() -> String {
    let mut rng = rand::thread_rng();
    let len = rng.gen_range(43..=128);
    (0..len)
        .map(|_| {
            let idx = rng.gen_range(0..UNRESERVED.len());
            UNRESERVED[idx] as char
        })
        .collect()
}

/// Derive the S256 `code_challenge` from a `code_verifier`.
///
/// `BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))` per RFC 7636 §4.2.
/// base64url: standard base64 with `+` → `-`, `/` → `_`, no `=` padding.
pub fn code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    base64_url_encode(&hash)
}

/// Generate a random OAuth `state` parameter (CSRF protection).
pub fn state() -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    hex::encode(&bytes)
}

// ---------------------------------------------------------------------------
// base64url (no padding) — kept inline to avoid pulling in another crate
// just for the URL-safe alphabet switch.
// ---------------------------------------------------------------------------

fn base64_url_encode(input: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input)
}

// ---------------------------------------------------------------------------
// OAuth flow helpers (Phase 1)
// ---------------------------------------------------------------------------

use std::sync::Mutex;

use crate::calendar::tokens::{self, TokenSet};

/// Google OAuth endpoints.
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

/// The single readonly scope needed for Phase 1.
pub const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";

/// Mutable slot so the loopback server handler can communicate the redirect URL
/// back to the OAuth flow.  The handler fires on a separate thread (spawned by
/// `tauri-plugin-oauth`), so we park the result here and poll it.
static REDIRECT_RESULT: Mutex<Option<Result<String, String>>> = Mutex::new(None);

/// Build the Google OAuth authorize URL (SPEC §3 step 4).
///
/// Includes `access_type=offline` + `prompt=consent` to guarantee a refresh
/// token on every authorization.
pub fn google_auth_url(
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
) -> String {
    format!(
        "{auth}?client_id={cid}&redirect_uri={ru}&response_type=code&\
         scope={scope}&code_challenge={cc}&code_challenge_method=S256&\
         state={st}&access_type=offline&prompt=consent",
        auth = GOOGLE_AUTH_URL,
        cid = url_encode(client_id),
        ru = url_encode(redirect_uri),
        scope = url_encode(GOOGLE_SCOPE),
        cc = url_encode(code_challenge),
        st = url_encode(state),
    )
}

/// Start the loopback server on `port`, open the browser, capture the redirect,
/// validate `state`, and return the authorization `code`.  This is the core of
/// SPEC §3 steps 3–5.
///
/// The caller must first bind and release `port` to reserve it (avoiding a race
/// with another process).  `build_auth_url` receives the `redirect_uri` (which
/// embeds `port`) and must return the full authorize URL.  `open_url` receives
/// the authorize URL and should open it in the system browser.
pub fn capture_code_via_loopback(
    port: u16,
    expected_state: &str,
    build_auth_url: impl FnOnce(&str) -> String,
    open_url: impl FnOnce(&str),
) -> Result<String, String> {
    // Reset the shared slot.
    *REDIRECT_RESULT.lock().unwrap() = None;

    let expected_state = expected_state.to_string();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    // Start the server on the reserved port.
    tauri_plugin_oauth::start_with_config(
        tauri_plugin_oauth::OauthConfig {
            ports: Some(vec![port]),
            ..Default::default()
        },
        move |full_url| {
            let result = parse_redirect(&full_url, &expected_state);
            *REDIRECT_RESULT.lock().unwrap() = Some(result);
        },
    )
    .map_err(|e| format!("Failed to start loopback server: {e}"))?;

    // Build the auth URL and open the browser.
    let auth_url = build_auth_url(&redirect_uri);
    open_url(&auth_url);

    // Poll until the handler fires or we give up (2 minute timeout — OAuth
    // codes typically expire in ~10 minutes).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let result = REDIRECT_RESULT.lock().unwrap().take();
        if let Some(r) = result {
            // Best-effort shut down the server so it doesn't linger.
            let _ = tauri_plugin_oauth::cancel(port);
            return r;
        }
        if std::time::Instant::now() > deadline {
            let _ = tauri_plugin_oauth::cancel(port);
            return Err("OAuth sign-in timed out (2 minutes).".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// Parse the OAuth redirect URL, validate `state`, and extract the `code`.
fn parse_redirect(full_url: &str, expected_state: &str) -> Result<String, String> {
    // The plugin hands us the full URL as a string; parse it.
    let parsed = url::Url::parse(full_url).map_err(|e| format!("Bad redirect URL: {e}"))?;

    // Check for an error response from the provider.
    if let Some(err) = parsed
        .query_pairs()
        .find(|(k, _)| k == "error")
        .map(|(_, v)| v.to_string())
    {
        let desc = parsed
            .query_pairs()
            .find(|(k, _)| k == "error_description")
            .map(|(_, v)| v.to_string())
            .unwrap_or_default();
        return Err(format!("OAuth error: {err} — {desc}"));
    }

    // Validate state (CSRF protection — SPEC §3 requirement).
    let returned_state = parsed
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| "OAuth redirect missing state parameter.".to_string())?;

    if returned_state != *expected_state {
        return Err(format!(
            "OAuth state mismatch: expected {expected_state}, got {returned_state}"
        ));
    }

    // Extract the authorization code.
    parsed
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
        .ok_or_else(|| "OAuth redirect missing code parameter.".to_string())
}

/// Exchange an authorization code for tokens (SPEC §3 step 6).
///
/// POSTs to Google's token endpoint, form-encoded, with PKCE `code_verifier`.
/// Includes `client_secret` only when present (some Google Desktop client types
/// have one, some don't).
pub async fn exchange_code(
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenSet, String> {
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", code_verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(secret) = client_secret {
        params.push(("client_secret", secret));
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed: {body}"));
    }

    let data: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(data.expires_in);
    Ok(TokenSet {
        access_token: data.access_token,
        refresh_token: data
            .refresh_token
            .ok_or_else(|| "No refresh token returned — ensure the client is configured for offline access and prompt=consent was sent.".to_string())?,
        expires_at: expires_at.to_rfc3339(),
    })
}

/// Deserialised Google token endpoint response.
#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: i64,
}

/// Returns a valid access token for `provider`, refreshing first if the stored
/// token is expired (with a 60-second skew, per SPEC).  Reads fresh from the
/// keychain so a concurrent refresh from another calendar read is picked up.
pub async fn refresh_if_needed(provider: &str) -> Result<String, String> {
    let stored = tokens::get_tokens(provider)?
        .ok_or_else(|| format!("{provider}: not connected (no tokens in keychain)."))?;

    // Parse expiry; if it's more than 60 s in the future, the token is fine.
    if let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(&stored.expires_at) {
        if chrono::Utc::now() < expiry - chrono::Duration::seconds(60) {
            return Ok(stored.access_token);
        }
    }

    // Token is expired or close enough — refresh.
    let creds = tokens::get_client(provider)?
        .ok_or_else(|| format!("{provider}: no client credentials in keychain."))?;

    let client = reqwest::Client::new();
    let mut params: Vec<(&str, &str)> = vec![
        ("client_id", &creds.client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", &stored.refresh_token),
    ];
    if let Some(secret) = creds.client_secret.as_deref() {
        params.push(("client_secret", secret));
    }

    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token refresh request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token refresh failed — reconnect required: {body}"));
    }

    let data: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse refresh response: {e}"))?;

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(data.expires_in);
    let new_tokens = TokenSet {
        access_token: data.access_token.clone(),
        // Google may rotate the refresh token; keep the new one if sent,
        // otherwise retain the existing one.
        refresh_token: data.refresh_token.unwrap_or(stored.refresh_token),
        expires_at: expires_at.to_rfc3339(),
    };
    tokens::set_tokens(provider, &new_tokens)?;

    Ok(data.access_token)
}

/// Fetch the user's email via Google's userinfo endpoint.  Returns the email
/// (and display name) for populating the `CalendarAccount` metadata.
pub async fn fetch_userinfo(access_token: &str) -> Result<(String, String), String> {
    #[derive(serde::Deserialize)]
    struct UserInfo {
        email: String,
        #[serde(default)]
        name: String,
    }

    let client = reqwest::Client::new();
    let resp = client
        .get(GOOGLE_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Userinfo request failed: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Userinfo failed: {body}"));
    }

    let info: UserInfo = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse userinfo: {e}"))?;

    Ok((info.email, info.name))
}

/// Best-effort revoke an access token at Google (SPEC §6 disconnect).
/// Always returns `Ok(())` — the local disconnect must succeed regardless.
pub async fn revoke_token(access_token: &str) {
    let client = reqwest::Client::new();
    let _ = client
        .post(GOOGLE_REVOKE_URL)
        .form(&[("token", access_token)])
        .send()
        .await;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Percent-encode a string for use in a URL query parameter value.
fn url_encode(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes()).collect()
}

/// Hex encoding module (tiny, no deps needed beyond std).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_length() {
        for _ in 0..100 {
            let v = code_verifier();
            assert!(v.len() >= 43, "verifier too short: {}", v.len());
            assert!(v.len() <= 128, "verifier too long: {}", v.len());
            assert!(v.chars().all(|c| UNRESERVED.contains(&(c as u8))));
        }
    }

    #[test]
    fn challenge_is_url_safe_no_pad() {
        let v = code_verifier();
        let c = code_challenge(&v);
        assert!(!c.ends_with('='), "challenge must not have padding");
        assert!(
            !c.contains('+') && !c.contains('/'),
            "challenge must be URL-safe base64"
        );
    }

    #[test]
    fn pkce_s256_known_vector() {
        // Test vector from RFC 7636 Appendix B.
        // verifier (128 chars of "AAAA…"):
        // dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        let challenge = code_challenge(verifier);
        assert_eq!(challenge, expected_challenge);
    }

    #[test]
    fn state_is_64_hex_chars() {
        let s = state();
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn unique_verifiers_and_states() {
        let v1 = code_verifier();
        let v2 = code_verifier();
        assert_ne!(v1, v2);

        let s1 = state();
        let s2 = state();
        assert_ne!(s1, s2);
    }
}
