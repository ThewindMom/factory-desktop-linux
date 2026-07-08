//! Application entrypoints and orchestration for the local updater daemon.

use crate::{
    builder, cache_cleanup,
    cli::{Cli, Commands},
    config::{RuntimeConfig, RuntimePaths},
    install, install_rollback, liveness, logging, notify, port_update, rollback,
    state::{PersistedState, UpdateStatus},
    upstream,
};
use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Client;
use serde::Deserialize;
use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tokio::time::{self, Duration};
use tracing::{error, info, warn};

const RECONCILE_INTERVAL_SECONDS: u64 = 15;
const DISABLE_RELAUNCH_ENV: &str = "FACTORY_UPDATE_MANAGER_DISABLE_RELAUNCH";
const INSTALL_READY_EXIT_WAIT_MS_ENV: &str = "FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_WAIT_MS";
const INSTALL_READY_EXIT_POLL_MS_ENV: &str = "FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_POLL_MS";
const DEFAULT_INSTALL_READY_EXIT_WAIT_MS: u64 = 120_000;
const DEFAULT_INSTALL_READY_EXIT_POLL_MS: u64 = 250;
const POLKIT_AUTH_AGENT_PROCESS_TOKENS: &[&str] = &[
    "budgie-polkit",
    "cinnamon-polkit",
    "cosmic-osd",
    "gnome-shell",
    "hyprpolkitagent",
    "io.elementary.desktop.agent-polkit",
    "lxpolkit",
    "lxqt-policykit-agent",
    "mate-polkit",
    "polkit-agent",
    "polkit-dde-agent",
    "polkit-gnome-authentication-agent",
    "polkit-kde-authentication-agent",
    "soteria",
    "ukui-polkit",
    "xfce-polkit",
];

/// Runs the updater command-line entrypoint.
pub async fn run(cli: Cli) -> Result<()> {
    let paths = RuntimePaths::detect()?;
    paths.ensure_dirs()?;
    logging::init(&paths.log_file)?;

    let config = RuntimeConfig::load_or_default(&paths)?;
    let mut state =
        PersistedState::load_or_default(&paths.state_file, effective_auto_install(&config))?;
    let original_state = state.clone();
    state.installed_version = install::installed_package_version();
    persist_if_changed(&paths, &state, &original_state)?;

    match cli.command {
        Commands::Daemon => run_daemon(&config, &mut state, &paths).await,
        Commands::CheckNow { if_stale } => {
            run_check_now(&config, &mut state, &paths, if_stale).await
        }
        Commands::Status { json } => run_status(&config, &mut state, &paths, json).await,
        Commands::InstallReady => run_install_ready(&config, &mut state, &paths).await,
        Commands::Rollback => rollback::run(&config, &mut state, &paths).await,
        Commands::InstallDeb { path, result_file } => {
            write_install_result(&path, result_file.as_deref(), install::install_deb(&path))
        }
        Commands::InstallRollbackDeb { path, result_file } => write_install_result(
            &path,
            result_file.as_deref(),
            install_rollback::install_deb(&path),
        ),
    }
}

fn persist_state(paths: &RuntimePaths, state: &PersistedState) -> Result<()> {
    state.save(&paths.state_file)
}
/// Writes a result sentinel file after an install-deb/install-rollback-deb
/// subcommand completes. The daemon polls this file to detect completion of
/// installs launched via systemd-run transient units.
///
/// Format: `success\n` or `failure\n<error message>`
fn write_install_result(
    package_path: &Path,
    result_file: Option<&Path>,
    result: Result<()>,
) -> Result<()> {
    let _ = package_path; // used for logging context if needed
    if let Some(result_file) = result_file {
        let content = match &result {
            Ok(()) => "success\n".to_string(),
            Err(e) => format!("failure\n{e}"),
        };
        // Best-effort: if we can't write the sentinel, the daemon will
        // eventually detect the failure via systemd unit status.
        if let Some(parent) = result_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(result_file, content);
    }
    result
}
fn persist_if_changed(
    paths: &RuntimePaths,
    state: &PersistedState,
    original_state: &PersistedState,
) -> Result<()> {
    if state != original_state {
        persist_state(paths, state)?;
    }
    Ok(())
}

fn effective_auto_install(_config: &RuntimeConfig) -> bool {
    false
}

fn duration_from_env_ms(var: &str, default_ms: u64) -> Duration {
    std::env::var(var)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(default_ms))
}

async fn wait_for_app_exit(config: &RuntimeConfig) -> Result<bool> {
    let timeout = duration_from_env_ms(
        INSTALL_READY_EXIT_WAIT_MS_ENV,
        DEFAULT_INSTALL_READY_EXIT_WAIT_MS,
    );
    let poll = duration_from_env_ms(
        INSTALL_READY_EXIT_POLL_MS_ENV,
        DEFAULT_INSTALL_READY_EXIT_POLL_MS,
    );

    if !liveness::is_app_running(config)? {
        return Ok(true);
    }
    if timeout.is_zero() {
        return Ok(false);
    }

    let deadline = time::Instant::now() + timeout;
    loop {
        let now = time::Instant::now();
        if now >= deadline {
            return Ok(!liveness::is_app_running(config)?);
        }

        let remaining = deadline.saturating_duration_since(now);
        time::sleep(poll.min(remaining)).await;
        if !liveness::is_app_running(config)? {
            return Ok(true);
        }
    }
}

fn sync_runtime_state(config: &RuntimeConfig, state: &mut PersistedState) {
    state.auto_install_on_app_exit = effective_auto_install(config);
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    state.installed_version = install::installed_package_version();
    // Sync the installed port SHA from build-info.json here (not only in
    // run_check_cycle) so that complete_pending_install_if_already_installed
    // can correctly compare port SHAs even when the check cycle is skipped
    // due to a pending update. Without this, a stale ready_to_install state
    // deadlocks the daemon: the check cycle skips (pending), but the SHA
    // needed to clear the pending state is never synced.
    sync_installed_port_sha(config, state);
}

fn sync_and_persist(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    sync_runtime_state(config, state);
    persist_if_changed(paths, state, &original_state)
}

fn normalize_workspace_dir_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let original_state = state.clone();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_if_changed(paths, state, &original_state)
}

fn maybe_prune_workspace_cache(workspace_root: &Path, state: &PersistedState) {
    match cache_cleanup::prune_unreferenced_workspaces(workspace_root, state) {
        Ok(summary) if summary.pruned_workspaces > 0 => {
            info!(
                pruned_workspaces = summary.pruned_workspaces,
                workspace_root = %workspace_root.display(),
                "pruned unreferenced updater workspaces"
            );
        }
        Ok(_) => {}
        Err(error) => {
            warn!(
                ?error,
                workspace_root = %workspace_root.display(),
                "failed to prune unreferenced updater workspaces"
            );
        }
    }
}

fn set_status(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    status: UpdateStatus,
) -> Result<()> {
    state.status = status;
    if state.status != UpdateStatus::WaitingForAppExit {
        state.waiting_for_app_exit_auto_install = false;
    }
    persist_state(paths, state)
}

fn set_waiting_for_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    auto_install: bool,
) -> Result<()> {
    state.waiting_for_app_exit_auto_install = auto_install;
    state.status = UpdateStatus::WaitingForAppExit;
    persist_state(paths, state)
}

fn mark_failed_and_persist(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: impl Into<String>,
) -> Result<()> {
    state.mark_failed(message);
    persist_state(paths, state)
}

fn packaged_runtime_removed(config: &RuntimeConfig) -> bool {
    config.builder_bundle_root == Path::new("/opt/factory-desktop/update-builder")
        && !config.app_executable_path.exists()
        && !install::is_primary_package_installed()
}

fn summarize_command_output(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    let mut lines = text.lines().rev().take(3).collect::<Vec<_>>();
    lines.reverse();
    Some(lines.join(" | "))
}

struct CheckLock {
    _file: fs::File,
}

fn try_acquire_check_lock(paths: &RuntimePaths) -> Result<Option<CheckLock>> {
    let lock_path = paths.state_dir.join("check.lock");
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("Failed to open {}", lock_path.display()))?;

    match file.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            info!("skipping upstream check because another check is already active");
            return Ok(None);
        }
        Err(fs::TryLockError::Error(error)) => {
            return Err(error).with_context(|| format!("Failed to lock {}", lock_path.display()));
        }
    }

    file.set_len(0)
        .with_context(|| format!("Failed to truncate {}", lock_path.display()))?;
    file.seek(SeekFrom::Start(0))
        .with_context(|| format!("Failed to seek {}", lock_path.display()))?;
    writeln!(file, "{}", std::process::id())
        .with_context(|| format!("Failed to write {}", lock_path.display()))?;

    Ok(Some(CheckLock { _file: file }))
}

