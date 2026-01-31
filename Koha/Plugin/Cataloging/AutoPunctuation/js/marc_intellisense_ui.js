(function(global, $) {
    'use strict';

    function initUI(settings) {
        const state = {
            rules: [],
            findings: new Map(),
            aiFindings: [],
            missingRequired: [],
            guardrailAlerts: [],
            requiredFields: parseList(settings.requiredFields),
            excludedTags: parseList(settings.excludedTags),
            localAllowlist: parseList(settings.localFieldsAllowlist),
            redactionRules: parseList(settings.aiRedactionRules),
            strictCoverage: settings.strictCoverageMode,
            autoApply: settings.autoApplyPunctuation,
            aiConfigured: settings.aiConfigured,
            aiConfidenceThreshold: settings.aiConfidenceThreshold || 0.85,
            undoStack: [],
            guideActive: false,
            ignoredFindings: new Set(),
            revalidateAfterApply: new Set(),
            ruleDependencies: new Map(),
            statementCaseTimers: new Map(),
            guideCurrentStep: null,
            guideRefresh: null,
            lastFocusedField: null,
            aiSuggestions: { classification: '', subjects: [], confidence: null, rawText: '', errors: [] },
            aiPunctuation: { findings: [], patches: [], summary: '', meta: null },
            lastChangeMeta: null,
            lastChangeAt: 0,
            validationLocks: new Set(),
            aiRequestCounter: 0,
            aiRequests: {
                punctuation: { id: 0, inFlight: false, status: '', statusType: 'info' },
                cataloging: { id: 0, inFlight: false, status: '', statusType: 'info' }
            }
        };
        global.AACR2IntellisenseState = state;

        const userContext = getUserContext(settings);
        state.userContext = userContext;
        if (userContext.internExcluded) {
            settings.autoApplyPunctuation = false;
            state.autoApply = false;
            state.readOnly = true;
        }

        const rules = global.AACR2RulesEngine.loadRules(global.AACR2RulePack || {}, settings.customRules || '{}');
        state.rules = rules;
        state.ruleDependencies = buildRuleDependencies(rules);
        if (global.AACR2RulesEngine) {
            global.AACR2RulesEngine.onWarning = message => toast('warning', message);
        }

        injectStyles();
        addToolbar(settings, state, userContext);
        addSidePanel(settings, state);
        makePanelDraggable();
        bindFieldHandlers(settings, state);
        bindFormHandlers(settings, state);
        updateGuardrails(settings, state);
        setTimeout(() => refreshAll(settings), 250);
        attachCopyCatalogObserver(settings, state);
    }

    function parseList(value) {
        if (!value) return [];
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }

    function getUserContext(settings) {
        let loggedInUser = settings && settings.currentUserId ? String(settings.currentUserId).trim() : '';
        if (!loggedInUser) {
            const selectors = [
                '#logged-in-info-full [class*="loggedinusernam"]',
                '#logged-in-info [class*="loggedinusernam"]',
                '#loggedinuser',
                '[class*="loggedinusernam"]'
            ];
            for (const selector of selectors) {
                const $candidate = $(selector).first();
                if ($candidate.length) {
                    loggedInUser = $candidate.text().trim();
                    if (loggedInUser) break;
                }
            }
        }
        const guideExclusions = parseList(`${settings.guideUsers || ''},${settings.guideExclusionList || ''}`);
        const internExclusions = parseList(`${settings.internshipUsers || ''},${settings.internshipExclusionList || ''}`);
        return {
            user: loggedInUser,
            guideExcluded: guideExclusions.includes(loggedInUser),
            internExcluded: settings.internshipMode && internExclusions.includes(loggedInUser)
        };
    }

    function debug(settings, message) {
        if (settings.debugMode) {
            console.log(`[AACR2 Assistant] ${message}`);
        }
    }

    function buildPluginUrl(settings, methodName) {
        const pluginPath = settings && settings.pluginPath ? settings.pluginPath : '';
        if (!methodName) {
            const message = 'Plugin method is required.';
            if (settings && settings.debugMode) {
                throw new Error(message);
            }
            console.error(`[AACR2 Assistant] ${message}`);
            return '';
        }
        return `${pluginPath}&method=${encodeURIComponent(methodName)}`;
    }

    function reportProgressUpdateError(settings, status, message, bodySnippet) {
        const statusLabel = status ? `HTTP ${status}` : 'HTTP error';
        const detail = message ? message.replace(/\s+/g, ' ').slice(0, 180) : '';
        const summary = detail ? `${statusLabel}: ${detail}` : statusLabel;
        toast('error', `Training progress update failed (${summary}).`);
        if (settings && settings.debugMode) {
            const snippet = bodySnippet ? bodySnippet.replace(/\s+/g, ' ').slice(0, 400) : '';
            console.error('[AACR2 Assistant] Guide progress update error:', summary, snippet);
        }
    }

    function sanitizeServerMessage(text) {
        return (text || '')
            .toString()
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    function getAiRequestState(state, context) {
        if (!state) return null;
        if (!state.aiRequests) state.aiRequests = {};
        if (!state.aiRequests[context]) {
            state.aiRequests[context] = { id: 0, inFlight: false, status: '', statusType: 'info', controller: null };
        }
        return state.aiRequests[context];
    }

    function createAbortController() {
        if (typeof AbortController === 'undefined') return null;
        return new AbortController();
    }

    function cancelAiRequest(state, context, reason, silent) {
        const req = getAiRequestState(state, context);
        if (!req || !req.inFlight) return false;
        if (req.controller && typeof req.controller.abort === 'function') {
            try {
                req.controller.abort();
            } catch (err) {
                // ignore abort errors
            }
        }
        req.inFlight = false;
        req.controller = null;
        if (!silent) {
            const message = reason || 'Cancelled.';
            setAiRequestStatus(state, context, message, 'warning');
        }
        updateAiCancelButtonState(state);
        return true;
    }

    function isLatestAiRequest(state, context, requestId) {
        const req = getAiRequestState(state, context);
        return !!(req && req.id === requestId);
    }

    function startAiRequest(state, context) {
        if (!state) return 0;
        const req = getAiRequestState(state, context);
        if (req && req.inFlight) {
            cancelAiRequest(state, context, null, true);
        }
        const nextId = (state.aiRequestCounter || 0) + 1;
        state.aiRequestCounter = nextId;
        if (req) {
            req.id = nextId;
            req.inFlight = true;
            req.controller = createAbortController();
        }
        updateAiCancelButtonState(state);
        return nextId;
    }

    function finishAiRequest(state, context, requestId) {
        const req = getAiRequestState(state, context);
        if (!req || req.id !== requestId) return false;
        req.inFlight = false;
        req.controller = null;
        updateAiCancelButtonState(state);
        return true;
    }

    function getAiRequestSignal(state, context, requestId) {
        const req = getAiRequestState(state, context);
        if (!req || req.id !== requestId) return null;
        return req.controller ? req.controller.signal : null;
    }

    function isAbortError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        return String(err.message || '').toLowerCase().includes('aborted');
    }

    function setAiRequestStatus(state, context, message, type) {
        const req = getAiRequestState(state, context);
        if (!req) return;
        req.status = message || '';
        req.statusType = type || 'info';
    }

    function updateAiCancelButtonState(state) {
        const $panel = $('#aacr2-ai-panel');
        if (!$panel.length) return;
        const punctuation = getAiRequestState(state, 'punctuation');
        const cataloging = getAiRequestState(state, 'cataloging');
        const inFlight = (punctuation && punctuation.inFlight) || (cataloging && cataloging.inFlight);
        const $cancel = $panel.find('#aacr2-ai-panel-cancel');
        if ($cancel.length) {
            $cancel.prop('disabled', !inFlight);
        }
    }

    function applyStoredAiStatus($panel, state) {
        if (!$panel || !$panel.length) return;
        const punctuation = getAiRequestState(state, 'punctuation');
        if (punctuation && punctuation.status) {
            updateAiPanelStatus($panel, punctuation.status, punctuation.statusType);
        }
        const cataloging = getAiRequestState(state, 'cataloging');
        if (cataloging && cataloging.status) {
            updateAiCatalogingStatus($panel, cataloging.status, cataloging.statusType);
        }
    }

    function notifyTruncation(result) {
        const errors = result && Array.isArray(result.errors) ? result.errors : [];
        const warning = errors.find(err => err && err.code === 'OUTPUT_TRUNCATED');
        if (warning) {
            toast('warning', warning.message || 'Output truncated. Increase max output tokens or reduce reasoning effort.');
        }
    }

    function injectStyles() {
        if ($('#aacr2-intellisense-styles').length) return;
        const styles = `
            .aacr2-indicator { display: inline-block; margin-left: 6px; font-size: 11px; padding: 2px 6px; border-radius: 10px; }
            .aacr2-indicator.info { background: #e5f2ff; color: #1b4f8a; }
            .aacr2-indicator.warning { background: #fff3cd; color: #8a6d3b; }
            .aacr2-indicator.error { background: #f8d7da; color: #a94442; }
            .aacr2-ghost-text { color: #9aa7b8; font-style: italic; margin-left: 6px; cursor: pointer; }
            .aacr2-toast { position: fixed; right: 20px; bottom: 20px; z-index: 10000; min-width: 220px; padding: 10px 12px; border-radius: 4px; margin-top: 8px; color: #fff; font-size: 12px; box-shadow: 0 6px 12px rgba(0,0,0,0.2); }
            .aacr2-toast.info { background: #2f6f9f; }
            .aacr2-toast.warning { background: #b78103; }
            .aacr2-toast.error { background: #b33a3a; }
            .aacr2-panel { position: fixed; right: 20px; top: 120px; width: 360px; max-height: 70vh; background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.15); border-radius: 6px; z-index: 9998; display: flex; flex-direction: column; resize: both; overflow: auto; min-width: 280px; min-height: 180px; }
            .aacr2-panel header { padding: 10px 12px; background: #0c223f; color: #fff; font-weight: 700; display: flex; justify-content: space-between; align-items: center; cursor: move; }
            .aacr2-panel .body { padding: 10px 12px; overflow-y: auto; font-size: 12px; }
            .aacr2-panel.minimized { min-height: 0; height: auto; resize: none; overflow: hidden; }
            .aacr2-panel.minimized .body { display: none; }
            .aacr2-panel .finding { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; margin-bottom: 8px; cursor: default; }
            .aacr2-panel .finding .meta { font-size: 11px; color: #5b6b7c; }
            .aacr2-panel .finding.error { border-left: 4px solid #d9534f; }
            .aacr2-panel .finding.warning { border-left: 4px solid #f0ad4e; }
            .aacr2-panel .finding.info { border-left: 4px solid #5bc0de; }
            .aacr2-panel .finding button { cursor: pointer; }
            .aacr2-panel .finding .actions { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
            .aacr2-help { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; border: 1px solid #94a3b8; color: #475569; font-size: 11px; margin-left: 6px; }
            .aacr2-toolbar { background: #f5f7fb; border: 1px solid #dde3ea; padding: 8px 10px; border-radius: 6px; margin: 10px 0; }
            .aacr2-toolbar .btn { margin-right: 6px; }
            .aacr2-preview { font-family: monospace; background: #f8fafc; padding: 4px 6px; border-radius: 4px; display: inline-block; margin-top: 6px; }
            .aacr2-raw-wrapper { margin-top: 6px; }
            .aacr2-raw-output { display: none; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px; font-size: 11px; max-height: 140px; overflow: auto; white-space: pre-wrap; }
            .aacr2-ai-panel { position: fixed; right: 24px; bottom: 24px; width: 380px; background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; z-index: 10002; display: flex; flex-direction: column; resize: both; overflow: auto; min-width: 300px; min-height: 200px; }
            .aacr2-ai-panel header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; cursor: move; padding: 8px 10px; background: #1f2937; color: #fff; font-weight: 700; }
            .aacr2-ai-panel .body { padding: 10px 12px; font-size: 12px; }
            .aacr2-ai-panel.minimized { min-height: 0; height: auto; resize: none; overflow: hidden; }
            .aacr2-ai-panel.minimized .body { display: none; }
            .aacr2-ai-panel .meta { color: #5b6b7c; font-size: 11px; margin-bottom: 4px; }
            .aacr2-ai-field-value { font-family: monospace; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
            .aacr2-ai-text-output { font-family: monospace; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 6px; white-space: pre-wrap; word-break: break-word; max-height: 140px; overflow: auto; }
            .aacr2-ai-error { color: #a94442; font-weight: 600; margin-top: 4px; }
            .aacr2-ai-debug { margin-top: 6px; }
            .aacr2-ai-debug summary { cursor: pointer; font-weight: 600; color: #1f2937; }
            .aacr2-ai-debug pre { margin: 6px 0 0 0; padding: 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
            .aacr2-ai-results { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; margin-top: 6px; }
            .aacr2-ai-result-item { border-bottom: 1px dashed #e2e8f0; padding: 6px 0; }
            .aacr2-ai-result-item:last-child { border-bottom: none; }
            .aacr2-ai-result-meta { color: #6b7280; font-size: 11px; margin-top: 2px; }
            .aacr2-ai-result-actions { margin-top: 6px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
            .aacr2-ai-result-checkbox { margin-right: 6px; }
            .aacr2-ai-panel .options label { display: block; margin-top: 4px; font-weight: 400; }
            .aacr2-ai-panel .actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
            .aacr2-ai-section { border-bottom: 1px dashed #e2e8f0; padding-bottom: 10px; margin-bottom: 10px; }
            .aacr2-ai-section:last-child { border-bottom: none; margin-bottom: 0; }
            .aacr2-ai-section-title { font-weight: 700; font-size: 12px; margin-bottom: 6px; color: #0c223f; text-transform: uppercase; letter-spacing: 0.3px; }
            .aacr2-ai-inline { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
            .aacr2-ai-inline input { flex: 1 1 auto; min-width: 160px; }
            .aacr2-ai-list { padding-left: 18px; margin: 4px 0 0 0; }
            .aacr2-ai-callnumber { margin-top: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; }
            .aacr2-guide-modal { position: fixed; top: 120px; right: 24px; left: auto; transform: none; background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; padding: 0; z-index: 10001; width: 420px; resize: both; overflow: auto; min-width: 320px; min-height: 220px; max-height: 80vh; display: flex; flex-direction: column; }
            .aacr2-guide-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 10000; }
            .aacr2-guide-highlight { border: 2px solid #3b82f6 !important; box-shadow: 0 0 10px rgba(59,130,246,0.4) !important; }
            .aacr2-focus-flash { border: 2px solid #10b981 !important; box-shadow: 0 0 8px rgba(16,185,129,0.4) !important; }
            .aacr2-about-modal { position: fixed; top: 22%; left: 50%; transform: translateX(-50%); background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; padding: 14px; z-index: 10001; width: 420px; }
            .aacr2-ai-preview-modal { position: fixed; top: 18%; left: 50%; transform: translateX(-50%); background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; padding: 14px; z-index: 10002; width: 520px; max-width: 90vw; max-height: 70vh; overflow: auto; }
            .aacr2-ai-preview-modal pre { background: #f8fafc; padding: 8px; border-radius: 4px; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
            .aacr2-guide-modal.minimized .aacr2-guide-content { display: none; }
            .aacr2-guide-modal.minimized { min-height: 0; height: auto; resize: none; overflow: hidden; }
            .aacr2-guide-modal header { display: flex; justify-content: space-between; align-items: center; cursor: move; padding: 8px 10px; background: #1f2937; color: #ffffff; font-weight: 700; }
            .aacr2-guide-content { padding: 10px 12px; font-size: 12px; }
            .aacr2-guide-steps { max-height: 160px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px; margin-top: 8px; }
            .aacr2-guide-steps button { width: 100%; text-align: left; margin-bottom: 4px; }
            .aacr2-guide-progress { margin-top: 8px; font-size: 12px; color: #5b6b7c; }
            .aacr2-guide-module { margin-top: 8px; display: flex; align-items: center; gap: 6px; font-size: 12px; }
            .aacr2-guide-module select { max-width: 260px; }
            .aacr2-guide-status.success { color: #1f7a4d; font-weight: 600; }
            .aacr2-guide-status.error { color: #b33a3a; font-weight: 600; }
            .aacr2-guide-status.info { color: #1b4f8a; font-weight: 600; }
            .aacr2-progress-bar { height: 6px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
            .aacr2-progress-bar span { display: block; height: 100%; background: #2563eb; }
            .aacr2-about-modal .aacr2-ack-list { margin: 6px 0 12px 18px; }
            .aacr2-about-modal .aacr2-ack-list li { margin-bottom: 4px; }
        `;
        $('head').append(`<style id="aacr2-intellisense-styles">${styles}</style>`);
    }

    const toastState = { lastKey: '', lastAt: 0 };
    function toast(type, message) {
        const now = Date.now();
        const key = `${type}:${message}`;
        if (toastState.lastKey === key && (now - toastState.lastAt) < 2000) {
            return;
        }
        toastState.lastKey = key;
        toastState.lastAt = now;
        const $toast = $(`<div class="aacr2-toast ${type}">${message}</div>`).appendTo('body');
        setTimeout(() => $toast.fadeOut(() => $toast.remove()), 4000);
    }

    function truncateToastText(text, maxLen) {
        const value = (text || '').toString();
        if (!maxLen || value.length <= maxLen) return value;
        return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
    }

    function buildConditionalSuffixToast(finding) {
        if (!finding || !finding.condition || finding.condition.type !== 'conditional_suffix') return '';
        const condition = finding.condition;
        const following = Array.isArray(condition.following_subfields) ? condition.following_subfields : [];
        if (!following.length) return '';
        const tag = finding.tag || '';
        const fieldLabel = `${tag}$${finding.subfield}`;
        const list = following.map(code => `${tag}$${code}`).join(', ');
        if (condition.action === 'trim' && condition.has_following) {
            return `Trailing punctuation removed from ${fieldLabel} because ${list} is present.`;
        }
        if (condition.action === 'add' && !condition.has_following) {
            return `Terminal punctuation added to ${fieldLabel} because ${list} is missing.`;
        }
        return '';
    }

    function buildConditionalSuffixSuggestionToast(finding) {
        if (!finding || !finding.condition || finding.condition.type !== 'conditional_suffix') return '';
        const condition = finding.condition;
        const following = Array.isArray(condition.following_subfields) ? condition.following_subfields : [];
        if (!following.length) return '';
        const tag = finding.tag || '';
        const fieldLabel = `${tag}$${finding.subfield}`;
        const list = following.map(code => `${tag}$${code}`).join(', ');
        if (condition.has_following) {
            return `Update ${fieldLabel}: remove trailing punctuation because ${list} is present.`;
        }
        return `Update ${fieldLabel}: add terminal punctuation because ${list} is missing.`;
    }

    function buildConditionalSuffixNote(finding) {
        if (!finding || !finding.condition || finding.condition.type !== 'conditional_suffix') return '';
        const condition = finding.condition;
        const following = Array.isArray(condition.following_subfields) ? condition.following_subfields : [];
        if (!following.length) return '';
        const tag = finding.tag || '';
        const list = following.map(code => `${tag}$${code}`).join(', ');
        if (condition.action === 'trim' && condition.has_following) {
            return `Trailing punctuation removed because ${list} is present.`;
        }
        if (condition.action === 'add' && !condition.has_following) {
            return `Terminal punctuation added because ${list} is missing.`;
        }
        const state = condition.has_following ? 'present' : 'missing';
        return `Punctuation depends on ${list} being ${state}.`;
    }

    function notifyDependentFindings(meta, findings, state) {
        if (!meta || !findings || !findings.length) return;
        const messages = new Set();
        const focusCode = (meta.code || '').toLowerCase();
        findings.forEach(finding => {
            if (!finding || !finding.condition || finding.condition.type !== 'conditional_suffix') return;
            if (focusCode && (finding.subfield || '').toLowerCase() === focusCode) return;
            const message = buildConditionalSuffixSuggestionToast(finding);
            if (message) messages.add(message);
        });
        messages.forEach(message => toast('info', message));
    }

    function notifyDependentFindingsAfterRefresh(state) {
        if (!state || !state.lastChangeMeta) return;
        if (!state.lastChangeAt || (Date.now() - state.lastChangeAt) > 2000) return;
        const meta = state.lastChangeMeta;
        if (!meta.tag) return;
        const combined = collectFindingsForField(state, meta.tag, meta.occurrence || '');
        notifyDependentFindings(meta, combined, state);
    }

    function addToolbar(settings, state, userContext) {
        if (!$('#cat_addbiblio, form[name="f"]').length) return;
        $('.aacr2-toolbar').remove();
        const guideButton = settings.enableGuide && !userContext.guideExcluded
            ? '<button type="button" class="btn btn-sm btn-default" id="aacr2-guide">Guide</button>'
            : '';
        const aboutButton = '<button type="button" class="btn btn-sm btn-default" id="aacr2-about">About</button>';
        const toolbar = `
            <div class="aacr2-toolbar">
                <button type="button" class="btn btn-sm ${settings.enabled ? 'btn-success' : 'btn-default'}" id="aacr2-toggle">
                    ${settings.enabled ? 'AACR2 Assistant ON' : 'AACR2 Assistant OFF'}
                </button>
                <button type="button" class="btn btn-sm ${settings.autoApplyPunctuation ? 'btn-primary' : 'btn-default'}" id="aacr2-autoapply">
                    ${settings.autoApplyPunctuation ? 'Auto-apply punctuation' : 'Suggest only'}
                </button>
                <button type="button" class="btn btn-sm btn-info" id="aacr2-panel-toggle">Cataloging Assistant</button>
                <button type="button" class="btn btn-sm btn-default" id="aacr2-ai-toggle" ${settings.aiConfigured ? '' : 'disabled'}>
                    AI Assist
                </button>
                ${guideButton}
                ${aboutButton}
                <span id="aacr2-guardrail-status" style="margin-left: 6px; font-size: 12px; color: #5b6b7c;">Guardrails: pending</span>
            </div>
        `;
        const $target = $('#cat_addbiblio').length ? $('#cat_addbiblio') : $('form[name="f"]').first();
        $target.before(toolbar);

        $('#aacr2-toggle').on('click', () => {
            if (userContext.internExcluded) {
                toast('warning', 'AACR2 assistant toggle disabled for training.');
                return;
            }
            settings.enabled = !settings.enabled;
            $('#aacr2-toggle').toggleClass('btn-success btn-default')
                .text(settings.enabled ? 'AACR2 Assistant ON' : 'AACR2 Assistant OFF');
            toast('info', settings.enabled ? 'AACR2 assistant enabled.' : 'AACR2 assistant disabled.');
        });

        $('#aacr2-autoapply').on('click', () => {
            if (userContext.internExcluded) {
                toast('warning', 'Auto-apply disabled for training.');
                return;
            }
            settings.autoApplyPunctuation = !settings.autoApplyPunctuation;
            $('#aacr2-autoapply').toggleClass('btn-primary btn-default')
                .text(settings.autoApplyPunctuation ? 'Auto-apply punctuation' : 'Suggest only');
            state.autoApply = settings.autoApplyPunctuation;
            toast('info', settings.autoApplyPunctuation ? 'Auto-apply punctuation enabled.' : 'Auto-apply punctuation disabled.');
        });

        $('#aacr2-panel-toggle').on('click', () => {
            $('.aacr2-panel').toggle();
            updatePanelToggleButton();
        });

        $('#aacr2-ai-toggle').on('click', () => {
            if (!settings.aiConfigured || userContext.internExcluded) return;
            showAiAssistPanel(settings, state);
        });

        if (userContext.internExcluded) {
            $('#aacr2-autoapply')
                .prop('disabled', true)
                .attr('title', 'Disabled in internship mode.');
        }

        if (settings.enableGuide && !userContext.guideExcluded) {
            $(document).off('click.aacr2guide', '#aacr2-guide');
            $(document).on('click.aacr2guide', '#aacr2-guide', () => {
                showGuide(settings);
            });
        }
        $('#aacr2-about').on('click', () => {
            showAboutModal(settings);
        });
        updateAiToggleButton();
    }

    function addSidePanel(settings, state) {
        if ($('.aacr2-panel').length) return;
        const isReadOnly = state && state.readOnly;
        const readOnlyAttr = isReadOnly ? 'disabled title="Disabled in internship mode."' : '';
        const panel = `
            <div class="aacr2-panel" style="display:block;">
                <header>
                    <span>Cataloging Assistant</span>
                    <div>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-applyall" ${readOnlyAttr}>Apply all</button>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-undo" ${readOnlyAttr}>Undo</button>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-undoall" ${readOnlyAttr}>Undo all</button>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-ignoreall">Ignore all</button>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-minimize">Minimize</button>
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-close">Close</button>
                    </div>
                </header>
                <div class="body">
                    <div class="meta">AACR2 rules and punctuation findings appear here. Click Apply to accept suggestions.</div>
                    <div id="aacr2-findings"></div>
                </div>
            </div>
        `;
        $('body').append(panel);
        $('#aacr2-panel-close').on('click', () => {
            $('.aacr2-panel').hide();
            updatePanelToggleButton();
        });
        $('#aacr2-panel-minimize').on('click', () => {
            const $panel = $('.aacr2-panel');
            setFloatingMinimized($panel, !$panel.hasClass('minimized'), '#aacr2-panel-minimize');
        });
        $('#aacr2-panel-applyall').on('click', () => applyAllFindings(settings));
        $('#aacr2-panel-undo').on('click', () => undoLastChange());
        $('#aacr2-panel-undoall').on('click', () => undoAllChanges());
        $('#aacr2-panel-ignoreall').on('click', () => {
            ignoreAllFindings(state);
            updateSidePanel(state);
            toast('info', 'All suggestions ignored for this session.');
        });
        updatePanelToggleButton();
    }

    function makePanelDraggable() {
        const $panel = $('.aacr2-panel');
        if (!$panel.length || $panel.data('draggable')) return;
        $panel.data('draggable', true);
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        $panel.find('header').on('mousedown', function(event) {
            if ($(event.target).closest('button').length) return;
            dragging = true;
            const rect = $panel[0].getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            $panel.css({ right: 'auto' });
            $panel.addClass('dragging');
            event.preventDefault();
        });
        $(document).on('mousemove.aacr2panel', function(event) {
            if (!dragging) return;
            const left = Math.max(0, event.clientX - offsetX);
            const top = Math.max(0, event.clientY - offsetY);
            $panel.css({ left: `${left}px`, top: `${top}px` });
        });
        $(document).on('mouseup.aacr2panel', function() {
            dragging = false;
            $panel.removeClass('dragging');
        });
    }

    function updatePanelToggleButton() {
        const $toggle = $('#aacr2-panel-toggle');
        if (!$toggle.length) return;
        const isVisible = $('.aacr2-panel:visible').length > 0;
        $toggle.toggleClass('btn-info', isVisible).toggleClass('btn-default', !isVisible);
    }

    function updateAiToggleButton() {
        const $toggle = $('#aacr2-ai-toggle');
        if (!$toggle.length) return;
        const isVisible = $('#aacr2-ai-panel:visible').length > 0;
        $toggle.toggleClass('btn-warning', isVisible).toggleClass('btn-default', !isVisible);
    }

    function setFloatingMinimized($panel, minimized, buttonSelector) {
        if (!$panel || !$panel.length) return;
        const sizeKey = 'aacr2PrevSize';
        if (minimized) {
            if (!$panel.data(sizeKey)) {
                $panel.data(sizeKey, {
                    height: $panel[0].style.height || '',
                    width: $panel[0].style.width || ''
                });
            }
            const headerHeight = $panel.find('header').outerHeight() || 0;
            $panel.css('height', headerHeight ? `${headerHeight}px` : 'auto');
        } else {
            const prev = $panel.data(sizeKey) || {};
            if (prev.height !== undefined) {
                $panel.css('height', prev.height);
            }
            if (prev.width !== undefined) {
                $panel.css('width', prev.width);
            }
            $panel.removeData(sizeKey);
        }
        $panel.toggleClass('minimized', minimized);
        if (buttonSelector) {
            const $button = $panel.find(buttonSelector);
            if ($button.length) {
                $button.text(minimized ? 'Maximize' : 'Minimize');
            }
        }
    }

    function makeGuideDraggable() {
        const $modal = $('.aacr2-guide-modal');
        if (!$modal.length || $modal.data('draggable')) return;
        $modal.data('draggable', true);
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        $modal.find('header').on('mousedown', function(event) {
            if ($(event.target).closest('button').length) return;
            dragging = true;
            const rect = $modal[0].getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            $modal.css({ right: 'auto', left: `${rect.left}px`, top: `${rect.top}px` });
            $modal.addClass('dragging');
            event.preventDefault();
        });
        $(document).on('mousemove.aacr2guideDrag', function(event) {
            if (!dragging) return;
            const left = Math.max(0, event.clientX - offsetX);
            const top = Math.max(0, event.clientY - offsetY);
            $modal.css({ left: `${left}px`, top: `${top}px` });
        });
        $(document).on('mouseup.aacr2guideDrag', function() {
            dragging = false;
            $modal.removeClass('dragging');
        });
    }

    function makeAiPanelDraggable() {
        const $panel = $('.aacr2-ai-panel');
        if (!$panel.length || $panel.data('draggable')) return;
        $panel.data('draggable', true);
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;
        $panel.find('header').on('mousedown', function(event) {
            if ($(event.target).closest('button').length) return;
            dragging = true;
            const rect = $panel[0].getBoundingClientRect();
            offsetX = event.clientX - rect.left;
            offsetY = event.clientY - rect.top;
            $panel.css({ right: 'auto', left: `${rect.left}px`, top: `${rect.top}px` });
            $panel.addClass('dragging');
            event.preventDefault();
        });
        $(document).on('mousemove.aacr2aipanel', function(event) {
            if (!dragging) return;
            const left = Math.max(0, event.clientX - offsetX);
            const top = Math.max(0, event.clientY - offsetY);
            $panel.css({ left: `${left}px`, top: `${top}px` });
        });
        $(document).on('mouseup.aacr2aipanel', function() {
            dragging = false;
            $panel.removeClass('dragging');
        });
    }

    function setGuideMinimized($modal, minimized) {
        if (!$modal || !$modal.length) return;
        $modal.toggleClass('minimized', minimized);
        const $button = $modal.find('#aacr2-guide-minimize');
        if ($button.length) {
            $button.text(minimized ? 'Maximize' : 'Minimize');
        }
    }

    function bindFieldHandlers(settings, state) {
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], select[id*="subfield"], select[id*="tag_"], input[name^="field_"], textarea[name^="field_"], select[name^="field_"]';
        $(document).on('focusin.aacr2', selector, function() {
            if (parseFieldMeta(this)) {
                state.lastFocusedField = this;
            }
            const $aiPanel = $('#aacr2-ai-panel');
            if ($aiPanel.length && $aiPanel.is(':visible')) {
                updateAiPanelSelection($aiPanel, settings, state);
                updateAiCatalogingContext($aiPanel, settings, state);
            }
        });
        $(document).on('blur.aacr2', selector, function() {
            const meta = parseFieldMeta(this);
            const indicatorMeta = !meta ? parseIndicatorMeta(this) : null;
            if (meta) {
                runFieldValidation(this, settings, state, { apply: true });
            } else if (indicatorMeta) {
                runIndicatorValidation(indicatorMeta, settings, state, { apply: true });
            }
        });
        $(document).on('change.aacr2', selector, function() {
            if (document.activeElement === this) return;
            const meta = parseFieldMeta(this);
            const indicatorMeta = !meta ? parseIndicatorMeta(this) : null;
            if (meta) {
                runFieldValidation(this, settings, state, { apply: true });
            } else if (indicatorMeta) {
                runIndicatorValidation(indicatorMeta, settings, state, { apply: true });
            }
        });

        $(document).on('input.aacr2', selector, function() {
            $(this).siblings('.aacr2-ghost-text').remove();
            const meta = parseFieldMeta(this);
            const indicatorMeta = !meta ? parseIndicatorMeta(this) : null;
            if (settings.enableLiveValidation) {
                if (meta) {
                    runFieldValidation(this, settings, state, { apply: false });
                    consumeRevalidation(state, meta);
                } else if (indicatorMeta) {
                    runIndicatorValidation(indicatorMeta, settings, state, { apply: false });
                }
            } else if (consumeRevalidation(state, meta)) {
                runFieldValidation(this, settings, state, { apply: false });
            }
            const $aiPanel = $('#aacr2-ai-panel');
            if ($aiPanel.length && $aiPanel.is(':visible')) {
                updateAiCatalogingContext($aiPanel, settings, state);
            }
        });

        $(document).on('keydown.aacr2', selector, function(event) {
            if (event.key !== 'Tab' && event.key !== 'Enter') return;
            const $ghost = $(this).siblings('.aacr2-ghost-text');
            if (!$ghost.length) return;
            const expected = $ghost.data('expected');
            if (!expected) return;
            event.preventDefault();
            $(this).val(expected);
            $ghost.remove();
            markFieldForRevalidation(state, parseFieldMeta(this));
            toast('info', 'AACR2 ghost suggestion applied.');
        });
    }

    function runFieldValidation(element, settings, state, options) {
        if (!settings.enabled && !(settings.enforceAacr2Guardrails || settings.enableLiveValidation)) return;
        const opts = options || {};
        const meta = parseFieldMeta(element);
        if (!meta) return;
        const lockKey = buildFieldKey(meta);
        if (state && state.validationLocks && state.validationLocks.has(lockKey)) return;
        if (state && state.validationLocks) {
            state.validationLocks.add(lockKey);
        }
        const visited = opts.visited || new Set();
        visited.add(lockKey);
        try {
            if (state && opts.recordChange !== false) {
                state.lastChangeMeta = { ...meta };
                state.lastChangeAt = Date.now();
            }
            if (isTagExcluded(settings, state, meta.tag)) return;
            const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
            if (!fieldContext) return;
            const result = global.AACR2RulesEngine.validateField(fieldContext, settings, state.rules);
            const filteredFindings = result.findings.filter(finding => !isExcluded(settings, state, finding.tag, finding.subfield));
            updateFindingsForField(state, meta, filteredFindings);
            if (opts.apply) {
                applyAutoFixes(settings, state, meta, filteredFindings);
            }
            const statementCaseContext = opts.apply ? buildFieldContext(meta.tag, meta.occurrence) : fieldContext;
            queueStatementCaseValidation(statementCaseContext || fieldContext, settings, state);
            updateIndicators(fieldContext, filteredFindings);
            updateSidePanel(state);
            updateGuardrails(settings, state);
            if (opts.apply) {
                notifyDependentFindings(meta, filteredFindings, state);
            }
            maybeShowGhost(element, filteredFindings, settings, state);
            refreshGuideForChange(state, meta);
            if (!opts.skipDependents) {
                revalidateDependentSubfields(settings, state, meta, {
                    apply: opts.apply,
                    visited,
                    recordChange: false
                });
            }
        } finally {
            if (state && state.validationLocks) {
                state.validationLocks.delete(lockKey);
            }
        }
    }

    function runIndicatorValidation(indicatorMeta, settings, state, options) {
        if (!settings.enabled && !(settings.enforceAacr2Guardrails || settings.enableLiveValidation)) return;
        if (!indicatorMeta) return;
        if (isTagExcluded(settings, state, indicatorMeta.tag)) return;
        const fieldContext = buildFieldContext(indicatorMeta.tag, indicatorMeta.occurrence);
        if (!fieldContext) return;
        const result = global.AACR2RulesEngine.validateField(fieldContext, settings, state.rules);
        const filteredFindings = result.findings.filter(finding => !isExcluded(settings, state, finding.tag, finding.subfield));
        updateFindingsForField(state, { tag: indicatorMeta.tag, code: '*', occurrence: indicatorMeta.occurrence || '' }, filteredFindings);
        if (options && options.apply) {
            applyAutoFixes(settings, state, { tag: indicatorMeta.tag, code: '*', occurrence: indicatorMeta.occurrence || '' }, filteredFindings);
        }
        const statementCaseContext = (options && options.apply)
            ? buildFieldContext(indicatorMeta.tag, indicatorMeta.occurrence)
            : fieldContext;
        queueStatementCaseValidation(statementCaseContext || fieldContext, settings, state);
        updateIndicators(fieldContext, filteredFindings);
        updateSidePanel(state);
        updateGuardrails(settings, state);
        refreshGuideForChange(state, { tag: indicatorMeta.tag, code: '', occurrence: indicatorMeta.occurrence || '' });
    }

    function bindFormHandlers(settings, state) {
        $('form[name="f"], #cat_addbiblio form').on('submit.aacr2', function(event) {
            const record = filterRecordContext(buildRecordContext(), settings, state);
            const result = global.AACR2RulesEngine.validateRecord(record, settings, state.rules, settings.strictCoverageMode);
            state.findings = groupFindings(result.findings);
            if (settings.enabled && state.autoApply && result.findings.length) {
                result.findings.forEach(finding => {
                    const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
                    if (patch) applyPatch(patch, finding.occurrence, finding);
                });
                refreshAll(settings);
            }
            updateSidePanel(state);
            updateGuardrails(settings, state);
            const errorCount = countSeverity(state.findings, 'ERROR');
            if (settings.blockSaveOnError && settings.enforceAacr2Guardrails && errorCount > 0) {
                event.preventDefault();
                toast('error', `Save blocked: ${errorCount} AACR2 error(s) detected.`);
            }
        });
    }

    function attachCopyCatalogObserver(settings, state) {
        if (state.copyObserver || !global.MutationObserver) return;
        const form = document.querySelector('form[name="f"], #cat_addbiblio form');
        if (!form) return;
        let refreshTimer = null;
        const observer = new MutationObserver(() => {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => refreshAll(settings), 300);
        });
        observer.observe(form, { childList: true, subtree: true });
        state.copyObserver = observer;
    }

    function parseFieldMeta(element) {
        const id = element.id || '';
        const name = element.name || '';
        let match = id.match(/tag_(\d{3})_subfield_([a-z0-9])(?:_(\d+(?:_\d+)*))?/i);
        if (!match) match = id.match(/subfield(\d{3})([a-z0-9])/i);
        if (!match && name) match = name.match(/tag_(\d{3})_subfield_([a-z0-9])(?:_(\d+(?:_\d+)*))?/i);
        if (!match && name) match = name.match(/field_(\d{3})([a-z0-9])(?:_(\d+(?:_\d+)*))?/i);
        if (!match) return null;
        return { tag: match[1], code: match[2], occurrence: match[3] || '' };
    }

    function buildFieldKey(meta) {
        if (!meta) return '';
        return `${meta.tag}$${meta.code}:${normalizeOccurrenceKey(meta.occurrence)}`;
    }

    function normalizeOccurrence(value) {
        if (value === undefined || value === null || value === '') return 0;
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    function normalizeOccurrenceKey(value) {
        return String(normalizeOccurrence(value));
    }

    function markFieldForRevalidation(state, meta) {
        if (!state || !state.revalidateAfterApply || !meta) return;
        state.revalidateAfterApply.add(buildFieldKey(meta));
    }

    function consumeRevalidation(state, meta) {
        if (!state || !state.revalidateAfterApply || !meta) return false;
        const key = buildFieldKey(meta);
        if (!state.revalidateAfterApply.has(key)) return false;
        state.revalidateAfterApply.delete(key);
        return true;
    }

    function isValidTag(tag) {
        return /^\d{3}$/.test(tag || '');
    }

    function isValidSubfieldCode(code) {
        return /^[a-z0-9]$/i.test(code || '');
    }

    function isGuideSubfieldCode(code) {
        return /^[a-z]$/i.test(code || '');
    }

    function parseIndicatorMeta(element) {
        const id = element.id || '';
        const name = element.name || '';
        let match = id.match(/tag_(\d{3})_indicator([12])(?:_(\d+(?:_\d+)*))?/i);
        if (!match && name) match = name.match(/tag_(\d{3})_indicator([12])(?:_(\d+(?:_\d+)*))?/i);
        if (!match) return null;
        return { tag: match[1], indicator: match[2], occurrence: match[3] || '' };
    }

    function buildRuleDependencies(rules) {
        const dependencyMap = new Map();
        const addDependency = (tag, fromCode, toCode) => {
            if (!tag || !fromCode || !toCode) return;
            if (!dependencyMap.has(tag)) dependencyMap.set(tag, new Map());
            const byTag = dependencyMap.get(tag);
            if (!byTag.has(fromCode)) byTag.set(fromCode, new Set());
            byTag.get(fromCode).add(toCode);
        };
        (rules || []).forEach(rule => {
            if (!rule || !rule.tag) return;
            const tag = rule.tag;
            const targetCodes = Array.isArray(rule.subfields)
                ? rule.subfields.map(code => (code || '').toLowerCase())
                : [];
            const hasPattern = !targetCodes.length && rule.subfield_pattern;
            const dependencies = new Set();
            if (Array.isArray(rule.requires_subfields)) rule.requires_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
            if (Array.isArray(rule.forbids_subfields)) rule.forbids_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
            if (rule.next_subfield_is) {
                [].concat(rule.next_subfield_is).forEach(code => dependencies.add((code || '').toLowerCase()));
            }
            if (rule.previous_subfield_is) {
                [].concat(rule.previous_subfield_is).forEach(code => dependencies.add((code || '').toLowerCase()));
            }
            (rule.checks || []).forEach(check => {
                if (Array.isArray(check.when_following_subfields)) {
                    check.when_following_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
                }
                if (Array.isArray(check.when_preceding_subfields)) {
                    check.when_preceding_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
                }
            });
            if (!targetCodes.length && hasPattern) {
                addDependency(tag, '*', '*');
                dependencies.forEach(code => addDependency(tag, code, '*'));
                return;
            }
            if (!targetCodes.length) return;
            targetCodes.forEach(target => {
                addDependency(tag, target, target);
                dependencies.forEach(code => addDependency(tag, code, target));
            });
        });
        return dependencyMap;
    }

    function getDependentSubfields(state, tag, code) {
        if (!state || !state.ruleDependencies || !tag) return null;
        const byTag = state.ruleDependencies.get(tag);
        if (!byTag) return null;
        const deps = new Set();
        const direct = byTag.get(code);
        if (direct) direct.forEach(item => deps.add(item));
        const wildcard = byTag.get('*');
        if (wildcard) wildcard.forEach(item => deps.add(item));
        return deps.size ? deps : null;
    }

    function revalidateDependentSubfields(settings, state, meta, options) {
        if (!meta || !meta.tag || !meta.code) return;
        const deps = getDependentSubfields(state, meta.tag, (meta.code || '').toLowerCase());
        if (!deps || !deps.size) return;
        const opts = options || {};
        const visited = opts.visited || new Set();
        const occurrence = meta.occurrence || '';
        deps.forEach(code => {
            if (!code || code === '*' || code === (meta.code || '').toLowerCase()) return;
            const $field = findFieldElement(meta.tag, code, occurrence);
            if (!$field.length) return;
            const fieldMeta = parseFieldMeta($field[0]);
            if (!fieldMeta) return;
            const fieldKey = buildFieldKey(fieldMeta);
            if (visited.has(fieldKey)) return;
            visited.add(fieldKey);
            runFieldValidation($field[0], settings, state, {
                apply: opts.apply,
                skipDependents: false,
                visited,
                recordChange: opts.recordChange
            });
        });
    }

    function refreshGuideForChange(state, meta) {
        if (!state || !state.guideActive || !state.guideRefresh || !state.guideCurrentStep) return;
        const step = state.guideCurrentStep;
        if (!step || !step.tag) return;
        const tag = meta && meta.tag ? meta.tag : '';
        if (tag && tag !== step.tag && !(step.alternateTags || []).includes(tag)) return;
        const changedCode = meta && meta.code ? meta.code.toLowerCase() : '';
        const stepCode = (step.code || '').toLowerCase();
        if (!stepCode || !changedCode) {
            state.guideRefresh();
            return;
        }
        if (stepCode === changedCode) {
            state.guideRefresh();
            return;
        }
        const affected = getDependentSubfields(state, step.tag, changedCode);
        if (!affected) {
            state.guideRefresh();
            return;
        }
        if (affected.has(stepCode) || affected.has('*')) {
            state.guideRefresh();
        }
    }

    function findIndicatorValue(tag, indicator, occurrence) {
        const selector = [
            `input[id^="tag_${tag}_indicator${indicator}"]`,
            `select[id^="tag_${tag}_indicator${indicator}"]`,
            `input[name^="tag_${tag}_indicator${indicator}"]`,
            `select[name^="tag_${tag}_indicator${indicator}"]`
        ].join(',');
        let value = '';
        $(selector).each(function() {
            const meta = parseIndicatorMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            value = $(this).val() || '';
            return false;
        });
        return value;
    }

    function buildFieldContext(tag, occurrence) {
        const field = { tag, ind1: '', ind2: '', occurrence: normalizeOccurrenceKey(occurrence), subfields: [] };
        field.ind1 = findIndicatorValue(tag, 1, occurrence) || '';
        field.ind2 = findIndicatorValue(tag, 2, occurrence) || '';
        const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            field.subfields.push({ code: meta.code, value: $(this).val() || '' });
        });
        if (!field.subfields.length) return null;
        return field;
    }

    function prioritizeSubfield(fieldContext, primaryCode) {
        if (!fieldContext || !Array.isArray(fieldContext.subfields)) return fieldContext;
        const code = (primaryCode || '').toLowerCase();
        if (!code) return fieldContext;
        const subs = fieldContext.subfields.slice();
        const idx = subs.findIndex(sub => (sub.code || '').toLowerCase() === code);
        if (idx > 0) {
            const primary = subs.splice(idx, 1)[0];
            subs.unshift(primary);
        }
        return { ...fieldContext, subfields: subs };
    }

    function buildRecordContext() {
        const fields = {};
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], select[id*="subfield"], select[id*="tag_"], input[name^="field_"], textarea[name^="field_"], select[name^="field_"]';
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            const key = `${meta.tag}:${normalizeOccurrenceKey(meta.occurrence)}`;
            if (!fields[key]) {
                fields[key] = { tag: meta.tag, ind1: '', ind2: '', occurrence: normalizeOccurrenceKey(meta.occurrence), subfields: [] };
            }
            fields[key].subfields.push({ code: meta.code, value: $(this).val() || '' });
        });
        Object.values(fields).forEach(field => {
            field.ind1 = findIndicatorValue(field.tag, 1, field.occurrence) || '';
            field.ind2 = findIndicatorValue(field.tag, 2, field.occurrence) || '';
        });
        return { fields: Object.values(fields) };
    }

    function filterRecordContext(record, settings, state) {
        const filtered = record.fields.map(field => {
            const subfields = field.subfields.filter(sub => !isExcluded(settings, state, field.tag, sub.code));
            return { ...field, subfields };
        }).filter(field => field.subfields.length);
        return { fields: filtered };
    }

    function buildAiRecordContext(meta, settings, state) {
        const mode = settings.aiContextMode || 'tag_only';
        if (mode === 'tag_only') return null;
        const record = filterRecordContext(buildRecordContext(), settings, state);
        const normalized = {
            fields: (record.fields || []).map(field => {
                return { ...field, occurrence: normalizeOccurrence(field.occurrence) };
            })
        };
        if (mode === 'full') return normalized;
        if (mode === 'tag_plus_neighbors') {
            const fields = normalized.fields || [];
            const normalizedTarget = normalizeOccurrence(meta.occurrence);
            const idx = fields.findIndex(f => f.tag === meta.tag && (f.occurrence || 0) === normalizedTarget);
            if (idx === -1) return { fields: [] };
            const subset = [];
            if (idx > 0) subset.push(fields[idx - 1]);
            subset.push(fields[idx]);
            if (idx < fields.length - 1) subset.push(fields[idx + 1]);
            return { fields: subset };
        }
        return normalized;
    }

    function shouldRedactValue(settings, state, tag, code, value) {
        if (settings.aiRedact856Querystrings && tag === '856' && (code || '').toLowerCase() === 'u') {
            if (value && /[?&]/.test(value)) return true;
        }
        const rules = (state && state.redactionRules) ? state.redactionRules : [];
        return rules.some(entry => {
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            return false;
        });
    }

    function redactTagContext(tagContext, settings, state) {
        if (!tagContext || typeof tagContext !== 'object') return {};
        const clone = { ...tagContext };
        if (Array.isArray(clone.subfields)) {
            clone.subfields = clone.subfields.map(sub => {
                const value = shouldRedactValue(settings, state, clone.tag, sub.code, sub.value)
                    ? '[REDACTED]'
                    : (sub.value || '');
                return { code: sub.code, value };
            });
        }
        return clone;
    }

    function redactRecordContext(recordContext, settings, state) {
        if (!recordContext || typeof recordContext !== 'object') return {};
        const fields = Array.isArray(recordContext.fields) ? recordContext.fields : [];
        return {
            fields: fields.map(field => {
                const subfields = Array.isArray(field.subfields) ? field.subfields : [];
                return {
                    ...field,
                    subfields: subfields.map(sub => {
                        const value = shouldRedactValue(settings, state, field.tag, sub.code, sub.value)
                            ? '[REDACTED]'
                            : (sub.value || '');
                        return { code: sub.code, value };
                    })
                };
            })
        };
    }

    function isExcluded(settings, state, tag, code) {
        if (!settings.enableLocalFields && /^9\d\d$/.test(tag)) return true;
        if (settings.enableLocalFields && state.localAllowlist.length) {
            const allowed = state.localAllowlist.some(entry => {
                if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
                if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
                if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
                if (/^\d{3}$/i.test(entry)) return entry === tag;
                return false;
            });
            if (!allowed) return true;
        }
        return state.excludedTags.some(entry => {
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            return false;
        });
    }

    function isTagExcluded(settings, state, tag) {
        if (!settings.enableLocalFields && /^9\d\d$/.test(tag)) return true;
        if (settings.enableLocalFields && state.localAllowlist.length) {
            const allowed = state.localAllowlist.some(entry => {
                if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
                if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
                if (/^\d{3}$/i.test(entry)) return entry === tag;
                return false;
            });
            if (!allowed) return true;
        }
        return state.excludedTags.some(entry => {
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            return false;
        });
    }

    function updateFindingsForField(state, meta, findings) {
        const occurrenceKey = normalizeOccurrenceKey(meta.occurrence);
        Array.from(state.findings.keys()).forEach(key => {
            if (key.startsWith(meta.tag) && key.endsWith(`:${occurrenceKey}`)) {
                state.findings.delete(key);
            }
        });
        const grouped = groupFindings(findings);
        grouped.forEach((list, key) => {
            state.findings.set(key, dedupeFindings(list));
        });
    }

    function groupFindings(findings) {
        const grouped = new Map();
        dedupeFindings(findings).forEach(finding => {
            const key = `${finding.tag}${finding.subfield}:${normalizeOccurrenceKey(finding.occurrence)}`;
            const existing = grouped.get(key) || [];
            existing.push(finding);
            grouped.set(key, existing);
        });
        return grouped;
    }

    function buildFindingKey(finding) {
        return [
            finding.severity,
            finding.code,
            finding.tag,
            finding.subfield,
            normalizeOccurrenceKey(finding.occurrence),
            finding.expected_value || '',
            finding.message || ''
        ].join('|');
    }

    function isFindingIgnored(state, finding) {
        if (!state || !state.ignoredFindings) return false;
        return state.ignoredFindings.has(buildFindingKey(finding));
    }

    function ignoreFinding(state, finding) {
        if (!state || !state.ignoredFindings) return;
        state.ignoredFindings.add(buildFindingKey(finding));
    }

    function ignoreAllFindings(state) {
        if (!state || !state.ignoredFindings) return;
        state.findings.forEach(list => {
            list.forEach(finding => {
                state.ignoredFindings.add(buildFindingKey(finding));
            });
        });
    }

    function dedupeFindings(findings) {
        const seen = new Set();
        const result = [];
        findings.forEach(finding => {
            const key = buildFindingKey(finding);
            if (seen.has(key)) return;
            seen.add(key);
            result.push(finding);
        });
        return result;
    }

    const STATEMENT_CASE_FINDING_CODE = 'AACR2_STATEMENT_245C_CASE';

    function isStatementCaseEnabled(settings) {
        return !!(settings && settings.enabled);
    }

    const STATEMENT_LOWER_WORDS = new Set([
        'by', 'edited', 'editor', 'editors', 'ed', 'eds', 'ed.',
        'illustrated', 'illustrator', 'illustrators', 'illus', 'illus.',
        'translated', 'translator', 'translators', 'trans', 'trans.',
        'compiled', 'compiler', 'compilers', 'comp', 'comp.',
        'adapted', 'adapter', 'adapters', 'arranged', 'arranger', 'arrangers',
        'selected', 'selection', 'introduction', 'preface', 'foreword', 'afterword',
        'commentary', 'notes', 'with', 'and', 'or', 'from', 'for', 'based', 'upon',
        'rev', 'revised', 'revision', 'abridged'
    ]);

    function titleCaseName(text) {
        return (text || '').split(/\s+/).map(word => toNameTitleWord(word)).join(' ');
    }

    function toNameTitleWord(word) {
        if (!word) return word;
        const match = word.match(/^([("'\\[]*)([A-Za-z][A-Za-z'.-]*)([^A-Za-z]*)$/);
        if (!match) return word;
        const leading = match[1] || '';
        const core = match[2] || '';
        const trailing = match[3] || '';
        if (core.toUpperCase() === core && core.length <= 3) {
            return `${leading}${core}${trailing}`;
        }
        if (/^Mc[A-Za-z]/.test(core)) {
            const rest = core.slice(2);
            return `${leading}Mc${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}${trailing}`;
        }
        if (core.includes("'")) {
            const parts = core.split("'");
            const fixed = parts.map(part => part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : '').join("'");
            return `${leading}${fixed}${trailing}`;
        }
        return `${leading}${core.charAt(0).toUpperCase()}${core.slice(1).toLowerCase()}${trailing}`;
    }

    function normalizeStatementStopwords(text) {
        return (text || '').split(/\s+/).map(word => normalizeStatementWord(word)).join(' ');
    }

    function normalizeStatementWord(word) {
        if (!word) return word;
        const match = word.match(/^([("'\\[]*)([A-Za-z][A-Za-z'.-]*)([^A-Za-z]*)$/);
        if (!match) return word;
        const leading = match[1] || '';
        const core = match[2] || '';
        const trailing = match[3] || '';
        const lowered = core.toLowerCase();
        if (STATEMENT_LOWER_WORDS.has(lowered)) {
            return `${leading}${lowered}${trailing}`;
        }
        return word;
    }

    function applyStatementDecorations(original, normalized) {
        const raw = (original || '').toString();
        let expected = (normalized || '').toString().trim();
        if (!expected) return '';
        const prefixMatch = raw.match(/^\s*\/\s*/);
        if (prefixMatch && prefixMatch[0] && !expected.startsWith(prefixMatch[0])) {
            expected = prefixMatch[0] + expected;
        }
        const suffixMatch = raw.match(/[.?!]\s*$/);
        if (suffixMatch && suffixMatch[0]) {
            const suffix = suffixMatch[0].trim();
            if (suffix && !expected.endsWith(suffix)) {
                expected += suffix;
            }
        }
        return expected;
    }

    function buildStatementCaseFinding(meta, current, expected) {
        return {
            severity: 'WARNING',
            code: STATEMENT_CASE_FINDING_CODE,
            message: 'Normalize casing for statement of responsibility.',
            rationale: 'Local Title Case normalization suggests a different capitalization.',
            tag: meta.tag,
            subfield: meta.code,
            occurrence: normalizeOccurrenceKey(meta.occurrence),
            current_value: current,
            expected_value: expected,
            proposed_fixes: [{
                label: 'Normalize casing',
                patch: [{
                    op: 'replace_subfield',
                    tag: meta.tag,
                    code: meta.code,
                    value: expected
                }]
            }]
        };
    }

    function updateStatementCaseFinding(state, meta, finding) {
        if (!state || !meta) return;
        const key = `${meta.tag}${meta.code}:${normalizeOccurrenceKey(meta.occurrence)}`;
        const list = state.findings.get(key) || [];
        const filtered = list.filter(item => item.code !== STATEMENT_CASE_FINDING_CODE);
        if (finding) filtered.push(finding);
        state.findings.set(key, dedupeFindings(filtered));
    }

    function collectFindingsForField(state, tag, occurrence) {
        const list = [];
        if (!state || !state.findings) return list;
        const suffix = `:${normalizeOccurrenceKey(occurrence)}`;
        state.findings.forEach((items, key) => {
            if (key.startsWith(tag) && key.endsWith(suffix)) {
                items.forEach(item => list.push(item));
            }
        });
        return list;
    }

    function queueStatementCaseValidation(fieldContext, settings, state) {
        if (!isStatementCaseEnabled(settings) || !fieldContext) return;
        if (fieldContext.tag !== '245') return;
        const occurrence = normalizeOccurrenceKey(fieldContext.occurrence);
        fieldContext.subfields.forEach(sub => {
            if (!sub || (sub.code || '').toLowerCase() !== 'c') return;
            if (isExcluded(settings, state, fieldContext.tag, sub.code)) return;
            const meta = { tag: fieldContext.tag, code: sub.code, occurrence };
            scheduleStatementCaseCheck(meta, sub.value || '', settings, state);
        });
    }

    function queueStatementCaseRecordValidations(settings, state) {
        if (!isStatementCaseEnabled(settings)) return;
        const record = buildRecordContext();
        (record.fields || []).forEach(field => {
            if (!field || field.tag !== '245') return;
            const ctx = buildFieldContext(field.tag, field.occurrence || '');
            if (ctx) queueStatementCaseValidation(ctx, settings, state);
        });
    }

    function scheduleStatementCaseCheck(meta, value, settings, state) {
        if (!state || !meta) return;
        const key = buildFieldKey(meta);
        const trimmed = (value || '').toString();
        if (!trimmed.trim()) {
            updateStatementCaseFinding(state, meta, null);
            updateSidePanel(state);
            updateGuardrails(settings, state);
            return;
        }
        if (state.statementCaseTimers.has(key)) {
            clearTimeout(state.statementCaseTimers.get(key));
        }
        const timer = setTimeout(() => {
            runStatementCaseCheck(meta, trimmed, settings, state);
        }, 250);
        state.statementCaseTimers.set(key, timer);
    }

    function runStatementCaseCheck(meta, value, settings, state) {
        if (!state || !meta) return;
        const key = buildFieldKey(meta);
        if (state.statementCaseTimers.has(key)) {
            clearTimeout(state.statementCaseTimers.get(key));
            state.statementCaseTimers.delete(key);
        }
        applyStatementCaseResult(meta, value, settings, state);
    }

    function applyStatementCaseResult(meta, requestedValue, settings, state) {
        const $field = findFieldElement(meta.tag, meta.code, meta.occurrence);
        if (!$field.length) return;
        const current = ($field.val() || '').toString();
        if (current !== requestedValue) return;
        const prefixMatch = current.match(/^\s*\/\s*/);
        const suffixMatch = current.match(/[.?!]\s*$/);
        let core = current;
        if (prefixMatch && prefixMatch[0]) {
            core = core.slice(prefixMatch[0].length);
        }
        if (suffixMatch && suffixMatch[0]) {
            core = core.slice(0, Math.max(0, core.length - suffixMatch[0].length));
        }
        const fallback = normalizeStatementStopwords(titleCaseName(core.trim()));
        let expectedCore = fallback || core.trim();
        if (meta.tag === '245' && meta.code === 'c') {
            expectedCore = normalizeStatementStopwords(expectedCore);
        }
        const expected = applyStatementDecorations(current, expectedCore);
        if (!expected || expected === current) {
            updateStatementCaseFinding(state, meta, null);
        } else {
            updateStatementCaseFinding(state, meta, buildStatementCaseFinding(meta, current, expected));
        }
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        if (fieldContext) {
            const combined = collectFindingsForField(state, meta.tag, meta.occurrence);
            updateIndicators(fieldContext, combined);
        }
        updateSidePanel(state);
        updateGuardrails(settings, state);
    }

    function countSeverity(findingsMap, severity) {
        let count = 0;
        findingsMap.forEach(list => {
            list.forEach(f => {
                if (f.severity === severity) count++;
            });
        });
        return count;
    }

    function applyAutoFixes(settings, state, meta, findings) {
        if (!state.autoApply || !settings.enabled || state.guideActive || state.readOnly) return;
        findings.forEach(finding => {
            const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
            if (!patch) return;
            applyPatch(patch, finding.occurrence, finding);
        });
    }

    function applyPatch(patch, occurrence, finding) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) {
            toast('warning', 'Punctuation apply is disabled in internship mode.');
            return;
        }
        if (patch.op !== 'replace_subfield') return;
        const $field = findFieldElement(patch.tag, patch.code, occurrence);
        if (!$field.length) return;
        const previous = $field.val() || '';
        if (previous === patch.value) return;
        const meta = parseFieldMeta($field[0]);
        const record = {
            tag: patch.tag,
            code: patch.code,
            occurrence: occurrence || (meta ? meta.occurrence : '')
        };
        markFieldForRevalidation(state, meta || record);
        recordUndo(record, previous, patch.value);
        $field.val(patch.value);
        $field.trigger('change');
        const conditionToast = buildConditionalSuffixToast(finding);
        if (conditionToast) {
            toast('info', conditionToast);
        }
    }

    function applyAiPatch(patch, finding) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) {
            toast('warning', 'Punctuation apply is disabled in internship mode.');
            return;
        }
        if (!patch || patch.op !== 'replace_subfield') return;
        const occurrence = patch.occurrence;
        const $field = findFieldElement(patch.tag, patch.subfield, occurrence);
        if (!$field.length) return;
        const previous = $field.val() || '';
        if (patch.original_text !== undefined && patch.original_text !== previous) {
            toast('warning', 'Field value changed; AI patch skipped.');
            return;
        }
        const nextValue = patch.replacement_text || '';
        if (previous === nextValue) return;
        const meta = parseFieldMeta($field[0]);
        const record = {
            tag: patch.tag,
            code: patch.subfield,
            occurrence: occurrence || (meta ? meta.occurrence : '')
        };
        markFieldForRevalidation(state, meta || record);
        recordUndo(record, previous, nextValue);
        $field.val(nextValue);
        $field.trigger('change');
        const conditionToast = buildConditionalSuffixToast(finding);
        if (conditionToast) {
            toast('info', conditionToast);
        }
    }

    function recordUndo(target, previousValue, nextValue) {
        const state = global.AACR2IntellisenseState;
        if (!state) return;
        state.undoStack.push({
            tag: target.tag,
            code: target.code,
            occurrence: target.occurrence || '',
            previous: previousValue,
            next: nextValue
        });
    }

    function updateIndicators(fieldContext, findings) {
        fieldContext.subfields.forEach(sub => {
            const $field = findFieldElement(fieldContext.tag, sub.code, fieldContext.occurrence);
            if (!$field.length) return;
            $field.siblings('.aacr2-indicator').remove();
            const related = findings.filter(f => f.subfield === sub.code);
            if (!related.length) return;
            const highest = related.find(f => f.severity === 'ERROR') || related.find(f => f.severity === 'WARNING') || related[0];
            const tooltip = buildTooltip(highest);
            const badge = $(`<span class="aacr2-indicator ${highest.severity.toLowerCase()}" title="${tooltip}">${highest.severity}</span>`);
            $field.after(badge);
        });
    }

    function buildTooltip(finding) {
        const example = finding.examples && finding.examples[0] ? `Example: ${finding.examples[0].before} -> ${finding.examples[0].after}` : '';
        return `${finding.message}\n${finding.rationale || ''}\n${example}`.trim();
    }

    function updateSidePanel(state) {
        const $container = $('#aacr2-findings');
        if (!$container.length) return;
        $container.empty();
        let total = 0;
        const isReadOnly = state && state.readOnly;
        const readOnlyAttr = isReadOnly ? 'disabled title="Disabled in internship mode."' : '';
        if (state.guardrailAlerts && state.guardrailAlerts.length) {
            state.guardrailAlerts.forEach(alert => {
                total++;
                const hasTarget = alert && alert.tag && alert.subfield;
                const action = hasTarget
                    ? `<button type="button" class="btn btn-xs btn-default" data-tag="${alert.tag}" data-sub="${alert.subfield}">Go to field</button>`
                    : '';
                const item = $(`
                    <div class="finding warning">
                        <div><strong>${alert.label || 'Guardrail'}</strong> · WARNING</div>
                        <div class="meta">${alert.message || 'Required AACR2 data is missing.'}</div>
                        <div class="actions">${action}</div>
                    </div>
                `);
                if (hasTarget) {
                    item.find('button').on('click', (event) => {
                        const $btn = $(event.currentTarget);
                        focusField($btn.data('tag'), $btn.data('sub'), '');
                    });
                }
                $container.append(item);
            });
        }
        if (state.missingRequired.length) {
            state.missingRequired.forEach(code => {
                total++;
                const tag = code.slice(0, 3);
                const sub = code.slice(3);
                const label = `${tag}$${sub}`;
                const item = $(`
                    <div class="finding warning">
                        <div><strong>${label}</strong> · WARNING</div>
                        <div class="meta">Required AACR2 field is missing.</div>
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default" data-tag="${tag}" data-sub="${sub}">Go to field</button>
                        </div>
                    </div>
                `);
                item.find('button').on('click', (event) => {
                    const $btn = $(event.currentTarget);
                    focusField($btn.data('tag'), $btn.data('sub'), '');
                });
                $container.append(item);
            });
        }
        state.findings.forEach(list => {
            list.forEach(finding => {
                if (isFindingIgnored(state, finding)) return;
                total++;
                const severityClass = (finding.severity || 'info').toLowerCase();
                const helpText = buildHelpText(finding);
                const conditionNote = buildConditionalSuffixNote(finding);
                const conditionHtml = conditionNote ? `<div class="meta">${escapeAttr(conditionNote)}</div>` : '';
                const helpIcon = (finding.severity === 'ERROR' || finding.severity === 'WARNING')
                    ? `<span class="aacr2-help" title="${escapeAttr(helpText)}">?</span>`
                    : '';
                const preview = finding.expected_value ? `<div class="aacr2-preview">${finding.current_value} → ${finding.expected_value}</div>` : '';
                const rawExcerpt = finding.raw_text_excerpt ? escapeAttr(finding.raw_text_excerpt) : '';
                const rawHtml = rawExcerpt
                    ? `<div class="aacr2-raw-wrapper">
                            <button type="button" class="btn btn-xs btn-default aacr2-raw-toggle">View raw output</button>
                            <pre class="aacr2-raw-output">${rawExcerpt}</pre>
                        </div>`
                    : '';
                const item = $(`
                    <div class="finding ${severityClass}">
                        <div><strong>${finding.tag}$${finding.subfield}</strong> · ${finding.severity} ${helpIcon}</div>
                        <div class="meta">${finding.message}</div>
                        ${conditionHtml}
                        ${preview}
                        ${rawHtml}
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default aacr2-go-field" data-tag="${finding.tag}" data-sub="${finding.subfield}" data-occ="${normalizeOccurrenceKey(finding.occurrence)}">Go to field</button>
                            <button type="button" class="btn btn-xs btn-primary aacr2-apply" ${readOnlyAttr}>Apply</button>
                            <button type="button" class="btn btn-xs btn-default aacr2-ignore">Ignore</button>
                        </div>
                    </div>
                `);
                item.find('.aacr2-go-field').on('click', () => {
                    focusField(finding.tag, finding.subfield, finding.occurrence);
                });
                item.find('.aacr2-apply').on('click', () => {
                    if (isReadOnly) {
                        toast('warning', 'Punctuation apply is disabled in internship mode.');
                        return;
                    }
                    const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
                    if (patch) {
                        const conditionToast = buildConditionalSuffixToast(finding);
                        applyPatch(patch, finding.occurrence, finding);
                        if (!conditionToast) {
                            toast('info', `AACR2 punctuation applied to ${finding.tag}$${finding.subfield}.`);
                        }
                    }
                });
                item.find('.aacr2-ignore').on('click', () => {
                    ignoreFinding(state, finding);
                    updateSidePanel(state);
                });
                item.find('.aacr2-raw-toggle').on('click', function() {
                    const $raw = item.find('.aacr2-raw-output');
                    const isVisible = $raw.is(':visible');
                    $raw.toggle(!isVisible);
                    $(this).text(isVisible ? 'View raw output' : 'Hide raw output');
                });
                $container.append(item);
            });
        });
        if (!total) {
            $container.append('<div class="meta">No AACR2 findings yet.</div>');
        }
    }

    function updateGuardrails(settings, state) {
        const missing = state.requiredFields.filter(code => {
            const tag = code.slice(0, 3);
            const sub = code.slice(3);
            return !anyFieldHasValue(tag, sub);
        });
        state.missingRequired = missing;
        state.guardrailAlerts = [];
        const errorCount = countSeverity(state.findings, 'ERROR');
        const missingCount = missing.length;
        const total = errorCount + missingCount;
        const status = total === 0 ? 'AACR2 guardrails satisfied' : `${total} issue(s) (${missingCount} required missing)`;
        $('#aacr2-guardrail-status').text(`Guardrails: ${status}`);
    }

    function applyAllFindings(settings) {
        const state = global.AACR2IntellisenseState;
        if (!state) return;
        if (state.readOnly) {
            toast('warning', 'Punctuation apply is disabled in internship mode.');
            return;
        }
        const patches = [];
        state.findings.forEach(list => {
            list.forEach(finding => {
                if (isFindingIgnored(state, finding)) return;
                const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
                if (!patch) return;
                patches.push({ patch, occurrence: finding.occurrence, finding });
            });
        });
        if (!patches.length) {
            toast('info', 'No AACR2 suggestions to apply.');
            return;
        }
        patches.forEach(item => applyPatch(item.patch, item.occurrence, item.finding));
        refreshAll(settings);
        toast('info', 'Applied all AACR2 suggestions.');
    }

    function undoLastChange() {
        const state = global.AACR2IntellisenseState;
        if (!state || !state.undoStack.length) {
            toast('info', 'Nothing to undo.');
            return;
        }
        if (state.readOnly) {
            toast('warning', 'Undo is disabled in internship mode.');
            return;
        }
        const change = state.undoStack.pop();
        const $field = findFieldElement(change.tag, change.code, change.occurrence);
        if ($field.length) {
            $field.val(change.previous);
            refreshAll(global.AutoPunctuationSettings || {});
            toast('info', 'Last change undone.');
        }
    }

    function undoAllChanges() {
        const state = global.AACR2IntellisenseState;
        if (!state || !state.undoStack.length) {
            toast('info', 'Nothing to undo.');
            return;
        }
        if (state.readOnly) {
            toast('warning', 'Undo is disabled in internship mode.');
            return;
        }
        while (state.undoStack.length) {
            const change = state.undoStack.pop();
            const $field = findFieldElement(change.tag, change.code, change.occurrence);
            if ($field.length) $field.val(change.previous);
        }
        refreshAll(global.AutoPunctuationSettings || {});
        toast('info', 'All changes undone.');
    }

    function refreshAll(settings) {
        const state = global.AACR2IntellisenseState;
        if (!state) return;
        const record = filterRecordContext(buildRecordContext(), settings, state);
        const result = global.AACR2RulesEngine.validateRecord(record, settings, state.rules, settings.strictCoverageMode);
        state.findings = groupFindings(result.findings);
        updateSidePanel(state);
        updateGuardrails(settings, state);
        queueStatementCaseRecordValidations(settings, state);
        notifyDependentFindingsAfterRefresh(state);
    }

    function maybeShowGhost(element, findings, settings, state) {
        $(element).siblings('.aacr2-ghost-text').remove();
        if (!settings.enabled || state.readOnly) return;
        const candidate = findings.find(finding => finding.severity !== 'ERROR' && finding.expected_value);
        if (!candidate) return;
        const ghostText = computeGhostText(candidate.current_value, candidate.expected_value);
        if (!ghostText) return;
        const $ghost = $(`<span class="aacr2-ghost-text" title="Accept AACR2 suggestion">${ghostText}</span>`);
        $ghost.data('expected', candidate.expected_value);
        $ghost.on('click', () => {
            $(element).val(candidate.expected_value);
            $ghost.remove();
            markFieldForRevalidation(state, parseFieldMeta(element));
            toast('info', 'AACR2 ghost suggestion applied.');
        });
        $(element).after($ghost);
    }

    function computeGhostText(currentValue, expectedValue) {
        if (!currentValue) return '';
        if (expectedValue.startsWith(currentValue)) {
            return expectedValue.slice(currentValue.length);
        }
        if (expectedValue.endsWith(currentValue)) {
            return expectedValue.slice(0, expectedValue.length - currentValue.length);
        }
        return '';
    }

    function updateAiPanelStatus($panel, message, type) {
        if (!$panel || !$panel.length) return;
        const $status = $panel.find('#aacr2-ai-status');
        if (!$status.length) return;
        $status.removeClass('success error info').addClass(type || 'info');
        $status.text(message || '');
    }

    function updateAiCatalogingStatus($panel, message, type) {
        if (!$panel || !$panel.length) return;
        const $status = $panel.find('#aacr2-ai-cataloging-status');
        if (!$status.length) return;
        $status.removeClass('success error info').addClass(type || 'info');
        $status.text(message || '');
    }

    function renderAiDebug($panel, context, result) {
        if (!$panel || !$panel.length) return;
        const debug = result && result.debug ? result.debug : null;
        const $details = $panel.find(`#aacr2-ai-${context}-debug`);
        const $content = $panel.find(`#aacr2-ai-${context}-debug-content`);
        if (!$details.length || !$content.length) return;
        if (!debug || (!debug.raw_provider_response && !debug.raw_text && !debug.parse_error)) {
            $details.hide();
            $content.text('');
            return;
        }
        const sections = [];
        if (debug.parse_error) sections.push(`Parse error: ${debug.parse_error}`);
        if (debug.raw_provider_response) sections.push(`Raw provider response:\n${debug.raw_provider_response}`);
        if (debug.raw_text && !debug.raw_provider_response) sections.push(`Raw text:\n${debug.raw_text}`);
        $content.text(sections.join('\n\n'));
        $details.show();
    }

    function confidencePercentFromResult(result) {
        if (result && typeof result.confidence_percent === 'number' && !Number.isNaN(result.confidence_percent)) {
            return Math.min(100, Math.max(0, Math.round(result.confidence_percent)));
        }
        const findings = result && Array.isArray(result.findings) ? result.findings : [];
        const values = findings
            .map(finding => (finding && typeof finding.confidence === 'number' ? finding.confidence : null))
            .filter(value => value !== null && value >= 0 && value <= 1);
        if (!values.length) return 50;
        const avg = values.reduce((acc, val) => acc + val, 0) / values.length;
        return Math.min(100, Math.max(0, Math.round(avg * 100)));
    }

    function summarizeFindings(findings) {
        if (!Array.isArray(findings) || !findings.length) return '';
        const lines = [];
        findings.forEach(finding => {
            if (!finding) return;
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

    function summarizeIssues(issues) {
        if (!Array.isArray(issues) || !issues.length) return '';
        return issues.map(issue => {
            if (!issue) return '';
            const message = (issue.message || '').trim();
            const suggestion = (issue.suggestion || '').trim();
            if (message && suggestion && message !== suggestion) return `${message} - ${suggestion}`;
            return message || suggestion || '';
        }).filter(Boolean).join('\n');
    }

    function groupIssuesByField(issues) {
        const grouped = new Map();
        (issues || []).forEach(issue => {
            if (!issue) return;
            const tag = issue.tag || '';
            const subfield = issue.subfield || '';
            const key = `${tag}$${subfield}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(issue);
        });
        return grouped;
    }

    function collectAiPunctuationPatches(findings) {
        const patches = [];
        if (!Array.isArray(findings)) return patches;
        findings.forEach((finding, findingIndex) => {
            const fixes = Array.isArray(finding.proposed_fixes) ? finding.proposed_fixes : [];
            fixes.forEach((fix, fixIndex) => {
                const patchList = Array.isArray(fix.patch) ? fix.patch : [];
                patchList.forEach((patch, patchIndex) => {
                    if (!patch) return;
                    patches.push({
                        id: `${findingIndex}-${fixIndex}-${patchIndex}`,
                        finding,
                        patch
                    });
                });
            });
        });
        return patches;
    }

    function formatAiPatchLabel(item) {
        if (!item || !item.patch) return '';
        const patch = item.patch;
        const tag = patch.tag || '';
        const code = patch.subfield || '';
        const original = patch.original_text || '';
        const replacement = patch.replacement_text || '';
        if (original && replacement && original !== replacement) {
            return `${tag}$${code}: "${original}" -> "${replacement}"`;
        }
        return `${tag}$${code}: ${replacement || original}`.trim();
    }

    function renderAiPunctuationResults($panel, settings, state, meta, result) {
        if (!$panel || !$panel.length) return;
        const $summary = $panel.find('#aacr2-ai-punctuation-summary');
        const $list = $panel.find('#aacr2-ai-punctuation-list');
        const $actions = $panel.find('#aacr2-ai-punctuation-actions');
        const findings = Array.isArray(result && result.findings) ? result.findings : [];
        const issues = Array.isArray(result && result.issues) ? result.issues : [];
        const patches = collectAiPunctuationPatches(findings);
        const assistantText = (result && result.assistant_message ? String(result.assistant_message).trim() : '');
        const summary = summarizeIssues(issues) || summarizeFindings(findings) || assistantText || 'No rules or punctuation suggestions returned.';

        if (state) {
            state.aiPunctuation = {
                findings,
                patches,
                summary,
                meta: meta || null
            };
        }

        if ($summary.length) $summary.text(summary);
        $list.empty();

        if (issues.length) {
            const grouped = groupIssuesByField(issues);
            grouped.forEach((items, key) => {
                const $group = $('<div class="aacr2-ai-result-item"></div>');
                $group.append(`<div><strong>${escapeAttr(key)}</strong></div>`);
                items.forEach(issue => {
                    const severity = (issue.severity || '').toUpperCase();
                    const message = (issue.message || '').trim();
                    const suggestion = (issue.suggestion || '').trim();
                    const ruleBasis = (issue.rule_basis || '').trim();
                    const snippet = (issue.snippet || issue.selector || '').trim();
                    if (message) $group.append(`<div>${escapeAttr(message)}</div>`);
                    if (suggestion) $group.append(`<div class="aacr2-ai-result-meta">Suggestion: ${escapeAttr(suggestion)}</div>`);
                    if (ruleBasis) $group.append(`<div class="aacr2-ai-result-meta">Rule basis: ${escapeAttr(ruleBasis)}</div>`);
                    if (snippet) $group.append(`<div class="aacr2-ai-result-meta">Snippet: ${escapeAttr(snippet)}</div>`);
                    if (severity) $group.append(`<div class="aacr2-ai-result-meta">Severity: ${escapeAttr(severity)}</div>`);
                });
                $list.append($group);
            });
        }
        if (patches.length) {
            if (issues.length) {
                $list.append('<div class="meta" style="margin-top:6px;">Applyable patches:</div>');
            }
            patches.forEach((item, index) => {
                const label = formatAiPatchLabel(item) || (item.finding && item.finding.message) || 'Suggested update';
                const $row = $(`
                    <div class="aacr2-ai-result-item">
                        <label>
                            <input type="checkbox" class="aacr2-ai-result-checkbox" data-index="${index}" checked/>
                            <span>${escapeAttr(label)}</span>
                        </label>
                    </div>
                `);
                $list.append($row);
            });
            const readOnly = state && state.readOnly;
            $actions.show();
            $actions.find('button').prop('disabled', !!readOnly);
        } else if (!issues.length && findings.length) {
            findings.forEach(finding => {
                const message = (finding.message || '').trim();
                const rationale = (finding.rationale || '').trim();
                if (!message && !rationale) return;
                const $row = $('<div class="aacr2-ai-result-item"></div>');
                if (message) $row.append(`<div>${escapeAttr(message)}</div>`);
                if (rationale && rationale !== message) {
                    $row.append(`<div class="aacr2-ai-result-meta">${escapeAttr(rationale)}</div>`);
                }
                $list.append($row);
            });
            $actions.hide();
        } else if (!issues.length && !patches.length) {
            $list.append('<div class="meta">(none)</div>');
            $actions.hide();
        } else if (!patches.length) {
            $actions.hide();
        }
    }

    function applySelectedAiPatches(state) {
        const $panel = $('#aacr2-ai-panel');
        const patches = state && state.aiPunctuation ? state.aiPunctuation.patches || [] : [];
        if (!patches.length) {
            toast('info', 'No AI rule or punctuation suggestions to apply.');
            return;
        }
        const selected = $panel.find('#aacr2-ai-punctuation-list input[type="checkbox"]:checked');
        if (!selected.length) {
            toast('info', 'No AI suggestions selected.');
            return;
        }
        let applied = 0;
        selected.each(function() {
            const idx = Number($(this).data('index'));
            const item = patches[idx];
            if (!item || !item.patch) return;
            applyAiPatch(item.patch, item.finding);
            applied += 1;
        });
        if (applied) {
            toast('info', `Applied ${applied} AI punctuation suggestion${applied > 1 ? 's' : ''}.`);
        }
    }

    function applyAllAiPatches(state) {
        const patches = state && state.aiPunctuation ? state.aiPunctuation.patches || [] : [];
        if (!patches.length) {
            toast('info', 'No AI rule or punctuation suggestions to apply.');
            return;
        }
        let applied = 0;
        patches.forEach(item => {
            if (!item || !item.patch) return;
            applyAiPatch(item.patch, item.finding);
            applied += 1;
        });
        if (applied) {
            toast('info', `Applied ${applied} AI punctuation suggestion${applied > 1 ? 's' : ''}.`);
        }
    }

    function updateAiPanelSelection($panel, settings, state) {
        if (!$panel || !$panel.length) return { element: null, meta: null };
        const element = resolveAiTargetElement(state);
        const meta = element ? parseFieldMeta(element) : null;
        const requestState = getAiRequestState(state, 'punctuation');
        const inFlight = requestState && requestState.inFlight;
        if (!meta) {
            $panel.data('targetElement', null);
            $panel.data('targetMeta', null);
            $panel.find('#aacr2-ai-selected').text('None');
            $panel.find('#aacr2-ai-current').text('(no MARC field selected)');
            if (!inFlight) {
                updateAiPanelStatus($panel, 'Select a MARC field to enable rule and punctuation suggestions.', 'info');
            }
            return { element: null, meta: null };
        }
        const label = `${meta.tag}$${meta.code}${meta.occurrence ? ` (${meta.occurrence})` : ''}`;
        $panel.data('targetElement', element);
        $panel.data('targetMeta', meta);
        $panel.find('#aacr2-ai-selected').text(label);
        $panel.find('#aacr2-ai-current').text($(element).val() || '(empty)');
        if (!inFlight) {
            updateAiPanelStatus($panel, '', 'info');
        }
        return { element, meta };
    }

    function updateAiCatalogingContext($panel, settings, state) {
        if (!$panel || !$panel.length) return {};
        const titleInfo = getTitleWithSubtitle();
        const cutterSource = getPreferredCutterSource();
        const yearInfo = getPublicationYear();
        const aiSuggestions = (state && state.aiSuggestions) ? state.aiSuggestions : { classification: '', subjects: [], confidence: null, errors: [] };
        const classificationInput = $panel.find('#aacr2-ai-classification-input').val() || '';
        const aiRangeError = Array.isArray(aiSuggestions.errors)
            ? (aiSuggestions.errors.find(err => err && err.code === 'CLASSIFICATION_RANGE') || null)
            : null;
        const inputRangeMessage = classificationRangeMessage(classificationInput);
        const suggestionRangeMessage = classificationRangeMessage(aiSuggestions.classification || '');
        const rangeMessage = inputRangeMessage || suggestionRangeMessage || (aiRangeError ? aiRangeError.message : '');
        const classificationRaw = rangeMessage ? '' : (classificationInput || aiSuggestions.classification || '');
        const classification = normalizeClassificationSuggestion(classificationRaw);
        const cutter = buildCutterSanborn(cutterSource.value || '', cutterSource.tag || '');
        const year = yearInfo.value || '';
        const callNumber = buildCallNumber(classification, cutter, year);

        $panel.find('#aacr2-ai-title').text(titleInfo.value || '(missing)');
        $panel.find('#aacr2-ai-cutter-source').text(cutterSource.label || 'Title');
        $panel.find('#aacr2-ai-cutter').text(cutter || '(no match)');
        $panel.find('#aacr2-ai-year').text(year || '(n/a)');
        const previewText = rangeMessage ? '(range not allowed)' : (callNumber || '(waiting for classification)');
        $panel.find('#aacr2-ai-callnumber-preview').text(previewText);
        $panel.find('#aacr2-ai-classification').text(aiSuggestions.classification || '(none)');
        const $classError = $panel.find('#aacr2-ai-classification-error');
        if ($classError.length) {
            if (rangeMessage) {
                $classError.text(rangeMessage).show();
            } else {
                $classError.text('').hide();
            }
        }
        const confidence = typeof aiSuggestions.confidence === 'number'
            ? `${Math.round(aiSuggestions.confidence)}%`
            : '(n/a)';
        $panel.find('#aacr2-ai-confidence').text(confidence);
        renderAiSubjectList($panel, aiSuggestions.subjects || []);
        $panel.find('#aacr2-ai-response').text(aiSuggestions.rawText || '(none)');

        const hasTitle = !!titleInfo.title;
        const selection = getAiCatalogingSelectionState($panel, settings);
        const $runBtn = $panel.find('#aacr2-ai-run-cataloging');
        if ($runBtn.length) $runBtn.prop('disabled', !hasTitle || !selection.hasFeature);
        let status = '';
        if (!hasTitle) {
            status = 'Title source requires 245$a. 245$b and 245$c are included when present.';
        } else if (!selection.hasFeature) {
            status = 'Select classification and/or subjects to enable suggestions.';
        }
        const requestState = getAiRequestState(state, 'cataloging');
        const inFlight = requestState && requestState.inFlight;
        if (!inFlight) {
            $panel.find('#aacr2-ai-cataloging-status')
                .text(status)
                .toggleClass('error', !hasTitle)
                .toggleClass('info', hasTitle);
        }
        const $applyCall = $panel.find('#aacr2-ai-apply-callnumber');
        if ($applyCall.length) {
            const readOnly = state && state.readOnly;
            $applyCall.prop('disabled', !!(inputRangeMessage || aiRangeError || readOnly));
        }
        updateAiCatalogingControls($panel, settings);
        return { titleInfo, cutterSource, year, classification, callNumber, cutter };
    }

    function getAiCatalogingSelectionState($panel, settings) {
        const classificationEnabled = !!(settings.aiCallNumberGuidance && $panel.find('#aacr2-ai-opt-classification').is(':checked'));
        const subjectsEnabled = !!(settings.aiSubjectGuidance && $panel.find('#aacr2-ai-opt-subjects').is(':checked'));
        const hasFeature = classificationEnabled || subjectsEnabled;
        let label = 'Suggest classification & subjects';
        if (classificationEnabled && !subjectsEnabled) label = 'Suggest classification';
        if (!classificationEnabled && subjectsEnabled) label = 'Suggest subjects';
        if (!classificationEnabled && !subjectsEnabled) label = 'Select cataloging options';
        return { classificationEnabled, subjectsEnabled, hasFeature, label };
    }

    function updateAiCatalogingControls($panel, settings) {
        if (!$panel || !$panel.length) return;
        const selection = getAiCatalogingSelectionState($panel, settings);
        const $button = $panel.find('#aacr2-ai-run-cataloging');
        if ($button.length) {
            $button.text(selection.label);
            $button.prop('disabled', $button.prop('disabled') || !selection.hasFeature);
        }
        const state = global.AACR2IntellisenseState;
        const subjects = state && state.aiSuggestions ? state.aiSuggestions.subjects || [] : [];
        const $applySubjects = $panel.find('#aacr2-ai-apply-subjects');
        if ($applySubjects.length) {
            $applySubjects.prop('disabled', !subjects.length || (state && state.readOnly));
        }
    }

    function resolveAiTargetElement(state) {
        const active = document.activeElement;
        if (active && parseFieldMeta(active)) return active;
        if (state && state.lastFocusedField && document.contains(state.lastFocusedField)) {
            const meta = parseFieldMeta(state.lastFocusedField);
            if (meta) return state.lastFocusedField;
        }
        return null;
    }

    function showAiAssistPanel(settings, state) {
        let $panel = $('#aacr2-ai-panel');
        if (!$panel.length) {
            $panel = $(`
                <div class="aacr2-ai-panel" id="aacr2-ai-panel" style="display:none;">
                    <header>
                        <span>AI Assist</span>
                        <div>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-minimize">Minimize</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-refresh">Refresh</button>
                            <button type="button" class="btn btn-xs btn-warning" id="aacr2-ai-panel-cancel" disabled>Cancel</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-close">Close</button>
                        </div>
                    </header>
                    <div class="body">
                        <div class="aacr2-ai-section">
                            <div class="aacr2-ai-section-title">Cataloging Suggestions</div>
                            <div class="meta">Title source (245$a + optional $n/$p/$b/$c): <strong id="aacr2-ai-title">None</strong></div>
                            <div class="meta">Cutter source: <span id="aacr2-ai-cutter-source">Title</span></div>
                            <div class="options">
                                <label><input type="checkbox" id="aacr2-ai-opt-classification"> Classification number</label>
                                <label><input type="checkbox" id="aacr2-ai-opt-subjects"> Subject headings</label>
                            </div>
                            <div id="aacr2-ai-cataloging-status" class="aacr2-guide-status info" style="margin-top: 6px;"></div>
                            <div class="actions">
                                ${settings.aiPayloadPreview ? '<button type="button" class="btn btn-xs btn-default" id="aacr2-ai-cataloging-preview">Preview</button>' : ''}
                                <button type="button" class="btn btn-xs btn-info" id="aacr2-ai-run-cataloging">Suggest classification &amp; subjects</button>
                            </div>
                            <div class="aacr2-ai-results">
                                <div class="meta">Classification (LC): <span id="aacr2-ai-classification">(none)</span></div>
                                <div class="meta">Confidence: <span id="aacr2-ai-confidence">(n/a)</span></div>
                                <div class="meta">Subjects:</div>
                                <div id="aacr2-ai-subjects" class="aacr2-ai-text-output">(none)</div>
                                <div class="actions" style="justify-content: space-between;">
                                    <label style="font-weight: normal;">
                                        <input type="checkbox" id="aacr2-ai-subjects-replace"/>
                                        Replace existing subjects
                                    </label>
                                    <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-apply-subjects">Apply subjects</button>
                                </div>
                                <div class="meta" style="margin-top: 6px;">AI response:</div>
                                <div id="aacr2-ai-response" class="aacr2-ai-text-output">(none)</div>
                                <details class="aacr2-ai-debug" id="aacr2-ai-cataloging-debug" style="display:none;">
                                    <summary>Advanced/Debug</summary>
                                    <pre id="aacr2-ai-cataloging-debug-content"></pre>
                                </details>
                            </div>
                            <div class="aacr2-ai-callnumber">
                                <label for="aacr2-ai-classification-input">Manual classification number</label>
                                <div class="aacr2-ai-inline">
                                    <input type="text" id="aacr2-ai-classification-input" class="form-control input-sm" placeholder="Enter classification"/>
                                </div>
                                <div id="aacr2-ai-classification-error" class="aacr2-ai-error" style="display:none;"></div>
                                <div class="meta">Derived cutter: <span id="aacr2-ai-cutter">(n/a)</span></div>
                                <div class="meta">Publication year: <span id="aacr2-ai-year">(n/a)</span></div>
                                <div class="meta">Call number preview: <span id="aacr2-ai-callnumber-preview">(waiting for classification)</span></div>
                                <div class="actions">
                                    <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-apply-callnumber">Apply call number</button>
                                </div>
                            </div>
                        </div>
                        <hr/>
                        <div class="aacr2-ai-section">
                            <div class="aacr2-ai-section-title">Rules &amp; Punctuation Suggestions</div>
                            <div class="meta">Selected field: <strong id="aacr2-ai-selected">None</strong></div>
                            <div class="meta">Field value:</div>
                            <div class="aacr2-ai-field-value" id="aacr2-ai-current"></div>
                            <div class="options">
                                <label><input type="checkbox" id="aacr2-ai-opt-punctuation"> Include rationale (may be slower)</label>
                            </div>
                            <div id="aacr2-ai-status" class="aacr2-guide-status info" style="margin-top: 8px;"></div>
                            <div class="actions">
                                ${settings.aiPayloadPreview ? '<button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-preview">Preview</button>' : ''}
                                <button type="button" class="btn btn-xs btn-info" id="aacr2-ai-panel-run">Run rules &amp; punctuation suggestions</button>
                            </div>
                            <div class="aacr2-ai-results" id="aacr2-ai-punctuation-results">
                                <div class="meta" id="aacr2-ai-punctuation-summary">No rules or punctuation suggestions yet.</div>
                                <div id="aacr2-ai-punctuation-list"></div>
                                <div class="aacr2-ai-result-actions" id="aacr2-ai-punctuation-actions" style="display:none;">
                                    <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-apply-selected">Apply selected</button>
                                    <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-apply-all">Apply all</button>
                                </div>
                                <details class="aacr2-ai-debug" id="aacr2-ai-punctuation-debug" style="display:none;">
                                    <summary>Advanced/Debug</summary>
                                    <pre id="aacr2-ai-punctuation-debug-content"></pre>
                                </details>
                            </div>
                        </div>
                    </div>
                </div>
            `);
            $('body').append($panel);
            makeAiPanelDraggable();
            $panel.find('#aacr2-ai-panel-minimize').on('click', () => {
                setFloatingMinimized($panel, !$panel.hasClass('minimized'), '#aacr2-ai-panel-minimize');
            });
            $panel.find('#aacr2-ai-panel-close').on('click', () => {
                $panel.hide();
                if (state) state.aiPanelOpen = false;
                updateAiToggleButton();
            });
            $panel.find('#aacr2-ai-panel-refresh').on('click', () => {
                updateAiPanelSelection($panel, settings, state);
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-panel-cancel').on('click', () => {
                const cancelledPunct = cancelAiRequest(state, 'punctuation', 'Cancelled.', false);
                const cancelledCatalog = cancelAiRequest(state, 'cataloging', 'Cancelled.', false);
                if (cancelledPunct) updateAiPanelStatus($panel, 'Cancelled.', 'warning');
                if (cancelledCatalog) updateAiCatalogingStatus($panel, 'Cancelled.', 'warning');
            });
            $panel.find('#aacr2-ai-panel-run').on('click', async function() {
                const $button = $(this);
                const selection = updateAiPanelSelection($panel, settings, state);
                const element = selection.element;
                const features = {
                    punctuation_explain: settings.aiPunctuationExplain && $panel.find('#aacr2-ai-opt-punctuation').is(':checked'),
                    subject_guidance: false,
                    call_number_guidance: false
                };
                $button.prop('disabled', true);
                try {
                    await requestAiAssist(settings, state, {
                        element,
                        features,
                        onStatus: (message, type) => updateAiPanelStatus($panel, message, type)
                    });
                } finally {
                    $button.prop('disabled', false);
                }
            });
            $panel.find('#aacr2-ai-run-cataloging').on('click', async function() {
                const $button = $(this);
                const features = {
                    punctuation_explain: false,
                    subject_guidance: settings.aiSubjectGuidance && $panel.find('#aacr2-ai-opt-subjects').is(':checked'),
                    call_number_guidance: settings.aiCallNumberGuidance && $panel.find('#aacr2-ai-opt-classification').is(':checked')
                };
                $button.prop('disabled', true);
                try {
                    await requestAiCatalogingAssist(settings, state, {
                        features,
                        onStatus: (message, type) => updateAiCatalogingStatus($panel, message, type)
                    });
                } finally {
                    $button.prop('disabled', false);
                }
            });
            $panel.find('#aacr2-ai-panel-preview').on('click', function() {
                const selection = updateAiPanelSelection($panel, settings, state);
                const meta = selection.meta;
                if (!meta) {
                    toast('warning', 'Select a MARC field before previewing AI payload.');
                    return;
                }
                const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
                if (!fieldContext) {
                    toast('warning', 'Unable to read field context for preview.');
                    return;
                }
                const recordContext = buildAiRecordContext(meta, settings, state);
                const features = {
                    punctuation_explain: settings.aiPunctuationExplain && $panel.find('#aacr2-ai-opt-punctuation').is(':checked'),
                    subject_guidance: false,
                    call_number_guidance: false
                };
                const orderedContext = prioritizeSubfield(fieldContext, meta.code);
                const tagContext = {
                    ...orderedContext,
                    occurrence: normalizeOccurrence(fieldContext.occurrence),
                    active_subfield: meta.code
                };
                const payload = {
                    request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    tag_context: redactTagContext(tagContext, settings, state),
                    features
                };
                if (recordContext && recordContext.fields && recordContext.fields.length) {
                    payload.record_context = redactRecordContext(recordContext, settings, state);
                }
                showAiPreviewModal(payload);
            });
            $panel.find('#aacr2-ai-cataloging-preview').on('click', function() {
                const titleInfo = getTitleWithSubtitle();
                if (!titleInfo.title) {
                    toast('warning', '245$a is required before previewing AI cataloging payload.');
                    return;
                }
                const fieldContext = buildFieldContext('245', titleInfo.occurrence || '');
                if (!fieldContext) {
                    toast('warning', 'Unable to read 245 context for preview.');
                    return;
                }
                const tagContext = buildCatalogingTagContext(fieldContext);
                if (!tagContext) {
                    toast('warning', 'Unable to build 245 title source for preview.');
                    return;
                }
                const features = {
                    punctuation_explain: false,
                    subject_guidance: settings.aiSubjectGuidance && $panel.find('#aacr2-ai-opt-subjects').is(':checked'),
                    call_number_guidance: settings.aiCallNumberGuidance && $panel.find('#aacr2-ai-opt-classification').is(':checked')
                };
                const payload = {
                    request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    tag_context: redactTagContext(tagContext, settings, state),
                    features
                };
                showAiPreviewModal(payload);
            });
            $panel.find('#aacr2-ai-classification-input').on('input', function() {
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-opt-classification, #aacr2-ai-opt-subjects').on('change', function() {
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-apply-callnumber').on('click', function() {
                const info = updateAiCatalogingContext($panel, settings, state);
                const inputValue = $panel.find('#aacr2-ai-classification-input').val() || '';
                const suggestionValue = state && state.aiSuggestions ? state.aiSuggestions.classification || '' : '';
                const rangeMessage = classificationRangeMessage(inputValue) || classificationRangeMessage(suggestionValue);
                if (rangeMessage) {
                    toast('error', rangeMessage);
                    return;
                }
                if (!info.callNumber) {
                    toast('warning', 'Enter a classification number to build a call number.');
                    return;
                }
                const target = findCallNumberTarget();
                if (!target || !target.$field || !target.$field.length) {
                    toast('warning', 'No call number field (050$a/090$a) found on this form.');
                    return;
                }
                target.$field.val(info.callNumber);
                target.$field.trigger('change');
                const hasCutter = !!info.cutter;
                const message = hasCutter
                    ? `Call number applied to ${target.tag}$${target.code}: ${info.callNumber}.`
                    : `Call number applied to ${target.tag}$${target.code}: ${info.callNumber}. Cutter-Sanborn match not found; review the cutter.`;
                toast(hasCutter ? 'info' : 'warning', message);
            });
            $panel.find('#aacr2-ai-apply-subjects').on('click', function() {
                applyAiSubjects(settings, state);
            });
            $panel.find('#aacr2-ai-apply-selected').on('click', () => {
                applySelectedAiPatches(state);
            });
            $panel.find('#aacr2-ai-apply-all').on('click', () => {
                applyAllAiPatches(state);
            });
        }
        $panel.find('#aacr2-ai-opt-punctuation')
            .prop('checked', !!settings.aiPunctuationExplain)
            .prop('disabled', !settings.aiPunctuationExplain);
        $panel.find('#aacr2-ai-opt-classification')
            .prop('checked', !!settings.aiCallNumberGuidance)
            .prop('disabled', !settings.aiCallNumberGuidance);
        $panel.find('#aacr2-ai-opt-subjects')
            .prop('checked', !!settings.aiSubjectGuidance)
            .prop('disabled', !settings.aiSubjectGuidance);
        updateAiPanelSelection($panel, settings, state);
        updateAiCatalogingContext($panel, settings, state);
        applyStoredAiStatus($panel, state);
        updateAiCancelButtonState(state);
        $panel.show();
        if (state) state.aiPanelOpen = true;
        updateAiToggleButton();
    }

    function showAiPreviewModal(payload) {
        $('.aacr2-ai-preview-modal, .aacr2-guide-backdrop').remove();
        const json = JSON.stringify(payload, null, 2);
        const modal = $(`
            <div class="aacr2-guide-backdrop"></div>
            <div class="aacr2-ai-preview-modal">
                <h4 style="margin-top:0;">AI Payload Preview</h4>
                <p class="meta">This is the redacted JSON that will be sent to the AI provider.</p>
                <pre>${escapeAttr(json)}</pre>
                <div style="text-align: right;">
                    <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-preview-close">Close</button>
                </div>
            </div>
        `);
        $('body').append(modal);
        $('#aacr2-ai-preview-close').on('click', () => {
            $('.aacr2-ai-preview-modal, .aacr2-guide-backdrop').remove();
        });
    }

    async function requestAiAssist(settings, state, options) {
        const opts = options || {};
        const active = opts.element || resolveAiTargetElement(state);
        const meta = active ? parseFieldMeta(active) : null;
        const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        if (!meta) {
            const message = 'Select a MARC field before requesting rules and punctuation suggestions.';
            toast('warning', message);
            if (onStatus) onStatus(message, 'error');
            return;
        }
        if (isExcluded(settings, state, meta.tag, meta.code)) {
            const message = `AI assistance is disabled for excluded field ${meta.tag}$${meta.code}.`;
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        if (!fieldContext) {
            const message = 'Unable to read field context.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const orderedContext = prioritizeSubfield(fieldContext, meta.code);
        const tagContext = {
            ...orderedContext,
            occurrence: normalizeOccurrence(fieldContext.occurrence),
            active_subfield: meta.code
        };
        if (!global.AACR2RulesEngine.isFieldCovered(meta.tag, meta.code, fieldContext.ind1 || '', fieldContext.ind2 || '', state.rules)) {
            const message = 'No AACR2 rule defined for this field; AI assistance disabled.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const recordContext = buildAiRecordContext(meta, settings, state);
        const features = opts.features || {
            punctuation_explain: settings.aiPunctuationExplain,
            subject_guidance: settings.aiSubjectGuidance,
            call_number_guidance: settings.aiCallNumberGuidance
        };
        const payload = {
            request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tag_context: tagContext,
            features
        };
        if (recordContext && recordContext.fields && recordContext.fields.length) {
            payload.record_context = recordContext;
        }
        const requestId = startAiRequest(state, 'punctuation');
        const signal = getAiRequestSignal(state, 'punctuation', requestId);
        const setStatus = (message, type) => {
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            setAiRequestStatus(state, 'punctuation', message, type);
            if (onStatus) onStatus(message, type);
        };
        const startMessage = 'Running...';
        toast('info', startMessage);
        setStatus(startMessage, 'info');
        try {
            const result = await global.AACR2ApiClient.aiSuggest(settings.pluginPath, payload, { signal });
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            if (result.error) {
                toast('error', result.error);
                renderAiDebug($('#aacr2-ai-panel'), 'punctuation', result);
                setStatus(`Error: ${result.error}`, 'error');
                return;
            }
            notifyTruncation(result);
            renderAiPunctuationResults($('#aacr2-ai-panel'), settings, state, meta, result);
            renderAiDebug($('#aacr2-ai-panel'), 'punctuation', result);
            if (result.degraded_mode && result.extracted_call_number) {
                const message = `AI returned non-structured output; extracted LC candidate: ${result.extracted_call_number}.`;
                toast('warning', message);
                setStatus('Done', 'warning');
            } else {
                toast('info', 'Rules & punctuation suggestions ready.');
                setStatus('Done', 'success');
            }
        } catch (err) {
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            if (isAbortError(err)) {
                const message = 'Cancelled.';
                setStatus(message, 'warning');
                return;
            }
            const message = `AI suggestions unavailable: ${err.message}`;
            toast('error', message);
            setStatus(`Error: ${err.message}`, 'error');
        } finally {
            if (isLatestAiRequest(state, 'punctuation', requestId)) {
                finishAiRequest(state, 'punctuation', requestId);
            }
        }
    }

    async function requestAiCatalogingAssist(settings, state, options) {
        const opts = options || {};
        const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        const titleInfo = getTitleWithSubtitle();
        if (!titleInfo.title) {
            const message = '245$a is required for AI cataloging guidance.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        if (isExcluded(settings, state, '245', 'a')) {
            const message = 'AI cataloging guidance is disabled because 245$a is excluded.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const fieldContext = buildFieldContext('245', titleInfo.occurrence || '');
        if (!fieldContext) {
            const message = 'Unable to read 245 context.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const tagContext = buildCatalogingTagContext(fieldContext);
        if (!tagContext || !tagContext.subfields || !tagContext.subfields.length) {
            const message = '245$a is required for AI cataloging guidance.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const features = opts.features || {
            punctuation_explain: false,
            subject_guidance: settings.aiSubjectGuidance,
            call_number_guidance: settings.aiCallNumberGuidance
        };
        if (!features.subject_guidance && !features.call_number_guidance) {
            const message = 'Select at least one AI cataloging option.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const payload = {
            request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tag_context: tagContext,
            features
        };
        const requestId = startAiRequest(state, 'cataloging');
        const signal = getAiRequestSignal(state, 'cataloging', requestId);
        const setStatus = (message, type) => {
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            setAiRequestStatus(state, 'cataloging', message, type);
            if (onStatus) onStatus(message, type);
        };
        const startMessage = 'Running...';
        toast('info', startMessage);
        setStatus(startMessage, 'info');
        try {
            const result = await global.AACR2ApiClient.aiSuggest(settings.pluginPath, payload, { signal });
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            if (result.error) {
                toast('error', result.error);
                renderAiDebug($('#aacr2-ai-panel'), 'cataloging', result);
                setStatus(`Error: ${result.error}`, 'error');
                return;
            }
            notifyTruncation(result);
            const findings = Array.isArray(result.findings) ? result.findings : [];
            const assistantMessage = pickAiAssistantText(result, findings);
            const extracted = extractCatalogingSuggestionsFromText(assistantMessage || result.raw_text_excerpt || '');
            const resultSubjects = Array.isArray(result.subjects) ? result.subjects : [];
            const rawSubjects = resultSubjects.length
                ? resultSubjects
                : (extracted.subjects && extracted.subjects.length ? extracted.subjects : parseAiSubjects(findings));
            let classification = (result.classification || '').toString().trim()
                || extracted.classification
                || parseAiClassification(findings);
            if (!classification && result && result.extracted_call_number) {
                classification = result.extracted_call_number;
            }
            classification = normalizeClassificationSuggestion(classification || '');
            let subjects = normalizeSubjectObjects(rawSubjects || []);
            const errors = Array.isArray(result.errors) ? result.errors.slice() : [];
            const rangeMessage = classificationRangeMessage(classification || '');
            if (rangeMessage) {
                classification = '';
                if (!errors.find(err => err && err.code === 'CLASSIFICATION_RANGE')) {
                    errors.push({ code: 'CLASSIFICATION_RANGE', field: 'classification', message: rangeMessage });
                }
            }
            let confidence = null;
            if (typeof extracted.confidence_percent === 'number' && !Number.isNaN(extracted.confidence_percent)) {
                confidence = extracted.confidence_percent;
            } else if (result && typeof result.confidence_percent === 'number' && !Number.isNaN(result.confidence_percent)) {
                confidence = result.confidence_percent;
            } else {
                confidence = confidencePercentFromResult(result);
            }
            state.aiSuggestions = {
                classification,
                subjects,
                confidence,
                rawText: assistantMessage || result.raw_text_excerpt || '',
                errors
            };
            updateAiCatalogingContext($('#aacr2-ai-panel'), settings, state);
            renderAiDebug($('#aacr2-ai-panel'), 'cataloging', result);
            const message = (!classification && !subjects.length)
                ? 'AI returned no cataloging suggestions.'
                : 'Cataloging suggestions ready.';
            toast('info', message);
            if (result && result.degraded_mode && result.extracted_call_number && result.extraction_source !== 'plain_text') {
                const fallbackMessage = `AI returned non-structured output; extracted LC candidate: ${result.extracted_call_number}.`;
                toast('warning', fallbackMessage);
                setStatus('Done', 'warning');
            } else {
                setStatus('Done', classification || subjects.length ? 'success' : 'info');
            }
        } catch (err) {
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            if (isAbortError(err)) {
                const message = 'Cancelled.';
                setStatus(message, 'warning');
                return;
            }
            const message = `AI cataloging suggestions unavailable: ${err.message}`;
            toast('error', message);
            setStatus(`Error: ${err.message}`, 'error');
        } finally {
            if (isLatestAiRequest(state, 'cataloging', requestId)) {
                finishAiRequest(state, 'cataloging', requestId);
            }
        }
    }

    function extractCatalogingSuggestionsFromText(text) {
        const extractor = global.AACR2AiTextExtract;
        if (extractor && typeof extractor.extractCatalogingSuggestionsFromText === 'function') {
            return extractor.extractCatalogingSuggestionsFromText(text || '');
        }
        return { classification: '', subjects: [], confidence_percent: null };
    }

    function summarizeAiFindings(findings) {
        if (!Array.isArray(findings) || !findings.length) return '';
        return findings.map(finding => {
            const message = (finding.message || '').toString().trim();
            const rationale = (finding.rationale || '').toString().trim();
            if (message && rationale && rationale !== message) return `${message} - ${rationale}`;
            return message || rationale || '';
        }).filter(Boolean).join('\n');
    }

    function pickAiAssistantText(result, findings) {
        if (result && result.assistant_message) {
            const text = String(result.assistant_message).trim();
            if (text && !/^```/.test(text) && !/^[\\[{]/.test(text)) return text;
        }
        const summary = summarizeAiFindings(findings);
        if (summary) return summary;
        if (result && result.raw_text_excerpt) return String(result.raw_text_excerpt).trim();
        return '';
    }

    function normalizeSuggestionText(text) {
        return (text || '')
            .toString()
            .replace(/^\s*(subjects?|subject headings?|lcsh)\s*[:\-]\s*/i, '')
            .trim();
    }

    function normalizeClassificationSuggestion(text) {
        const cleaned = (text || '')
            .toString()
            .trim()
            .replace(/\s{2,}/g, ' ')
            .replace(/\s*\(fallback[^)]*\)\s*$/i, '')
            .replace(/[\s\.,;:]+$/g, '')
            .trim();
        return cleaned;
    }

    function classificationRangeMessage(value) {
        const text = (value || '').toString();
        if (!text.trim()) return '';
        const normalized = text.replace(/[\u2012\u2013\u2014\u2212]/g, '-');
        if (/\b[A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?\s*-\s*(?:[A-Z]{1,3}\s*)?\d{1,4}(?:\.\d+)?\b/i.test(normalized)) {
            return 'Classification ranges are not allowed. Provide a single class number.';
        }
        if (/\b\d{1,4}(?:\.\d+)?\s*-\s*\d{1,4}(?:\.\d+)?\b/.test(normalized)) {
            return 'Classification ranges are not allowed. Provide a single class number.';
        }
        return '';
    }

    function normalizeSubjectHeading(text) {
        let value = (text || '').toString().trim();
        if (!value) return '';
        value = value.replace(/\s*--\s*/g, ' -- ');
        value = value.replace(/\s{2,}/g, ' ');
        value = value.replace(/\s*--\s*$/g, '').trim();
        return value;
    }

    function dedupeCaseInsensitive(items) {
        const seen = new Set();
        return items.filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function parseAiClassification(findings) {
        if (!Array.isArray(findings)) return '';
        const direct = findings.find(f => (f.code || '').toUpperCase() === 'AI_CLASSIFICATION');
        let text = direct ? (direct.message || direct.rationale || '') : '';
        if (!text) {
            const fallback = findings.find(f =>
                /classification/i.test(f.message || '') ||
                /classification/i.test(f.rationale || '') ||
                /call number/i.test(f.message || '') ||
                /call number/i.test(f.rationale || '')
            );
            text = fallback ? (fallback.message || fallback.rationale || '') : '';
        }
        const cleaned = (text || '')
            .toString()
            .trim()
            .replace(/^\s*(classification|call number)\s*[:\-]\s*/i, '')
            .replace(/^\s*(classification|call number)\s+/i, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/[\s\.,;:]+$/g, '')
            .trim();
        return normalizeClassificationSuggestion(cleaned);
    }

    function parseAiSubjects(findings) {
        if (!Array.isArray(findings)) return [];
        const direct = findings.find(f => (f.code || '').toUpperCase() === 'AI_SUBJECTS');
        let text = direct ? (direct.message || direct.rationale || '') : '';
        if (!text) {
            const fallback = findings.find(f => /subjects?/i.test(f.message || '') || /subjects?/i.test(f.rationale || ''));
            text = fallback ? (fallback.message || fallback.rationale || '') : '';
        }
        const cleaned = normalizeSuggestionText(text);
        if (!cleaned) return [];
        const parts = cleaned.split(/[;\n|]+/);
        const expanded = [];
        parts.forEach(part => {
            const value = (part || '').toString().trim();
            if (!value) return;
            if (/--/.test(value)) {
                expanded.push(value);
                return;
            }
            const commaCount = (value.match(/,/g) || []).length;
            if (commaCount >= 2) {
                value.split(/\s*,\s*/).forEach(seg => {
                    const trimmed = (seg || '').trim();
                    if (trimmed) expanded.push(trimmed);
                });
                return;
            }
            if (commaCount === 1) {
                const pieces = value.split(/\s*,\s*/);
                if (pieces.length === 2 && !/\s/.test(pieces[0]) && !/\s/.test(pieces[1])) {
                    pieces.forEach(piece => {
                        const trimmed = (piece || '').trim();
                        if (trimmed) expanded.push(trimmed);
                    });
                    return;
                }
            }
            expanded.push(value);
        });
        const normalized = expanded
            .map(item => normalizeSubjectHeading(item))
            .filter(Boolean);
        return dedupeCaseInsensitive(normalized);
    }

    function normalizeSubjectObjects(subjects) {
        const extract = global.AACR2AiTextExtract;
        if (extract && typeof extract.subjectsFromHeadingList === 'function') {
            return extract.subjectsFromHeadingList(subjects || []);
        }
        if (!Array.isArray(subjects)) return [];
        return subjects.map(item => {
            if (item && typeof item === 'object') return item;
            const heading = normalizeSubjectHeading(item);
            if (!heading) return null;
            const parts = heading.split(/\s--\s/).map(part => part.trim()).filter(Boolean);
            if (!parts.length) return null;
            return {
                tag: '650',
                ind1: ' ',
                ind2: '0',
                subfields: {
                    a: parts[0],
                    x: parts.slice(1),
                    y: [],
                    z: [],
                    v: []
                }
            };
        }).filter(Boolean);
    }

    function renderAiSubjectList($panel, subjects) {
        const $list = $panel.find('#aacr2-ai-subjects');
        if (!$list.length) return;
        if (!Array.isArray(subjects) || !subjects.length) {
            $list.text('(none)');
            return;
        }
        const formatter = global.AACR2AiTextExtract && typeof global.AACR2AiTextExtract.formatSubjectDisplay === 'function'
            ? global.AACR2AiTextExtract.formatSubjectDisplay
            : null;
        const lines = subjects.map(item => {
            if (formatter) return formatter(item);
            if (typeof item === 'string') return item;
            const tag = item && item.tag ? item.tag : '650';
            const ind1 = item && item.ind1 !== undefined ? item.ind1 : ' ';
            const ind2 = item && item.ind2 !== undefined ? item.ind2 : '0';
            const sub = item && item.subfields ? item.subfields : {};
            const parts = [sub.a || ''];
            ['x', 'y', 'z', 'v'].forEach(code => {
                const values = Array.isArray(sub[code]) ? sub[code] : [];
                values.forEach(val => { if (val) parts.push(val); });
            });
            return `${tag}${ind1}${ind2} ${parts.join(' -- ')}`.trim();
        }).filter(Boolean);
        $list.text(lines.join('\n'));
    }

    function maybeShowAiGhost(element, findings, settings) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) return;
        const candidate = findings.find(f => f.confidence >= settings.aiConfidenceThreshold && f.severity !== 'ERROR');
        if (!candidate) return;
        const patch = candidate.proposed_fixes && candidate.proposed_fixes[0] && candidate.proposed_fixes[0].patch[0];
        if (!patch) return;
        const current = $(element).val() || '';
        const ghostText = computeGhostText(current, patch.replacement_text || '');
        if (!ghostText) return;
        const $ghost = $(`<span class="aacr2-ghost-text" title="Accept AI suggestion">${ghostText}</span>`);
        $ghost.data('expected', patch.replacement_text || '');
        $ghost.on('click', () => {
            $(element).val(patch.replacement_text || '');
            $ghost.remove();
            markFieldForRevalidation(state, parseFieldMeta(element));
            toast('info', 'AI ghost suggestion applied.');
        });
        $(element).after($ghost);
    }

    function isSameOccurrence(a, b) {
        if (b === undefined || b === null || b === '') return true;
        if (a === undefined || a === null || a === '') return false;
        return normalizeOccurrenceKey(a) === normalizeOccurrenceKey(b);
    }

    function findFieldElement(tag, code, occurrence) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return $();
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], select[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"], select[name^="field_${tag}${code}"]`;
        const $candidates = $(selector);
        if (occurrence === undefined || occurrence === null || occurrence === '') return $candidates.first();
        const match = $candidates.filter(function() {
            const meta = parseFieldMeta(this);
            return meta && meta.tag === tag && meta.code === code && isSameOccurrence(meta.occurrence, occurrence);
        }).first();
        return match.length ? match : $candidates.first();
    }

    function collectSubfieldElements(tag, code, occurrence) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return $();
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], select[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"], select[name^="field_${tag}${code}"]`;
        const matches = [];
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag || meta.code !== code) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            matches.push(this);
        });
        return $(matches);
    }

    function setIndicatorValue(tag, indicator, occurrence, value) {
        const selector = [
            `input[id^="tag_${tag}_indicator${indicator}"]`,
            `select[id^="tag_${tag}_indicator${indicator}"]`,
            `input[name^="tag_${tag}_indicator${indicator}"]`,
            `select[name^="tag_${tag}_indicator${indicator}"]`
        ].join(',');
        let updated = false;
        $(selector).each(function() {
            const meta = parseIndicatorMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            $(this).val(value);
            updated = true;
            return false;
        });
        return updated;
    }

    function guessAddFieldControl(tag) {
        const selector = [
            `[data-tag="${tag}"]`,
            `[data-marc-tag="${tag}"]`,
            `[data-field-tag="${tag}"]`,
            `a[onclick*="tag_${tag}"]`,
            `button[onclick*="tag_${tag}"]`,
            `a[onclick*="${tag}"]`,
            `button[onclick*="${tag}"]`
        ].join(',');
        const $candidates = $(selector).filter(function() {
            const text = ($(this).text() || '').toLowerCase();
            return !text || text.includes('add');
        });
        return $candidates.first();
    }

    function addFieldForTag(tag) {
        const $existing = findFieldElement(tag, 'a', '');
        const beforeCount = collectFieldOccurrences(tag).length;
        try {
            if (typeof window.AddField === 'function') {
                window.AddField(tag);
            } else if (typeof window.addField === 'function') {
                window.addField(tag);
            } else if (typeof window.CloneField === 'function' && $existing.length) {
                window.CloneField($existing.attr('id') || $existing.attr('name'));
            } else if (typeof window.cloneField === 'function' && $existing.length) {
                window.cloneField($existing.attr('id') || $existing.attr('name'));
            } else {
                const $control = guessAddFieldControl(tag);
                if ($control.length) $control.trigger('click');
            }
        } catch (err) {
            // ignore and fall through
        }
        const afterCount = collectFieldOccurrences(tag).length;
        return afterCount > beforeCount;
    }

    function collectFieldOccurrences(tag) {
        if (!isValidTag(tag)) return [];
        const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
        const occurrences = new Set();
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag) return;
            occurrences.add(normalizeOccurrenceKey(meta.occurrence));
        });
        return Array.from(occurrences);
    }

    function cloneSubfieldRow($base, tag, code, occurrence) {
        if (!$base || !$base.length) return $();
        const baseMeta = parseFieldMeta($base[0]);
        const baseCode = baseMeta ? baseMeta.code : code;
        const baseOcc = baseMeta ? baseMeta.occurrence : occurrence;
        const existing = collectSubfieldElements(tag, code, occurrence);
        const suffix = existing.length ? `_${existing.length}` : '';
        const newToken = `${normalizeOccurrenceKey(baseOcc)}${suffix}`;
        const $row = $base.closest('.subfield_line, .subfield, .field, li, div').first();
        const $clone = $row.clone();
        $clone.find('input, textarea, select, label').each(function() {
            const $el = $(this);
            const id = $el.attr('id');
            const name = $el.attr('name');
            if (id) {
                let nextId = id;
                nextId = nextId.replace(new RegExp(`tag_${tag}_subfield_${baseCode}(_\\d+(?:_\\d+)*)?`, 'i'), `tag_${tag}_subfield_${code}_${newToken}`);
                nextId = nextId.replace(new RegExp(`subfield${tag}${baseCode}`, 'i'), `subfield${tag}${code}`);
                if (nextId === id) {
                    nextId = `tag_${tag}_subfield_${code}_${newToken}`;
                }
                $el.attr('id', nextId);
            }
            if (name) {
                let nextName = name;
                nextName = nextName.replace(new RegExp(`tag_${tag}_subfield_${baseCode}(_\\d+(?:_\\d+)*)?`, 'i'), `tag_${tag}_subfield_${code}_${newToken}`);
                nextName = nextName.replace(new RegExp(`field_${tag}${baseCode}`, 'i'), `field_${tag}${code}`);
                if (nextName === name) {
                    nextName = `tag_${tag}_subfield_${code}_${newToken}`;
                }
                $el.attr('name', nextName);
            }
            if ($el.is('label')) {
                $el.text(`$${code}`);
            } else {
                $el.val('');
            }
        });
        $row.after($clone);
        return $clone.find('input, textarea, select').first();
    }

    function ensureSubfieldInput(tag, occurrence, code) {
        const existing = collectSubfieldElements(tag, code, occurrence);
        if (existing.length) return existing.last();
        const $base = findFieldElement(tag, 'a', occurrence);
        if (!$base.length) return $();
        const $added = cloneSubfieldRow($base, tag, code, occurrence);
        return $added.length ? $added : collectSubfieldElements(tag, code, occurrence).last();
    }

    function getFieldValue(tag, code) {
        const $field = findFieldElement(tag, code, '');
        if (!$field.length) return { value: '', element: null, occurrence: '' };
        const meta = parseFieldMeta($field[0]);
        return {
            value: ($field.val() || '').trim(),
            element: $field[0],
            occurrence: meta ? meta.occurrence : ''
        };
    }

    function buildTitleSourceFromParts(title, subtitle, responsibility) {
        const parts = [title, subtitle, responsibility]
            .map(value => (value || '').toString().trim())
            .filter(Boolean);
        return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
    }

    function getTitleWithSubtitle() {
        const titleInfo = getFieldValue('245', 'a');
        const subtitleInfo = getFieldValue('245', 'b');
        const responsibilityInfo = getFieldValue('245', 'c');
        const combined = buildTitleSourceFromParts(titleInfo.value, subtitleInfo.value, responsibilityInfo.value);
        return {
            value: combined,
            title: titleInfo.value,
            subtitle: subtitleInfo.value,
            responsibility: responsibilityInfo.value,
            occurrence: titleInfo.occurrence || subtitleInfo.occurrence || responsibilityInfo.occurrence || '',
            element: titleInfo.element || subtitleInfo.element || responsibilityInfo.element || null
        };
    }

    function filterCatalogingSubfields(subfields, options) {
        const opts = options || {};
        const maxSubfields = Number.isFinite(opts.maxSubfields) ? opts.maxSubfields : 20;
        const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 1200;
        const maxValueChars = Number.isFinite(opts.maxValueChars) ? opts.maxValueChars : 240;
        const requiredCodes = Array.isArray(opts.requiredCodes)
            ? opts.requiredCodes.map(code => String(code || '').toLowerCase()).filter(Boolean)
            : ['a', 'b', 'c'];
        const activeCode = String(opts.activeCode || '').toLowerCase();

        const cleaned = [];
        (subfields || []).forEach(sub => {
            if (!sub || typeof sub !== 'object') return;
            const code = String(sub.code || '').toLowerCase();
            if (!code) return;
            let value = (sub.value !== undefined && sub.value !== null) ? String(sub.value) : '';
            value = value.trim();
            if (!value) return;
            cleaned.push({ code, value });
        });
        if (!cleaned.length) return [];

        const normalizeValue = (value) => {
            if (!value) return '';
            if (maxValueChars && value.length > maxValueChars) {
                return value.slice(0, Math.max(0, maxValueChars - 3)) + '...';
            }
            return value;
        };

        const totalChars = cleaned.reduce((sum, sub) => sum + sub.value.length, 0);
        if ((!maxSubfields || cleaned.length <= maxSubfields) && (!maxChars || totalChars <= maxChars)) {
            return cleaned.map(sub => ({ code: sub.code, value: normalizeValue(sub.value) }));
        }

        let centerIndex = 0;
        if (activeCode) {
            const idx = cleaned.findIndex(sub => sub.code === activeCode);
            if (idx >= 0) centerIndex = idx;
        }

        const selected = new Set();
        cleaned.forEach((sub, idx) => {
            if ((activeCode && sub.code === activeCode) || requiredCodes.includes(sub.code)) {
                selected.add(idx);
            }
        });
        if (!selected.size) selected.add(centerIndex);

        let offset = 1;
        while (selected.size < maxSubfields && (centerIndex - offset >= 0 || centerIndex + offset < cleaned.length)) {
            const left = centerIndex - offset;
            if (left >= 0) selected.add(left);
            if (selected.size >= maxSubfields) break;
            const right = centerIndex + offset;
            if (right < cleaned.length) selected.add(right);
            offset += 1;
        }

        const indices = Array.from(selected).sort((a, b) => a - b).slice(0, maxSubfields);
        const result = [];
        let total = 0;
        indices.forEach(idx => {
            let value = normalizeValue(cleaned[idx].value);
            if (!value) return;
            if (maxChars && total + value.length > maxChars) {
                const remaining = maxChars - total;
                if (remaining <= 3) return;
                value = value.slice(0, Math.max(0, remaining - 3)) + '...';
            }
            total += value.length;
            result.push({ code: cleaned[idx].code, value });
        });
        return result;
    }

    function buildCatalogingTagContext(fieldContext) {
        if (!fieldContext) return null;
        const rawSubfields = Array.isArray(fieldContext.subfields) ? fieldContext.subfields : [];
        let activeCode = '';
        const firstA = rawSubfields.find(sub => sub && String(sub.code || '').toLowerCase() === 'a');
        if (firstA) {
            activeCode = 'a';
        } else if (rawSubfields.length) {
            activeCode = String(rawSubfields[0].code || '').toLowerCase();
        }
        const subfields = filterCatalogingSubfields(rawSubfields, { activeCode });
        const activeSubfield = activeCode || (subfields[0] ? subfields[0].code : '');
        return {
            tag: fieldContext.tag || '245',
            ind1: fieldContext.ind1 || '',
            ind2: fieldContext.ind2 || '',
            occurrence: normalizeOccurrence(fieldContext.occurrence),
            active_subfield: activeSubfield,
            subfields
        };
    }

    function getPreferredCutterSource() {
        const authorInfo = getFieldValue('100', 'a');
        if (authorInfo.value) {
            return { value: authorInfo.value, label: '100$a (author)', tag: '100' };
        }
        const titleInfo = getFieldValue('245', 'a');
        if (titleInfo.value) {
            return { value: titleInfo.value, label: '245$a (title)', tag: '245' };
        }
        return { value: '', label: 'Title', tag: '245' };
    }

    function extractKnownYear(value) {
        if (!value) return '';
        const raw = value.toString().trim();
        if (!raw) return '';
        const lower = raw.toLowerCase();
        if (/[?]/.test(lower)) return '';
        if (/n\.d\.|no date|unknown|undated/.test(lower)) return '';
        if (/\bca\.?\b|\bcirca\b|\bapprox\b|\bapprox\.\b/.test(lower)) return '';
        if (/\d{4}\s*[-/]\s*\d{4}/.test(lower)) return '';
        let cleaned = raw.replace(/[\[\]\(\)©]/g, '').trim();
        cleaned = cleaned.replace(/^(c|copyright)\s*/i, '');
        const matches = cleaned.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) || [];
        if (matches.length !== 1) return '';
        return matches[0];
    }

    function getPublicationYear() {
        const field264 = getFieldValue('264', 'c');
        const field260 = getFieldValue('260', 'c');
        const year = extractKnownYear(field264.value) || extractKnownYear(field260.value);
        return { value: year || '' };
    }

    function buildCutterSanborn(value, sourceTag) {
        if (global.AACR2CutterSanborn && typeof global.AACR2CutterSanborn.build === 'function') {
            return global.AACR2CutterSanborn.build(value, sourceTag);
        }
        return '';
    }

    function buildCallNumber(classification, cutter, year) {
        const parts = [];
        if (classification) parts.push(classification.trim());
        if (cutter) parts.push(cutter.trim());
        if (year) parts.push(year.trim());
        return parts.join(' ').trim();
    }

    function parseLcTarget(target) {
        const value = (target || '').toString().trim();
        let match = value.match(/^(\d{3})\s*\$\s*([a-z0-9])$/i);
        if (!match) match = value.match(/^(\d{3})([a-z0-9])$/i);
        if (!match) return null;
        return { tag: match[1], code: match[2].toLowerCase() };
    }

    function findCallNumberTarget() {
        const settings = global.AutoPunctuationSettings || {};
        const target = parseLcTarget(settings.lcClassTarget || '');
        const candidates = [];
        if (target) candidates.push(target);
        candidates.push(
            { tag: '050', code: 'a' },
            { tag: '090', code: 'a' },
            { tag: '099', code: 'a' }
        );
        for (const candidate of candidates) {
            const $field = findFieldElement(candidate.tag, candidate.code, '');
            if ($field.length) {
                return { ...candidate, $field };
            }
        }
        return null;
    }

    function clearSubjectFields(tags) {
        (tags || []).forEach(tag => {
            const occurrences = collectFieldOccurrences(tag);
            occurrences.forEach(occ => {
                const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
                $(selector).each(function() {
                    const meta = parseFieldMeta(this);
                    if (!meta || meta.tag !== tag) return;
                    if (!isSameOccurrence(meta.occurrence, occ)) return;
                    $(this).val('');
                });
            });
        });
    }

    function findEmptySubjectField(tag) {
        const $fields = collectSubfieldElements(tag, 'a', '');
        let $candidate = $();
        $fields.each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            const fieldContext = buildFieldContext(tag, meta.occurrence);
            if (!fieldContext) return;
            const hasValue = (fieldContext.subfields || []).some(sub => (sub.value || '').toString().trim());
            if (!hasValue) {
                $candidate = $(this);
                return false;
            }
        });
        return $candidate;
    }

    function applySubjectObject(subject, settings, state) {
        if (!subject || !subject.subfields || !subject.subfields.a) return false;
        const tag = subject.tag || '650';
        const ind1 = subject.ind1 !== undefined ? subject.ind1 : ' ';
        const ind2 = subject.ind2 !== undefined ? subject.ind2 : '0';
        let $fieldA = findEmptySubjectField(tag);
        if (!$fieldA.length) {
            addFieldForTag(tag);
            $fieldA = findEmptySubjectField(tag);
        }
        if (!$fieldA.length) return false;
        const meta = parseFieldMeta($fieldA[0]);
        if (!meta) return false;
        const occurrence = meta.occurrence;
        setIndicatorValue(tag, 1, occurrence, ind1);
        setIndicatorValue(tag, 2, occurrence, ind2);
        const setValueAtIndex = (code, value, index) => {
            let $targets = collectSubfieldElements(tag, code, occurrence);
            while ($targets.length <= index) {
                ensureSubfieldInput(tag, occurrence, code);
                $targets = collectSubfieldElements(tag, code, occurrence);
            }
            const $target = $targets.eq(index);
            if ($target.length) {
                $target.val(value);
                $target.trigger('change');
                markFieldForRevalidation(state, { tag, code, occurrence });
            }
        };
        setValueAtIndex('a', subject.subfields.a, 0);
        ['x', 'y', 'z', 'v'].forEach(code => {
            const values = Array.isArray(subject.subfields[code]) ? subject.subfields[code] : [];
            values.forEach((value, idx) => {
                if (value) setValueAtIndex(code, value, idx);
            });
        });
        return true;
    }

    function applyAiSubjects(settings, state) {
        const $panel = $('#aacr2-ai-panel');
        const subjects = state && state.aiSuggestions ? state.aiSuggestions.subjects || [] : [];
        if (!subjects.length) {
            toast('info', 'No subject headings to apply.');
            return;
        }
        if (state && state.readOnly) {
            toast('warning', 'Auto-apply disabled for training.');
            return;
        }
        const replace = $panel.find('#aacr2-ai-subjects-replace').is(':checked');
        if (replace) {
            if (!confirm('Replace existing subject fields for these tags? This cannot be undone.')) return;
            const tags = Array.from(new Set(subjects.map(sub => sub.tag || '650')));
            clearSubjectFields(tags);
        }
        let applied = 0;
        subjects.forEach(subject => {
            if (applySubjectObject(subject, settings, state)) applied += 1;
        });
        if (!applied) {
            toast('warning', 'Unable to apply subjects automatically. Add a subject field and try again.');
            return;
        }
        refreshAll(settings);
        toast('info', `Applied ${applied} subject heading${applied > 1 ? 's' : ''}.`);
    }

    function anyFieldHasValue(tag, code) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return false;
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], select[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"], select[name^="field_${tag}${code}"]`;
        let found = false;
        $(selector).each(function() {
            const value = $(this).val();
            if (value && value.trim()) {
                found = true;
                return false;
            }
        });
        return found;
    }

    function anyTagHasValue(tags, code) {
        return (tags || []).some(tag => anyFieldHasValue(tag, code));
    }

    function pickGuardrailTarget(tags, code) {
        for (const tag of tags || []) {
            const $field = findFieldElement(tag, code, '');
            if ($field.length) return { tag, subfield: code };
        }
        return null;
    }

    function focusField(tag, code, occurrence) {
        const $field = findFieldElement(tag, code, occurrence);
        if (!$field.length) {
            toast('warning', `Field ${tag}$${code} not found on form.`);
            return;
        }
        const tabId = findFieldTabId($field);
        if (tabId) {
            activateTab(tabId);
        }
        setTimeout(() => {
            $('html, body').animate({ scrollTop: $field.offset().top - 120 }, 200);
            $field.focus();
            $field.addClass('aacr2-focus-flash');
            setTimeout(() => $field.removeClass('aacr2-focus-flash'), 1200);
        }, tabId ? 160 : 0);
    }

    function findFieldTabId($field) {
        if (!$field || !$field.length) return '';
        const $pane = $field.closest('.tab-pane');
        if ($pane.length && $pane.attr('id')) return $pane.attr('id');
        const $panel = $field.closest('[id$="_panel"]');
        if ($panel.length && $panel.attr('id')) return $panel.attr('id');
        const $any = $field.closest('[id]');
        if ($any.length) {
            const id = $any.attr('id');
            const $tab = $(`a[href="#${id}"], a[data-bs-target="#${id}"], a[aria-controls="${id}"]`);
            if ($tab.length) return id;
        }
        return '';
    }

    function buildHelpText(finding) {
        const parts = [];
        if (finding.message) parts.push(finding.message);
        if (finding.rationale) parts.push(finding.rationale);
        if (finding.examples && finding.examples.length) {
            const ex = finding.examples[0];
            if (ex && ex.before !== undefined && ex.after !== undefined) {
                parts.push(`Example: ${ex.before} → ${ex.after}`);
            }
        }
        const conditionNote = buildConditionalSuffixNote(finding);
        if (conditionNote) parts.push(conditionNote);
        return parts.join('\n');
    }

    function escapeAttr(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    const regexWarnings = new Set();
    function safeRegexTest(pattern, value, label) {
        if (!pattern) return true;
        if (pattern.length > 120) {
            const message = `${label} regex is too long or complex; rule skipped.`;
            if (!regexWarnings.has(message)) {
                regexWarnings.add(message);
                toast('warning', message);
            }
            return false;
        }
        if (/\([^)]*(?:\+|\*|\{\d+,?\d*\})[^)]*\)(?:\+|\*|\?|\{\d+,?\d*\})/.test(pattern)
            || /\.\*(?:\+|\*)/.test(pattern)) {
            const message = `${label} regex is too complex; rule skipped.`;
            if (!regexWarnings.has(message)) {
                regexWarnings.add(message);
                toast('warning', message);
            }
            return false;
        }
        try {
            return new RegExp(pattern).test(value);
        } catch (err) {
            const message = `${label} regex is invalid; rule skipped.`;
            if (!regexWarnings.has(message)) {
                regexWarnings.add(message);
                toast('warning', message);
            }
            return false;
        }
    }

    function ruleMatchesForGuide(rule, tag, code) {
        if (rule.tag && rule.tag !== tag) return false;
        if (rule.tag_pattern && !safeRegexTest(rule.tag_pattern, tag, `Rule ${rule.id || 'unknown'} tag_pattern`)) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(x => x.toLowerCase()).includes(code.toLowerCase());
        }
        if (rule.subfield_pattern) {
            return safeRegexTest(rule.subfield_pattern, code, `Rule ${rule.id || 'unknown'} subfield_pattern`);
        }
        return true;
    }

    function filterGuideRules(rules) {
        if (rules.length <= 1) return rules;
        const filtered = rules.filter(rule => !rule.only_when_no_other_rule);
        return filtered.length ? filtered : rules;
    }

    function isMeaningfulExample(example) {
        if (!example) return false;
        const before = (example.before || '').toString();
        const after = (example.after || '').toString();
        if (!before.trim() || !after.trim()) return false;
        return before !== after;
    }

    function getRuleExample(rule) {
        if (!rule || !rule.examples || !rule.examples.length) return null;
        const example = rule.examples[0];
        return isMeaningfulExample(example) ? example : null;
    }

    function normalizeFrameworkFields(settings) {
        if (!settings) return [];
        if (Array.isArray(settings.frameworkFields)) return settings.frameworkFields;
        if (typeof settings.frameworkFields === 'string') {
            try {
                const parsed = JSON.parse(settings.frameworkFields);
                if (Array.isArray(parsed)) return parsed;
            } catch (err) {
                return [];
            }
        }
        return [];
    }

    function collectDomFieldGroups(settings, state) {
        const groups = new Map();
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], input[name^="field_"], textarea[name^="field_"]';
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            if (!isGuideSubfieldCode(meta.code)) return;
            if (isExcluded(settings, state, meta.tag, meta.code)) return;
            const key = `${meta.tag}${meta.code}`;
            if (!groups.has(key)) {
                groups.set(key, { tag: meta.tag, code: meta.code, entries: [] });
            }
            groups.get(key).entries.push({
                tag: meta.tag,
                code: meta.code,
                occurrence: meta.occurrence || '',
                element: $(this)
            });
        });
        return groups;
    }

    function guideStepSortKey(step) {
        const tag = (step.tag || '').trim();
        const code = (step.code || '').trim();
        const tagKey = tag ? tag : 'zzz';
        const codeKey = code ? code : 'zz';
        const titleKey = (step.title || '').toLowerCase();
        return `${tagKey}:${codeKey}:${titleKey}`;
    }

    function compareGuideSteps(a, b) {
        return guideStepSortKey(a).localeCompare(guideStepSortKey(b));
    }

    function prioritizeGuideSteps(steps, state) {
        if (!state) return steps;
        const missing = Array.isArray(state.missingRequired) ? state.missingRequired : [];
        return steps
            .map((step, index) => {
                const occurrenceKey = normalizeOccurrenceKey(step.occurrence);
                const key = `${step.tag}${step.code}:${occurrenceKey}`;
                const hasFinding = state.findings && state.findings.has(key);
                const isMissing = missing.includes(`${step.tag}${step.code}`);
                const priority = (hasFinding || isMissing) ? 0 : 1;
                return { step, index, priority, sortKey: guideStepSortKey(step) };
            })
            .sort((a, b) => (a.priority - b.priority) || a.sortKey.localeCompare(b.sortKey) || (a.index - b.index))
            .map(item => item.step);
    }

    function guideRuleScore(rule, tag, code, entries) {
        let score = 0;
        if (rule.tag && rule.tag === tag) score += 6;
        if (rule.tag_pattern) score += 2;
        if (rule.subfields && Array.isArray(rule.subfields) && rule.subfields.map(x => x.toLowerCase()).includes(code.toLowerCase())) score += 4;
        if (rule.subfield_pattern) score += 2;
        if (entries && entries.length) {
            const matchesExisting = entries.some(entry => {
                const fieldContext = buildFieldContext(tag, entry.occurrence || '');
                return fieldContext && ruleAppliesToField(rule, fieldContext, code);
            });
            if (matchesExisting) score += 5;
        }
        if (getRuleExample(rule)) score += 1;
        if (rule.rationale) score += 1;
        return score;
    }

    function selectBestGuideRule(rules, tag, code, entries) {
        if (!rules.length) return null;
        let best = rules[0];
        let bestScore = guideRuleScore(best, tag, code, entries);
        rules.slice(1).forEach(rule => {
            const score = guideRuleScore(rule, tag, code, entries);
            if (score > bestScore) {
                best = rule;
                bestScore = score;
                return;
            }
            if (score === bestScore) {
                const bestHasExample = !!getRuleExample(best);
                const ruleHasExample = !!getRuleExample(rule);
                if (ruleHasExample && !bestHasExample) {
                    best = rule;
                    bestScore = score;
                }
            }
        });
        return best;
    }

    function selectBestFieldEntry(entries, rule, tag, code) {
        if (!entries || !entries.length) return null;
        for (const entry of entries) {
            const fieldContext = buildFieldContext(tag, entry.occurrence || '');
            if (fieldContext && ruleAppliesToField(rule, fieldContext, code)) {
                return entry;
            }
        }
        return entries[0];
    }

    function buildDecisionGuideSteps(settings, state) {
        const rulesById = new Map((state.rules || []).map(rule => [rule.id, rule]));
        const steps = [
            {
                id: 'tg-245-a-tier1',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 1',
                title: '245 $a Title proper',
                tag: '245',
                code: 'a',
                ruleId: 'AACR2_TITLE_245A_001',
                text: 'Title proper punctuation and normalization.',
                tree: [
                    'If $b/$n/$p/$c follows, do not add a trailing period to $a.',
                    'If $a is last, add "." unless it already ends with . ? !',
                    'Replace ellipses in the title with a dash.',
                    'Replace literal [ ] in the title with ( ).'
                ],
                examples: [
                    { before: 'The great Gatsby', after: 'The great Gatsby.' },
                    { before: 'Who are you?', after: 'Who are you?' },
                    { before: 'When a line bends... a shape begins', after: 'When a line bends- a shape begins' },
                    { before: 'If I have to tell you [again]', after: 'If I have to tell you (again)' }
                ]
            },
            {
                id: 'tg-245-b-tier1',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 1',
                title: '245 $b Other title info / parallel title',
                tag: '245',
                code: 'b',
                ruleId: 'AACR2_TITLE_245B_001',
                text: 'Other title information and parallel titles.',
                tree: [
                    'Prefix other title info with " : ".',
                    'If $b begins with "=", use " = " instead.',
                    'If $c does not follow, end $b with ".".'
                ],
                examples: [
                    { before: 'a novel', after: ' : a novel.' },
                    { before: '= Le grand Gatsby', after: ' = Le grand Gatsby.' },
                    { before: ' : a novel', after: ' : a novel.' }
                ]
            },
            {
                id: 'tg-245-n-tier2',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 2',
                title: '245 $n Numbering',
                tag: '245',
                code: 'n',
                ruleId: 'AACR2_TITLE_245N_001',
                text: 'Numbering or part designation punctuation.',
                tree: [
                    'Prefix numbering with ". " when it follows $a or $b.',
                    'If $p follows, end $n with ", " to link the part title.',
                    'Avoid double commas if $n already ends with a comma.'
                ],
                examples: [
                    { before: 'Part 1', after: '. Part 1,' },
                    { before: 'Part 1,', after: '. Part 1,' }
                ]
            },
            {
                id: 'tg-245-p-tier2',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 2',
                title: '245 $p Part title',
                tag: '245',
                code: 'p',
                ruleId: 'AACR2_TITLE_245P_001',
                text: 'Part title punctuation depends on whether $n is present.',
                tree: [
                    'If $n precedes, prefix $p with ", ".',
                    'If no $n, prefix $p with ". ".',
                    'End with "." only if $b or $c does not follow.'
                ],
                examples: [
                    { before: 'The early years', after: ', The early years.' },
                    { before: '. The early years', after: '. The early years.' }
                ]
            },
            {
                id: 'tg-245-c-tier1',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 1',
                title: '245 $c Statement of responsibility',
                tag: '245',
                code: 'c',
                ruleId: 'AACR2_TITLE_245C_001',
                text: 'Statement of responsibility punctuation.',
                tree: [
                    'First statement: prefix with " / ".',
                    'Additional statements: prefix with " ; ".',
                    'End the final statement with ".".'
                ],
                examples: [
                    { before: 'F. Scott Fitzgerald', after: ' / F. Scott Fitzgerald.' },
                    { before: 'edited by John Smith', after: ' ; edited by John Smith.' }
                ]
            },
            {
                id: 'tg-dependent-punctuation-tier2',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 2',
                title: 'Re-check dependent punctuation',
                tag: '',
                code: '',
                text: 'When subfields are added or removed, revisit punctuation in earlier subfields.',
                tree: [
                    'If $b/$c/$n/$p is added after 245 $a, remove terminal punctuation from $a.',
                    'If $b/$c/$n/$p is removed, add terminal punctuation back to $a.',
                    'Apply the same dependency checks for 260/264 $a/$b, 300 $a/$b, 490 $a/$v, and 6xx subdivisions.'
                ],
                examples: [
                    { before: '245 $a The great Gatsby.', after: '245 $a The great Gatsby $b : a novel.' },
                    { before: '300 $a xii, 180 p. $c 23 cm.', after: '300 $a xii, 180 p ; $c 23 cm.' }
                ]
            },
            {
                id: 'tg-245-or-tier3',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 3',
                title: 'Alternative title with "or"',
                tag: '',
                code: '',
                text: 'Alternative titles use commas around "or".',
                tree: [
                    'Precede and follow the word "or" with commas.',
                    'Capitalize the first word after "or".',
                    'Use judgment: this applies only when "or" introduces an alternate title.'
                ],
                examples: [
                    { before: 'The Newcastle rider or Ducks and pease', after: 'The Newcastle rider, or, Ducks and pease' },
                    { before: 'How to keep well or The preservation of health', after: 'How to keep well, or, The preservation of health' }
                ]
            },
            {
                id: 'tg-260-a-tier1',
                module: 'Publication (260/264)',
                tier: 'Tier 1',
                title: '260/264 $a Place of publication',
                tag: '260',
                code: 'a',
                ruleId: 'AACR2_PUBLICATION_260A_001',
                alternateTags: ['264'],
                text: 'Place of publication punctuation.',
                tree: [
                    'If $b or $c follows, end $a with " : ".',
                    'If $a is last, end with ".".',
                    'Use [S.l.] for unknown place.'
                ],
                examples: [
                    { before: 'London', after: 'London :' },
                    { before: '[S.l.]', after: '[S.l.] :' }
                ]
            },
            {
                id: 'tg-260-b-tier1',
                module: 'Publication (260/264)',
                tier: 'Tier 1',
                title: '260/264 $b Publisher',
                tag: '260',
                code: 'b',
                ruleId: 'AACR2_PUBLICATION_260B_001',
                alternateTags: ['264'],
                text: 'Publisher punctuation.',
                tree: [
                    'If $c follows, end $b with ", ".',
                    'If $b is last, end with ".".',
                    'Use [s.n.] for unknown publisher.'
                ],
                examples: [
                    { before: 'Scribner', after: 'Scribner,' },
                    { before: '[s.n.]', after: '[s.n.],' }
                ]
            },
            {
                id: 'tg-260-c-tier1',
                module: 'Publication (260/264)',
                tier: 'Tier 1',
                title: '260/264 $c Date of publication',
                tag: '260',
                code: 'c',
                ruleId: 'AACR2_PUBLICATION_260C_001',
                alternateTags: ['264'],
                text: 'Publication date punctuation.',
                tree: [
                    'End the date with "." even when bracketed.',
                    'Use [19--] or [ca. 19--] for unknown dates.'
                ],
                examples: [
                    { before: '1925', after: '1925.' },
                    { before: '[19--]', after: '[19--].' },
                    { before: '[ca. 19--]', after: '[ca. 19--].' }
                ]
            },
            {
                id: 'tg-260-unknown-tier2',
                module: 'Publication (260/264)',
                tier: 'Tier 2',
                title: 'Unknown place/publisher/date',
                tag: '',
                code: '',
                text: 'Use bracketed placeholders when data is missing.',
                tree: [
                    'Unknown place: use "[S.l.]".',
                    'Unknown publisher: use "[s.n.]".',
                    'Unknown date: use "[19--]" or "ca. 19--".'
                ],
                examples: [
                    { before: 'S.l. : s.n.', after: '[S.l.] : [s.n.], [19--].' },
                    { before: 'n.p., n.d.', after: '[S.l.] : [s.n.], [19--].' }
                ]
            },
            {
                id: 'tg-300-a-tier1',
                module: 'Physical Description (300)',
                tier: 'Tier 1',
                title: '300 $a Extent',
                tag: '300',
                code: 'a',
                ruleId: 'AACR2_PHYSICAL_300A_001',
                text: 'Extent punctuation.',
                tree: [
                    'If $b follows, end $a with " : ".',
                    'If no $b but $c follows, end $a with " ; ".',
                    'If $a is last, end with ".".'
                ],
                examples: [
                    { before: 'xii, 180 p', after: 'xii, 180 p.' },
                    { before: 'xii, 180 p', after: 'xii, 180 p :' },
                    { before: 'xii, 180 p', after: 'xii, 180 p ;' }
                ]
            },
            {
                id: 'tg-300-b-tier1',
                module: 'Physical Description (300)',
                tier: 'Tier 1',
                title: '300 $b Other physical details',
                tag: '300',
                code: 'b',
                ruleId: 'AACR2_PHYSICAL_300B_001',
                text: 'Other physical details punctuation.',
                tree: [
                    'Prefix with " : " after $a.',
                    'If $c follows, end with " ; ".',
                    'If $b is last, end with ".".'
                ],
                examples: [
                    { before: 'ill', after: ' : ill.' },
                    { before: 'maps', after: ' : maps ;' },
                    { before: 'charts', after: ' : charts.' }
                ]
            },
            {
                id: 'tg-300-c-tier1',
                module: 'Physical Description (300)',
                tier: 'Tier 1',
                title: '300 $c Dimensions',
                tag: '300',
                code: 'c',
                ruleId: 'AACR2_PHYSICAL_300C_001',
                text: 'Dimensions punctuation.',
                tree: [
                    'End dimensions with ".".'
                ],
                examples: [
                    { before: '23 cm', after: '23 cm.' },
                    { before: '28 cm', after: '28 cm.' }
                ]
            },
            {
                id: 'tg-300-full-tier2',
                module: 'Physical Description (300)',
                tier: 'Tier 2',
                title: '300 full string check',
                tag: '300',
                code: 'a',
                ruleId: 'AACR2_PHYSICAL_300A_001',
                text: 'Check the full extent + details + dimensions string.',
                tree: [
                    'Order is: extent : other details ; dimensions.',
                    'Keep spacing around ":" and ";".',
                    'End the final subfield with a period.'
                ],
                examples: [
                    { before: 'xii, 180 p : ill ; 23 cm', after: 'xii, 180 p : ill. ; 23 cm.' }
                ]
            },
            {
                id: 'tg-250-a-tier1',
                module: 'Edition (250)',
                tier: 'Tier 1',
                title: '250 $a Edition statement',
                tag: '250',
                code: 'a',
                ruleId: 'AACR2_EDITION_250A_001',
                text: 'Edition statements end with ".".',
                tree: [
                    'Add a terminal period if none is present.'
                ],
                examples: [
                    { before: '2nd ed', after: '2nd ed.' }
                ]
            },
            {
                id: 'tg-490-a-tier2',
                module: 'Series (440/490/8xx)',
                tier: 'Tier 2',
                title: '490 $a Series statement',
                tag: '490',
                code: 'a',
                ruleId: 'AACR2_SERIES_490A_001',
                text: 'Series punctuation with numbering.',
                tree: [
                    'If $v follows, end $a with " ; ".',
                    'If last, end with ".".'
                ],
                examples: [
                    { before: 'Cambridge studies', after: 'Cambridge studies ;' }
                ]
            },
            {
                id: 'tg-6xx-tier2',
                module: 'Subjects (6xx)',
                tier: 'Tier 2',
                title: '6xx subdivisions',
                tag: '650',
                code: 'a',
                ruleId: 'AACR2_SUBJECT_MAIN_001',
                text: 'Subject headings use double dashes before subdivisions.',
                tree: [
                    'If $v/$x/$y/$z follows, end $a with " -- ".',
                    'Subdivisions themselves are prefixed with " -- ".'
                ],
                examples: [
                    { before: 'Women', after: 'Women -- ' },
                    { before: 'Women -- History', after: 'Women -- History.' }
                ]
            },
            {
                id: 'tg-100-a-tier1',
                module: 'Main Entry Names (1xx)',
                tier: 'Tier 1',
                title: '100 $a Personal name heading',
                tag: '100',
                code: 'a',
                ruleId: 'AACR2_PERSONAL_NAME_A_001',
                text: 'Personal name access points typically end with a period when final.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'Fitzgerald, F. Scott', after: 'Fitzgerald, F. Scott.' }
                ]
            },
            {
                id: 'tg-110-a-tier1',
                module: 'Main Entry Names (1xx)',
                tier: 'Tier 1',
                title: '110 $a Corporate name heading',
                tag: '110',
                code: 'a',
                ruleId: 'AACR2_CORP_NAME_A_001',
                text: 'Corporate body access points end with a period when final.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'International Council of Museums', after: 'International Council of Museums.' }
                ]
            },
            {
                id: 'tg-111-a-tier1',
                module: 'Main Entry Names (1xx)',
                tier: 'Tier 1',
                title: '111 $a Meeting name heading',
                tag: '111',
                code: 'a',
                ruleId: 'AACR2_MEETING_NAME_A_001',
                text: 'Meeting name access points end with a period when final.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'Symposium on Cataloging', after: 'Symposium on Cataloging.' }
                ]
            },
            {
                id: 'tg-700-a-tier2',
                module: 'Added Entries (7xx)',
                tier: 'Tier 2',
                title: '700 $a Added personal name',
                tag: '700',
                code: 'a',
                ruleId: 'AACR2_PERSONAL_NAME_A_001',
                text: 'Added personal name access points follow the same punctuation as main entries.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'Achebe, Chinua', after: 'Achebe, Chinua.' }
                ]
            },
            {
                id: 'tg-710-a-tier2',
                module: 'Added Entries (7xx)',
                tier: 'Tier 2',
                title: '710 $a Added corporate name',
                tag: '710',
                code: 'a',
                ruleId: 'AACR2_CORP_NAME_A_001',
                text: 'Added corporate access points follow the same punctuation as main entries.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'United Nations', after: 'United Nations.' }
                ]
            },
            {
                id: 'tg-711-a-tier2',
                module: 'Added Entries (7xx)',
                tier: 'Tier 2',
                title: '711 $a Added meeting name',
                tag: '711',
                code: 'a',
                ruleId: 'AACR2_MEETING_NAME_A_001',
                text: 'Added meeting access points follow the same punctuation as main entries.',
                tree: [
                    'Apply title-style capitalization.',
                    'Add a terminal period if $a is the final subfield.'
                ],
                examples: [
                    { before: 'Annual Conference on Metadata', after: 'Annual Conference on Metadata.' }
                ]
            },
            {
                id: 'tg-notes-tier2',
                module: 'Notes (5xx)',
                tier: 'Tier 2',
                title: '5xx notes',
                tag: '500',
                code: 'a',
                ruleId: 'AACR2_NOTES_5XXA_001',
                text: 'Notes usually end with ".".',
                tree: [
                    'Add terminal period to note statements.'
                ],
                examples: [
                    { before: 'Includes bibliographical references', after: 'Includes bibliographical references.' }
                ]
            },
            {
                id: 'tg-judgment-tier3',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 3',
                title: 'Integrated title vs. responsibility',
                tag: '',
                code: '',
                text: 'Decide when names are part of the title proper.',
                tree: [
                    'If the name is integral to the title as found, keep it in $a.',
                    'If it is clearly a responsibility statement, move to $c.'
                ],
                examples: [
                    { before: 'Jane Fonda\'s workout book', after: 'Keep as title proper in $a.' },
                    { before: 'Gypsy politics / edited by Thomas Acton', after: 'Move names to $c.' }
                ]
            }
        ];

        return steps.map(step => {
            const rule = step.ruleId ? rulesById.get(step.ruleId) : null;
            const example = (step.examples && step.examples[0]) || { before: '', after: '' };
            return {
                key: step.id,
                title: step.title,
                tag: step.tag || '',
                code: step.code || '',
                occurrence: '',
                module: step.module || '',
                tier: step.tier || '',
                alternateTags: step.alternateTags || [],
                ruleId: step.ruleId || (rule ? rule.id : ''),
                rule,
                text: step.text || '',
                tree: step.tree || [],
                examples: step.examples || [],
                example_raw: example.before || '',
                example_expected: example.after || ''
            };
        });
    }

    function buildGuideStepSets(settings, state) {
        const primary = buildDecisionGuideSteps(settings, state);
        const secondary = [];
        primary.forEach(step => {
            if (step.tag && step.code) {
                const $field = findFieldElement(step.tag, step.code, step.occurrence || '');
                step.hasField = $field.length > 0;
                step.tab = step.hasField ? (findFieldTabId($field) || '') : '';
            } else {
                step.hasField = false;
                step.tab = '';
            }
        });
        return {
            primary: prioritizeGuideSteps(primary, state),
            secondary: prioritizeGuideSteps(secondary, state)
        };
    }

    function indicatorMatch(value, ruleValue) {
        if (ruleValue === undefined || ruleValue === null || ruleValue === '') return true;
        if (ruleValue === '*') return true;
        if (Array.isArray(ruleValue)) return ruleValue.includes(value);
        return ruleValue === value;
    }

    function ruleAppliesToField(rule, field, subfieldCode) {
        if (!rule || !field) return false;
        if (rule.tag && rule.tag !== field.tag) return false;
        if (rule.tag_pattern && !safeRegexTest(rule.tag_pattern, field.tag, `Rule ${rule.id || 'unknown'} tag_pattern`)) return false;
        if (!indicatorMatch(field.ind1 || '', rule.ind1)) return false;
        if (!indicatorMatch(field.ind2 || '', rule.ind2)) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(code => code.toLowerCase()).includes((subfieldCode || '').toLowerCase());
        }
        if (rule.subfield_pattern) {
            return safeRegexTest(rule.subfield_pattern, subfieldCode || '', `Rule ${rule.id || 'unknown'} subfield_pattern`);
        }
        return true;
    }

    function getGuideProgressKey() {
        return 'aacr2GuideProgress';
    }

    function loadGuideProgress(steps) {
        const key = getGuideProgressKey();
        const signature = steps.map(step => step.key).join('|');
        let progress = { completed: {}, skipped: {}, currentIndex: 0, signature };
        try {
            const stored = sessionStorage.getItem(key);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.completed) {
                    steps.forEach(step => {
                        if (parsed.completed[step.key]) {
                            progress.completed[step.key] = true;
                        }
                        if (parsed.skipped && parsed.skipped[step.key]) {
                            progress.skipped[step.key] = true;
                        }
                    });
                    if (parsed.signature === signature) {
                        progress.currentIndex = parsed.currentIndex || 0;
                    }
                }
            }
        } catch (err) {
            progress = { completed: {}, skipped: {}, currentIndex: 0, signature };
        }
        return progress;
    }

    function computeExpectedForRule(step, fieldContext, settings) {
        if (!fieldContext) return '';
        const result = global.AACR2RulesEngine.validateField(fieldContext, settings, [step.rule]);
        const relevant = result.findings.find(f => f.subfield === step.code && f.code === step.ruleId);
        if (relevant && relevant.expected_value) return relevant.expected_value;
        if (ruleAppliesToField(step.rule, fieldContext, step.code)) {
            const current = (fieldContext.subfields || []).find(sub => sub.code === step.code);
            return current && current.value ? current.value : '';
        }
        return '';
    }

    function computeGuideExample(step, $field, settings) {
        const stepExample = (step.examples && step.examples[0]) ? step.examples[0] : null;
        const ruleExample = getRuleExample(step.rule);
        let raw = '';
        let expected = '';
        if ($field && $field.length) {
            const meta = parseFieldMeta($field[0]);
            if (meta) {
                const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
                if (fieldContext) {
                    const current = fieldContext.subfields.find(sub => sub.code === meta.code);
                    if (current && current.value) raw = current.value;
                    expected = computeExpectedForRule(step, fieldContext, settings);
                }
            }
        }
        if ((!expected || expected === raw) && stepExample) {
            raw = stepExample.before || raw;
            expected = stepExample.after || expected;
        } else if ((!expected || expected === raw) && ruleExample) {
            raw = ruleExample.before || raw;
            expected = ruleExample.after || expected;
        }
        if (!raw) raw = step.example_raw || '';
        if (!expected) expected = step.example_expected || '';
        if (!expected && raw) {
            const synthetic = {
                tag: step.tag,
                ind1: '',
                ind2: '',
                occurrence: '',
                subfields: [{ code: step.code, value: raw }]
            };
            expected = computeExpectedForRule(step, synthetic, settings);
        }
        if (!expected && raw) expected = raw;
        return { raw, expected };
    }

    function guideModuleForTag(tag) {
        if (!tag) return 'Other';
        if (['245', '246', '130', '240', '730'].includes(tag)) return 'Title & Statement (245/246)';
        if (tag === '250') return 'Edition (250)';
        if (tag === '260' || tag === '264') return 'Publication (260/264)';
        if (tag === '300') return 'Physical Description (300)';
        if (['440', '490', '800', '810', '811', '830'].includes(tag)) return 'Series (440/490/8xx)';
        if (/^(76|77|78)\d$/.test(tag)) return 'Linking Entries (76x-78x)';
        if (/^5\d\d$/.test(tag)) return 'Notes (5xx)';
        if (/^6\d\d$/.test(tag)) return 'Subjects (6xx)';
        if (/^7\d\d$/.test(tag)) return 'Added Entries (7xx)';
        if (/^1\d\d$/.test(tag)) return 'Main Entry Names (1xx)';
        if (/^0\d\d$/.test(tag)) return 'Identifiers (0xx)';
        return 'Other';
    }

    function guideModuleOrder() {
        return [
            'Title & Statement (245/246)',
            'Edition (250)',
            'Publication (260/264)',
            'Physical Description (300)',
            'Series (440/490/8xx)',
            'Notes (5xx)',
            'Subjects (6xx)',
            'Added Entries (7xx)',
            'Linking Entries (76x-78x)',
            'Main Entry Names (1xx)',
            'Identifiers (0xx)',
            'Other'
        ];
    }

    function buildGuideModules(steps) {
        const moduleMap = new Map();
        steps.forEach(step => {
            const module = step.module || guideModuleForTag(step.tag);
            step.module = module;
            if (!moduleMap.has(module)) moduleMap.set(module, []);
            moduleMap.get(module).push(step);
        });
        moduleMap.forEach(list => {
            list.sort(compareGuideSteps);
        });
        const order = guideModuleOrder();
        const modules = Array.from(moduleMap.keys()).sort((a, b) => {
            const ai = order.indexOf(a);
            const bi = order.indexOf(b);
            if (ai === -1 && bi === -1) return a.localeCompare(b);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
        return { modules, moduleMap };
    }

    function firstIncompleteIndex(steps, progress) {
        for (let i = 0; i < steps.length; i++) {
            if (!progress.completed[steps[i].key] && !(progress.skipped && progress.skipped[steps[i].key])) return i;
        }
        return Math.max(steps.length - 1, 0);
    }

    function saveGuideProgress(progress, settings, summary) {
        try {
            sessionStorage.setItem(getGuideProgressKey(), JSON.stringify(progress));
        } catch (err) {
            // ignore storage failures
        }
        sendGuideProgressUpdate(progress, settings, summary);
    }

    function sendGuideProgressUpdate(progress, settings, summary) {
        if (!settings || !settings.pluginPath) return;
        const completed = Object.keys(progress.completed || {});
        const skipped = Object.keys(progress.skipped || {});
        const summaryCounts = (() => {
            const completedCount = completed.length;
            const skippedCount = skipped.length;
            let total = completedCount + skippedCount;
            if (summary && typeof summary === 'object') {
                const explicitTotal = summary.steps_total || summary.total || summary.stepsTotal;
                if (Number.isFinite(explicitTotal)) total = explicitTotal;
            }
            return {
                completed_count: completedCount,
                skipped_count: skippedCount,
                total
            };
        })();
        const payload = {
            signature: progress.signature || '',
            completed,
            skipped,
            summary_counts: summaryCounts
        };
        const url = buildPluginUrl(settings, 'guide_progress_update');
        if (!url) return;
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfToken = csrfMeta ? (csrfMeta.getAttribute('content') || '') : '';
        payload.csrf_token = csrfToken;
        const params = new URLSearchParams();
        params.set('payload', JSON.stringify(payload));
        if (csrfToken) params.set('csrf_token', csrfToken);
        const body = params.toString();
        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: 'application/x-www-form-urlencoded; charset=UTF-8' });
            const sent = navigator.sendBeacon(url, blob);
            if (sent) return;
        }
        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json'
            },
            credentials: 'include',
            body
        })
            .then(async resp => {
                try {
                    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
                    const isJson = contentType.includes('application/json');
                    let data = null;
                    let bodyText = '';
                    if (isJson) {
                        try {
                            data = await resp.json();
                        } catch (err) {
                            try {
                                bodyText = await resp.text();
                            } catch (err2) {
                                bodyText = '';
                            }
                        }
                    } else {
                        try {
                            bodyText = await resp.text();
                        } catch (err) {
                            bodyText = '';
                        }
                    }

                    if (!isJson) {
                        const snippet = (bodyText || '').toString().slice(0, 300);
                        console.warn('[AACR2 Assistant] Guide progress update non-JSON response:', resp.status, snippet);
                    }

                    if (!resp.ok) {
                        let message = (resp.status === 401 || resp.status === 403)
                            ? 'Session expired. Please refresh and log in again.'
                            : '';
                        if (!message) {
                            message = (data && data.error) ? data.error : sanitizeServerMessage(bodyText);
                        }
                        reportProgressUpdateError(settings, resp.status, message || 'Request failed.', bodyText);
                        return null;
                    }

                    if (!data) {
                        reportProgressUpdateError(settings, resp.status, 'Non-JSON response from server.', bodyText);
                        return null;
                    }
                    if (data && data.error) {
                        reportProgressUpdateError(settings, resp.status, data.error, bodyText);
                    }
                    return data;
                } catch (err) {
                    reportProgressUpdateError(settings, resp.status || 0, err.message || 'Request failed.', '');
                    return null;
                }
            })
            .catch(err => {
                reportProgressUpdateError(settings, 0, err.message || 'Request failed.', '');
            });
    }

    function showGuide(settings) {
        const state = global.AACR2IntellisenseState;
        if (!state) return;
        try {
            state.guideActive = true;
            state.guideRefresh = null;
            state.guideCurrentStep = null;
            const stepSets = buildGuideStepSets(settings, state);
            const allSteps = stepSets.primary.concat(stepSets.secondary);
            const masterSignature = allSteps.map(step => step.key).join('|');
            let steps = stepSets.primary;
            let remainingSteps = stepSets.secondary;
            if (!steps.length && remainingSteps.length) {
                steps = remainingSteps;
                remainingSteps = [];
            }
            if (!steps.length) {
                state.guideActive = false;
                state.guideRefresh = null;
                state.guideCurrentStep = null;
                toast('warning', 'No AACR2 rules found for this framework.');
                return;
            }
            const moduleData = buildGuideModules(allSteps);
            let activeModule = 'All';
            let stepIndex = 0;
            const progress = loadGuideProgress(allSteps);
            progress.signature = masterSignature;
            stepIndex = firstIncompleteIndex(steps, progress);
            $('.aacr2-guide-modal').remove();
            const modal = $(`
                <div class="aacr2-guide-modal">
                    <header>
                        <span>AACR2 Training Guide</span>
                        <div>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-reset">Reset</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-minimize">Minimize</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-close">Close</button>
                        </div>
                    </header>
                    <div class="aacr2-guide-content">
                        <div id="aacr2-guide-progress" class="aacr2-guide-progress"></div>
                        <div class="aacr2-guide-module">
                            <label for="aacr2-guide-module">Module:</label>
                            <select id="aacr2-guide-module" class="form-control input-sm"></select>
                        </div>
                        <div id="aacr2-guide-module-status" class="aacr2-guide-progress"></div>
                        <div id="aacr2-guide-overall-status" class="aacr2-guide-progress"></div>
                        <div id="aacr2-guide-body"></div>
                        <div id="aacr2-guide-status" class="aacr2-guide-status" style="margin-top: 8px; font-size: 12px;"></div>
                        <div class="aacr2-guide-steps" id="aacr2-guide-steps"></div>
                        <div style="margin-top: 12px; text-align: right;">
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-example">Insert Input</button>
                            <button type="button" class="btn btn-xs btn-info" id="aacr2-guide-check">Check Step</button>
                            <button type="button" class="btn btn-xs btn-warning" id="aacr2-guide-skip">Skip</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-prev">Prev</button>
                            <button type="button" class="btn btn-xs btn-primary" id="aacr2-guide-next">Next</button>
                        </div>
                    </div>
                </div>
            `);
            $('body').append(modal);
            makeGuideDraggable();
            const $moduleSelect = $('#aacr2-guide-module');
            $moduleSelect.empty();
            $moduleSelect.append('<option value="All">All areas</option>');
            moduleData.modules.forEach(module => {
                $moduleSelect.append(`<option value="${escapeAttr(module)}">${module}</option>`);
            });
            $moduleSelect.val(activeModule);

        function getGuideField(step) {
            if (!step.tag || !step.code) return $();
            let $field = findFieldElement(step.tag, step.code, step.occurrence);
            step.activeTag = step.tag;
            if (!$field.length && Array.isArray(step.alternateTags)) {
                step.alternateTags.some(tag => {
                    const candidate = findFieldElement(tag, step.code, step.occurrence);
                    if (candidate.length) {
                        $field = candidate;
                        step.activeTag = tag;
                        return true;
                    }
                    return false;
                });
            }
            return $field;
        }

        function setActiveModule(moduleName) {
            if (!moduleName || moduleName === 'All') {
                activeModule = 'All';
                steps = stepSets.primary;
                remainingSteps = stepSets.secondary;
                if (!steps.length && remainingSteps.length) {
                    steps = remainingSteps;
                    remainingSteps = [];
                }
            } else {
                activeModule = moduleName;
                steps = moduleData.moduleMap.get(moduleName) || [];
                remainingSteps = [];
            }
            if (!steps.length) {
                toast('warning', 'No guide steps available for this module.');
                return;
            }
            stepIndex = firstIncompleteIndex(steps, progress);
            updateGuide();
        }

        function stepDone(step) {
            return !!(progress.completed[step.key] || progress.skipped[step.key]);
        }

        function stepSkipped(step) {
            return !!progress.skipped[step.key];
        }

        function countSteps(list) {
            const stats = { total: list.length, completed: 0, skipped: 0 };
            list.forEach(step => {
                if (progress.completed[step.key]) stats.completed++;
                if (progress.skipped[step.key]) stats.skipped++;
            });
            return stats;
        }

        function moduleCompletionSummary() {
            const modulesTotal = moduleData.modules.length;
            let modulesComplete = 0;
            moduleData.modules.forEach(module => {
                const list = moduleData.moduleMap.get(module) || [];
                const stats = countSteps(list);
                if (stats.total === 0 || (stats.completed + stats.skipped) >= stats.total) {
                    modulesComplete++;
                }
            });
            return { modulesTotal, modulesComplete };
        }

        function nextIncompleteModule() {
            if (activeModule === 'All') return '';
            const modules = moduleData.modules || [];
            if (!modules.length) return '';
            const startIndex = modules.indexOf(activeModule);
            const ordered = startIndex >= 0
                ? modules.slice(startIndex + 1).concat(modules.slice(0, startIndex + 1))
                : modules;
            for (const module of ordered) {
                if (module === activeModule) continue;
                const stats = countSteps(moduleData.moduleMap.get(module) || []);
                if (stats.total && (stats.completed + stats.skipped) < stats.total) return module;
            }
            return '';
        }

        function updateGuideStatus(message, type) {
            const $status = $('#aacr2-guide-status');
            $status.removeClass('success error info').addClass(type || 'info');
            $status.text(message || '');
        }

        function maxUnlockedIndex() {
            let idx = 0;
            while (idx < steps.length && stepDone(steps[idx])) {
                idx++;
            }
            return Math.min(idx, steps.length - 1);
        }

        function updateProgressUI() {
            const stats = countSteps(steps);
            const doneCount = stats.completed + stats.skipped;
            const percent = stats.total ? Math.round((doneCount / stats.total) * 100) : 0;
            $('#aacr2-guide-progress').html(
                `<div>${doneCount} of ${stats.total} steps complete (Skipped ${stats.skipped})</div>` +
                `<div class="aacr2-progress-bar"><span style="width:${percent}%"></span></div>`
            );
            const moduleLabel = activeModule === 'All' ? 'All areas' : activeModule;
            $('#aacr2-guide-module-status').text(`${moduleLabel}: ${doneCount}/${stats.total} steps complete (Skipped ${stats.skipped}).`);
            const moduleSummary = moduleCompletionSummary();
            const moduleText = `Modules complete: ${moduleSummary.modulesComplete}/${moduleSummary.modulesTotal}`;
            $('#aacr2-guide-overall-status').text(moduleText);
            updateModuleDropdown();
            if (moduleSummary.modulesTotal > 0 && moduleSummary.modulesComplete === moduleSummary.modulesTotal) {
                maybeShowGuideCompletionModal();
            }
        }

        function updateModuleDropdown() {
            $moduleSelect.find('option').each(function() {
                const value = $(this).attr('value');
                if (!value) return;
                let stats;
                if (value === 'All') {
                    stats = countSteps(allSteps);
                } else {
                    stats = countSteps(moduleData.moduleMap.get(value) || []);
                }
                const done = stats.completed + stats.skipped;
                const suffix = stats.total ? ` (${done}/${stats.total}, S${stats.skipped})` : ' (0/0)';
                const label = value === 'All' ? 'All areas' : value;
                $(this).text(`${label}${suffix}`);
            });
            $moduleSelect.val(activeModule);
        }

        function renderStepList() {
            const $list = $('#aacr2-guide-steps');
            $list.empty();
            steps.forEach((step, index) => {
                const completed = !!progress.completed[step.key];
                const skipped = !!progress.skipped[step.key];
                const label = completed ? '✓' : (skipped ? 'S' : (index === stepIndex ? '→' : '•'));
                const btnClass = completed ? 'btn-success' : (skipped ? 'btn-warning' : 'btn-default');
                const btn = $(`<button type="button" class="btn btn-xs ${btnClass}">${label} ${step.title}</button>`);
                btn.on('click', () => {
                    const limit = maxUnlockedIndex();
                    if (index > limit) {
                        toast('warning', 'Complete the current step before jumping ahead.');
                        return;
                    }
                    stepIndex = index;
                    updateGuide();
                });
                $list.append(btn);
            });
        }

        function updateGuide() {
            const step = steps[stepIndex];
            state.guideCurrentStep = step;
            state.guideRefresh = updateGuide;
            const $field = getGuideField(step);
            const hasField = $field.length > 0;
            const ind1Label = (step.rule && step.rule.ind1 !== undefined && step.rule.ind1 !== null && step.rule.ind1 !== '') ? step.rule.ind1 : '*';
            const ind2Label = (step.rule && step.rule.ind2 !== undefined && step.rule.ind2 !== null && step.rule.ind2 !== '') ? step.rule.ind2 : '*';
            const indicatorNote = (step.rule && (step.rule.ind1 !== undefined || step.rule.ind2 !== undefined))
                ? `<div class="meta">Applies when ind1=${ind1Label}, ind2=${ind2Label}.</div>`
                : '';
            const missingNote = (!step.tag || !step.code || hasField) ? '' : '<div class="meta">Field not on the form. Use Add field to insert it before checking.</div>';
            const example = computeGuideExample(step, $field, settings);
            step.example_current = example;
            const exampleRawValue = (example.raw || step.example_raw || '').replace(/\s+$/, '');
            const exampleExpectedValue = (example.expected || step.example_expected || '').replace(/\s+$/, '');
            const exampleRaw = exampleRawValue || '(no sample input provided)';
            const exampleExpected = exampleExpectedValue || '(no sample output provided)';
            const tierLabel = step.tier ? `<div class="meta"><strong>${step.tier}</strong></div>` : '';
            const treeHtml = (step.tree && step.tree.length)
                ? `<ul>${step.tree.map(item => `<li>${escapeAttr(item)}</li>`).join('')}</ul>`
                : '';
            const examplesHtml = (step.examples && step.examples.length)
                ? `<div><em>Examples:</em><ul>${step.examples.map(ex => `<li>${escapeAttr(ex.before || '')} → ${escapeAttr(ex.after || '')}</li>`).join('')}</ul></div>`
                : '';
            $('#aacr2-guide-body').html(
                `<strong>${step.title}</strong>${tierLabel}<p>${step.text}</p>` +
                treeHtml +
                `<div><em>Example input:</em> ${escapeAttr(exampleRaw)}</div>` +
                `<div><em>Expected AACR2:</em> ${escapeAttr(exampleExpected)}</div>` +
                examplesHtml +
                indicatorNote +
                missingNote
            );
            $('#aacr2-guide-prev').prop('disabled', stepIndex === 0);
            const canAdvance = stepDone(step);
            $('#aacr2-guide-next').prop('disabled', !canAdvance);
            const atLastStep = stepIndex === steps.length - 1;
            const hasMoreSteps = remainingSteps.length > 0;
            const moduleSummary = moduleCompletionSummary();
            const allModulesDone = moduleSummary.modulesTotal > 0 && moduleSummary.modulesComplete === moduleSummary.modulesTotal;
            let nextLabel = 'Next';
            if (atLastStep) {
                if (activeModule === 'All') {
                    nextLabel = hasMoreSteps ? 'Continue' : 'Finish';
                } else {
                    nextLabel = allModulesDone ? 'Finish' : 'Next module';
                }
            }
            $('#aacr2-guide-next').text(nextLabel);
            updateGuideStatus('', 'info');
            $('.aacr2-guide-highlight').removeClass('aacr2-guide-highlight');
            if ($field.length) {
                const tabId = findFieldTabId($field) || step.tab;
                if (tabId) {
                    activateTab(tabId);
                }
                $field.addClass('aacr2-guide-highlight');
                $field.focus();
            }
            const checkable = !!step.rule && hasField;
            const allowMark = !step.rule;
            $('#aacr2-guide-example').prop('disabled', !hasField);
            $('#aacr2-guide-check')
                .prop('disabled', !(checkable || allowMark))
                .text(step.rule ? 'Check Step' : 'Mark Complete');
            $('#aacr2-guide-skip').prop('disabled', stepDone(step));
            progress.currentIndex = stepIndex;
            saveGuideProgress(progress, settings, buildProgressSummary());
            updateProgressUI();
            renderStepList();
        }

        $('#aacr2-guide-example').on('click', () => {
            const step = steps[stepIndex];
            focusField(step.activeTag || step.tag, step.code, step.occurrence);
            setTimeout(() => {
                const $field = getGuideField(step);
                if ($field.length) {
                    const example = step.example_current || computeGuideExample(step, $field, settings);
                    const inputValue = example.raw || step.example_raw;
                    if (!inputValue) {
                        updateGuideStatus('No sample input available for this step.', 'error');
                        return;
                    }
                    $field.val(inputValue);
                    runFieldValidation($field[0], settings, state, { apply: false });
                    updateGuideStatus('Input inserted. Make the AACR2 corrections and then check.', 'info');
                }
            }, 220);
        });

        $('#aacr2-guide-check').on('click', () => {
            const step = steps[stepIndex];
            if (!step.rule) {
                progress.completed[step.key] = true;
                delete progress.skipped[step.key];
                updateGuideStatus('Marked complete for this guidance step.', 'success');
                saveGuideProgress(progress, settings, buildProgressSummary());
                updateGuide();
                return;
            }
            const $field = getGuideField(step);
            if (!$field.length) {
                updateGuideStatus('Field not found on the form. Add the field before checking.', 'error');
                return;
            }
            if (!($field.val() || '').trim()) {
                updateGuideStatus('Field is empty. Enter a value before checking.', 'error');
                return;
            }
            const meta = parseFieldMeta($field[0]);
            if (!meta) return;
            const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
            if (!fieldContext) return;
            const targetSub = fieldContext.subfields.find(sub => sub.code === meta.code);
            if (!targetSub) {
                updateGuideStatus('Target subfield not found. Insert a value before checking.', 'error');
                return;
            }
            if (!ruleAppliesToField(step.rule, fieldContext, meta.code)) {
                const ind1 = (step.rule && step.rule.ind1 !== undefined && step.rule.ind1 !== null && step.rule.ind1 !== '') ? step.rule.ind1 : '*';
                const ind2 = (step.rule && step.rule.ind2 !== undefined && step.rule.ind2 !== null && step.rule.ind2 !== '') ? step.rule.ind2 : '*';
                updateGuideStatus(`Indicators do not match this rule. Set ind1=${ind1}, ind2=${ind2} to continue.`, 'error');
                return;
            }
            const result = global.AACR2RulesEngine.validateField(fieldContext, settings, [step.rule]);
            const relevant = result.findings.filter(f => f.subfield === meta.code && f.code === step.ruleId);
            if (!relevant.length) {
                progress.completed[step.key] = true;
                delete progress.skipped[step.key];
                updateGuideStatus('Looks good. AACR2 punctuation satisfied for this step.', 'success');
                toast('info', `${step.title}: AACR2 punctuation looks good.`);
                saveGuideProgress(progress, settings, buildProgressSummary());
                updateGuide();
            } else {
                const example = computeGuideExample(step, $field, settings);
                const expected = (relevant[0].expected_value || example.expected || step.example_expected || '').replace(/\s+$/, '');
                const message = (relevant[0].message || '').replace(/\s+$/, '');
                const expectedText = expected ? ` Expected: ${expected}` : '';
                updateGuideStatus(`Needs attention: ${message}${expectedText}`, 'error');
                const expectedPreview = expected ? ` Expected: ${truncateToastText(expected, 120)}` : '';
                const messageSuffix = message ? (/[.!?]$/.test(message) ? '' : '.') : '';
                toast('warning', `Needs attention (${step.title}): ${message}${messageSuffix}${expectedPreview}`);
            }
        });

        $('#aacr2-guide-prev').on('click', () => {
            if (stepIndex > 0) {
                stepIndex--;
                updateGuide();
            }
        });
        $('#aacr2-guide-next').on('click', () => {
            if (!stepDone(steps[stepIndex])) {
                toast('warning', 'Check the current step before continuing.');
                return;
            }
            if (stepIndex < steps.length - 1) {
                stepIndex++;
                updateGuide();
            } else if (remainingSteps.length && activeModule === 'All') {
                const proceed = confirm('Continue with additional AACR2 training steps?');
                if (!proceed) {
                    closeGuide();
                    return;
                }
                steps = steps.concat(remainingSteps);
                remainingSteps = [];
                stepIndex = Math.min(stepIndex + 1, steps.length - 1);
                saveGuideProgress(progress, settings, buildProgressSummary());
                updateGuide();
            } else if (activeModule !== 'All') {
                const nextModule = nextIncompleteModule();
                if (nextModule) {
                    setActiveModule(nextModule);
                    return;
                }
                closeGuide();
            } else {
                closeGuide();
            }
        });
        $('#aacr2-guide-reset').on('click', () => {
            progress.completed = {};
            progress.skipped = {};
            progress.currentIndex = 0;
            saveGuideProgress(progress, settings, buildProgressSummary());
            stepIndex = 0;
            updateGuide();
        });
        $('#aacr2-guide-skip').on('click', () => {
            const step = steps[stepIndex];
            progress.skipped[step.key] = true;
            delete progress.completed[step.key];
            updateGuideStatus('Step skipped. You can continue.', 'info');
            saveGuideProgress(progress, settings, buildProgressSummary());
            updateGuide();
        });
        $moduleSelect.on('change', () => {
            const selection = $moduleSelect.val() || 'All';
            setActiveModule(selection);
        });
        $('#aacr2-guide-minimize').on('click', () => {
            const $modal = $('.aacr2-guide-modal');
            setGuideMinimized($modal, !$modal.hasClass('minimized'));
        });
        $('#aacr2-guide-close').on('click', () => closeGuide());

        function closeGuide() {
            state.guideActive = false;
            state.guideRefresh = null;
            state.guideCurrentStep = null;
            $(document).off('mousemove.aacr2guideDrag mouseup.aacr2guideDrag');
            $('.aacr2-guide-modal').remove();
            $('.aacr2-guide-highlight').removeClass('aacr2-guide-highlight');
        }

        function buildProgressSummary() {
            const overall = countSteps(allSteps);
            const moduleSummary = {};
            const tierSummary = {};
            moduleData.modules.forEach(module => {
                moduleSummary[module] = countSteps(moduleData.moduleMap.get(module) || []);
            });
            allSteps.forEach(step => {
                if (!step.tier) return;
                if (!tierSummary[step.tier]) {
                    tierSummary[step.tier] = { total: 0, completed: 0, skipped: 0 };
                }
                tierSummary[step.tier].total += 1;
                if (progress.completed[step.key]) tierSummary[step.tier].completed += 1;
                if (progress.skipped[step.key]) tierSummary[step.tier].skipped += 1;
            });
            const modules = moduleCompletionSummary();
            return {
                steps_total: overall.total,
                steps_completed: overall.completed,
                steps_skipped: overall.skipped,
                modules_total: modules.modulesTotal,
                modules_completed: modules.modulesComplete,
                module_breakdown: moduleSummary,
                tier_breakdown: tierSummary
            };
        }

        function maybeShowGuideCompletionModal() {
            const key = `aacr2GuideCongrats:${progress.signature || 'default'}`;
            if (sessionStorage.getItem(key)) return;
            sessionStorage.setItem(key, '1');
            const modal = $(`
                <div class="aacr2-guide-backdrop"></div>
                <div class="aacr2-about-modal">
                    <h4 style="margin-top:0;">Training Complete</h4>
                    <p>Great work! You have completed all available AACR2 training modules for this record.</p>
                    <div style="text-align: right;">
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-guide-congrats-close">Close</button>
                    </div>
                </div>
            `);
            $('body').append(modal);
            $('#aacr2-guide-congrats-close').on('click', () => {
                $('.aacr2-about-modal, .aacr2-guide-backdrop').remove();
            });
        }

            updateGuide();
        } catch (err) {
            state.guideActive = false;
            state.guideRefresh = null;
            state.guideCurrentStep = null;
            toast('error', 'Unable to open the training guide. See console for details.');
            console.error('[AACR2 Assistant] Guide error:', err);
        }
    }

    function showAboutModal(settings) {
        $('.aacr2-about-modal, .aacr2-guide-backdrop').remove();
        const modal = $(`
            <div class="aacr2-guide-backdrop"></div>
            <div class="aacr2-about-modal">
                <h4 style="margin-top:0;">About AACR2 Assistant</h4>
                <p>AACR2 rules and MARC21 punctuation guardrails with optional AI guidance. Deterministic rules first; AI suggestions require explicit review.</p>
                <p><strong>Author:</strong> Duke Chijimaka Jonathan, University of Port Harcourt, Nigeria</p>
                <p><strong>Email:</strong> djonathan002@uniport.edu.ng</p>
                <p><strong>LinkedIn:</strong> <a href="https://linkedin.com/in/duke-j-a1a9b0260" target="_blank" rel="noopener">linkedin.com/in/duke-j-a1a9b0260</a></p>
                <p><strong>Plugin GitHub:</strong> <a href="https://github.com/Dzechy/Koha_AACR2_Assistant_Plugin/" target="_blank" rel="noopener">github.com/Dzechy/Koha_AACR2_Assistant_Plugin</a></p>
                <p><strong>Acknowledgements:</strong></p>
                <ul class="aacr2-ack-list">
                    <li>Prof. Helen Uzoezi Emasealu (helen.emasealu@uniport.edu.ng)</li>
                    <li>Dr. Millie Nne Horsfall (millie.horsfall@uniport.edu.ng)</li>
                    <li>Mr. Stanislaus Richard Ezeonye (stanislaus.ezeonye@uniport.edu.ng)</li>
                </ul>
                <ul>
                    <li>Auto-apply toggle or suggestion-only mode</li>
                    <li>Inline indicators, ghost text, and quick fixes</li>
                    <li>Strict coverage warnings and framework report</li>
                    <li>Assistive AI with JSON-only responses</li>
                </ul>
                <p><strong>AI provider:</strong> ${settings.llmApiProvider || 'OpenRouter'}</p>
                <p><strong>Model:</strong> ${settings.aiModel || 'Not set'}</p>
                <div style="text-align: right;">
                    <button type="button" class="btn btn-xs btn-default" id="aacr2-about-close">Close</button>
                </div>
            </div>
        `);
        $('body').append(modal);
        $('#aacr2-about-close').on('click', () => {
            $('.aacr2-about-modal, .aacr2-guide-backdrop').remove();
        });
    }

    function activateTab(tabId) {
        const selector = `a[href="#${tabId}"], a[data-bs-target="#${tabId}"]`;
        const $tab = $(selector).first();
        if (!$tab.length) return;
        if (global.bootstrap && global.bootstrap.Tab) {
            new global.bootstrap.Tab($tab[0]).show();
            return;
        }
        if ($tab.tab) {
            $tab.tab('show');
            return;
        }
        $tab.trigger('click');
    }

    global.AACR2IntellisenseTestHooks = {
        buildTitleSourceFromParts,
        filterCatalogingSubfields,
        parseAiSubjects,
        parseAiClassification,
        buildPluginUrl
    };
    global.AACR2IntellisenseUI = { init: initUI };
})(window, window.jQuery);
