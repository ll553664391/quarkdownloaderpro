import { create } from 'zustand';
import type { ShareFileNode } from '../types/quark';

export interface LogEntry {
    message: string;
    type: 'info' | 'success' | 'error' | 'warn';
    timestamp: number;
}

interface ShareParseState {
    pwdId: string;
    stoken: string;
    files: ShareFileNode[];
    allFiles: ShareFileNode[];
    status: string;
    statusType: 'info' | 'success' | 'error' | 'warn';
    shareUrl: string;
}

export interface DownloadInfo {
    filename: string;
    downloaded: number;
    total: number;
    speed: number;
    status: 'downloading' | 'merging' | 'done';
}

/** 任务生命周期：排队中 → 转存中 → 下载中 → 合并中 → 终态（已完成/已失败/已跳过/已停止） */
export type DownloadTaskStatus = 'pending' | 'saving' | 'downloading' | 'merging' | 'done' | 'failed' | 'skipped' | 'stopped';

export interface DownloadTask {
    fid: string;
    filename: string;
    relativePath: string | null;
    size: number;
    status: DownloadTaskStatus;
    downloaded: number;
    /** 下载中阶段由 Rust 事件上报的实际总字节（未知时回退 size） */
    total?: number;
    speed: number;
    error?: string;
    /** 落盘绝对路径（下载成功时由 Rust 返回），供「打开文件夹」使用 */
    savedPath?: string;
}

interface QuarkState {
    cookie: string;
    toast: {
        isLoggingOut?: boolean;
        id: number;
        message: string;
        type: 'info' | 'success' | 'error' | 'warn' | '';
    };
    isLoggedIn: boolean;
    capacity: {
        used: number;
        total: number;
        loading: boolean;
    };
    shareInfo: ShareParseState;
    logs: LogEntry[];
    downloading: boolean;
    progress: {
        done: number;
        total: number;
        text: string;
    };
    selectedFids: Set<string>;
    downloadConcurrency: number;
    downloadDir: string;
    theme: 'light' | 'dark';
    taskStartedAt: number;
    /** 全局停止请求：两处「停止」按钮共享，流水线据此中断，避免取消后又拉起新任务 */
    stopRequested: boolean;
    activeDownloads: Map<string, DownloadInfo>;
    // 迅雷式任务记录（仅本次运行保留）：key = fid，覆盖排队/转存等无 Rust 事件的阶段
    downloadTasks: Map<string, DownloadTask>;
    // 任务级字节账本：整体进度 = (finishedBytes + 活跃文件已下字节) / totalBytes
    taskTotalBytes: number;
    taskFinishedBytes: number;

    setCookie: (cookie: string) => void;
    setCapacity: (used: number, total: number) => void;
    setCapacityLoading: (loading: boolean) => void;
    setShareInfo: (info: Partial<ShareParseState>) => void;
    addLog: (message: string, type?: LogEntry['type']) => void;
    clearLogs: () => void;
    setDownloadConcurrency: (value: number) => void;
    setDownloadDir: (dir: string) => void;
    setTheme: (theme: 'light' | 'dark') => void;
    setTaskStartedAt: (ts: number) => void;
    setStopRequested: (v: boolean) => void;
    setTaskBytes: (totalBytes: number) => void;
    addFinishedBytes: (bytes: number) => void;
    adjustTaskTotalBytes: (delta: number) => void;
    resetTaskBytes: () => void;
    setLoggingOut: (isLoggingOut: boolean) => void;
    notify: (message: string, type: 'info' | 'success' | 'error' | 'warn', durationMs?: number) => void;
    toggleFileSelection: (fid: string) => void;
    toggleFolderSelection: (node: ShareFileNode) => void;
    selectAllFiles: (fids: string[]) => void;
    clearSelection: () => void;
    setDownloading: (downloading: boolean) => void;
    setProgress: (done: number, total: number, text: string) => void;
    updateDownload: (id: string, info: Partial<DownloadInfo> & { filename: string }) => void;
    removeDownload: (id: string) => void;
    clearAllDownloads: () => void;
    initDownloadTasks: (files: ShareFileNode[]) => void;
    updateDownloadTask: (fid: string, patch: Partial<DownloadTask>) => void;
    clearDownloadTasks: () => void;
    markTasksStopped: () => void;
    resetShareInfo: () => void;
    setShareUrl: (url: string) => void;
}

