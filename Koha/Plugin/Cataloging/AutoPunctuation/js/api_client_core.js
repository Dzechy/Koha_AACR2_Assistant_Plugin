(function(global) {
    'use strict';

    const AiTextExtract = global.AACR2AiTextExtract || {};

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
            if (schema.additionalProperties === false && schema.properties) {
                Object.keys(data).forEach(key => {
                    if (!(key in schema.properties)) errors.push(`${currentPath} has unexpected property ${key}`);
                });
            }
        } else if (type === 'array') {
            if (!Array.isArray(data)) {
                errors.push(`${currentPath} should be array`);
                return;
            }
            if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
                errors.push(`${currentPath} must have at least ${schema.minItems} items`);
            }
            if (typeof schema.maxItems === 'number' && data.length > schema.maxItems) {
                errors.push(`${currentPath} must have at most ${schema.maxItems} items`);
            }
            if (schema.items) {
                data.forEach((item, idx) => validateSchema(schema.items, item, `${currentPath}[${idx}]`, errors));
            }
        } else if (type === 'string') {
            if (typeof data !== 'string') errors.push(`${currentPath} should be string`);
            if (typeof schema.minLength === 'number' && typeof data === 'string' && data.length < schema.minLength) {
                errors.push(`${currentPath} must be at least ${schema.minLength} characters`);
            }
            if (typeof schema.maxLength === 'number' && typeof data === 'string' && data.length > schema.maxLength) {
                errors.push(`${currentPath} must be at most ${schema.maxLength} characters`);
            }
            if (Array.isArray(schema.enum) && typeof data === 'string' && !schema.enum.includes(data)) {
                errors.push(`${currentPath} must be one of enum values`);
            }
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

    function parseList(value) {
        if (!value) return [];
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    function normalizeCsrfToken(raw) {
        if (raw === undefined || raw === null) return '';
        let value = String(raw).replace(/[\r\n]/g, '').trim();
        if (!value) return '';
        if (value.includes(',')) {
            value = value.split(',').map(item => item.trim()).filter(Boolean)[0] || '';
        }
        return value;
    }

    function isPluginCsrfToken(value) {
        return /^[a-f0-9]{64}$/i.test(String(value || '').trim());
    }

    function getCsrfToken() {
        const settings = global.AutoPunctuationSettings || {};
        const settingsToken = normalizeCsrfToken(settings.csrfToken || settings.csrf_token || '');
        if (settingsToken && isPluginCsrfToken(settingsToken)) return settingsToken;
        const hidden = document.getElementById('csrf_token');
        if (hidden) {
            const hiddenToken = normalizeCsrfToken(hidden.value || hidden.getAttribute('value') || '');
            if (hiddenToken && isPluginCsrfToken(hiddenToken)) return hiddenToken;
        }
        const input = document.querySelector('input[name="csrf_token"]');
        if (input) {
            const inputToken = normalizeCsrfToken(input.value || input.getAttribute('value') || '');
            if (inputToken && isPluginCsrfToken(inputToken)) return inputToken;
        }
        const metas = Array.from(document.querySelectorAll('meta[name="csrf-token"]'));
        for (const meta of metas) {
            const token = normalizeCsrfToken(meta ? meta.getAttribute('content') : '');
            if (token && isPluginCsrfToken(token)) return token;
        }
        return '';
    }

    function normalizeOccurrence(value) {
        if (value === undefined || value === null || value === '') return 0;
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    function normalizeTagContext(tagContext, maxSubfields) {
        if (!tagContext || typeof tagContext !== 'object') return {};
        const subfields = Array.isArray(tagContext.subfields) ? tagContext.subfields.slice() : [];
        let normalizedSubs = subfields.filter(sub => sub && typeof sub === 'object').map(sub => ({
            code: sub.code || '',
            value: sub.value !== undefined && sub.value !== null ? String(sub.value) : ''
        }));
        if (typeof maxSubfields === 'number' && normalizedSubs.length > maxSubfields) {
            const primary = normalizedSubs[0];
            normalizedSubs = [primary].concat(normalizedSubs.slice(1, maxSubfields));
        }
        return {
            ...tagContext,
            occurrence: normalizeOccurrence(tagContext.occurrence),
            subfields: normalizedSubs
        };
    }

    function normalizeRecordContext(recordContext, maxFields, maxSubfields) {
        if (!recordContext || typeof recordContext !== 'object') return null;
        let fields = Array.isArray(recordContext.fields) ? recordContext.fields.slice() : [];
        if (typeof maxFields === 'number' && fields.length > maxFields) {
            fields = fields.slice(0, maxFields);
        }
        const normalizedFields = fields.map(field => {
            const subfields = Array.isArray(field.subfields) ? field.subfields.slice() : [];
            const trimmedSubs = typeof maxSubfields === 'number' && subfields.length > maxSubfields
                ? subfields.slice(0, maxSubfields)
                : subfields;
            return {
                ...field,
                occurrence: normalizeOccurrence(field.occurrence),
                subfields: trimmedSubs.filter(sub => sub && typeof sub === 'object').map(sub => ({
                    code: sub.code || '',
                    value: sub.value !== undefined && sub.value !== null ? String(sub.value) : ''
                }))
            };
        });
        return { fields: normalizedFields };
    }

    function normalizeFeatures(features) {
        return {
            punctuation_explain: !!(features && features.punctuation_explain),
            subject_guidance: !!(features && features.subject_guidance),
            call_number_guidance: !!(features && features.call_number_guidance)
        };
    }

    function normalizeAiRequestPayload(payload) {
        if (!payload || typeof payload !== 'object') return {};
        const normalized = { ...payload };
        normalized.tag_context = normalizeTagContext(payload.tag_context, 20);
        normalized.features = normalizeFeatures(payload.features);
        if (payload.record_context) {
            normalized.record_context = normalizeRecordContext(payload.record_context, 30, 30);
        }
        return normalized;
    }

    function shouldRedactValue(settings, tag, code, value) {
        if (settings.aiRedact856Querystrings && tag === '856' && (code || '').toLowerCase() === 'u') {
            if (value && /[?&]/.test(value)) return true;
        }
        const rules = parseList(settings.aiRedactionRules || '');
        return rules.some(entry => {
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            return false;
        });
    }

    function redactTagContext(tagContext, settings) {
        if (!tagContext || typeof tagContext !== 'object') return {};
        const clone = { ...tagContext };
        if (Array.isArray(clone.subfields)) {
            clone.subfields = clone.subfields.map(sub => {
                const value = shouldRedactValue(settings, clone.tag, sub.code, sub.value)
                    ? '[REDACTED]'
                    : (sub.value || '');
                return { code: sub.code, value };
            });
        }
        return clone;
    }

    function redactRecordContext(recordContext, settings) {
        if (!recordContext || typeof recordContext !== 'object') return {};
        const fields = Array.isArray(recordContext.fields) ? recordContext.fields : [];
        return {
            fields: fields.map(field => {
                const subfields = Array.isArray(field.subfields) ? field.subfields : [];
                return {
                    ...field,
                    subfields: subfields.map(sub => {
                        const value = shouldRedactValue(settings, field.tag, sub.code, sub.value)
                            ? '[REDACTED]'
                            : (sub.value || '');
                        return { code: sub.code, value };
                    })
                };
            })
        };
    }

    function isExcludedField(settings, tag, code) {
        if (!settings.enableLocalFields && /^9\d\d$/.test(tag)) return true;
        const allowlist = parseList(settings.localFieldsAllowlist || '');
        if (settings.enableLocalFields && allowlist.length) {
            const allowed = allowlist.some(entry => {
                if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
                if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
                if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
                if (/^\d{3}$/i.test(entry)) return entry === tag;
                return false;
            });
            if (!allowed) return true;
        }
        const excluded = parseList(settings.excludedTags || '');
        return excluded.some(entry => {
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            return false;
        });
    }

    function filterRecordContext(recordContext, settings, tagContext) {
        const mode = settings.aiContextMode || 'tag_only';
        if (mode === 'tag_only') return null;
        if (!recordContext || typeof recordContext !== 'object') return null;
        const fields = Array.isArray(recordContext.fields) ? recordContext.fields : [];
        if (!fields.length) return null;
        if (mode === 'tag_plus_neighbors') {
            const targetTag = tagContext && tagContext.tag ? tagContext.tag : '';
            const targetOcc = tagContext ? normalizeOccurrence(tagContext.occurrence) : 0;
            const idx = fields.findIndex(field => field.tag === targetTag && normalizeOccurrence(field.occurrence) === targetOcc);
            if (idx >= 0) {
                const subset = [];
                if (idx > 0) subset.push(fields[idx - 1]);
                subset.push(fields[idx]);
                if (idx < fields.length - 1) subset.push(fields[idx + 1]);
                return { fields: subset };
            }
            return { fields: fields.slice(0, Math.min(fields.length, 3)) };
        }
        const max = 30;
        if (fields.length > max) {
            return { fields: fields.slice(0, max) };
        }
        return { fields };
    }
