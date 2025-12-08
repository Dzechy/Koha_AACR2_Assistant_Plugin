/**
 * AACR2 MARC21 LCC Intellisense for Koha
 * ======================================
 * AACR2-only punctuation, MARC21/LCC intellisense, floating assistant UI, and
 * AI-driven subject + call number guidance crafted for Koha cataloging forms.
 * Authored by Duke Chijimaka Jonathan.
 */
$(document).ready(function() {
    // Get configuration with fallback
    const CONFIG = window.AutoPunctuationSettings || {
        enabled: true,
        catalogingStandard: 'AACR2',
        debugMode: true,
        enableGuide: false,
        guideUsers: '',
        guideExclusionList: '',
        customRules: '{}',
        internshipMode: true,
        internshipUsers: '',
        internshipExclusionList: '',
        enforceAacr2Guardrails: true,
        enableLiveValidation: true,
        blockSaveOnError: true,
        requiredFields: '100a,245a,260c,300a,050a',
        excludedTags: '',
        llmApiProvider: 'OpenAI',
        llmApiKey: '',
        last_updated: '2025-06-20 12:56:22',
        pluginPath: '/cgi-bin/koha/plugins/run.pl?class=Koha::Plugin::Cataloging::AutoPunctuation'
    };

    // Enforce AACR2-only behavior regardless of stored preference
    CONFIG.catalogingStandard = 'AACR2';

    // Warn if fallback is used
    if (!window.AutoPunctuationSettings) {
        console.warn('[AutoPunctuation] Warning: Using fallback configuration. Server-side settings failed to load. Check intranet_js output.');
    }

    // Log configuration for debugging
    if (CONFIG.debugMode) {
        console.log('[AutoPunctuation] Configuration:', CONFIG);
    }

    // Parse custom rules
    let customRules = {};
    try {
        customRules = typeof CONFIG.customRules === 'string' ?
            JSON.parse(CONFIG.customRules || '{}') :
            CONFIG.customRules || {};
    } catch (e) {
        debug(`Failed to parse custom rules: ${e}`);
        customRules = {};
    }

    // Store original values
    const originalValues = {};

    // Get logged-in username using regex for loggedinusernam*
    let loggedInUser = '';
    let isSuperLibrarian = false;
    const loggedInUserSpan = $('#logged-in-info-full [class*="loggedinusernam"]');
    if (loggedInUserSpan.length) {
        loggedInUser = loggedInUserSpan.text().trim();
        isSuperLibrarian = loggedInUserSpan.hasClass('is_superlibrarian');
    } else {
        console.warn('[AutoPunctuation] Could not find span with class matching loggedinusernam*. Falling back to empty user.');
    }

    // Log username and superlibrarian status
    if (CONFIG.debugMode) {
        console.log(`[AutoPunctuation] Username: ${loggedInUser}, SuperLibrarian: ${isSuperLibrarian}`);
    }

    // Check if user is excluded for specific features
    const guideExclusions = (CONFIG.guideUsers + ',' + CONFIG.guideExclusionList)
        .split(',')
        .map(u => u.trim())
        .filter(Boolean);

    const internshipExclusions = (CONFIG.internshipUsers + ',' + CONFIG.internshipExclusionList)
        .split(',')
        .map(u => u.trim())
        .filter(Boolean);

    const isGuideExcluded = guideExclusions.includes(loggedInUser);
    const isInternExcluded = CONFIG.internshipMode && internshipExclusions.includes(loggedInUser);

    // Override enabled status for excluded users
    CONFIG.enabled = CONFIG.enabled && !isInternExcluded;

    // Persist exclusions and user info in session storage
    sessionStorage.setItem('punctuationGuideExclusions', JSON.stringify(guideExclusions));
    sessionStorage.setItem('punctuationInternshipExclusions', JSON.stringify(internshipExclusions));
    sessionStorage.setItem('punctuationUserInSession', loggedInUser);
    sessionStorage.setItem('punctuationIsSuperLibrarian', isSuperLibrarian);

    // Log exclusion status
    if (CONFIG.debugMode) {
        console.log(`[AutoPunctuation] User: ${loggedInUser}, Guide Excluded: ${isGuideExcluded}, Intern Excluded: ${isInternExcluded}, Plugin Enabled: ${CONFIG.enabled}`);
    }

    // Log messages when debug mode is enabled
    function debug(message) {
        if (CONFIG.debugMode) {
            console.log(`[AutoPunctuation] ${message}`);
        }
    }

    // Floating assistant styles
    const assistantStyles = `
        #aacr2-intellisense { position: fixed; bottom: 20px; right: 20px; width: 360px; background: #0c223f; color: #fff; border-radius: 6px; box-shadow: 0 8px 20px rgba(0,0,0,0.35); z-index: 9999; overflow: hidden; }
        #aacr2-intellisense header { padding: 10px 12px; background: #17345f; display: flex; justify-content: space-between; align-items: center; }
        #aacr2-intellisense h4 { margin: 0; font-size: 14px; font-weight: 700; }
        #aacr2-intellisense .body { padding: 10px 12px; background: #102742; }
        #aacr2-intellisense .meta { font-size: 11px; color: #cdd8ec; margin-bottom: 8px; }
        #aacr2-intellisense .results { background: #0a1b30; border: 1px solid #264a8f; border-radius: 4px; padding: 8px; min-height: 80px; font-size: 12px; color: #e8f0ff; }
        #aacr2-intellisense button { margin-top: 8px; }
        #aacr2-intellisense.collapsed .body { display: none; }
        #aacr2-intellisense .tags { margin-top: 6px; font-size: 11px; color: #cdd8ec; }
        .aacr2-violation { border-color: #d9534f !important; box-shadow: 0 0 6px rgba(217,83,79,0.6) !important; }
        .aacr2-violation-hint { color: #f7d7d7; font-size: 11px; margin-top: 4px; }
        .aacr2-ghost { margin-top: 6px; padding: 8px; background: #0e2c51; border: 1px dashed #4aa3ff; border-radius: 4px; color: #e8f0ff; font-size: 12px; position: relative; }
        .aacr2-ghost .ghost-actions { margin-top: 6px; display: flex; gap: 6px; }
        .aacr2-ghost .ghost-pill { display: inline-block; background: rgba(255,255,255,0.12); color: #b8d7ff; padding: 4px 6px; border-radius: 12px; margin-right: 6px; font-size: 11px; }
        .aacr2-ghost button.btn-link { color: #b8d7ff; padding: 0; border: none; background: transparent; text-decoration: underline; }
    `;
    $('head').append(`<style>${assistantStyles}</style>`);

    // Toast helper
    function toast(type, message) {
        if (window.toastr && typeof window.toastr[type] === 'function') {
            toastr.options = toastr.options || {};
            toastr.options.positionClass = toastr.options.positionClass || 'toast-bottom-right';
            toastr[type](message);
            return;
        }
        const $toast = $(`
            <div class="alert alert-${type === 'error' ? 'danger' : type}" style="position: fixed; bottom: 20px; right: 20px; z-index: 10000; min-width: 220px;">${message}</div>
        `).appendTo('body');
        setTimeout(() => $toast.fadeOut(() => $toast.remove()), 4000);
    }

    // Ghost suggestion cache and state
    const ghostCache = new Map();
    const ghostRequestsInFlight = new Set();
    const ghostTargets = {
        '050a': { label: 'LCC call number', type: 'call_number' },
        '090a': { label: 'Local call number', type: 'call_number' },
        '650a': { label: 'LCSH topical subject', type: 'subject_topical' },
        '651a': { label: 'LCSH geographic subject', type: 'subject_geographic' }
    };

    const requiredFields = (CONFIG.requiredFields || '100a,245a,260c,300a,050a')
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
    const excludedFields = (CONFIG.excludedTags || '')
        .split(',')
        .map(f => f.trim())
        .filter(Boolean);
    const violationState = new Map();

    function isExcluded(tag, subfield) {
        const key = `${tag}${subfield}`;
        return excludedFields.some(entry => {
            if (!entry) return false;
            if (/\d{3}[a-z]/i.test(entry)) {
                return entry.toLowerCase() === key.toLowerCase();
            }
            if (/\d{3}/.test(entry)) {
                return entry.replace(/\D/g, '') === tag;
            }
            return false;
        });
    }

    function setViolation(fieldKey, message, $element) {
        if (!$element) return;
        violationState.set(fieldKey, message);
        $element.addClass('aacr2-violation').attr('title', message);
        updateGuardrailStatus();
    }

    function clearViolation(fieldKey, $element) {
        violationState.delete(fieldKey);
        if ($element) {
            $element.removeClass('aacr2-violation').removeAttr('title');
        }
        updateGuardrailStatus();
    }

    function updateGuardrailStatus() {
        const missingRequired = requiredFields.filter(code => !fieldHasValue(code));
        const totalViolations = violationState.size + missingRequired.length;
        const statusText = totalViolations === 0
            ? 'AACR2 guardrails satisfied'
            : `${totalViolations} AACR2 guardrail issue${totalViolations === 1 ? '' : 's'} (${missingRequired.length} required fields missing)`;
        $('#aacr2-guardrail-status').text(statusText);
        $('#aacr2-live-meta').text(`Guardrail status: ${statusText}`);
        if (CONFIG.blockSaveOnError && CONFIG.enforceAacr2Guardrails) {
            const shouldDisable = totalViolations > 0;
            $('form[name="f"] input[type="submit"], #cat_addbiblio input[type="submit"]').prop('disabled', shouldDisable);
        }
    }

    function fieldHasValue(code) {
        const tag = code.substring(0, 3);
        const sub = code.substring(3, 4);
        const selector = `#subfield${tag}${sub}, #tag_${tag}_subfield_${sub}, input[name^="field_${tag}${sub}"], textarea[name^="field_${tag}${sub}"]`;
        const $field = $(selector).first();
        if (!$field.length) return false;
        return Boolean($field.val() && $field.val().trim());
    }

    // Check if server settings are newer
    function isServerSettingsNewer() {
        const sessionLastUpdated = sessionStorage.getItem('punctuationHelperLastUpdated');
        if (!sessionLastUpdated) return true;
        const serverDate = new Date(CONFIG.last_updated);
        const sessionDate = new Date(sessionLastUpdated);
        return serverDate > sessionDate;
    }

    // Load session preferences
    function loadSessionPreferences() {
        if (isServerSettingsNewer()) {
            debug('Server settings are newer, clearing session preferences');
            sessionStorage.removeItem('punctuationHelperEnabled');
            sessionStorage.removeItem('punctuationHelperStandard');
            sessionStorage.setItem('punctuationHelperLastUpdated', CONFIG.last_updated);
            return;
        }
        const savedEnabled = sessionStorage.getItem('punctuationHelperEnabled');
        if (savedEnabled !== null && !isInternExcluded) {
            CONFIG.enabled = savedEnabled === 'true';
            debug(`Loaded session preference for enabled: ${CONFIG.enabled}`);
        }
        CONFIG.catalogingStandard = 'AACR2';
        debug('Cataloging standard locked to AACR2 for intellisense focus');
        // Load exclusions from session storage
        const savedGuideExclusions = sessionStorage.getItem('punctuationGuideExclusions');
        const savedInternshipExclusions = sessionStorage.getItem('punctuationInternshipExclusions');
        if (savedGuideExclusions) {
            try {
                const exclusions = JSON.parse(savedGuideExclusions);
                if (exclusions.includes(loggedInUser)) {
                    debug(`User ${loggedInUser} excluded from guide via session storage`);
                }
            } catch (e) {
                debug(`Failed to parse guide exclusions: ${e}`);
            }
        }
        if (savedInternshipExclusions && CONFIG.internshipMode) {
            try {
                const exclusions = JSON.parse(savedInternshipExclusions);
                if (exclusions.includes(loggedInUser)) {
                    CONFIG.enabled = false;
                    debug(`User ${loggedInUser} excluded from auto-punctuation via session storage`);
                }
            } catch (e) {
                debug(`Failed to parse internship exclusions: ${e}`);
            }
        }
    }

    // Default punctuation rules
    const defaultPunctuationRules = {
        'AACR2': {
            '245a': { prefix: '', suffix: '.' },
            '245b': { prefix: ' : ', suffix: '' },
            '245c': { prefix: ' / ', suffix: '.' },
            '245n': { prefix: '. ', suffix: '' },
            '245p': { prefix: ', ', suffix: '' },
            '260a': { prefix: '', suffix: ' : ' },
            '260b': { prefix: '', suffix: ', ' },
            '260c': { prefix: '', suffix: '.' },
            '300a': { prefix: '', suffix: ' : ' },
            '300b': { prefix: '', suffix: ' ; ' },
            '300c': { prefix: '', suffix: '.' },
            '440a': { prefix: '', suffix: ' ; ' },
            '440v': { prefix: '', suffix: '.' },
            '490a': { prefix: '', suffix: ' ; ' },
            '490v': { prefix: '', suffix: '.' },
            '500a': { prefix: '', suffix: '.' },
            '502a': { prefix: '', suffix: '.' },
            '504a': { prefix: '', suffix: '.' },
            '505a': { prefix: '', suffix: '.' },
            '520a': { prefix: '', suffix: '.' },
            '650a': { prefix: '', suffix: ' -- ' },
            '650x': { prefix: '', suffix: ' -- ' },
            '650y': { prefix: '', suffix: ' -- ' },
            '650z': { prefix: '', suffix: '.' },
            '651a': { prefix: '', suffix: ' -- ' },
            '651x': { prefix: '', suffix: ' -- ' },
            '651y': { prefix: '', suffix: ' -- ' },
            '651z': { prefix: '', suffix: '.' },
            '100a': { prefix: '', suffix: '.' },
            '100d': { prefix: ', ', suffix: '.' },
            '100e': { prefix: ', ', suffix: '.' },
            '700a': { prefix: '', suffix: '.' },
            '700d': { prefix: ', ', suffix: '.' },
            '700e': { prefix: ', ', suffix: '.' },
            '110a': { prefix: '', suffix: '.' },
            '110b': { prefix: '. ', suffix: '.' },
            '710a': { prefix: '', suffix: '.' },
            '710b': { prefix: '. ', suffix: '.' },
            '111a': { prefix: '', suffix: '.' },
            '111c': { prefix: ' (', suffix: ')' },
            '111d': { prefix: ' (', suffix: ')' },
            '711a': { prefix: '', suffix: '.' },
            '711c': { prefix: ' (', suffix: ')' },
            '711d': { prefix: ' (', suffix: ')' },
            '240a': { prefix: '', suffix: '.' },
            '250a': { prefix: '', suffix: '.' },
            '020a': { prefix: '', suffix: ' ' },
            '022a': { prefix: '', suffix: ' ' }
        }
    };

    // Merge custom rules with default rules
    let punctuationRules = {};
    try {
        punctuationRules = {
            AACR2: { ...defaultPunctuationRules.AACR2, ...(customRules.AACR2 || {}) }
        };
    } catch (e) {
        debug(`Error merging rules: ${e}. Using default rules.`);
        punctuationRules = { ...defaultPunctuationRules };
    }

    // Configuration for field ID patterns
    const fieldIdPatterns = [
        /tag_(\d+)_subfield_([a-z])/i,
        /subfield(\d+)([a-z])/i,
        /tag_(\d+)_code_([a-z])/i
    ];

    // Parse field ID
    function parseFieldId(inputId) {
        for (const pattern of fieldIdPatterns) {
            const match = inputId.match(pattern);
            if (match) {
                return { tag: match[1], subfield: match[2] };
            }
        }
        const genericMatch = inputId.match(/(\d{3}).*?([a-z])/i);
        if (genericMatch) {
            debug(`Using generic pattern for field ID: ${inputId}`);
            return { tag: genericMatch[1], subfield: genericMatch[2] };
        }
        debug(`Could not parse field ID: ${inputId}`);
        return null;
    }

    // Get applicable rules
    function getRules() {
        return punctuationRules[CONFIG.catalogingStandard] || punctuationRules['AACR2'];
    }

    // Check for terminal punctuation
    function shouldHaveTerminalPunctuation(tag, subfield) {
        const rules = getRules();
        const fieldKey = tag + subfield;
        if (fieldKey === '245a') {
            if ($('#subfield245b, #tag_245_subfield_b, [id*="245"][id*="b"]').length ||
                $('#subfield245c, #tag_245_subfield_c, [id*="245"][id*="c"]').length ||
                $('#subfield245n, #tag_245_subfield_n, [id*="245"][id*="n"]').length ||
                $('#subfield245p, #tag_245_subfield_p, [id*="245"][id*="p"]').length) {
                debug('245$a should not have terminal punctuation due to subsequent subfields');
                return false;
            }
        }
        if (fieldKey === '300a') {
            if ($('#subfield300b, #tag_300_subfield_b, [id*="300"][id*="b"]').length) {
                debug('300$a should use colon due to subsequent $b');
                return true;
            } else {
                return true;
            }
        }
        return rules[fieldKey] && rules[fieldKey].suffix && rules[fieldKey].suffix.trim().length > 0;
    }

    // Get punctuation
    function getPunctuation(tag, subfield, type) {
        const rules = getRules();
        const fieldKey = tag + subfield;
        if (!rules[fieldKey]) {
            debug(`No ${type} punctuation rule for ${fieldKey}`);
            return '';
        }
        if (type === 'suffix') {
            if (fieldKey === '245a' && !shouldHaveTerminalPunctuation(tag, subfield)) {
                debug('Returning empty suffix for 245$a due to subsequent subfields');
                return '';
            }
            if (fieldKey === '300a') {
                if ($('#subfield300b, #tag_300_subfield_b, [id*="300"][id*="b"]').length) {
                    debug('Using colon suffix for 300$a due to presence of $b');
                    return ' : ';
                } else {
                    debug('Using period suffix for 300$a as final subfield');
                    return '.';
                }
            }
        }
        debug(`Using ${type} for ${fieldKey}: "${rules[fieldKey]}"`);
        return rules[fieldKey][type] || '';
    }

    // Handle field focus
    function handleFieldFocus(event) {
        if (!CONFIG.enabled && !(CONFIG.enableLiveValidation || CONFIG.enforceAacr2Guardrails)) return;
        const inputId = $(this).attr('id');
        const parsedField = parseFieldId(inputId);
        if (!parsedField) return;
        const { tag, subfield } = parsedField;
        if (isExcluded(tag, subfield)) {
            debug(`Field ${tag}${subfield} is excluded from automation`);
            return;
        }
        const fieldKey = tag + subfield;
        const rules = getRules();
        const hasRules = Boolean(rules[fieldKey]);
        if (!hasRules && !ghostTargets[fieldKey]) {
            debug(`No rules or ghost targets for field ${fieldKey}, skipping`);
            return;
        }
        originalValues[inputId] = $(this).val();
        if (hasRules && $(this).val() === '' && rules[fieldKey].prefix) {
            debug(`Adding prefix "${rules[fieldKey].prefix}" to ${fieldKey}`);
            $(this).val(rules[fieldKey].prefix);
            if (this.setSelectionRange) {
                const prefixLength = rules[fieldKey].prefix.length;
                this.setSelectionRange(prefixLength, prefixLength);
                $(this).attr('aria-live', 'polite');
                setTimeout(() => $(this).removeAttr('aria-live'), 1000);
            }
        }
        maybeShowGhostSuggestion(fieldKey, $(this));
    }

    // Handle field blur
    function handleFieldBlur(event) {
        if (!CONFIG.enabled && !(CONFIG.enforceAacr2Guardrails || CONFIG.enableLiveValidation)) return;
        const inputId = $(this).attr('id');
        const parsedField = parseFieldId(inputId);
        if (!parsedField) return;
        const { tag, subfield } = parsedField;
        if (isExcluded(tag, subfield)) {
            debug(`Field ${tag}${subfield} is excluded from automation`);
            return;
        }
        const fieldKey = tag + subfield;
        const rules = getRules();
        const hasRules = Boolean(rules[fieldKey]);
        if (!hasRules) {
            debug(`No punctuation rules for ${fieldKey} on blur; skipping punctuation enforcement`);
            return;
        }
        const currentValue = $(this).val().trim();
        if (currentValue === '') {
            debug(`Field ${fieldKey} is empty, skipping suffix`);
            return;
        }
        const suffix = getPunctuation(tag, subfield, 'suffix');
        if (suffix && !currentValue.endsWith(suffix)) {
            if (fieldKey === '300a' && suffix === ' : ' && !$('#subfield300b, #tag_300_subfield_b, [id*="300"][id*="b"]').length) {
                debug(`300$a with no $b, using period instead of colon`);
                let newValue = currentValue.trim();
                if (!newValue.endsWith('.')) {
                    newValue += '.';
                    $(this).val(newValue);
                    debug(`Added period to 300$a: ${newValue}`);
                }
            } else {
                let newValue = currentValue.trim();
                const endsWithPunctuation = /[.,:;!?]$/.test(newValue);
                if (endsWithPunctuation) {
                    debug(`Field ${fieldKey} already has punctuation, respecting manual edit`);
                } else {
                    newValue += suffix;
                    $(this).val(newValue);
                    debug(`Added suffix "${suffix}" to ${fieldKey}: ${newValue}`);
                    $(this).attr('aria-live', 'polite');
                    setTimeout(() => $(this).removeAttr('aria-live'), 1000);
                }
            }
        }
        validateField($(this), fieldKey, suffix, tag, subfield);
    }

    function validateField($element, fieldKey, suffix, tag, subfield) {
        if (!(CONFIG.enableLiveValidation || CONFIG.enforceAacr2Guardrails)) {
            return;
        }
        const value = ($element.val() || '').trim();
        if (!value) {
            clearViolation(fieldKey, $element);
            updateGuardrailStatus();
            return;
        }
        const issues = [];
        if (suffix && shouldHaveTerminalPunctuation(tag, subfield)) {
            const normalizedSuffix = suffix.trim();
            if (normalizedSuffix && !value.endsWith(normalizedSuffix)) {
                issues.push(`Missing AACR2 terminal punctuation (${normalizedSuffix}) for ${fieldKey}`);
            }
        }
        if (/\s{2,}/.test(value)) {
            issues.push('AACR2 discourages double spaces; please tighten spacing');
        }
        if (issues.length) {
            setViolation(fieldKey, issues[0], $element);
        } else {
            clearViolation(fieldKey, $element);
        }
    }

    function isGhostCandidate(fieldKey) {
        return CONFIG.enabled && CONFIG.llmApiKey && ghostTargets[fieldKey] && !isInternExcluded;
    }

    function maybeShowGhostSuggestion(fieldKey, $element) {
        if (!isGhostCandidate(fieldKey)) return;
        if (ghostRequestsInFlight.has(fieldKey)) return;

        if (ghostCache.has(fieldKey)) {
            renderGhostSuggestion(fieldKey, $element, ghostCache.get(fieldKey));
            return;
        }

        ghostRequestsInFlight.add(fieldKey);
        toast('info', `Requesting AACR2 ghost guidance for ${ghostTargets[fieldKey].label}...`);
        fetchGhostSuggestion(fieldKey, $element)
            .catch(err => {
                debug(`Ghost suggestion failed for ${fieldKey}: ${err.message}`);
                toast('error', `Ghost suggestion unavailable for ${ghostTargets[fieldKey].label}.`);
            })
            .finally(() => ghostRequestsInFlight.delete(fieldKey));
    }

    function extractGhostValues(result, fieldKey) {
        const target = ghostTargets[fieldKey];
        if (!target) return [];
        const values = [];
        if (target.type === 'call_number') {
            if (result.call_number) values.push(result.call_number);
            if (result.lcc && !values.includes(result.lcc)) values.push(result.lcc);
        } else if (target.type && target.type.startsWith('subject')) {
            if (Array.isArray(result.subjects)) {
                result.subjects.forEach(subject => {
                    if (typeof subject === 'string') {
                        values.push(subject);
                        return;
                    }
                    const isGeo = subject.type === 'geographic';
                    const isTopical = subject.type === 'topical';
                    if (target.type === 'subject_geographic' && !isGeo) return;
                    if (target.type === 'subject_topical' && !isTopical) return;
                    const main = subject.main || subject.heading || '';
                    if (!main) return;
                    const subdivisions = Array.isArray(subject.subdivisions) ? subject.subdivisions.filter(Boolean) : [];
                    const assembled = `${main}${subdivisions.length ? ' -- ' + subdivisions.join(' -- ') : ''}`;
                    values.push(assembled);
                });
            }
        }
        return values.filter(Boolean);
    }

    async function fetchGhostSuggestion(fieldKey, $element) {
        const payload = collectAACR2Data();
        if (Object.keys(payload).length === 0) {
            toast('warning', 'Add AACR2-required descriptive fields before asking for ghost guidance.');
            return;
        }
        if (!CONFIG.pluginPath) {
            toast('error', 'Plugin path missing; cannot request ghost guidance.');
            return;
        }
        payload.intent = 'ghost_suggestion';
        payload.focus_field = fieldKey;
        payload.target = ghostTargets[fieldKey].type;
        const response = await fetch(`${CONFIG.pluginPath}&method=api_classify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        const values = extractGhostValues(result, fieldKey);
        if (!values.length) {
            toast('warning', `No AACR2-ready suggestion returned for ${ghostTargets[fieldKey].label}.`);
            return;
        }
        ghostCache.set(fieldKey, values);
        renderGhostSuggestion(fieldKey, $element, values);
        toast('success', `${ghostTargets[fieldKey].label} ghost ready. Accept or refresh to use.`);
    }

    function renderGhostSuggestion(fieldKey, $element, values) {
        if (!values || !values.length) return;
        const label = ghostTargets[fieldKey]?.label || fieldKey;
        const formattedValues = values.map(v => `<li>${formatGhostValue(fieldKey, v)}</li>`).join('');
        const $ghost = $(`
            <div class="aacr2-ghost" data-field="${fieldKey}">
                <div><span class="ghost-pill">AI ghost</span> AACR2-ready ${label} suggestion</div>
                <ul style="margin: 6px 0 0 18px; padding: 0;">${formattedValues}</ul>
                <div class="ghost-actions">
                    <button class="btn btn-xs btn-success ghost-accept"><i class="fa fa-check"></i> Accept</button>
                    <button class="btn btn-xs btn-default ghost-refresh"><i class="fa fa-refresh"></i> Refresh</button>
                    <button class="btn btn-xs btn-link ghost-dismiss">Dismiss</button>
                </div>
            </div>
        `);
        $element.next('.aacr2-ghost').remove();
        $ghost.insertAfter($element);

        $ghost.find('.ghost-accept').off('click').on('click', function() {
            applyGhostValue(fieldKey, values[0], $element);
        });
        $ghost.find('.ghost-refresh').off('click').on('click', function() {
            ghostCache.delete(fieldKey);
            $ghost.remove();
            maybeShowGhostSuggestion(fieldKey, $element);
        });
        $ghost.find('.ghost-dismiss').off('click').on('click', function() {
            $ghost.remove();
            toast('info', `${label} ghost dismissed.`);
        });
    }

    function formatGhostValue(fieldKey, value) {
        const rules = getRules();
        const suffix = rules[fieldKey] ? rules[fieldKey].suffix : '';
        if (suffix) {
            const trimmedSuffix = (suffix || '').trim();
            if (!value.endsWith(suffix) && (!trimmedSuffix || !value.endsWith(trimmedSuffix))) {
                return `${value}${suffix}`;
            }
        }
        return value;
    }

    function applyGhostValue(fieldKey, value, $element) {
        if (!value) return;
        const formatted = formatGhostValue(fieldKey, value);
        $element.val(formatted);
        toast('success', `${ghostTargets[fieldKey]?.label || fieldKey} applied from ghost suggestion.`);
        $element.next('.aacr2-ghost').remove();
        handleFieldBlur.call($element[0]);
    }

    // Adjust consecutive subfields
    function handleConsecutiveSubfields() {
        if (!CONFIG.enabled && !(CONFIG.enforceAacr2Guardrails || CONFIG.enableLiveValidation)) return;
        debug('Checking and adjusting consecutive subfields');
        const title245a = $('#subfield245a, #tag_245_subfield_a, [id*="245"][id*="a"]');
        if (title245a.length) {
            const hasConsecutiveSubfields =
                $('#subfield245b, #tag_245_subfield_b, [id*="245"][id*="b"]').length ||
                $('#subfield245c, #tag_245_subfield_c, [id*="245"][id*="c"]').length ||
                $('#subfield245n, #tag_245_subfield_n, [id*="245"][id*="n"]').length ||
                $('#subfield245p, #tag_245_subfield_p, [id*="245"][id*="p"]').length;
            if (hasConsecutiveSubfields) {
                let titleValue = title245a.val();
                if (titleValue && titleValue.endsWith('.')) {
                    titleValue = titleValue.substring(0, titleValue.length - 1);
                    title245a.val(titleValue);
                    debug('Removed terminal period from 245$a due to subsequent subfields');
                }
            }
        }
        const extent300a = $('#subfield300a, #tag_300_subfield_a, [id*="300"][id*="a"]');
        if (extent300a.length) {
            const hasSubfieldB = $('#subfield300b, #tag_300_subfield_b, [id*="300"][id*="b"]').length;
            let extentValue = extent300a.val();
            if (extentValue) {
                if (hasSubfieldB && !extentValue.endsWith(' : ')) {
                    extentValue = extentValue.replace(/[.,:;!?]\s*$/, '');
                    extentValue += ' : ';
                    extent300a.val(extentValue);
                    debug('Added colon to 300$a due to presence of $b');
                } else if (!hasSubfieldB && !extentValue.endsWith('.')) {
                    extentValue = extentValue.replace(/[.,:;!?]\s*$/, '');
                    extentValue += '.';
                    extent300a.val(extentValue);
                    debug('Added period to 300$a as final subfield');
                }
            }
        }
    }

    // Apply event handlers
    function applyHandlersToFields() {
        if (!CONFIG.enabled && !(CONFIG.enforceAacr2Guardrails || CONFIG.enableLiveValidation)) return;
        debug('Applying event handlers to bibliographic fields');
        const fieldSelector = 'input[id^="tag_"], input[id^="subfield"], input[id*="tag"], input[id*="subfield"]';
        $(fieldSelector).off('focus.punctuation blur.punctuation');
        $(fieldSelector).each(function() {
            const inputId = $(this).attr('id');
            const parsedField = parseFieldId(inputId);
            if (parsedField) {
                const { tag, subfield } = parsedField;
                const fieldKey = tag + subfield;
                const rules = getRules();
                if ((rules[fieldKey] || ghostTargets[fieldKey]) && !isExcluded(tag, subfield)) {
                    debug(`Adding handlers to field ${fieldKey} (${inputId})`);
                    $(this).on('focus.punctuation', handleFieldFocus);
                    $(this).on('blur.punctuation', handleFieldBlur);
                }
            }
        });
        $(fieldSelector).on('change.punctuation', function() {
            const parsed = parseFieldId($(this).attr('id'));
            if (parsed && !isExcluded(parsed.tag, parsed.subfield)) {
                const suffix = getPunctuation(parsed.tag, parsed.subfield, 'suffix');
                validateField($(this), `${parsed.tag}${parsed.subfield}`, suffix, parsed.tag, parsed.subfield);
            }
            setTimeout(handleConsecutiveSubfields, 100);
            updateGuardrailStatus();
        });
        $('form[name="f"], #cat_addbiblio form').on('submit.punctuation', handleConsecutiveSubfields);
        updateGuardrailStatus();
    }

    // Disable buttons for excluded users
    function disableButtonsForExcludedUsers() {
        if (!isGuideExcluded && !isInternExcluded) {
            debug(`Buttons not disabled for user: ${loggedInUser}`);
            return;
        }

        debug(`Disabling buttons for excluded user: ${loggedInUser} ${isSuperLibrarian ? '(SuperLibrarian)' : ''}`);

        if (isGuideExcluded) {
            $('#punctuation-guide').prop('disabled', true).addClass('btn-disabled').css({
                'opacity': '0.5',
                'cursor': 'not-allowed'
            }).attr('title', 'This feature is disabled for your account due to training mode settings');
        }

        if (isInternExcluded) {
            const buttons = [
                '#punctuation-toggle',
                '#punctuation-standard',
                '#punctuation-ai'
            ];
            buttons.forEach(selector => {
                $(selector).prop('disabled', true).addClass('btn-disabled').css({
                    'opacity': '0.5',
                    'cursor': 'not-allowed'
                }).attr('title', 'This feature is disabled for your account due to training mode settings');
            });
        }
    }

    // Dynamic guide steps focused on AACR2 + LCC
    function getGuideSteps() {
        return [
            {
                field: null,
                tab: null,
                description: 'Welcome to the AACR2/LCC Intellisense guide. We focus on AACR2 punctuation, MARC21 placement, and Library of Congress call numbers for Koha catalogers.',
                example: '',
                action: 'none'
            },
            {
                field: '100a',
                tab: 'tab1XX_panel',
                description: 'Enter the main entry (100$a) with terminal period. This anchors name access for LCSH and LCC work.',
                example: 'Fitzgerald, F. Scott,',
                action: 'focus'
            },
            {
                field: '245a',
                tab: 'tab2XX_panel',
                description: 'Record the title proper (245$a). AACR2 adds a terminal period only when no $b/$c/$n/$p follow.',
                example: 'The great Gatsby',
                action: 'focus'
            },
            {
                field: '245c',
                tab: 'tab2XX_panel',
                description: 'Statement of responsibility (245$c) begins with " / " and ends with a period. Supports authority control and LCC cutters.',
                example: ' / F. Scott Fitzgerald.',
                action: 'focus'
            },
            {
                field: '250a',
                tab: 'tab2XX_panel',
                description: 'Edition statement (250$a) ends with a period when final. Use AACR2 abbreviations as required.',
                example: '2nd ed.',
                action: 'focus'
            },
            {
                field: '260a',
                tab: 'tab2XX_panel',
                description: 'Publication place (260$a) ends with a space-colon-space when $b or $c follow.',
                example: 'New York :',
                action: 'focus'
            },
            {
                field: '260b',
                tab: 'tab2XX_panel',
                description: 'Publisher (260$b) ends with comma-space when $c follows.',
                example: 'Scribner,',
                action: 'focus'
            },
            {
                field: '260c',
                tab: 'tab2XX_panel',
                description: 'Date of publication (260$c) ends with a period. Reinforces chronological element for LCC call numbers.',
                example: '1925.',
                action: 'focus'
            },
            {
                field: '300a',
                tab: 'tab3XX_panel',
                description: 'Extent (300$a) ends with colon-space when $b exists, otherwise with a period.',
                example: '180 p. :',
                action: 'focus'
            },
            {
                field: '520a',
                tab: 'tab5XX_panel',
                description: 'Summary note (520$a) ends with a period; provides language for AI subject proposals.',
                example: 'A portrait of the Jazz Age in decline.',
                action: 'focus'
            },
            {
                field: '650a',
                tab: 'tab6XX_panel',
                description: 'Topical subject (650$a) should end with double dashes for subdivisions. Aligns with LCSH and feeds call number cutters.',
                example: 'Wealth --',
                action: 'focus'
            },
            {
                field: '651a',
                tab: 'tab6XX_panel',
                description: 'Geographic subject (651$a) follows the same punctuation pattern as 650s.',
                example: 'Long Island (N.Y.) --',
                action: 'focus'
            },
            {
                field: '050a',
                tab: 'tab0XX_panel',
                description: 'Library of Congress Classification (050$a) call number suggestion lives here. Use the AI assistant to seed a classmark.',
                example: 'PS3511.I9 G7',
                action: 'focus'
            }
        ];
    }
    // Create guide dialog with proper close handlers
    function createGuideDialogHTML() {
        return `
            <div id="guide-dialog" class="modal fade" tabindex="-1" role="dialog" aria-labelledby="guideLabel">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <button type="button" class="close guide-close" aria-label="Close">
                                <span aria-hidden="true">×</span>
                            </button>
                            <h4 class="modal-title" id="guideLabel">Cataloging Training Guide (${CONFIG.catalogingStandard})</h4>
                        </div>
                        <div class="modal-body">
                            <p id="guide-description"></p>
                            <div id="guide-example-container" style="margin: 15px 0;">
                                <strong>Example:</strong>
                                <span id="guide-example" style="font-family: monospace; background: #f5f5f5; padding: 2px 4px; border-radius: 3px;"></span>
                            </div>
                            <div id="guide-progress" style="margin-bottom: 15px; padding: 8px; background: #e7f3ff; border-radius: 4px;"></div>
                        </div>
                        <div class="modal-footer">
                            <button id="guide-restart" class="btn btn-default">
                                <i class="fa fa-refresh"></i> Restart
                            </button>
                            <button id="guide-prev" class="btn btn-default">
                                <i class="fa fa-arrow-left"></i> Previous
                            </button>
                            <button id="guide-next" class="btn btn-primary">
                                Next <i class="fa fa-arrow-right"></i>
                            </button>
                            <button id="guide-close" class="btn btn-default guide-close">
                                <i class="fa fa-times"></i> Close
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // Make the guide dialog draggable
    function makeGuideDialogDraggable() {
        $("#guide-dialog .modal-content").draggable({
            handle: ".modal-header"
        });
    }

    // Start guide with improved functionality
    function startGuide() {    
        if (!CONFIG.enableGuide || isGuideExcluded) {
            debug('Guide disabled or user excluded, skipping');
            return;
        }
        
        let currentStep = 0;
        const steps = getGuideSteps();

        function updateGuide() {
            const step = steps[currentStep];
            $('#guide-description').text(step.description);

            const $exampleContainer = $('#guide-example-container');
            if (step.example) {
                $('#guide-example').text(step.example);
                $exampleContainer.show();
            } else {
                $exampleContainer.hide();
            }

            $('#guide-prev').prop('disabled', currentStep === 0);
            $('#guide-next').text(currentStep === steps.length - 1 ? 'Finish' : 'Next');

            const progressText = `Step ${currentStep + 1} of ${steps.length}`;
            const progressPercent = Math.round((currentStep + 1) / steps.length * 100);
            $('#guide-progress').html(`
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span><strong>${progressText}</strong></span>
                    <span>${progressPercent}% Complete</span>
                </div>
                <div style="background: #ddd; height: 6px; border-radius: 3px; margin-top: 5px;">
                    <div style="background: #337ab7; height: 100%; width: ${progressPercent}%; border-radius: 2px; transition: width 0.3s;"></div>
                </div>
            `);

            $('#guideLabel').text(`Cataloging Training Guide (${CONFIG.catalogingStandard})`);

            if (step.action === 'focus' && step.field) {
                // Navigate to the relevant tab
                if (step.tab) {
                    console.log(`Attempting to show tab: ${step.tab}`); // Debugging statement
                    const tabLink = $(`a[href="#${step.tab}"]`);
                    if (tabLink.length) {
                        tabLink.tab('show');
                        console.log(`Tab ${step.tab} shown successfully.`); // Debugging statement
                    } else {
                        console.log(`Tab ${step.tab} not found.`); // Debugging statement
                    }
                }

                // Focus on the relevant field
                const fieldSelector = `#subfield${step.field}, #tag_${step.field.slice(0, 3)}_subfield_${step.field.slice(3)}, [id*="${step.field.slice(0, 3)}"][id*="${step.field.slice(3)}"]`;
                const $field = $(fieldSelector);

                if ($field.length) {
                    setTimeout(() => {
                        $field.focus().addClass('guide-highlight');
                        setTimeout(() => $field.removeClass('guide-highlight'), 3000);
                    }, 300);
                    console.log(`Focused field ${step.field} successfully.`); // Debugging statement
                } else {
                    console.log(`Field ${step.field} not found in form.`); // Debugging statement
                }
            }
        }

        function closeGuide() {
            $('#guide-dialog').modal('hide');
            $('.guide-highlight').removeClass('guide-highlight');
            debug('Guide closed');
        }

        $('#guide-dialog').remove();
        $('body').append(createGuideDialogHTML());

        if (!$('#guide-highlight-css').length) {
            $('head').append(`
                <style id="guide-highlight-css">
                    .guide-highlight {
                        border: 2px solid #337ab7 !important;
                        box-shadow: 0 0 10px rgba(51, 122, 183, 0.5) !important;
                        transition: all 0.3s ease !important;
                    }
                    .btn-disabled {
                        background-color: #ccc !important;
                        border-color: #aaa !important;
                    }
                </style>
            `);
        }

        $('#guide-restart').off('click').on('click', function() {
            currentStep = 0;
            updateGuide();
            debug('Guide restarted');
        });

        $('#guide-prev').off('click').on('click', function() {
            if (currentStep > 0) {
                currentStep--;
                updateGuide();
                debug(`Moved to previous step: ${currentStep + 1}`);
            }
        });

        $('#guide-next').off('click').on('click', function() {
            if (currentStep < steps.length - 1) {
                currentStep++;
                updateGuide();
                debug(`Moved to next step: ${currentStep + 1}`);
            } else {
                closeGuide();
                debug('Guide completed');
            }
        });

        $('.guide-close').off('click').on('click', closeGuide);

        $('#guide-dialog').off('hidden.bs.modal').on('hidden.bs.modal', function() {
            $('.guide-highlight').removeClass('guide-highlight');
        });

        $(document).off('keydown.guide').on('keydown.guide', function(e) {
            if (e.keyCode === 27 && $('#guide-dialog').is(':visible')) {
                closeGuide();
            }
        });

        updateGuide();
        $('#guide-dialog').modal('show');
        debug('Guide started');
        
        // Make the guide dialog draggable
        makeGuideDialogDraggable();
    }

    // Improved AI classification with proper API integration
    async function applyAIClassification() {
        if (!CONFIG.llmApiKey || !CONFIG.enabled) {
            debug('AI classification skipped: no API key or disabled');
            return;
        }
        debug(`Applying AI classification using ${CONFIG.llmApiProvider}`);
        const data = collectAACR2Data();
        if (Object.keys(data).length === 0) {
            debug('No data to analyze for AI classification');
            return;
        }
        try {
            const response = await fetch(`${CONFIG.pluginPath}&method=api_classify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data)
            });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();

            if (result.error) {
                debug(`AI classification error: ${result.error}`);
                return;
            }
            debug(`AI classification response: ${JSON.stringify(result)}`);
            if (result.subjects && Array.isArray(result.subjects)) {
                result.subjects.forEach((subject, index) => {
                    const field = subject.type === 'topical' ? '650' : '651';
                    const $fieldA = $(`#subfield${field}a, #tag_${field}_subfield_a, [id*="${field}"][id*="a"]`).eq(index);
                    if ($fieldA.length && !$fieldA.val().trim()) {
                        $fieldA.val(subject.main);
                        handleFieldBlur.call($fieldA[0]);

                        if (subject.subdivisions && Array.isArray(subject.subdivisions)) {
                            ['x', 'y', 'z'].forEach((sub, i) => {
                                if (subject.subdivisions[i]) {
                                    const $subfield = $(`#subfield${field}${sub}, #tag_${field}_subfield_${sub}, [id*="${field}"][id*="${sub}"]`).eq(index);
                                    if ($subfield.length && !$subfield.val().trim()) {
                                        $subfield.val(subject.subdivisions[i]);
                                        handleFieldBlur.call($subfield[0]);
                                    }
                                }
                            });
                        }
                    }
                });
            }
            if (result.lcc && result.lcc.trim()) {
                const $field050a = $(`#subfield050a, #tag_050_subfield_a, [id*="050"][id*="a"]`);
                if ($field050a.length && !$field050a.val().trim()) {
                    $field050a.val(result.lcc);
                    handleFieldBlur.call($field050a[0]);
                }
            }
            if (result.call_number && result.call_number.trim()) {
                const $field092a = $(`#subfield092a, #tag_092_subfield_a, [id*="092"][id*="a"]`);
                if ($field092a.length && !$field092a.val().trim()) {
                    $field092a.val(result.call_number);
                    handleFieldBlur.call($field092a[0]);
                }
            }
            if (result.subjects || result.lcc || result.call_number) {
                const $notification = $('<div class="alert alert-info alert-dismissible" style="margin: 10px 0;">')
                    .html(`
                        <button type="button" class="close" data-dismiss="alert">×</button>
                        <strong>AI Classification Applied:</strong> Subjects and call numbers have been automatically inserted using ${CONFIG.llmApiProvider}. Review and modify as needed.
                    `).appendTo('body');
                setTimeout(() => $notification.fadeOut(), 5000);
            }
        } catch (error) {
            debug(`AI classification failed: ${error.message}`);
            console.error(error);
        }
    }

    // Collect AACR2-required MARC21 data for AI prompts
    function collectAACR2Data() {
        const pairs = [
            ['100', 'a'], ['110', 'a'], ['245', 'a'], ['245', 'b'], ['245', 'c'], ['250', 'a'],
            ['260', 'a'], ['260', 'b'], ['260', 'c'], ['300', 'a'], ['300', 'b'], ['300', 'c'],
            ['490', 'a'], ['520', 'a'], ['650', 'a'], ['651', 'a']
        ];
        const payload = {};
        pairs.forEach(([tag, sub]) => {
            const selector = `#subfield${tag}${sub}, #tag_${tag}_subfield_${sub}, input[name^="field_${tag}${sub}"], textarea[name^="field_${tag}${sub}"]`;
            const value = $(selector).first().val();
            if (value && value.trim()) {
                payload[`${tag}${sub}`] = value.trim();
            }
        });
        return payload;
    }

    // Floating AACR2/LCC window
    function renderFloatingAssistant() {
        if ($('#aacr2-intellisense').length) return;
        const html = `
            <div id="aacr2-intellisense" class="${CONFIG.enabled ? '' : 'collapsed'}">
                <header>
                    <h4>AACR2 · MARC21 · LCC</h4>
                    <div>
                        <small style="margin-right:10px; color:#cdd8ec;">by Duke Chijimaka Jonathan</small>
                        <button id="aacr2-intellisense-toggle" class="btn btn-xs btn-default" title="Collapse/expand">
                            <i class="fa fa-window-restore"></i>
                        </button>
                    </div>
                </header>
                <div class="body">
                    <div class="meta">Focused on AACR2-required, MARC21 fields for original cataloging. Uses AI to propose LCSH + LCC call numbers.</div>
                    <div id="aacr2-live-meta" class="meta">Guardrail status: pending...</div>
                    <div id="aacr2-intellisense-results" class="results">Ready for guidance. Populate 1XX/245/250/260/300/5XX/6XX fields then click Generate.</div>
                    <div class="tags">Endpoint: ${CONFIG.pluginPath ? 'Configured' : 'Missing plugin path'} · API: ${CONFIG.llmApiProvider || 'Not set'}</div>
                    <button id="aacr2-intellisense-run" class="btn btn-primary btn-sm" ${CONFIG.llmApiKey ? '' : 'disabled'}>
                        <i class="fa fa-magic"></i> Generate LCC + subjects
                    </button>
                </div>
            </div>`;
        $('body').append(html);
        $('#aacr2-intellisense-toggle').on('click', function() {
            $('#aacr2-intellisense').toggleClass('collapsed');
        });
        $('#aacr2-intellisense-run').on('click', runIntellisenseOverlay);
    }

    async function runIntellisenseOverlay() {
        const $results = $('#aacr2-intellisense-results');
        if (!CONFIG.llmApiKey) {
            $results.text('No AI provider configured. Add credentials in plugin settings.');
            return;
        }
        const payload = collectAACR2Data();
        if (Object.keys(payload).length === 0) {
            $results.text('Provide AACR2 core fields (100/245/250/260/300/520/650/651) before requesting guidance.');
            return;
        }
        $results.text('Requesting AACR2/LCC guidance...');
        try {
            const response = await fetch(`${CONFIG.pluginPath}&method=api_classify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            if (result.error) throw new Error(result.error);
            const subjects = (result.subjects || []).map(s => `<li>${s}</li>`).join('');
            const marcFields = (result.marc_fields || []).join(', ');
            $results.html(`
                <div><strong>LCC classmark:</strong> ${result.lcc || '—'}</div>
                <div><strong>Call number:</strong> ${result.call_number || '—'}</div>
                <div><strong>LCSH candidates:</strong><ul>${subjects || '<li>No subjects returned</li>'}</ul></div>
                <div><strong>MARC focus:</strong> ${marcFields || 'Not specified'}</div>
                <div><strong>Notes:</strong> ${result.notes || 'Review AACR2 punctuation before saving.'}</div>
            `);
        } catch (err) {
            $results.text(`AACR2/LCC assistant error: ${err.message}`);
        }
    }

    // Create toggle button HTML
    function createToggleButtonHTML() {
        return `
            <div id="punctuation-toolbar" class="punctuation-toolbar" style="background: #f5f5f5; padding: 8px; margin: 10px 0; border-radius: 4px; border: 1px solid #ddd;">
                <div class="btn-group" role="group" aria-label="Auto-Punctuation Controls">
                    <button id="punctuation-toggle" class="btn btn-sm ${CONFIG.enabled ? 'btn-success' : 'btn-danger'}"
                            aria-pressed="${CONFIG.enabled}" ${isInternExcluded ? 'disabled' : ''}
                            title="${CONFIG.enabled ? 'Click to toggle auto-punctuation off' : 'Click to enable auto-punctuation'}">
                        <i class="fa ${CONFIG.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                        Auto-Punctuation: ${CONFIG.enabled ? 'ON' : 'OFF'}
                    </button>
                    <span class="btn btn-sm btn-default" title="AACR2-only focus with MARC21/LCC guidance">
                        <i class="fa fa-book"></i> AACR2 · MARC21 · LCC
                    </span>
                    <button id="punctuation-guide" class="btn btn-sm btn-info"
                            title="Start interactive training guide"
                            ${CONFIG.enableGuide && !isGuideExcluded ? '' : 'disabled'}>
                        <i class="fa fa-graduation-cap"></i> Guide
                    </button>
                    <button id="punctuation-ai" class="btn btn-sm btn-warning"
                            title="Apply AI classification using ${CONFIG.llmApiProvider}"
                            ${CONFIG.llmApiKey && !isInternExcluded ? '' : 'disabled'}>
                        <i class="fa fa-magic"></i> AI Classify
                    </button>
                    <button id="punctuation-help" class="btn btn-sm btn-default"
                            title="Show Help">
                        <i class="fa fa-question-circle"></i> Help
                    </button>
                </div>
                ${isInternExcluded ? '<div style="margin-top: 5px;"><small style="color: red; font-weight: bold;"><i class="fa fa-info-circle"></i> Auto-punctuation disabled for training purposes</small></div>' : ''}
                <div id="aacr2-guardrail-status" class="aacr2-violation-hint" aria-live="polite">Guardrail status: pending...</div>
            </div>
        `;
    }

    // Create help dialog HTML
    function createHelpDialogHTML() {
        return `
            <div id="punctuation-help-dialog" class="modal fade" tabindex="-1" role="dialog" aria-labelledby="punctuationHelpLabel">
                <div class="modal-dialog modal-lg">
                    <div class="modal-content">
                        <div class="modal-header">
                            <button type="button" class="close help-close" aria-label="Close">
                                <span aria-hidden="true">×</span>
                            </button>
                            <h4 class="modal-title" id="punctuationHelpLabel">Auto-Punctuation Help</h4>
                        </div>
                        <div class="modal-body">
                            <div class="row">
                                <div class="col-md-6">
                                    <h5>About AutoPunctuation</h5>
                                    <p>This tool automatically inserts punctuation into MARC fields per <strong id="activeStandard">AACR2</strong> rules with LCC-focused prompts.</p>
                                    <h5>Key Features</h5>
                                    <ul>
                                        <li><strong>Prefix/Suffix:</strong> Punctuation added on field entry/exit</li>
                                        <li><strong>Smart adjustments:</strong> Handles field relationships</li>
                                        <li><strong>AACR2 support:</strong> Customizable MARC21 punctuation set</li>
                                        <li><strong>Training guide:</strong> Step-by-step learning</li>
                                        <li><strong>AI-driven classification:</strong> Subjects and call numbers via ${CONFIG.llmApiProvider}</li>
                                    </ul>
                                </div>
                                <div class="col-md-6">
                                    <h5>Current Settings</h5>
                                    <dl class="dl-horizontal">
                                        <dt>Status:</dt>
                                        <dd><span class="label ${CONFIG.enabled ? 'label-success' : 'label-danger'}">${CONFIG.enabled ? 'Enabled' : 'Disabled'}</span></dd>
                                        <dt>Standard:</dt>
                                        <dd id="activeStandardDisplay">AACR2 (locked)</dd>
                                        <dt>Guide:</dt>
                                        <dd><span class="label ${CONFIG.enableGuide && !isGuideExcluded ? 'label-success' : 'label-default'}">${CONFIG.enableGuide && !isGuideExcluded ? 'Available' : 'Unavailable'}</span></dd>
                                        <dt>AI:</dt>
                                        <dd><span class="label ${CONFIG.llmApiKey ? 'label-success' : 'label-default'}">${CONFIG.llmApiKey ? 'Configured' : 'Not configured'} (${CONFIG.llmApiProvider})</span></dd>
                                    </dl>
                                    <h5>Quick Tips</h5>
                                    <ul>
                                        <li>Toggle auto-punctuation on/off as needed</li>
                                        <li>Use the AACR2 guide for step-by-step training</li>
                                        <li>Manual edits override auto-punctuation</li>
                                    </ul>
                                </div>
                            </div>
                            <h5>Troubleshooting</h5>
                            <div class="alert alert-info">
                                <ul>
                                    <li><strong>Punctuation not applied:</strong> Check if auto-punctuation is enabled and field supported</li>
                                    <li><strong>Wrong punctuation:</strong> Edit manually - your changes will be preserved</li>
                                    <li><strong>Guide not working:</strong> Ensure permissions and feature enabled</li>
                                    <li><strong>AI not working:</strong> Contact administrator for configuration</li>
                                </ul>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-default help-close">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // Make the help dialog draggable
    function makeHelpDialogDraggable() {
        $("#punctuation-help-dialog .modal-content").draggable({
            handle: ".modal-header"
        });
    }

    // Close help dialog
    function closeHelpDialog() {
        $('#punctuation-help-dialog').modal('hide');
        debug('Help dialog closed');
    }

    // Add UI elements
    function addUIElements() {
        if (!$('#cat_addbiblio, form[name="f"]').length) {
            debug('No cataloging form found, skipping UI elements');
            return;
        }
        debug('Adding UI elements to page');
        $('.punctuation-toolbar').remove();
        const toggleButton = createToggleButtonHTML();
        const $target = $('#cat_addbiblio').length ? $('#cat_addbiblio') : $('form[name="f"]').first();
        $target.before(toggleButton);
        $('#punctuation-toggle').off('click').on('click', function() {
            if (isInternExcluded) return;

            CONFIG.enabled = !CONFIG.enabled;
            $(this).toggleClass('btn-success btn-danger');
            $(this).attr('aria-pressed', CONFIG.enabled);
            $(this).attr('title', CONFIG.enabled ? 'Click to toggle auto-punctuation off' : 'Click to enable auto-punctuation');
            $(this).html(`
                <i class="fa ${CONFIG.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                Auto-Punctuation: ${CONFIG.enabled ? 'ON' : 'OFF'}
            `);
            sessionStorage.setItem('punctuationHelperEnabled', CONFIG.enabled);
            sessionStorage.setItem('punctuationHelperLastUpdated', CONFIG.last_updated);
            if (CONFIG.enabled) {
                applyHandlersToFields();
            }
            debug(`Auto-punctuation toggled ${CONFIG.enabled ? 'ON' : 'OFF'}`);
        });
        $('#punctuation-guide').off('click').on('click', function() {
            if (CONFIG.enableGuide && !isGuideExcluded) {
                startGuide();
            }
        });
        $('#punctuation-ai').off('click').on('click', function() {
            if (CONFIG.llmApiKey && !isInternExcluded) {
                $(this).prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i> Processing...');
                applyAIClassification().finally(() => {
                    $(this).prop('disabled', false).html('<i class="fa fa-magic"></i> AI Classify');
                });
            }
        });
        $('#punctuation-help').off('click').on('click', function() {
            if (!$('#punctuation-help-dialog').length) {
                $('body').append(createHelpDialogHTML());
                bindHelpDialogEvents();
            }
            $('#punctuation-help-dialog').modal('show');
        });
        if (!$('#punctuation-help-dialog').length) {
            $('body').append(createHelpDialogHTML());
            bindHelpDialogEvents();
        }
        // Apply button disable logic
        disableButtonsForExcludedUsers();
    }

    function bindHelpDialogEvents() {        
        $('.help-close').off('click').on('click', closeHelpDialog);
        $('#punctuation-help-dialog').off('hidden.bs.modal').on('hidden.bs.modal', closeHelpDialog);  
           
        // Make the help dialog draggable
        makeHelpDialogDraggable();
    }

    // Observe DOM
    function observeDOM() {
        if (!CONFIG.enabled && !(CONFIG.enforceAacr2Guardrails || CONFIG.enableLiveValidation)) return;
        const targetNode = document.getElementById('cat_addbiblio') ||
                          document.querySelector('form[name="f"]') ||
                          document.body;
        if (!targetNode) {
            debug('No target node found for DOM observation');
            return;
        }
        debug(`Setting up DOM observer for ${targetNode.id || targetNode.tagName}`);
        const observer = new MutationObserver(function(mutations) {
            let shouldUpdate = false;
            mutations.forEach(function(mutation) {
                if (mutation.type === 'childList' && mutation.addedNodes.length) {
                    for (let i = 0; i < mutation.addedNodes.length; i++) {
                        const node = mutation.addedNodes[i];
                        if (node.nodeType === 1 && (
                            node.id?.includes('tag_') ||
                            node.id?.includes('subfield') ||
                            $(node).find('[id*="tag_"], [id*="subfield"]').length ||
                            $(node).find('#logged-in-info-full').length ||
                            $(node).find('[class*="loggedinusernam"]').length
                        )) {
                            shouldUpdate = true;
                            break;
                        }
                    }
                }
            });
            if (shouldUpdate) {
                debug('Detected new fields or login info added to the DOM, reapplying handlers');
                setTimeout(() => {
                    applyHandlersToFields();
                    disableButtonsForExcludedUsers();
                }, 100);
            }
        });
        const config = { childList: true, subtree: true };
        observer.observe(targetNode, config);
        debug('DOM observer started');
        return observer;
    }

    // Initialize
    function init() {
        debug('Initializing AACR2 MARC21 LCC Intellisense v1.3.0');
        loadSessionPreferences();
        addUIElements();
        renderFloatingAssistant();
        applyHandlersToFields();
        updateGuardrailStatus();
        setInterval(updateGuardrailStatus, 2000);
        observeDOM();
        debug(`Initialization complete. Enabled: ${CONFIG.enabled}, Standard: ${CONFIG.catalogingStandard}, User: ${loggedInUser}, SuperLibrarian: ${isSuperLibrarian}`);
    }

    if ($('#cat_addbiblio, form[name="f"], #record').length) {
        debug('On cataloging page, initializing Auto-Punctuation Plugin');
        init();
    } else {
        debug('Not on a cataloging page, plugin idle');
    }
});

