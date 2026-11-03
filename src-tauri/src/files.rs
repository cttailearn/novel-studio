//! 桌面文件选择与读写。
//!
//! 前端已有 Blob 下载与 `<input type="file">`，桌面端再提供原生对话框，
//! 让 `.novel` 备份、TXT/Markdown 导出落到用户选定的位置。移动端继续用
//! WebView 的文件选择/分享能力，命令返回明确的未支持错误。

#[cfg(desktop)]
use base64::Engine;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub async fn save_text_file(
    suggested_name: String,
    content: String,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let dialog = rfd::AsyncFileDialog::new()
            .set_title("导出文件")
            .set_file_name(&suggested_name);
        let Some(file) = dialog.save_file().await else {
            return Ok(None);
        };
        let path = file.path().to_path_buf();
        std::fs::write(&path, content).map_err(|error| format!("写入文件失败：{error}"))?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = (suggested_name, content);
        Err("移动端请使用系统分享或浏览器下载".to_string())
    }
}

/// 保存二进制文件（`.novel` 备份是压缩包，不能按 UTF-8 文本写）。
#[tauri::command]
pub async fn save_binary_file(
    suggested_name: String,
    base64_data: String,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_data.as_bytes())
            .map_err(|error| format!("备份内容解码失败：{error}"))?;
        let dialog = rfd::AsyncFileDialog::new()
            .set_title("导出备份")
            .set_file_name(&suggested_name);
        let Some(file) = dialog.save_file().await else {
            return Ok(None);
        };
        let path = file.path().to_path_buf();
        std::fs::write(&path, bytes).map_err(|error| format!("写入文件失败：{error}"))?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
    #[cfg(not(desktop))]
    {
        let _ = (suggested_name, base64_data);
        Err("移动端请使用系统分享".to_string())
    }
}

#[tauri::command]
pub async fn open_text_file() -> Result<Option<TextFile>, String> {
    #[cfg(desktop)]
    {
        let dialog = rfd::AsyncFileDialog::new()
            .set_title("导入文件")
            .add_filter("墨耕项目与文本", &["novel", "txt", "md", "markdown", "json"])
            .add_filter("所有文件", &["*"]);
        let Some(file) = dialog.pick_file().await else {
            return Ok(None);
        };
        let path = file.path().to_path_buf();
        let content = std::fs::read_to_string(&path)
            .map_err(|error| format!("读取文件失败：{error}（仅支持 UTF-8 文本）"))?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名文件".to_string());
        Ok(Some(TextFile {
            name,
            path: path.to_string_lossy().to_string(),
            content,
        }))
    }
    #[cfg(not(desktop))]
    {
        Err("移动端请使用系统文件选择器".to_string())
    }
}
