// 在 release 模式下隐藏 Windows 控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_server;
mod quark_client;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::task::JoinHandle;

/// 全局下载代际计数器（epoch）。
/// 每次取消时 +1，下载任务持有启动时的 epoch，
/// 发现不匹配即知道自己被取消，无需重置标志，天然无竞态。
static DOWNLOAD_EPOCH: AtomicU64 = AtomicU64::new(0);

/// 判断某 epoch 的下载是否已被取消
fn is_cancelled(epoch: u64) -> bool {
    DOWNLOAD_EPOCH.load(Ordering::Relaxed) != epoch
}

/// 取消轮询 future：每 200ms 检查一次 epoch，被取消时返回。
/// 与网络读取用 tokio::select! 赛跑，保证即使连接长时间无数据也能及时响应取消。
async fn cancellation_poll(epoch: u64) {
    loop {
        if is_cancelled(epoch) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// 活跃下载任务注册表：cancel_downloads 可立即 abort 任务，无论其卡在
/// 连接建立、数据传输还是分片合并等任何环节（epoch 机制覆盖不到的死角）。
struct ActiveDownload {
    id: String,
    handle: JoinHandle<()>,
    save_path: PathBuf,
    /// 临时分片目录，由 download_multithread 创建后写入
    temp_dir: Arc<Mutex<Option<PathBuf>>>,
}

static ACTIVE_DOWNLOADS: Mutex<Vec<ActiveDownload>> = Mutex::new(Vec::new());

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch";
const MIN_MULTITHREAD_SIZE: u64 = 10 * 1024 * 1024; // 10MB 以下走单线程

// ── 通用工具 ──────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .tcp_keepalive(std::time::Duration::from_secs(60))
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .http1_only()
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))
}

fn add_headers(req: reqwest::RequestBuilder, cookie: &str) -> reqwest::RequestBuilder {
    req.header("User-Agent", UA)
        .header("Cookie", cookie)
        .header("Referer", "https://pan.quark.cn/")
        .header("Accept", "*/*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Accept-Encoding", "identity")
        .header("Connection", "keep-alive")
}

/// 手动跟随 302 重定向，返回 (最终URL, 响应)
async fn follow_redirects(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
) -> Result<(String, reqwest::Response), String> {
    let mut current_url = url.to_string();
    let mut redirects = 0u32;

    loop {
        if redirects > 5 {
            return Err("重定向次数过多".into());
        }

        let resp = add_headers(client.get(&current_url), cookie)
            .send()
            .await
            .map_err(|e| format!("请求失败: {}", e))?;

        if resp.status().is_redirection() {
            if let Some(loc) = resp.headers().get("location") {
                let next = loc.to_str().map_err(|e| e.to_string())?;
                current_url = url::Url::parse(&current_url)
                    .and_then(|base| base.join(next))
                    .map(|u| u.to_string())
                    .unwrap_or_else(|_| next.to_string());
                println!(
                    "[download] 重定向 #{}: {}...",
                    redirects + 1,
                    &current_url[..current_url.len().min(80)]
                );
                redirects += 1;
                continue;
            }
        }

        return Ok((current_url, resp));
    }
}

/// 清洗相对路径：过滤空片段、`.`、`..`（防目录越权）及 Windows 非法字符
fn sanitize_relative_path(p: &str) -> PathBuf {
    let mut pb = PathBuf::new();
    for comp in p.split(['/', '\\']) {
        let comp = comp.trim();
        if comp.is_empty() || comp == "." || comp == ".." {
            continue;
        }
        let cleaned: String = comp
            .chars()
            .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
            .collect();
        if !cleaned.is_empty() {
            pb.push(cleaned);
        }
    }
    if pb.as_os_str().is_empty() {
        PathBuf::from("download")
    } else {
        pb
    }
}

/// 计算目标保存路径：基础目录（save_dir 优先，否则系统下载目录）+ 相对路径/文件名。
/// 下载与"已存在跳过"检查共用，保证判断路径与实际保存路径一致。
fn resolve_target_path(
    save_dir: &Option<String>,
    relative_path: &Option<String>,
    filename: &str,
) -> PathBuf {
    let base_dir = match save_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => dirs::download_dir().unwrap_or_else(|| PathBuf::from(".")),
    };
    match relative_path.as_deref() {
        Some(r) if !r.trim().is_empty() => base_dir.join(sanitize_relative_path(r)),
        _ => base_dir.join(filename),
    }
}

