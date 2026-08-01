//! Versioned, offline-tolerant beta registration and onboarding state.

use crate::types::{OnboardingState, RegistrationState};

const CONSENT_VERSION: &str = "beta-registration-v1";
// "registration" / "permissions" / "ready" are the 3-screen wizard
// (SETUP_REDESIGN_SPEC §B); "sample" is recorded post-wizard by the
// in-app status strip. The remaining names are legacy 7-step rows that
// persisted onboarding states still contain — they stay accepted so a
// half-finished old wizard resumes instead of erroring.
const ALLOWED_STEPS: &[&str] = &[
    "registration",
    "disclosure",
    "hardware",
    "model",
    "permissions",
    "sample",
    "capture",
    "ready",
];

// The main webview can issue commands while the Tauri setup callback is still
// finishing. Serialize the idempotent legacy migration so an early onboarding
// read never observes the pre-migration rows and strands an existing user in
// the first-run flow for the rest of that frontend session.
static LEGACY_MIGRATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(serde::Serialize)]
struct RegistrationPayload<'a> {
    name: &'a str,
    email: &'a str,
    source: &'a str,
    app_version: &'a str,
    platform: &'a str,
    consent_timestamp: &'a str,
    consent_version: &'a str,
}

fn formspree_endpoint() -> Option<&'static str> {
    option_env!("ADVERSARIA_FORMSPREE_ENDPOINT")
        .map(str::trim)
        .filter(|value| value.starts_with("https://formspree.io/f/") && value.len() > 24)
}

fn validate_identity(name: &str, email: &str, consent: bool) -> Result<(), String> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("Enter your name (100 characters or fewer).".to_string());
    }
    if email.len() > 254
        || email.contains(char::is_whitespace)
        || email.matches('@').count() != 1
        || !email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
    {
        return Err("Enter a valid email address.".to_string());
    }
    if !consent {
        return Err("Registration consent is required to continue.".to_string());
    }
    Ok(())
}

fn retry_delay_seconds(attempt_count: u32) -> i64 {
    let exponent = attempt_count.saturating_sub(1).min(10);
    (60_i64.saturating_mul(1_i64 << exponent)).min(24 * 60 * 60)
}

fn persist_failure(
    mut state: RegistrationState,
    message: &str,
) -> Result<RegistrationState, String> {
    crate::diagnostics::record("registration.retry_queued", message);
    state.status = "pending".to_string();
    state.attempt_count = state.attempt_count.saturating_add(1);
    state.last_error = Some(message.to_string());
    state.next_retry_at = Some(
        (chrono::Utc::now() + chrono::Duration::seconds(retry_delay_seconds(state.attempt_count)))
            .to_rfc3339(),
    );
    crate::storage::save_registration_state(&state)
        .map_err(|e| format!("Could not save registration retry state: {e}"))?;
    Ok(state)
}

async fn attempt_pending(
    mut state: RegistrationState,
    force: bool,
) -> Result<RegistrationState, String> {
    if state.status != "pending" {
        return Ok(state);
    }
    if !force
        && state
            .next_retry_at
            .as_deref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .is_some_and(|next| next.with_timezone(&chrono::Utc) > chrono::Utc::now())
    {
        return Ok(state);
    }
    let Some(endpoint) = formspree_endpoint() else {
        // No endpoint compiled into this build (every dev build, and 0.3.66):
        // retrying can never succeed, so schedule NOTHING. The wizard shows
        // its "Registration queued … Retry now" banner only when a retry is
        // actually pending — this state queues silently and delivers on the
        // first endpoint-carrying build, which the user can't influence.
        crate::diagnostics::record(
            "registration.retry_queued",
            "Registration is queued; this build has no Formspree endpoint configured.",
        );
        state.next_retry_at = None;
        state.last_error =
            Some("This build has no registration endpoint; details stay on-device.".to_string());
        crate::storage::save_registration_state(&state)
            .map_err(|e| format!("Could not save registration state: {e}"))?;
        return Ok(state);
    };
    let Some(consent_timestamp) = state.consent_timestamp.as_deref() else {
        return persist_failure(state, "Registration consent metadata is missing.");
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Could not create registration client: {e}"))?;
    let payload = RegistrationPayload {
        name: &state.name,
        email: &state.email,
        source: &state.source,
        app_version: &state.app_version,
        platform: &state.platform,
        consent_timestamp,
        consent_version: &state.consent_version,
    };
    let response = client
        .post(endpoint)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&payload)
        .send()
        .await;
    match response {
        Ok(response) if response.status().is_success() => {
            crate::diagnostics::record(
                "registration.submitted",
                "Formspree accepted the registration payload.",
            );
            state.status = "submitted".to_string();
            state.next_retry_at = None;
            state.last_error = None;
            crate::storage::save_registration_state(&state)
                .map_err(|e| format!("Could not save submitted registration: {e}"))?;
            let _ = crate::config::update_config_with(|config| {
                config.signup_synced = true;
            });
            Ok(state)
        }
        Ok(response) => persist_failure(
            state,
            &format!(
                "Registration service returned HTTP {}; retry is queued.",
                response.status().as_u16()
            ),
        ),
        Err(_) => persist_failure(
            state,
            "Registration service is unreachable; retry is queued.",
        ),
    }
}

