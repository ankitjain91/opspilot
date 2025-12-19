// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        use std::env;
        if let Ok(path) = env::var("PATH") {
            // Append common paths for brew/local binaries which are often missing in launchd environment
            let new_path = format!("/opt/homebrew/bin:/usr/local/bin:{}:/usr/bin:/bin:/usr/sbin:/sbin", path);
            env::set_var("PATH", new_path);
        } else {
             // Fallback if PATH is somehow missing completely
            env::set_var("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        }
    }
    opspilot::run()
}