/// 文件级断点续传：判断目标文件是否已存在。
/// 停止任务时会保留完整文件、清理半截文件，因此"存在 = 上次已完整下载"。
#[tauri::command]
fn check_file_exists(
    save_dir: Option<String>,
    relative_path: Option<String>,
    filename: String,
) -> Result<bool, String> {
    let full_path = resolve_target_path(&save_dir, &relative_path, &filename);
    Ok(full_path.is_file())
}

/// 设置 Windows 任务栏按钮的进度覆盖层（类似迅雷）。
/// percent: Some(0-100) 显示进度条；None 清除。任务栏无法绘制文字，百分比在主界面悬浮岛展示。
#[tauri::command]
fn set_taskbar_progress(app: tauri::AppHandle, percent: Option<u64>) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let state = match percent {
        Some(p) => tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::Normal),
            progress: Some(p.clamp(0, 100)),
        },
        None => tauri::window::ProgressBarState {
            status: Some(tauri::window::ProgressBarStatus::None),
            progress: None,
        },
    };
    win.set_progress_bar(state).map_err(|e| e.to_string())
}

/// 解决文件名冲突：存在同名文件时追加 (1), (2), ...
fn resolve_save_path(downloads_dir: &PathBuf, filename: &str) -> PathBuf {
    let mut save_path = downloads_dir.join(filename);
    if !save_path.exists() {
        return save_path;
    }
    let stem = save_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download")
        .to_string();
    let ext = save_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mut i = 1;
    loop {
        let new_name = if ext.is_empty() {
            format!("{} ({})", stem, i)
        } else {
            format!("{} ({}).{}", stem, i, ext)
        };
        save_path = downloads_dir.join(new_name);
        if !save_path.exists() {
            return save_path;
        }
        i += 1;
    }
}

// ── Tauri 命令入口 ───────────────────────────────────────

/// 取消所有正在进行的下载：epoch +1 使旧任务失效，并立即 abort
/// 注册表内全部活跃任务（含卡在连接建立等 epoch 检查不到的环节）
#[tauri::command]
async fn cancel_downloads() -> Result<serde_json::Value, String> {
    let old = DOWNLOAD_EPOCH.fetch_add(1, Ordering::SeqCst);
    println!("[download] 取消下载 (epoch {} → {})", old, old + 1);

    let mut cleanup: Vec<(Option<PathBuf>, PathBuf)> = Vec::new();
    {
        let mut tasks = ACTIVE_DOWNLOADS.lock().unwrap();
        for t in tasks.drain(..) {
            t.handle.abort();
            let temp = t.temp_dir.lock().unwrap().take();
            cleanup.push((temp, t.save_path));
        }
    }

    // 后台清理临时分片目录与未完成的目标文件（注册表内任务必定未完成）
    tokio::spawn(async move {
        for (temp, save) in cleanup {
            if let Some(dir) = temp {
                let _ = tokio::fs::remove_dir_all(&dir).await;
                println!("[download] 已清理临时目录: {:?}", dir);
            }
            let _ = tokio::fs::remove_file(&save).await;
        }
    });

    Ok(serde_json::json!({ "cancelled": true }))
}

/// 弹出原生文件夹选择对话框，返回所选目录路径（取消则返回 None）
#[tauri::command]
async fn pick_download_dir() -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new()
        .set_title("选择下载目录")
        .pick_folder()
        .await
        .map(|handle| handle.path().to_string_lossy().to_string());
    Ok(folder)
}

