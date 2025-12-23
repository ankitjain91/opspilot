use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use chrono::Local;
use std::env;

static LOG_FILE_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn get_log_path() -> &'static Mutex<Option<PathBuf>> {
    LOG_FILE_PATH.get_or_init(|| Mutex::new(None))
}

/// Initialize the logger, setting up the log directory and file.
pub fn init_logger() -> Result<PathBuf, String> {
    let home = env::var("HOME").or_else(|_| env::var("USERPROFILE"))
        .map_err(|_| "Could not find home directory")?;

    let log_dir = PathBuf::from(home).join(".opspilot").join("logs");

    if !log_dir.exists() {
        fs::create_dir_all(&log_dir)
            .map_err(|e| format!("Failed to create log dir: {}", e))?;
    }

    let log_file = log_dir.join("opspilot.log");

    // Rotation: If file exists and is large (>5MB), rename it
    if log_file.exists() {
        if let Ok(metadata) = fs::metadata(&log_file) {
            if metadata.len() > 5 * 1024 * 1024 {
                let timestamp = Local::now().format("%Y%m%d_%H%M%S");
                let rotated = log_dir.join(format!("opspilot_{}.log", timestamp));
                let _ = fs::rename(&log_file, &rotated);

                // Cleanup old logs (keep last 5)
                cleanup_old_logs(&log_dir);
            }
        }
    }

    *get_log_path().lock().unwrap() = Some(log_file.clone());

    // Write init message
    log_to_file("system", "INFO", "Logger initialized");

    Ok(log_file)
}

fn cleanup_old_logs(log_dir: &PathBuf) {
    if let Ok(entries) = fs::read_dir(log_dir) {
        let mut logs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map_or(false, |ext| ext == "log") &&
                        p.file_stem().map_or(false, |s| s.to_string_lossy().starts_with("opspilot_")))
            .collect();

        logs.sort(); // Sorts by timestamp in name

        // Remove all but last 5
        if logs.len() > 5 {
            for log in logs.iter().take(logs.len() - 5) {
                let _ = fs::remove_file(log);
            }
        }
    }
}

/// Write a log entry to the file
pub fn log_to_file(category: &str, level: &str, message: &str) {
    let path_guard = get_log_path().lock().unwrap();
    if let Some(path) = path_guard.as_ref() {
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
        let line = format!("[{}] [{}] [{}] {}\n", timestamp, level, category, message);

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// Command exposed to frontend to save logs
#[tauri::command]
pub fn log_frontend_message(level: String, category: String, message: String, data: Option<serde_json::Value>) {
    let msg = if let Some(d) = data {
        format!("{} | {}", message, d)
    } else {
        message
    };
    log_to_file(&category, &level.to_uppercase(), &msg);
}
