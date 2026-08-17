//! Meeting Note Taker — Tauri backend library.
//!
//! Module map:
//! - `types`        — shared structs matching the API + DB contracts
//! - `config`       — user settings (Task 6)
//! - `storage`      — SQLite meeting store (Task 6)
//! - `http_client`  — typed client for the Python ML service (Task 7)
//! - `audio`        — WASAPI loopback capture (Task 8)
//! - `tray`         — system tray + global hotkeys (Task 9)
//! - `commands`     — Tauri IPC command handlers (Task 10)

use tauri::Manager;

pub mod types;

// Registered as tasks progress — uncomment each after implementation:
pub mod audio;
pub mod calendar;
pub mod commands;
pub mod config;
pub mod demo;
pub mod detection;
pub mod diagnostics;
pub mod embeddings;
pub mod http_client;
pub mod llama_engine;
pub mod meeting_reminders;
pub mod permissions;
pub mod recap;
pub mod recording_spool;
pub mod registration;
pub mod reminders;
pub mod second_brain;
pub mod setup;
pub mod stats;
pub mod storage;
pub mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                match window.is_visible() {
                    Ok(false) => {
                        if let Err(error) = window.show() {
                            eprintln!("[single-instance] couldn't show main window: {error}");
                        }
                    }
                    Ok(true) => {}
                    Err(error) => {
                        eprintln!("[single-instance] couldn't inspect main window: {error}")
                    }
                }
                if let Err(error) = window.set_focus() {
                    eprintln!("[single-instance] couldn't focus main window: {error}");
                }
            } else {
                eprintln!("[single-instance] main window is not available");
            }
        }));
    #[cfg(feature = "wdio")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Show the floating "Recording" bubble when the main window is
        // minimized/blurred during a recording, and hide it when refocused.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                let recording = app
                    .state::<commands::AppState>()
                    .recording
                    .load(std::sync::atomic::Ordering::SeqCst);
                if *focused {
                    commands::hide_recording_bubble(app);
                } else if recording {
                    commands::show_recording_bubble(app);
                }
            }
        })
        .manage(commands::AppState::new())
        .setup(|app| {
            config::ensure_config_dir().expect("Failed to create config directory");
            if let Err(error) = diagnostics::init(app.handle()) {
                eprintln!("[diagnostics] initialization failed: {error}");
            }
            if let Err(error) = storage::init_db(config::load_config().encrypt_db) {
                // A keychain denial (or a changed code signature) makes the DB key
                // unreadable. Explain it and exit cleanly instead of aborting with an
                // opaque crash the user can't act on.
                diagnostics::record("storage.init_failed", &error.to_string());
                // Name the right credential store per platform — this dialog told
                // Windows users to "allow keychain access when macOS asks", which
                // is both impossible to act on and the wrong diagnosis.
                #[cfg(target_os = "macos")]
                let hint = "This usually means access to your keychain was denied. Reopen \
                            Adversaria and allow keychain access when macOS asks.";
                #[cfg(windows)]
                let hint = "This usually means Adversaria could not read its key from \
                            Windows Credential Manager. Reopen Adversaria, and allow \
                            access if Windows asks.";
                #[cfg(not(any(target_os = "macos", windows)))]
                let hint = "This usually means Adversaria could not read its key from \
                            the system credential store. Reopen Adversaria and allow \
                            access if prompted.";
                rfd::MessageDialog::new()
                    .set_level(rfd::MessageLevel::Error)
                    .set_title("Adversaria can't start")
                    .set_description(format!(
                        "Adversaria couldn't open your local database.\n\n{error}\n\n{hint}"
                    ))
                    .show();
                std::process::exit(1);
            }
            if let Err(error) = registration::migrate_legacy_config() {
                eprintln!("[onboarding] legacy state migration failed: {error}");
            }
            // A brand-new library is never empty: seed one finished sample
            // meeting so the first thing a user sees is the end product. Fresh
            // installs only, exactly once — and never a reason not to start.
            match demo::seed_demo_meeting() {
                Ok(true) => eprintln!("[demo] seeded the sample meeting for this fresh install"),
                Ok(false) => {}
                Err(error) => eprintln!("[demo] sample meeting not seeded: {error}"),
            }
            tauri::async_runtime::spawn(async {
                if let Err(error) = registration::retry(false).await {
                    eprintln!("[registration] queued retry could not run: {error}");
                }
            });
            // Recover pending recordings OFF the setup critical path. Recovery
            // touches the macOS Keychain (recording_key → spool decryption); a
            // re-signed build can trigger a Keychain access prompt, and running
            // this synchronously here would HANG launch behind that (often
            // hidden) prompt — no window, no sidecar. On a background thread the
            // window shows and the sidecar spawns first, so any prompt appears
            // over the running app and recovery simply completes once approved.
            std::thread::spawn(|| match commands::recover_recordings() {
                Ok(ids) if !ids.is_empty() => {
                    diagnostics::record("recording.recovered", &format!("count={}", ids.len()));
                    eprintln!("[recovery] restored {} pending recording(s)", ids.len())
                }
                Ok(_) => {}
                Err(error) => {
                    diagnostics::record("recording.recovery_failed", &error);
                    eprintln!("[recovery] startup reconciliation failed: {error}")
                }
            });
            tray::setup_tray(app.handle())?;
            tray::setup_hotkeys(app.handle())?;
            detection::spawn_detector(app.handle().clone());
            reminders::spawn(app.handle().clone());
            meeting_reminders::spawn(app.handle().clone());
            // Packaged builds only: start the bundled Python ML service sidecar.
            // No-op in dev (the bundled binary isn't present; use manual uvicorn).
            commands::spawn_sidecar(app.handle());

            // Nothing downloads during setup (SPEC V3), so a recording can be
            // made before the transcription model exists. This poller finishes
            // those the moment the model is ready — in dev too, where the
            // service is started by hand.
            commands::spawn_transcription_drain(app.handle().clone());

            // Existing local-first users should never have to relaunch Rapid-
            // MLX themselves after an app restart. Warm the selected managed
            // profile in the background; readiness remains visible via health
            // and setup status while the model loads.
            {
                let handle = app.handle().clone();
                let config = config::load_config();
                let onboarding = storage::get_onboarding_state().ok();
                if config.llm_provider == "local"
                    && onboarding.as_ref().is_some_and(|state| {
                        state.setup_complete
                            && setup::profile_alias(&state.selected_model_profile).is_some()
                    })
                {
                    let profile = onboarding.unwrap().selected_model_profile;
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = setup::start(
                            &handle,
                            &handle.state::<commands::AppState>().managed_llm,
                            &profile,
                        )
                        .await
                        {
                            eprintln!("[local-model] background start failed: {error}");
                        }
                    });
                }
            }

            // Backfill/refresh the embedding index once the sidecar is up. Three
            // spaced attempts; a failure just means semantic search stays off
            // until next trigger.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    for attempt in 1u32..=3 {
                        let secs = if attempt == 1 { 20 } else { 90 };
                        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                        let base_url = handle
                            .state::<commands::AppState>()
                            .client
                            .current_base_url();
                        let client = crate::http_client::HttpClient::new(base_url);
                        match crate::embeddings::sync_index(&client).await {
                            Ok(n) => {
                                if n > 0 {
                                    eprintln!("[embeddings] startup sync indexed {n} meeting(s)");
                                }
                                break;
                            }
                            Err(e) => {
                                eprintln!("[embeddings] startup sync attempt {attempt} failed: {e}")
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_recording,
            commands::focus_main_window,
            commands::bubble_stop_recording,
            commands::bubble_start_drag,
            commands::get_audio_level,
            commands::get_audio_levels,
            commands::set_recording_bubble_expanded,
            commands::get_recording_elapsed,
            commands::transcribe_and_summarize,
            commands::transcribe_meeting,
            commands::retry_recording_cleanup,
            commands::enqueue_recording,
            commands::import_audio,
            commands::pick_audio_file,
            commands::resummarize_meeting,
            commands::structure_note,
            commands::generate_template,
            commands::chat_with_meeting,
            commands::get_chat_messages,
            commands::clear_chat,
            commands::update_attendees,
            commands::update_meeting_tags,
            commands::update_meeting_notes,
            commands::update_meeting_summary,
            commands::create_note,
            commands::set_meeting_pinned,
            commands::set_meeting_locked,
            commands::set_meeting_archived,
            commands::delete_meeting,
            commands::export_summary,
            commands::export_html,
            commands::export_meeting_bundle,
            commands::import_meeting_bundle,
            commands::export_all_meetings,
            commands::export_redacted_diagnostics,
            commands::import_all_meetings,
            commands::get_meeting_graph,
            commands::merge_meeting_speakers,
            commands::rename_meeting_person,
            commands::update_meeting_link,
            commands::export_second_brain,
            commands::get_meetings,
            commands::get_meeting,
            commands::ask_all_meetings,
            commands::weekly_briefing,
            commands::get_ask_conversation,
            commands::clear_ask_conversation,
            commands::chat_with_meeting_stream,
            commands::get_config,
            commands::update_config,
            commands::check_service_health,
            commands::restart_local_ai_service,
            commands::test_llm_connection,
            commands::biometric_authenticate,
            commands::get_registration_state,
            commands::submit_registration,
            commands::retry_registration,
            commands::get_onboarding_state,
            commands::complete_onboarding_step,
            commands::get_setup_status,
            commands::engine_configured,
            commands::accept_agent_work,
            commands::get_engine_install_plan,
            commands::install_local_engine,
            commands::start_model_download,
            commands::reset_model_download,
            commands::get_model_download_status,
            commands::get_managed_llm_status,
            commands::start_managed_llm,
            commands::stop_managed_llm,
            commands::set_local_model_profile,
            commands::test_local_setup,
            commands::test_cloud_setup,
            commands::list_whisper_models,
            commands::download_whisper_model,
            commands::list_templates,
            commands::get_template,
            commands::save_template,
            commands::delete_template,
            commands::calendar_set_credentials,
            commands::calendar_has_credentials,
            commands::calendar_connect,
            commands::calendar_disconnect,
            commands::calendar_status,
            commands::calendar_upcoming_events,
            commands::calendar_event_at,
            commands::calendar_macos_enable,
            commands::check_capture_permissions,
            commands::request_microphone_permission,
            commands::probe_system_audio,
            commands::open_privacy_settings,
            commands::calendar_macos_status,
            commands::get_meeting_stats,
            commands::get_person,
            commands::save_person,
            commands::get_action_items,
            commands::set_action_item_done,
            commands::update_action_item,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the bundled sidecar when the app exits so it doesn't linger.
            if let tauri::RunEvent::Exit = event {
                commands::shutdown_sidecar(&app_handle.state::<commands::AppState>());
            }
        });
}