/// 在系统文件管理器中打开文件夹（传入文件路径时打开其所在目录）
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_file() {
        p.parent().unwrap_or(p).to_path_buf()
    } else {
        p.to_path_buf()
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn download_file(
    app: tauri::AppHandle,
    url: String,
    cookie: String,
    filename: String,
    thread_count: Option<usize>,
    save_dir: Option<String>,
    relative_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let thread_count = thread_count.unwrap_or(999).max(1).min(999);

    // 目标路径：下载目录 + 相对路径（保留分享子目录结构），无相对路径时平铺
    let full_path = resolve_target_path(&save_dir, &relative_path, &filename);

    let target_dir = full_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建下载目录失败: {}", e))?;

    let filename = full_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| filename);

    let save_path = resolve_save_path(&target_dir, &filename);
    let save_path_display = save_path.to_string_lossy().to_string();

    // 捕获当前 epoch——本次下载的"身份证"
    let epoch = DOWNLOAD_EPOCH.load(Ordering::SeqCst);
    // 唯一下载 ID，供前端区分并聚合多个并发下载
    let download_id = uuid::Uuid::new_v4().to_string()[..8].to_string();

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<serde_json::Value, String>>();

    // 注册到活跃任务表，cancel_downloads 可立即 abort（覆盖任何挂起环节）
    let temp_slot: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let wrapper_id = download_id.clone();
    let reg_id = download_id.clone();
    let reg_temp_slot = temp_slot.clone();
    let handle = tokio::spawn(async move {
        let result = do_download(app, url, cookie, filename, save_path, epoch, download_id, thread_count, temp_slot).await;
        // 任务结束（含取消路径）时注销自己
        ACTIVE_DOWNLOADS.lock().unwrap().retain(|t| t.id != wrapper_id);
        let _ = tx.send(result);
    });
    ACTIVE_DOWNLOADS.lock().unwrap().push(ActiveDownload {
        id: reg_id,
        handle,
        save_path: save_path_display.clone().into(),
        temp_dir: reg_temp_slot,
    });

    match rx.await {
        Ok(result) => result,
        Err(_) => Err(format!("下载任务异常终止: {}", save_path_display)),
    }
}

// ── 下载调度 ─────────────────────────────────────────────

async fn do_download(
    app: tauri::AppHandle,
    url: String,
    cookie: String,
    filename: String,
    save_path: PathBuf,
    epoch: u64,
    download_id: String,
    thread_count: usize,
    temp_slot: Arc<Mutex<Option<PathBuf>>>,
) -> Result<serde_json::Value, String> {
    if is_cancelled(epoch) {
        return Err("下载已取消".into());
    }

    println!("[download] 开始: {} -> {:?} (epoch={})", filename, save_path, epoch);

    let client = build_client()?;
    let (final_url, resp) = follow_redirects(&client, &url, &cookie).await?;

    if is_cancelled(epoch) {
        return Err("下载已取消".into());
    }

    if resp.status().as_u16() >= 400 {
        let status = resp.status().as_u16();
        let err = resp.text().await.unwrap_or_default();
        return Err(format!(
            "CDN 返回错误 {}: {}",
            status,
            &err[..err.len().min(200)]
        ));
    }

    let total_size: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let accept_ranges = resp
        .headers()
        .get("accept-ranges")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("bytes"))
        .unwrap_or(false);

    println!(
        "[download] CDN 200, 大小: {} ({:.1} MB), 支持 Range: {}",
        total_size,
        total_size as f64 / 1024.0 / 1024.0,
        accept_ranges
    );

    if accept_ranges && total_size >= MIN_MULTITHREAD_SIZE {
        drop(resp);
        println!("[download] 启用 {} 线程并行下载", thread_count);
        download_multithread(app, client, final_url, cookie, filename, save_path, total_size, epoch, download_id, thread_count, temp_slot)
            .await
    } else {
        println!("[download] 使用单线程下载 (Range 不支持或文件较小)");
        download_single(app, resp, filename, save_path, total_size, epoch, download_id).await
    }
}

// ── 多线程分段下载 ────────────────────────────────────────

