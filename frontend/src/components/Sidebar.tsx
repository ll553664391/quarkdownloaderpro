import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
    Zap,
    Settings,
    HelpCircle,
    LogOut,
    User,
    HardDrive,
    RefreshCw,
    Download,
    ChevronRight
} from 'lucide-react';
import { cn } from '../utils';
import { useQuarkStore } from '../store/useQuarkStore';
import { Button } from './ui/button';
import { CapacityStats } from '../features/capacity/CapacityStats';

interface SidebarProps {
    onLogout: () => void;
    onRefreshCapacity: () => void;
    onLogin: () => void;
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
    onLogout,
    onRefreshCapacity,
    onLogin,
    activeTab,
    setActiveTab
}) => {
    const { isLoggedIn, toast, downloadTasks } = useQuarkStore();

    // 剩余未下载任务数 = 总数 − 已完成 − 已存在（跳过）；已失败/已停止均未下载成功，计入
    // 停止后显示未下载数量，每完成一个递减，新任务启动时随 initDownloadTasks 重建
    const pendingTaskCount = useMemo(() => {
        let n = 0;
        for (const t of downloadTasks.values()) {
            if (t.status !== 'done' && t.status !== 'skipped') n += 1;
        }
        return n;
    }, [downloadTasks]);

    const menuItems = [
        { id: 'parser', icon: Zap, label: '解析提取' },
        { id: 'downloads', icon: Download, label: '下载管理' },
        { id: 'history', icon: RefreshCw, label: '解析历史' },
        { id: 'settings', icon: Settings, label: '软件设置' },
        { id: 'help', icon: HelpCircle, label: '使用说明' },
    ];

    return (
        <div className="relative m-6 w-52 glass-effect rounded-[2.5rem] z-50 flex flex-col p-5 overflow-hidden shrink-0 h-[calc(100%-3rem)]">
            <div className="flex items-center gap-2 mb-10 px-1">
                <div className="w-10 h-10 gradient-bg rounded-2xl flex items-center justify-center text-white shadow-lg shadow-purple-200/50 dark:shadow-purple-900/40">
                    <HardDrive size={22} strokeWidth={2.5} />
                </div>
                <div className="flex flex-col">
                    <span className="font-display text-base font-medium tracking-tight text-slate-800 dark:text-slate-100 leading-none">
                        Quark
                    </span>
                    <span className="font-display text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400">
                        Downloader Pro
                    </span>
                </div>
            </div>

            <nav className="flex-1 space-y-2">
                {menuItems.map((item) => (
                    <button
                        key={item.id}
                        onClick={() => setActiveTab(item.id)}
                        className={cn(
                            "w-full flex items-center gap-2 px-3 py-3 rounded-2xl transition-all duration-200 group relative",
                            activeTab === item.id
                                ? "bg-slate-900 text-white shadow-xl shadow-slate-200/50 dark:bg-indigo-500/90 dark:shadow-indigo-900/40"
                                : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                        )}
                    >
                        <item.icon size={20} strokeWidth={activeTab === item.id ? 2.5 : 2} />
                        <span className="font-semibold text-sm">{item.label}</span>
                        {item.id === 'downloads' && pendingTaskCount > 0 ? (
                            // 有未完成任务时角标替代箭头，呼吸动画提示（不复用 active-pill 的 layoutId，避免跨菜单项飞行动画）
                            <motion.span
                                initial={{ scale: 0 }}
                                animate={{ scale: [1, 1.15, 1] }}
                                transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
                                className={cn(
                                    "absolute right-2.5 min-w-5 h-5 px-1.5 rounded-full flex items-center justify-center text-[10px] font-black tabular-nums shadow-sm",
                                    activeTab === item.id
                                        ? "bg-white text-indigo-600"
                                        : "bg-indigo-500 text-white shadow-indigo-300/50 dark:shadow-indigo-900/40"
                                )}
                            >
                                {pendingTaskCount > 99 ? '99+' : pendingTaskCount}
                            </motion.span>
                        ) : activeTab === item.id && (
                            <motion.div
                                layoutId="active-pill"
                                className="absolute right-3"
                            >
                                <ChevronRight size={14} className="opacity-50" />
                            </motion.div>
                        )}
                    </button>
                ))}
            </nav>

            <div className="mt-auto space-y-4">
                {isLoggedIn ? (
                    <div className="space-y-4">
                        <CapacityStats onRefresh={onRefreshCapacity} />
                        <motion.button
                            disabled={toast.isLoggingOut}
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            onClick={onLogout}
                            className={cn(
                                "w-full flex items-center justify-center gap-2 py-2.5 text-[10px] font-bold rounded-xl transition-all duration-300 border shadow-sm",
                                toast.isLoggingOut
                                    ? "bg-slate-100 text-slate-400 border-slate-200 dark:bg-slate-800 dark:text-slate-500 dark:border-slate-700 cursor-not-allowed"
                                    : "text-rose-500 border-rose-100/50 dark:border-rose-500/30 hover:bg-rose-500 hover:text-white hover:border-rose-500 hover:shadow-md hover:shadow-rose-200 dark:hover:shadow-rose-900/40"
                            )}
                        >
                            {toast.isLoggingOut ? <RefreshCw size={14} className="animate-spin" /> : <LogOut size={14} strokeWidth={2.5} />}
                            {toast.isLoggingOut ? '正在提出...' : '退出登录'}
                        </motion.button>
                    </div>
                ) : (
                    <Button
                        onClick={onLogin}
                        variant="gradient"
                        className="w-full rounded-2xl py-6 font-bold flex items-center gap-2 group"
                    >
                        <User size={18} className="group-hover:animate-pulse" />
                        立即登录
                    </Button>
                )}
            </div>
        </div>
    );
};