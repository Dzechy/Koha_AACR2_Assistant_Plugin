/**
 * Auto-Insert Punctuation for Koha Bibliographic Fields
 * =====================================================
 * This plugin automatically inserts punctuation marks in MARC fields according to
 * cataloging standards (AACR2, RDA), with interactive training, custom rules,
 * internship mode, and AI-driven classification.
 *
 * Part of the Koha Auto-Punctuation Plugin v1.2.5
 * Updated to apply exclusions to both superlibrarian and regular users
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
        llmApiProvider: 'OpenAI',
        llmApiKey: '',
        last_updated: '2025-06-20 12:56:22',
        pluginPath: '/cgi-bin/koha/plugins/run.pl?class=Koha::Plugin::Cataloging::AutoPunctuation'
    };

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
        const savedStandard = sessionStorage.getItem('punctuationHelperStandard');
        if (savedStandard) {
            CONFIG.catalogingStandard = savedStandard;
            debug(`Loaded session preference for standard: ${CONFIG.catalogingStandard}`);
        }
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
        },
        'RDA': {
            '245a': { prefix: '', suffix: '.' },
            '245b': { prefix: ' : ', suffix: '' },
            '245c': { prefix: ' / ', suffix: '' },
            '245n': { prefix: '. ', suffix: '' },
            '245p': { prefix: ', ', suffix: '' },
            '264a': { prefix: '', suffix: ' : ' },
            '264b': { prefix: '', suffix: '' },
            '264c': { prefix: '', suffix: '' },
            '336a': { prefix: '', suffix: '' },
            '337a': { prefix: '', suffix: '' },
            '338a': { prefix: '', suffix: '' },
            '300a': { prefix: '', suffix: ' : ' },
            '300b': { prefix: '', suffix: ' ; ' },
            '300c': { prefix: '', suffix: '' },
            '490a': { prefix: '', suffix: ' ; ' },
            '500a': { prefix: '', suffix: '' },
            '502a': { prefix: '', suffix: '' },
            '504a': { prefix: '', suffix: '' },
            '505a': { prefix: '', suffix: '' },
            '520a': { prefix: '', suffix: '' },
            '650a': { prefix: '', suffix: ' -- ' },
            '650x': { prefix: '', suffix: ' -- ' },
            '650y': { prefix: '', suffix: ' -- ' },
            '650z': { prefix: '', suffix: '' },
            '651a': { prefix: '', suffix: ' -- ' },
            '651x': { prefix: '', suffix: ' -- ' },
            '651y': { prefix: '', suffix: ' -- ' },
            '651z': { prefix: '', suffix: '' },
            '100a': { prefix: '', suffix: '' },
            '100d': { prefix: ', ', suffix: '' },
            '100e': { prefix: ', ', suffix: '' },
            '700a': { prefix: '', suffix: '' },
            '700d': { prefix: ', ', suffix: '' },
            '700e': { prefix: ', ', suffix: '' },
            '110a': { prefix: '', suffix: '' },
            '110b': { prefix: '. ', suffix: '' },
            '710a': { prefix: '', suffix: '' },
            '710b': { prefix: '. ', suffix: '' },
            '111a': { prefix: '', suffix: '' },
            '111c': { prefix: ' (', suffix: ')' },
            '111d': { prefix: ' (', suffix: ')' },
            '711a': { prefix: '', suffix: '' },
            '711c': { prefix: ' (', suffix: ')' },
            '711d': { prefix: ' (', suffix: ')' },
            '240a': { prefix: '', suffix: '' },
            '250a': { prefix: '', suffix: '' },
            '020a': { prefix: '', suffix: ' ' },
            '022a': { prefix: '', suffix: ' ' }
        }
    };

    // Merge custom rules with default rules
    let punctuationRules = {};
    try {
        punctuationRules = {
            AACR2: { ...defaultPunctuationRules.AACR2, ...(customRules.AACR2 || {}) },
            RDA: { ...defaultPunctuationRules.RDA, ...(customRules.RDA || {}) }
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
        if (!CONFIG.enabled) return;
        const inputId = $(this).attr('id');
        const parsedField = parseFieldId(inputId);
        if (!parsedField) return;
        const { tag, subfield } = parsedField;
        const fieldKey = tag + subfield;
        const rules = getRules();
        if (!rules[fieldKey]) {
            debug(`No rules for field ${fieldKey}, skipping`);
            return;
        }
        originalValues[inputId] = $(this).val();
        if ($(this).val() === '' && rules[fieldKey].prefix) {
            debug(`Adding prefix "${rules[fieldKey].prefix}" to ${fieldKey}`);
            $(this).val(rules[fieldKey].prefix);
            if (this.setSelectionRange) {
                const prefixLength = rules[fieldKey].prefix.length;
                this.setSelectionRange(prefixLength, prefixLength);
                $(this).attr('aria-live', 'polite');
                setTimeout(() => $(this).removeAttr('aria-live'), 1000);
            }
        }
    }

    // Handle field blur
    function handleFieldBlur(event) {
        if (!CONFIG.enabled) return;
        const inputId = $(this).attr('id');
        const parsedField = parseFieldId(inputId);
        if (!parsedField) return;
        const { tag, subfield } = parsedField;
        const fieldKey = tag + subfield;
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
    }

    // Adjust consecutive subfields
    function handleConsecutiveSubfields() {
        if (!CONFIG.enabled) return;
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
        if (CONFIG.catalogingStandard === 'RDA') {
            debug('Applying RDA-specific adjustments');
            const date264c = $('#subfield264c, #tag_264_subfield_c, [id*="264"][id*="c"]');
            if (date264c.length) {
                let dateValue = date264c.val();
                if (dateValue && dateValue.endsWith('.')) {
                    dateValue = dateValue.substring(0, dateValue.length - 1);
                    date264c.val(dateValue);
                    debug('Removed terminal period from 264$c per RDA rules');
                }
            }
        }
    }

    // Apply event handlers
    function applyHandlersToFields() {
        if (!CONFIG.enabled) return;
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
                if (rules[fieldKey]) {
                    debug(`Adding handlers to field ${fieldKey} (${inputId})`);
                    $(this).on('focus.punctuation', handleFieldFocus);
                    $(this).on('blur.punctuation', handleFieldBlur);
                }
            }
        });
        $(fieldSelector).on('change.punctuation', function() {
            setTimeout(handleConsecutiveSubfields, 100);
        });
        $('form[name="f"], #cat_addbiblio form').on('submit.punctuation', handleConsecutiveSubfields);
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

    // Dynamic guide steps that adapt to current standard
    function getGuideSteps() {
        const standard = CONFIG.catalogingStandard;
        const aacr2Steps = [
            {
                field: null,
                tab: null,
                description: 'Welcome to the AACR2 Cataloging Guide! Follow these steps to learn how to apply AACR2 punctuation rules across MARC fields. We\'ll cover areas 0-9.',
                example: '',
                action: 'none'
            },
            {
                field: '245a',
                tab: 'tab2XX_panel', // Ensure this matches the actual tab identifier in your HTML
                description: 'Enter the title proper (245$a). AACR2 adds a period if no subsequent subfields (e.g., $b, $c) are present.',
                example: 'The great Gatsby.',
                action: 'focus'
            },
            {
                field: '245b',
                tab: 'tab2XX_panel',
                description: 'Add a subtitle (245$b), preceded by a colon and space.',
                example: ' : a novel',
                action: 'focus'
            },
            {
                field: '245c',
                tab: 'tab2XX_panel',
                description: 'Enter the statement of responsibility (245$c), preceded by a slash and space, ending with a period.',
                example: ' / F. Scott Fitzgerald.',
                action: 'focus'
            },
            {
                field: '250a',
                tab: 'tab2XX_panel',
                description: 'Enter the edition statement (250$a), ending with a period.',
                example: '2nd ed.',
                action: 'focus'
            },
            {
                field: '260a',
                tab: 'tab2XX_panel',
                description: 'Enter the place of publication (260$a), followed by a colon and space.',
                example: 'New York :',
                action: 'focus'
            },
            {
                field: '260b',
                tab: 'tab2XX_panel',
                description: 'Enter the publisher (260$b), followed by a comma and space.',
                example: 'Scribner,',
                action: 'focus'
            },
            {
                field: '260c',
                tab: 'tab2XX_panel',
                description: 'Enter the publication date (260$c), ending with a period.',
                example: '1925.',
                action: 'focus'
            },
            {
                field: '300a',
                tab: 'tab3XX_panel',
                description: 'Enter the extent of item (300$a), followed by a colon if subsequent subfields exist, or a period if final.',
                example: '180 p. :',
                action: 'focus'
            },
            {
                field: '500a',
                tab: 'tab5XX_panel',
                description: 'Enter a general note (500$a), ending with a period.',
                example: 'Includes bibliographical references.',
                action: 'focus'
            },
            {
                field: '650a',
                tab: 'tab6XX_panel',
                description: 'Enter a topical subject heading (650$a), followed by a double dash.',
                example: 'American fiction --',
                action: 'focus'
            },
            {
                field: '100a',
                tab: 'tab1XX_panel',
                description: 'Enter the main entry personal name (100$a), ending with a period.',
                example: 'Fitzgerald, F. Scott.',
                action: 'focus'
            }
        ];

        const rdaSteps = [
            {
                field: null,
                tab: null,
                description: 'Welcome to the RDA Cataloging Guide! Follow these steps to learn how to apply RDA punctuation rules across MARC fields. We\'ll cover areas 0-9.',
                example: '',
                action: 'none'
            },
            {
                field: '245a',
                tab: 'tab2XX_panel',
                description: 'Enter the title proper (245$a). RDA adds a period if no subsequent subfields (e.g., $b, $c) are present.',
                example: 'The great Gatsby.',
                action: 'focus'
            },
            {
                field: '245b',
                tab: 'tab2XX_panel',
                description: 'Add a subtitle (245$b), preceded by a colon and space.',
                example: ' : a novel',
                action: 'focus'
            },
            {
                field: '245c',
                tab: 'tab2XX_panel',
                description: 'Enter the statement of responsibility (245$c), preceded by a slash and space, no terminal period in RDA.',
                example: ' / F. Scott Fitzgerald',
                action: 'focus'
            },
            {
                field: '250a',
                tab: 'tab2XX_panel',
                description: 'Enter the edition statement (250$a), no terminal period in RDA.',
                example: 'Second edition',
                action: 'focus'
            },
            {
                field: '264a',
                tab: 'tab2XX_panel',
                description: 'Enter the place of publication (264$a), followed by a colon and space.',
                example: 'New York :',
                action: 'focus'
            },
            {
                field: '264b',
                tab: 'tab2XX_panel',
                description: 'Enter the publisher (264$b), followed by a comma and space.',
                example: 'Scribner,',
                action: 'focus'
            },
            {
                field: '264c',
                tab: 'tab2XX_panel',
                description: 'Enter the publication date (264$c), no terminal period in RDA.',
                example: '2015',
                action: 'focus'
            },
            {
                field: '336a',
                tab: 'tab3XX_panel',
                description: 'Enter the content type (336$a), no punctuation in RDA.',
                example: 'text',
                action: 'focus'
            },
            {
                field: '337a',
                tab: 'tab3XX_panel',
                description: 'Enter the media type (337$a), no punctuation in RDA.',
                example: 'unmediated',
                action: 'focus'
            },
            {
                field: '338a',
                tab: 'tab3XX_panel',
                description: 'Enter the carrier type (338$a), no punctuation in RDA.',
                example: 'volume',
                action: 'focus'
            },
            {
                field: '300a',
                tab: 'tab3XX_panel',
                description: 'Enter the extent of item (300$a), followed by a colon if subsequent subfields exist, no period if final in RDA.',
                example: '180 pages :',
                action: 'focus'
            },
            {
                field: '500a',
                tab: 'tab5XX_panel',
                description: 'Enter a general note (500$a), no terminal period in RDA.',
                example: 'Includes bibliographical references',
                action: 'focus'
            },
            {
                field: '650a',
                tab: 'tab6XX_panel',
                description: 'Enter a topical subject heading (650$a), followed by a double dash.',
                example: 'American fiction --',
                action: 'focus'
            },
            {
                field: '100a',
                tab: 'tab1XX_panel',
                description: 'Enter the main entry personal name (100$a), no terminal period in RDA.',
                example: 'Fitzgerald, F. Scott',
                action: 'focus'
            }
        ];

        return standard === 'RDA' ? rdaSteps : aacr2Steps;
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
        const fieldsToAnalyze = ['245a', '245b', '245c', '520a'];
        const data = {};
        fieldsToAnalyze.forEach(field => {
            const selector = `#subfield${field}, #tag_${field.slice(0,3)}_subfield_${field.slice(3)}, [id*="${field.slice(0,3)}"][id*="${field.slice(3)}"]`;
            const value = $(selector).val() || '';
            if (value.trim()) data[field] = value.trim();
        });
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
            if (result.ddc && result.ddc.trim()) {
                const $field082a = $(`#subfield082a, #tag_082_subfield_a, [id*="082"][id*="a"]`);
                if ($field082a.length && !$field082a.val().trim()) {
                    $field082a.val(result.ddc);
                    handleFieldBlur.call($field082a[0]);
                }
            }
            if (result.call_number && result.call_number.trim()) {
                const $field092a = $(`#subfield092a, #tag_092_subfield_a, [id*="092"][id*="a"]`);
                if ($field092a.length && !$field092a.val().trim()) {
                    $field092a.val(result.call_number);
                    handleFieldBlur.call($field092a[0]);
                }
            }
            if (result.subjects || result.lcc || result.ddc || result.call_number) {
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
                    <button id="punctuation-standard" class="btn btn-sm btn-default"
                            title="Current cataloging standard: ${CONFIG.catalogingStandard}. Click to switch.">
                        <i class="fa fa-book"></i> ${CONFIG.catalogingStandard}
                    </button>
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
                                    <p>This tool automatically inserts punctuation into MARC fields per <strong id="activeStandard">${CONFIG.catalogingStandard}</strong> rules.</p>
                                    <h5>Key Features</h5>
                                    <ul>
                                        <li><strong>Prefix/Suffix:</strong> Punctuation added on field entry/exit</li>
                                        <li><strong>Smart adjustments:</strong> Handles field relationships</li>
                                        <li><strong>AACR2/RDA support:</strong> With custom rules</li>
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
                                        <dd id="activeStandardDisplay">${CONFIG.catalogingStandard}</dd>
                                        <dt>Guide:</dt>
                                        <dd><span class="label ${CONFIG.enableGuide && !isGuideExcluded ? 'label-success' : 'label-default'}">${CONFIG.enableGuide && !isGuideExcluded ? 'Available' : 'Unavailable'}</span></dd>
                                        <dt>AI:</dt>
                                        <dd><span class="label ${CONFIG.llmApiKey ? 'label-success' : 'label-default'}">${CONFIG.llmApiKey ? 'Configured' : 'Not configured'} (${CONFIG.llmApiProvider})</span></dd>
                                    </dl>
                                    <h5>Quick Tips</h5>
                                    <ul>
                                        <li>Toggle auto-punctuation on/off as needed</li>
                                        <li>Switch between AACR2 and RDA</li>
                                        <li>Use guide for step-by-step training</li>
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
        $('#punctuation-standard').off('click').on('click', function() {
            if (isInternExcluded) return;
            CONFIG.catalogingStandard = CONFIG.catalogingStandard === 'AACR2' ? 'RDA' : 'AACR2';
            $(this).html(`<i class="fa fa-book"></i> ${CONFIG.catalogingStandard}`);
            $(this).attr('title', `Current cataloging standard: ${CONFIG.catalogingStandard}. Click to switch.`);
            sessionStorage.setItem('punctuationHelperStandard', CONFIG.catalogingStandard);
            sessionStorage.setItem('punctuationHelperLastUpdated', CONFIG.last_updated);
            if (CONFIG.enabled) {
                applyHandlersToFields();
            }
            if ($('#punctuation-help-dialog').is(':visible')) {
                $('#punctuation-help-dialog').remove();
                $('body').append(createHelpDialogHTML());
                bindHelpDialogEvents();
                $('#punctuation-help-dialog').modal('show');
            }
            debug(`Cataloging standard changed to ${CONFIG.catalogingStandard}`);
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
        if (!CONFIG.enabled) return;
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
        debug('Initializing Auto-Punctuation Plugin v1.2.5');
        loadSessionPreferences();
        addUIElements();
        applyHandlersToFields();
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

