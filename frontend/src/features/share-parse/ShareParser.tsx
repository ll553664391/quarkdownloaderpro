import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Link2, ChevronUp, Sparkles, Zap } from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import { quarkApi, parseShareUrl, collectFiles } from '../../services/quarkApi';
import type { RawFileItem, ShareFileNode } from '../../types/quark';
import { getErrorMessage, cn } from '../../utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { SearchContainer, GradientGlow } from '../../components/ui/card';
import { DownloadManager } from '../download/DownloadManager';
import { motion, AnimatePresence } from 'framer-motion';

type ParseProgressReporter = (list: RawFileItem[], depth: number, page: number) => void;

const isDirectory = (item: RawFileItem) => item.dir || item.file_type === 0 || item.obj_category === 'dir';

// 全局并发上限：整个解析过程共享，防止请求过多触发接口限流
const PARSE_CONCURRENCY = 6;

// 全局请求信号量：限制同时进行的 HTTP 请求数。
// 目录递归与分页会嵌套，各自开并发池会导致并发相乘，因此在最底层的请求处统一限流。
// 槽位只在单次请求期间持有，不会在持有时等待其他槽位，因此无死锁风险。
let activeRequests = 0;
const requestQueue: (() => void)[] = [];

const withSlot = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = () =>
        fn().finally(() => {
            activeRequests -= 1;
            requestQueue.shift()?.();
        });

    if (activeRequests < PARSE_CONCURRENCY) {
        activeRequests += 1;
        return run();
    }

    return new Promise<T>((resolve, reject) => {
        requestQueue.push(() => {
            activeRequests += 1;
            run().then(resolve, reject);
        });
    });
};

// 并行执行任务数组，结果按原任务顺序返回（并发由 withSlot 在请求层统一控制）
const runParallel = <T,>(tasks: (() => Promise<T>)[]): Promise<T[]> => Promise.all(tasks.map((task) => task()));

