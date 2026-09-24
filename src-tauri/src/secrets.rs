//! Shared secret storage: OS keychain in release builds, a private JSON file in dev.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, Once};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Keychain,
    DevFile,
}

pub fn backend() -> Backend {
    match std::env::var("ADVERSARIA_SECRET_STORE").as_deref() {
        Ok("keychain") => Backend::Keychain,
        Ok("file") => Backend::DevFile,
        _ if cfg!(debug_assertions) => Backend::DevFile,
        _ => Backend::Keychain,
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Store {
    Keychain,
    DevFile(PathBuf),
}

type Cache = HashMap<(Store, String, String), Option<String>>;

#[derive(Default)]
struct State {
    cache: Cache,
    // Remember failed and missing lookups too, even if persisting a migrated
    // value fails, so a key is only queried once per process for migration.
    migrations: HashMap<(String, String), Option<String>>,
}

// Hold the same lock through cache lookup, backend I/O, and cache updates, so
// concurrent writers cannot lose entries or leave a stale cached result.
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
static DEV_NOTICE: Once = Once::new();

#[cfg(not(test))]
fn keychain_get(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(service, account).map_err(|e| format!("keyring open: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read: {e}")),
    }
}

#[cfg(test)]
type KeychainLookup = fn(&str, &str) -> Result<Option<String>, String>;

// Tests always start with a harmless missing-entry lookup; they can inject
// values or failures without ever constructing a real keychain entry.
#[cfg(test)]
static KEYCHAIN_LOOKUP: Mutex<KeychainLookup> = Mutex::new(|_, _| Ok(None));

#[cfg(test)]
fn keychain_get(service: &str, account: &str) -> Result<Option<String>, String> {
    let lookup = *KEYCHAIN_LOOKUP.lock().unwrap();
    lookup(service, account)
}

fn store() -> Store {
    match backend() {
        Backend::Keychain => Store::Keychain,
        Backend::DevFile => {
            let path = crate::config::app_data_dir().join("dev-secrets.json");
            DEV_NOTICE.call_once(|| {
                eprintln!(
                    "[secrets] dev build: using {} instead of the OS keychain (set ADVERSARIA_SECRET_STORE=keychain to override)",
                    path.display()
                );
            });
            Store::DevFile(path)
        }
    }
}

pub fn get(service: &str, account: &str) -> Result<Option<String>, String> {
    let mut state = STATE.lock().map_err(|e| format!("secrets lock: {e}"))?;
    let store = store();
    let key = (store.clone(), service.to_string(), account.to_string());
    if let Some(value) = state.cache.get(&key) {
        return Ok(value.clone());
    }
    let value = match store {
        Store::Keychain => keychain_get(service, account)?,
        Store::DevFile(path) => {
            let mut values = read_file(&path)?;
            let file_key = format!("{service}/{account}");
            if let Some(value) = values.get(&file_key) {
                Some(value.clone())
            } else {
                let migrated = state
                    .migrations
                    .entry((service.to_string(), account.to_string()))
                    .or_insert_with(|| keychain_get(service, account).ok().flatten())
                    .clone();
                if let Some(value) = &migrated {
                    values.insert(file_key, value.clone());
                    write_file(&path, &values)?;
                    eprintln!("[secrets] migrated {service}/{account} from the keychain");
                }
                migrated
            }
        }
    };
    state.cache.insert(key, value.clone());
    Ok(value)
}

pub fn set(service: &str, account: &str, value: &str) -> Result<(), String> {
    let mut state = STATE.lock().map_err(|e| format!("secrets lock: {e}"))?;
    let store = store();
    match &store {
        Store::Keychain => {
            let entry =
                keyring::Entry::new(service, account).map_err(|e| format!("keyring open: {e}"))?;
            entry
                .set_password(value)
                .map_err(|e| format!("keyring write: {e}"))?;
        }
        Store::DevFile(path) => {
            let mut values = read_file(path)?;
            values.insert(format!("{service}/{account}"), value.to_string());
            write_file(path, &values)?;
        }
    }
    state.cache.insert(
        (store, service.to_string(), account.to_string()),
        Some(value.to_string()),
    );
    Ok(())
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    let mut state = STATE.lock().map_err(|e| format!("secrets lock: {e}"))?;
    let store = store();
    match &store {
        Store::Keychain => {
            let entry =
                keyring::Entry::new(service, account).map_err(|e| format!("keyring open: {e}"))?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("keyring delete: {e}")),
            }
        }
        Store::DevFile(path) => {
            let mut values = read_file(path)?;
            if values.remove(&format!("{service}/{account}")).is_some() {
                write_file(path, &values)?;
            }
        }
    }
    state
        .cache
        .insert((store, service.to_string(), account.to_string()), None);
    Ok(())
}

fn read_file(path: &Path) -> Result<HashMap<String, String>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("dev secrets parse at {}: {e}", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(HashMap::new()),
        Err(e) => Err(format!("dev secrets read at {}: {e}", path.display())),
    }
}

