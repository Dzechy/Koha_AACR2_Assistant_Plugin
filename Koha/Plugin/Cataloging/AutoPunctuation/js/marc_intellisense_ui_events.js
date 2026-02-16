        }
        const normalizedSubjects = normalizeSubjectObjects(subjects || []);
        if (state && state.aiSuggestions) {
            state.aiSuggestions.subjects = normalizedSubjects;
        }
        if (state && state.readOnly) {
            toast('warning', 'Auto-apply disabled for training.');
            return;
        }
        const replace = $panel.find('#aacr2-ai-subjects-replace').is(':checked');
        const existingSignatures = collectExistingSubjectSignatures();
        if (replace) {
            if (!confirm('Replace existing subject fields for these tags? This cannot be undone.')) return;
            const tags = Array.from(new Set(normalizedSubjects.map(sub => sub.tag || '650')));
            clearSubjectFields(tags);
            existingSignatures.clear();
        }
        let applied = 0;
        let duplicates = 0;
        let failed = 0;
        normalizedSubjects.forEach(subject => {
            const result = applySubjectObject(subject, settings, state, {
                replace,
                existingSignatures,
                allowTagFallback: true
            });
            if (result && result.ok) {
                applied += 1;
            } else if (result && result.reason === 'duplicate') {
                duplicates += 1;
            } else {
                failed += 1;
            }
        });
        if (!applied) {
            if (duplicates && !failed) {
                toast('info', 'Suggested subjects are already present; nothing new was applied.');
            } else {
                toast('warning', 'Unable to apply subjects automatically. Ensure at least one 6xx subject field is available and retry.');
            }
            return;
        }
        refreshAll(settings);
        let message = `Applied ${applied} subject heading${applied > 1 ? 's' : ''}.`;
        if (duplicates) message += ` Skipped ${duplicates} duplicate${duplicates > 1 ? 's' : ''}.`;
        if (failed) message += ` ${failed} suggestion${failed > 1 ? 's' : ''} could not be applied automatically.`;
        toast(failed ? 'warning' : 'info', message);
    }

    function applyAiSubjectByIndex(settings, state, index) {
        const subjects = normalizeSubjectObjects((state && state.aiSuggestions ? state.aiSuggestions.subjects || [] : []) || []);
        if (!subjects.length) {
            toast('info', 'No subject headings to apply.');
            return false;
        }
        const subject = subjects[index];
        if (!subject) {
            toast('warning', 'Selected subject suggestion is no longer available.');
            return false;
        }
        if (state && state.readOnly) {
            toast('warning', 'Auto-apply disabled for training.');
            return false;
        }
        const $panel = $('#aacr2-ai-panel');
        const replace = $panel.find('#aacr2-ai-subjects-replace').is(':checked');
        const existingSignatures = collectExistingSubjectSignatures();
        if (replace) {
            if (!confirm('Replace existing subject fields for this tag? This cannot be undone.')) return false;
            clearSubjectFields([subject.tag || '650']);
            existingSignatures.clear();
        }
        const result = applySubjectObject(subject, settings, state, {
            replace,
            existingSignatures,
            allowTagFallback: true
        });
        if (!result || !result.ok) {
            if (result && result.reason === 'duplicate') {
                toast('info', 'This subject is already present.');
            } else {
                toast('warning', 'Unable to apply the selected subject automatically. Ensure a 6xx subject field is available and retry.');
            }
            return false;
        }
        refreshAll(settings);
        toast('info', 'Applied 1 subject heading.');
        return true;
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
                    'If $a is last, add "." unless it already ends with . ? ! ] ).',
                    'Replace ellipses in the title with a dash.',
                    'Do not normalize bracket style automatically.'
                ],
                examples: [
                    { before: 'The great Gatsby', after: 'The great Gatsby.' },
                    { before: 'Who are you?', after: 'Who are you?' },
                    { before: 'When a line bends... a shape begins', after: 'When a line bends- a shape begins' }
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
                id: 'tg-245-h-tier3',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 3',
                title: '245 $h GMD handling',
                tag: '245',
                code: 'h',
                text: 'Do not auto-insert or normalize GMD brackets unless local policy explicitly requires it.',
                tree: [
                    'Treat $h content as entered by cataloger/local practice.',
                    'Do not auto-wrap text in [ ] in this plugin layer.',
                    'Preserve existing punctuation unless a local rule is configured.'
                ],
                examples: [
                    { before: '[videorecording]', after: '[videorecording]' }
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
                id: 'tg-246-a-tier2',
                module: 'Title & Statement (245/246)',
                tier: 'Tier 2',
                title: '246 variant title',
                tag: '246',
                code: 'a',
                ruleId: 'AACR2_TITLE_246A_001',
                text: 'Variant title punctuation is intentionally light-touch.',
                tree: [
                    'Do not force terminal punctuation in 246 by default.',
                    'If display text in $i ends with ":" this is display behavior, not MARC subfield punctuation.',
                    'Apply local policy manually where needed.'
                ],
                examples: [
                    { before: 'Great Gatsby', after: 'Great Gatsby' }
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
                    'Apply the same dependency checks for 260/264 $a/$b, 300 $a/$b/$c/$e, 490 $a/$v, and 6xx subdivisions.',
                    'Do not double-punctuate when punctuation already exists at boundaries.'
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
                    'If no $b/$c but $e follows, end $a with " + ".',
                    'If $a is last, end with ".".'
                ],
                examples: [
                    { before: 'xii, 180 p', after: 'xii, 180 p.' },
                    { before: 'xii, 180 p', after: 'xii, 180 p :' },
                    { before: '1 volume', after: '1 volume +' },
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
                    'If $e follows and $c is absent, end with " + ".',
                    'If $b is last, end with ".".'
                ],
                examples: [
                    { before: 'ill', after: ' : ill.' },
                    { before: 'maps', after: ' : maps ;' },
                    { before: 'illustrations', after: ' : illustrations +' },
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
                    'If $e follows, end $c with " + ".',
                    'If $c is last, end with ".".'
                ],
                examples: [
                    { before: '24 cm', after: '24 cm + 1 booklet.' },
                    { before: '23 cm', after: '23 cm.' },
                    { before: '28 cm', after: '28 cm.' }
                ]
            },
            {
                id: 'tg-300-e-tier1',
                module: 'Physical Description (300)',
                tier: 'Tier 1',
                title: '300 $e Accompanying material',
                tag: '300',
                code: 'e',
                ruleId: 'AACR2_PHYSICAL_300E_001',
                text: 'Accompanying material uses plus as the joining separator.',
                tree: [
                    'Use plus separator from the preceding subfield (typically 300$c).',
                    'If $e is last, end with ".".',
                    'Do not double-insert "+" if already present.'
                ],
                examples: [
                    { before: '1 booklet', after: '1 booklet.' }
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
                    'Order is: extent : other details ; dimensions + accompanying material.',
                    'Keep spacing around ":" ";" and "+".',
                    'End the final subfield with a period.'
                ],
                examples: [
                    { before: 'xii, 180 p : ill ; 23 cm + 1 booklet', after: 'xii, 180 p : ill. ; 23 cm + 1 booklet.' }
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
                id: 'tg-250-b-tier1',
                module: 'Edition (250)',
                tier: 'Tier 1',
                title: '250 $b Edition remainder',
                tag: '250',
                code: 'b',
                ruleId: 'AACR2_EDITION_250B_001',
                text: 'Edition remainder commonly follows with comma-space and ends with a period.',
                tree: [
                    'If $a precedes, prefix $b with ", ".',
                    'End final edition statement with ".".',
                    'Do not double-insert commas or periods.'
                ],
                examples: [
                    { before: 'rev. and expanded', after: ', rev. and expanded.' }
                ]
            },
            {
                id: 'tg-254-a-tier2',
                module: 'Other Descriptive Fields',
                tier: 'Tier 2',
                title: '254 $a Musical presentation',
                tag: '254',
                code: 'a',
                ruleId: 'AACR2_MUSICAL_254A_001',
                text: 'Musical presentation statements are usually treated like short notes.',
                tree: [
                    'When local policy allows, end with a terminal period.',
                    'Keep wording and qualifiers as entered.'
                ],
                examples: [
                    { before: 'Miniature score', after: 'Miniature score.' }
                ]
            },
            {
                id: 'tg-255-tier2',
                module: 'Other Descriptive Fields',
                tier: 'Tier 2',
                title: '255 cartographic data',
                tag: '255',
                code: 'a',
                ruleId: 'AACR2_CARTO_255_HANDSOFF_001',
                text: 'Cartographic mathematical data is format-specific; avoid automatic internal punctuation changes.',
                tree: [
                    'Do not normalize internal punctuation in 255 automatically.',
                    'Review manually according to cartographic cataloging practice.'
                ],
                examples: [
                    { before: 'Scale 1:24,000', after: 'Scale 1:24,000' }
                ]
            },
            {
                id: 'tg-340-tier2',
                module: 'Other Descriptive Fields',
                tier: 'Tier 2',
                title: '340 physical medium',
                tag: '340',
                code: 'a',
                ruleId: 'AACR2_PHYSICAL_340_HANDSOFF_001',
                text: '340 is treated as hands-off to avoid risky normalization.',
                tree: [
                    'Do not auto-ISBD-punctuate 340 subfields.',
                    'Use local/profile-specific review for this field.'
                ],
                examples: [
                    { before: 'paper', after: 'paper' }
                ]
            },
            {
                id: 'tg-336-338-tier2',
                module: 'Other Descriptive Fields',
                tier: 'Tier 2',
                title: '336/337/338 RDA content/media/carrier',
                tag: '336',
                code: 'a',
                ruleId: 'AACR2_NON_AACR2_336_001',
                text: 'These are not ISBD punctuation targets in this plugin baseline.',
                tree: [
                    'Do not add terminal punctuation by default.',
                    'Treat these as controlled vocabulary/coded-text fields.'
                ],
                examples: [
                    { before: 'text', after: 'text' }
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
                id: 'tg-8xx-hands-off-tier2',
                module: 'Series (440/490/8xx)',
                tier: 'Tier 2',
                title: '8xx controlled series access points',
                tag: '830',
                code: 'a',
                ruleId: 'AACR2_HEADINGS_HANDSOFF_001',
                text: '8xx fields are access points; do not force ISBD terminal punctuation.',
                tree: [
                    'Treat 8xx like other heading/access-point fields.',
                    'Avoid adding final periods unless explicitly part of established heading form.'
                ],
                examples: [
                    { before: 'Cambridge studies in cataloging', after: 'Cambridge studies in cataloging' }
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
                text: 'Subject headings should keep subdivisions distinct (x/y/z/v) without forced terminal punctuation.',
                tree: [
                    'Keep topical, chronological, geographic, and form subdivisions separate.',
                    'Avoid merging multiple unrelated subjects into one heading.',
                    'Do not force a terminal period for heading fields.'
                ],
                examples: [
                    { before: 'Women', after: 'Women -- History -- 20th century -- United States' },
                    { before: 'Children -- Books and reading', after: 'Children -- Books and reading -- Bibliography' }
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
                text: 'Personal name main entry should use inverted form with comma-space and usually no terminal punctuation.',
                tree: [
                    'Use surname first, then comma-space, then forename/initials (e.g., "Fitzgerald, F. Scott").',
                    'If multiple name parts are present with no comma, add comma-space after the surname.',
                    'Do not add a terminal period unless it is part of initials.'
                ],
                examples: [
                    { before: 'F. Scott Fitzgerald', after: 'Fitzgerald, F. Scott' },
                    { before: 'Fitzgerald,F. Scott', after: 'Fitzgerald, F. Scott' }
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
                text: 'Corporate headings are access points; avoid forcing terminal punctuation.',
                tree: [
                    'Maintain authorized heading form.',
                    'Do not force a final period for heading fields.'
                ],
                examples: [
                    { before: 'International Council of Museums', after: 'International Council of Museums' }
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
                text: 'Meeting headings are access points; avoid forcing terminal punctuation.',
                tree: [
                    'Maintain authorized heading form.',
                    'Do not force a final period for heading fields.'
                ],
                examples: [
                    { before: 'Symposium on Cataloging', after: 'Symposium on Cataloging' }
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
                text: 'Added personal name headings follow the same comma-space and no-forced-period pattern as 100$a.',
                tree: [
                    'Use surname, forename/initials form.',
                    'Avoid forcing a final period for heading fields.'
                ],
                examples: [
                    { before: 'Achebe Chinua', after: 'Achebe, Chinua' }
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
                text: 'Added corporate headings are access points; avoid forcing terminal punctuation.',
                tree: [
                    'Maintain authorized heading form.',
                    'Avoid forcing a final period for heading fields.'
                ],
                examples: [
                    { before: 'United Nations', after: 'United Nations' }
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
                text: 'Added meeting headings are access points; avoid forcing terminal punctuation.',
                tree: [
                    'Maintain authorized heading form.',
                    'Avoid forcing a final period for heading fields.'
                ],
                examples: [
                    { before: 'Annual Conference on Metadata', after: 'Annual Conference on Metadata' }
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
                    'Add terminal period to note statements.',
                    'Exclude complex note patterns (e.g., 505/533/534) from automatic normalization.'
                ],
                examples: [
                    { before: 'Includes bibliographical references', after: 'Includes bibliographical references.' }
                ]
            },
            {
                id: 'tg-notes-complex-tier3',
                module: 'Notes (5xx)',
                tier: 'Tier 3',
                title: '505/533/534 complex notes',
                tag: '505',
                code: 'a',
                ruleId: 'AACR2_NOTES_COMPLEX_HANDSOFF_001',
                text: 'Structured contents/reproduction notes are treated as hands-off to avoid breaking structure.',
                tree: [
                    'Do not auto-normalize internal punctuation for 505.',
                    'Do not auto-normalize prescribed punctuation patterns in 533/534.'
                ],
                examples: [
                    { before: 'pt. 1. Origins -- pt. 2. Methods', after: 'pt. 1. Origins -- pt. 2. Methods' }
                ]
            },
            {
                id: 'tg-identifiers-tier2',
                module: 'Identifiers & Access',
                tier: 'Tier 2',
                title: '020/022 identifiers',
                tag: '020',
                code: 'a',
                ruleId: 'AACR2_STDNUM_NO_PUNCT_001',
                text: 'Standard number fields should not be auto-punctuated.',
                tree: [
                    'Do not add periods/colons/commas to identifiers.',
                    'If trailing punctuation exists, remove it.'
                ],
                examples: [
                    { before: '9781234567890.', after: '9781234567890' }
                ]
            },
            {
                id: 'tg-041-tier2',
                module: 'Identifiers & Access',
                tier: 'Tier 2',
                title: '041 language code',
                tag: '041',
                code: 'a',
                ruleId: 'AACR2_LANG_041_HANDSOFF_001',
                text: '041 language code subfields are coded data; keep punctuation untouched.',
                tree: [
                    'Do not add punctuation in 041 subfields.',
                    'Keep language codes exactly as entered.'
                ],
                examples: [
                    { before: 'eng', after: 'eng' }
                ]
            },
            {
                id: 'tg-856-tier2',
                module: 'Identifiers & Access',
                tier: 'Tier 2',
                title: '856 electronic access',
                tag: '856',
                code: 'u',
                ruleId: 'AACR2_ACCESS_856_HANDSOFF_001',
                text: 'Do not auto-punctuate 856; punctuation can break URLs and access strings.',
                tree: [
                    'Keep URLs and link text untouched.',
                    'If a display period is needed, handle it in OPAC/template display logic.'
                ],
                examples: [
                    { before: 'https://example.org/resource?id=1', after: 'https://example.org/resource?id=1' }
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

    function getGuideProgressKey(settings) {
        const user = (settings && settings.currentUserId ? String(settings.currentUserId) : '').trim() || 'anonymous';
        const framework = (settings && settings.frameworkCode ? String(settings.frameworkCode) : '').trim() || 'default';
        return `aacr2GuideProgress:${user}:${framework}`;
    }

    function loadGuideProgress(steps, settings) {
        const key = getGuideProgressKey(settings);
        const signature = steps.map(step => step.key).join('|');
        let progress = { completed: {}, skipped: {}, currentIndex: 0, signature };
        try {
            const stored = (window.localStorage && window.localStorage.getItem(key))
                || (window.sessionStorage && window.sessionStorage.getItem(key))
                || '';
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
