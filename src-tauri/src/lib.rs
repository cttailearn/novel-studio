mod android_install;
mod files;
mod llm;
mod secure;
mod sqlite;
mod update;

use std::io;
use std::path::PathBuf;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // 便携/测试模式：允许把数据目录指到任意可写位置。
            // 正常启动仍用系统标准的 app_data_dir。
            let data_dir = match std::env::var_os("NOVEL_STUDIO_DATA_DIR") {
                Some(path) => PathBuf::from(path),
                None => app.path().app_data_dir()?,
            };
            eprintln!("[tauri] data_dir={}", data_dir.display());
            std::fs::create_dir_all(&data_dir).map_err(|error| {
                eprintln!("[tauri] create_dir_all 失败：{error}");
                error
            })?;
            let db_path = data_dir.join("novel-studio.sqlite3");
            eprintln!("[tauri] db_path={}", db_path.display());
            let store = sqlite::SqliteStore::open(&db_path).map_err(|error| {
                eprintln!("[tauri] 打开 SQLite 失败：{error}");
                io::Error::other(format!("打开 SQLite 失败：{error}"))
            })?;
            eprintln!("[tauri] SQLite 已打开");
            app.manage(store);
            app.manage(llm::ProxyState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            llm::proxy_stream,
            llm::proxy_abort,
            llm::proxy_active,
            sqlite::sqlite_load,
            sqlite::sqlite_stores,
            sqlite::sqlite_indexes,
            sqlite::sqlite_create_store,
            sqlite::sqlite_create_index,
            sqlite::sqlite_apply,
            sqlite::sqlite_import,
            sqlite::sqlite_wipe,
            sqlite::sqlite_stats,
            sqlite::sqlite_path,
            sqlite::sqlite_backup,
            secure::secure_available,
            secure::secure_get,
            secure::secure_set,
            secure::secure_delete,
            files::save_text_file,
            files::save_binary_file,
            files::open_text_file,
            update::app_version,
            update::update_check,
            update::update_install,
            android_install::android_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
