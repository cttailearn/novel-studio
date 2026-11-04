//! 桌面端应用内更新。
//!
//! 更新清单（latest.json）由发布流水线生成，安装包使用 Tauri 的 minisign
//! 签名校验后再交给系统安装器。这里只做三件事：报版本、查更新、下载安装。
//! Android/iOS 没有 Tauri updater 支持，命令会明确返回错误，由前端改走
//! 「打开发布页手动装 APK」的路径，而不是假装能原地更新。

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<i64>,
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;

        let current_version = env!("CARGO_PKG_VERSION").to_string();
        let update = app
            .updater()
            .map_err(|error| format!("初始化更新器失败：{error}"))?
            .check()
            .await
            .map_err(|error| format!("检查更新失败：{error}"))?;

        let Some(update) = update else {
            return Ok(UpdateInfo {
                available: false,
                current_version,
                version: None,
                notes: None,
                date: None,
            });
        };

        Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            date: update.date.map(|date| date.unix_timestamp()),
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("当前平台不支持应用内安装更新".to_string())
    }
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_updater::UpdaterExt;

        let update = app
            .updater()
            .map_err(|error| format!("初始化更新器失败：{error}"))?
            .check()
            .await
            .map_err(|error| format!("检查更新失败：{error}"))?
            .ok_or_else(|| "当前没有可安装的更新".to_string())?;

        update
            .download_and_install(
                |_chunk_length: usize, _content_length: Option<u64>| {},
                || {},
            )
            .await
            .map_err(|error| format!("下载或安装更新失败：{error}"))?;
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("当前平台不支持应用内安装更新".to_string())
    }
}
