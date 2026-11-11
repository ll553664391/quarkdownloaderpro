use axum::{
    Router,
    extract::Query,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::{CorsLayer, Any};

use crate::quark_client;

/// 允许的来源白名单：仅 Tauri WebView 自身（生产）与 Vite 开发服务器（dev）。
/// 防止浏览器中任意恶意网页通过 CORS 读取本地 API 响应（含登录 Cookie）。
const ALLOWED_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",  // Tauri v2 生产环境（Windows/macOS WebView）
    "tauri://localhost",       // Tauri v2 自定义协议（Linux 等）
    "http://127.0.0.1:1420",   // dev 模式 Vite 开发服务器
];

pub fn create_router() -> Router {
    let cors = CorsLayer::new()
        .allow_origin(
            ALLOWED_ORIGINS
                .iter()
                .map(|o| HeaderValue::from_static(o))
                .collect::<Vec<HeaderValue>>(),
        )
        .allow_methods(Any)
        .allow_headers(Any)
        .expose_headers([header::HeaderName::from_static("x-append-cookie")]);

    Router::new()
        .route("/api/health", get(health))
        .route("/api/qrlogin/token", get(qr_token))
        .route("/api/qrlogin/query", get(qr_query))
        .route("/api/qrlogin/cookie", get(qr_cookie))
        .route("/api/logout", post(logout))
        // API 代理路由
        .route("/api/share/token", post(api_proxy))
        .route("/api/share/detail", get(api_proxy))
        .route("/api/share/save", post(api_proxy))
        .route("/api/task", get(api_proxy))
        .route("/api/file/download", post(api_proxy))
        .route("/api/file/delete", post(api_proxy))
        .route("/api/member", get(api_proxy))
        // 测速路由（scripts/speed-test.mjs 使用）：与应用下载相同的 reqwest 引擎
        .route("/api/speedtest", post(speed_probe))
        .layer(cors)
}

/// 测速请求参数
#[derive(Deserialize)]
struct SpeedProbeParams {
    url: String,
    cookie: String,
    #[serde(default = "default_threads")]
    threads: usize,
    #[serde(default = "default_seconds")]
    seconds: u64,
}

fn default_threads() -> usize { 4 }
fn default_seconds() -> u64 { 10 }

const PROBE_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";

/// CDN 测速：N 个段并发 Range 下载 seconds 秒，返回各段累计字节。
/// 与正式下载使用相同的 reqwest 引擎（同 TLS 指纹），绕开 Node fetch 的 412 风控。
async fn speed_probe(axum::Json(p): axum::Json<SpeedProbeParams>) -> Response {
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .http1_only()
        .build()
    {
        Ok(c) => c,
        Err(e) => return json_response(StatusCode::OK, json!({ "error": format!("build client: {}", e) })),
    };

    // 手动跟随 302（每跳带头），首跳不带 Range，与正式下载一致
    let mut current = p.url.clone();
    let mut head_resp = None;
    for _ in 0..6 {
        let r = client
            .get(&current)
            .header("User-Agent", PROBE_UA)
            .header("Cookie", &p.cookie)
            .header("Referer", "https://pan.quark.cn/")
            .header("Accept", "*/*")
            .header("Accept-Encoding", "identity")
            .header("Connection", "keep-alive")
            .send()
            .await;
        match r {
            Ok(resp) if resp.status().is_redirection() => {
                match resp.headers().get("location").and_then(|l| l.to_str().ok()) {
                    Some(loc) => {
                        current = url::Url::parse(&current)
                            .and_then(|b| b.join(loc))
                            .map(|u| u.to_string())
                            .unwrap_or_else(|_| loc.to_string());
                    }
                    None => return json_response(StatusCode::OK, json!({ "error": "redirect without location" })),
                }
            }
            Ok(resp) => { head_resp = Some(resp); break; }
            Err(e) => return json_response(StatusCode::OK, json!({ "error": format!("request: {}", e) })),
        }
    }
    let head = match head_resp {
        Some(h) => h,
        None => return json_response(StatusCode::OK, json!({ "error": "too many redirects" })),
    };
    if head.status().as_u16() >= 400 {
        return json_response(StatusCode::OK, json!({ "error": format!("CDN HTTP {}", head.status()) }));
    }
    let total: u64 = head
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let accept_ranges = head
        .headers()
        .get("accept-ranges")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("bytes"))
        .unwrap_or(false);
    drop(head);

    let threads = p.threads.max(1);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(p.seconds);

    // 计算各段范围
    let segments: Vec<(u64, u64)> = if accept_ranges && total > 0 && threads > 1 {
        let seg = total / threads as u64;
        (0..threads)
            .map(|i| {
                let s = i as u64 * seg;
                let e = if i == threads - 1 { total - 1 } else { (i as u64 + 1) * seg - 1 };
                (s, e)
            })
            .collect()
    } else {
        vec![(0, u64::MAX)] // 单流全量
    };

    // 每段一个任务：一次请求，流式读取到 deadline 或段结束
    let mut handles = Vec::new();
    for (seg_start, seg_end) in segments {
        let client = client.clone();
        let url = current.clone();
        let cookie = p.cookie.clone();
        handles.push(tokio::spawn(async move {
            use futures_util::StreamExt;
            let mut bytes: u64 = 0;
            let mut req = client
                .get(&url)
                .header("User-Agent", PROBE_UA)
                .header("Cookie", &cookie)
                .header("Referer", "https://pan.quark.cn/")
                .header("Accept", "*/*")
                .header("Accept-Encoding", "identity")
                .header("Connection", "keep-alive");
            if seg_end != u64::MAX {
                req = req.header("Range", format!("bytes={}-{}", seg_start, seg_end));
            }
            let remain = std::time::Duration::from_secs((deadline - tokio::time::Instant::now()).as_secs().max(1));
            let resp = match req.timeout(remain).send().await {
                Ok(r) if r.status().is_success() || r.status().as_u16() == 206 => r,
                _ => return 0u64,
            };
            let mut stream = resp.bytes_stream();
            loop {
                if tokio::time::Instant::now() >= deadline { break; }
                match tokio::time::timeout(std::time::Duration::from_secs(2), stream.next()).await {
                    Ok(Some(Ok(chunk))) => bytes += chunk.len() as u64,
                    Ok(Some(Err(_))) => break,
                    Ok(None) => break,   // 段已下完
                    Err(_) => break,     // 单块超时
                }
            }
            bytes
        }));
    }

    let mut seg_bytes: Vec<u64> = Vec::new();
    let mut total_bytes: u64 = 0;
    for h in handles {
        let b = h.await.unwrap_or(0);
        total_bytes += b;
        seg_bytes.push(b);
    }

    json_response(
        StatusCode::OK,
        json!({ "ok": true, "total": total, "accept_ranges": accept_ranges, "bytes": total_bytes, "segments": seg_bytes }),
    )
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        serde_json::to_string(&body).unwrap_or_default(),
    )
        .into_response()
}