async fn download_multithread(
    app: tauri::AppHandle,
    client: reqwest::Client,
    url: String,
    cookie: String,
    filename: String,
    save_path: PathBuf,
    total_size: u64,
    epoch: u64,
    download_id: String,
    thread_count: usize,
    temp_slot: Arc<Mutex<Option<PathBuf>>>,
) -> Result<serde_json::Value, String> {
    // 1. 为本次下载创建独立临时目录
    let temp_id = uuid::Uuid::new_v4();
    let temp_dir = save_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(format!(".quark_temp_{}", &temp_id.to_string()[..8]));
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("创建临时目录失败: {}", e))?;
    // 通知注册表：cancel 时需清理该临时目录
    *temp_slot.lock().unwrap() = Some(temp_dir.clone());

    // 2. 计算各段字节范围
    let segment_size = total_size / thread_count as u64;
    let segments: Vec<(u64, u64)> = (0..thread_count)
        .map(|i| {
            let start = i as u64 * segment_size;
            let end = if i == thread_count - 1 {
                total_size - 1
            } else {
                (i as u64 + 1) * segment_size - 1
            };
            (start, end)
        })
        .collect();

    for (i, (s, e)) in segments.iter().enumerate() {
        println!(
            "[download] 段{}: {}-{} ({:.1} MB)",
            i,
            s,
            e,
            (*e - *s + 1) as f64 / 1024.0 / 1024.0
        );
    }

    // 3. 每段独立的进度原子计数器
    let seg_progresses: Vec<Arc<AtomicU64>> = (0..thread_count)
        .map(|_| Arc::new(AtomicU64::new(0)))
        .collect();

    // 4. 进度监控任务
    let monitor_app = app.clone();
    let monitor_filename = filename.clone();
    let monitor_id = download_id.clone();
    let monitor_segs: Vec<Arc<AtomicU64>> = seg_progresses.iter().map(Arc::clone).collect();
    let monitor = tokio::spawn(async move {
        let mut last_downloaded: u64 = 0;
        let mut last_time = std::time::Instant::now();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if is_cancelled(epoch) {
                break;
            }
            let downloaded: u64 = monitor_segs
                .iter()
                .map(|a| a.load(Ordering::Relaxed))
                .sum();
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_time).as_secs_f64();
            let speed = if dt > 0.0 {
                (downloaded.saturating_sub(last_downloaded)) as f64 / dt
            } else {
                0.0
            };
            last_downloaded = downloaded;
            last_time = now;
            let _ = monitor_app.emit(
                "download-progress",
                serde_json::json!({
                    "id": &monitor_id,
                    "filename": &monitor_filename,
                    "downloaded": downloaded,
                    "total": total_size,
                    "speed": speed,
                }),
            );
            if downloaded >= total_size {
                break;
            }
        }
    });

    // 5. 各段并行下载到临时文件
    let mut handles = Vec::with_capacity(thread_count);
    for (i, &(start, end)) in segments.iter().enumerate() {
        let client = client.clone();
        let url = url.clone();
        let cookie = cookie.clone();
        let chunk_path = temp_dir.join(format!("chunk_{}", i));
        let seg_progress = Arc::clone(&seg_progresses[i]);

        handles.push(tokio::spawn(async move {
            download_segment(&client, &url, &cookie, &chunk_path, start, end, seg_progress, i, epoch)
                .await
        }));
    }

    // 6. 等待所有段完成
    let mut errors = Vec::new();
    for (i, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => errors.push(format!("段{}: {}", i, e)),
            Err(e) => errors.push(format!("段{} 任务崩溃: {}", i, e)),
        }
    }

    monitor.abort();

    if !errors.is_empty() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        println!("[download] 已清理临时目录: {:?}", temp_dir);
        return Err(format!("多线程下载失败:\n{}", errors.join("\n")));
    }

    // 7. 合并前再检查一次
    if is_cancelled(epoch) {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        return Err("下载已取消".into());
    }

    // 8. 合并分片到最终文件
    println!("[download] 合并 {} 个分片到最终文件...", thread_count);
    let _ = app.emit(
        "download-progress",
        serde_json::json!({
            "id": &download_id,
            "filename": &filename,
            "downloaded": total_size,
            "total": total_size,
            "status": "merging",
        }),
    );

    {
        let final_file = tokio::fs::File::create(&save_path)
            .await
            .map_err(|e| format!("创建最终文件失败: {}", e))?;
        let mut writer = tokio::io::BufWriter::with_capacity(8 * 1024 * 1024, final_file);

        for i in 0..thread_count {
            let chunk_path = temp_dir.join(format!("chunk_{}", i));
            let mut chunk_file = tokio::fs::File::open(&chunk_path)
                .await
                .map_err(|e| format!("打开分片 {} 失败: {}", i, e))?;
            tokio::io::copy(&mut chunk_file, &mut writer)
                .await
                .map_err(|e| format!("合并分片 {} 失败: {}", i, e))?;
        }

        writer
            .flush()
            .await
            .map_err(|e| format!("flush 失败: {}", e))?;
    }

    // 9. 清理临时目录
    let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    println!("[download] 临时文件已清理");

    // 最终进度
    let _ = app.emit(
        "download-progress",
        serde_json::json!({
            "id": &download_id,
            "filename": &filename,
            "downloaded": total_size,
            "total": total_size,
            "status": "done",
        }),
    );

    Ok(serde_json::json!({
        "path": save_path.to_string_lossy(),
        "size": total_size,
    }))
}

