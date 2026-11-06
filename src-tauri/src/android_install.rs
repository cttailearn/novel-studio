//! Android 应用内更新：下载 APK 后交给系统安装器。
//!
//! 安卓不允许普通应用静默安装（INSTALL_PACKAGES 属于 signature 级权限），
//! 所以这里只做两件事：把安装包下到应用缓存目录，再用 FileProvider 生成
//! content:// 地址，通过 ACTION_VIEW 唤起系统安装器，由用户点确认。
//! 系统安装器会覆盖安装同一签名的旧版本，作品数据保持不动。

#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::Emitter as _;
#[cfg(target_os = "android")]
use tauri::Manager as _;

#[cfg(target_os = "android")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    received: u64,
    total: Option<u64>,
}

#[tauri::command]
pub async fn android_install_update(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        download_and_install(app, url, version).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &url, &version);
        Err("当前平台不支持应用内安装更新".to_string())
    }
}

#[cfg(target_os = "android")]
async fn download_and_install(
    app: tauri::AppHandle,
    url: String,
    version: String,
) -> Result<(), String> {
    use futures_util::StreamExt as _;
    use std::io::{Read as _, Write as _};

    const RELEASE_PREFIX: &str = "https://github.com/cttailearn/novel-studio/releases/download/";
    if !url.starts_with(RELEASE_PREFIX) {
        return Err("更新地址不在发布页范围内".to_string());
    }
    if version.is_empty() || !version.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return Err("版本号格式不正确".to_string());
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("取缓存目录失败：{error}"))?;
    let update_dir = cache_dir.join("updates");
    std::fs::create_dir_all(&update_dir).map_err(|error| format!("创建缓存目录失败：{error}"))?;

    let file_name = format!("novel-studio-{version}.apk");
    let target = update_dir.join(&file_name);
    let partial = update_dir.join(format!("{file_name}.part"));

    let client = reqwest::Client::builder()
        .user_agent(concat!("novel-studio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("初始化下载器失败：{error}"))?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| format!("下载请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }

    let total = response.content_length();
    let mut file =
        std::fs::File::create(&partial).map_err(|error| format!("创建安装包失败：{error}"))?;
    let mut received: u64 = 0;
    let mut next_report: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载中断：{error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("写入安装包失败：{error}"))?;
        received += chunk.len() as u64;
        if received >= next_report {
            next_report = received + 1024 * 1024;
            let _ = app.emit("update-progress", UpdateProgress { received, total });
        }
    }
    file.flush()
        .map_err(|error| format!("写入安装包失败：{error}"))?;
    drop(file);

    // 校验 zip 头，避免把错误页或半截文件交给系统安装器。
    let mut header = [0u8; 4];
    {
        let mut handle =
            std::fs::File::open(&partial).map_err(|error| format!("读取安装包失败：{error}"))?;
        handle
            .read_exact(&mut header)
            .map_err(|error| format!("读取安装包失败：{error}"))?;
    }
    if &header != b"PK\x03\x04" {
        let _ = std::fs::remove_file(&partial);
        return Err("下载到的文件不是有效的 APK".to_string());
    }

    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&partial, &target).map_err(|error| format!("保存安装包失败：{error}"))?;
    let _ = app.emit("update-progress", UpdateProgress { received, total });

    launch_installer(&target)
}

#[cfg(target_os = "android")]
fn launch_installer(path: &std::path::Path) -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    use jni::JavaVM;

    // Activity 与 JavaVM 由 tao 在启动时交给 ndk_context，
    // 这里直接取用，不需要额外的 Kotlin 插件。
    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|error| format!("获取 Java 虚拟机失败：{error}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|error| format!("挂载 JNI 线程失败：{error}"))?;
    let activity = unsafe { JObject::from_raw(context.context().cast()) };

    let path_text = env
        .new_string(path.to_string_lossy().to_string())
        .map_err(|error| format!("构造文件路径失败：{error}"))?;
    let file = env
        .new_object(
            "java/io/File",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&path_text)],
        )
        .map_err(|error| format!("打开安装包失败：{error}"))?;

    let package_object = env
        .call_method(&activity, "getPackageName", "()Ljava/lang/String;", &[])
        .and_then(|value| value.l())
        .map_err(|error| format!("读取应用包名失败：{error}"))?;
    // 用 Java 侧拼接，省掉 JNI 字符串到 Rust 字符串的转换。
    let suffix = env
        .new_string(".fileprovider")
        .map_err(|error| format!("构造 FileProvider 失败：{error}"))?;
    let authority = env
        .call_method(
            &package_object,
            "concat",
            "(Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&suffix)],
        )
        .and_then(|value| value.l())
        .map_err(|error| format!("构造 FileProvider 失败：{error}"))?;

    let uri = env
        .call_static_method(
            "androidx/core/content/FileProvider",
            "getUriForFile",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
            &[
                JValue::Object(&activity),
                JValue::Object(&authority),
                JValue::Object(&file),
            ],
        )
        .and_then(|value| value.l())
        .map_err(|error| format!("生成安装包地址失败：{error}"))?;

    let action = env
        .new_string("android.intent.action.VIEW")
        .map_err(|error| format!("构造安装意图失败：{error}"))?;
    let intent = env
        .new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&action)],
        )
        .map_err(|error| format!("构造安装意图失败：{error}"))?;
    let mime = env
        .new_string("application/vnd.android.package-archive")
        .map_err(|error| format!("构造安装意图失败：{error}"))?;
    env.call_method(
        &intent,
        "setDataAndType",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
        &[JValue::Object(&uri), JValue::Object(&mime)],
    )
    .map_err(|error| format!("设置安装意图失败：{error}"))?;

    // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
    const FLAGS: i32 = 0x0000_0001 | 0x1000_0000;
    env.call_method(
        &intent,
        "addFlags",
        "(I)Landroid/content/Intent;",
        &[JValue::Int(FLAGS)],
    )
    .map_err(|error| format!("设置安装意图失败：{error}"))?;
    env.call_method(
        &activity,
        "startActivity",
        "(Landroid/content/Intent;)V",
        &[JValue::Object(&intent)],
    )
    .map_err(|error| format!("唤起系统安装器失败：{error}"))?;

    Ok(())
}
