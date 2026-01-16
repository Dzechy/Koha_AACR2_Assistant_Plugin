(function(global) {
    'use strict';

    function validateSchema(schema, data, path, errors) {
        if (!schema || typeof schema !== 'object') return;
        const currentPath = path || '$';
        const type = schema.type || '';
        if (type === 'object') {
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                errors.push(`${currentPath} should be object`);
                return;
            }
            if (Array.isArray(schema.required)) {
                schema.required.forEach(key => {
                    if (!(key in data)) errors.push(`${currentPath} missing ${key}`);
                });
            }
            if (schema.properties) {
                Object.keys(schema.properties).forEach(key => {
                    if (key in data) validateSchema(schema.properties[key], data[key], `${currentPath}.${key}`, errors);
                });
            }
        } else if (type === 'array') {
            if (!Array.isArray(data)) {
                errors.push(`${currentPath} should be array`);
                return;
            }
            if (schema.items) {
                data.forEach((item, idx) => validateSchema(schema.items, item, `${currentPath}[${idx}]`, errors));
            }
        } else if (type === 'string') {
            if (typeof data !== 'string') errors.push(`${currentPath} should be string`);
        } else if (type === 'number') {
            if (typeof data !== 'number') errors.push(`${currentPath} should be number`);
        } else if (type === 'boolean') {
            if (typeof data !== 'boolean') errors.push(`${currentPath} should be boolean`);
        }
    }

    function validateAgainstSchema(name, data) {
        const schema = (global.AACR2Schemas || {})[name];
        if (!schema) return [];
        const errors = [];
        validateSchema(schema, data, '$', errors);
        return errors;
    }

    async function postJson(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {})
        });
        if (!response.ok) {
            let detail = '';
            try {
                const data = await response.json();
                if (data && typeof data === 'object') {
                    if (data.error) detail = data.error;
                    else if (data.details) detail = JSON.stringify(data.details);
                }
            } catch (err) {
                try {
                    const text = await response.text();
                    detail = (text || '').trim();
                } catch (err2) {
                    detail = '';
                }
            }
            const suffix = detail ? `: ${detail}` : '';
            throw new Error(`HTTP ${response.status}${suffix}`);
        }
        return response.json();
    }

    function buildEndpoint(pluginPath, method) {
        return `${pluginPath}&method=${method}`;
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
        aiSuggest: (pluginPath, payload) => {
            const errors = validateAgainstSchema('ai_request', payload);
            if (errors.length) return Promise.reject(new Error(`Invalid request: ${errors.join(', ')}`));
            return postJson(buildEndpoint(pluginPath, 'ai_suggest'), payload);
        },
        testConnection: (pluginPath) => postJson(buildEndpoint(pluginPath, 'test_connection'), {})
    };
})(window);
