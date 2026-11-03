//! 原生流式代理。
//!
//! 前端把「目标 URL + 方法 + 头 + 体」交给这里，Rust 侧校验目标、
//! 钉住 DNS 结果、用无重定向的 reqwest 发请求，再把响应按 SSE/JSON
//! 原始字节逐块回推。这样 Tauri 里既没有 CORS，也不会把厂商 key
//! 写进 WebView 的日志或 Network 面板。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 8;

pub struct ProxyState {
    tokens: Mutex<HashMap<String, CancellationToken>>,
    permits: Arc<Semaphore>,
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub id: String,
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub auth_header: Option<String>,
    #[serde(default)]
    pub auth_scheme: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProxyEvent {
    Response {
        status: u16,
        headers: HashMap<String, String>,
        url: String,
    },
    Chunk {
        data: String,
    },
    End,
    Error {
        message: String,
    },
}

fn send_error(channel: &Channel<ProxyEvent>, message: &str) {
    let _ = channel.send(ProxyEvent::Error {
        message: message.to_string(),
    });
}

#[tauri::command]
pub async fn proxy_active(state: State<'_, ProxyState>) -> Result<Vec<String>, String> {
    Ok(state.tokens.lock().await.keys().cloned().collect())
}

#[tauri::command]
pub async fn proxy_abort(state: State<'_, ProxyState>, id: String) -> Result<(), String> {
    if let Some(token) = state.tokens.lock().await.remove(&id) {
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn proxy_stream(
    state: State<'_, ProxyState>,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    {
        let mut tokens = state.tokens.lock().await;
        tokens.insert(request.id.clone(), token.clone());
    }

    let permit = state
        .permits
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| "代理已关闭".to_string())?;
    if token.is_cancelled() {
        state.tokens.lock().await.remove(&request.id);
        return Err("已中止".to_string());
    }

    let result = run_proxy(&request, token.clone(), on_event.clone()).await;

    state.tokens.lock().await.remove(&request.id);
    drop(permit);

    if let Err(error) = &result {
        // run_proxy 在拿到响应前失败时可能还没来得及发事件；
        // 这里补一条，前端就能把 fetch 的 promise 正常 reject。
        send_error(&on_event, error);
    }
    result
}

async fn run_proxy(
    request: &ProxyRequest,
    token: CancellationToken,
    on_event: Channel<ProxyEvent>,
) -> Result<(), String> {
    let (parsed, _host, pin, pinned_addr) = validate_target(&request.url).await?;

    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .user_agent("novel-studio/0.1 (tauri)");

    if let (Some(host), Some(addr)) = (pin.as_deref(), pinned_addr) {
        builder = builder.resolve(host, addr);
    }

    let client = builder
        .build()
        .map_err(|error| format!("创建网络客户端失败：{error}"))?;

    let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法：{}", request.method))?;

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "upgrade"
                | "proxy-connection"
                | "accept-encoding"
                | "authorization"
                | "x-api-key"
                | "x-goog-api-key"
        ) {
            continue;
        }
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("非法请求头：{name}"))?;
        let header_value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| format!("非法请求头值：{name}"))?;
        headers.append(header_name, header_value);
    }

    if let Some(api_key) = request.api_key.as_deref().filter(|key| !key.is_empty()) {
        let header = request
            .auth_header
            .as_deref()
            .filter(|name| !name.is_empty())
            .unwrap_or("authorization");
        // `authScheme` 可能带尾空格（"Bearer "），也可能不带（"Bearer"）；
        // 空串表示这个头只需要裸 key（x-api-key 一类）。
        let scheme = request
            .auth_scheme
            .as_deref()
            .unwrap_or("Bearer")
            .trim();
        let value = if scheme.is_empty() {
            api_key.to_string()
        } else {
            format!("{scheme} {api_key}")
        };
        let header_name = reqwest::header::HeaderName::from_bytes(header.as_bytes())
            .map_err(|_| "非法鉴权头".to_string())?;
        let header_value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| "非法鉴权值".to_string())?;
        headers.insert(header_name, header_value);
    }

    if let Some(body) = request.body.as_deref() {
        if body.len() > MAX_REQUEST_BYTES {
            return Err(format!(
                "请求体过大（{} 字节，上限 {} 字节）",
                body.len(),
                MAX_REQUEST_BYTES
            ));
        }
    }

    let mut outgoing = client.request(method, parsed.clone()).headers(headers);
    if let Some(body) = request.body.clone() {
        outgoing = outgoing.body(body);
    }

    let response = tokio::select! {
        _ = token.cancelled() => return Err("已中止".to_string()),
        result = outgoing.send() => result.map_err(|error| format!("网络请求失败：{error}"))?,
    };

    let status = response.status().as_u16();
    let mut response_headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(text) = value.to_str() {
            response_headers.insert(name.as_str().to_string(), text.to_string());
        }
    }
    let final_url = response.url().to_string();
    let _ = on_event.send(ProxyEvent::Response {
        status,
        headers: response_headers,
        url: final_url,
    });

    let mut stream = response.bytes_stream();
    let mut total = 0usize;

    loop {
        let item = tokio::select! {
            _ = token.cancelled() => {
                let _ = on_event.send(ProxyEvent::Error { message: "已中止".to_string() });
                return Err("已中止".to_string());
            }
            item = stream.next() => item,
        };

        match item {
            Some(Ok(bytes)) => {
                total = total.saturating_add(bytes.len());
                if total > MAX_RESPONSE_BYTES {
                    let message = format!(
                        "上游响应过大（超过 {} MiB），已停止接收",
                        MAX_RESPONSE_BYTES / 1024 / 1024
                    );
                    let _ = on_event.send(ProxyEvent::Error {
                        message: message.clone(),
                    });
                    return Err(message);
                }
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                if on_event.send(ProxyEvent::Chunk { data }).is_err() {
                    return Ok(());
                }
            }
            Some(Err(error)) => {
                let message = format!("读取上游响应失败：{error}");
                let _ = on_event.send(ProxyEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
            None => break,
        }
    }

    let _ = on_event.send(ProxyEvent::End);
    Ok(())
}

/// 校验目标并返回 (URL, 主机名, 钉住用的域名, 钉住的地址)。
///
/// 1. 只允许 https；http 只允许本机回环（Ollama 之类）。
/// 2. 禁止 URL 内嵌账号密码。
/// 3. 解析 DNS 后校验全部地址，任一落在私网/回环/链路本地/云元数据就拒绝。
/// 4. 把解析结果交给 reqwest 的 resolve() 钉住，防止 DNS rebinding。
async fn validate_target(raw: &str) -> Result<(Url, String, Option<String>, Option<SocketAddr>), String> {
    let url = Url::parse(raw).map_err(|error| format!("非法 URL：{error}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL 不允许包含账号密码".to_string());
    }
    let scheme = url.scheme();
    if scheme != "https" && scheme != "http" {
        return Err("只允许 http/https 上游".to_string());
    }

    let host = url.host().ok_or_else(|| "URL 缺少主机名".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "URL 缺少端口".to_string())?;
    let host_name = match &host {
        Host::Domain(name) => name.to_ascii_lowercase(),
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => ip.to_string(),
    };

    let is_loopback_literal = match &host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
    };

    if scheme == "http" && !is_loopback_literal {
        return Err("http 只允许连接本机回环地址（如 Ollama）；其他上游请用 https".to_string());
    }

    match host {
        Host::Ipv4(ip) => {
            if forbidden_ip(IpAddr::V4(ip)) && !ip.is_loopback() {
                return Err("拒绝连接私网、链路本地或保留地址".to_string());
            }
            let addr = SocketAddr::new(IpAddr::V4(ip), port);
            Ok((url, host_name, None, Some(addr)))
        }
        Host::Ipv6(ip) => {
            if forbidden_ip(IpAddr::V6(ip)) && !ip.is_loopback() {
                return Err("拒绝连接私网、链路本地或保留地址".to_string());
            }
            let addr = SocketAddr::new(IpAddr::V6(ip), port);
            Ok((url, host_name, None, Some(addr)))
        }
        Host::Domain(_) => {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host_name.as_str(), port))
                .await
                .map_err(|error| format!("解析主机失败：{error}"))?
                .collect();
            if addrs.is_empty() {
                return Err("主机没有可用地址".to_string());
            }
            for addr in &addrs {
                if forbidden_ip(addr.ip()) {
                    return Err(format!(
                        "拒绝连接解析到私网/保留地址的主机（{}）",
                        addr.ip()
                    ));
                }
            }
            let pinned = addrs[0];
            Ok((url, host_name.clone(), Some(host_name), Some(pinned)))
        }
    }
}

fn forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => forbidden_v4(v4),
        IpAddr::V6(v6) => forbidden_v6(v6),
    }
}

fn forbidden_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        // 100.64.0.0/10 运营商级 NAT
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn forbidden_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        // 2001:db8::/32 文档地址（is_documentation 在 IPv6 上仍不稳定）
        || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
        || ip
            .to_ipv4_mapped()
            .map(forbidden_v4)
            .unwrap_or(false)
}