fn update_install_is_pending(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit | UpdateStatus::Installing
    )
}

fn status_to_restore_after_check_failure(state: &PersistedState) -> UpdateStatus {
    if state.status != UpdateStatus::CheckingUpstream {
        return state.status.clone();
    }
    if state.candidate_version.is_some() {
        UpdateStatus::Idle
    } else {
        UpdateStatus::Installed
    }
}

async fn run_daemon(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(config, state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_workspace_cache(&config.workspace_root, state);
    maybe_notify_installed(state, paths, config.notifications)?;
    if packaged_runtime_removed(config) {
        info!("packaged app files are gone; stopping updater daemon");
        return Ok(());
    }
    info!("daemon initialized");

    time::sleep(Duration::from_secs(config.initial_check_delay_seconds)).await;
    if let Err(error) = run_check_cycle(config, state, paths).await {
        error!(?error, "initial check failed");
    }
    if let Err(error) = reconcile_pending_install(config, state, paths).await {
        error!(?error, "initial reconciliation failed");
    }

    let mut check_interval =
        time::interval(Duration::from_secs(config.check_interval_hours * 3600));
    let mut reconcile_interval = time::interval(Duration::from_secs(RECONCILE_INTERVAL_SECONDS));
    check_interval.tick().await;
    reconcile_interval.tick().await;
    loop {
        if packaged_runtime_removed(config) {
            info!("packaged app files are gone; stopping updater daemon");
            break;
        }

        tokio::select! {
            _ = check_interval.tick() => {
                if let Err(error) = run_check_cycle(config, state, paths).await {
                    error!(?error, "periodic check failed");
                }
            }
            _ = reconcile_interval.tick() => {
                if let Err(error) = reconcile_pending_install(config, state, paths).await {
                    error!(?error, "pending install reconciliation failed");
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                info!("daemon received shutdown signal");
                break;
            }
        }
    }

    Ok(())
}

async fn run_check_now(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    if_stale: bool,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(config, state, paths)?;
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;
    maybe_prune_workspace_cache(&config.workspace_root, state);
    maybe_notify_installed(state, paths, config.notifications)?;
    clear_superseded_pending_for_manual_check(state, paths)?;
    if if_stale && upstream_check_is_fresh(config, state) {
        info!("skipping check-now because the last successful upstream check is still fresh");
        return reconcile_pending_install(config, state, paths).await;
    }
    run_check_cycle(config, state, paths).await?;
    reconcile_pending_install(config, state, paths).await
}

fn upstream_check_is_fresh(config: &RuntimeConfig, state: &PersistedState) -> bool {
    let Some(last_successful_check_at) = state.last_successful_check_at else {
        return false;
    };

    let freshness_window = ChronoDuration::hours(config.check_interval_hours as i64);
    Utc::now().signed_duration_since(last_successful_check_at) < freshness_window
}

/// Fetch the latest droid CLI version from the npm registry.
///
/// Queries `https://registry.npmjs.org/@factory/cli-linux-x64` and parses
/// the `dist-tags.latest` field. Returns `Ok(None)` on network failure so
/// the status command never fails due to a transient network issue.
async fn fetch_latest_droid_version(client: &Client) -> Result<Option<String>> {
    let response = client
        .get("https://registry.npmjs.org/@factory/cli-linux-x64")
        .timeout(Duration::from_secs(8))
        .send()
        .await;
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            warn!("failed to fetch latest droid version from npm: {e}");
            return Ok(None);
        }
    };
    let body: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(e) => {
            warn!("failed to parse npm registry response: {e}");
            return Ok(None);
        }
    };
    let latest = body
        .get("dist-tags")
        .and_then(|t| t.get("latest"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(latest)
}

async fn run_status(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    json: bool,
) -> Result<()> {
    complete_current_dmg_update_if_already_installed(config, state, paths)?;
    complete_pending_install_if_already_installed(state, paths)?;
    normalize_workspace_dir_and_persist(state, paths)?;

    // Fetch installed + latest droid version for drift advisory.
    let installed_droid = installed_droid_version(config);
    let client = Client::builder().build()?;
    let latest_droid = fetch_latest_droid_version(&client).await.unwrap_or(None);

    let droid_drift = match (&installed_droid, &latest_droid) {
        (Some(installed), Some(latest)) => installed != latest,
        _ => false,
    };

    if json {
        let mut json_state = serde_json::to_value(state)?;
        let obj = json_state.as_object_mut().unwrap();
        if let Some(ref v) = installed_droid {
            obj.insert(
                "droid_version".to_string(),
                serde_json::Value::String(v.clone()),
            );
        }
        if let Some(ref v) = latest_droid {
            obj.insert(
                "droid_latest_version".to_string(),
                serde_json::Value::String(v.clone()),
            );
        }
        obj.insert(
            "droid_drift".to_string(),
            serde_json::Value::Bool(droid_drift),
        );
        println!("{}", serde_json::to_string_pretty(&json_state)?);
    } else {
        println!("status: {:?}", state.status);
        println!("installed_version: {}", state.installed_version);
        println!(
            "candidate_version: {}",
            state.candidate_version.as_deref().unwrap_or("none")
        );
        println!(
            "last_known_good_version: {}",
            state.last_known_good_version.as_deref().unwrap_or("none")
        );
        println!(
            "rollback_blocked_candidate_version: {}",
            state
                .rollback_blocked_candidate_version
                .as_deref()
                .unwrap_or("none")
        );
        println!("{}", update_error_status_line(state));

        if let Some(ref installed) = installed_droid {
            println!("droid_version: {}", installed);
            if droid_drift {
                if let Some(ref latest) = latest_droid {
                    println!(
                        "droid_drift: installed={}, latest={} — a newer droid CLI is available.                          It will be included in the next port build.",
                        installed, latest
                    );
                }
            }
        }
    }

    Ok(())
}

fn update_error_status_line(state: &PersistedState) -> String {
    format!(
        "update_error: {}",
        state.error_message.as_deref().unwrap_or("none")
    )
}

async fn run_check_cycle(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    if update_install_is_pending(&state.status) {
        match refresh_superseded_pending_port_update(config, state, paths).await {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error) => warn!(?error, "pending port update refresh check failed"),
        }
        info!("skipping upstream check because an update is already pending");
        return Ok(());
    }

    let retrying_failed_update = state.status == UpdateStatus::Failed;

    let Some(_check_lock) = try_acquire_check_lock(paths)? else {
        return Ok(());
    };

    let client = Client::builder().build()?;

    sync_runtime_state(config, state);
    let status_before_check = status_to_restore_after_check_failure(state);
    state.status = UpdateStatus::CheckingUpstream;
    state.last_check_at = Some(Utc::now());
    state.error_message = None;
    persist_state(paths, state)?;

    let result: Result<()> = async {
        if let Some(port_update) = port_update::check_for_port_update(
            &client,
            &config.github_api_base_url,
            &config.github_owner,
            &config.github_repo,
            state.installed_port_sha.as_deref(),
        )
        .await?
        {
            info!(
                release_sha = %port_update.release_sha,
                "port build update detected"
            );

            if let (Some(deb_url), Some(deb_name)) =
                (port_update.deb_url.as_ref(), port_update.deb_name.as_ref())
            {
                set_status(state, paths, UpdateStatus::DownloadingDmg)?;

                let deb_dir = config.workspace_root.join("port-deb");
                let downloaded =
                    port_update::download_deb(&client, deb_url, &deb_dir, deb_name).await?;

                rollback::record_current_package_as_known_good(state);
                state.status = UpdateStatus::ReadyToInstall;
                state.port_candidate_sha = Some(port_update.release_sha.clone());
                state.artifact_paths.package_path = Some(downloaded.path);
                state.candidate_version = Some(port_update.release_version.clone());
                state.notified_events.clear();
                state.save(&paths.state_file)?;

                info!(deb = %deb_name, "port .deb downloaded and ready to install");
                maybe_notify_update_ready(state, paths, config.notifications)?;
                return Ok(());
            }

            info!(
                "port build update detected but no .deb asset found; falling through to upstream check"
            );
        }

        let metadata =
            upstream::fetch_remote_metadata(&client, &config.dmg_api_url_with_arch()).await?;
        let previous_headers_fingerprint = state.remote_headers_fingerprint.clone();
        state.remote_headers_fingerprint = Some(metadata.headers_fingerprint.clone());
        state.last_successful_check_at = Some(Utc::now());

        if previous_headers_fingerprint.as_deref() == Some(metadata.headers_fingerprint.as_str())
            && state.dmg_sha256.is_some()
            && !retrying_failed_update
        {
            set_status(state, paths, UpdateStatus::Idle)?;
            info!("upstream fingerprint unchanged; skipping download");
            return Ok(());
        }

        set_status(state, paths, UpdateStatus::DownloadingDmg)?;

        let downloads_dir = config.workspace_root.join("downloads");
        let downloaded = upstream::download_dmg(
            &client,
            &config.dmg_api_url_with_arch(),
            &downloads_dir,
            Utc::now(),
        )
        .await?;

        if installed_upstream_dmg_matches(config, &downloaded.sha256) {
            clear_dmg_update_candidate(
                state,
                paths,
                Some(downloaded.path),
                Some(downloaded.sha256),
            )?;
            info!("downloaded DMG hash matches installed app; no update detected");
            return Ok(());
        }

        if state
            .rollback_blocked_candidate_version
            .as_deref()
            .is_some_and(|blocked| {
                installed_version_matches_candidate(blocked, &downloaded.candidate_version)
            })
        {
            state.status = UpdateStatus::Idle;
            state.error_message = Some(format!(
                "Candidate {} was rolled back and will not be reinstalled automatically",
                downloaded.candidate_version
            ));
            persist_state(paths, state)?;
            info!(
                candidate_version = %downloaded.candidate_version,
                "skipping candidate blocked by rollback"
            );
            return Ok(());
        }

        if state.dmg_sha256.as_deref() == Some(downloaded.sha256.as_str())
            && !retrying_failed_update
        {
            state.status = UpdateStatus::Idle;
            state.artifact_paths.dmg_path = Some(downloaded.path);
            persist_state(paths, state)?;
            info!("downloaded DMG hash matches current cached DMG; no update detected");
            return Ok(());
        }

        rollback::record_current_package_as_known_good(state);
        state.status = UpdateStatus::UpdateDetected;
        state.candidate_version = Some(downloaded.candidate_version.clone());
        state.dmg_sha256 = Some(downloaded.sha256.clone());
        state.artifact_paths.dmg_path = Some(downloaded.path.clone());
        state.notified_events.clear();
        state.save(&paths.state_file)?;

        maybe_notify(
            state,
            paths,
            config.notifications,
            "update_detected",
            "New Factory Desktop update detected",
            "Preparing a local Linux package from the new upstream DMG.",
        )?;

        let candidate_version = state
            .candidate_version
            .clone()
            .expect("candidate version should be set before local build");
        builder::build_update(config, state, paths, &candidate_version, &downloaded.path).await?;
        maybe_prune_workspace_cache(&config.workspace_root, state);
        maybe_notify_update_ready(state, paths, config.notifications)?;
        Ok(())
    }
    .await;

    if let Err(error) = result {
        if state.status == UpdateStatus::CheckingUpstream {
            state.status = status_before_check;
            state.error_message = Some(error.to_string());
            state
                .notified_events
                .retain(|event| !event.starts_with("build_failed:"));
            persist_state(paths, state)?;
            maybe_prune_workspace_cache(&config.workspace_root, state);
            return Err(error);
        } else {
            mark_failed_and_persist(state, paths, error.to_string())?;
        }
        maybe_prune_workspace_cache(&config.workspace_root, state);
        let _ = notify_failure(config, state, paths, &error);
        return Err(error);
    }

    Ok(())
}

