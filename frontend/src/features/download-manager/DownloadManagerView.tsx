import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import {
    Download,
    Clock,
    RefreshCw,
    Zap,
    Layers,
    CheckCircle2,
    XCircle,
    SkipForward,
    Ban,
    Trash2,
    Square,
    FolderOpen,
} from 'lucide-react';
import { useQuarkStore, type DownloadTask, type DownloadTaskStatus } from '../../store/useQuarkStore';
import { cn, formatSize, fmtDuration, getErrorMessage } from '../../utils';
import { Button } from '../../components/ui/button';

/** 各状态的展示配置 */
const STATUS_META: Record<DownloadTaskStatus, { label: string; icon: React.ElementType; className: string; spin?: boolean }> = {
    pending: { label: '排队中', icon: Clock, className: 'text-slate-400 dark:text-slate-500 bg-slate-100/80 dark:bg-slate-700/50' },
    saving: { label: '转存中', icon: RefreshCw, className: 'text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-500/15', spin: true },
    downloading: { label: '下载中', icon: Zap, className: 'text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-500/15' },
    merging: { label: '合并中', icon: Layers, className: 'text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-500/15', spin: true },
    done: { label: '已完成', icon: CheckCircle2, className: 'text-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/15' },
    failed: { label: '已失败', icon: XCircle, className: 'text-rose-600 dark:text-rose-300 bg-rose-50 dark:bg-rose-500/15' },
    skipped: { label: '已存在', icon: SkipForward, className: 'text-sky-600 dark:text-sky-300 bg-sky-50 dark:bg-sky-500/15' },
    stopped: { label: '已停止', icon: Ban, className: 'text-slate-500 dark:text-slate-400 bg-slate-100/80 dark:bg-slate-700/50' },
};

const ACTIVE_STATUSES: DownloadTaskStatus[] = ['pending', 'saving', 'downloading', 'merging'];

