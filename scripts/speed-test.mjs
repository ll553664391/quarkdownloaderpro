#!/usr/bin/env node
/**
 * 夸克网盘下载速度对照测试脚本
 *
 * 目的：找出下载速度的真正瓶颈（账号/CDN 限速 vs 连接数不足），
 *       测试线程数、并发文件数对速度的实际影响，为调优提供依据。
 *
 * 依赖：Node.js >= 18（原生 fetch），需先启动 Tauri 应用（内嵌 API 服务）。
 *
 * 用法：
 *   node scripts/speed-test.mjs login                     # 扫码登录（cookie 缓存到 scripts/.quark-cookie.json）
 *   node scripts/speed-test.mjs cookie "<原始 cookie>"     # 直接写入 cookie 缓存
 *   node scripts/speed-test.mjs test <分享链接> [选项]
 *
 * test 选项：
 *   --window 10        每档测速采样秒数（默认 10）
 *   --threads 1,2,4,8,16,32   单文件多线程档位
 *   --conc 1,2,4       多文件并发档位（每文件固定 4 线程）
 *
 * 示例：
 *   node scripts/speed-test.mjs test "https://pan.quark.cn/s/1e1e4f1bf254#/list/share/096d32df621f444cb26bae54755f494d"
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://127.0.0.1:3000/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = path.join(SCRIPT_DIR, '.quark-cookie.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMB = (bytes) => (bytes / 1024 / 1024).toFixed(2);

// ── cookie 缓存 ──────────────────────────────────────────────

function loadCookie() {
    if (existsSync(COOKIE_FILE)) {
        try {
            const { cookie } = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
            if (cookie) return cookie;
        } catch { /* ignore */ }
    }
    return null;
}

function saveCookie(cookie) {
    writeFileSync(COOKIE_FILE, JSON.stringify({ cookie, saved_at: new Date().toISOString() }, null, 2));
    console.log(`[cookie] 已缓存到 ${COOKIE_FILE}`);
}

// ── 内嵌 API 调用（自动带 x-cookie，自动合并 __puus） ─────────

let sessionCookie = null;
let puus = '';

