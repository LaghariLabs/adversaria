//! Cloud-provider API key storage via OS keychain (`keyring` crate) for Live Copilot.
//!
//! Service name: `"adversaria-copilot"`.
//! Accounts: `"anthropic-api-key"` and `"deepseek-api-key"`.
//!
//! Never log or leak the key.

use std::sync::Mutex;

const SERVICE: &str = "adversaria-copilot";
const ANTHROPIC_ACCOUNT: &str = "anthropic-api-key";
const DEEPSEEK_ACCOUNT: &str = "deepseek-api-key";

/// Process-wide cache: outer None = not yet loaded from keychain/disk,
/// Some(None) = checked and no key found, Some(Some(k)) = cached key.
static KEY_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);
static DEEPSEEK_KEY_CACHE: Mutex<Option<Option<String>>> = Mutex::new(None);

/// Set the Anthropic API key in the OS keychain.
/// Rejects empty/blank keys with "API key is empty.".
pub fn set_api_key(key: &str) -> Result<(), String> {
    set_provider_api_key(key, ANTHROPIC_ACCOUNT, &KEY_CACHE)
}

/// Set the DeepSeek API key in the OS keychain.
pub fn set_deepseek_api_key(key: &str) -> Result<(), String> {
    set_provider_api_key(key, DEEPSEEK_ACCOUNT, &DEEPSEEK_KEY_CACHE)
}

fn set_provider_api_key(
    key: &str,
    account: &str,
    cache: &Mutex<Option<Option<String>>>,
) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty.".to_string());
    }

    crate::secrets::set(SERVICE, account, trimmed)?;

    *cache.lock().unwrap() = Some(Some(trimmed.to_string()));
    Ok(())
}

/// Read the Anthropic API key from cache, OS keychain, or debug dev-file.
/// Returns `Ok(None)` if no key is stored.
pub fn get_api_key() -> Result<Option<String>, String> {
    get_provider_api_key(ANTHROPIC_ACCOUNT, &KEY_CACHE)
}

/// Read the DeepSeek API key from cache, OS keychain, or debug dev-file.
pub fn get_deepseek_api_key() -> Result<Option<String>, String> {
    get_provider_api_key(DEEPSEEK_ACCOUNT, &DEEPSEEK_KEY_CACHE)
}

fn get_provider_api_key(
    account: &str,
    cache: &Mutex<Option<Option<String>>>,
) -> Result<Option<String>, String> {
    if let Some(cached) = cache.lock().unwrap().as_ref() {
        return Ok(cached.clone());
    }

    let loaded = crate::secrets::get(SERVICE, account)?;

    *cache.lock().unwrap() = Some(loaded.clone());
    Ok(loaded)
}

/// Check if an Anthropic API key is saved.
pub fn has_api_key() -> Result<bool, String> {
    Ok(get_api_key()?.is_some())
}

/// Check if a DeepSeek API key is saved.
pub fn has_deepseek_api_key() -> Result<bool, String> {
    Ok(get_deepseek_api_key()?.is_some())
}

/// Delete the stored Anthropic API key.
/// Returns `Ok(())` if already gone (NoEntry).
pub fn clear_api_key() -> Result<(), String> {
    clear_provider_api_key(ANTHROPIC_ACCOUNT, &KEY_CACHE)
}

/// Delete the stored DeepSeek API key.
pub fn clear_deepseek_api_key() -> Result<(), String> {
    clear_provider_api_key(DEEPSEEK_ACCOUNT, &DEEPSEEK_KEY_CACHE)
}

fn clear_provider_api_key(
    account: &str,
    cache: &Mutex<Option<Option<String>>>,
) -> Result<(), String> {
    let res = crate::secrets::delete(SERVICE, account);

    *cache.lock().unwrap() = Some(None);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_api_key_rejects_empty_or_whitespace() {
        assert_eq!(set_api_key("").unwrap_err(), "API key is empty.");
        assert_eq!(set_api_key("   \n\t  ").unwrap_err(), "API key is empty.");
    }

    #[test]
    fn cache_round_trip() {
        *KEY_CACHE.lock().unwrap() = Some(Some("sk-ant-test-123".to_string()));
        assert_eq!(get_api_key().unwrap(), Some("sk-ant-test-123".to_string()));
        assert!(has_api_key().unwrap());

        *KEY_CACHE.lock().unwrap() = Some(None);
        assert_eq!(get_api_key().unwrap(), None);
        assert!(!has_api_key().unwrap());
    }

    #[test]
    fn deepseek_cache_is_independent() {
        *KEY_CACHE.lock().unwrap() = Some(Some("sk-ant-test-123".to_string()));
        *DEEPSEEK_KEY_CACHE.lock().unwrap() = Some(Some("sk-deepseek-test".to_string()));
        assert_eq!(get_api_key().unwrap().as_deref(), Some("sk-ant-test-123"));
        assert_eq!(
            get_deepseek_api_key().unwrap().as_deref(),
            Some("sk-deepseek-test")
        );
        assert!(has_deepseek_api_key().unwrap());
    }
}