/// 单个段的下载逻辑：Range 请求 → 写入独立临时文件
async fn download_segment(
    client: &reqwest::Client,
    url: &str,
    cookie: &str,
    chunk_path: &PathBuf,
    start: u64,
    end: u64,
    progress: Arc<AtomicU64>,
    index: usize,
    epoch: u64,
) -> Result<(), String> {
    let range_header = format!("bytes={}-{}", start, end);

    // 请求发起阶段也与取消轮询赛跑：CDN 限流时连接可能长时间无响应
    let resp = tokio::select! {
        r = add_headers(client.get(url), cookie)
            .header("Range", &range_header)
            .send() => r.map_err(|e| format!("请求失败: {}", e))?,
        _ = cancellation_poll(epoch) => return Err("下载已取消".into()),
    };

    let status = resp.status().as_u16();
    if status != 206 && status != 200 {
        return Err(format!("CDN 返回 {} (期望 206)", status));
    }

    if status == 200 {
        return Err("CDN 不支持 Range 请求 (返回 200 而非 206)".into());
    }

    let file = tokio::fs::File::create(chunk_path)
        .await
        .map_err(|e| format!("创建临时文件失败: {}", e))?;

    let mut writer = tokio::io::BufWriter::with_capacity(1024 * 1024, file);
    let mut resp = resp;
    let mut seg_downloaded: u64 = 0;
    let expected = end - start + 1;

    loop {
        // 网络数据与取消轮询赛跑：即使 chunk 长时间 pending 也能在 200ms 内响应取消
        let chunk = tokio::select! {
            c = resp.chunk() => match c {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(e) => {
                    return Err(format!(
                        "传输中断: {} (已下载 {}/{})",
                        e, seg_downloaded, expected
                    ));
                }
            },
            _ = cancellation_poll(epoch) => return Err("下载已取消".into()),
        };
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败: {}", e))?;
        seg_downloaded += chunk.len() as u64;
        progress.store(seg_downloaded, Ordering::Relaxed);
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush 失败: {}", e))?;

    println!(
        "[download] 段{} 完成: {}/{} bytes",
        index, seg_downloaded, expected
    );

    Ok(())
}

// ── 单线程下载（Range 不可用时的回退） ───────────────────

async fn download_single(
    app: tauri::AppHandle,
    mut resp: reqwest::Response,
    filename: String,
    save_path: PathBuf,
    total_size: u64,
    epoch: u64,
    download_id: String,
) -> Result<serde_json::Value, String> {
    let file = tokio::fs::File::create(&save_path)
        .await
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut writer = tokio::io::BufWriter::with_capacity(8 * 1024 * 1024, file);

    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut last_downloaded: u64 = 0;

    loop {
        // 网络数据与取消轮询赛跑：即使 chunk 长时间 pending 也能在 200ms 内响应取消
        let chunk = tokio::select! {
            c = resp.chunk() => match c {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&save_path).await;
                    return Err(format!("下载中断: {} (已下载 {})", e, downloaded));
                }
            },
            _ = cancellation_poll(epoch) => {
                drop(writer);
                let _ = tokio::fs::remove_file(&save_path).await;
                return Err("下载已取消".into());
            }
        };
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
            let now = std::time::Instant::now();
            let dt = now.duration_since(last_emit).as_secs_f64();
            let speed = if dt > 0.0 {
                (downloaded.saturating_sub(last_downloaded)) as f64 / dt
            } else {
                0.0
            };
            last_downloaded = downloaded;
            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "id": &download_id,
                    "filename": &filename,
                    "downloaded": downloaded,
                    "total": total_size,
                    "speed": speed,
                }),
            );
            last_emit = now;
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush 失败: {}", e))?;

    println!(
        "[download] 单线程完成: {} ({:.1} MB, {} bytes)",
        filename,
        downloaded as f64 / 1024.0 / 1024.0,
        downloaded
    );

    let _ = app.emit(
        "download-progress",
        serde_json::json!({
            "id": &download_id,
            "filename": &filename,
            "downloaded": downloaded,
            "total": total_size,
            "status": "done",
        }),
    );

    Ok(serde_json::json!({
        "path": save_path.to_string_lossy(),
        "size": downloaded,
    }))
}

// ── 主入口 ───────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            download_file,
            cancel_downloads,
            pick_download_dir,
            open_folder,
            check_file_exists,
            set_taskbar_progress
        ])
        .setup(|app| {
            let _main_window = app
                .get_webview_window("main")
                .expect("主窗口不存在");

            // 启动内嵌 HTTP 服务（axum）
            let port: u16 = std::env::var("PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3000);
            tauri::async_runtime::spawn(async move {
                let router = api_server::create_router();
                let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
                    .await
                    .expect("failed to bind API server port");
                println!("[quark-api] 内嵌服务已启动: http://127.0.0.1:{}", port);
                axum::serve(listener, router)
                    .await
                    .expect("API server error");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}