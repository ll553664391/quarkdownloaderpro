import axios from 'axios';
import { useQuarkStore } from '../store/useQuarkStore';

const http = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api',
});

// 请求拦截：自动注入 x-cookie
http.interceptors.request.use((config) => {
    const cookie = localStorage.getItem('quark_cookie');
    if (cookie) {
        config.headers['x-cookie'] = cookie;
    }
    return config;
});

// 响应拦截：处理 x-append-cookie
http.interceptors.response.use((response) => {
    const appendCookie = response.headers['x-append-cookie'];
    if (appendCookie) {
        const currentCookie = localStorage.getItem('quark_cookie') || '';
        // __puus 是 CDN 防盗链签名且会被服务端刷新，必须始终用最新值：
        // 移除旧的 __puus 并把最新值追加到末尾（CDN 校验取最后一个 __puus）。
        // 若缓存旧值不刷新（历史逻辑），服务端刷新签名后会全部 412
        const cleaned = currentCookie
            .replace(/(^|;\s*)__puus=[^;]*/g, '')
            .replace(/^;\s*/, '');
        const newCookie = cleaned ? `${cleaned}; ${appendCookie}` : appendCookie;
        localStorage.setItem('quark_cookie', newCookie);
        // 同步更新 Zustand store，确保下载等功能能拿到完整 Cookie
        useQuarkStore.getState().setCookie(newCookie);
        console.log('[HTTP] Refreshed __puus cookie');
    }
    return response;
});

export default http;
