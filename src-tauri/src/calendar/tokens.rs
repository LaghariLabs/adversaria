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
    crate::secrets::set(SERVICE, &account, &json)
}

/// Read the user's OAuth client credentials from the OS keychain.
/// Returns `Ok(None)` if no credentials exist yet.
pub fn get_client(provider: &str) -> Result<Option<ClientCreds>, String> {
    let account = format!("{provider}:client");
    match crate::secrets::get(SERVICE, &account)? {
        Some(json) => {
            let creds: ClientCreds =
                serde_json::from_str(&json).map_err(|e| format!("deserialize: {e}"))?;
            Ok(Some(creds))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Phase 1 stubs
// ---------------------------------------------------------------------------

/// Store OAuth tokens for a provider.
pub fn set_tokens(provider: &str, tokens: &TokenSet) -> Result<(), String> {
    let account = format!("{provider}:tokens");
    let json = serde_json::to_string(tokens).map_err(|e| format!("serialize tokens: {e}"))?;
    crate::secrets::set(SERVICE, &account, &json)
        .map_err(|e| e.replacen("keyring write: ", "keyring write tokens: ", 1))
}

/// Read OAuth tokens for a provider. Returns `Ok(None)` if no tokens exist yet.
pub fn get_tokens(provider: &str) -> Result<Option<TokenSet>, String> {
    let account = format!("{provider}:tokens");
    match crate::secrets::get(SERVICE, &account)
        .map_err(|e| e.replacen("keyring read: ", "keyring read tokens: ", 1))?
    {
        Some(json) => {
            let tokens: TokenSet =
                serde_json::from_str(&json).map_err(|e| format!("deserialize tokens: {e}"))?;
            Ok(Some(tokens))
        }
        None => Ok(None),
    }
}

/// Delete the keychain entry for a given account key.
#[allow(dead_code)]
pub fn delete_entry(account_key: &str) -> Result<(), String> {
    crate::secrets::delete(SERVICE, account_key)
}