fn extract_cookie(headers: &HeaderMap) -> String {
    headers
        .get("x-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

// ==================== Health ====================

async fn health() -> Response {
    json_response(StatusCode::OK, json!({ "ok": true, "service": "quark-api-rust" }))
}

// ==================== 扫码登录 ====================

async fn qr_token() -> Response {
    match quark_client::qr_get_token().await {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(e) => json_response(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

#[derive(Deserialize)]
struct QrQueryParams {
    token: Option<String>,
}

async fn qr_query(Query(params): Query<QrQueryParams>) -> Response {
    let token = match params.token {
        Some(t) if !t.is_empty() => t,
        _ => return json_response(StatusCode::BAD_REQUEST, json!({ "error": "Missing token" })),
    };

    match quark_client::qr_query_status(&token).await {
        Ok(result) => {
            let body: Value = serde_json::from_slice(&result.body).unwrap_or(Value::Null);
            json_response(StatusCode::from_u16(result.status).unwrap_or(StatusCode::OK), body)
        }
        Err(e) => json_response(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

#[derive(Deserialize)]
struct QrCookieParams {
    service_ticket: Option<String>,
}

async fn qr_cookie(Query(params): Query<QrCookieParams>) -> Response {
    let st = match params.service_ticket {
        Some(s) if !s.is_empty() => s,
        _ => return json_response(StatusCode::BAD_REQUEST, json!({ "error": "Missing service_ticket" })),
    };

    match quark_client::qr_get_cookie(&st).await {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(e) => json_response(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}

// ==================== 退出登录 ====================

async fn logout(headers: HeaderMap) -> Response {
    let cookie = extract_cookie(&headers);
    match quark_client::logout(&cookie).await {
        Ok(data) => json_response(StatusCode::OK, data),
        Err(e) => json_response(StatusCode::BAD_REQUEST, json!({ "error": e })),
    }
}

// ==================== API 代理 ====================

async fn api_proxy(
    method: axum::http::Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let path = uri.path();
    let routes = quark_client::get_api_routes();

    let route = match routes.get(path) {
        Some(r) => r,
        None => return json_response(StatusCode::NOT_FOUND, json!({ "error": "Not Found", "path": path })),
    };

    let cookie = extract_cookie(&headers);
    let query = uri.query().unwrap_or("").to_string();

    let req_method = match method {
        axum::http::Method::POST => Method::POST,
        _ => route.method.clone(),
    };

    let body_opt = if body.is_empty() { None } else { Some(body.into()) };

    match quark_client::proxy_request(
        route.path,
        req_method,
        Some(&cookie),
        body_opt,
        &query,
        route.host,
        true,
    )
    .await
    {
        Ok(result) => {
            let mut resp_headers = vec![(
                header::CONTENT_TYPE,
                "application/json; charset=utf-8".to_string(),
            )];

            // 检查 __puus cookie
            if let Some(set_cookie) = result.headers.get("set-cookie") {
                if let Ok(sc_str) = set_cookie.to_str() {
                    if sc_str.starts_with("__puus=") {
                        let puus_val = sc_str.split(';').next().unwrap_or("");
                        resp_headers.push((
                            header::HeaderName::from_static("x-append-cookie"),
                            puus_val.to_string(),
                        ));
                        println!("[api-proxy] 捕获到 __puus cookie!");
                    }
                }
            }
            // 也检查多个 set-cookie
            for val in result.headers.get_all("set-cookie") {
                if let Ok(sc_str) = val.to_str() {
                    if sc_str.starts_with("__puus=") {
                        let puus_val = sc_str.split(';').next().unwrap_or("");
                        resp_headers.push((
                            header::HeaderName::from_static("x-append-cookie"),
                            puus_val.to_string(),
                        ));
                    }
                }
            }

            let status = StatusCode::from_u16(result.status).unwrap_or(StatusCode::OK);
            let mut response = (status, result.body.to_vec()).into_response();
            for (name, value) in resp_headers {
                if let Ok(v) = value.parse() {
                    response.headers_mut().insert(name, v);
                }
            }
            response
        }
        Err(e) => json_response(StatusCode::BAD_GATEWAY, json!({ "error": e })),
    }
}
