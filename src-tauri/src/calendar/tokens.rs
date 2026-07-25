//! OS keychain token storage via the `keyring` crate.
//!
//! Service name: `"adversaria-calendar"`. Account keys per SPEC §5.2:
//! - `{provider}:client`  → JSON `{ "client_id", "client_secret?" }`
//! - `{provider}:tokens`  → JSON `{ "access_token", "refresh_token", "expires_at" }`
//!
//! Phase 0: client credential get/set. Token get/set are stubs for Phase 1.

use serde::{Deserialize, Serialize};

const SERVICE: &str = "adversaria-calendar";

/// Stored client credentials for a provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCreds {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

/// Stored OAuth tokens (Phase 1 stub — not yet used).
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// RFC3339 expiry.
    pub expires_at: String,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Store the user's OAuth client credentials for a provider in the OS keychain.
pub fn set_client(
    provider: &str,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<(), String> {
    let account = format!("{provider}:client");
    let creds = ClientCreds {
        client_id: client_id.to_string(),
        client_secret: client_secret.map(|s| s.to_string()),
    };
    let json = serde_json::to_string(&creds).map_err(|e| format!("serialize: {e}"))?;
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("keyring open: {e}"))?;
    entry
        .set_password(&json)
        .map_err(|e| format!("keyring write: {e}"))
}

/// Read the user's OAuth client credentials from the OS keychain.
/// Returns `Ok(None)` if no credentials exist yet.
pub fn get_client(provider: &str) -> Result<Option<ClientCreds>, String> {
    let account = format!("{provider}:client");
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("keyring open: {e}"))?;
    match entry.get_password() {
        Ok(json) => {
            let creds: ClientCreds =
                serde_json::from_str(&json).map_err(|e| format!("deserialize: {e}"))?;
            Ok(Some(creds))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Phase 1 stubs
// ---------------------------------------------------------------------------

/// Store OAuth tokens for a provider.
pub fn set_tokens(provider: &str, tokens: &TokenSet) -> Result<(), String> {
    let account = format!("{provider}:tokens");
    let json = serde_json::to_string(tokens).map_err(|e| format!("serialize tokens: {e}"))?;
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("keyring open: {e}"))?;
    entry
        .set_password(&json)
        .map_err(|e| format!("keyring write tokens: {e}"))
}

/// Read OAuth tokens for a provider. Returns `Ok(None)` if no tokens exist yet.
pub fn get_tokens(provider: &str) -> Result<Option<TokenSet>, String> {
    let account = format!("{provider}:tokens");
    let entry = keyring::Entry::new(SERVICE, &account).map_err(|e| format!("keyring open: {e}"))?;
    match entry.get_password() {
        Ok(json) => {
            let tokens: TokenSet =
                serde_json::from_str(&json).map_err(|e| format!("deserialize tokens: {e}"))?;
            Ok(Some(tokens))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read tokens: {e}")),
    }
}

/// Delete the keychain entry for a given account key.
#[allow(dead_code)]
pub fn delete_entry(account_key: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(SERVICE, account_key).map_err(|e| format!("keyring open: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone
        Err(e) => Err(format!("keyring delete: {e}")),
    }
}
