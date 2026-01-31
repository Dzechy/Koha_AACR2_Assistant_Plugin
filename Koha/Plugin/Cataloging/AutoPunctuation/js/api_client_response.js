
    function summarizeAiFindings(findings) {
        if (!Array.isArray(findings)) return '';
        const lines = [];
        findings.forEach(finding => {
            if (!finding || typeof finding !== 'object') return;
            const message = (finding.message || '').trim();
            const rationale = (finding.rationale || '').trim();
            if (message && rationale && message !== rationale) {
                lines.push(`${message} - ${rationale}`);
            } else if (message) {
                lines.push(message);
            } else if (rationale) {
                lines.push(rationale);
            }
        });
        return lines.join('\n');
    }

    function confidencePercentFromFindings(findings) {
        if (!Array.isArray(findings)) return 50;
        const values = findings
            .map(finding => (finding && typeof finding.confidence === 'number' ? finding.confidence : null))
            .filter(value => value !== null && value >= 0 && value <= 1);
        if (!values.length) return 50;
        const sum = values.reduce((acc, val) => acc + val, 0);
        const avg = sum / values.length;
        return Math.min(100, Math.max(0, Math.round(avg * 100)));
    }

    function attachTruncationWarning(result) {
        if (!result || typeof result !== 'object') return result;
        const message = 'Output truncated. Increase max output tokens or reduce reasoning effort.';
        if (!Array.isArray(result.errors)) result.errors = [];
        if (!result.errors.find(err => err && err.code === 'OUTPUT_TRUNCATED')) {
            result.errors.push({ code: 'OUTPUT_TRUNCATED', message });
        }
        return result;
    }

    function sanitizeAiResponseForChat(result) {
        if (!result || typeof result !== 'object') return result;
        const findings = Array.isArray(result.findings) ? result.findings : [];
        findings.forEach(finding => {
            if (!finding || typeof finding !== 'object') return;
            finding.proposed_fixes = [];
        });
        result.findings = findings;
        const message = (result.assistant_message || '').trim() || summarizeAiFindings(findings) || 'No AI suggestions returned.';
        result.assistant_message = message;
        let confidence = result.confidence_percent;
        if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
            confidence = confidencePercentFromFindings(findings);
        }
        result.confidence_percent = Math.min(100, Math.max(0, Math.round(confidence)));
        return result;
    }

    async function requestWithTimeout(url, options, timeoutSeconds) {
        const controller = new AbortController();
        const timeout = Math.max(5, Number(timeoutSeconds) || 30) * 1000;
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            return response;
        } finally {
            clearTimeout(timer);
        }
    }

    async function extractErrorDetail(response, provider) {
        let detail = '';
        try {
            const data = await response.clone().json();
            if (provider === 'openai') {
                detail = (data && data.error && (data.error.message || data.error.code)) || '';
            } else if (provider === 'openrouter') {
                detail = (data && data.error && (data.error.message || data.error.code))
                    || (data && data.data && data.data.error && data.data.error.message)
                    || '';
            }
        } catch (err) {
            try {
                const text = await response.clone().text();
                detail = (text || '').trim();
            } catch (err2) {
                detail = '';
            }
        }
        if (detail) {
            detail = detail.replace(/\s+/g, ' ').slice(0, 200);
        }
        return detail;
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function strictJsonModeEnabled() {
        return false;
    }

    function sanitizeServerMessage(text) {
        return (text || '')
            .toString()
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200);
    }

    function sessionExpiredMessage(status) {
        return (status === 401 || status === 403)
            ? 'Session expired. Please refresh and log in again.'
            : '';
    }

    function isJsonResponse(response) {
        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        return contentType.includes('application/json');
    }

    function buildHttpError(status, message) {
        const detail = (message || '').toString().trim();
        return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
    }

    async function callWithRetries(callFn, retryCount) {
        const attempts = Math.max(0, Number(retryCount) || 0) + 1;
        let backoff = 200;
        let lastResult = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const result = await callFn();
                lastResult = result;
                if (!result || !result.error) return result;
            } catch (err) {
                lastResult = { error: err && err.message ? err.message : 'AI request failed.' };
            }
            if (attempt < attempts - 1) {
                await delay(backoff);
                backoff *= 2;
            }
        }
        return lastResult || { error: 'AI request failed.' };
    }

    function extractResponseText(data) {
        let content = '';
        const chat = extractChatCompletionText(data);
        if (chat) return chat;
        if (data && data.message && typeof data.message.content === 'string') {
            return data.message.content;
        }
        if (data && Array.isArray(data.output)) {
            data.output.forEach(item => {
                if (Array.isArray(item.content)) {
                    item.content.forEach(chunk => {
                        if (chunk && chunk.text) content += chunk.text;
                        else if (chunk && chunk.output_text) content += chunk.output_text;
                    });
                }
            });
        }
        if (!content && data && data.output_text) content = data.output_text;
        return content;
    }

    function extractChatCompletionText(data) {
        if (data && Array.isArray(data.choices)) {
            for (const choice of data.choices) {
                if (choice && choice.message && typeof choice.message.content === 'string') {
                    return choice.message.content;
                }
                if (choice && choice.delta && typeof choice.delta.content === 'string') {
                    return choice.delta.content;
                }
            }
        }
        return '';
    }

    function cleanJsonText(content) {
        const text = (content || '').toString().trim();
        if (!text) return '';
        const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
        if (fenced) return fenced[1].trim();
        return text;
    }

    function tryParseJson(content) {
        const cleaned = cleanJsonText(content);
        if (!cleaned) return null;
        try {
            return JSON.parse(cleaned);
        } catch (err) {
            let start = cleaned.indexOf('{');
            let end = cleaned.lastIndexOf('}');
            if (start !== -1 && end > start) {
                try {
                    return JSON.parse(cleaned.slice(start, end + 1));
                } catch (err2) {
                    // fall through
                }
            }
            start = cleaned.indexOf('[');
            end = cleaned.lastIndexOf(']');
            if (start !== -1 && end > start) {
                try {
                    return JSON.parse(cleaned.slice(start, end + 1));
                } catch (err3) {
                    // fall through
                }
            }
        }
        return null;
    }

    async function callOpenAiResponses(prompt, settings, apiKey, options) {
        const model = (settings.aiModel || '').toString().trim();
        if (!model || model.toLowerCase() === 'default') return { error: 'OpenAI model not configured.' };
        const expectJson = options && Object.prototype.hasOwnProperty.call(options, 'expectJson') ? !!options.expectJson : true;
        const systemPrompt = options && options.systemPrompt
            ? options.systemPrompt
            : (expectJson
                ? 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return JSON only.'
                : 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return plain text only.');
        const maxTokens = Math.round(Number(settings.aiMaxTokens) || 1024);
        const payload = {
            model,
            input: [
                {
                    role: 'system',
                    content: [{ type: 'text', text: systemPrompt }]
                },
                {
                    role: 'user',
                    content: [{ type: 'text', text: prompt }]
                }
            ],
            max_output_tokens: maxTokens,
            temperature: Number(settings.aiTemperature) || 0
        };
        const effort = normalizeReasoningEffort(settings.aiReasoningEffort);
        if (effort !== 'none' && isOpenAiReasoningModel(model)) {
            payload.reasoning = { effort };
        }
        const response = await requestWithTimeout('https://api.openai.com/v1/responses', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        }, settings.aiTimeout);
        if (!response.ok) {
            const detail = await extractErrorDetail(response, 'openai');
            const suffix = detail ? ` - ${detail}` : '';
            return { error: `OpenAI API error: ${response.status}${suffix}` };
        }
        let data;
        let rawBody = '';
        try {
            rawBody = await response.text();
            data = JSON.parse(rawBody);
        } catch (err) {
            return { error: 'OpenAI API response was not valid JSON.', rawResponse: rawBody || '' };
        }
        const content = extractResponseText(data);
        if (!content) return { error: 'OpenAI response was empty.' };
        const truncated = detectTruncation(data);
        if (!expectJson) return { rawText: content, textMode: true, truncated };
        const parsed = tryParseJson(content);
        return parsed
            ? { data: parsed, rawText: content, rawResponse: rawBody, truncated }
            : { error: 'OpenAI response was not valid JSON.', rawText: content, rawResponse: rawBody, parseError: 'Unable to parse JSON from model output.', truncated };
    }

    async function callOpenRouter(prompt, settings, apiKey, options) {
        const model = (settings.aiModel || '').toString().trim();
        if (!model || model.toLowerCase() === 'default') return { error: 'OpenRouter model not configured.' };
        const expectJson = options && Object.prototype.hasOwnProperty.call(options, 'expectJson') ? !!options.expectJson : true;
        const systemPrompt = options && options.systemPrompt
            ? options.systemPrompt
            : (expectJson
                ? 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return JSON only.'
                : 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return plain text only.');
        const maxTokens = Math.round(Number(settings.aiMaxTokens) || 1024);
        const payload = {
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: maxTokens,
            temperature: Number(settings.aiTemperature) || 0,
            model
        };
        const response = await requestWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': settings.pluginRepoUrl || window.location.origin,
                'X-Title': 'Koha AACR2 Assistant'
            },
            body: JSON.stringify(payload)
        }, settings.aiTimeout);
        if (!response.ok) {
            const detail = await extractErrorDetail(response, 'openrouter');
            const suffix = detail ? ` - ${detail}` : '';
            return { error: `OpenRouter API error: ${response.status}${suffix}` };
        }
        let data;
        let rawBody = '';
        try {
            rawBody = await response.text();
            data = JSON.parse(rawBody);
        } catch (err) {
            return { error: 'OpenRouter API response was not valid JSON.', rawResponse: rawBody || '' };
        }
        if (data && data.error) {
            const message = data.error.message || data.error;
            return { error: `OpenRouter API error: ${message}` };
        }
        const content = extractChatCompletionText(data) || extractResponseText(data);
        if (!content) return { error: 'OpenRouter response was empty.' };
        const truncated = detectTruncation(data);
        if (!expectJson) return { rawText: content, textMode: true, truncated };
        const parsed = tryParseJson(content);
        return parsed
            ? { data: parsed, rawText: content, rawResponse: rawBody, truncated }
            : {
                error: 'OpenRouter response was not valid JSON. The plugin will display plain text instead.',
                rawText: content,
                rawResponse: rawBody,
                parseError: 'Unable to parse JSON from model output.',
                truncated
            };
    }


    function extractCatalogingSuggestionsFromText(rawText) {
        if (AiTextExtract && typeof AiTextExtract.extractCatalogingSuggestionsFromText === 'function') {
            return AiTextExtract.extractCatalogingSuggestionsFromText(rawText || '');
        }
        return { classification: '', subjects: [], confidence_percent: null };
    }

    function buildUnstructuredAiResponse(payload, rawText, settings, options) {
        if (!payload || !rawText) return null;
        const assistantMessage = String(rawText || '').trim().replace(/\r\n/g, '\n').slice(0, 4000);
        const excerpt = assistantMessage.replace(/\s+/g, ' ').slice(0, 240);
        const response = {
            success: true,
            degraded_mode: true,
            raw_text_excerpt: excerpt,
            version: settings.aiPromptVersion || '2.3',
            request_id: payload.request_id,
            tag_context: payload.tag_context,
            assistant_message: assistantMessage,
            confidence_percent: 50,
            classification: '',
            subjects: [],
            issues: [],
            findings: [],
            errors: [],
            disclaimer: 'Suggestions only; review before saving.'
        };
        if (options && options.debug) response.debug = options.debug;
        return response;
    }

    function buildCatalogingTextResponse(payload, rawText, settings, options) {
        if (!payload || !rawText) return null;
        const features = payload.features || {};
        if (!features.call_number_guidance && !features.subject_guidance) return null;
        const extracted = extractCatalogingSuggestionsFromText(rawText);
        let selected = extracted.classification || '';
        const rangeMessage = AiTextExtract && typeof AiTextExtract.detectClassificationRange === 'function'
            ? AiTextExtract.detectClassificationRange(rawText)
            : '';
        if (rangeMessage) selected = '';
        const target = AiTextExtract && typeof AiTextExtract.parseLcTarget === 'function'
            ? AiTextExtract.parseLcTarget(settings.lcClassTarget || '050$a')
            : null;
        const targetExcluded = target ? isExcludedField(settings, target.tag, target.code) : false;
        const extractionSource = options && options.extractionSource ? options.extractionSource : 'raw_text';
        const degradedMode = options && Object.prototype.hasOwnProperty.call(options, 'degradedMode')
            ? !!options.degradedMode
            : true;
        const findings = [];
        const errors = [];
        if (features.call_number_guidance) {
            const message = selected || '';
            let rationale = extractionSource === 'plain_text'
                ? 'Extracted from AI text output.'
                : 'AI returned non-structured output; extracted LC classification candidate.';
            if (targetExcluded && target && message) {
                rationale += ` Target ${target.tag}$${target.code} is excluded.`;
            }
            findings.push({
                severity: 'INFO',
                code: 'AI_CLASSIFICATION',
                message,
                rationale,
                proposed_fixes: [],
                confidence: 0.2
            });
        }
        if (rangeMessage) {
            errors.push({
                code: 'CLASSIFICATION_RANGE',
                field: 'classification',
                message: rangeMessage
            });
        }
        if (features.subject_guidance) {
            const subjects = Array.isArray(extracted.subjects) ? extracted.subjects : [];
            const subjectsText = subjects.length ? subjects.join('; ') : '';
            const rationale = extractionSource === 'plain_text'
                ? 'Extracted from AI text output.'
                : 'AI returned non-structured output; extracted subject headings.';
            findings.push({
                severity: 'INFO',
                code: 'AI_SUBJECTS',
                message: subjectsText,
                rationale,
                proposed_fixes: [],
                confidence: 0.2
            });
        }
        const subjectsStructured = AiTextExtract && typeof AiTextExtract.subjectsFromHeadingList === 'function'
            ? AiTextExtract.subjectsFromHeadingList(extracted.subjects || [])
            : [];
        const assistantMessage = String(rawText || '').trim().replace(/\r\n/g, '\n').slice(0, 4000);
        const excerpt = assistantMessage.replace(/\s+/g, ' ').slice(0, 240);
        const confidencePercent = (extracted.confidence_percent !== null && extracted.confidence_percent !== undefined)
            ? extracted.confidence_percent
            : 20;
        const response = {
            success: true,
            degraded_mode: degradedMode,
            extracted_call_number: selected || undefined,
            extraction_source: extractionSource,
            raw_text_excerpt: excerpt,
            version: settings.aiPromptVersion || '2.3',
            request_id: payload.request_id,
            tag_context: payload.tag_context,
            assistant_message: assistantMessage,
            confidence_percent: Number(confidencePercent) || 0,
            classification: selected || '',
            subjects: subjectsStructured,
            findings,
            errors,
            disclaimer: 'Suggestions only; review before saving.'
        };
        if (settings.debugMode && AiTextExtract && typeof AiTextExtract.extractLcCallNumbers === 'function') {
            response.lc_candidates = AiTextExtract.extractLcCallNumbers(rawText || '').slice(0, 10);
        }
        return response;
    }

    function normalizeReasoningEffort(value) {
        const effort = (value || '').toString().trim().toLowerCase();
        if (['none', 'low', 'medium', 'high'].includes(effort)) return effort;
        return 'low';
    }

    function isOpenAiReasoningModel(modelId) {
        const id = (modelId || '').toString().trim().toLowerCase();
        if (!id) return false;
        if (id.includes('reasoning')) return true;
        if (/^o\\d/.test(id)) return true;
        if (/(^|-)o\\d/.test(id)) return true;
        return false;
    }

    function detectTruncation(data) {
        if (!data || typeof data !== 'object') return false;
        if (Array.isArray(data.choices)) {
            return data.choices.some(choice => {
                const reason = (choice && choice.finish_reason) || '';
                return typeof reason === 'string' && reason.toLowerCase() === 'length';
            });
        }
        if (Array.isArray(data.output)) {
            return data.output.some(item => {
                const finish = (item && item.finish_reason) || '';
                const status = (item && item.status) || '';
                const detail = item && item.incomplete_details ? item.incomplete_details.reason || '' : '';
                return (typeof finish === 'string' && finish.toLowerCase() === 'length')
                    || (typeof status === 'string' && status.toLowerCase() === 'incomplete')
                    || (typeof detail === 'string' && detail.toLowerCase().includes('max_output_tokens'));
            });
        }
        if (data.incomplete_details && data.incomplete_details.reason) {
            const reason = String(data.incomplete_details.reason || '').toLowerCase();
            if (reason.includes('max_output_tokens') || reason.includes('length')) return true;
        }
        return false;
    }
