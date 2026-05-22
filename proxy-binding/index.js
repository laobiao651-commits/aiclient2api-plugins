/**
 * ip-node-proxy 用户插件
 * 为号池中每个账号绑定独立的代理IP
 *
 * 核心机制：
 * 1. middleware 在每个请求中将 ipNodeProxy 对象注入 requestContext
 * 2. proxy-utils.js 的 getNodeProxyUrlFromBinding() 会从 context 读取并使用
 * 3. 管理接口通过 providerPoolManager 读写号池数据，无需直接操作文件
 */

import requestContext from '../../utils/context.js';
import logger from '../../utils/logger.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROXY_POOL_FILE = path.join(__dirname, 'proxy-pool.json');

// 模块级缓存，避免每次请求都动态 import
let _providerPoolManager = null;

async function getPoolManager() {
    if (_providerPoolManager) return _providerPoolManager;
    try {
        const { getProviderPoolManager } = await import('../../services/service-manager.js');
        _providerPoolManager = getProviderPoolManager();
    } catch (e) {
        logger.error('[proxy-binding] Failed to get providerPoolManager:', e.message);
    }
    return _providerPoolManager;
}

/**
 * 认证检查：支持 UI 登录 token 和全局 API Key 两种方式
 */
async function checkAdminAuth(req, config) {
    // 方式1：UI 后台登录 token
    try {
        const { checkAuth } = await import('../../ui-modules/auth.js');
        if (await checkAuth(req)) return true;
    } catch (e) { /* 忽略，继续尝试下一种方式 */ }

    // 方式2：全局 REQUIRED_API_KEY
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (config?.REQUIRED_API_KEY && token === config.REQUIRED_API_KEY) return true;
    }
    const apiKey = req.headers['x-api-key'];
    if (config?.REQUIRED_API_KEY && apiKey === config.REQUIRED_API_KEY) return true;

    return false;
}

/**
 * 脱敏代理URL（隐藏密码）
 */
function maskProxyUrl(url) {
    if (!url) return null;
    return url.replace(/(:\/\/[^:@]+:)[^@]+(@)/, '$1****$2');
}

/**
 * 读写代理池文件
 */