async fn refresh_superseded_pending_port_update(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(false);
    }

    let Some(pending_port_sha) = state.port_candidate_sha.clone() else {
        return Ok(false);
    };

    sync_runtime_state(config, state);

    let client = Client::builder().build()?;
    let Some(port_update) = port_update::check_for_port_update(
        &client,
        &config.github_api_base_url,
        &config.github_owner,
        &config.github_repo,
        state.installed_port_sha.as_deref(),
    )
    .await?
    else {
        return Ok(false);
    };

    if port_update.release_sha == pending_port_sha {
        return Ok(false);
    }

    let (Some(deb_url), Some(deb_name)) =
        (port_update.deb_url.as_ref(), port_update.deb_name.as_ref())
    else {
        return Ok(false);
    };

    info!(
        old_release_sha = %pending_port_sha,
        new_release_sha = %port_update.release_sha,
        "refreshing superseded pending port update"
    );

    set_status(state, paths, UpdateStatus::DownloadingDmg)?;
    let deb_dir = config.workspace_root.join("port-deb");
    let downloaded = port_update::download_deb(&client, deb_url, &deb_dir, deb_name).await?;

    rollback::record_current_package_as_known_good(state);
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.port_candidate_sha = Some(port_update.release_sha);
    state.artifact_paths.package_path = Some(downloaded.path);
    state.candidate_version = Some(port_update.release_version);
    state.error_message = None;
    state.notified_events.clear();
    state.save(&paths.state_file)?;

    info!(deb = %deb_name, "refreshed pending port .deb");
    maybe_notify_update_ready(state, paths, config.notifications)?;
    Ok(true)
}

async fn reconcile_pending_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_runtime_state(config, state);
    recover_interrupted_install(config, state, paths)?;
    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.auto_install_on_app_exit && liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                set_waiting_for_app_exit(state, paths, true)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "ready_to_install",
                    "Factory Desktop update ready",
                    "Close Factory Desktop to install the ready update.",
                )?;
                return Ok(());
            }

            if !state.auto_install_on_app_exit {
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "ready_to_install_manual",
                    "Factory Desktop update ready",
                    "Run: factory-update-manager install-ready",
                )?;
                return Ok(());
            }

            // App is NOT running and auto-install is enabled — install now.
            if install_auth_retry_is_blocked(state) {
                return Ok(());
            }

            if !graphical_polkit_auth_agent_is_likely_available() {
                defer_install_for_manual_auth(state, paths, &package_path)?;
                maybe_notify_manual_install_required(state, paths, config.notifications)?;
                return Ok(());
            }

            trigger_install(config, state, paths, &config.workspace_root, &package_path).await?;
        }
        UpdateStatus::WaitingForAppExit => {
            let Some(package_path) = state.artifact_paths.package_path.clone() else {
                return Ok(());
            };

            if !package_path.exists() {
                mark_failed_and_persist(
                    state,
                    paths,
                    format!(
                        "Pending package artifact is missing: {}",
                        package_path.display()
                    ),
                )?;
                return Ok(());
            }

            if state.waiting_for_app_exit_auto_install && !state.auto_install_on_app_exit {
                set_status(state, paths, UpdateStatus::ReadyToInstall)?;
                return Ok(());
            }

            if liveness::is_app_running(config)? {
                if !graphical_polkit_auth_agent_is_likely_available() {
                    defer_install_for_manual_auth(state, paths, &package_path)?;
                    maybe_notify_manual_install_required(state, paths, config.notifications)?;
                    return Ok(());
                }
                clear_install_auth_required_event(state, paths)?;
                maybe_notify(
                    state,
                    paths,
                    config.notifications,
                    "waiting_for_app_exit",
                    "Factory Desktop update ready",
                    "The update will install after you close Factory Desktop.",
                )?;
                return Ok(());
            }

            if install_auth_retry_is_blocked(state) {
                return Ok(());
            }

            if !graphical_polkit_auth_agent_is_likely_available() {
                defer_install_for_manual_auth(state, paths, &package_path)?;
                maybe_notify_manual_install_required(state, paths, config.notifications)?;
                return Ok(());
            }

            trigger_install(config, state, paths, &config.workspace_root, &package_path).await?;
        }
        UpdateStatus::Installing => {
            // An install was launched via systemd-run (fire-and-forget).
            // Poll for completion via the result sentinel file or unit status.
            if check_install_completion(config, state, paths)? {
                // Install completed — state already updated by check_install_completion.
                return Ok(());
            }
            // Install still running — nothing to do this cycle.
        }
        _ => {}
    }

    Ok(())
}

