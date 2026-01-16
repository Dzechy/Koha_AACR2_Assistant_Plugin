(function(global, $) {
    'use strict';

    function initUI(settings) {
        const state = {
            rules: [],
            findings: new Map(),
            aiFindings: [],
            missingRequired: [],
            requiredFields: parseList(settings.requiredFields),
            excludedTags: parseList(settings.excludedTags),
            localAllowlist: parseList(settings.localFieldsAllowlist),
            strictCoverage: settings.strictCoverageMode,
            autoApply: settings.autoApplyPunctuation,
            aiConfigured: settings.aiConfigured,
            aiConfidenceThreshold: settings.aiConfidenceThreshold || 0.85,
            undoStack: [],
            guideActive: false,
            ignoredFindings: new Set(),
            lastFocusedField: null
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
        let loggedInUser = '';
        const loggedInUserSpan = $('#logged-in-info-full [class*="loggedinusernam"]');
        if (loggedInUserSpan.length) {
            loggedInUser = loggedInUserSpan.text().trim();
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
            .aacr2-ai-panel { position: fixed; right: 24px; bottom: 24px; width: 380px; background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; z-index: 10002; display: flex; flex-direction: column; resize: both; overflow: auto; min-width: 300px; min-height: 200px; }
            .aacr2-ai-panel header { display: flex; justify-content: space-between; align-items: center; cursor: move; padding: 8px 10px; background: #1f2937; color: #fff; font-weight: 700; }
            .aacr2-ai-panel .body { padding: 10px 12px; font-size: 12px; }
            .aacr2-ai-panel .meta { color: #5b6b7c; font-size: 11px; margin-bottom: 4px; }
            .aacr2-ai-panel .options label { display: block; margin-top: 4px; font-weight: 400; }
            .aacr2-ai-panel .actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
            .aacr2-guide-modal { position: fixed; top: 120px; right: 24px; left: auto; transform: none; background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; padding: 14px; z-index: 10001; width: 420px; resize: both; overflow: auto; min-width: 320px; min-height: 220px; max-height: 80vh; }
            .aacr2-guide-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 10000; }
            .aacr2-guide-highlight { border: 2px solid #3b82f6 !important; box-shadow: 0 0 10px rgba(59,130,246,0.4) !important; }
            .aacr2-focus-flash { border: 2px solid #10b981 !important; box-shadow: 0 0 8px rgba(16,185,129,0.4) !important; }
            .aacr2-about-modal { position: fixed; top: 22%; left: 50%; transform: translateX(-50%); background: #ffffff; border: 1px solid #d1d9e0; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.2); border-radius: 6px; padding: 14px; z-index: 10001; width: 420px; }
            .aacr2-guide-modal.minimized .aacr2-guide-content { display: none; }
            .aacr2-guide-modal.minimized { min-height: 0; height: auto; resize: none; overflow: hidden; }
            .aacr2-guide-modal header { display: flex; justify-content: space-between; align-items: center; cursor: move; }
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
                <button type="button" class="btn btn-sm btn-warning" id="aacr2-ai-toggle" ${settings.aiConfigured ? '' : 'disabled'}>
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
                        <button type="button" class="btn btn-xs btn-default" id="aacr2-panel-close">Close</button>
                    </div>
                </header>
                <div class="body">
                    <div class="meta">AACR2 punctuation findings appear here. Click Apply to accept suggestions.</div>
                    <div id="aacr2-findings"></div>
                </div>
            </div>
        `;
        $('body').append(panel);
        $('#aacr2-panel-close').on('click', () => {
            $('.aacr2-panel').hide();
            updatePanelToggleButton();
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
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], input[name^="field_"], textarea[name^="field_"]';
        $(document).on('focusin.aacr2', selector, function() {
            state.lastFocusedField = this;
            const $aiPanel = $('#aacr2-ai-panel');
            if ($aiPanel.length && $aiPanel.is(':visible')) {
                updateAiPanelSelection($aiPanel, settings, state);
            }
        });
        $(document).on('blur.aacr2', selector, function() {
            runFieldValidation(this, settings, state, { apply: true });
        });
        $(document).on('change.aacr2', selector, function() {
            if (document.activeElement === this) return;
            runFieldValidation(this, settings, state, { apply: true });
        });

        $(document).on('input.aacr2', selector, function() {
            $(this).siblings('.aacr2-ghost-text').remove();
            if (settings.enableLiveValidation) {
                runFieldValidation(this, settings, state, { apply: false });
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
            toast('info', 'AACR2 ghost suggestion applied.');
        });
    }

    function runFieldValidation(element, settings, state, options) {
        if (!settings.enabled && !(settings.enforceAacr2Guardrails || settings.enableLiveValidation)) return;
        const opts = options || {};
        const meta = parseFieldMeta(element);
        if (!meta) return;
        if (isExcluded(settings, state, meta.tag, meta.code)) return;
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        if (!fieldContext) return;
        const result = global.AACR2RulesEngine.validateField(fieldContext, settings, state.rules);
        updateFindingsForField(state, meta, result.findings);
        if (opts.apply) {
            applyAutoFixes(settings, state, meta, result.findings);
        }
        updateIndicators(fieldContext, result.findings);
        updateSidePanel(state);
        updateGuardrails(settings, state);
        maybeShowGhost(element, result.findings, settings, state);
    }

    function bindFormHandlers(settings, state) {
        $('form[name="f"], #cat_addbiblio form').on('submit.aacr2', function(event) {
            const record = filterRecordContext(buildRecordContext(), settings, state);
            const result = global.AACR2RulesEngine.validateRecord(record, settings, state.rules, settings.strictCoverageMode);
            state.findings = groupFindings(result.findings);
            if (settings.enabled && state.autoApply && result.findings.length) {
                result.findings.forEach(finding => {
                    const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
                    if (patch) applyPatch(patch, finding.occurrence);
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
        const field = { tag, ind1: '', ind2: '', occurrence: occurrence || '', subfields: [] };
        field.ind1 = findIndicatorValue(tag, 1, occurrence) || '';
        field.ind2 = findIndicatorValue(tag, 2, occurrence) || '';
        const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"]`;
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            field.subfields.push({ code: meta.code, value: $(this).val() || '' });
        });
        if (!field.subfields.length) return null;
        return field;
    }

    function buildRecordContext() {
        const fields = {};
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], input[name^="field_"], textarea[name^="field_"]';
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            const key = `${meta.tag}:${meta.occurrence || '0'}`;
            if (!fields[key]) {
                fields[key] = { tag: meta.tag, ind1: '', ind2: '', occurrence: meta.occurrence || '', subfields: [] };
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

    function updateFindingsForField(state, meta, findings) {
        const occurrenceKey = meta.occurrence || '0';
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
            const key = `${finding.tag}${finding.subfield}:${finding.occurrence || '0'}`;
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
            finding.occurrence || '',
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
            applyPatch(patch, finding.occurrence);
        });
    }

    function applyPatch(patch, occurrence) {
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
        recordUndo(record, previous, patch.value);
        $field.val(patch.value);
        $field.trigger('change');
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
        if (state.missingRequired.length) {
            state.missingRequired.forEach(code => {
                total++;
                const item = $(`
                    <div class="finding warning">
                        <div><strong>${code}</strong> · WARNING</div>
                        <div class="meta">Required AACR2 field is missing.</div>
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default" data-tag="${code.slice(0, 3)}" data-sub="${code.slice(3)}">Go to field</button>
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
                const helpIcon = (finding.severity === 'ERROR' || finding.severity === 'WARNING')
                    ? `<span class="aacr2-help" title="${escapeAttr(helpText)}">?</span>`
                    : '';
                const preview = finding.expected_value ? `<div class="aacr2-preview">${finding.current_value} → ${finding.expected_value}</div>` : '';
                const item = $(`
                    <div class="finding ${severityClass}">
                        <div><strong>${finding.tag}$${finding.subfield}</strong> · ${finding.severity} ${helpIcon}</div>
                        <div class="meta">${finding.message}</div>
                        ${preview}
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default aacr2-go-field" data-tag="${finding.tag}" data-sub="${finding.subfield}" data-occ="${finding.occurrence || ''}">Go to field</button>
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
                        applyPatch(patch, finding.occurrence);
                        toast('info', `AACR2 punctuation applied to ${finding.tag}$${finding.subfield}.`);
                    }
                });
                item.find('.aacr2-ignore').on('click', () => {
                    ignoreFinding(state, finding);
                    updateSidePanel(state);
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
        const errorCount = countSeverity(state.findings, 'ERROR');
        const total = errorCount + missing.length;
        const status = total === 0 ? 'AACR2 guardrails satisfied' : `${total} issue(s) (${missing.length} required missing)`;
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
                patches.push({ patch, occurrence: finding.occurrence });
            });
        });
        if (!patches.length) {
            toast('info', 'No AACR2 suggestions to apply.');
            return;
        }
        patches.forEach(item => applyPatch(item.patch, item.occurrence));
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

    function updateAiPanelSelection($panel, settings, state) {
        if (!$panel || !$panel.length) return { element: null, meta: null };
        const element = resolveAiTargetElement(state);
        const meta = element ? parseFieldMeta(element) : null;
        if (!meta) {
            $panel.data('targetElement', null);
            $panel.data('targetMeta', null);
            $panel.find('#aacr2-ai-selected').text('None');
            $panel.find('#aacr2-ai-current').text('(no MARC field selected)');
            updateAiPanelStatus($panel, 'Select a MARC field to enable AI assist.', 'info');
            return { element: null, meta: null };
        }
        const label = `${meta.tag}$${meta.code}${meta.occurrence ? ` (${meta.occurrence})` : ''}`;
        $panel.data('targetElement', element);
        $panel.data('targetMeta', meta);
        $panel.find('#aacr2-ai-selected').text(label);
        $panel.find('#aacr2-ai-current').text($(element).val() || '(empty)');
        updateAiPanelStatus($panel, '', 'info');
        return { element, meta };
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
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-refresh">Refresh</button>
                            <button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-close">Close</button>
                        </div>
                    </header>
                    <div class="body">
                        <div class="meta">Selected field: <strong id="aacr2-ai-selected">None</strong></div>
                        <div class="meta">Current value:</div>
                        <div class="aacr2-preview" id="aacr2-ai-current"></div>
                        <div class="options">
                            <label><input type="checkbox" id="aacr2-ai-opt-punctuation"> Punctuation explanation</label>
                            <label><input type="checkbox" id="aacr2-ai-opt-subjects"> Subject guidance</label>
                            <label><input type="checkbox" id="aacr2-ai-opt-callnumber"> Call number guidance</label>
                        </div>
                        <div id="aacr2-ai-status" class="aacr2-guide-status info" style="margin-top: 8px;"></div>
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-info" id="aacr2-ai-panel-run">Run AI</button>
                        </div>
                    </div>
                </div>
            `);
            $('body').append($panel);
            makeAiPanelDraggable();
            $panel.find('#aacr2-ai-panel-close').on('click', () => {
                $panel.hide();
                if (state) state.aiPanelOpen = false;
            });
            $panel.find('#aacr2-ai-panel-refresh').on('click', () => {
                updateAiPanelSelection($panel, settings, state);
            });
            $panel.find('#aacr2-ai-panel-run').on('click', async function() {
                const $button = $(this);
                const selection = updateAiPanelSelection($panel, settings, state);
                const element = selection.element;
                const features = {
                    punctuation_explain: settings.aiPunctuationExplain && $panel.find('#aacr2-ai-opt-punctuation').is(':checked'),
                    subject_guidance: settings.aiSubjectGuidance && $panel.find('#aacr2-ai-opt-subjects').is(':checked'),
                    call_number_guidance: settings.aiCallNumberGuidance && $panel.find('#aacr2-ai-opt-callnumber').is(':checked')
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
        }
        $panel.find('#aacr2-ai-opt-punctuation')
            .prop('checked', !!settings.aiPunctuationExplain)
            .prop('disabled', !settings.aiPunctuationExplain);
        $panel.find('#aacr2-ai-opt-subjects')
            .prop('checked', !!settings.aiSubjectGuidance)
            .prop('disabled', !settings.aiSubjectGuidance);
        $panel.find('#aacr2-ai-opt-callnumber')
            .prop('checked', !!settings.aiCallNumberGuidance)
            .prop('disabled', !settings.aiCallNumberGuidance);
        updateAiPanelSelection($panel, settings, state);
        $panel.show();
        if (state) state.aiPanelOpen = true;
    }

    async function requestAiAssist(settings, state, options) {
        const opts = options || {};
        const active = opts.element || resolveAiTargetElement(state);
        const meta = active ? parseFieldMeta(active) : null;
        const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        if (!meta) {
            const message = 'Select a MARC field (place the cursor in it) before requesting AI guidance.';
            toast('warning', message);
            if (onStatus) onStatus(message, 'error');
            return;
        }
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        if (!fieldContext) {
            const message = 'Unable to read field context.';
            toast('warning', message);
            if (onStatus) onStatus(message, 'error');
            return;
        }
        if (!global.AACR2RulesEngine.isFieldCovered(meta.tag, meta.code, '', '', state.rules)) {
            const message = 'No AACR2 rule defined for this field; AI assistance disabled.';
            toast('warning', message);
            if (onStatus) onStatus(message, 'error');
            return;
        }
        const recordContext = filterRecordContext(buildRecordContext(), settings, state);
        const features = opts.features || {
            punctuation_explain: settings.aiPunctuationExplain,
            subject_guidance: settings.aiSubjectGuidance,
            call_number_guidance: settings.aiCallNumberGuidance
        };
        const payload = {
            request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tag_context: fieldContext,
            record_context: recordContext,
            features
        };
        const startMessage = 'Requesting AACR2 AI guidance...';
        toast('info', startMessage);
        if (onStatus) onStatus(startMessage, 'info');
        try {
            const result = await global.AACR2ApiClient.aiSuggest(settings.pluginPath, payload);
            if (result.error) {
                toast('error', result.error);
                if (onStatus) onStatus(result.error, 'error');
                return;
            }
            if (Array.isArray(result.findings)) {
                const enriched = result.findings.map(f => ({
                    ...f,
                    occurrence: meta.occurrence || '',
                    current_value: (f.tag === meta.tag && f.subfield === meta.code) ? $(active).val() : '',
                    expected_value: f.proposed_fixes && f.proposed_fixes[0] && f.proposed_fixes[0].patch[0] ? f.proposed_fixes[0].patch[0].value : ''
                }));
                const grouped = groupFindings(enriched);
                grouped.forEach((value, key) => {
                    const existing = state.findings.get(key) || [];
                    state.findings.set(key, dedupeFindings(existing.concat(value)));
                });
                updateSidePanel(state);
                toast('info', 'AI suggestions ready. Review before applying.');
                if (onStatus) onStatus('AI suggestions ready. Review before applying.', 'success');
                maybeShowAiGhost(active, result.findings, settings);
            }
        } catch (err) {
            const message = `AI suggestions unavailable: ${err.message}`;
            toast('error', message);
            if (onStatus) onStatus(message, 'error');
        }
    }

    function maybeShowAiGhost(element, findings, settings) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) return;
        const candidate = findings.find(f => f.confidence >= settings.aiConfidenceThreshold && f.severity !== 'ERROR');
        if (!candidate) return;
        const patch = candidate.proposed_fixes && candidate.proposed_fixes[0] && candidate.proposed_fixes[0].patch[0];
        if (!patch) return;
        const current = $(element).val() || '';
        const ghostText = computeGhostText(current, patch.value);
        if (!ghostText) return;
        const $ghost = $(`<span class="aacr2-ghost-text" title="Accept AI suggestion">${ghostText}</span>`);
        $ghost.data('expected', patch.value);
        $ghost.on('click', () => {
            $(element).val(patch.value);
            $ghost.remove();
            toast('info', 'AI ghost suggestion applied.');
        });
        $(element).after($ghost);
    }

    function isSameOccurrence(a, b) {
        if (!b) return true;
        if (!a) return false;
        return a === b;
    }

    function findFieldElement(tag, code, occurrence) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return $();
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"]`;
        const $candidates = $(selector);
        if (!occurrence) return $candidates.first();
        const match = $candidates.filter(function() {
            const meta = parseFieldMeta(this);
            return meta && meta.tag === tag && meta.code === code && meta.occurrence === occurrence;
        }).first();
        return match.length ? match : $candidates.first();
    }

    function anyFieldHasValue(tag, code) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return false;
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"]`;
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
        return parts.join('\n');
    }

    function escapeAttr(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function ruleMatchesForGuide(rule, tag, code) {
        if (rule.tag && rule.tag !== tag) return false;
        if (rule.tag_pattern && !(new RegExp(rule.tag_pattern).test(tag))) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(x => x.toLowerCase()).includes(code.toLowerCase());
        }
        if (rule.subfield_pattern) {
            return new RegExp(rule.subfield_pattern).test(code);
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

    function prioritizeGuideSteps(steps, state) {
        if (!state) return steps;
        const missing = Array.isArray(state.missingRequired) ? state.missingRequired : [];
        return steps
            .map((step, index) => {
                const occurrenceKey = step.occurrence || '0';
                const key = `${step.tag}${step.code}:${occurrenceKey}`;
                const hasFinding = state.findings && state.findings.has(key);
                const isMissing = missing.includes(`${step.tag}${step.code}`);
                const priority = (hasFinding || isMissing) ? 0 : 1;
                return { step, index, priority };
            })
            .sort((a, b) => (a.priority - b.priority) || (a.index - b.index))
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

    function buildGuideStepSets(settings, state) {
        const primary = [];
        const secondary = [];
        const seen = new Set();
        const frameworkFields = normalizeFrameworkFields(settings);
        const domGroups = collectDomFieldGroups(settings, state);
        const fieldGroups = domGroups.size
            ? domGroups
            : frameworkFields.reduce((groups, field) => {
                const tag = field.tag || field.tagfield || '';
                const code = field.subfield || field.tagsubfield || '';
                if (!tag || !code) return groups;
                if (!isValidTag(tag) || !isValidSubfieldCode(code) || !isGuideSubfieldCode(code)) return groups;
                const key = `${tag}${code}`;
                if (!groups.has(key)) {
                    groups.set(key, { tag, code, entries: [] });
                }
                groups.get(key).entries.push({ tag, code, occurrence: '', element: null });
                return groups;
            }, new Map());
        fieldGroups.forEach(group => {
            const tag = group.tag;
            const code = group.code;
            if (!tag || !code) return;
            if (!isValidTag(tag) || !isValidSubfieldCode(code) || !isGuideSubfieldCode(code)) return;
            if (isExcluded(settings, state, tag, code)) return;
            const matched = filterGuideRules(state.rules.filter(rule => ruleMatchesForGuide(rule, tag, code)));
            if (!matched.length) return;
            const applicable = group.entries.length ? matched.filter(rule => {
                return group.entries.some(entry => {
                    const fieldContext = buildFieldContext(tag, entry.occurrence || '');
                    return fieldContext && ruleAppliesToField(rule, fieldContext, code);
                });
            }) : [];
            const selectedRule = selectBestGuideRule(applicable.length ? applicable : matched, tag, code, group.entries);
            if (!selectedRule) return;
            const chosenEntry = selectBestFieldEntry(group.entries, selectedRule, tag, code);
            const occurrence = chosenEntry ? (chosenEntry.occurrence || '') : '';
            const $field = chosenEntry && chosenEntry.element ? chosenEntry.element : findFieldElement(tag, code, occurrence);
            const hasField = $field.length > 0;
            if (!hasField) return;
            const fieldContext = hasField ? buildFieldContext(tag, occurrence) : null;
            const key = `${tag}${code}:${selectedRule.id || 'AACR2_RULE'}`;
            const tabId = hasField ? findFieldTabId($field) : '';
            const example = getRuleExample(selectedRule) || { before: '', after: '' };
            const step = {
                key,
                title: `${tag}$${code}`,
                field: `${tag}${code}`,
                tag,
                code,
                occurrence,
                tab: tabId || '',
                hasField,
                ruleId: selectedRule.id || 'AACR2_RULE',
                rule: selectedRule,
                text: selectedRule.rationale || (selectedRule.checks && selectedRule.checks[0] && selectedRule.checks[0].message) || 'Apply AACR2 punctuation.',
                example_raw: example.before || '',
                example_expected: example.after || ''
            };
            if (!example.before && !example.after) {
                const expectedSample = fieldContext ? computeExpectedForRule(step, fieldContext, settings) : '';
                if (!expectedSample) return;
            }
            if (seen.has(key)) return;
            seen.add(key);
            const appliesNow = fieldContext ? ruleAppliesToField(selectedRule, fieldContext, code) : false;
            if (hasField && appliesNow) {
                primary.push(step);
            } else {
                secondary.push(step);
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
        if (rule.tag_pattern && !(new RegExp(rule.tag_pattern).test(field.tag))) return false;
        if (!indicatorMatch(field.ind1 || '', rule.ind1)) return false;
        if (!indicatorMatch(field.ind2 || '', rule.ind2)) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(code => code.toLowerCase()).includes((subfieldCode || '').toLowerCase());
        }
        if (rule.subfield_pattern) {
            return new RegExp(rule.subfield_pattern).test(subfieldCode || '');
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
        return relevant && relevant.expected_value ? relevant.expected_value : '';
    }

    function computeGuideExample(step, $field, settings) {
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
        if ((!expected || expected === raw) && ruleExample) {
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
            const module = guideModuleForTag(step.tag);
            step.module = module;
            if (!moduleMap.has(module)) moduleMap.set(module, []);
            moduleMap.get(module).push(step);
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
        const state = global.AACR2IntellisenseState;
        const userContext = (state && state.userContext) ? state.userContext : getUserContext(settings);
        const user = userContext && userContext.user ? userContext.user : '';
        const payload = {
            user,
            signature: progress.signature || '',
            completed: Object.keys(progress.completed || {}),
            skipped: Object.keys(progress.skipped || {}),
            summary: summary || {}
        };
        fetch(`${settings.pluginPath}&method=guide_progress_update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(() => {});
    }

    function showGuide(settings) {
        const state = global.AACR2IntellisenseState;
        if (!state) return;
        try {
            state.guideActive = true;
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
                        <strong>AACR2 Training Guide</strong>
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
            return findFieldElement(step.tag, step.code, step.occurrence);
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
                if (stats.total > 0 && (stats.completed + stats.skipped) >= stats.total) {
                    modulesComplete++;
                }
            });
            return { modulesTotal, modulesComplete };
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
            const $field = getGuideField(step);
            const hasField = $field.length > 0;
            const ind1Label = (step.rule && step.rule.ind1 !== undefined && step.rule.ind1 !== null && step.rule.ind1 !== '') ? step.rule.ind1 : '*';
            const ind2Label = (step.rule && step.rule.ind2 !== undefined && step.rule.ind2 !== null && step.rule.ind2 !== '') ? step.rule.ind2 : '*';
            const indicatorNote = (step.rule && (step.rule.ind1 !== undefined || step.rule.ind2 !== undefined))
                ? `<div class="meta">Applies when ind1=${ind1Label}, ind2=${ind2Label}.</div>`
                : '';
            const missingNote = hasField ? '' : '<div class="meta">Field not on the form. Use Add field to insert it before checking.</div>';
            const example = computeGuideExample(step, $field, settings);
            step.example_current = example;
            const exampleRawValue = (example.raw || step.example_raw || '').replace(/\s+$/, '');
            const exampleExpectedValue = (example.expected || step.example_expected || '').replace(/\s+$/, '');
            const exampleRaw = exampleRawValue || '(no sample input provided)';
            const exampleExpected = exampleExpectedValue || '(no sample output provided)';
            $('#aacr2-guide-body').html(
                `<strong>${step.title}</strong><p>${step.text}</p>` +
                `<div><em>Example input:</em> ${exampleRaw}</div>` +
                `<div><em>Expected AACR2:</em> ${exampleExpected}</div>` +
                indicatorNote +
                missingNote
            );
            $('#aacr2-guide-prev').prop('disabled', stepIndex === 0);
            const canAdvance = stepDone(step);
            $('#aacr2-guide-next').prop('disabled', !canAdvance);
            const atLastStep = stepIndex === steps.length - 1;
            const hasMoreSteps = remainingSteps.length > 0;
            const nextLabel = atLastStep ? (hasMoreSteps ? 'Continue' : 'Finish') : 'Next';
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
            $('#aacr2-guide-example').prop('disabled', !hasField);
            $('#aacr2-guide-check').prop('disabled', !hasField);
            $('#aacr2-guide-skip').prop('disabled', stepDone(step));
            progress.currentIndex = stepIndex;
            saveGuideProgress(progress, settings, buildProgressSummary());
            updateProgressUI();
            renderStepList();
        }

        $('#aacr2-guide-example').on('click', () => {
            const step = steps[stepIndex];
            focusField(step.tag, step.code, step.occurrence);
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
            $(document).off('mousemove.aacr2guideDrag mouseup.aacr2guideDrag');
            $('.aacr2-guide-modal').remove();
            $('.aacr2-guide-highlight').removeClass('aacr2-guide-highlight');
        }

        function buildProgressSummary() {
            const overall = countSteps(allSteps);
            const moduleSummary = {};
            moduleData.modules.forEach(module => {
                moduleSummary[module] = countSteps(moduleData.moduleMap.get(module) || []);
            });
            const modules = moduleCompletionSummary();
            return {
                steps_total: overall.total,
                steps_completed: overall.completed,
                steps_skipped: overall.skipped,
                modules_total: modules.modulesTotal,
                modules_completed: modules.modulesComplete,
                module_breakdown: moduleSummary
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
                <p>AACR2-only MARC21 punctuation and guardrails with optional AI guidance. Deterministic rules first; AI suggestions require explicit acceptance.</p>
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
                <p><strong>AI provider:</strong> ${settings.llmApiProvider || 'OpenAI'}</p>
                <p><strong>Model:</strong> ${settings.aiModel || 'default'}</p>
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

    global.AACR2IntellisenseUI = { init: initUI };
})(window, window.jQuery);
