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

    function isInternFeatureAllowed(state, key) {
        if (typeof internFeatureAllowed === 'function') {
            return internFeatureAllowed(state, key);
        }
        return true;
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
        if (applyRecordedChange(change, 'previous')) {
            if (!state.redoStack) state.redoStack = [];
            state.redoStack.push(change);
            refreshAll(global.AutoPunctuationSettings || {});
            toast('info', 'Last change undone.');
        }
    }

    function redoLastChange() {
        const state = global.AACR2IntellisenseState;
        if (!state || !state.redoStack || !state.redoStack.length) {
            toast('info', 'Nothing to redo.');
            return;
        }
        if (state.readOnly) {
            toast('warning', 'Redo is disabled in internship mode.');
            return;
        }
        const change = state.redoStack.pop();
        if (applyRecordedChange(change, 'next')) {
            state.undoStack.push(change);
            refreshAll(global.AutoPunctuationSettings || {});
            toast('info', 'Last change redone.');
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
        if (!state.redoStack) state.redoStack = [];
        while (state.undoStack.length) {
            const change = state.undoStack.pop();
            if (applyRecordedChange(change, 'previous')) {
                state.redoStack.push(change);
            }
        }
        refreshAll(global.AutoPunctuationSettings || {});
        toast('info', 'All changes undone.');
    }

    function applyRecordedChange(change, direction) {
        if (!change) return false;
        const value = direction === 'previous' ? change.previous : change.next;
        if ((change.kind || 'subfield') === 'indicator') {
            const indicator = Number(change.indicator || 0);
            if (!(indicator === 1 || indicator === 2)) return false;
            return setIndicatorValue(change.tag, indicator, change.occurrence, value || '');
        }
        const $field = findFieldElement(change.tag, change.code, change.occurrence);
        if (!$field.length) return false;
        $field.val(value || '');
        return true;
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
        const meta = parseFieldMeta(element);
        if (!meta) return;
        const occurrenceKey = normalizeOccurrenceKey(meta.occurrence);
        const relevant = (findings || []).filter(finding => {
            if (!finding || !finding.expected_value) return false;
            if ((finding.severity || '').toUpperCase() === 'ERROR') return false;
            if ((finding.tag || '') !== meta.tag) return false;
            if ((finding.subfield || '').toLowerCase() !== (meta.code || '').toLowerCase()) return false;
            return normalizeOccurrenceKey(finding.occurrence || '') === occurrenceKey;
        });
        const candidate = relevant.find(f => (f.severity || '').toUpperCase() === 'WARNING') || relevant[0];
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
        $status.removeClass('success error info warning').addClass(type || 'info');
        $status.text(message || '');
    }

    function updateAiCatalogingStatus($panel, message, type) {
        if (!$panel || !$panel.length) return;
        const $status = $panel.find('#aacr2-ai-cataloging-status');
        if (!$status.length) return;
        $status.removeClass('success error info warning').addClass(type || 'info');
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
            const canApply = isInternFeatureAllowed(state, 'aiApplyActions') && !readOnly;
            $actions.show();
            $actions.find('button').prop('disabled', !canApply);
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
        if (state && (!isInternFeatureAllowed(state, 'aiApplyActions') || state.readOnly)) {
            toast('warning', 'AI apply actions are disabled in internship mode.');
            return;
        }
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
        if (state && (!isInternFeatureAllowed(state, 'aiApplyActions') || state.readOnly)) {
            toast('warning', 'AI apply actions are disabled in internship mode.');
            return;
        }
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
        const $runBtn = $panel.find('#aacr2-ai-panel-run');
        const requestState = getAiRequestState(state, 'punctuation');
        const inFlight = requestState && requestState.inFlight;
        const punctuationAllowed = isInternFeatureAllowed(state, 'aiPunctuation');
        if (!meta) {
            $panel.data('targetElement', null);
            $panel.data('targetMeta', null);
            $panel.find('#aacr2-ai-selected').text('None');
            $panel.find('#aacr2-ai-current').text('(no MARC field selected)');
            if ($runBtn.length) $runBtn.prop('disabled', true);
            if (!inFlight) {
                updateAiPanelStatus($panel, 'Select a MARC field to enable rule and punctuation suggestions.', 'info');
            }
            return { element: null, meta: null };
        }
        const currentValue = ($(element).val() || '').toString();
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        const hasValue = currentValue.trim().length > 0;
        const excluded = isExcluded(settings, state, meta.tag, meta.code);
        const covered = !!(global.AACR2RulesEngine
            && typeof global.AACR2RulesEngine.isFieldCovered === 'function'
            && global.AACR2RulesEngine.isFieldCovered(
                meta.tag,
                meta.code,
                (fieldContext && fieldContext.ind1) || '',
                (fieldContext && fieldContext.ind2) || '',
                (state && state.rules) || []
            ));
        const label = `${meta.tag}$${meta.code}${meta.occurrence ? ` (${meta.occurrence})` : ''}`;
        $panel.data('targetElement', element);
        $panel.data('targetMeta', meta);
        $panel.find('#aacr2-ai-selected').text(label);
        $panel.find('#aacr2-ai-current').text(currentValue || '(empty)');
        if ($runBtn.length) {
            $runBtn.prop('disabled', !punctuationAllowed || !hasValue || excluded || !covered);
        }
        if (!inFlight) {
            if (!punctuationAllowed) {
                updateAiPanelStatus($panel, 'AI punctuation requests are disabled for this internship profile.', 'warning');
            } else if (!hasValue) {
                updateAiPanelStatus($panel, `Enter a value in ${label} to run rules and punctuation suggestions.`, 'info');
            } else if (excluded) {
                updateAiPanelStatus($panel, `AI assistance is disabled for excluded field ${meta.tag}$${meta.code}.`, 'warning');
            } else if (!covered) {
                updateAiPanelStatus($panel, 'No AACR2 rule defined for this field; AI assistance disabled.', 'warning');
            } else {
                updateAiPanelStatus($panel, '', 'info');
            }
        }
        return { element, meta };
    }

    function formatCatalogingResponseHtml(text) {
        const raw = (text || '').toString().replace(/\r\n?/g, '\n').trim();
        if (!raw) return '(none)';
        return raw.split('\n').map(line => {
            const escaped = escapeAttr(line || '');
            return escaped.replace(
                /^(\s*)(Classification|Subjects|Confidence|Rationale)(\s*:)/i,
                '$1<strong>$2</strong>$3'
            );
        }).join('<br/>');
    }

    function selectedCallNumberPrefix($panel) {
        if (!$panel || !$panel.length) return '';
        const value = $panel.find('input[name="aacr2-ai-prefix-type"]:checked').val();
        return (value || '').toString().trim();
    }

    function apply942PartsEnabled($panel) {
        if (!$panel || !$panel.length) return false;
        return !!$panel.find('#aacr2-ai-apply-942-parts').is(':checked');
    }

    function storePendingItemCallNumber(callNumber) {
        const value = (callNumber || '').toString().trim();
        if (!value) return;
        try {
            if (window.sessionStorage) {
                window.sessionStorage.setItem('aacr2PendingItemCallNumber', value);
            }
        } catch (err) {
            // ignore storage failures
        }
    }

    function resolveTagOccurrence(tag, preferredCodes) {
        if (!tag) return '';
        const codes = Array.isArray(preferredCodes) && preferredCodes.length ? preferredCodes : ['a'];
        for (const code of codes) {
            const $field = findFieldElement(tag, code, '');
            if ($field && $field.length) {
                const meta = parseFieldMeta($field[0]);
                return meta ? (meta.occurrence || '') : '';
            }
        }
        return '';
    }

    function ensureSubfieldInputFlexible(tag, occurrence, code) {
        const existing = findFieldElement(tag, code, occurrence);
        if (existing && existing.length) return existing;
        let $created = ensureSubfieldInput(tag, occurrence, code);
        if ($created && $created.length) return $created;
        const baseCodes = ['a', 'c', 'h', 'i', 'm', 'b', 'n', 'p', 'q'];
        for (const baseCode of baseCodes) {
            const $base = findFieldElement(tag, baseCode, occurrence);
            if ($base && $base.length && typeof cloneSubfieldRow === 'function') {
                $created = cloneSubfieldRow($base, tag, code, occurrence);
                if ($created && $created.length) return $created;
            }
        }
        return $();
    }

    function setTargetSubfieldValueWithUndo($field, target, nextValue, state) {
        if (!$field || !$field.length || !target) return false;
        const previous = ($field.val() || '').toString();
        const next = (nextValue || '').toString();
        if (previous === next) return false;
        recordUndo(target, previous, next);
        $field.val(next);
        $field.trigger('change');
        markFieldForRevalidation(state, target);
        return true;
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
        const normalizedClassification = sanitizeAiClassificationSuggestion(classificationRaw);
        const classification = normalizedClassification || normalizeClassificationSuggestion(classificationRaw);
        const cutter = buildCutterSanborn(cutterSource.value || '', cutterSource.tag || '');
        const year = yearInfo.value || '';
        const prefix = selectedCallNumberPrefix($panel);
        const callNumberParts = buildCallNumberParts(classification, cutter, year, prefix);
        const callNumber = callNumberParts.full;
        const readOnly = !!(state && state.readOnly);
        const catalogingAllowed = isInternFeatureAllowed(state, 'aiCataloging');
        const aiApplyAllowed = isInternFeatureAllowed(state, 'aiApplyActions');

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
        const normalizedSubjects = normalizeSubjectObjects(aiSuggestions.subjects || []);
        if (state && state.aiSuggestions) {
            state.aiSuggestions.subjects = normalizedSubjects;
        }
        renderAiSubjectList($panel, normalizedSubjects);
        $panel.find('#aacr2-ai-response').html(formatCatalogingResponseHtml(aiSuggestions.rawText || '(none)'));

        const hasTitle = !!titleInfo.title;
        const selection = getAiCatalogingSelectionState($panel, settings);
        const $runBtn = $panel.find('#aacr2-ai-run-cataloging');
        if ($runBtn.length) $runBtn.prop('disabled', !catalogingAllowed || !hasTitle || !selection.hasFeature);
        let status = '';
        if (!catalogingAllowed) {
            status = 'AI cataloging requests are disabled for this internship profile.';
        } else if (!hasTitle) {
            status = 'Title source requires 245$a. 245$b and 245$c are included when present.';
        } else if (!selection.hasFeature) {
            status = 'Select classification and/or subjects to enable suggestions.';
        }
        const requestState = getAiRequestState(state, 'cataloging');
        const inFlight = requestState && requestState.inFlight;
        if (!inFlight) {
            updateAiCatalogingStatus($panel, status, hasTitle ? 'info' : 'error');
        }
        const $useSuggested = $panel.find('#aacr2-ai-use-suggested-class');
        if ($useSuggested.length) {
            const hasManualClass = !!classificationInput.toString().trim() && !inputRangeMessage;
            const hasSuggestedClass = !!(aiSuggestions.classification || '').toString().trim() && !suggestionRangeMessage;
            $useSuggested.prop('disabled', !!(readOnly || !aiApplyAllowed || (!hasSuggestedClass && !hasManualClass)));
        }
        const $applyCall = $panel.find('#aacr2-ai-apply-callnumber');
        if ($applyCall.length) {
            const hasCallData = !!callNumber;
            const target = findCallNumberTarget();
            const hasTarget = !!(target && target.$field && target.$field.length);
            $applyCall.prop('disabled', !!(inputRangeMessage || aiRangeError || readOnly || !aiApplyAllowed || !hasCallData || !hasTarget));
        }
        const $undoCall = $panel.find('#aacr2-ai-undo-callnumber');
        if ($undoCall.length) {
            const hasUndo = !!(state && state.undoStack && state.undoStack.length);
            $undoCall.prop('disabled', !!(readOnly || !aiApplyAllowed || !hasUndo));
        }
        const $redoCall = $panel.find('#aacr2-ai-redo-callnumber');
        if ($redoCall.length) {
            const hasRedo = !!(state && state.redoStack && state.redoStack.length);
            $redoCall.prop('disabled', !!(readOnly || !aiApplyAllowed || !hasRedo));
        }
        const $apply942 = $panel.find('#aacr2-ai-apply-942-parts');
        if ($apply942.length) {
            $apply942.prop('disabled', !!(readOnly || !aiApplyAllowed));
        }
        updateAiCatalogingControls($panel, settings);
        return {
            titleInfo,
            cutterSource,
            year,
            classification,
            callNumber,
            classSegment: callNumberParts.classSegment,
            cutterSegment: callNumberParts.cutterSegment,
            cutter,
            prefix
        };
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
        const state = global.AACR2IntellisenseState;
        const catalogingAllowed = isInternFeatureAllowed(state, 'aiCataloging');
        const aiApplyAllowed = isInternFeatureAllowed(state, 'aiApplyActions');
        if ($button.length) {
            $button.text(selection.label);
            $button.prop('disabled', $button.prop('disabled') || !selection.hasFeature || !catalogingAllowed);
        }
        const $itemButtons = $panel.find('.aacr2-ai-subject-apply, .aacr2-ai-subject-undo, .aacr2-ai-subject-redo');
        if ($itemButtons.length) {
            $itemButtons.prop('disabled', !!(state && state.readOnly) || !aiApplyAllowed);
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
        if (!isInternFeatureAllowed(state, 'aiAssistToggle')) {
            toast('warning', 'AI Assist is disabled for this internship profile.');
            return;
        }
        let $panel = $('#aacr2-ai-panel');
        if (!$panel.length) {
            $panel = $(`
                <div class="aacr2-ai-panel" id="aacr2-ai-panel" style="display:none;">
                    <header>
                        <span>AI Assist</span>
                        <div>
                            <button type="button" class="btn btn-xs aacr2-btn-yellow" id="aacr2-ai-panel-minimize">Minimize</button>
                            <button type="button" class="btn btn-xs aacr2-btn-yellow" id="aacr2-ai-panel-refresh">Refresh</button>
                            <button type="button" class="btn btn-xs aacr2-btn-danger" id="aacr2-ai-panel-close">Close</button>
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
                            <div class="aacr2-ai-status-row">
                                <div id="aacr2-ai-cataloging-status" class="aacr2-status-text info"></div>
                                <button type="button" class="btn btn-xs aacr2-btn-danger" id="aacr2-ai-cancel-cataloging" style="display:none;">Cancel</button>
                            </div>
                            <div class="actions">
                                ${settings.aiPayloadPreview ? '<button type="button" class="btn btn-xs btn-default" id="aacr2-ai-cataloging-preview">Preview</button>' : ''}
                                <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-run-cataloging">Suggest classification &amp; subjects</button>
                            </div>
                            <div class="aacr2-ai-results">
                                <div class="meta">Classification (LC): <span id="aacr2-ai-classification">(none)</span></div>
                                <div class="meta">Confidence: <span id="aacr2-ai-confidence">(n/a)</span></div>
                                <div class="meta">Subjects:</div>
                                <div id="aacr2-ai-subjects" class="aacr2-ai-text-output">(none)</div>
                                <div class="actions" style="justify-content: flex-start;">
                                    <label style="font-weight: normal;">
                                        <input type="checkbox" id="aacr2-ai-subjects-replace"/>
                                        Replace existing subjects
                                    </label>
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
                                    <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-use-suggested-class">Apply</button>
                                </div>
                                <div class="meta" style="margin-top: 6px;">Collection prefix:</div>
                                <div class="aacr2-ai-prefix-options">
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="" checked/> None</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Ref."/> Reference material</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Spec. Col."/> Special collections</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Fed. Doc."/> Federal documents</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="St. Doc."/> State documents</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Juv. Col."/> Juvenile collection</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Media"/> Media</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Microform"/> Microform</label>
                                    <label><input type="radio" name="aacr2-ai-prefix-type" value="Music"/> Music</label>
                                </div>
                                <div class="actions" style="justify-content:flex-start; margin-top:6px;">
                                    <label style="font-weight: normal;">
                                        <input type="checkbox" id="aacr2-ai-apply-942-parts"/>
                                        Also apply to 942$h (classification), 942$i (cutter/year), and 942$m (prefix)
                                    </label>
                                </div>
                                <div id="aacr2-ai-classification-error" class="aacr2-ai-error" style="display:none;"></div>
                                <div class="aacr2-ai-callnumber-hints">
                                    <div class="meta">Derived cutter: <span id="aacr2-ai-cutter">(n/a)</span></div>
                                    <div class="meta">Publication year: <span id="aacr2-ai-year">(n/a)</span></div>
                                    <div class="meta">Call number preview: <span id="aacr2-ai-callnumber-preview">(waiting for classification)</span></div>
                                </div>
                                <div class="actions">
                                    <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-apply-callnumber">Apply call number</button>
                                    <button type="button" class="btn btn-xs aacr2-btn-yellow" id="aacr2-ai-undo-callnumber">Undo</button>
                                    <button type="button" class="btn btn-xs aacr2-btn-yellow" id="aacr2-ai-redo-callnumber">Redo</button>
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
                            <div class="aacr2-ai-status-row" style="margin-top: 8px;">
                                <div id="aacr2-ai-status" class="aacr2-status-text info"></div>
                                <button type="button" class="btn btn-xs aacr2-btn-danger" id="aacr2-ai-cancel-punctuation" style="display:none;">Cancel</button>
                            </div>
                            <div class="actions">
                                ${settings.aiPayloadPreview ? '<button type="button" class="btn btn-xs btn-default" id="aacr2-ai-panel-preview">Preview</button>' : ''}
                                <button type="button" class="btn btn-xs btn-primary" id="aacr2-ai-panel-run">Run rules &amp; punctuation suggestions</button>
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
            $panel.find('#aacr2-ai-cancel-punctuation').on('click', () => {
                const cancelled = cancelAiRequest(state, 'punctuation', 'Cancelled.', false);
                if (cancelled) updateAiPanelStatus($panel, 'Cancelled.', 'warning');
            });
            $panel.find('#aacr2-ai-cancel-cataloging').on('click', () => {
                const cancelled = cancelAiRequest(state, 'cataloging', 'Cancelled.', false);
                if (cancelled) updateAiCatalogingStatus($panel, 'Cancelled.', 'warning');
            });
            $panel.find('#aacr2-ai-panel-run').on('click', async function() {
                if (!isInternFeatureAllowed(state, 'aiPunctuation')) {
                    toast('warning', 'AI punctuation requests are disabled for this internship profile.');
                    return;
                }
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
                if (!isInternFeatureAllowed(state, 'aiCataloging')) {
                    toast('warning', 'AI cataloging requests are disabled for this internship profile.');
                    return;
                }
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
            $panel.find('#aacr2-ai-use-suggested-class').on('click', function() {
                if (!isInternFeatureAllowed(state, 'aiApplyActions') || (state && state.readOnly)) {
                    toast('warning', 'AI apply actions are disabled in internship mode.');
                    return;
                }
                const manualValue = ($panel.find('#aacr2-ai-classification-input').val() || '').toString().trim();
                if (manualValue) {
                    updateAiCatalogingContext($panel, settings, state);
                    toast('info', 'Manual classification retained.');
                    return;
                }
                const suggested = state && state.aiSuggestions ? (state.aiSuggestions.classification || '') : '';
                if (!suggested) {
                    toast('info', 'No suggested classification is available yet.');
                    return;
                }
                $panel.find('#aacr2-ai-classification-input').val(suggested);
                updateAiCatalogingContext($panel, settings, state);
                toast('info', 'Suggested classification applied.');
            });
            $panel.find('input[name="aacr2-ai-prefix-type"]').on('change', function() {
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-opt-classification, #aacr2-ai-opt-subjects').on('change', function() {
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-apply-callnumber').on('click', function() {
                if (!isInternFeatureAllowed(state, 'aiApplyActions') || (state && state.readOnly)) {
                    toast('warning', 'AI apply actions are disabled in internship mode.');
                    return;
                }
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
                const targetMeta = parseFieldMeta(target.$field[0]) || { occurrence: '' };
                const targetCode = ((target && target.code) || 'a').toLowerCase();
                const classValue = (info.classSegment || '').trim();
                const cutterValue = (info.cutterSegment || '').trim();
                const rawClassValue = (info.classification || '').trim();
                const prefixValue = (info.prefix || '').trim();
                const $classField = (targetCode === 'a')
                    ? target.$field
                    : ensureSubfieldInput(target.tag, targetMeta.occurrence || '', targetCode);
                if (!$classField || !$classField.length) {
                    toast('warning', `Unable to locate ${target.tag}$${targetCode} on this form.`);
                    return;
                }
                const classMeta = parseFieldMeta($classField[0]) || { occurrence: targetMeta.occurrence || '' };
                const classTarget = { tag: target.tag, code: targetCode, occurrence: classMeta.occurrence || '' };
                setTargetSubfieldValueWithUndo($classField, classTarget, classValue, state);
                const $cutterField = ensureSubfieldInput(target.tag, targetMeta.occurrence || '', 'b');
                const hasCutterField = !!($cutterField && $cutterField.length);
                if (hasCutterField) {
                    const cutterMeta = parseFieldMeta($cutterField[0]) || { occurrence: targetMeta.occurrence || '' };
                    const cutterTarget = { tag: target.tag, code: 'b', occurrence: cutterMeta.occurrence || '' };
                    setTargetSubfieldValueWithUndo($cutterField, cutterTarget, cutterValue, state);
                }
                let mirror942Applied = false;
                if (apply942PartsEnabled($panel)) {
                    const occ942 = resolveTagOccurrence('942', ['c', 'a', 'h', 'i', 'm']);
                    const apply942Part = (code, value) => {
                        const $field942 = ensureSubfieldInputFlexible('942', occ942, code);
                        if (!$field942 || !$field942.length) return false;
                        const meta942 = parseFieldMeta($field942[0]) || { occurrence: occ942 };
                        return setTargetSubfieldValueWithUndo(
                            $field942,
                            { tag: '942', code, occurrence: meta942.occurrence || occ942 || '' },
                            value,
                            state
                        );
                    };
                    if (apply942Part('h', rawClassValue)) mirror942Applied = true;
                    if (apply942Part('i', cutterValue)) mirror942Applied = true;
                    if (apply942Part('m', prefixValue)) mirror942Applied = true;
                }
                storePendingItemCallNumber(info.callNumber || '');
                const hasCutter = !!info.cutter;
                let message = `Call number applied: ${target.tag}$${targetCode}="${classValue}"`;
                message += hasCutterField ? `, ${target.tag}$b="${cutterValue}".` : '.';
                if (!hasCutterField) {
                    message += ` Unable to locate/create ${target.tag}$b.`;
                } else if (!hasCutter) {
                    message += ' Cutter-Sanborn match not found; review the cutter.';
                }
                if (apply942PartsEnabled($panel)) {
                    message += mirror942Applied
                        ? ' Mirrored to 942$h/$i/$m.'
                        : ' 942 mirror selected, but no editable 942 field was found.';
                }
                toast((hasCutter && hasCutterField) ? 'info' : 'warning', message);
            });
            $panel.find('#aacr2-ai-undo-callnumber').on('click', function() {
                undoLastChange();
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.find('#aacr2-ai-redo-callnumber').on('click', function() {
                redoLastChange();
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.on('click', '.aacr2-ai-subject-apply', function() {
                if (!isInternFeatureAllowed(state, 'aiApplyActions') || (state && state.readOnly)) {
                    toast('warning', 'AI apply actions are disabled in internship mode.');
                    return;
                }
                const index = Number($(this).attr('data-index'));
                applyAiSubjectByIndex(settings, state, index);
                updateAiCatalogingContext($panel, settings, state);
            });
            $panel.on('click', '.aacr2-ai-subject-undo', function() {
                if (!isInternFeatureAllowed(state, 'aiApplyActions') || (state && state.readOnly)) {
                    toast('warning', 'AI apply actions are disabled in internship mode.');
                    return;
                }
                const index = Number($(this).attr('data-index'));
                if (undoAiSubjectApplyByIndex(settings, state, index)) {
                    updateAiCatalogingContext($panel, settings, state);
                }
            });
            $panel.on('click', '.aacr2-ai-subject-redo', function() {
                if (!isInternFeatureAllowed(state, 'aiApplyActions') || (state && state.readOnly)) {
                    toast('warning', 'AI apply actions are disabled in internship mode.');
                    return;
                }
                const index = Number($(this).attr('data-index'));
                if (redoAiSubjectApplyByIndex(settings, state, index)) {
                    updateAiCatalogingContext($panel, settings, state);
                }
            });
            $panel.find('#aacr2-ai-apply-selected').on('click', () => {
                applySelectedAiPatches(state);
            });
            $panel.find('#aacr2-ai-apply-all').on('click', () => {
                applyAllAiPatches(state);
            });
        }
        const aiCatalogingAllowed = isInternFeatureAllowed(state, 'aiCataloging');
        const aiPunctuationAllowed = isInternFeatureAllowed(state, 'aiPunctuation');
        $panel.find('#aacr2-ai-opt-punctuation')
            .prop('checked', !!(settings.aiPunctuationExplain && aiPunctuationAllowed))
            .prop('disabled', !settings.aiPunctuationExplain || !aiPunctuationAllowed);
        $panel.find('#aacr2-ai-opt-classification')
            .prop('checked', !!(settings.aiCallNumberGuidance && aiCatalogingAllowed))
            .prop('disabled', !settings.aiCallNumberGuidance || !aiCatalogingAllowed);
        $panel.find('#aacr2-ai-opt-subjects')
            .prop('checked', !!(settings.aiSubjectGuidance && aiCatalogingAllowed))
            .prop('disabled', !settings.aiSubjectGuidance || !aiCatalogingAllowed);
        updateAiPanelSelection($panel, settings, state);
        updateAiCatalogingContext($panel, settings, state);
        applyStoredAiStatus($panel, state);
        updateAiCancelButtonState(state);
        $panel.show();
        recoverFloatingPanel($panel, { minWidth: 320, minHeight: 220, right: 24, bottom: 24, buttonSelector: '#aacr2-ai-panel-minimize' });
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
        if (!isInternFeatureAllowed(state, 'aiPunctuation')) {
            const denied = 'AI punctuation requests are disabled for this internship profile.';
            toast('warning', denied);
            if (typeof opts.onStatus === 'function') opts.onStatus(denied, 'error');
            return;
        }
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