async function api(route, { method = 'GET', body, useCookie = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (useCookie && sessionCookie) headers['x-cookie'] = sessionCookie;
    const res = await fetch(`${API}${route}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    // 代理透传的 x-append-cookie：拿到 __puus，下载 CDN 链接时需要
    const append = res.headers.get('x-append-cookie');
    if (append) {
        puus = append.split(';').find((c) => c.trim().startsWith('__puus='))?.trim() || puus;
        console.log('[cookie] 已捕获 __puus');
    }
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return { httpStatus: res.status, ...json, _res: res };
}

function okOrThrow(r, what) {
    const code = r.status ?? r.code;
    // 夸克 API 成功码：2000000（部分接口为 200 / ok）
    const ok = code === 2000000 || code === 200 || r.ok === true || r.httpStatus === 200 && r.data !== undefined;
    if (!ok) throw new Error(`${what} 失败: code=${code} message=${r.message ?? r.error ?? '未知'}`);
}

// ── CDN 下载测速 ─────────────────────────────────────────────

function downloadHeaders(extra = {}) {
    let cookie = sessionCookie || '';
    if (puus && !cookie.includes('__puus=')) cookie = cookie ? `${cookie}; ${puus}` : puus;
    return {
        'User-Agent': UA,
        'Cookie': cookie,
        'Referer': 'https://pan.quark.cn/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        ...extra,
    };
}

/** 手动跟随 302（Node fetch 跨域重定向会剥掉 Cookie/Range 头，必须逐跳重带头，与 Rust 端行为一致） */
async function fetchWithRedirects(url, extraHeaders = {}, maxRedirects = 6) {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const res = await fetch(current, {
            headers: downloadHeaders(extraHeaders),
            redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new Error(`重定向缺少 location (${res.status})`);
            current = new URL(loc, current).href;
            continue;
        }
        return { res, finalUrl: current, hops: hop };
    }
    throw new Error(`重定向超过 ${maxRedirects} 次`);
}

/** 探测文件大小与 Range 支持（走 Rust 端 /api/speedtest，与应用同引擎） */
async function probeFile(url) {
    const r = await api('/speedtest', {
        method: 'POST',
        body: { url, cookie: buildCookieHeader(), threads: 1, seconds: 1 },
    });
    if (r.error) throw new Error(`CDN 探测失败: ${r.error}`);
    return { total: r.total || 0, range: !!r.accept_ranges };
}

/** 合并后的下载 Cookie 头：在末尾追加最新 __puus（CDN 校验取最后一个 __puus，与前端应用行为一致） */
function buildCookieHeader() {
    const c = sessionCookie || '';
    return puus ? `${c}; ${puus}` : c;
}

/**
 * 在 windowMs 时间内以 threads 并发下载，返回累计字节（Rust 端 reqwest 引擎）。
 */
async function downloadSegment(url, start, end, windowMs, threads = 1) {
    const r = await api('/speedtest', {
        method: 'POST',
        body: { url, cookie: buildCookieHeader(), threads, seconds: Math.ceil(windowMs / 1000) },
    });
    if (r.error) throw new Error(`测速失败: ${r.error}`);
    return r.bytes || 0;
}

/** 单个 URL、N 线程分块并发，测 windowMs 内的总字节 */
async function measureUrl(url, total, threads, windowMs) {
    return downloadSegment(url, 0, Infinity, windowMs, threads);
}

// ── 从 WebView2 localStorage 落盘文件提取 cookie（应用已登录时免扫码） ──

const APP_IDENTIFIER = 'com.quark.downloader';
/** 夸克 cookie 的特征字段 */
const COOKIE_KEYS = /(^|; )__(pus|puus|kp|kt|kps|ktd)=|(^|; )ctoken=|(^|; )uid=/;

function looksLikeCookie(s) {
    if (!COOKIE_KEYS.test(s)) return false;
    const parts = s.split(';').map((p) => p.trim());
    const pairs = parts.filter((p) => /^[^\s=]+=[^\s=]*$/.test(p));
    return pairs.length >= 4;
}

function extractCookieFromWebView() {
    const leveldbDir = path.join(process.env.LOCALAPPDATA || '', APP_IDENTIFIER, 'EBWebView', 'Default', 'Local Storage', 'leveldb');
    if (!existsSync(leveldbDir)) {
        throw new Error(`未找到 WebView 存储目录: ${leveldbDir}（应用是否在本机登录过？）`);
    }
    // 复制到临时目录（leveldb 可能被运行中的应用锁定，只读复制即可）
    const tmp = path.join(os.tmpdir(), `quark-cookie-extract-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    const candidates = new Map();
    try {
        for (const name of readdirSync(leveldbDir)) {
            if (!/\.(log|ldb)$/.test(name)) continue;
            try { copyFileSync(path.join(leveldbDir, name), path.join(tmp, name)); } catch { continue; }
            const buf = readFileSync(path.join(tmp, name));
            // localStorage 记录布局：... quark_cookie <非ASCII标记字节> <cookie 全文（latin1，含空格）> <非ASCII结束>
            // 定位 key 后，跳过标记字节，连续读取可打印 ASCII 直到非可打印边界
            const keyBuf = Buffer.from('quark_cookie', 'latin1');
            let idx = 0;
            for (;;) {
                const k = buf.indexOf(keyBuf, idx);
                if (k === -1) break;
                idx = k + keyBuf.length;
                let j = idx;
                while (j < buf.length && (buf[j] < 0x21 || buf[j] > 0x7e)) j++; // 跳过标记字节
                let end = j;
                while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7e) end++; // 读到边界
                const cand = buf.slice(j, end).toString('latin1');
                if (looksLikeCookie(cand)) {
                    candidates.set(cand, (candidates.get(cand) ?? 0) + 1);
                }
            }
        }
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
    if (candidates.size === 0) {
        throw new Error('未在 WebView 存储中找到 cookie（应用登录后需操作过一次页面让 localStorage 落盘）');
    }
    // 优先含 __puus 的，其次最长的（字段最全）
    const best = [...candidates.keys()]
        .sort((a, b) => (Number(b.includes('__puus=')) - Number(a.includes('__puus='))) || b.length - a.length)[0];
    return best;
}

async function cmdExtract() {
    const cookie = extractCookieFromWebView();
    // 预览关键字段确认有效性
    const keys = cookie.split(';').map((p) => p.trim().split('=')[0]).filter(Boolean);
    console.log(`[extract] 提取到 cookie，共 ${keys.length} 个字段: ${keys.join(', ')}`);
    if (!cookie.includes('__puus=')) console.log('[extract] 警告: 该 cookie 缺少 __puus，下载可能受限（应用获取过下载链接后才会写入）');
    saveCookie(cookie);
}

// ── 登录 ─────────────────────────────────────────────────────

async function cmdLogin() {
    const r = await api('/qrlogin/token', { useCookie: false });
    okOrThrow(r, '获取二维码 token');
    const token = r.data?.members?.token;
    if (!token) throw new Error('未取到 qr token');
    const qrUrl = `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S:custom%7COPT:SAREA%400%7COPT:IMMERSIVE%401%7COPT:BACK_BTN_STYLE%400`;
    console.log('\n请用浏览器打开下面的链接，并用【夸克 App】扫码确认登录：\n');
    console.log(qrUrl + '\n');

    for (let i = 0; i < 90; i++) {
        await sleep(2000);
        const q = await api(`/qrlogin/query?token=${encodeURIComponent(token)}`, { useCookie: false });
        const st = q.data?.members?.service_ticket;
        if (st) {
            const c = await api(`/qrlogin/cookie?service_ticket=${encodeURIComponent(st)}`, { useCookie: false });
            if (c.cookie) {
                saveCookie(c.cookie);
                if (c.missing_puus) console.log('[cookie] 警告: 缺少 __puus，下载可能受限');
                else console.log('[cookie] 登录成功');
                return;
            }
        }
        process.stdout.write(`\r[等待扫码确认] ${i * 2}s `);
    }
    throw new Error('登录超时');
}

// ── 分享解析 + 测速 ──────────────────────────────────────────

function parseShareUrl(url) {
    const m = url.match(/\/s\/([0-9a-f]+)\/?/i);
    const pid = url.match(/#\/list\/share\/([0-9a-f]+)/i)?.[1] || '0';
    if (!m) throw new Error('无法从链接解析 pwd_id');
    return { pwdId: m[1], pdirFid: pid };
}

async function walkShare(pwdId, stoken, rootFid) {
    const files = [];
    const queue = [rootFid];
    while (queue.length > 0 && files.length < 500) {
        const fid = queue.shift();
        for (let page = 1; page < 40; page++) {
            const r = await api(`/share/detail?pwd_id=${pwdId}&stoken=${encodeURIComponent(stoken)}&pdir_fid=${fid}&force=0&_page=${page}&_size=50&_fetch_total=1&_fetch_sub_dirs=0&_sort=file_type:asc,file_name:asc`);
            okOrThrow(r, '获取分享详情');
            const list = r.data?.list ?? [];
            for (const item of list) {
                if (item.dir) queue.push(item.fid);
                else if (item.size > 0) files.push(item);
            }
            if (list.length < 50) break;
        }
    }
    return files;
}

async function saveAndGetUrls(pwdId, stoken, files) {
    console.log(`\n[流程] 批量转存 ${files.length} 个文件...`);
    const sr = await api('/share/save', {
        method: 'POST',
        body: {
            fid_list: files.map((f) => f.fid),
            fid_token_list: files.map((f) => f.share_fid_token),
            to_pdir_fid: '0', pwd_id: pwdId, stoken, pdir_fid: '0', scene: 'link',
        },
    });
    okOrThrow(sr, '批量转存');
    const taskId = sr.data?.task_id;

    let savedFids = [];
    for (let r = 0; r < 20; r++) {
        await sleep(500);
        const tr = await api(`/task?task_id=${taskId}&retry_index=${r}`);
        if (tr.data?.status === 2) {
            savedFids = tr.data?.save_as?.save_as_top_fids ?? [];
            break;
        }
    }
    if (savedFids.length === 0) throw new Error('转存超时或未获取到文件 ID');
    console.log(`[流程] 转存成功 ${savedFids.length} 个`);

    console.log('[流程] 批量获取下载链接...');
    const dr = await api('/file/download', { method: 'POST', body: { fids: savedFids } });
    okOrThrow(dr, '获取下载链接');
    const items = dr.data ?? [];
    const urlByFid = new Map();
    items.forEach((item, i) => {
        const fid = item.fid || savedFids[i];
        if (item.download_url) urlByFid.set(fid, item.download_url);
    });
    return { savedFids, urlByFid };
}

async function cleanup(savedFids) {
    if (savedFids.length === 0) return;
    console.log('\n[清理] 删除转存文件...');
    try {
        await api('/file/delete', { method: 'POST', body: { action_type: 2, filelist: savedFids, exclude_fids: [] } });
        console.log('[清理] 完成');
    } catch (e) {
        console.log(`[清理] 失败（请手动检查网盘）: ${e.message}`);
    }
}

function printRow(name, bytes, windowMs) {
    const speed = (bytes / 1024 / 1024) / (windowMs / 1000);
    const bar = '█'.repeat(Math.min(30, Math.round(speed)));
    console.log(`${name.padEnd(24)} ${fmtMB(bytes).padStart(9)} MB  ${speed.toFixed(2).padStart(7)} MB/s  ${bar}`);
}

/** 用系统 curl（schannel TLS 指纹）测试 CDN 是否放行，对照 Node fetch 的 412 */
function curlProbe(url, range) {
    const args = ['-s', '-o', 'NUL', '-w', '%{http_code} %{size_download}', '--max-time', '8',
        '-A', UA, '-H', 'Referer: https://pan.quark.cn/',
        '-H', `Cookie: ${sessionCookie}${puus ? '; ' + puus : ''}`];
    if (range) args.push('-r', range);
    args.push(url);
    try {
        const out = execFileSync('curl.exe', args, { encoding: 'utf-8', timeout: 15000 });
        return out.trim();
    } catch (e) {
        return `curl-failed: ${e.status ?? ''} ${String(e.stdout ?? e.message).slice(0, 80)}`;
    }
}

async function cmdTest(args) {
    const shareUrl = args._[0];
    if (!shareUrl) throw new Error('缺少分享链接参数');
    const windowMs = (args.window ?? 10) * 1000;
    const threadList = String(args.threads ?? '1,2,4,8,16,32').split(',').map(Number);
    const concList = String(args.conc ?? '1,2,4').split(',').map(Number);

    const cookie = loadCookie();
    if (!cookie) throw new Error('未找到 cookie，请先执行: node scripts/speed-test.mjs login');
    sessionCookie = cookie;

    // 健康检查：需先启动 Tauri 应用
    const h = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
    if (!h?.ok) throw new Error(`内嵌 API 服务不可用（${API}/health），请先启动应用`);

    const { pwdId, pdirFid } = parseShareUrl(shareUrl);
    console.log(`[分享] pwd_id=${pwdId} pdir_fid=${pdirFid}`);

    console.log('[分享] 获取 stoken...');
    const tr = await api('/share/token', { method: 'POST', body: { pwd_id: pwdId, passcode: '' } });
    okOrThrow(tr, '获取 stoken');
    const stoken = tr.data.stoken;

    console.log('[分享] 遍历文件列表（含子目录）...');
    const files = await walkShare(pwdId, stoken, pdirFid);
    if (files.length === 0) throw new Error('分享内没有可下载文件');
    console.log(`[分享] 共 ${files.length} 个文件，总 ${(files.reduce((a, f) => a + f.size, 0) / 1024 / 1024).toFixed(1)} MB`);

    // 选测速文件：最大的 4 个（转存上限内），最大者做单文件多线程测试
    const top = [...files].sort((a, b) => b.size - a.size).slice(0, Math.max(4, concList[concList.length - 1]));
    const main = top[0];
    console.log(`[选择] 主测文件: ${main.file_name} (${fmtMB(main.size)} MB)`);
    top.slice(1).forEach((f) => console.log(`        并发候选: ${f.file_name} (${fmtMB(f.size)} MB)`));

    const { savedFids, urlByFid } = await saveAndGetUrls(pwdId, stoken, top);

    // --diag：诊断 CDN 放行策略（cookie 组合对照）
    if (args.diag) {
        const mainUrl = urlByFid.get(savedFids[0]);
        const variants = {
            'a-原样sessionCookie': sessionCookie,
            'b-追加新puus': `${sessionCookie}; ${puus}`,
            'c-覆盖新puus': buildCookieHeader(),
            'd-仅新puus': puus,
        };
        console.log('\n═══ CDN 诊断：cookie 组合对照（Rust 引擎 2s 探测 + curl 对照）═══');
        for (const [name, cookie] of Object.entries(variants)) {
            const r = await api('/speedtest', { method: 'POST', body: { url: mainUrl, cookie, threads: 1, seconds: 2 } });
            console.log(`${name.padEnd(22)} Rust: ${r.error ?? r.bytes + ' bytes'}`);
        }
        console.log('curl GET(原样+追加) :', curlProbe(mainUrl, '0-999999').slice(0, 60));
        await cleanup(savedFids);
        return;
    }

    const results = {};
    try {
        const mainUrl = urlByFid.get(savedFids[0]);
        if (!mainUrl) throw new Error('主测文件未拿到下载链接');
        const probe = await probeFile(mainUrl);
        console.log(`\n[探测] 文件大小 ${fmtMB(probe.total)} MB，Range 支持: ${probe.range ? '是' : '否（CDN 不支持分块，多线程无效）'}`);
        results.range = probe.range;

        // 测试 A：单文件线程数扩展
        console.log(`\n═══ 测试 A：单文件 × 线程数（每档采样 ${windowMs / 1000}s，主测文件）═══`);
        results.threads = {};
        for (const t of threadList) {
            process.stdout.write(`  测试 ${t} 线程...\r`);
            try {
                const bytes = await measureUrl(mainUrl, probe.total, t, windowMs);
                results.threads[t] = bytes;
                printRow(`单文件 × ${t} 线程`, bytes, windowMs);
            } catch (e) {
                console.log(`  ${t} 线程测试失败: ${e.message}`);
            }
        }

        // 测试 B：文件数 × 固定 4 线程
        console.log(`\n═══ 测试 B：文件并发 × 4 线程/文件 ═══`);
        results.concurrency = {};
        for (const c of concList) {
            process.stdout.write(`  测试 ${c} 文件并发...\r`);
            const picked = top.slice(0, c).map((f, i) => ({ url: urlByFid.get(savedFids[i]), size: f.size }));
            if (picked.some((p) => !p.url)) { console.log('  链接不足，跳过'); continue; }
            const bytes = (await Promise.all(
                picked.map((p) => measureUrl(p.url, p.size, Math.min(4, p.size), windowMs))
            )).reduce((a, b) => a + b, 0);
            results.concurrency[c] = bytes;
            printRow(`${c} 文件 × 4 线程`, bytes, windowMs);
        }
    } finally {
        await cleanup(savedFids);
    }

    // 结论分析
    console.log('\n═══ 分析结论 ═══');
    const t = results.threads ?? {};
    const spd = (bytes) => (bytes / 1024 / 1024) / (windowMs / 1000);
    const s1 = spd(t[1] ?? 0), s32 = spd(t[32] ?? Math.max(...Object.values(t)));
    const bestT = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    const c4 = spd(results.concurrency?.[4] ?? 0);
    const bestC = Object.entries(results.concurrency ?? {}).sort((a, b) => b[1] - a[1])[0];

    if (!results.range) {
        console.log('· CDN 链接不支持 Range 分块 → 多线程无效，只能靠提高文件并发数');
    } else if (s32 < s1 * 1.5) {
        console.log('· 线程数增加对速度几乎无影响 → 疑似账号/CDN 级限速（非会员限速），调连接数无效');
    } else {
        console.log(`· 多线程有效：${bestT[0]} 线程时最快（${spd(bestT[1]).toFixed(2)} MB/s），建议提高单文件线程数`);
    }
    if (bestC && Object.keys(results.threads ?? {}).length > 0) {
        console.log(`· 文件并发：${bestC[0]} 文件时聚合 ${spd(bestC[1]).toFixed(2)} MB/s${c4 > s32 ? '，高于单文件 32 线程 → 提高并发上限更有价值' : ''}`);
    }
    const allMax = Math.max(...Object.values(t ?? {}), ...Object.values(results.concurrency ?? {}));
    if (spd(allMax) < 3) {
        console.log('· 所有档位速度都 < 3 MB/s → 大概率是账号级限速（非会员），需要开会员或换网络环境验证');
    }
    console.log('\n[完成] 测试结果已打印，可据此调整线程/并发策略');
}

// ── 入口 ─────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const args = { _: [] };
    for (let i = 1; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            // 无值或下一个也是 -- 开头的选项 → true
            args[argv[i].slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i];
        } else {
            args._.push(argv[i]);
        }
    }

    if (cmd === 'cookie') {
        if (!args._[0]) throw new Error('用法: node scripts/speed-test.mjs cookie "<原始 cookie>"');
        saveCookie(args._[0]);
        return;
    }
    if (cmd === 'extract') return cmdExtract();
    if (cmd === 'login') return cmdLogin();
    if (cmd === 'test') return cmdTest(args);

    console.log('用法：');
    console.log('  node scripts/speed-test.mjs extract              # 从已登录应用的 WebView 存储提取 cookie（推荐）');
    console.log('  node scripts/speed-test.mjs login                # 扫码登录');
    console.log('  node scripts/speed-test.mjs cookie "<cookie>"    # 直接写入 cookie');
    console.log('  node scripts/speed-test.mjs test <分享链接> [--window 10] [--threads 1,2,4,8,16,32] [--conc 1,2,4]');
}

main().catch((e) => {
    console.error(`\n[错误] ${e.message}`);
    process.exit(1);
});
