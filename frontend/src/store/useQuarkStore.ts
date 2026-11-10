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
    downloadThreads: number;
    downloadDir: string;
    theme: 'light' | 'dark';
    taskStartedAt: number;
    activeDownloads: Map<string, DownloadInfo>;

    setCookie: (cookie: string) => void;
    setCapacity: (used: number, total: number) => void;
    setCapacityLoading: (loading: boolean) => void;
    setShareInfo: (info: Partial<ShareParseState>) => void;
    addLog: (message: string, type?: LogEntry['type']) => void;
    clearLogs: () => void;
    setDownloadConcurrency: (value: number) => void;
    setDownloadThreads: (value: number) => void;
    setDownloadDir: (dir: string) => void;
    setTheme: (theme: 'light' | 'dark') => void;
    setTaskStartedAt: (ts: number) => void;
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
    downloadConcurrency: Number(localStorage.getItem('download_concurrency')) || 5,
    downloadThreads: Math.min(256, Number(localStorage.getItem('download_threads')) || 999),
    downloadDir: localStorage.getItem('download_dir') || '',
    theme: (localStorage.getItem('theme') === 'dark' ? 'dark' : 'light'),
    taskStartedAt: 0,
    activeDownloads: new Map<string, DownloadInfo>(),

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
        const normalized = Math.max(1, Math.min(20, value));
        localStorage.setItem('download_concurrency', normalized.toString());

        set({ downloadConcurrency: normalized });
    },
    setDownloadThreads: (value: number) => {
        const normalized = Math.max(1, Math.min(256, value));
        localStorage.setItem('download_threads', normalized.toString());

        set({ downloadThreads: normalized });
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