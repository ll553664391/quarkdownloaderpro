import React, { useState } from 'react';
import { CheckSquare, Square, Zap, FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQuarkStore } from '../../store/useQuarkStore';
import { quarkApi } from '../../services/quarkApi';
import { sleep } from '../../utils';
import { formatSize, cn, getErrorMessage } from '../../utils';
import { Button } from '../../components/ui/button';
import type { ShareFileNode } from '../../types/quark';

export const DownloadManager: React.FC = () => {
    const {
        shareInfo,
        selectedFids,
        selectAllFiles,
        clearSelection,
        downloading,
        setDownloading,
        setTaskStartedAt,
        setProgress,
        clearAllDownloads,
        initDownloadTasks,
        updateDownloadTask,
        markTasksStopped,
        addLog,
        clearLogs,
        cookie,
        isLoggedIn,
        downloadConcurrency,
        downloadDir,
        setDownloadDir,
        setTaskBytes,
        addFinishedBytes,
        adjustTaskTotalBytes,
        resetTaskBytes,
        setStopRequested,
        notify
    } = useQuarkStore();

    const [lastSavePath, setLastSavePath] = useState('');

    // 流水线停止检查走全局 stopRequested（store）：
    // 两个「停止」按钮（本组件与下载管理页）共享，避免本组件未挂载/局部 ref 不同步
    const isStopped = () => useQuarkStore.getState().stopRequested;

    // download-progress 事件监听已提升到 App.tsx 顶层（始终挂载），
    // 避免切 tab / 关闭悬浮面板时监听被注销导致进度与网速事件丢失

    const handleSelectAll = () => {
        if (selectedFids.size === shareInfo.allFiles.length) {
            clearSelection();
        } else {
            selectAllFiles(shareInfo.allFiles.map((f: ShareFileNode) => f.fid));
        }
    };

    const getSelectedSize = () => {
        return shareInfo.allFiles
            .filter((f: ShareFileNode) => selectedFids.has(f.fid))
            .reduce((acc: number, f: ShareFileNode) => acc + f.size, 0);
    };

    const handlePickDir = async () => {
        try {
            const dir = await invoke<string | null>('pick_download_dir');
            if (dir) {
                setDownloadDir(dir);
                addLog(`下载目录已设置为: ${dir}`, 'success');
            }
        } catch (error: unknown) {
            notify(`选择目录失败: ${getErrorMessage(error)}`, 'error');
        }
    };

    const handleOpenFolder = async () => {
        if (!lastSavePath) return;
        try {
            await invoke('open_folder', { path: lastSavePath });
        } catch (error: unknown) {
            notify(`打开文件夹失败: ${getErrorMessage(error)}`, 'error');
        }
    };

    // 线程数不再单独设置：按同时最高下载数自动调整（128/并发）。
    // 实测（scripts/speed-test.mjs，19.8GB 文件）：单连接被限速 ~290kbps，速度随连接数近线性增长，
    // 32→128 连接对应 1.14→3.43 MB/s，故总连接数上限提到 128
    const threadCount = Math.max(4, Math.min(64, Math.floor(128 / downloadConcurrency)));

    const triggerDownload = async (url: string, filename: string, downloadId: string, relativePath?: string): Promise<boolean> => {
        try {
            const result = await invoke('download_file', {
                url,
                cookie,
                filename,
                threadCount,
                saveDir: downloadDir || null,
                relativePath: relativePath || null,
                downloadId,
            });
            const res = result as { path?: string; size?: number };
            if (res.path) {
                setLastSavePath(res.path);
                updateDownloadTask(downloadId, { savedPath: res.path });
            }
            addLog(`  已保存到: ${res.path ?? '未知路径'}`, 'success');
            return true;
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            // 主动停止触发的取消不算失败
            if (message.includes('取消')) {
                addLog(`  已停止: ${filename}`, 'warn');
                return false;
            }
            addLog(`下载失败: ${message}`, 'error');
            notify(`下载失败: ${message}`, 'error');
            return false;
        }
    };

    const handleStop = () => {
        // 先同步置全局停止标志，流水线立即停；再 cancel Rust 端，
        // 防止 cancel 后流水线又用新 epoch 拉起新任务
        setStopRequested(true);
        // 立即中断 Rust 端所有下载任务（abort 全部活跃任务，覆盖任何挂起环节）
        invoke('cancel_downloads').catch(() => {});
        // 立即恢复 UI，后台 worker 自行收尾退出
        setDownloading(false);
        setTaskStartedAt(0);
        setProgress(0, 0, '');
        clearAllDownloads();
        markTasksStopped();
        resetTaskBytes();
        addLog('已发送停止指令，任务已中止', 'warn');
        notify('任务已停止', 'warn');
    };

    const startDownload = async () => {
        if (selectedFids.size === 0 || downloading) return;
        if (!isLoggedIn) {
            addLog('请先登录账号', 'warn');
            notify('请先登录账号', 'warn');
            return;
        }

        const filesToDownload = shareInfo.allFiles.filter((f: ShareFileNode) => selectedFids.has(f.fid));
        setStopRequested(false);
        // 创建迅雷式任务记录：所有选中文件进入队列（含排队/转存阶段，下载管理页全程可见）
        initDownloadTasks(filesToDownload);
        setDownloading(true);
        setTaskStartedAt(Date.now());
        clearLogs();

        try {
            const total = filesToDownload.length;
            let done = 0;
            let skipped = 0;
            const concurrency = Math.min(downloadConcurrency, total);
            // 分批流水线：转存/拿链接/清理接口均原生支持批量数组，20 个/批把每文件 2~5s 的 API 开销降低约 90%
            const BATCH_SIZE = 20;
            // 任务级字节账本：整体进度按「全部文件字节」计算，而非仅当前正在下载的文件
            const totalBytes = filesToDownload.reduce((acc: number, f: ShareFileNode) => acc + (f.size || 0), 0);
            setTaskBytes(totalBytes);

            if (total === 0) {
                addLog('没有可处理的文件', 'warn');
                notify('没有可处理的文件', 'warn');
                return;
            }

            setProgress(0, total, `准备中...`);
            addLog(`开始批量处理，共 ${total} 个文件，${BATCH_SIZE} 个/批，并发 ${concurrency}`);

            const reportProgress = () => {
                if (done >= total) {
                    setProgress(done, total, '全部完成');
                    setTimeout(() => setProgress(0, 0, ''), 3000);
                } else {
                    setProgress(done, total, `正在处理 ${done}/${total}`);
                }
            };

            for (let batchStart = 0; batchStart < total; batchStart += BATCH_SIZE) {
                if (isStopped()) break;
                const batch = filesToDownload.slice(batchStart, batchStart + BATCH_SIZE);

                // 1) 文件级断点续传：本地已存在的整批剔除，不占用转存/下载名额
                const toProcess: ShareFileNode[] = [];
                for (let i = 0; i < batch.length; i++) {
                    if (isStopped()) break;
                    const f = batch[i];
                    try {
                        const exists = await invoke<boolean>('check_file_exists', {
                            saveDir: downloadDir || null,
                            relativePath: f.path || null,
                            filename: f.file_name,
                        });
                        if (exists) {
                            skipped += 1;
                            done += 1;
                            updateDownloadTask(f.fid, { status: 'skipped', downloaded: f.size || 0 });
                            addFinishedBytes(f.size || 0);
                            addLog(`[${batchStart + i + 1}/${total}] 已存在，跳过: ${f.file_name}`);
                            reportProgress();
                            continue;
                        }
                    } catch {
                        // 检查失败时照常下载
                    }
                    toProcess.push(f);
                }
                if (isStopped()) break;
                if (toProcess.length === 0) continue;

                // 2) 批量转存（1 次 API 顶 toProcess.length 次）
                for (const f of toProcess) {
                    updateDownloadTask(f.fid, { status: 'saving', downloaded: 0, speed: 0, error: undefined });
                }
                addLog(`[转存] 批量转存 ${toProcess.length} 个文件...`);
                let savedFids: string[] = [];
                try {
                    const sr = await quarkApi.saveFiles(
                        shareInfo.pwdId,
                        shareInfo.stoken,
                        toProcess.map((f) => f.fid),
                        toProcess.map((f) => f.share_fid_token)
                    );
                    if (sr.status !== 200 || !sr.data) {
                        throw new Error(sr.message || '转存失败');
                    }
                    const taskId = sr.data.task_id;
                    for (let r = 0; r < 20; r++) {
                        if (isStopped()) break;
                        await sleep(500);
                        const tr = await quarkApi.queryTask(taskId, r);
                        if (tr.data && tr.data.status === 2) {
                            savedFids = tr.data.save_as?.save_as_top_fids ?? [];
                            break;
                        }
                    }
                    if (!isStopped() && savedFids.length === 0) {
                        throw new Error('转存超时或未获取到文件 ID');
                    }
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    addLog(`[转存] 批量转存失败: ${message}`, 'error');
                    for (const f of toProcess) {
                        updateDownloadTask(f.fid, { status: 'failed', error: message });
                        adjustTaskTotalBytes(-(f.size || 0));
                        done += 1;
                    }
                    reportProgress();
                    continue;
                }
                if (isStopped()) {
                    // 停止时兜底清理已转存文件，不留网盘垃圾
                    if (savedFids.length > 0) {
                        quarkApi.deleteFiles(savedFids).catch(() => {});
                    }
                    break;
                }

                // save_as_top_fids 与入参顺序一致；长度异常时按序号兜底
                const savedFidByIndex = toProcess.map((_, i) => savedFids[i] ?? null);

                // 3) 批量获取下载链接（1 次 API）
                addLog(`[链接] 批量获取 ${savedFids.length} 个下载链接...`);
                const urlBySavedFid = new Map<string, string>();
                try {
                    const dl = await quarkApi.getDownloadUrl(savedFids);
                    if (dl.status === 200 && dl.data) {
                        for (let i = 0; i < dl.data.length; i++) {
                            const item = dl.data[i];
                            // 优先按响应中的 fid 匹配，字段缺失时按序号兜底
                            const savedFid = (item as { fid?: string }).fid || savedFids[i];
                            if (item.download_url && savedFid) {
                                urlBySavedFid.set(savedFid, item.download_url);
                            }
                        }
                    }
                } catch (error: unknown) {
                    addLog(`[链接] 批量获取链接失败: ${getErrorMessage(error)}`, 'error');
                }

                // 4) 拿到链接后批量删除转存文件（URL 自带鉴权 token，删除后仍有效）
                if (savedFids.length > 0) {
                    try {
                        await quarkApi.deleteFiles(savedFids);
                        addLog('[清理] 本批转存文件已清理');
                    } catch (e: unknown) {
                        addLog(`[清理] 转存清理失败: ${getErrorMessage(e)}`, 'warn');
                    }
                }

                // 5) 并发下载本批（沿用同时最高下载数设置）
                let next = 0;
                const downloadOne = async (f: ShareFileNode, savedFid: string | null) => {
                    const url = savedFid ? urlBySavedFid.get(savedFid) : undefined;
                    if (!url) {
                        addLog(`  获取链接失败: ${f.file_name}`, 'error');
                        updateDownloadTask(f.fid, { status: 'failed', error: '获取链接失败' });
                        adjustTaskTotalBytes(-(f.size || 0));
                    } else {
                        updateDownloadTask(f.fid, { status: 'downloading' });
                        const ok = await triggerDownload(url, f.file_name, f.fid, f.path);
                        if (ok) {
                            addFinishedBytes(f.size || 0);
                        } else {
                            adjustTaskTotalBytes(-(f.size || 0));
                        }
                    }
                    done += 1;
                    reportProgress();
                };
                const worker = async () => {
                    while (!isStopped()) {
                        const idx = next;
                        next += 1;
                        if (idx >= toProcess.length) return;
                        await downloadOne(toProcess[idx], savedFidByIndex[idx]);
                    }
                };
                await Promise.all(Array.from({ length: concurrency }, () => worker()));
            }

            if (isStopped()) {
                // 停止提示已在 handleStop 中给出，这里仅记录汇总日志
                addLog(`任务已停止，已完成 ${done}/${total}`, 'warn');
                setProgress(0, 0, '');
            } else {
                setProgress(total, total, '全部完成');
                const summary = skipped > 0
                    ? `全部完成：新下载 ${total - skipped} 个，跳过已存在 ${skipped} 个`
                    : `全部完成，共处理 ${total} 个文件`;
                addLog(summary, 'success');
                notify(summary, 'success');
            }
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            addLog(`流程出错: ${message}`, 'error');
            notify(`流程出错: ${message}`, 'error');
        } finally {
            setDownloading(false);
            setTaskStartedAt(0);
        }
    };

    if (shareInfo.files.length === 0) return null;

    const isAllSelected = selectedFids.size === shareInfo.allFiles.length && shareInfo.allFiles.length > 0;

    return (
        <div className="shrink-0">
            {/* 增加内边距 px-5 py-2.5 以提升卡片纵向空间感 */}
            <div className="flex items-center gap-6 p-2.5 px-5 rounded-[1.2rem]">
                <div className="flex items-center gap-4">
                    <button
                        onClick={handleSelectAll}
                        className={cn(
                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all",
                            isAllSelected ? "bg-indigo-50/80 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" : "text-slate-400 dark:text-slate-500 hover:bg-slate-50/50 dark:hover:bg-slate-800/50"
                        )}
                    >
                        {isAllSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                        <span>{isAllSelected ? '取消全选' : '全选'}</span>
                    </button>

                    <div className="h-4 w-px bg-slate-200/60 dark:bg-slate-700/60" />

                    <div className="flex items-center gap-2.5 text-xs font-bold text-slate-700 dark:text-slate-200 whitespace-nowrap">
                        <span className="text-slate-400 dark:text-slate-500 font-medium text-[9px] uppercase tracking-tighter">已选</span>
                        <span className="flex items-center gap-2">
                            <span className="text-[13px]">{selectedFids.size}</span>
                            <span className="text-indigo-600 dark:text-indigo-400 font-black text-[10px] bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 rounded-md border border-indigo-100/30 dark:border-indigo-500/30">
                                {formatSize(getSelectedSize())}
                            </span>
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3 ml-auto">
                    {/* 下载目录设置 */}
                    <button
                        onClick={handlePickDir}
                        disabled={downloading}
                        title={downloadDir || '系统默认下载目录'}
                        className={cn(
                            "flex items-center gap-1.5 px-2.5 h-8 max-w-[220px] bg-slate-50/80 dark:bg-slate-800/80 rounded-lg border border-slate-100/50 dark:border-slate-700/50 transition-all",
                            downloading ? "opacity-50 cursor-not-allowed" : "hover:bg-slate-100/80 dark:hover:bg-slate-700/80 hover:border-indigo-200 dark:hover:border-indigo-500/50"
                        )}
                    >
                        <FolderOpen size={13} className="shrink-0 text-indigo-500" />
                        <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter shrink-0">下载到</span>
                        <span className="truncate text-[10px] font-bold text-slate-600 dark:text-slate-300">
                            {downloadDir || '系统默认下载目录'}
                        </span>
                    </button>

                    {/* 打开所在文件夹 */}
                    {lastSavePath && !downloading && (
                        <button
                            onClick={handleOpenFolder}
                            title={`打开: ${lastSavePath}`}
                            className="flex items-center gap-1.5 px-2.5 h-8 bg-slate-50/80 dark:bg-slate-800/80 rounded-lg border border-slate-100/50 dark:border-slate-700/50 hover:bg-slate-100/80 dark:hover:bg-slate-700/80 hover:border-indigo-200 dark:hover:border-indigo-500/50 transition-all"
                        >
                            <SquareArrowOutUpRight size={13} className="text-slate-500 dark:text-slate-400" />
                            <span className="text-[10px] font-bold text-slate-600 dark:text-slate-300">打开文件夹</span>
                        </button>
                    )}

                    <div className="hidden sm:flex items-center px-2.5 h-8 bg-slate-50/80 dark:bg-slate-800/80 rounded-lg border border-slate-100/50 dark:border-slate-700/50">
                        <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">并行 {downloadConcurrency} · 线程 {threadCount}（自动）</span>
                    </div>

                    {downloading ? (
                        <Button
                            onClick={handleStop}
                            variant="outline"
                            className="px-6 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30 hover:bg-rose-500 hover:text-white hover:border-rose-500 dark:hover:bg-rose-500 dark:hover:text-white shadow-sm active:scale-95 transition-transform"
                        >
                            <Square size={12} className="fill-current" />
                            停止任务
                        </Button>
                    ) : (
                        <Button
                            onClick={startDownload}
                            disabled={selectedFids.size === 0}
                            variant="gradient"
                            className="px-6 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 shadow-sm active:scale-95 transition-transform"
                        >
                            <Zap size={14} className="fill-white" />
                            开始任务
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
};