export const ShareParser: React.FC = () => {
    const [url, setUrl] = useState('');
    const {
        cookie,
        setShareInfo,
        resetShareInfo,
        addLog,
        notify,
        shareInfo,
        selectedFids,
        setShareUrl
    } = useQuarkStore();
    const [loading, setLoading] = useState(false);
    const [isActionBarVisible, setIsActionBarVisible] = useState(false);
    const [showSuccessPulse, setShowSuccessPulse] = useState(false);

    const isParsed = shareInfo.allFiles.length > 0;
    const shouldShowActionBar = isParsed && selectedFids.size > 0;

    // 统一的面板开启状态判断
    const isPanelOpen = isActionBarVisible || shouldShowActionBar;

    const prevSelectedSize = useRef(selectedFids.size);

    const getFileListPaged = async (
        pid: string,
        st: string,
        fid: string = '0',
        depth: number = 0,
        onPageLoaded?: ParseProgressReporter
    ) => {
        // 第 1 页先请求，拿到 _total 才知道总页数
        const fetchPage = (page: number) =>
            withSlot(() => quarkApi.getShareDetail(pid, st, fid, page));

        const firstRes = await fetchPage(1);
        if (firstRes.status !== 200 || !firstRes.data) {
            throw new Error(firstRes.message || '获取文件列表失败');
        }

        const firstList = (firstRes.data.list || []) as RawFileItem[];
        const hasTotal = firstRes.metadata?._total !== undefined;
        const total = hasTotal ? (firstRes.metadata?._total as number) : Infinity;
        onPageLoaded?.(firstList, depth, 1);

        // 首页不足一页或已拿完全部，说明没有更多数据
        if (firstList.length === 0 || firstList.length < 50 || firstList.length >= total) {
            return firstList;
        }

        if (hasTotal) {
            // 剩余页码已知，一次性并行拉取（并发由信号量统一控制），结果按页码顺序拼接
            const totalPages = Math.ceil(total / 50);
            const remainingTasks: (() => Promise<RawFileItem[]>)[] = [];
            for (let page = 2; page <= totalPages; page++) {
                remainingTasks.push(async () => {
                    const res = await fetchPage(page);
                    if (res.status !== 200 || !res.data) {
                        throw new Error(res.message || '获取文件列表失败');
                    }
                    const list = (res.data.list || []) as RawFileItem[];
                    onPageLoaded?.(list, depth, page);
                    return list;
                });
            }

            const remainingLists = await runParallel(remainingTasks);
            return [...firstList, ...remainingLists.flat()];
        }

        // 无总数：回退为顺序翻页，直到某页不满 50 条
        const rest: RawFileItem[] = [];
        let page = 2;
        while (true) {
            const res = await fetchPage(page);
            if (res.status !== 200 || !res.data) {
                throw new Error(res.message || '获取文件列表失败');
            }
            const list = (res.data.list || []) as RawFileItem[];
            if (list.length === 0) break;
            rest.push(...list);
            onPageLoaded?.(list, depth, page);
            if (list.length < 50) break;
            page++;
        }
        return [...firstList, ...rest];
    };

    const getFileTreeRecursive = async (
        pid: string,
        st: string,
        fid: string = '0',
        depth: number = 0,
        parentPath: string = '',
        onPageLoaded?: ParseProgressReporter
    ): Promise<ShareFileNode[]> => {
        const list = await getFileListPaged(pid, st, fid, depth, onPageLoaded);

        // 先按原顺序构建节点骨架，目录 children 保持为空数组占位
        const nodes: ShareFileNode[] = list.map((item) => {
            const isDir = isDirectory(item);
            const path = parentPath ? `${parentPath}/${item.file_name}` : item.file_name;
            return {
                fid: item.fid,
                file_name: item.file_name,
                size: item.size || 0,
                format_type: item.format_type || '',
                updated_at: item.updated_at || item.l_updated_at || 0,
                share_fid_token: item.share_fid_token || '',
                isDir,
                depth,
                path,
                children: [],
                expanded: false,
            } as ShareFileNode;
        });

        // 收集同级目录的递归任务并行执行（并发由请求层信号量统一控制），
        // 按索引回填 children，保证文件树顺序与原串行逻辑一致
        const dirIndexes = list.map((item, index) => ({ item, index })).filter(({ item }) => isDirectory(item));

        if (dirIndexes.length > 0) {
            const childrenLists = await runParallel(
                dirIndexes.map(({ item, index }) => () =>
                    getFileTreeRecursive(pid, st, item.fid, depth + 1, nodes[index].path, onPageLoaded)
                )
            );
            dirIndexes.forEach(({ index }, i) => {
                nodes[index].children = childrenLists[i];
            });
        }

        return nodes;
    };

    const handleParse = async () => {
        if (!url.trim()) return;
        if (!cookie) {
            const message = '请先登录账号';
            setShareInfo({ status: message, statusType: 'warn' });
            notify(message, 'warn');
            return;
        }
        setLoading(true);
        resetShareInfo();
        setShowSuccessPulse(false);
        addLog(`开始解析: ${url.substring(0, 50)}...`);

        const parseStats = {
            scannedItems: 0,
            scannedFiles: 0,
            scannedDirs: 0,
            lastToastAt: 0,
        };

        const reportParseProgress: ParseProgressReporter = (list, depth, page) => {
            let fileCount = 0;
            let dirCount = 0;

            for (const item of list) {
                if (isDirectory(item)) dirCount += 1;
                else fileCount += 1;
            }

            parseStats.scannedItems += list.length;
            parseStats.scannedFiles += fileCount;
            parseStats.scannedDirs += dirCount;

            const message = `解析中：已扫描 ${parseStats.scannedItems} 项（文件 ${parseStats.scannedFiles}，目录 ${parseStats.scannedDirs}）`;
            setShareInfo({ status: message, statusType: 'info' });

            const now = Date.now();
            const shouldNotify = now - parseStats.lastToastAt > 1000 || depth === 0 || page === 1;
            if (shouldNotify) {
                notify(message, 'info');
                parseStats.lastToastAt = now;
            }
        };

        try {
            const { pwdId, passcode, pdirFid } = parseShareUrl(url);
            if (!pwdId) throw new Error('无法从链接中提取分享 ID');

            setShareInfo({ status: '正在获取访问令牌...', statusType: 'info' });
            notify('正在获取访问令牌...', 'info');
            const resToken = await quarkApi.getShareToken(pwdId, passcode);
            if (!resToken.data?.stoken) throw new Error(resToken.message || '获取访问令牌失败');

            const stoken = resToken.data.stoken;
            notify('正在解析目录结构...', 'info');
            const files = await getFileTreeRecursive(pwdId, stoken, pdirFid, 0, '', reportParseProgress);
            const allFiles = collectFiles(files);

            setShareInfo({
                pwdId,
                stoken,
                shareUrl: url,
                files,
                allFiles,
                status: `解析完成，共 ${allFiles.length} 个文件`,
                statusType: 'success'
            });
            setShowSuccessPulse(true);
            notify(`解析成功，发现 ${allFiles.length} 个文件`, 'success');
            addLog(`解析成功，发现 ${allFiles.length} 个文件`, 'success');
        } catch (err: unknown) {
            const message = getErrorMessage(err);
            setShareInfo({ status: `解析失败: ${message}`, statusType: 'error' });
            addLog(`解析失败: ${message}`, 'error');
            notify(`解析失败: ${message}`, 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (prevSelectedSize.current > 0 && selectedFids.size === 0) {
            setIsActionBarVisible(false);
        }
        prevSelectedSize.current = selectedFids.size;
    }, [selectedFids.size]);

    // 初始化时从 store 恢复 URL
    useEffect(() => {
        if (shareInfo.shareUrl && !url) {
            setUrl(shareInfo.shareUrl);
        }
    }, [shareInfo.shareUrl]);

    // 输入时同步到 store
    const handleUrlChange = (newUrl: string) => {
        setUrl(newUrl);
        setShareUrl(newUrl);
    };

    return (
        <div className="relative">
            <div className="relative group">
                <GradientGlow />
                <SearchContainer className="relative pr-2">
                    <div className="flex items-center pl-4 text-slate-400 dark:text-slate-500 group-focus-within:text-indigo-500 transition-colors">
                        <Link2 size={20} />
                    </div>
                    <Input
                        value={url}
                        onChange={(e) => handleUrlChange(e.target.value)}
                        placeholder="粘贴夸克网盘分享链接..."
                        className="border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:bg-transparent h-14 font-medium"
                        onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                    />

                    <div className="flex items-center gap-2.5">
                        <Button
                            onClick={handleParse}
                            disabled={loading || !url.trim()}
                            variant={isParsed ? "default" : "gradient"}
                            size="xl"
                            className={cn(
                                "relative overflow-hidden rounded-xl px-10 font-bold flex items-center gap-2 transition-all duration-700",
                                isParsed
                                    ? "bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] border-0"
                                    : "hover:scale-[1.02] active:scale-[0.98]"
                            )
                            }
                        >
                            <AnimatePresence mode="wait">
                                {loading ? (
                                    <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                        <Loader2 size={18} className="animate-spin" />
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key={isParsed ? "success" : "idle"}
                                        initial={{ y: 5, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        className="flex items-center gap-2"
                                    >
                                        {isParsed ? <Zap size={18} className="fill-white animate-pulse" /> : <Zap size={18} />}
                                        <span>解析提取</span>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                            {(showSuccessPulse || isParsed) && (
                                <motion.div
                                    className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -skew-x-12"
                                    animate={{ left: ['-100%', '200%'] }}
                                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                                />
                            )}
                        </Button>

                        <AnimatePresence>
                            {isParsed && (
                                <motion.div className="relative">
                                    <motion.button
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{
                                            opacity: 1,
                                            scale: 1,
                                            background: isPanelOpen
                                                ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                                                : "#e0e7ff"
                                        }}
                                        exit={{ opacity: 0, scale: 0.8 }}
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.95 }}
                                        onClick={() => setIsActionBarVisible(!isActionBarVisible)}
                                        className={cn(
                                            "relative z-10 w-12 h-12 flex items-center justify-center rounded-xl shadow-sm transition-all duration-500",
                                            isPanelOpen ? "shadow-indigo-200 dark:shadow-indigo-900/50 shadow-lg" : "hover:bg-indigo-200/50 dark:hover:bg-indigo-500/30"
                                        )}
                                        // 强制通过 style 设置颜色，防止 tailwind 类冲突
                                        style={{ color: isPanelOpen ? '#ffffff' : '#4f46e5' }}
                                    >
                                        <AnimatePresence mode="wait">
                                            <motion.div
                                                key={isPanelOpen ? "open" : "closed"}
                                                initial={{ scale: 0.5, opacity: 0 }}
                                                animate={{
                                                    scale: [1, 1.4, 1],
                                                    opacity: [0.8, 1, 0.8],
                                                    filter: isPanelOpen
                                                        ? ["drop-shadow(0 0 0px #fff)", "drop-shadow(0 0 8px #fff)", "drop-shadow(0 0 0px #fff)"]
                                                        : ["drop-shadow(0 0 0px rgba(99,102,241,0.5))", "drop-shadow(0 0 8px rgba(99,102,241,0.8))", "drop-shadow(0 0 0px rgba(99,102,241,0.5))"]
                                                }}
                                                exit={{ scale: 0.5, opacity: 0 }}
                                                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                                                className="flex items-center justify-center"
                                            >
                                                {/* 只要面板是打开的（手动或自动），就一直显示白色的星星，这是用户最想要的逻辑 */}
                                                {isPanelOpen && !isActionBarVisible ? (
                                                    <Sparkles size={22} fill="currentColor" />
                                                ) : isActionBarVisible ? (
                                                    <ChevronUp size={22} className="rotate-180" />
                                                ) : (
                                                    <Sparkles size={22} fill="currentColor" />
                                                )}
                                            </motion.div>
                                        </AnimatePresence>
                                    </motion.button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </SearchContainer>

                <AnimatePresence>
                    {isPanelOpen && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: -14, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                            className="absolute bottom-full right-0 z-50 pointer-events-none pb-2"
                        >
                            <div className="glass-effect !bg-white/95 dark:!bg-slate-900/95 !backdrop-blur-3xl rounded-[1.5rem] p-1.5 shadow-[0_30px_70px_-10px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] dark:ring-white/[0.06] border-white/80 dark:border-slate-700/60 pointer-events-auto inline-block min-w-max">
                                <DownloadManager />
                            </div>
                            <div className="absolute -bottom-1 right-5 w-4 h-4 bg-white/95 dark:bg-slate-900/95 rotate-45 border-r border-b border-black/[0.03] dark:border-slate-700/60" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