pub async fn submit(
    name: String,
    email: String,
    consent: bool,
) -> Result<RegistrationState, String> {
    validate_identity(&name, &email, consent)?;
    let state = RegistrationState {
        schema_version: 1,
        status: "pending".to_string(),
        name: name.trim().to_string(),
        email: email.trim().to_lowercase(),
        consent_version: CONSENT_VERSION.to_string(),
        consent_timestamp: Some(chrono::Utc::now().to_rfc3339()),
        source: "desktop-beta".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        attempt_count: 0,
        next_retry_at: None,
        last_error: None,
    };
    crate::storage::save_registration_state(&state)
        .map_err(|e| format!("Could not queue registration locally: {e}"))?;
    crate::config::update_config_with(|config| {
        config.user_name = state.name.clone();
        config.user_email = state.email.clone();
        config.signup_synced = false;
    })
    .map_err(|e| format!("Could not preserve registration locally: {e}"))?;
    complete_step("registration", None, false)?;
    attempt_pending(state, true).await
}

pub async fn retry(force: bool) -> Result<RegistrationState, String> {
    let state = crate::storage::get_registration_state()
        .map_err(|e| format!("Could not load registration state: {e}"))?;
    attempt_pending(state, force).await
}

pub fn complete_step(
    step: &str,
    selected_model_profile: Option<String>,
    setup_complete: bool,
) -> Result<OnboardingState, String> {
    if !ALLOWED_STEPS.contains(&step) {
        return Err(format!("Unknown onboarding step: {step}"));
    }
    let mut state = crate::storage::get_onboarding_state()
        .map_err(|e| format!("Could not load onboarding state: {e}"))?;
    if !state.completed_steps.iter().any(|value| value == step) {
        state.completed_steps.push(step.to_string());
    }
    if let Some(profile) = selected_model_profile {
        let alias = crate::setup::profile_alias(&profile)
            .ok_or_else(|| format!("Unknown model profile: {profile}"))?;
        state.selected_model_profile = profile;
        crate::config::update_config_with(|config| {
            config.ollama_model = alias.to_string();
            config.llm_provider = "local".to_string();
        })
        .map_err(|e| format!("Could not save the selected model profile: {e}"))?;
    }
    state.setup_complete = setup_complete;
    state.updated_at = chrono::Utc::now().to_rfc3339();
    crate::storage::save_onboarding_state(&state)
        .map_err(|e| format!("Could not save onboarding state: {e}"))?;
    if setup_complete {
        crate::config::update_config_with(|config| {
            config.beta_onboarded = true;
        })
        .map_err(|e| format!("Could not finalize onboarding: {e}"))?;
    }
    Ok(state)
}

/// Re-point the local meeting model AFTER first-run setup (the Settings model
/// picker). Persists the newly selected profile and updates the LLM config to
/// the pinned alias — but, unlike [`complete_step`], never touches
/// `completed_steps` or `setup_complete`, so switching models in Settings can
/// never bounce an onboarded user back into the wizard.
pub fn set_selected_model_profile(profile_id: &str) -> Result<OnboardingState, String> {
    let alias = crate::setup::profile_alias(profile_id)
        .ok_or_else(|| format!("Unknown model profile: {profile_id}"))?;
    let mut state = crate::storage::get_onboarding_state()
        .map_err(|e| format!("Could not load onboarding state: {e}"))?;
    state.selected_model_profile = profile_id.to_string();
    state.updated_at = chrono::Utc::now().to_rfc3339();
    crate::storage::save_onboarding_state(&state)
        .map_err(|e| format!("Could not save onboarding state: {e}"))?;
    crate::config::update_config_with(|config| {
        config.ollama_model = alias.to_string();
        config.llm_provider = "local".to_string();
    })
    .map_err(|e| format!("Could not save the selected model profile: {e}"))?;
    Ok(state)
}

/// Preserve existing users without forcing them through a new gate. New users
/// use the v1 state machine; legacy flags are copied once into versioned rows.
pub fn migrate_legacy_config() -> Result<(), String> {
    let _guard = LEGACY_MIGRATION
        .lock()
        .map_err(|_| "Legacy onboarding migration lock is unavailable.".to_string())?;
    let config = crate::config::load_config();
    let registration = crate::storage::get_registration_state()
        .map_err(|e| format!("Could not inspect registration migration: {e}"))?;
    if registration.status == "unregistered"
        && config.beta_onboarded
        && !config.user_email.is_empty()
    {
        let migrated = RegistrationState {
            status: if config.signup_synced {
                "submitted".to_string()
            } else {
                "pending".to_string()
            },
            name: config.user_name.clone(),
            email: config.user_email.clone(),
            consent_version: "legacy-beta-v0".to_string(),
            last_error: (!config.signup_synced)
                .then(|| "Legacy registration is queued for retry.".to_string()),
            ..RegistrationState::default()
        };
        crate::storage::save_registration_state(&migrated)
            .map_err(|e| format!("Could not migrate registration state: {e}"))?;
    }
    let onboarding = crate::storage::get_onboarding_state()
        .map_err(|e| format!("Could not inspect onboarding migration: {e}"))?;
    if !onboarding.setup_complete && config.beta_onboarded {
        let migrated = OnboardingState {
            completed_steps: ALLOWED_STEPS
                .iter()
                .map(|step| (*step).to_string())
                .collect(),
            selected_model_profile: "legacy-existing-setup".to_string(),
            setup_complete: true,
            ..OnboardingState::default()
        };
        crate::storage::save_onboarding_state(&migrated)
            .map_err(|e| format!("Could not migrate onboarding state: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_requires_name_email_and_consent() {
        assert!(validate_identity("", "a@example.com", true).is_err());
        assert!(validate_identity("A", "invalid", true).is_err());
        assert!(validate_identity("A", "a@example.com", false).is_err());
        assert!(validate_identity("A", "a@example.com", true).is_ok());
    }

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay_seconds(1), 60);
        assert_eq!(retry_delay_seconds(2), 120);
        assert_eq!(retry_delay_seconds(30), 61_440);
        assert!(retry_delay_seconds(30) <= 86_400);
    }
}