export const useQuarkStore = create<QuarkState>((set) => ({
    toast: {
        id: 0,
        message: '',
        type: '',
    },
    cookie: localStorage.getItem('quark_cookie') || '',
    isLoggedIn: !!localStorage.getItem('quark_cookie'),
    capacity: {
        used: 0,
        total: 0,
        loading: false,
    },
    shareInfo: {
        pwdId: '',
        stoken: '',
        files: [],
        allFiles: [],
        status: '',
        statusType: 'info',
        shareUrl: '',
    },
    logs: [],
    downloading: false,
    progress: {
        done: 0,
        total: 0,
        text: '',
    },
    selectedFids: new Set<string>(),
    downloadConcurrency: Math.min(8, Math.max(1, Number(localStorage.getItem('download_concurrency')) || 4)),
    downloadDir: localStorage.getItem('download_dir') || '',
    theme: (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'),
    taskStartedAt: 0,
    stopRequested: false,
    activeDownloads: new Map<string, DownloadInfo>(),
    downloadTasks: new Map<string, DownloadTask>(),
    taskTotalBytes: 0,
    taskFinishedBytes: 0,

    setCookie: (cookie: string) => {
        localStorage.setItem('quark_cookie', cookie);
        set({ cookie, isLoggedIn: !!cookie });
    },
    setCapacity: (used: number, total: number) => set({ capacity: { used, total, loading: false } }),
    setCapacityLoading: (loading: boolean) => set((state: QuarkState) => ({ capacity: { ...state.capacity, loading } })),
    setShareInfo: (info: Partial<ShareParseState>) => {
        if (info.files) {
            const flatten = (nodes: ShareFileNode[]): ShareFileNode[] => {
                const res: ShareFileNode[] = [];
                for (const n of nodes) {
                    if (!n.isDir) res.push(n);
                    if (n.children) res.push(...flatten(n.children));
                }
                return res;
            };
            info.allFiles = flatten(info.files);
        }

        set((state: QuarkState) => {
            const next: Partial<QuarkState> = { shareInfo: { ...state.shareInfo, ...info } };
            // 解析完成（files 有值）时默认全选所有文件
            if (info.files && info.allFiles) {
                next.selectedFids = new Set(info.allFiles.map((f: ShareFileNode) => f.fid));
            }
            return next;
        });
    },
    addLog: (message: string, type: LogEntry['type'] = 'info') => {
        const newLog: LogEntry = {
            message,
            type,
            timestamp: Date.now(),
        };
        set((state: QuarkState) => ({ logs: [newLog, ...state.logs].slice(0, 500) }));
    },
    clearLogs: () => set({ logs: [] }),
    setDownloadConcurrency: (value: number) => {
        const normalized = Math.max(1, Math.min(8, value));
        localStorage.setItem('download_concurrency', normalized.toString());

        set({ downloadConcurrency: normalized });
    },
    setDownloadDir: (dir: string) => {
        localStorage.setItem('download_dir', dir);
        set({ downloadDir: dir });
    },
    setTheme: (theme: 'light' | 'dark') => {
        localStorage.setItem('theme', theme);
        // 立即切换 html.dark 类，Tailwind darkMode: ["class"] 据此生效
        document.documentElement.classList.toggle('dark', theme === 'dark');
        set({ theme });
    },
    setTaskStartedAt: (ts: number) => set({ taskStartedAt: ts }),
    setStopRequested: (v: boolean) => set({ stopRequested: v }),
    setTaskBytes: (totalBytes: number) => set({ taskTotalBytes: totalBytes, taskFinishedBytes: 0 }),
    addFinishedBytes: (bytes: number) => set((state: QuarkState) => ({
        taskFinishedBytes: state.taskFinishedBytes + bytes,
    })),
    adjustTaskTotalBytes: (delta: number) => set((state: QuarkState) => ({
        taskTotalBytes: Math.max(0, state.taskTotalBytes + delta),
    })),
    resetTaskBytes: () => set({ taskTotalBytes: 0, taskFinishedBytes: 0 }),
    notify: (message: string, type: 'info' | 'success' | 'error' | 'warn', durationMs?: number) => {
        const toastId = Date.now() + Math.random();
        const timeout = durationMs ?? 3000;
        set((state: QuarkState) => ({ toast: { ...state.toast, id: toastId, message, type } }));

        set({ toast: { id: toastId, message, type } });

        setTimeout(() => {
            set((state: QuarkState) => (
                state.toast.id === toastId ? { toast: { id: 0, message: '', type: '' } } : {}
            ));
        }, timeout);
    },
    setLoggingOut: (isLoggingOut: boolean) => set((state: QuarkState) => ({ toast: { ...state.toast, isLoggingOut } })),
    toggleFileSelection: (fid: string) => set((state: QuarkState) => {
        const newSet = new Set(state.selectedFids);
        if (newSet.has(fid)) newSet.delete(fid);
        else newSet.add(fid);
        return { selectedFids: newSet };
    }),
    selectAllFiles: (fids: string[]) => set({ selectedFids: new Set(fids) }),
    clearSelection: () => set({ selectedFids: new Set<string>() }),
    toggleFolderSelection: (node: ShareFileNode) => set((state: QuarkState) => {
        // 递归收集该文件夹（含嵌套子文件夹）下所有文件的 fid
        const collect = (n: ShareFileNode): string[] => {
            const out: string[] = [];
            if (!n.isDir) out.push(n.fid);
            for (const c of n.children || []) out.push(...collect(c));
            return out;
        };
        const fids = collect(node);
        if (fids.length === 0) return {};

        const newSet = new Set(state.selectedFids);
        const allSelected = fids.every((f) => newSet.has(f));
        for (const f of fids) {
            if (allSelected) newSet.delete(f);
            else newSet.add(f);
        }
        return { selectedFids: newSet };
    }),
    setDownloading: (downloading: boolean) => set({ downloading }),
    setProgress: (done: number, total: number, text: string) => set({ progress: { done, total, text } }),
    updateDownload: (id: string, info: Partial<DownloadInfo> & { filename: string }) => set((state: QuarkState) => {
        const next = new Map(state.activeDownloads);
        const existing = next.get(id);
        next.set(id, {
            filename: info.filename,
            downloaded: info.downloaded ?? existing?.downloaded ?? 0,
            total: info.total ?? existing?.total ?? 0,
            speed: info.speed ?? existing?.speed ?? 0,
            status: (info.status as DownloadInfo['status']) ?? existing?.status ?? 'downloading',
        });
        return { activeDownloads: next };
    }),
    removeDownload: (id: string) => set((state: QuarkState) => {
        const next = new Map(state.activeDownloads);
        next.delete(id);
        return { activeDownloads: next };
    }),
    clearAllDownloads: () => set({ activeDownloads: new Map<string, DownloadInfo>() }),
    initDownloadTasks: (files: ShareFileNode[]) => set(() => ({
        downloadTasks: new Map(files.map((f) => [f.fid, {
            fid: f.fid,
            filename: f.file_name,
            relativePath: f.path || null,
            size: f.size || 0,
            status: 'pending' as DownloadTaskStatus,
            downloaded: 0,
            speed: 0,
        }])),
    })),
    updateDownloadTask: (fid: string, patch: Partial<DownloadTask>) => set((state: QuarkState) => {
        if (!state.downloadTasks.has(fid)) return {};
        const next = new Map(state.downloadTasks);
        next.set(fid, { ...next.get(fid)!, ...patch });
        return { downloadTasks: next };
    }),
    clearDownloadTasks: () => set({ downloadTasks: new Map<string, DownloadTask>() }),
    markTasksStopped: () => set((state: QuarkState) => {
        const next = new Map(state.downloadTasks);
        for (const [fid, task] of next) {
            if (['pending', 'saving', 'downloading', 'merging'].includes(task.status)) {
                next.set(fid, { ...task, status: 'stopped', speed: 0 });
            }
        }
        return { downloadTasks: next };
    }),
    resetShareInfo: () => set((state: QuarkState) => ({
        shareInfo: {
            pwdId: '',
            stoken: '',
            files: [],
            allFiles: [],
            status: '',
            statusType: 'info',
            shareUrl: state.shareInfo.shareUrl,
        },
        selectedFids: new Set<string>(),
        logs: [],
    })),
    setShareUrl: (url: string) => set((state: QuarkState) => ({
        shareInfo: { ...state.shareInfo, shareUrl: url }
    })),
}));