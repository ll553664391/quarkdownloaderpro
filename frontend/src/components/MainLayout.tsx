import React, { type ReactNode, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sidebar } from '../components/Sidebar';
import { TitleBar } from '../components/TitleBar';
import { useQuarkStore } from '../store/useQuarkStore';
import { quarkApi } from '../services/quarkApi';
import { AuthModal } from '../features/auth/AuthModal';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { cn, formatSize, getErrorMessage } from '../utils';

/** 秒数 → mm:ss / h:mm:ss */
const fmtDuration = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

const ToastIcon: React.FC<{ type: string }> = ({ type }) => {
    switch (type) {
        case 'success': return <CheckCircle2 size={18} className="text-emerald-400" />;
        case 'error': return <AlertCircle size={18} className="text-rose-400" />;
        case 'warn': return <AlertTriangle size={18} className="text-amber-400" />;
        case 'info': return <Info size={18} className="text-indigo-400" />;
        default: return <Zap size={18} className="text-indigo-400" />;
    }
};

interface MainLayoutProps {
    children: ReactNode;
    activeTab: string;
    setActiveTab: (tab: string) => void;
    setIsAuthOpen: (open: boolean) => void;
    isAuthOpen: boolean;
}

export const MainLayout: React.FC<MainLayoutProps> = ({
    children,
    activeTab,
    setActiveTab,
    isAuthOpen,
    setIsAuthOpen
}) => {
    const {
        isLoggedIn,
        cookie,
        setCookie,
        addLog,
        setCapacity,
        setCapacityLoading,
        activeDownloads,
        progress,
        downloading,
        taskStartedAt,
        toast,
        notify,
        setLoggingOut,
    } = useQuarkStore();

    // 将活跃下载转为数组，计算百分比
    const dlEntries = useMemo(() => {
        if (activeDownloads.size === 0) return [];
        return Array.from(activeDownloads.entries()).map(([id, info]) => ({
            id,
            ...info,
            percent: info.total > 0 ? Math.round((info.downloaded / info.total) * 100) : 0,
        }));
    }, [activeDownloads]);

    // ≥4个时聚合第4个及之后的下载
    const dlOverflow = useMemo(() => {
        if (dlEntries.length <= 3) return null;
        const overflow = dlEntries.slice(3);
        let downloaded = 0, total = 0, speed = 0;
        for (const item of overflow) {
            downloaded += item.downloaded;
            total += item.total;
            speed += item.speed;
        }
        return { count: overflow.length, downloaded, total, speed };
    }, [dlEntries]);

    const hasDownloadProgress = dlEntries.length > 0;
    const hasTaskProgress = progress.total > 0 && !hasDownloadProgress;

    // ── 任务总览：整体字节进度 / 总速度 / 已用与剩余时间 ──
    const overall = useMemo(() => {
        let downloaded = 0, total = 0, speed = 0;
        for (const dl of dlEntries) {
            downloaded += dl.downloaded;
            total += dl.total;
            speed += dl.speed;
        }
        return { downloaded, total, speed };
    }, [dlEntries]);

    const overallPercent = overall.total > 0
        ? Math.round((overall.downloaded / overall.total) * 100)
        : 0;

    // 每秒跳动一次时钟，驱动"已用时间"显示
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!taskStartedAt) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [taskStartedAt]);

    const elapsedSec = taskStartedAt
        ? Math.max(0, Math.floor((now - taskStartedAt) / 1000))
        : 0;
    const remainingSec = overall.speed > 0 && overall.total > overall.downloaded
        ? Math.round((overall.total - overall.downloaded) / overall.speed)
        : null;

    // ── 任务栏进度条同步（迅雷式覆盖层） ──
    useEffect(() => {
        let pct: number | null = null;
        if (hasDownloadProgress && overall.total > 0) {
            pct = overallPercent;
        } else if (downloading && progress.total > 0) {
            // 转存等无字节进度阶段，按文件数折算
            pct = Math.round((progress.done / progress.total) * 100);
        }
        invoke('set_taskbar_progress', { percent: pct }).catch(() => {});
    }, [hasDownloadProgress, overallPercent, downloading, progress.done, progress.total]);

    const fetchCapacity = async () => {
        if (!isLoggedIn) return;
        setCapacityLoading(true);
        try {
            const res = await quarkApi.getMemberInfo();
            if (res.status === 200 || res.code === 0) {
                const data = res.data || res;
                setCapacity(data.use_capacity || 0, data.total_capacity || 0);
            }
        } catch (e) {
            console.error('Failed to fetch capacity', e);
        }
    };

    const handleLogout = async () => {
        setLoggingOut(true);
        if (!cookie.trim()) {
            setCookie('');
            addLog('本地登录状态已清理', 'info');
            notify('已退出登录', 'info');
            setLoggingOut(false);
            return;
        }

        let logoutMessage = '已安全退出登录';
        let logoutType: 'success' | 'warn' = 'success';

        try {
            const result = await quarkApi.logout();
            if (result.logged_out) {
                logoutType = result.logout_request_error ? 'warn' : 'success';
                logoutMessage = result.message || '已安全退出夸克账号';
            } else {
                logoutType = 'warn';
                const nickname = result.verify?.nickname ? `（当前账号：${result.verify.nickname}）` : '';
                logoutMessage = result.message || `已清理本地登录状态，远端会话可能仍有效${nickname}`;
            }

            if (result.verify_error) {
                logoutType = 'warn';
            }
        } catch (error: unknown) {
            logoutType = 'warn';
            logoutMessage = `远端退出状态校验失败，已清理本地登录状态（${getErrorMessage(error)}）`;
        }

        setCookie('');
        setCapacity(0, 0);
        addLog('已退出登录', 'info');
        notify(logoutMessage, logoutType);
        setLoggingOut(false);
    };

    const hasProgress = hasDownloadProgress || hasTaskProgress;
    const hasToast = Boolean(toast.message);
    const hasIslandContent = hasProgress || hasToast;

    return (
        <div className="h-screen flex flex-col bg-[#f1f5f9] text-slate-900 dark:bg-[#0b1220] dark:text-slate-100 font-sans selection:bg-indigo-100 selection:text-indigo-900 dark:selection:bg-indigo-900/60 dark:selection:text-indigo-100 overflow-hidden relative">
            {/* 自定义标题栏 */}
            <TitleBar />

            {/* 主内容区 */}
            <div className="flex-1 flex min-h-0 relative">
                <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] px-4 pointer-events-none">
                <AnimatePresence>
                    {hasIslandContent && (
                        <motion.div
                            key="global-island"
                            initial={{ y: -24, opacity: 0, scale: 0.9 }}
                            animate={{ y: 0, opacity: 1, scale: 1 }}
                            exit={{ y: -24, opacity: 0, scale: 0.9 }}
                            transition={{ type: 'spring', damping: 22, stiffness: 260 }}
                            className={cn(
                                "mx-auto pointer-events-auto rounded-[2rem] border border-slate-700/60 bg-slate-900/95 shadow-2xl shadow-slate-900/30 backdrop-blur-2xl",
                                hasProgress ? "w-[520px] max-w-[calc(100vw-2rem)] px-5 py-4" : "w-fit max-w-[calc(100vw-2rem)] px-4 py-3"
                            )}
                            style={{ fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' }}
                        >
                            {/* 任务总览：整体进度 / 总速度 / 已用与剩余时间 */}
                            {hasProgress && taskStartedAt > 0 && (
                                <div className="mb-3 pb-2.5 border-b border-white/10 flex items-center justify-between text-[11px]">
                                    <div className="flex items-center gap-3">
                                        {hasDownloadProgress && overall.total > 0 ? (
                                            <>
                                                <span className="text-white font-semibold tabular-nums">整体 {overallPercent}%</span>
                                                {overall.speed > 0 && (
                                                    <span className="text-emerald-300 tabular-nums">{(overall.speed / 1024 / 1024).toFixed(1)} MB/s</span>
                                                )}
                                            </>
                                        ) : (
                                            <span className="text-white font-semibold tabular-nums">
                                                {progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 text-slate-400 tabular-nums">
                                        <span>已用 {fmtDuration(elapsedSec)}</span>
                                        {remainingSec !== null && <span>剩余 {fmtDuration(remainingSec)}</span>}
                                    </div>
                                </div>
                            )}

                            {hasDownloadProgress && (
                                <div className="flex items-start gap-4">
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-indigo-500/20">
                                        <Zap size={18} fill="currentColor" />
                                    </div>
                                    <div className="flex-1 space-y-3">
                                    {dlEntries.slice(0, 3).map((dl) => (
                                        <div key={dl.id}>
                                            <div className="flex justify-between items-center mb-1.5">
                                                <span className="text-xs font-medium text-slate-300 truncate max-w-[320px]" title={dl.filename}>
                                                    {dl.status === 'merging'
                                                        ? `${dl.filename.slice(0, 28)} 合并中...`
                                                        : dl.filename.length > 28 ? dl.filename.slice(0, 28) + '...' : dl.filename}
                                                </span>
                                                <div className="flex items-center gap-2 shrink-0 ml-2">
                                                    {dl.status !== 'merging' && (
                                                        <span className="text-[10px] text-slate-400 tabular-nums">
                                                            {formatSize(dl.downloaded)}/{formatSize(dl.total)}
                                                            {dl.speed > 0 && ` ${(dl.speed / 1024 / 1024).toFixed(1)} MB/s`}
                                                        </span>
                                                    )}
                                                    <span className="text-xs font-semibold text-white tabular-nums w-8 text-right">
                                                        {dl.percent}%
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                                                <motion.div
                                                    className="h-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${dl.percent}%` }}
                                                    transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                    {dlOverflow && (
                                        <div className="pt-2 border-t border-white/10">
                                            <span className="text-[10px] font-medium text-slate-400 tracking-wide">
                                                还有 {dlOverflow.count} 个文件下载中 {formatSize(dlOverflow.downloaded)}/{formatSize(dlOverflow.total)}
                                                {dlOverflow.speed > 0 ? ` ${(dlOverflow.speed / 1024 / 1024).toFixed(1)} MB/s` : ''}
                                            </span>
                                        </div>
                                    )}
                                    </div>
                                </div>
                            )}

                            {hasTaskProgress && (
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-500 flex items-center justify-center text-white shrink-0 shadow-lg shadow-indigo-500/20">
                                        <Zap size={18} fill="currentColor" />
                                    </div>
                                    <div className="flex-1">
                                        <div className="flex justify-between items-end mb-2">
                                            <span className="font-display text-[10px] font-medium text-slate-400 uppercase tracking-[0.18em]">
                                                {progress.text}
                                            </span>
                                            <span className="text-sm font-semibold text-white tabular-nums">
                                                {Math.round((progress.done / progress.total) * 100)}%
                                            </span>
                                        </div>
                                        <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                                            <motion.div
                                                className="h-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]"
                                                initial={{ width: 0 }}
                                                animate={{ width: `${(progress.done / progress.total) * 100}%` }}
                                                transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}

                            {hasProgress && hasToast && <div className="my-3 h-px bg-white/10" />}

                            {hasToast && (
                                <div className="flex items-center justify-center gap-3 text-center">
                                    <ToastIcon type={toast.type} />
                                    <span className="text-sm font-semibold text-white tracking-tight leading-relaxed text-center break-normal [word-break:keep-all] [text-wrap:pretty] sm:whitespace-nowrap">{toast.message}</span>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* 背景氛围光晕 - 让玻化效果可见 */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] rounded-full bg-indigo-200/40 dark:bg-indigo-600/15 blur-[120px]" />
                <div className="absolute top-[20%] -right-[5%] w-[30%] h-[40%] rounded-full bg-purple-200/30 dark:bg-purple-700/10 blur-[100px]" />
                <div className="absolute -bottom-[10%] left-[20%] w-[50%] h-[30%] rounded-full bg-pink-100/40 dark:bg-pink-700/10 blur-[110px]" />
                <div className="absolute top-[50%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[60%] h-[60%] rounded-full bg-slate-200/20 dark:bg-slate-700/10 blur-[140px]" />
            </div>

            <Sidebar
                onLogout={handleLogout}
                onRefreshCapacity={fetchCapacity}
                onLogin={() => setIsAuthOpen(true)}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
            />

            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden pl-2 pr-6 py-6">
                <main className="flex-1 w-full flex flex-col min-h-0">
                    {children}
                </main>
            </div>

            <AuthModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} onLogout={handleLogout} />
            </div>
        </div>
    );
};