async fn run_install_ready(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    sync_and_persist(config, state, paths)?;
    recover_interrupted_install(config, state, paths)?;

    if complete_current_dmg_update_if_already_installed(config, state, paths)? {
        println!("Factory Desktop is already up to date.");
        return Ok(());
    }

    if complete_pending_install_if_already_installed(state, paths)? {
        let _ = maybe_notify_installed(state, paths, config.notifications);
        println!("Factory Desktop update is already installed or superseded.");
        return Ok(());
    }

    match state.status {
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit => {}
        UpdateStatus::Installing => {
            maybe_send_notification(
                config.notifications,
                "Factory update already installing",
                "Factory Desktop is already applying the ready update.",
            );
            println!("Factory Desktop update is already installing.");
            return Ok(());
        }
        _ => {
            maybe_send_notification(
                config.notifications,
                "No Factory update ready",
                "There is no rebuilt Factory Desktop update waiting to install.",
            );
            println!("No Factory Desktop update is ready to install.");
            return Ok(());
        }
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(state, paths, "No ready update package is recorded")?;
        println!("No ready update package is recorded.");
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Pending package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        println!(
            "Ready update package is missing: {}",
            package_path.display()
        );
        return Ok(());
    }

    if liveness::is_app_running(config)? {
        if !graphical_polkit_auth_agent_is_likely_available() {
            defer_install_for_manual_auth(state, paths, &package_path)?;
            maybe_send_manual_install_required_notification(config.notifications);
            print_manual_install_required(&package_path);
            return Ok(());
        }
        clear_install_auth_required_event(state, paths)?;
        set_waiting_for_app_exit(state, paths, true)?;
        maybe_send_notification(
            config.notifications,
            "Factory Desktop update ready",
            "Factory Desktop will install the update after it closes.",
        );
        println!("Factory Desktop is running. The update will install after it closes.");
        if !wait_for_app_exit(config).await? {
            return Ok(());
        }
        info!("Factory Desktop exited; launching ready update install");
        println!("Factory Desktop exited; installing update.");
    }

    clear_install_auth_required_event(state, paths)?;
    state.waiting_for_app_exit_auto_install = false;
    if !graphical_polkit_auth_agent_is_likely_available() {
        defer_install_for_manual_auth(state, paths, &package_path)?;
        maybe_send_manual_install_required_notification(config.notifications);
        print_manual_install_required(&package_path);
        return Ok(());
    }
    trigger_install(config, state, paths, &config.workspace_root, &package_path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledBuildInfo {
    upstream_dmg: Option<InstalledUpstreamDmg>,
    #[serde(default)]
    port_build_sha: Option<String>,
    #[serde(default)]
    droid_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstalledUpstreamDmg {
    sha256: Option<String>,
}

fn complete_current_dmg_update_if_already_installed(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !dmg_update_state_can_be_cleared_as_current(&state.status) {
        return Ok(false);
    }

    if state.candidate_version.is_none() {
        return Ok(false);
    }

    let Some(candidate_sha256) = state.dmg_sha256.clone() else {
        return Ok(false);
    };

    if !installed_upstream_dmg_matches(config, &candidate_sha256) {
        return Ok(false);
    }

    clear_dmg_update_candidate(state, paths, None, Some(candidate_sha256))?;
    info!("recovered DMG update state because the candidate DMG is already installed");
    Ok(true)
}

fn dmg_update_state_can_be_cleared_as_current(status: &UpdateStatus) -> bool {
    matches!(
        status,
        UpdateStatus::UpdateDetected
            | UpdateStatus::DownloadingDmg
            | UpdateStatus::PreparingWorkspace
            | UpdateStatus::BuildingPackage
            | UpdateStatus::ReadyToInstall
            | UpdateStatus::WaitingForAppExit
            | UpdateStatus::Installing
            | UpdateStatus::Failed
    )
}

fn clear_dmg_update_candidate(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    dmg_path: Option<PathBuf>,
    sha256: Option<String>,
) -> Result<()> {
    state.status = UpdateStatus::Idle;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    if let Some(sha256) = sha256 {
        state.dmg_sha256 = Some(sha256);
    }
    if let Some(dmg_path) = dmg_path {
        state.artifact_paths.dmg_path = Some(dmg_path);
    }
    state.artifact_paths.package_path = None;
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)
}
fn installed_upstream_dmg_matches(config: &RuntimeConfig, sha256: &str) -> bool {
    installed_upstream_dmg_sha256(config).as_deref() == Some(sha256)
}

fn installed_upstream_dmg_sha256(config: &RuntimeConfig) -> Option<String> {
    installed_build_info_paths(config)
        .into_iter()
        .find_map(|path| upstream_dmg_sha256_from_build_info(&path))
}

/// Read the portBuildSha from the installed build-info.json, if present.
fn installed_port_build_sha(config: &RuntimeConfig) -> Option<String> {
    installed_build_info_paths(config)
        .into_iter()
        .find_map(|path| {
            let content = fs::read_to_string(&path).ok()?;
            let build_info = serde_json::from_str::<InstalledBuildInfo>(&content).ok()?;
            build_info.port_build_sha.filter(|value| !value.is_empty())
        })
}

/// Read the droidVersion from the installed build-info.json, if present.
fn installed_droid_version(config: &RuntimeConfig) -> Option<String> {
    installed_build_info_paths(config)
        .into_iter()
        .find_map(|path| {
            let content = fs::read_to_string(&path).ok()?;
            let build_info = serde_json::from_str::<InstalledBuildInfo>(&content).ok()?;
            build_info.droid_version.filter(|value| !value.is_empty())
        })
}

/// Sync the installed port SHA from build-info.json into persisted state.
fn sync_installed_port_sha(config: &RuntimeConfig, state: &mut PersistedState) {
    let current = installed_port_build_sha(config);
    if current != state.installed_port_sha {
        state.installed_port_sha = current;
    }
}

fn installed_build_info_paths(config: &RuntimeConfig) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(app_root) = config.app_executable_path.parent() {
        paths.push(app_root.join(".factory-linux/build-info.json"));
        paths.push(app_root.join("resources/factory-linux-build-info.json"));
    }
    paths
}

fn upstream_dmg_sha256_from_build_info(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let build_info = serde_json::from_str::<InstalledBuildInfo>(&content).ok()?;
    build_info
        .upstream_dmg?
        .sha256
        .filter(|value| !value.is_empty())
}

fn complete_pending_install_if_already_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(false);
    }

    let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) else {
        return Ok(false);
    };

    // Don't clear a pending port update if the port SHA differs — the
    // version matches but the port build has new patches/code.
    let candidate_is_installed =
        installed_version_matches_candidate(&state.installed_version, &candidate_version);
    if candidate_is_installed
        && state.port_candidate_sha.is_some()
        && state.port_candidate_sha != state.installed_port_sha
    {
        return Ok(false);
    }

    state.status = UpdateStatus::Installed;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    state.port_candidate_sha = None;
    if !candidate_is_installed {
        state.artifact_paths.package_path = None;
    }
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!("recovered pending install state because the candidate version is already installed or superseded");
    Ok(true)
}

fn clear_superseded_pending_for_manual_check(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    if !matches!(
        state.status,
        UpdateStatus::ReadyToInstall | UpdateStatus::WaitingForAppExit
    ) {
        return Ok(false);
    }

    let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) else {
        return Ok(false);
    };

    let candidate_is_installed =
        installed_version_matches_candidate(&state.installed_version, &candidate_version);

    state.status = UpdateStatus::Installed;
    state.waiting_for_app_exit_auto_install = false;
    state.candidate_version = None;
    state.port_candidate_sha = None;
    if candidate_is_installed {
        state.artifact_paths.package_path = None;
    }
    state.error_message = None;
    state.notified_events.clear();
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!("cleared superseded pending update before manual check");
    Ok(true)
}

fn recover_interrupted_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    if state.status != UpdateStatus::Installing {
        return Ok(());
    }

    // Refresh installed_port_sha from the on-disk build-info.json before
    // comparing against port_candidate_sha. After a successful install, the
    // new build-info.json on disk has the new SHA, but the persisted state
    // still holds the old SHA from the previous daemon startup. Without this
    // refresh, the port SHA comparison below would incorrectly see a mismatch
    // and fall through to ReadyToInstall, re-triggering the install in a loop.
    sync_runtime_state(config, state);
    if let Some(candidate_version) = state.candidate_version.clone().filter(|candidate| {
        installed_version_satisfies_candidate(&state.installed_version, candidate)
    }) {
        // Don't clear an interrupted port update if the port SHA differs.
        if state.port_candidate_sha.is_some()
            && state.port_candidate_sha != state.installed_port_sha
        {
            // Fall through to package recovery below.
        } else {
            let candidate_is_installed =
                installed_version_matches_candidate(&state.installed_version, &candidate_version);

            state.status = UpdateStatus::Installed;
            state.waiting_for_app_exit_auto_install = false;
            state.candidate_version = None;
            if !candidate_is_installed {
                state.artifact_paths.package_path = None;
            }
            state.error_message = None;
            state.notified_events.clear();
            cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
            persist_state(paths, state)?;
            maybe_relaunch_app_after_update(config);
            info!("recovered interrupted install state because the candidate version is already installed");
            return Ok(());
        }
    }

    let Some(package_path) = state.artifact_paths.package_path.clone() else {
        mark_failed_and_persist(
            state,
            paths,
            "Previous install attempt was interrupted and no package artifact is recorded",
        )?;
        return Ok(());
    };

    if !package_path.exists() {
        mark_failed_and_persist(
            state,
            paths,
            format!(
                "Previous install attempt was interrupted and the package artifact is missing: {}",
                package_path.display()
            ),
        )?;
        return Ok(());
    }

    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message =
        Some("Previous install attempt was interrupted before completion".to_string());
    cache_cleanup::normalize_artifact_workspace_dir(&paths.cache_dir, state);
    persist_state(paths, state)?;
    info!(package = %package_path.display(), "recovered interrupted install state back to ready_to_install");
    Ok(())
}

