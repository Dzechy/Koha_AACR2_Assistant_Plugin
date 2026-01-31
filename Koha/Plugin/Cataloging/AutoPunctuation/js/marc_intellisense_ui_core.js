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
