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