const TaskRow: React.FC<{ task: DownloadTask }> = ({ task }) => {
    const meta = STATUS_META[task.status];
    const Icon = meta.icon;
    const isActive = ACTIVE_STATUSES.includes(task.status);
    const total = task.total || task.size;
    const percent = task.status === 'done' || task.status === 'skipped'
        ? 100
        : total > 0
            ? Math.min(100, Math.round((task.downloaded / total) * 100))
            : 0;
    const activePercent = task.status === 'done' || task.status === 'skipped'
        ? 100
        : total > 0
            ? Math.min(100, (task.downloaded / total) * 100)
            : 0;

    return (
        <motion.div
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
                "flex items-center gap-4 px-4 py-3 rounded-2xl border transition-colors",
                "bg-white/60 dark:bg-slate-800/40 border-slate-200/60 dark:border-slate-700/50",
                isActive && "border-indigo-200/70 dark:border-indigo-500/30"
            )}
        >
            {/* 状态图标 */}
            <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center shrink-0", meta.className)}>
                <Icon size={16} className={meta.spin ? 'animate-spin' : undefined} />
            </div>

            {/* 文件名 + 进度条 */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-3 mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate" title={task.filename}>
                            {task.filename}
                        </span>
                        {task.relativePath && (
                            <span className="text-[9px] font-medium text-slate-400 dark:text-slate-500 truncate shrink-0 max-w-[180px]" title={task.relativePath}>
                                {task.relativePath}
                            </span>
                        )}
                        {task.status === 'failed' && task.error && (
                            <span className="text-[9px] font-medium text-rose-500 dark:text-rose-400 truncate shrink-0 max-w-[200px]" title={task.error}>
                                {task.error}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 tabular-nums">
                        {isActive && task.status === 'downloading' && task.speed > 0 && (
                            <span className="text-[10px] font-bold text-emerald-500 dark:text-emerald-400">
                                {(task.speed / 1e6).toFixed(1)} MB/s
                            </span>
                        )}
                        {task.status !== 'pending' && task.status !== 'saving' && (
                            <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                                {task.status === 'done' || task.status === 'skipped'
                                    ? formatSize(task.size)
                                    : `${formatSize(task.downloaded)} / ${formatSize(total)}`}
                            </span>
                        )}
                        <span className={cn(
                            "text-[10px] font-black w-9 text-right",
                            isActive ? "text-indigo-600 dark:text-indigo-300" : "text-slate-400 dark:text-slate-500"
                        )}>
                            {percent}%
                        </span>
                    </div>
                </div>
                <div className="h-1.5 w-full bg-slate-100 dark:bg-slate-700/60 rounded-full overflow-hidden">
                    <motion.div
                        className={cn(
                            "h-full rounded-full",
                            task.status === 'done' || task.status === 'skipped'
                                ? "bg-emerald-500"
                                : task.status === 'failed'
                                    ? "bg-rose-500"
                                    : task.status === 'merging'
                                        ? "bg-amber-500"
                                        : "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.4)]"
                        )}
                        initial={{ width: 0 }}
                        animate={{ width: `${activePercent}%` }}
                        transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                    />
                </div>
            </div>

            {/* 状态标签 */}
            <span className={cn("shrink-0 px-2 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap", meta.className)}>
                {meta.label}
            </span>
        </motion.div>
    );
};

export const DownloadManagerView: React.FC = () => {
    const {
        downloadTasks,
        downloading,
        taskStartedAt,
        taskTotalBytes,
        taskFinishedBytes,
        markTasksStopped,
        setDownloading,
        setTaskStartedAt,
        setProgress,
        clearAllDownloads,
        resetTaskBytes,
        setStopRequested,
        clearDownloadTasks,
        addLog,
        notify,
    } = useQuarkStore();

    const tasks = useMemo(() => Array.from(downloadTasks.values()), [downloadTasks]);

    const counts = useMemo(() => {
        let active = 0, done = 0, failed = 0;
        let activeDownloaded = 0, activeSpeed = 0;
        for (const t of tasks) {
            if (ACTIVE_STATUSES.includes(t.status)) {
                active += 1;
                activeDownloaded += t.downloaded;
                // 仅下载中任务计入网速：排队/转存/合并阶段 speed 为残留值，计入会误导
                if (t.status === 'downloading') activeSpeed += t.speed;
            } else if (t.status === 'done' || t.status === 'skipped') done += 1;
            else if (t.status === 'failed') failed += 1;
        }
        return { active, done, failed, activeDownloaded, activeSpeed };
    }, [tasks]);

    // 每秒跳动一次时钟，驱动"已用时间"显示
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!taskStartedAt) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [taskStartedAt]);

    // 任务字节口径，与任务栏进度条一致：已完成文件字节 + 活跃文件实时字节
    const taskDownloaded = taskFinishedBytes + counts.activeDownloaded;
    const taskTotal = Math.max(taskTotalBytes, taskDownloaded);
    const taskPercent = taskTotal > 0 ? Math.min(100, Math.round((taskDownloaded / taskTotal) * 100)) : 0;

    const elapsedSec = taskStartedAt ? Math.max(0, Math.floor((now - taskStartedAt) / 1000)) : 0;
    const avgSpeed = elapsedSec > 0 ? taskDownloaded / elapsedSec : 0;
    const estSpeed = counts.activeSpeed > 0 ? counts.activeSpeed : avgSpeed;
    const remainingSec = estSpeed > 0 && taskTotal > taskDownloaded
        ? Math.round((taskTotal - taskDownloaded) / estSpeed)
        : null;

    const handleStop = () => {
        // 先同步置全局停止标志：解析页流水线（startDownload）读到后立即中断，
        // 避免 cancel_downloads 换新 epoch 后流水线又为剩余文件拉起新下载
        setStopRequested(true);
        invoke('cancel_downloads').catch(() => {});
        setDownloading(false);
        setTaskStartedAt(0);
        setProgress(0, 0, '');
        clearAllDownloads();
        markTasksStopped();
        resetTaskBytes();
        addLog('已从下载管理页停止全部任务', 'warn');
        notify('任务已停止', 'warn');
    };

    const handleClear = () => {
        if (downloading || counts.active > 0) return;
        clearDownloadTasks();
    };

    const canOpenFolder = tasks.some((t) => t.savedPath);

    const handleOpenFolder = async () => {
        const lastDone = [...tasks].reverse().find((t) => t.savedPath);
        if (!lastDone?.savedPath) return;
        try {
            await invoke('open_folder', { path: lastDone.savedPath });
        } catch (error: unknown) {
            notify(`打开文件夹失败: ${getErrorMessage(error)}`, 'error');
        }
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
            {/* 页面标题 */}
            <div className="flex items-center gap-3 shrink-0">
                <div className="w-10 h-10 gradient-bg rounded-2xl flex items-center justify-center text-white shadow-lg shadow-purple-200/50 dark:shadow-purple-900/30">
                    <Download size={20} />
                </div>
                <div className="flex-1">
                    <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">下载管理</h2>
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                        共 {tasks.length} 个任务 · 完成 {counts.done} · 失败 {counts.failed}
                    </p>
                </div>
                {canOpenFolder && (
                    <Button
                        onClick={handleOpenFolder}
                        variant="outline"
                        className="h-9 rounded-xl text-[11px] font-bold flex items-center gap-2"
                    >
                        <FolderOpen size={13} />
                        打开文件夹
                    </Button>
                )}
                {downloading && (
                    <Button
                        onClick={handleStop}
                        variant="outline"
                        className="h-9 rounded-xl text-[11px] font-bold flex items-center gap-2 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-500/30 hover:bg-rose-500 hover:text-white hover:border-rose-500 dark:hover:bg-rose-500 dark:hover:text-white"
                    >
                        <Square size={11} className="fill-current" />
                        停止全部
                    </Button>
                )}
                {!downloading && tasks.length > 0 && counts.active === 0 && (
                    <Button
                        onClick={handleClear}
                        variant="outline"
                        className="h-9 rounded-xl text-[11px] font-bold flex items-center gap-2 text-slate-500 dark:text-slate-400"
                    >
                        <Trash2 size={13} />
                        清空列表
                    </Button>
                )}
            </div>

            {/* 任务总览：整体进度 / 速度 / 已用与剩余时间 */}
            {downloading && tasks.length > 0 && (
                <div className="shrink-0 glass-effect rounded-[1.5rem] px-5 py-4">
                    <div className="flex items-center justify-between mb-2.5 text-xs">
                        <div className="flex items-center gap-3">
                            <span className="font-black text-indigo-600 dark:text-indigo-300 tabular-nums">整体 {taskPercent}%</span>
                            {counts.activeSpeed > 0 && (
                                <span className="font-bold text-emerald-500 dark:text-emerald-400 tabular-nums">
                                    {(counts.activeSpeed / 1e6).toFixed(1)} MB/s
                                </span>
                            )}
                            <span className="text-[10px] font-medium text-slate-400 dark:text-slate-500">
                                {formatSize(taskDownloaded)} / {formatSize(taskTotal)}
                            </span>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] font-medium text-slate-400 dark:text-slate-500 tabular-nums">
                            <span>已用 {fmtDuration(elapsedSec)}</span>
                            {remainingSec !== null && <span>剩余 {fmtDuration(remainingSec)}</span>}
                        </div>
                    </div>
                    <div className="h-2 w-full bg-slate-100 dark:bg-slate-700/60 rounded-full overflow-hidden">
                        <motion.div
                            className="h-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)] rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${taskPercent}%` }}
                            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                        />
                    </div>
                </div>
            )}

            {/* 任务列表 */}
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-2 pb-2">
                {tasks.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center space-y-3">
                        <div className="w-16 h-16 bg-slate-100/60 dark:bg-slate-800/50 rounded-3xl flex items-center justify-center text-slate-300 dark:text-slate-600">
                            <Download size={30} strokeWidth={1.5} />
                        </div>
                        <div className="space-y-1">
                            <h3 className="text-slate-700 dark:text-slate-200 font-bold">暂无下载任务</h3>
                            <p className="text-slate-400 dark:text-slate-500 text-xs max-w-xs">
                                在「解析提取」页解析链接并点击开始任务后，任务进度将在这里展示
                            </p>
                        </div>
                    </div>
                ) : (
                    tasks.map((task) => <TaskRow key={task.fid} task={task} />)
                )}
            </div>
        </div>
    );
};