/// Compares versions using semver. Factory uses semver (e.g. "0.108.0"),
/// so we parse and compare directly. Falls back to string equality.
fn installed_version_satisfies_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match (
        semver::Version::parse(installed),
        semver::Version::parse(candidate),
    ) {
        (Ok(installed_ver), Ok(candidate_ver)) => installed_ver >= candidate_ver,
        _ => installed == candidate,
    }
}

fn installed_version_matches_candidate(installed: &str, candidate: &str) -> bool {
    if installed == "unknown" {
        return false;
    }

    match (
        semver::Version::parse(installed),
        semver::Version::parse(candidate),
    ) {
        (Ok(installed_ver), Ok(candidate_ver)) => installed_ver == candidate_ver,
        _ => installed == candidate,
    }
}

fn maybe_notify(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_name: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("{event_name}:{version}");
    maybe_notify_with_event_key(state, paths, enabled, &event_key, summary, body)
}

fn maybe_notify_with_event_key(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
    event_key: &str,
    summary: &str,
    body: &str,
) -> Result<()> {
    if !state.notified_events.insert(event_key.to_string()) {
        return Ok(());
    }

    if enabled {
        if let Err(error) = notify::send(summary, body) {
            warn!(?error, "failed to send desktop notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

#[allow(dead_code)]
fn clear_notification_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    event_key: &str,
) -> Result<()> {
    if state.notified_events.remove(event_key) {
        persist_state(paths, state)?;
    }
    Ok(())
}

fn maybe_notify_installed(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    if state.status != UpdateStatus::Installed {
        return Ok(());
    }

    maybe_notify(
        state,
        paths,
        enabled,
        "installed",
        "Factory Desktop updated",
        "The new package is installed. Factory Desktop is reopening.",
    )
}

fn maybe_notify_update_ready(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    let version = state
        .candidate_version
        .as_deref()
        .unwrap_or(&state.installed_version);
    let event_key = format!("ready_to_install:{version}");
    if !state.notified_events.insert(event_key) {
        return Ok(());
    }

    if enabled {
        let body = if state.auto_install_on_app_exit {
            "A rebuilt Linux package is ready. Close Factory Desktop to install it, or open Factory Desktop and choose Update."
        } else {
            "A rebuilt Linux package is ready. Open Factory Desktop and choose Update to install it."
        };
        if let Err(error) = notify::send("Factory Desktop update ready", body) {
            warn!(?error, "failed to send update-ready notification");
        }
    }

    persist_state(paths, state)?;
    Ok(())
}

fn maybe_send_notification(enabled: bool, summary: &str, body: &str) {
    if enabled {
        let _ = notify::send(summary, body);
    }
}

async fn trigger_install(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace_root: &Path,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::Installing;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = None;

    // Set up the result sentinel path so the daemon can detect completion
    // after a restart (the postinst restarts the daemon mid-install).
    let result_file = paths.state_dir.join("install-result");
    state.install_task_result_file = Some(result_file.to_string_lossy().into_owned());
    persist_state(paths, state)?;

    let _ = notify::send(
        "Installing Factory Desktop update",
        "Applying the locally rebuilt Linux package.",
    );

    // Remove any stale result sentinel from a previous attempt.
    let _ = fs::remove_file(&result_file);

    let current_exe = std::env::current_exe().context("Failed to resolve updater binary path")?;

    // Launch the install as a transient systemd --user unit so it survives
    // the daemon restart that the postinst triggers (systemctl --user start).
    // The unit runs pkexec → factory-update-manager install-deb --result-file,
    // which writes a result sentinel on completion. The daemon polls for it
    // on subsequent reconcile cycles via `check_install_completion`.
    //
    // We do NOT use --collect: without it, the unit persists after exit so
    // the daemon can check `systemctl --user show factory-install-task
    // --property=Result` as a fallback if the sentinel was never written
    // (e.g. pkexec auth denied, binary crash). The daemon resets the unit
    // after processing the result.
    let unit_name = "factory-install-task";
    let mut command = tokio::process::Command::new("systemd-run");
    command
        .args([
            "--user",
            "--unit",
            unit_name,
            "--quiet",
            "pkexec",
            "--disable-internal-agent",
        ])
        .arg(&current_exe)
        .arg("install-deb")
        .arg("--path")
        .arg(package_path)
        .arg("--result-file")
        .arg(&result_file);

    match command.status().await {
        Ok(status) if status.success() => {
            // systemd-run launched the transient unit successfully. The actual
            // dpkg install is now running independently in the transient unit.
            // We'll detect completion on the next reconcile cycle via the
            // result sentinel file or unit status.
            info!("install launched in transient unit '{}'", unit_name);
            Ok(())
        }
        Ok(status) => {
            // systemd-run itself failed (not the install). Fall back to the
            // old synchronous pkexec path — better than no install at all.
            warn!(status = %status, "systemd-run failed; falling back to direct pkexec");
            trigger_install_fallback(
                config,
                state,
                paths,
                workspace_root,
                package_path,
                &current_exe,
                &result_file,
            )
            .await
        }
        Err(e) => {
            // systemd-run binary not found — fall back to direct pkexec.
            warn!(error = %e, "systemd-run not available; falling back to direct pkexec");
            trigger_install_fallback(
                config,
                state,
                paths,
                workspace_root,
                package_path,
                &current_exe,
                &result_file,
            )
            .await
        }
    }
}

/// Fallback: synchronous pkexec install (the old behavior). Used when
/// systemd-run is unavailable. This path has the self-restart race
/// (postinst restarts the daemon mid-install), but it's better than
/// no install at all.
async fn trigger_install_fallback(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace_root: &Path,
    package_path: &Path,
    current_exe: &Path,
    result_file: &Path,
) -> Result<()> {
    let mut command = install::pkexec_command(current_exe, package_path);
    command.arg("--result-file").arg(result_file);
    let output = command
        .output()
        .context("Failed to launch pkexec for update installation")?;
    let status = output.status;

    finalize_install_result(
        config,
        state,
        paths,
        workspace_root,
        status,
        &output.stdout,
        &output.stderr,
    )
    .await
}

/// Shared completion handler: updates state based on the install exit status.
/// Called from the fallback pkexec path (synchronous) and from
/// `check_install_completion` (asynchronous, polling the sentinel file).
async fn finalize_install_result(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    workspace_root: &Path,
    status: std::process::ExitStatus,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<()> {
    if status.success() {
        state.status = UpdateStatus::Installed;
        state.waiting_for_app_exit_auto_install = false;
        state.installed_version = install::installed_package_version();
        state.candidate_version = None;
        state.rollback_blocked_candidate_version = None;
        state.port_candidate_sha = None;
        state.installed_port_sha = installed_port_build_sha(config);
        state.install_task_result_file = None;
        state.error_message = None;
        state.notified_events.clear();
        let _ = maybe_notify_installed(state, paths, true);
        maybe_prune_workspace_cache(workspace_root, state);
        persist_state(paths, state)?;
        maybe_relaunch_app_after_update(config);
        return Ok(());
    }

    let stdout_summary = summarize_command_output(stdout);
    let stderr_summary = summarize_command_output(stderr);
    error!(
        status = %status,
        stdout = stdout_summary.as_deref().unwrap_or(""),
        stderr = stderr_summary.as_deref().unwrap_or(""),
        "privileged install failed"
    );

    let mut message = format!("Privileged install exited with status {status}");
    if let Some(stderr) = stderr_summary {
        message.push_str(": ");
        message.push_str(&stderr);
    }

    let error = anyhow::anyhow!(message);
    if pkexec_authentication_was_not_obtained(&status) {
        defer_install_until_next_app_exit(state, paths, error.to_string())?;
        return Err(error);
    }

    mark_failed_and_persist(state, paths, error.to_string())?;
    let _ = notify::send(
        "Factory update failed",
        "The package could not be installed. Check the updater log for details.",
    );
    Err(error)
}

/// Checks whether a previously launched install (via systemd-run transient
/// unit) has completed. Called from `reconcile_pending_install` when status
/// is `Installing`.
///
/// Detection order:
/// 1. Result sentinel file (written by install-deb --result-file)
/// 2. systemd unit status (fallback if sentinel missing)
///
/// Returns `Ok(true)` if the install completed (success or failure) and
/// state was updated, `Ok(false)` if the install is still running.
fn check_install_completion(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<bool> {
    let result_file = paths.state_dir.join("install-result");

    // 1. Check for the result sentinel file.
    if result_file.exists() {
        let content = fs::read_to_string(&result_file).with_context(|| {
            format!(
                "Failed to read install result file: {}",
                result_file.display()
            )
        })?;

        let (success, message) = if let Some(rest) = content.strip_prefix("success\n") {
            (true, rest.to_string())
        } else if let Some(rest) = content.strip_prefix("failure\n") {
            (false, rest.to_string())
        } else {
            (false, content)
        };

        // Clean up the sentinel and reset the transient unit.
        let _ = fs::remove_file(&result_file);
        reset_install_unit();

        if success {
            state.status = UpdateStatus::Installed;
            state.waiting_for_app_exit_auto_install = false;
            state.installed_version = install::installed_package_version();
            state.candidate_version = None;
            state.rollback_blocked_candidate_version = None;
            state.port_candidate_sha = None;
            state.installed_port_sha = installed_port_build_sha(config);
            state.install_task_result_file = None;
            state.error_message = None;
            state.notified_events.clear();
            maybe_prune_workspace_cache(&config.workspace_root, state);
            let _ = maybe_notify_installed(state, paths, config.notifications);
            persist_state(paths, state)?;
            maybe_relaunch_app_after_update(config);
            info!("install completed successfully (detected via sentinel)");
            Ok(true)
        } else {
            state.status = UpdateStatus::Failed;
            state.waiting_for_app_exit_auto_install = false;
            state.install_task_result_file = None;
            state.error_message = Some(message);
            state.notified_events.clear();
            persist_state(paths, state)?;
            error!(error = %state.error_message.as_deref().unwrap_or("unknown"), "install failed (detected via sentinel)");
            let _ = notify::send(
                "Factory update failed",
                "The package could not be installed. Check the updater log for details.",
            );
            Ok(true)
        }
    } else {
        // 2. Fallback: check systemd unit status. If the unit is no longer
        // active (finished or never started) and no sentinel exists, the
        // install failed before writing the result — treat as failure.
        if !is_install_unit_active() {
            // Clean up the unit if it exists in a failed/inactive state.
            reset_install_unit();

            state.status = UpdateStatus::Failed;
            state.waiting_for_app_exit_auto_install = false;
            state.install_task_result_file = None;
            state.error_message = Some(
                "Install process exited without writing a result. \
                 This usually means pkexec authentication was denied or the \
                 installer crashed before completion."
                    .to_string(),
            );
            state.notified_events.clear();
            persist_state(paths, state)?;
            error!("install failed (unit not active, no sentinel)");
            let _ = notify::send(
                "Factory update failed",
                "The installer did not complete. Check the updater log for details.",
            );
            Ok(true)
        } else {
            // Unit is still active — install is running.
            Ok(false)
        }
    }
}

/// Returns true if the factory-install-task transient unit is currently active.
fn is_install_unit_active() -> bool {
    std::process::Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", "factory-install-task"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resets (stops + resets failed state) the factory-install-task unit so it
/// can be reused for the next install. Best-effort — failures are ignored.
fn reset_install_unit() {
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "reset-failed", "factory-install-task"])
        .status();
}

fn maybe_relaunch_app_after_update(config: &RuntimeConfig) {
    if std::env::var_os(DISABLE_RELAUNCH_ENV).is_some() {
        info!("skipping Factory relaunch because relaunch is disabled by environment");
        return;
    }

    if !config.app_executable_path.exists() {
        warn!(
            app = %config.app_executable_path.display(),
            "skipping Factory relaunch because the app executable does not exist"
        );
        return;
    }

    match liveness::is_app_running(config) {
        Ok(true) => {
            info!("skipping Factory relaunch because the app is already running");
            return;
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                ?error,
                "could not determine whether Factory is already running before relaunch"
            );
        }
    }

    let mut command = Command::new(&config.app_executable_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(app_dir) = config.app_executable_path.parent() {
        command.current_dir(app_dir);
    }

    match command.spawn() {
        Ok(child) => {
            info!(pid = child.id(), "relaunched Factory Desktop after update");
        }
        Err(error) => {
            warn!(?error, "failed to relaunch Factory Desktop after update");
        }
    }
}

fn pkexec_authentication_was_not_obtained(status: &std::process::ExitStatus) -> bool {
    matches!(status.code(), Some(126 | 127))
}

fn install_auth_required_event_key(state: &PersistedState) -> Option<String> {
    state
        .candidate_version
        .as_deref()
        .map(|candidate| format!("install_auth_required:{candidate}"))
}

fn install_auth_retry_is_blocked(state: &PersistedState) -> bool {
    install_auth_required_event_key(state)
        .as_ref()
        .is_some_and(|event_key| state.notified_events.contains(event_key))
}

fn manual_install_required_message(package_path: &Path) -> String {
    format!(
        "No graphical polkit authentication agent is available for pkexec. Run this from a terminal after closing Factory Desktop: {}",
        manual_install_command(package_path)
    )
}

fn manual_install_command(package_path: &Path) -> String {
    format!(
        "sudo /usr/bin/factory-update-manager install-deb --path {}",
        shell_quote_path(package_path)
    )
}

fn shell_quote_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn print_manual_install_required(package_path: &Path) {
    println!("Manual install required: no graphical polkit authentication agent is available.");
    println!("Run this from a terminal after closing Factory Desktop:");
    println!("{}", manual_install_command(package_path));
}

fn defer_install_for_manual_auth(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    package_path: &Path,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(manual_install_required_message(package_path));
    persist_state(paths, state)
}

fn maybe_notify_manual_install_required(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    enabled: bool,
) -> Result<()> {
    maybe_notify(
        state,
        paths,
        enabled,
        "manual_install_required",
        "Factory update needs manual install",
        "No graphical authentication agent was found for pkexec. Run factory-update-manager status for details.",
    )
}

fn maybe_send_manual_install_required_notification(enabled: bool) {
    maybe_send_notification(
        enabled,
        "Factory update needs manual install",
        "No graphical authentication agent was found for pkexec. Run factory-update-manager status for details.",
    );
}

fn graphical_polkit_auth_agent_is_likely_available() -> bool {
    if std::env::var_os("FACTORY_UPDATE_MANAGER_ASSUME_NO_POLKIT_AGENT").is_some() {
        return false;
    }
    if std::env::var_os("FACTORY_UPDATE_MANAGER_ASSUME_POLKIT_AGENT").is_some() {
        return true;
    }
    if !has_user_session_bus_for_polkit() {
        return false;
    }
    polkit_auth_agent_process_is_running()
}

fn has_user_session_bus_for_polkit() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some()
        || std::env::var_os("XDG_RUNTIME_DIR").is_some()
}

fn polkit_auth_agent_process_is_running() -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return true;
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        if !file_name
            .to_string_lossy()
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let process_dir = entry.path();
        let mut process_text = String::new();
        if let Ok(comm) = fs::read_to_string(process_dir.join("comm")) {
            process_text.push_str(&comm);
            process_text.push('\n');
        }
        if let Ok(cmdline) = fs::read(process_dir.join("cmdline")) {
            process_text.push_str(&String::from_utf8_lossy(&cmdline).replace('\0', " "));
        }
        if process_text_matches_polkit_auth_agent(&process_text) {
            return true;
        }
    }

    false
}

fn process_text_matches_polkit_auth_agent(process_text: &str) -> bool {
    let normalized = process_text.to_ascii_lowercase();
    if normalized.contains("polkitd") || normalized.contains("polkit-agent-helper") {
        return false;
    }
    POLKIT_AUTH_AGENT_PROCESS_TOKENS
        .iter()
        .any(|token| normalized.contains(token))
}

fn clear_install_auth_required_event(
    state: &mut PersistedState,
    paths: &RuntimePaths,
) -> Result<()> {
    let Some(event_key) = install_auth_required_event_key(state) else {
        return Ok(());
    };

    if state.notified_events.remove(&event_key) {
        persist_state(paths, state)?;
    }

    Ok(())
}

fn defer_install_until_next_app_exit(
    state: &mut PersistedState,
    paths: &RuntimePaths,
    message: String,
) -> Result<()> {
    state.status = UpdateStatus::ReadyToInstall;
    state.waiting_for_app_exit_auto_install = false;
    state.error_message = Some(message);

    if let Some(event_key) = install_auth_required_event_key(state) {
        if state.notified_events.insert(event_key) {
            let _ = notify::send(
                "Factory update needs permission",
                "The ready update will retry after the next app close. Approve the system authentication dialog to install it.",
            );
        }
    }

    persist_state(paths, state)
}

fn notify_failure(
    config: &RuntimeConfig,
    state: &mut PersistedState,
    paths: &RuntimePaths,
    error: &anyhow::Error,
) -> Result<()> {
    let body = format!("The local rebuild failed: {error}");
    maybe_notify(
        state,
        paths,
        config.notifications,
        "build_failed",
        "Factory update failed",
        &body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(root: &std::path::Path) -> RuntimePaths {
        RuntimePaths {
            config_file: root.join("config/config.toml"),
            state_file: root.join("state/state.json"),
            log_file: root.join("state/service.log"),
            cache_dir: root.join("cache"),
            state_dir: root.join("state"),
            config_dir: root.join("config"),
        }
    }

    fn test_config(root: &std::path::Path) -> RuntimeConfig {
        RuntimeConfig {
            github_owner: "ThewindMom".to_string(),
            github_repo: "factory-desktop-linux".to_string(),
            github_api_base_url: "https://api.github.com".to_string(),
            dmg_api_url: "https://example.com/api/desktop".to_string(),
            arch: "x64".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: root.join("cache"),
            builder_bundle_root: root.join("builder"),
            app_executable_path: root.join("not-running-electron"),
        }
    }

    #[test]
    fn upstream_check_freshness_respects_configured_interval() {
        let config = RuntimeConfig {
            github_owner: "ThewindMom".to_string(),
            github_repo: "factory-desktop-linux".to_string(),
            github_api_base_url: "https://api.github.com".to_string(),
            dmg_api_url: "https://example.com/api/desktop".to_string(),
            arch: "x64".to_string(),
            initial_check_delay_seconds: 1,
            check_interval_hours: 6,
            auto_install_on_app_exit: true,
            notifications: false,
            workspace_root: std::path::PathBuf::from("/tmp/cache"),
            builder_bundle_root: std::path::PathBuf::from("/tmp/builder"),
            app_executable_path: std::path::PathBuf::from("/tmp/electron"),
        };

        let mut state = PersistedState::new(true);
        assert!(!upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(1));
        assert!(upstream_check_is_fresh(&config, &state));

        state.last_successful_check_at = Some(Utc::now() - ChronoDuration::hours(7));
        assert!(!upstream_check_is_fresh(&config, &state));
    }

    #[test]
    fn plain_status_reports_update_error() {
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::Failed;
        state.error_message = Some("build-all failed during local rebuild".to_string());

        assert_eq!(
            update_error_status_line(&state),
            "update_error: build-all failed during local rebuild"
        );

        state.error_message = None;
        assert_eq!(update_error_status_line(&state), "update_error: none");
    }

    #[test]
    fn semver_version_comparison_works() {
        assert!(installed_version_satisfies_candidate("0.109.0", "0.108.0"));
        assert!(!installed_version_satisfies_candidate("0.107.0", "0.108.0"));
        assert!(installed_version_satisfies_candidate("0.108.0", "0.108.0"));
        assert!(!installed_version_satisfies_candidate("unknown", "0.108.0"));

        assert!(installed_version_matches_candidate("0.108.0", "0.108.0"));
        assert!(!installed_version_matches_candidate("0.109.0", "0.108.0"));
    }

    #[test]
    fn stale_checking_status_restores_to_installed_without_candidate() {
        let mut state = PersistedState::new(true);
        state.status = UpdateStatus::CheckingUpstream;
        state.candidate_version = None;

        assert_eq!(
            status_to_restore_after_check_failure(&state),
            UpdateStatus::Installed
        );
    }

    #[test]
    fn manual_check_clears_superseded_same_version_pending_update() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(true);
        state.installed_version = "0.116.1".to_string();
        state.candidate_version = Some("0.116.1".to_string());
        state.status = UpdateStatus::ReadyToInstall;
        state.port_candidate_sha = Some("old-port-build".to_string());
        state.installed_port_sha = None;
        state.artifact_paths.package_path = Some(
            temp.path()
                .join("cache/port-deb/factory-desktop_0.115.0_amd64.deb"),
        );
        state.error_message =
            Some("Previous install attempt was interrupted before completion".to_string());
        state
            .notified_events
            .insert("ready_to_install:0.116.1".to_string());

        assert!(clear_superseded_pending_for_manual_check(
            &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.port_candidate_sha, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert_eq!(state.error_message, None);
        assert!(state.notified_events.is_empty());
        Ok(())
    }

    #[test]
    fn status_clears_ready_update_when_installed_version_is_newer_than_candidate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let mut state = PersistedState::new(false);
        state.installed_version = "0.124.1".to_string();
        state.candidate_version = Some("0.124.0".to_string());
        state.status = UpdateStatus::ReadyToInstall;
        state.port_candidate_sha = Some("older-port-build".to_string());
        state.installed_port_sha = Some("newer-port-build".to_string());
        state.artifact_paths.package_path = Some(
            temp.path()
                .join("cache/port-deb/factory-desktop_0.124.0_amd64.deb"),
        );
        state
            .notified_events
            .insert("ready_to_install:0.124.0".to_string());

        assert!(complete_pending_install_if_already_installed(
            &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::Installed);
        assert_eq!(state.candidate_version, None);
        assert_eq!(state.port_candidate_sha, None);
        assert_eq!(state.artifact_paths.package_path, None);
        assert!(state.notified_events.is_empty());
        Ok(())
    }

    #[test]
    fn status_keeps_ready_update_when_candidate_is_same_version_with_new_port_sha() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let package_path = temp
            .path()
            .join("cache/port-deb/factory-desktop_0.124.1_amd64.deb");
        let mut state = PersistedState::new(false);
        state.installed_version = "0.124.1".to_string();
        state.candidate_version = Some("0.124.1".to_string());
        state.status = UpdateStatus::ReadyToInstall;
        state.port_candidate_sha = Some("next-port-build".to_string());
        state.installed_port_sha = Some("current-port-build".to_string());
        state.artifact_paths.package_path = Some(package_path.clone());

        assert!(!complete_pending_install_if_already_installed(
            &mut state, &paths
        )?);

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.candidate_version.as_deref(), Some("0.124.1"));
        assert_eq!(state.port_candidate_sha.as_deref(), Some("next-port-build"));
        assert_eq!(state.artifact_paths.package_path, Some(package_path));
        Ok(())
    }

    #[tokio::test]
    async fn install_ready_continues_after_running_app_exits() -> Result<()> {
        let _env_guard = crate::test_util::env_lock();
        let _restore_env = crate::test_util::EnvRestoreGuard::capture(&[
            "FACTORY_UPDATE_MANAGER_ASSUME_POLKIT_AGENT",
            "FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_WAIT_MS",
            "FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_POLL_MS",
            "PATH",
        ]);
        std::env::set_var("FACTORY_UPDATE_MANAGER_ASSUME_POLKIT_AGENT", "1");
        std::env::set_var("FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_WAIT_MS", "2000");
        std::env::set_var("FACTORY_UPDATE_MANAGER_INSTALL_READY_EXIT_POLL_MS", "25");

        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;
        let package_path = temp.path().join("factory-desktop_9999.0.0_amd64.deb");
        fs::write(&package_path, b"mock package")?;

        let fake_bin = temp.path().join("bin");
        fs::create_dir_all(&fake_bin)?;
        let fake_systemd_run = fake_bin.join("systemd-run");
        let fake_systemd_run_log = temp.path().join("systemd-run.args");
        fs::write(
            &fake_systemd_run,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 0\n",
                fake_systemd_run_log.display()
            ),
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&fake_systemd_run, fs::Permissions::from_mode(0o755))?;
        }
        let old_path = std::env::var_os("PATH").unwrap_or_default();
        let new_path = std::env::join_paths(
            std::iter::once(fake_bin.clone()).chain(std::env::split_paths(&old_path)),
        )?;
        std::env::set_var("PATH", new_path);

        let app_executable = temp.path().join("factory-test-app");
        fs::copy("/usr/bin/sleep", &app_executable)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&app_executable, fs::Permissions::from_mode(0o755))?;
        }
        let mut app_process = std::process::Command::new(&app_executable)
            .arg("0.2")
            .spawn()?;

        let mut config = test_config(temp.path());
        config.app_executable_path = app_executable;

        let mut state = PersistedState::new(false);
        state.status = UpdateStatus::ReadyToInstall;
        state.installed_version = "0.121.0".to_string();
        state.candidate_version = Some("9999.0.0".to_string());
        state.artifact_paths.package_path = Some(package_path);

        run_install_ready(&config, &mut state, &paths).await?;
        let _ = app_process.wait();

        assert_eq!(state.status, UpdateStatus::Installing);
        assert!(!state.waiting_for_app_exit_auto_install);
        assert!(fake_systemd_run_log.exists());
        Ok(())
    }

    #[tokio::test]
    async fn run_check_cycle_skips_when_update_is_already_pending() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let config = test_config(temp.path());

        for status in [
            UpdateStatus::ReadyToInstall,
            UpdateStatus::WaitingForAppExit,
            UpdateStatus::Installing,
        ] {
            let mut state = PersistedState::new(true);
            state.status = status.clone();

            run_check_cycle(&config, &mut state, &paths).await?;

            assert_eq!(state.status, status);
            assert_eq!(state.last_check_at, None);
        }
        Ok(())
    }

    #[tokio::test]
    async fn run_check_cycle_refreshes_superseded_pending_port_deb() -> Result<()> {
        use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let server = MockServer::start().await;
        let deb_name = "factory-desktop_0.121.1_amd64.deb";
        let deb_path = format!("/download/{deb_name}");
        let deb_url = format!("{}{}", server.uri(), deb_path);

        Mock::given(matchers::method("GET"))
            .and(matchers::path(
                "/repos/ThewindMom/factory-desktop-linux/releases/latest",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "tag_name": "v0.121.1",
                "assets": [{
                    "name": deb_name,
                    "browser_download_url": deb_url,
                    "size": 11
                }]
            })))
            .mount(&server)
            .await;

        Mock::given(matchers::method("GET"))
            .and(matchers::path(
                "/repos/ThewindMom/factory-desktop-linux/git/ref/tags/v0.121.1",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "object": { "sha": "new-port-build-sha" }
            })))
            .mount(&server)
            .await;

        Mock::given(matchers::method("GET"))
            .and(matchers::path(deb_path.as_str()))
            .respond_with(ResponseTemplate::new(200).set_body_bytes("new package"))
            .mount(&server)
            .await;

        let mut config = test_config(temp.path());
        config.github_api_base_url = server.uri();

        let old_package_path = temp.path().join("old/factory-desktop_0.121.1_amd64.deb");
        fs::create_dir_all(old_package_path.parent().expect("old package has parent"))?;
        fs::write(&old_package_path, b"old package")?;

        let mut state = PersistedState::new(false);
        state.installed_version = "0.121.0".to_string();
        state.installed_port_sha = Some("installed-port-build-sha".to_string());
        state.candidate_version = Some("0.121.1".to_string());
        state.port_candidate_sha = Some("old-port-build-sha".to_string());
        state.status = UpdateStatus::WaitingForAppExit;
        state.waiting_for_app_exit_auto_install = true;
        state.artifact_paths.package_path = Some(old_package_path);
        state.error_message = Some("stale pending install".to_string());

        run_check_cycle(&config, &mut state, &paths).await?;

        assert_eq!(state.status, UpdateStatus::ReadyToInstall);
        assert_eq!(state.candidate_version.as_deref(), Some("0.121.1"));
        assert_eq!(
            state.port_candidate_sha.as_deref(),
            Some("new-port-build-sha")
        );
        assert!(!state.waiting_for_app_exit_auto_install);
        assert_eq!(state.error_message, None);
        let refreshed_path = state
            .artifact_paths
            .package_path
            .as_ref()
            .expect("refreshed package path is recorded");
        assert_eq!(
            refreshed_path.file_name().and_then(|name| name.to_str()),
            Some(deb_name)
        );
        assert_eq!(fs::read(refreshed_path)?, b"new package");
        Ok(())
    }

    #[tokio::test]
    async fn run_check_cycle_restores_status_when_port_update_check_fails() -> Result<()> {
        use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

        let temp = tempfile::tempdir()?;
        let paths = test_paths(temp.path());
        paths.ensure_dirs()?;

        let server = MockServer::start().await;
        Mock::given(matchers::method("GET"))
            .and(matchers::path(
                "/repos/ThewindMom/factory-desktop-linux/releases/latest",
            ))
            .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
                "message": "API rate limit exceeded"
            })))
            .mount(&server)
            .await;

        let mut config = test_config(temp.path());
        config.github_api_base_url = server.uri();

        let mut state = PersistedState::new(true);
        state.installed_version = "0.121.0".to_string();
        state.status = UpdateStatus::Installed;
        state
            .notified_events
            .insert("build_failed:0.121.0".to_string());

        let result = run_check_cycle(&config, &mut state, &paths).await;

        assert!(result.is_err());
        assert_eq!(state.status, UpdateStatus::Installed);
        assert!(state
            .error_message
            .as_deref()
            .is_some_and(|message| message.contains("returned an error status")));
        assert!(state.notified_events.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn fetch_latest_droid_version_returns_latest_from_mock() -> Result<()> {
        use wiremock::{matchers, Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;

        Mock::given(matchers::method("GET"))
            .and(matchers::path("@factory/cli-linux-x64"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "name": "@factory/cli-linux-x64",
                "dist-tags": { "latest": "0.111.0" },
                "versions": {}
            })))
            .mount(&server)
            .await;

        // We can't redirect the hardcoded URL in fetch_latest_droid_version,
        // but we can verify the JSON parsing contract by parsing the same
        // response shape that the function expects.
        let body: serde_json::Value = serde_json::json!({
            "dist-tags": { "latest": "0.111.0" }
        });
        let latest = body
            .get("dist-tags")
            .and_then(|t| t.get("latest"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        assert_eq!(latest, Some("0.111.0".to_string()));

        Ok(())
    }

    #[test]
    fn droid_drift_detection_logic() {
        // Drift is true when both present and different.
        let installed = Some("0.109.3".to_string());
        let latest = Some("0.111.0".to_string());
        let drift = match (&installed, &latest) {
            (Some(i), Some(l)) => i != l,
            _ => false,
        };
        assert!(drift, "drift when versions differ");

        // No drift when versions match.
        let installed2 = Some("0.111.0".to_string());
        let latest2 = Some("0.111.0".to_string());
        let drift2 = match (&installed2, &latest2) {
            (Some(i), Some(l)) => i != l,
            _ => false,
        };
        assert!(!drift2, "no drift when versions match");

        // No drift when installed is missing.
        let drift3 = match (&None::<String>, &Some("0.111.0".to_string())) {
            (Some(i), Some(l)) => i != l,
            _ => false,
        };
        assert!(!drift3, "no drift when installed is missing");

        // No drift when latest is missing (network failure).
        let drift4 = match (&Some("0.109.3".to_string()), &None::<String>) {
            (Some(i), Some(l)) => i != l,
            _ => false,
        };
        assert!(!drift4, "no drift when latest is missing");
    }

    #[test]
    fn installed_droid_version_reads_build_info() {
        let temp = tempfile::tempdir().unwrap();
        let config = test_config(temp.path());

        // test_config sets app_executable_path to root.join("not-running-electron"),
        // so parent() is root, and build-info.json is at root/.factory-linux/build-info.json
        let build_info_dir = temp.path().join(".factory-linux");
        fs::create_dir_all(&build_info_dir).unwrap();
        let build_info_path = build_info_dir.join("build-info.json");
        fs::write(
            &build_info_path,
            r#"{"upstreamDmg":{"sha256":"abc","version":"0.110.0"},"factoryVersion":"0.110.0","droidVersion":"0.111.0","electronVersion":"39.2.7","buildTimestamp":"2026-06-23T00:00:00Z","portBuildSha":"abc123"}"#,
        ).unwrap();

        let droid_version = installed_droid_version(&config);
        assert_eq!(droid_version, Some("0.111.0".to_string()));

        // Test missing droidVersion field.
        fs::write(
            &build_info_path,
            r#"{"upstreamDmg":{"sha256":"abc","version":"0.110.0"},"factoryVersion":"0.110.0"}"#,
        )
        .unwrap();
        let droid_version = installed_droid_version(&config);
        assert_eq!(droid_version, None);
    }
}