async function readProxyPool() {
    try {
        const content = await fs.readFile(PROXY_POOL_FILE, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        return { proxies: [] };
    }
}

async function writeProxyPool(data) {
    await fs.writeFile(PROXY_POOL_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

const plugin = {
    name: 'proxy-binding',
    version: '1.0.3',
    description: '号池账号代理绑定 - 为每个账号独立绑定出站代理IP<br>管理页面：<a href="ip-node-proxy.html" target="_blank">打开管理界面</a>',
    type: 'middleware',
    _priority: 10,
    staticPaths: ['ip-node-proxy.html', 'ip-node-proxy.css'],

    async init(config) {
        logger.info('[proxy-binding] Plugin itializing...');
        const pm = await getPoolManager();
        if (pm) {
            // 统计已有代理绑定的账号数
            let count = 0;
            for (const nodes of Object.values(pm.providerStatus || {})) {
                for (const node of nodes) {
                    if (node.config?.proxyUrl) count++;
                }
            }
            logger.info(`[proxy-binding] Initialized. Found ${count} existing proxy binding(s).`);
        } else {
            logger.warn('[proxy-binding] providerPoolManager not ready at init time, will retry on first request.');
        }
    },

    async destroy() {
        _providerPoolManager = null;
        logger.info('[proxy-binding] Plugin destroyed.');
    },

    /**
     * 核心中间件：将 ipNodeProxy 注入到 requestContext
     * proxy-utils.js 的 getNodeProxyUrlFromBinding() 会从 context 中读取
     */
    async middleware(req, res, requestUrl, config) {
        try {
            const pm = await getPoolManager();
            if (!pm) return { handled: false };

            requestContext.set('ipNodeProxy', {
                /**
                 * 根据 providerType 和 uuid 返回该账号绑定的代理URL
                 * @param {string} providerType - 提供商类型，如 'claude-kiro-oauth'
                 * @param {string} uuid - 账号唯一标识
                 * @returns {string|null} 代理URL或null
                 */
                getProxyUrl(providerType, uuid) {
                    if (!uuid || !pm.providerStatus) return null;

                    // 先精确匹配 providerType
                    const nodes = pm.providerStatus[providerType];
                    if (nodes) {
                        const node = nodes.find(n => n.uuid === uuid || n.config?.uuid === uuid);
                        if (node?.config?.proxyUrl) {
                            logger.info(`[proxy-binding] Using proxy for ${providerType}/${uuid}: ${maskProxyUrl(node.config.proxyUrl)}`);
                            return node.config.proxyUrl;
                        }
                    }

                    // 跨类型查找（兜底）
                    for (const [type, typeNodes] of Object.entries(pm.providerStatus)) {
                        const node = typeNodes.find(n => n.uuid === uuid || n.config?.uuid === uuid);
                        if (node?.config?.proxyUrl) {
                            logger.info(`[proxy-binding] Using proxy for ${type}/${uuid}: ${maskProxyUrl(node.config.proxyUrl)}`);
                            return node.config.proxyUrl;
                        }
                    }

                    return null;
                },

                // 客户端真实IP（供日志使用）
                clientIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                    || req.headers['x-real-ip']
                    || req.socket?.remoteAddress
                    || 'unknown'
            });
        } catch (error) {
            logger.error('[proxy-binding] Middleware error:', error.message);
        }
        return { handled: false };
    },

    routes: [
        /**
         * GET /api/proxy-binding/list
         * 列出所有号池账号及其代理绑定状态
         */
        {
            method: 'GET',
            path: '/api/proxy-binding/list',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                try {
                    const pm = await getPoolManager();
                    const list = [];

                    if (pm?.providerStatus) {
                        const poolData = await readProxyPool();
                        for (const [providerType, nodes] of Object.entries(pm.providerStatus)) {
                            for (const node of nodes) {
                                const fullProxyUrl = node.config?.proxyUrl || null;
                                let proxySourceName = null;
                                if (fullProxyUrl) {
                                    const matchedProxy = poolData.proxies.find(p => p.url === fullProxyUrl);
                                    if (matchedProxy) proxySourceName = matchedProxy.name;
                                }

                                list.push({
                                    providerType,
                                    uuid: node.config?.uuid || node.uuid,
                                    customName: node.config?.customName || '',
                                    proxyUrl: maskProxyUrl(fullProxyUrl),
                                    proxySourceName,
                                    hasProxy: !!fullProxyUrl,
                                    isHealthy: node.config?.isHealthy ?? true,
                                    isDisabled: node.config?.isDisabled ?? false,
                                    usageCount: node.config?.usageCount ?? 0,
                                    errorCount: node.config?.errorCount ?? 0,
                                    lastUsed: node.config?.lastUsed || null,
                                    credsFile: (() => {
                                        const p = node.config?.KIRO_OAUTH_CREDS_FILE_PATH || '';
                                        return p ? p.split('/').pop() : null;
                                    })()
                                });
                            }
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, total: list.length, data: list }));
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * POST /api/proxy-binding/set
         * 为指定账号设置代理
         * Body: { uuid: string, proxyUrl: string }
         */
        {
            method: 'POST',
            path: '/api/proxy-binding/set',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const { uuid, proxyUrl } = JSON.parse(body || '{}');
                    if (!uuid) throw new Error('uuid is required');
                    if (!proxyUrl) throw new Error('proxyUrl is required');

                    // 校验 URL 格式
                    try { new URL(proxyUrl); } catch (e) {
                        throw new Error('Invalid proxyUrl format. Expected: http://host:port or socks5://host:port');
                    }

                    const pm = await getPoolManager();
                    if (!pm) throw new Error('providerPoolManager not available');

                    let found = false;
                    for (const [providerType, nodes] of Object.entries(pm.providerStatus || {})) {
                        const node = nodes.find(n => (n.config?.uuid || n.uuid) === uuid);
                        if (node) {
                            node.config.proxyUrl = proxyUrl;
                            // 持久化到 provider_pools.json
                            if (typeof pm._debouncedSave === 'function') {
                                pm._debouncedSave(providerType);
                            }
                            found = true;
                            logger.info(`[proxy-binding] Set proxy for ${providerType}/${uuid}: ${maskProxyUrl(proxyUrl)}`);
                            break;
                        }
                    }

                    if (!found) throw new Error(`Account with uuid "${uuid}" not found in any provider pool`);

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, message: `Proxy cleared for ${uuid}` }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * POST /api/proxy-binding/batch-set
         * 批量设置代理
         * Body: { uuids: string[], proxyUrl: string }
         */
        {
            method: 'POST',
            path: '/api/proxy-binding/batch-set',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const { uuids, proxyUrl } = JSON.parse(body || '{}');
                    if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('uuids array is required');
                    if (!proxyUrl) throw new Error('proxyUrl is required');

                    try { new URL(proxyUrl); } catch (e) { throw new Error('Invalid proxyUrl format'); }

                    const pm = await getPoolManager();
                    if (!pm) throw new Error('providerPoolManager not available');

                    let successCount = 0;
                    const affectedProviders = new Set();

                    for (const uuid of uuids) {
                        for (const [providerType, nodes] of Object.entries(pm.providerStatus || {})) {
                            const node = nodes.find(n => (n.config?.uuid || n.uuid) === uuid);
                            if (node) {
                                node.config.proxyUrl = proxyUrl;
                                affectedProviders.add(providerType);
                                successCount++;
                                break;
                            }
                        }
                    }

                    for (const providerType of affectedProviders) {
                        if (typeof pm._debouncedSave === 'function') {
                            pm._debouncedSave(providerType);
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, count: successCount }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * POST /api/proxy-binding/batch-clear
         * 批量清除代理
         * Body: { uuids: string[] }
         */
        {
            method: 'POST',
            path: '/api/proxy-binding/batch-clear',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const { uuids } = JSON.parse(body || '{}');
                    if (!Array.isArray(uuids) || uuids.length === 0) throw new Error('uuids array is required');

                    const pm = await getPoolManager();
                    if (!pm) throw new Error('providerPoolManager not available');

                    let successCount = 0;
                    const affectedProviders = new Set();

                    for (const uuid of uuids) {
                        for (const [providerType, nodes] of Object.entries(pm.providerStatus || {})) {
                            const node = nodes.find(n => (n.config?.uuid || n.uuid) === uuid);
                            if (node) {
                                delete node.config.proxyUrl;
                                affectedProviders.add(providerType);
                                successCount++;
                                break;
                            }
                        }
                    }

                    for (const providerType of affectedProviders) {
                        if (typeof pm._debouncedSave === 'function') {
                            pm._debouncedSave(providerType);
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, count: successCount }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },


        /**
         * GET /api/proxy-binding/proxy-pool
         * 获取代理池列表，并附带统计信息
         */
        {
            method: 'GET',
            path: '/api/proxy-binding/proxy-pool',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                try {
                    const poolData = await readProxyPool();
                    const pm = await getPoolManager();
                    
                    // 统计每个代理的使用情况
                    if (pm?.providerStatus) {
                        poolData.proxies.forEach(proxy => {
                            proxy.usedBy = [];
                            for (const nodes of Object.values(pm.providerStatus)) {
                                for (const node of nodes) {
                                    if (node.config?.proxyUrl === proxy.url) {
                                        proxy.usedBy.push(node.config?.uuid || node.uuid);
                                    }
                                }
                            }
                        });
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, data: poolData.proxies }));
                } catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * POST /api/proxy-binding/proxy-pool
         * 添加代理（单个或批量）
         */
        {
            method: 'POST',
            path: '/api/proxy-binding/proxy-pool',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const payload = JSON.parse(body || '{}');
                    const poolData = await readProxyPool();
                    const added = [];
                    let failedCount = 0;

                    const processProxy = (p) => {
                        if (!p.url) return null;
                        try {
                            const urlObj = new URL(p.url);
                            return {
                                id: `proxy-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                                name: p.name || `代理-${poolData.proxies.length + added.length + 1}`,
                                url: p.url,
                                protocol: urlObj.protocol.replace(':', ''),
                                createdAt: new Date().toISOString()
                            };
                        } catch (e) {
                            failedCount++;
                            return null;
                        }
                    };

                    if (Array.isArray(payload.proxies)) {
                        for (const p of payload.proxies) {
                            const newProxy = processProxy(p);
                            if (newProxy) added.push(newProxy);
                        }
                    } else if (payload.url) {
                        const newProxy = processProxy(payload);
                        if (newProxy) added.push(newProxy);
                        else throw new Error('Invalid proxy URL');
                    } else {
                        throw new Error('Invalid request payload');
                    }

                    poolData.proxies.push(...added);
                    await writeProxyPool(poolData);

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        data: Array.isArray(payload.proxies) ? added : added[0], 
                        count: added.length,
                        failed: failedCount
                    }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * PUT /api/proxy-binding/proxy-pool/:id
         * 更新代理信息
         */
        {
            method: 'PUT',
            path: '/api/proxy-binding/proxy-pool/', // 简便起见，匹配包含 ID 的路径
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                const id = reqPath.split('/').pop();
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const { name, url } = JSON.parse(body || '{}');
                    const poolData = await readProxyPool();
                    const index = poolData.proxies.findIndex(p => p.id === id);
                    if (index === -1) throw new Error('Proxy not found');

                    if (url) {
                        try { new URL(url); } catch (e) { throw new Error('Invalid proxy URL'); }
                        poolData.proxies[index].url = url;
                        poolData.proxies[index].protocol = new URL(url).protocol.replace(':', '');
                    }
                    if (name) poolData.proxies[index].name = name;

                    await writeProxyPool(poolData);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, data: poolData.proxies[index] }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * DELETE /api/proxy-binding/proxy-pool/:id
         * 删除代理
         */
        {
            method: 'DELETE',
            path: '/api/proxy-binding/proxy-pool/',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                const id = reqPath.split('/').pop();
                try {
                    const poolData = await readProxyPool();
                    const initialLength = poolData.proxies.length;
                    poolData.proxies = poolData.proxies.filter(p => p.id !== id);
                    
                    if (poolData.proxies.length === initialLength) throw new Error('Proxy not found');

                    await writeProxyPool(poolData);
                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, message: 'Deleted' }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        },

        /**
         * DELETE /api/proxy-binding/clear
         * 清除指定账号的代理绑定
         * Body: { uuid: string }
         */
        {
            method: 'DELETE',
            path: '/api/proxy-binding/clear',
            handler: async (method, reqPath, req, res, config) => {
                if (!await checkAdminAuth(req, config)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
                    return true;
                }

                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                await new Promise(resolve => req.on('end', resolve));

                try {
                    const { uuid } = JSON.parse(body || '{}');
                    if (!uuid) throw new Error('uuid is required');

                    const pm = await getPoolManager();
                    if (!pm) throw new Error('providerPoolManager not available');

                    let found = false;
                    for (const [providerType, nodes] of Object.entries(pm.providerStatus || {})) {
                        const node = nodes.find(n => (n.config?.uuid || n.uuid) === uuid);
                        if (node) {
                            delete node.config.proxyUrl;
                            if (typeof pm._debouncedSave === 'function') {
                                pm._debouncedSave(providerType);
                            }
                            found = true;
                            logger.info(`[proxy-binding] Cleared proxy for ${providerType}/${uuid}`);
                            break;
                        }
                    }

                    if (!found) throw new Error(`Account with uuid "${uuid}" not found in any provider pool`);

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, message: `Proxy cleared for ${uuid}` }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
                return true;
            }
        }
    ]
};

export default plugin;
