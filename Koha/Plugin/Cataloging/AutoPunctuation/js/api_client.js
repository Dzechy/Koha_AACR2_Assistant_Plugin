
    async function postJson(url, payload, options) {
        if (!url || !String(url).includes('method=')) {
            throw new Error('Plugin method is required.');
        }
        const finalPayload = payload && typeof payload === 'object' ? { ...payload } : {};
        const csrfToken = getCsrfToken();
        if (csrfToken) {
            finalPayload.csrf_token = csrfToken;
        }
        const opts = options || {};
        const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        const response = await fetch(url, {
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
                            detail = sanitizeServerMessage(text);
                        } catch (err2) {
                            detail = '';
                        }
                    }
                } else {
                    try {
                        const text = await response.text();
                        detail = sanitizeServerMessage(text);
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

    function buildPluginUrl(pluginPath, methodName) {
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
        return `${path}&method=${encodeURIComponent(method)}`;
    }

    function buildEndpoint(pluginPath, method) {
        return buildPluginUrl(pluginPath, method);
    }

    global.AACR2ApiClient = {
        validateSchema: validateAgainstSchema,
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
        aiSuggest: (pluginPath, payload, options) => {
            const settings = global.AutoPunctuationSettings || {};
            const normalized = normalizeAiRequestPayload(payload);
            const errors = validateAgainstSchema('ai_request', normalized);
            if (errors.length) return Promise.reject(new Error(`Invalid request: ${errors.join(', ')}`));
            const requestMode = (settings.aiRequestMode || settings.aiClientMode || 'direct').toLowerCase() === 'server'
                ? 'server'
                : 'direct';
            if (requestMode === 'direct' && settings.debugMode) {
                console.warn('[AACR2 Assistant] Direct AI mode disabled; routing through server.');
            }
            return postJson(buildEndpoint(pluginPath, 'ai_suggest'), normalized, options);
        },
        testConnection: (pluginPath) => postJson(buildEndpoint(pluginPath, 'test_connection'), {})
    };
})(window);
