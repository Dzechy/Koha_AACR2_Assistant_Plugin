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
        const key = getGuideProgressKey(settings);
        try {
            const serialized = JSON.stringify(progress);
            if (window.localStorage) {
                window.localStorage.setItem(key, serialized);
            } else if (window.sessionStorage) {
                window.sessionStorage.setItem(key, serialized);
            }
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
            summary_counts: summaryCounts,
            summary: (summary && typeof summary === 'object') ? summary : {}
        };
        const buildGuideProgressUrl = (forceClass) => {
            const extraParams = { op: 'plugin_api' };
            if (forceClass) extraParams.class = forceClass;
            return buildPluginUrl(settings, 'guide_progress_update', extraParams);
        };
        const url = buildGuideProgressUrl('');
        if (!url) return;

        if (global.AACR2ApiClient && typeof global.AACR2ApiClient.postJson === 'function') {
            global.AACR2ApiClient.postJson(url, payload)
                .then(data => {
                    if (data && data.error) {
                        reportProgressUpdateError(settings, 200, data.error, '');
                    }
                    return data;
                })
                .catch(err => {
                    const message = err && err.message ? String(err.message) : 'Request failed.';
                    if (/missing required parameter:\s*class/i.test(message)) {
                        const fallbackClass = (settings.pluginClass || '').toString().trim();
                        const retryUrl = fallbackClass ? buildGuideProgressUrl(fallbackClass) : '';
                        if (retryUrl) {
                            global.AACR2ApiClient.postJson(retryUrl, payload)
                                .catch(retryErr => {
                                    reportProgressUpdateError(settings, 0, (retryErr && retryErr.message) || message, '');
                                });
                            return;
                        }
                    }
                    reportProgressUpdateError(settings, 0, message, '');
                });
            return;
        }

        // Fallback path if API client module is unavailable.
        const normalizeCsrfToken = (value) => {
            if (value === undefined || value === null) return '';
            let token = String(value).replace(/[\r\n]/g, '').trim();
            if (!token) return '';
            if (token.includes(',')) {
                token = token.split(',').map(item => item.trim()).filter(Boolean)[0] || '';
            }
            return token;
        };
        const isPluginCsrfToken = (value) => /^[a-f0-9]{64}$/i.test(String(value || '').trim());
        let csrfToken = normalizeCsrfToken((settings && settings.csrfToken) || '');
        if (!isPluginCsrfToken(csrfToken)) csrfToken = '';
        if (!csrfToken) {
            const csrfMetas = Array.from(document.querySelectorAll('meta[name="aacr2-plugin-csrf-token"], meta[name="csrf-token"]'));
            csrfToken = csrfMetas
                .map(meta => normalizeCsrfToken(meta ? meta.getAttribute('content') : ''))
                .find(token => isPluginCsrfToken(token)) || '';
        }
        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken, 'CSRF-TOKEN': csrfToken } : {})
            },
            credentials: 'include',
            body: JSON.stringify(payload)
        })
            .then(resp => resp.json())
            .then(data => {
                if (data && data.error) {
                    reportProgressUpdateError(settings, 200, data.error, '');
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
            const progress = loadGuideProgress(allSteps, settings);
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
            const normalizeTierLabel = (value) => {
                const raw = (value || '').toString().trim();
                if (!raw) return 'Unspecified';
                const match = raw.match(/tier\s*(\d+)/i) || raw.match(/^t\s*(\d+)$/i);
                if (match && match[1]) return `Tier ${match[1]}`;
                return raw;
            };
            moduleData.modules.forEach(module => {
                moduleSummary[module] = countSteps(moduleData.moduleMap.get(module) || []);
            });
            allSteps.forEach(step => {
                const tierLabel = normalizeTierLabel(step.tier);
                if (!tierSummary[tierLabel]) {
                    tierSummary[tierLabel] = { total: 0, completed: 0, skipped: 0 };
                }
                tierSummary[tierLabel].total += 1;
                if (progress.completed[step.key]) tierSummary[tierLabel].completed += 1;
                if (progress.skipped[step.key]) tierSummary[tierLabel].skipped += 1;
            });
            const modules = moduleCompletionSummary();
            const currentStep = (steps && steps.length && steps[stepIndex]) ? steps[stepIndex] : null;
            const doneCount = overall.completed + overall.skipped;
            const completionPercent = overall.total ? Math.round((doneCount / overall.total) * 100) : 0;
            const currentTier = currentStep ? normalizeTierLabel(currentStep.tier) : '';
            return {
                steps_total: overall.total,
                steps_completed: overall.completed,
                steps_skipped: overall.skipped,
                completion_percent: completionPercent,
                current_module: currentStep && currentStep.module ? currentStep.module : '',
                current_tier: currentTier === 'Unspecified' ? '' : currentTier,
                current_step_key: currentStep && currentStep.key ? currentStep.key : '',
                current_step_title: currentStep && currentStep.title ? currentStep.title : '',
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
                <h4 style="margin-top:0;">About Koha_AACR2_Assistant_Plugin</h4>
                <p>AACR2-focused MARC21 assistant for Koha with guardrails, training guidance, and optional AI suggestions.</p>
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
                    <li>AACR2 punctuation checks and quick fixes</li>
                    <li>Cataloging guide progress tracking</li>
                    <li>Optional AI suggestions for classification and subjects</li>
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