fn write_file(path: &Path, values: &HashMap<String, String>) -> Result<(), String> {
    let parent = path.parent().expect("dev secrets path has a parent");
    let temp = parent.join(format!(".dev-secrets-{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> Result<(), String> {
        fs::create_dir_all(parent).map_err(|e| format!("dev secrets directory: {e}"))?;
        let bytes =
            serde_json::to_vec(values).map_err(|e| format!("dev secrets serialize: {e}"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|e| format!("dev secrets create: {e}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("dev secrets write: {e}"))?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| format!("dev secrets replace: {e}"))
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static LOOKUPS: AtomicUsize = AtomicUsize::new(0);

    pub(crate) fn mock_keychain(lookup: KeychainLookup) {
        *KEYCHAIN_LOOKUP.lock().unwrap() = lookup;
    }

    // Each test runs alone in a subprocess with its own environment and cache.
    // Never mutate the environment of the parallel, full-crate test runner.
    pub(crate) fn with_store(test: impl FnOnce(&Path)) {
        let name = std::thread::current().name().unwrap().to_string();
        if std::env::var("ADVERSARIA_SECRETS_TEST").as_deref() == Ok(&name) {
            let dir = PathBuf::from(std::env::var_os("ADVERSARIA_DATA_DIR").unwrap());
            assert!(dir.starts_with(std::env::temp_dir()));
            assert_eq!(crate::config::app_data_dir(), dir);
            assert_eq!(backend(), Backend::DevFile);
            test(&dir.join("dev-secrets.json"));
            return;
        }
        let dir = std::env::temp_dir().join(format!("adversaria-secrets-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env("ADVERSARIA_DATA_DIR", &dir)
            .env("ADVERSARIA_SECRET_STORE", "file")
            .env("ADVERSARIA_SECRETS_TEST", &name)
            .output()
            .unwrap();
        fs::remove_dir_all(dir).unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn set_get_delete_round_trip() {
        with_store(|path| {
            set("service", "account", "secret\n雪").unwrap();
            set("other", "account", "independent").unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("secret\n雪")
            );
            assert_eq!(read_file(path).unwrap()["service/account"], "secret\n雪");
            delete("service", "account").unwrap();
            assert_eq!(get("service", "account").unwrap(), None);
            assert!(!read_file(path).unwrap().contains_key("service/account"));
            assert_eq!(
                get("other", "account").unwrap().as_deref(),
                Some("independent")
            );
            assert_eq!(read_file(path).unwrap()["other/account"], "independent");
        });
    }

    #[test]
    fn get_missing_returns_none() {
        with_store(|path| {
            assert_eq!(get("service", "missing").unwrap(), None);
            assert!(!path.exists());
            fs::write(path, br#"{"service/missing":"external"}"#).unwrap();
            assert_eq!(get("service", "missing").unwrap(), None);
        });
    }

    #[test]
    fn delete_missing_succeeds() {
        with_store(|path| {
            delete("service", "missing").unwrap();
            assert!(!path.exists());
            set("service", "present", "value").unwrap();
            delete("service", "missing").unwrap();
            assert_eq!(read_file(path).unwrap()["service/present"], "value");
        });
    }

    #[test]
    fn cache_wins_until_set() {
        with_store(|path| {
            set("service", "account", "cached").unwrap();
            fs::write(path, br#"{"service/account":"external"}"#).unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("cached")
            );
            set("service", "account", "updated").unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("updated")
            );
            assert_eq!(read_file(path).unwrap()["service/account"], "updated");
        });
    }

    #[test]
    fn get_caches_a_value_loaded_from_disk() {
        with_store(|path| {
            fs::write(path, br#"{"service/account":"loaded"}"#).unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("loaded")
            );
            fs::write(path, b"invalid json").unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("loaded")
            );
            assert!(set("service", "account", "replacement").is_err());
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("loaded")
            );
            assert_eq!(fs::read(path).unwrap(), b"invalid json");
        });
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_is_private_after_creation_and_replacement() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        with_store(|path| {
            set("service", "account", "first").unwrap();
            let original = fs::metadata(path).unwrap();
            assert_eq!(original.permissions().mode() & 0o777, 0o600);
            fs::set_permissions(path, fs::Permissions::from_mode(0o644)).unwrap();
            set("service", "account", "second").unwrap();
            let replaced = fs::metadata(path).unwrap();
            assert_eq!(replaced.permissions().mode() & 0o777, 0o600);
            assert_ne!(
                original.ino(),
                replaced.ino(),
                "writes must replace the file"
            );
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        });
    }

    #[test]
    fn concurrent_writes_preserve_all_accounts() {
        with_store(|path| {
            std::thread::scope(|scope| {
                for i in 0..16 {
                    scope.spawn(move || set("service", &i.to_string(), "value").unwrap());
                }
            });
            assert_eq!(read_file(path).unwrap().len(), 16);
        });
    }

    #[test]
    fn migration_persists_the_value_and_preserves_other_entries() {
        with_store(|path| {
            set("other", "account", "keep").unwrap();
            mock_keychain(|service, account| {
                assert_eq!((service, account), ("service", "account"));
                LOOKUPS.fetch_add(1, Ordering::SeqCst);
                Ok(Some("migrated secret\n雪".into()))
            });
            for _ in 0..2 {
                assert_eq!(
                    get("service", "account").unwrap().as_deref(),
                    Some("migrated secret\n雪")
                );
            }
            let values = read_file(path).unwrap();
            assert_eq!(values["service/account"], "migrated secret\n雪");
            assert_eq!(values["other/account"], "keep");
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);

            // A fresh process will read the migrated entry without consulting
            // the keychain. Clearing both caches simulates that cold start.
            *STATE.lock().unwrap() = State::default();
            mock_keychain(|_, _| panic!("a migrated file entry must win"));
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("migrated secret\n雪")
            );
            delete("service", "account").unwrap();
            assert_eq!(get("service", "account").unwrap(), None);
        });
    }

    #[test]
    fn existing_file_entries_never_trigger_migration() {
        with_store(|path| {
            let bytes = br#"{"service/account":"local","service/empty":""}"#;
            fs::write(path, bytes).unwrap();
            mock_keychain(|_, _| panic!("existing values must not be overwritten"));
            assert_eq!(get("service", "account").unwrap().as_deref(), Some("local"));
            assert_eq!(get("service", "empty").unwrap().as_deref(), Some(""));
            assert_eq!(fs::read(path).unwrap(), bytes);
        });
    }

    #[test]
    fn missing_keychain_entry_is_only_queried_once() {
        with_store(|path| {
            mock_keychain(|_, _| {
                LOOKUPS.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            });
            assert_eq!(get("service", "account").unwrap(), None);
            assert_eq!(get("service", "account").unwrap(), None);
            STATE.lock().unwrap().cache.clear();
            assert_eq!(get("service", "account").unwrap(), None);
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
            assert!(!path.exists());
        });
    }

    #[test]
    fn keychain_open_and_read_errors_do_not_fail_or_repeat_migration() {
        with_store(|path| {
            mock_keychain(|_, account| {
                LOOKUPS.fetch_add(1, Ordering::SeqCst);
                Err(format!("keyring {account}: unavailable"))
            });
            for _ in 0..2 {
                for account in ["open", "read"] {
                    assert_eq!(get("service", account).unwrap(), None);
                }
            }
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 2);
            assert!(!path.exists());
            set("service", "read", "manually saved").unwrap();
            assert_eq!(
                get("service", "read").unwrap().as_deref(),
                Some("manually saved")
            );
        });
    }

    #[test]
    fn migration_write_failure_retries_persistence_without_another_lookup() {
        with_store(|path| {
            mock_keychain(|_, _| {
                LOOKUPS.fetch_add(1, Ordering::SeqCst);
                // The lookup succeeds, but the atomic replacement cannot.
                fs::create_dir(crate::config::app_data_dir().join("dev-secrets.json")).unwrap();
                Ok(Some("keep this key".into()))
            });
            assert!(get("service", "account")
                .unwrap_err()
                .starts_with("dev secrets replace:"));
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
            fs::remove_dir(path).unwrap();
            assert_eq!(
                get("service", "account").unwrap().as_deref(),
                Some("keep this key")
            );
            assert_eq!(read_file(path).unwrap()["service/account"], "keep this key");
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn concurrent_migration_looks_up_each_key_once() {
        with_store(|path| {
            mock_keychain(|service, account| {
                LOOKUPS.fetch_add(1, Ordering::SeqCst);
                Ok(Some(format!("{service}:{account}")))
            });
            std::thread::scope(|scope| {
                for _ in 0..16 {
                    scope.spawn(|| {
                        assert_eq!(
                            get("service", "account").unwrap().as_deref(),
                            Some("service:account")
                        );
                    });
                }
            });
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 1);
            assert_eq!(
                get("other", "account").unwrap().as_deref(),
                Some("other:account")
            );
            assert_eq!(LOOKUPS.load(Ordering::SeqCst), 2);
            assert_eq!(read_file(path).unwrap().len(), 2);
        });
    }

    #[test]
    fn backend_selection_from_env() {
        with_store(|_| {
            std::env::set_var("ADVERSARIA_SECRET_STORE", "keychain");
            assert_eq!(backend(), Backend::Keychain);
            std::env::set_var("ADVERSARIA_SECRET_STORE", "file");
            assert_eq!(backend(), Backend::DevFile);
            let default = if cfg!(debug_assertions) {
                Backend::DevFile
            } else {
                Backend::Keychain
            };
            std::env::remove_var("ADVERSARIA_SECRET_STORE");
            assert_eq!(backend(), default);
            std::env::set_var("ADVERSARIA_SECRET_STORE", "unknown");
            assert_eq!(backend(), default);
        });
    }
}
