    function looksLikeKohaLoginHtml(text) {
        const raw = (text || '').toString().toLowerCase();
        return raw.includes('name="login_userid"')
            || raw.includes('id="loginform"')
            || raw.includes('koha login')
            || raw.includes('auth.tt');
    }

    function ensurePluginPostUrl(url) {
        const raw = (url || '').toString();
        if (!raw || !raw.includes('method=')) {
            throw new Error('Plugin method is required.');
        }
        const classFromPath = (rawPath) => {
            const value = (rawPath || '').toString();
            if (!value) return '';
            const qPos = value.indexOf('?');
            if (qPos < 0) return '';
            const parsed = new URLSearchParams(value.slice(qPos + 1));
            return (parsed.get('class') || '').trim();
        };
        const qIndex = raw.indexOf('?');
        const basePath = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
        const query = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
        const params = new URLSearchParams(query);
        if (!params.get('class')) {
            const settings = global.AutoPunctuationSettings || {};
            const fallbackClass = (settings.pluginClass || '').toString().trim()
                || classFromPath(settings.pluginPath)
                || classFromPath(settings.pluginToolPath)
                || classFromPath(settings.pluginBasePath);
            if (fallbackClass) {
                params.set('class', fallbackClass);
            }
        }
        if (!params.get('class')) {
            throw new Error('Plugin class is required.');
        }
        if (!params.get('op')) params.set('op', 'plugin_api');
        return `${basePath}?${params.toString()}`;
    }

    async function postJson(url, payload, options) {
        const finalUrl = ensurePluginPostUrl(url);
        const finalPayload = payload && typeof payload === 'object' ? { ...payload } : {};
        const csrfToken = getCsrfToken();
        if (csrfToken && !finalPayload.csrf_token) {
            finalPayload.csrf_token = csrfToken;
        }
        const opts = options || {};
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (csrfToken) {
            headers['X-CSRF-Token'] = csrfToken;
            headers['CSRF-TOKEN'] = csrfToken;
        }

        const settings = global.AutoPunctuationSettings || {};
        if (settings.debugMode) {
            try {
                const qIndex = finalUrl.indexOf('?');
                const query = qIndex >= 0 ? finalUrl.slice(qIndex + 1) : '';
                const params = new URLSearchParams(query);
                console.debug('[AACR2 Assistant] Plugin dispatch:', {
                    url: finalUrl,
                    class: params.get('class') || '',
                    method: params.get('method') || ''
                });
            } catch (err) {
                console.debug('[AACR2 Assistant] Plugin dispatch URL:', finalUrl);
            }
        }

        const response = await fetch(finalUrl, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify(finalPayload),
            signal: opts.signal
        });
        const jsonResponse = isJsonResponse(response);
        if (!response.ok) {
            let detail = sessionExpiredMessage(response.status);
            if (!detail) {
                if (jsonResponse) {
                    try {
                        const data = await response.json();
                        if (data && typeof data === 'object') {
                            if (data.error) detail = data.error;
                            else if (data.message) detail = data.message;
                            else if (data.details) detail = JSON.stringify(data.details);
                        }
                    } catch (err) {
                        try {
                            const text = await response.text();
                            if (looksLikeKohaLoginHtml(text)) {
                                detail = 'Session expired. Please refresh and log in again.';
                            } else {
                                detail = sanitizeServerMessage(text);
                            }
                        } catch (err2) {
                            detail = '';
                        }
                    }
                } else {
                    try {
                        const text = await response.text();
                        if (looksLikeKohaLoginHtml(text)) {
                            detail = 'Session expired. Please refresh and log in again.';
                        } else {
                            detail = sanitizeServerMessage(text);
                        }
                    } catch (err) {
                        detail = '';
                    }
                }
            }
            throw new Error(buildHttpError(response.status, detail || 'Request failed.'));
        }
        if (!jsonResponse) {
            let text = '';
            try {
                text = await response.text();
            } catch (err) {
                text = '';
            }
            if (looksLikeKohaLoginHtml(text)) {
                throw new Error(buildHttpError(401, 'Session expired. Please refresh and log in again.'));
            }
            throw new Error(buildHttpError(response.status, sanitizeServerMessage(text) || 'Non-JSON response from server.'));
        }
        try {
            return await response.json();
        } catch (err) {
            let text = '';
            try {
                text = await response.text();
            } catch (err2) {
                text = '';
            }
            throw new Error(buildHttpError(response.status, sanitizeServerMessage(text) || 'Response was not valid JSON.'));
        }
    }

    function buildPluginUrl(pluginPath, methodName, extraParams) {
        let path = pluginPath;
        let method = methodName;
        if (methodName === undefined) {
            method = pluginPath;
            path = (global.AutoPunctuationSettings || {}).pluginPath || '';
        }
        if (!method) {
            const message = 'Plugin method is required.';
            if (global.AutoPunctuationSettings && global.AutoPunctuationSettings.debugMode) {
                throw new Error(message);
            }
            console.error(`[AACR2 Assistant] ${message}`);
            return '';
        }

        const settings = global.AutoPunctuationSettings || {};
        const classFromPath = (rawPath) => {
            const value = (rawPath || '').toString();
            if (!value) return '';
            const qIndex = value.indexOf('?');
            if (qIndex < 0) return '';
            const parsed = new URLSearchParams(value.slice(qIndex + 1));
            return (parsed.get('class') || '').trim();
        };
        const fallbackClass = (settings.pluginClass || '').toString().trim()
            || classFromPath(settings.pluginBasePath)
            || classFromPath(settings.pluginToolPath);
        const fallbackBasePath = settings.pluginRunPath || '/cgi-bin/koha/plugins/run.pl';
        const rawPath = (path || '').toString();
        let basePath = fallbackBasePath;
        let className = fallbackClass;
        const qIndex = rawPath.indexOf('?');
        if (qIndex >= 0) {
            basePath = rawPath.slice(0, qIndex) || basePath;
            const parsed = new URLSearchParams(rawPath.slice(qIndex + 1));
            className = (parsed.get('class') || className || '').trim();
        } else if (rawPath) {
            basePath = rawPath;
        }
        if (!className) {
            const message = 'Plugin class is required.';
            if (settings.debugMode) throw new Error(message);
            console.error(`[AACR2 Assistant] ${message}`);
            return '';
        }

        const params = new URLSearchParams();
        params.set('class', className);
        params.set('method', String(method));
        if (extraParams && typeof extraParams === 'object') {
            Object.keys(extraParams).forEach(key => {
                const value = extraParams[key];
                if (value === undefined || value === null || value === '') return;
                params.set(key, String(value));
            });
        }
        return `${basePath}?${params.toString()}`;
    }

    function buildEndpoint(pluginPath, method, extraParams) {
        return buildPluginUrl(pluginPath, method, extraParams);
    }

    function requestMode(settings) {
        const mode = (settings.aiRequestMode || settings.aiClientMode || 'server').toString().toLowerCase();
        return mode === 'direct' || mode === 'browser' ? 'direct' : 'server';
    }

    function providerFromSettings(settings) {
        const provider = (settings.llmApiProvider || '').toString().toLowerCase();
        return provider === 'openai' ? 'openai' : 'openrouter';
    }

    function readFromStorage(storage, keys) {
        if (!storage) return '';
        for (const key of keys) {
            try {
                const value = storage.getItem(key);
                if (value && String(value).trim()) return String(value).trim();
            } catch (err) {
                // ignore storage access errors
            }
        }
        return '';
    }

    function deobfuscateBrowserKey(value) {
        const raw = (value || '').toString().trim();
        if (!raw) return '';
        let decoded = '';
        try {
            decoded = atob(raw);
        } catch (err) {
            return raw;
        }
        const mask = 73;
        let output = '';
        for (let i = 0; i < decoded.length; i += 1) {
            output += String.fromCharCode(decoded.charCodeAt(i) ^ mask);
        }
        return output;
    }

    function directKeyFingerprint(value) {
        const key = (value || '').toString();
        if (!key) return 'none';
        let hash = 5381;
        for (let i = 0; i < key.length; i += 1) {
            hash = ((hash << 5) + hash) + key.charCodeAt(i);
            hash &= 0xffffffff;
        }
        const hex = (hash >>> 0).toString(16).padStart(8, '0');
        return `k${key.length}-${hex}`;
    }

    function getDirectApiKey(settings, provider) {
        if (settings && settings.aiBrowserApiKey) {
            const value = String(settings.aiBrowserApiKey).trim();
            if (value) return value;
        }
        const obfuscatedNames = provider === 'openai'
            ? ['aacr2.openai.api_key.obf']
            : ['aacr2.openrouter.api_key.obf'];
        const obfuscated = readFromStorage(global.sessionStorage, obfuscatedNames) || readFromStorage(global.localStorage, obfuscatedNames);
        if (obfuscated) {
            const decoded = deobfuscateBrowserKey(obfuscated);
            if (decoded) return decoded;
        }
        const keyNames = provider === 'openai'
            ? ['aacr2.openai.api_key', 'aacr2_openai_api_key']
            : ['aacr2.openrouter.api_key', 'aacr2_openrouter_api_key'];
        return readFromStorage(global.sessionStorage, keyNames) || readFromStorage(global.localStorage, keyNames);
    }

    async function aiSuggestDirect(payload, settings) {
        const provider = providerFromSettings(settings);
        const apiKey = getDirectApiKey(settings, provider);
        if (!apiKey) {
            return {
                ok: 0,
                error: `Direct browser mode requires a ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} key in browser storage.`
            };
        }

        if (settings.debugMode) {
            console.debug('[AACR2 Assistant] Direct AI request auth context:', {
                mode: 'direct',
                provider,
                keyFingerprint: directKeyFingerprint(apiKey)
            });
        }

        const prompt = buildAiPrompt(payload, settings);
        const expectJson = strictJsonModeEnabled();
        const providerResult = await callWithRetries(() => (
            provider === 'openai'
                ? callOpenAiResponses(prompt, settings, apiKey, { expectJson })
                : callOpenRouter(prompt, settings, apiKey, { expectJson })
        ), settings.aiRetryCount);

        if (!providerResult) {
            return { ok: 0, error: 'AI request failed.' };
        }
        if (providerResult.error && !providerResult.rawText) {
            return { ok: 0, error: providerResult.error };
        }

        let result = null;
        if (providerResult.textMode || !providerResult.data) {
            const rawText = providerResult.rawText || '';
            if (isCatalogingAiRequest(payload)) {
                result = buildCatalogingTextResponse(payload, rawText, settings, {
                    extractionSource: 'plain_text',
                    degradedMode: false
                }) || buildUnstructuredAiResponse(payload, rawText, settings, {});
            } else {
                result = buildUnstructuredAiResponse(payload, rawText, settings, {});
            }
        } else {
            result = providerResult.data;
        }

        if (!result || typeof result !== 'object') {
            return { ok: 0, error: 'AI response was empty.' };
        }
        const guardrailError = validateAiResponseGuardrails(payload, result, settings);
        if (guardrailError) {
            return { ok: 0, error: guardrailError };
        }
        result = sanitizeAiResponseForChat(result);
        if (providerResult.truncated) {
            result = attachTruncationWarning(result);
        }
        return result;
    }

    global.AACR2ApiClient = {
        validateSchema: validateAgainstSchema,
        postJson,
        validateField: (pluginPath, payload) => {
            const errors = validateAgainstSchema('validate_field_request', payload);
            if (errors.length) return Promise.reject(new Error(`Invalid request: ${errors.join(', ')}`));
            return postJson(buildEndpoint(pluginPath, 'validate_field'), payload);
        },
        validateRecord: (pluginPath, payload) => {
            const errors = validateAgainstSchema('validate_record_request', payload);
            if (errors.length) return Promise.reject(new Error(`Invalid request: ${errors.join(', ')}`));
            return postJson(buildEndpoint(pluginPath, 'validate_record'), payload);
        },
        aiSuggest: async (pluginPath, payload, options) => {
            const settings = global.AutoPunctuationSettings || {};
            const normalized = normalizeAiRequestPayload(payload);
            const errors = validateAgainstSchema('ai_request', normalized);
            if (errors.length) {
                throw new Error(`Invalid request: ${errors.join(', ')}`);
            }
            if (requestMode(settings) === 'direct') {
                return aiSuggestDirect(normalized, settings);
            }
            return postJson(buildEndpoint(pluginPath, 'ai_suggest'), normalized, options);
        },
        testConnection: (pluginPath) => postJson(buildEndpoint(pluginPath, 'test_connection'), {})
    };
})(window);
