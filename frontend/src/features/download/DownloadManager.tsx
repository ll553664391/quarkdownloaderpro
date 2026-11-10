import React, { useEffect, useRef, useState } from 'react';
import { CheckSquare, Square, Zap, FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useQuarkStore } from '../../store/useQuarkStore';
import { quarkApi } from '../../services/quarkApi';
import { sleep } from '../../utils';
import { formatSize, cn, getErrorMessage } from '../../utils';
import { Button } from '../../components/ui/button';
import type { ShareFileNode } from '../../types/quark';

interface DownloadProgressEvent {
    id: string;
    filename: string;
    downloaded: number;
    total: number;
    speed?: number;
    status?: string;
}

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
        updateDownload,
        removeDownload,
        clearAllDownloads,
        addLog,
        clearLogs,
        cookie,
        isLoggedIn,
        downloadConcurrency,
        downloadThreads,
        downloadDir,
        setDownloadDir,
        notify
    } = useQuarkStore();

    const stopRef = useRef(false);
    const [lastSavePath, setLastSavePath] = useState('');

    // 监听 Rust 端发送的 download-progress 事件，按 id 更新 activeDownloads
    useEffect(() => {
        const unlisten = listen<DownloadProgressEvent>('download-progress', (event) => {
            const { id, filename, downloaded, total, speed, status } = event.payload;

            if (status === 'done') {
                // 下载完成，延迟移除让用户看到 100%
                updateDownload(id, { filename, downloaded, total, speed: 0, status: 'done' });
                setTimeout(() => removeDownload(id), 2000);
                return;
            }

            updateDownload(id, {
                filename,
                downloaded,
                total,
                speed: speed ?? 0,
                status: status === 'merging' ? 'merging' : 'downloading',
            });
        });

        return () => {
            unlisten.then(fn => fn());
        };
    }, [updateDownload, removeDownload]);

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

    const triggerDownload = async (url: string, filename: string, relativePath?: string) => {
        try {
            const result = await invoke('download_file', {
                url,
                cookie,
                filename,
                threadCount: downloadThreads,
                saveDir: downloadDir || null,
                relativePath: relativePath || null,
            });
            const res = result as { path?: string; size?: number };
            if (res.path) setLastSavePath(res.path);
            addLog(`  已保存到: ${res.path ?? '未知路径'}`, 'success');
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            // 主动停止触发的取消不算失败
            if (message.includes('取消')) {
                addLog(`  已停止: ${filename}`, 'warn');
                return;
            }
            addLog(`下载失败: ${message}`, 'error');
            notify(`下载失败: ${message}`, 'error');
        }
    };

    const handleStop = () => {
        stopRef.current = true;
        // 立即中断 Rust 端所有下载任务（abort 全部活跃任务，覆盖任何挂起环节）
        invoke('cancel_downloads').catch(() => {});
        // 立即恢复 UI，后台 worker 自行收尾退出
        setDownloading(false);
        setTaskStartedAt(0);
        setProgress(0, 0, '');
        clearAllDownloads();
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
        stopRef.current = false;
        setDownloading(true);
        setTaskStartedAt(Date.now());
        clearLogs();

        try {
            const total = filesToDownload.length;
            let done = 0;
            let skipped = 0;
            let nextIndex = 0;
            const concurrency = Math.min(downloadConcurrency, total);

            if (total === 0) {
                addLog('没有可处理的文件', 'warn');
                notify('没有可处理的文件', 'warn');
                return;
            }

            setProgress(0, total, `准备中...`);
            addLog(`开始批量处理，共 ${total} 个文件，并发 ${concurrency}`);

            const processFile = async (index: number) => {
                if (stopRef.current) return;
                const f = filesToDownload[index];

                // 文件级断点续传：目标文件已存在（上次已完整下载）则跳过，不再转存/下载
                try {
                    const exists = await invoke<boolean>('check_file_exists', {
                        saveDir: downloadDir || null,
                        relativePath: f.path || null,
                        filename: f.file_name,
                    });
                    if (exists) {
                        skipped += 1;
                        addLog(`[${index + 1}/${total}] 已存在，跳过: ${f.file_name}`);
                        return;
                    }
                } catch {
                    // 检查失败时照常下载
                }

                addLog(`[${index + 1}/${total}] 正在处理: ${f.file_name}`);

                let savedFid: string | null = null;
                try {
                    addLog('  正在转存到网盘...');
                    const sr = await quarkApi.saveFiles(
                        shareInfo.pwdId,
                        shareInfo.stoken,
                        [f.fid],
                        [f.share_fid_token]
                    );

                    if (sr.status !== 200 || !sr.data) {
                        throw new Error(sr.message || '转存失败');
                    }

                    const taskId = sr.data.task_id;

                    for (let r = 0; r < 20; r++) {
                        if (stopRef.current) return;
                        await sleep(500);
                        const tr = await quarkApi.queryTask(taskId, r);
                        if (tr.data && tr.data.status === 2) {
                            savedFid = tr.data.save_as?.save_as_top_fids?.[0] ?? null;
                            break;
                        }
                    }

                    if (stopRef.current) return;

                    if (!savedFid) {
                        addLog('  转存超时或未获取到文件 ID，跳过', 'warn');
                        return;
                    }

                    addLog('  获取下载链接...');
                    const dl = await quarkApi.getDownloadUrl([savedFid]);
                    if (dl.status === 200 && dl.data?.[0]?.download_url) {
                        // 拿到 CDN URL 后立即删除转存文件（URL 自带鉴权 token，删除后仍有效）
                        try {
                            await quarkApi.deleteFiles([savedFid]);
                            addLog('  转存文件已清理');
                        } catch (e: unknown) {
                            addLog(`  转存清理失败: ${getErrorMessage(e)}`, 'warn');
                        }
                        savedFid = null; // 已删除，防止 finally 重复处理

                        await triggerDownload(dl.data[0].download_url, f.file_name, f.path);
                    } else {
                        addLog(`  获取链接失败: ${dl.message || '未知错误'}`, 'error');
                    }
                } catch (error: unknown) {
                    const message = getErrorMessage(error);
                    addLog(`  处理出错: ${message}`, 'error');
                } finally {
                    // 如果在获取下载链接之前就失败了，savedFid 仍不为 null，需要兜底清理
                    if (savedFid) {
                        try {
                            await quarkApi.deleteFiles([savedFid]);
                            addLog('  转存文件已兜底清理');
                        } catch (e: unknown) {
                            addLog(`  兜底清理失败: ${getErrorMessage(e)}`, 'warn');
                        }
                    }

                    done += 1;
                    if (done >= total) {
                        setProgress(done, total, '全部完成');
                        setTimeout(() => {
                            setProgress(0, 0, '');
                        }, 3000);
                    } else {
                        const progressText = `正在处理 ${done}/${total}`;
                        setProgress(done, total, progressText);
                    }
                }
            };

            const worker = async () => {
                while (!stopRef.current) {
                    const index = nextIndex;
                    nextIndex += 1;
                    if (index >= total) return;

                    await processFile(index);

                    if (stopRef.current) return;

                    if (nextIndex < total) {
                        await sleep(300);
                    }
                }
            };

            await Promise.all(Array.from({ length: concurrency }, () => worker()));

            if (stopRef.current) {
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
                        <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter">线程 {downloadThreads} · 并行 {downloadConcurrency}</span>
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