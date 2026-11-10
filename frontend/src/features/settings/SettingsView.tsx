import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sun, Moon, FolderOpen, RotateCcw, Palette, HardDrive } from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import { cn, getErrorMessage } from '../../utils';

export const SettingsView: React.FC = () => {
    const { theme, setTheme, downloadDir, setDownloadDir, notify } = useQuarkStore();

    const handlePickDir = async () => {
        try {
            const dir = await invoke<string | null>('pick_download_dir');
            if (dir) {
                setDownloadDir(dir);
                notify(`下载位置已设置为: ${dir}`, 'success');
            }
        } catch (error: unknown) {
            notify(`选择目录失败: ${getErrorMessage(error)}`, 'error');
        }
    };

    const handleResetDir = () => {
        setDownloadDir('');
        notify('已恢复为系统默认下载目录', 'info');
    };

    const themeOptions: Array<{ value: 'light' | 'dark'; label: string; icon: React.ElementType }> = [
        { value: 'light', label: '亮色模式', icon: Sun },
        { value: 'dark', label: '暗色模式', icon: Moon },
    ];

    return (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            <div className="max-w-2xl mx-auto space-y-5 py-2">
                {/* 页面标题 */}
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 gradient-bg rounded-2xl flex items-center justify-center text-white shadow-lg shadow-purple-200/50 dark:shadow-purple-900/30">
                        <Palette size={20} />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">软件设置</h2>
                        <p className="text-xs text-slate-400 dark:text-slate-500">设置立即生效，重启后保留</p>
                    </div>
                </div>

                {/* 颜色模式 */}
                <div className="glass-effect rounded-[1.5rem] p-5">
                    <div className="mb-4">
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">颜色模式</h3>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">切换后立即生效，下次启动保持所选模式</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        {themeOptions.map((opt) => {
                            const Icon = opt.icon;
                            const active = theme === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    onClick={() => setTheme(opt.value)}
                                    className={cn(
                                        "flex items-center gap-3 px-4 py-3.5 rounded-2xl border-2 transition-all duration-200 text-left",
                                        active
                                            ? "border-indigo-500 bg-indigo-50/80 dark:bg-indigo-500/15 shadow-sm"
                                            : "border-slate-200/70 dark:border-slate-700/60 hover:border-indigo-300 dark:hover:border-indigo-500/50 bg-white/50 dark:bg-slate-800/40"
                                    )}
                                >
                                    <div className={cn(
                                        "w-9 h-9 rounded-xl flex items-center justify-center shrink-0",
                                        active
                                            ? "bg-indigo-500 text-white"
                                            : "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                                    )}>
                                        <Icon size={18} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className={cn(
                                            "text-sm font-bold",
                                            active ? "text-indigo-600 dark:text-indigo-300" : "text-slate-700 dark:text-slate-200"
                                        )}>
                                            {opt.label}
                                        </div>
                                        <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                                            {active ? '当前使用' : '点击切换'}
                                        </div>
                                    </div>
                                    <div className={cn(
                                        "w-4 h-4 rounded-full border-2 shrink-0 transition-colors",
                                        active ? "border-indigo-500 bg-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-500/30" : "border-slate-300 dark:border-slate-600"
                                    )} />
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 下载位置 */}
                <div className="glass-effect rounded-[1.5rem] p-5">
                    <div className="mb-4">
                        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100">下载位置</h3>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                            下载任务的默认保存目录，未设置时使用系统"下载"文件夹
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0 flex items-center gap-2.5 px-3.5 py-3 rounded-xl bg-white/60 dark:bg-slate-800/50 border border-slate-200/70 dark:border-slate-700/60">
                            <HardDrive size={16} className="shrink-0 text-indigo-500" />
                            <span
                                className={cn(
                                    "truncate text-xs font-semibold",
                                    downloadDir ? "text-slate-700 dark:text-slate-200" : "text-slate-400 dark:text-slate-500"
                                )}
                                title={downloadDir || '系统默认下载目录'}
                            >
                                {downloadDir || '系统默认下载目录（未自定义）'}
                            </span>
                        </div>
                        <button
                            onClick={handlePickDir}
                            className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs font-bold bg-indigo-500 text-white hover:bg-indigo-600 active:scale-95 transition-all shadow-sm shadow-indigo-200/50 dark:shadow-indigo-900/40 shrink-0"
                        >
                            <FolderOpen size={14} />
                            选择目录
                        </button>
                        {downloadDir && (
                            <button
                                onClick={handleResetDir}
                                title="恢复为系统默认下载目录"
                                className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100/80 dark:bg-slate-700/60 hover:bg-slate-200 dark:hover:bg-slate-600 active:scale-95 transition-all shrink-0"
                            >
                                <RotateCcw size={13} />
                                恢复默认
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
