import React, { type ReactNode, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sidebar } from '../components/Sidebar';
import { TitleBar } from '../components/TitleBar';
import { useQuarkStore } from '../store/useQuarkStore';
import { quarkApi } from '../services/quarkApi';
import { AuthModal } from '../features/auth/AuthModal';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react';
import { getErrorMessage } from '../utils';

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
        taskTotalBytes,
        taskFinishedBytes,
        toast,
        notify,
        setLoggingOut,
    } = useQuarkStore();

    // 将活跃下载转为数组，计算百分比（供任务栏进度条同步使用）
    const dlEntries = useMemo(() => {
        if (activeDownloads.size === 0) return [];
        return Array.from(activeDownloads.entries()).map(([id, info]) => ({
            id,
            ...info,
            percent: info.total > 0 ? Math.round((info.downloaded / info.total) * 100) : 0,
        }));
    }, [activeDownloads]);

    const hasDownloadProgress = dlEntries.length > 0;

    // ── 任务总览：按「任务全部文件字节」计算整体进度（供任务栏进度条同步） ──
    const overall = useMemo(() => {
        let downloaded = 0, total = 0, speed = 0;
        for (const dl of dlEntries) {
            downloaded += dl.downloaded;
            total += dl.total;
            speed += dl.speed;
        }
        return { downloaded, total, speed };
    }, [dlEntries]);

    // 任务级口径：已完成文件字节 + 活跃文件已下字节，分母为全部选中文件字节
    const taskDownloaded = taskFinishedBytes + overall.downloaded;
    const taskTotal = Math.max(taskTotalBytes, taskDownloaded);
    const taskPercent = taskTotal > 0
        ? Math.min(100, Math.round((taskDownloaded / taskTotal) * 100))
        : 0;

    const overallPercent = overall.total > 0
        ? Math.round((overall.downloaded / overall.total) * 100)
        : 0;

    // ── 任务栏进度条同步（迅雷式覆盖层）：优先任务字节口径 ──
    useEffect(() => {
        let pct: number | null = null;
        if (downloading && taskTotal > 0) {
            pct = taskPercent;
        } else if (downloading && progress.total > 0) {
            // 转存等无字节账本的阶段，按文件数折算
            pct = Math.round((progress.done / progress.total) * 100);
        } else if (hasDownloadProgress && overall.total > 0) {
            // 兜底：无任务账本但有活跃下载
            pct = overallPercent;
        }
        invoke('set_taskbar_progress', { percent: pct }).catch(() => {});
    }, [downloading, taskTotal, taskPercent, progress.done, progress.total, hasDownloadProgress, overallPercent, overall.total]);

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

    // 悬浮岛仅承载 Toast 通知；下载进度已移至「下载管理」子页面（任务栏进度条同步仍保留）
    const hasToast = Boolean(toast.message);

    return (
        <div className="h-screen flex flex-col bg-[#f1f5f9] text-slate-900 dark:bg-[#0b1220] dark:text-slate-100 font-sans selection:bg-indigo-100 selection:text-indigo-900 dark:selection:bg-indigo-900/60 dark:selection:text-indigo-100 overflow-hidden relative">
            {/* 自定义标题栏 */}
            <TitleBar />

            {/* 主内容区 */}
            <div className="flex-1 flex min-h-0 relative">
                <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] px-4 pointer-events-none">
                <AnimatePresence>
                    {hasToast && (
                        <motion.div
                            key="global-island"
                            initial={{ y: -24, opacity: 0, scale: 0.9 }}
                            animate={{ y: 0, opacity: 1, scale: 1 }}
                            exit={{ y: -24, opacity: 0, scale: 0.9 }}
                            transition={{ type: 'spring', damping: 22, stiffness: 260 }}
                            className="mx-auto pointer-events-auto w-fit max-w-[calc(100vw-2rem)] px-4 py-3 rounded-[2rem] border border-slate-700/60 bg-slate-900/95 shadow-2xl shadow-slate-900/30 backdrop-blur-2xl"
                            style={{ fontFamily: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif' }}
                        >
                            <div className="flex items-center justify-center gap-3 text-center">
                                <ToastIcon type={toast.type} />
                                <span className="text-sm font-semibold text-white tracking-tight leading-relaxed text-center break-normal [word-break:keep-all] [text-wrap:pretty] sm:whitespace-nowrap">{toast.message}</span>
                            </div>
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
