//! 系统密钥串。
//!
//! 桌面端使用 Windows Credential Manager / macOS Keychain / Secret Service；
//! 移动端 v1 尚未接入 Keychain/Keystore，命令会明确返回「未支持」，前端应
//! 退回 IndexedDB 的凭据存储，而不是假装安全。

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureAvailability {
    pub available: bool,
    pub backend: String,
    pub note: String,
}

#[cfg(desktop)]
const SERVICE: &str = "com.mogeng.novelstudio";

#[tauri::command]
pub fn secure_available() -> SecureAvailability {
    #[cfg(desktop)]
    {
        SecureAvailability {
            available: true,
            backend: backend_name().to_string(),
            note: "密钥保存在系统凭据管理器，不写入项目数据库。".to_string(),
        }
    }
    #[cfg(not(desktop))]
    {
        SecureAvailability {
            available: false,
            backend: "unsupported".to_string(),
            note: "移动端密钥串适配尚未接入，当前使用浏览器凭据存储。".to_string(),
        }
    }
}

#[cfg(desktop)]
fn backend_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows-credential-manager"
    } else if cfg!(target_os = "macos") {
        "macos-keychain"
    } else {
        "secret-service"
    }
}

#[cfg(desktop)]
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, id).map_err(|error| format!("打开系统密钥串失败：{error}"))
}

#[tauri::command]
pub fn secure_get(id: String) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        match entry(&id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("读取系统密钥失败：{error}")),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = id;
        Err("移动端密钥串尚未接入".to_string())
    }
}

#[tauri::command]
pub fn secure_set(id: String, value: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        entry(&id)?
            .set_password(&value)
            .map_err(|error| format!("写入系统密钥失败：{error}"))
    }
    #[cfg(not(desktop))]
    {
        let _ = (id, value);
        Err("移动端密钥串尚未接入".to_string())
    }
}

#[tauri::command]
pub fn secure_delete(id: String) -> Result<(), String> {
    #[cfg(desktop)]
    {
        match entry(&id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("删除系统密钥失败：{error}")),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = id;
        Err("移动端密钥串尚未接入".to_string())
    }
}
