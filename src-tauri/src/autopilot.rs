//! Autopilot — queued workspace tasks start by themselves, one per workspace,
//! unless the global Pause is on. Every state change that can make a task
//! runnable calls `kick`; a kick is cheap and idempotent.

use tauri::{AppHandle, Emitter, Manager};

use crate::commands::AppState;
use crate::types::WorkspaceEngine;

pub fn kick(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = drain(app).await {
            eprintln!("[autopilot] drain failed: {e}");
        }
    });
}

async fn drain(app: AppHandle) -> Result<(), String> {
    if crate::config::load_config().agents_paused {
        return Ok(());
    }

    let service_ok = app.state::<AppState>().client.check_health().await.is_ok();
    let engines =
        tokio::task::spawn_blocking(move || crate::workspace_runs::detect_engines(service_ok))
            .await
            .map_err(|e| e.to_string())?;

    for summary in crate::storage::list_workspaces().map_err(|e| e.to_string())? {
        if crate::config::load_config().agents_paused {
            return Ok(());
        }
        if summary.running_task_count > 0 {
            continue;
        }
        let id = summary.workspace.id;
        let Some(task) = crate::storage::next_queued_task(id).map_err(|e| e.to_string())? else {
            continue;
        };
        let engine_id = &summary.workspace.engine;
        let Some(engine) = pick_engine(engine_id, &engines) else {
            eprintln!(
                "[autopilot] workspace {} ({}): engine {} unavailable, {} queued",
                id, summary.workspace.name, engine_id, summary.queued_task_count
            );
            continue;
        };

        let task_id = task.id;
        eprintln!(
            "[autopilot] starting task {} in workspace {} on {}",
            task_id, id, engine
        );
        let _ = app.emit(
            "workspace-task-changed",
            serde_json::json!({ "workspace_id": id, "task_id": task_id }),
        );
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let failed_engine = engine.clone();
            if let Err(e) = crate::commands::execute_workspace_run(
                app2,
                task_id,
                engine,
                std::sync::Arc::new(|_line: String| {}),
            )
            .await
            {
                match crate::storage::fail_task_that_could_not_start(
                    task_id,
                    &failed_engine,
                    &e,
                ) {
                    Ok(true) => eprintln!(
                        "[autopilot] task {task_id} could not start and was marked failed: {e}"
                    ),
                    Ok(false) => eprintln!(
                        "[autopilot] task {task_id} could not start and was left queued: {e}"
                    ),
                    Err(mark_error) => eprintln!(
                        "[autopilot] task {task_id} could not start and its failure could not be recorded: {e}; {mark_error}"
                    ),
                }
            }
        });
    }
    Ok(())
}

pub fn pick_engine(workspace_engine: &str, engines: &[WorkspaceEngine]) -> Option<String> {
    engines
        .iter()
        .any(|engine| engine.id == workspace_engine && engine.available)
        .then(|| workspace_engine.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(id: &str, available: bool) -> WorkspaceEngine {
        WorkspaceEngine {
            id: id.to_string(),
            label: id.to_string(),
            available,
            version: String::new(),
            detail: String::new(),
        }
    }

    #[test]
    fn pick_engine_returns_available_workspace_engine() {
        assert_eq!(
            pick_engine("claude", &[engine("claude", true)]),
            Some("claude".to_string())
        );
    }

    #[test]
    fn pick_engine_rejects_unavailable_workspace_engine() {
        assert_eq!(pick_engine("codex", &[engine("codex", false)]), None);
    }

    #[test]
    fn pick_engine_rejects_unknown_workspace_engine() {
        assert_eq!(pick_engine("unknown", &[engine("local", true)]), None);
    }
}
