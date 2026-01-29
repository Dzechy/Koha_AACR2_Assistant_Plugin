(function(global) {
    'use strict';

    const DEFAULT_RULES = Object.freeze({ rules: [] });
    const ruleWarnings = new Set();

    function warnRule(message) {
        if (!message || ruleWarnings.has(message)) return;
        ruleWarnings.add(message);
        if (global.AACR2RulesEngine && typeof global.AACR2RulesEngine.onWarning === 'function') {
            global.AACR2RulesEngine.onWarning(message);
        }
    }

    function safeRegExp(pattern, label) {
        if (!pattern) return null;
        if (pattern.length > 120) {
            warnRule(`${label} regex is too long or complex.`);
            return null;
        }
        if (/\([^)]*(?:\+|\*|\{\d+,?\d*\})[^)]*\)(?:\+|\*|\?|\{\d+,?\d*\})/.test(pattern)) {
            warnRule(`${label} regex is too complex.`);
            return null;
        }
        try {
            return new RegExp(pattern);
        } catch (err) {
            warnRule(`${label} regex is invalid.`);
            return null;
        }
    }

    function normalizeRules(rulePack, customRulesRaw) {
        const base = rulePack && rulePack.rules ? rulePack.rules.slice() : [];
        let custom = {};
        if (customRulesRaw) {
            try {
                custom = typeof customRulesRaw === 'string' ? JSON.parse(customRulesRaw) : customRulesRaw;
            } catch (err) {
                custom = {};
            }
        }
        if (custom.rules && Array.isArray(custom.rules)) {
            return base.concat(custom.rules);
        }
        return base;
    }

    function indicatorMatch(value, ruleValue) {
        if (ruleValue === undefined || ruleValue === null || ruleValue === '') return true;
        if (ruleValue === '*') return true;
        if (Array.isArray(ruleValue)) return ruleValue.includes(value);
        return ruleValue === value;
    }

    function ruleMatches(rule, tag, subfield, ind1, ind2) {
        if (rule.tag && rule.tag !== tag) return false;
        if (rule.tag_pattern) {
            const regex = safeRegExp(rule.tag_pattern, `Rule ${rule.id || 'unknown'} tag_pattern`);
            if (!regex || !regex.test(tag)) return false;
        }
        if (!indicatorMatch(ind1 || '', rule.ind1)) return false;
        if (!indicatorMatch(ind2 || '', rule.ind2)) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(code => code.toLowerCase()).includes(subfield.toLowerCase());
        }
        if (rule.subfield_pattern) {
            const regex = safeRegExp(rule.subfield_pattern, `Rule ${rule.id || 'unknown'} subfield_pattern`);
            if (!regex) return false;
            return regex.test(subfield);
        }
        return true;
    }

    function normalizeOccurrence(value) {
        if (value === undefined || value === null || value === '') return 0;
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    function resolveSuffix(check, field, code, index) {
        const mode = check.suffix_mode || 'always';
        const following = check.when_following_subfields || [];
        let hasFollowing = false;
        let prefixOverride = '';
        if (Array.isArray(following) && field && Array.isArray(field.subfields)) {
            const wanted = following.map(x => x.toLowerCase());
            const startIndex = typeof index === 'number' ? index + 1 : 0;
            for (let i = startIndex; i < field.subfields.length; i++) {
                const sub = field.subfields[i];
                if (!sub || !sub.code || !sub.value) continue;
                if (startIndex === 0 && sub.code.toLowerCase() === code.toLowerCase()) continue;
                if (wanted.includes(sub.code.toLowerCase())) {
                    hasFollowing = true;
                    if (!prefixOverride && Array.isArray(check.suffix_if_following_prefixes)) {
                        const trimmedValue = String(sub.value || '').trim();
                        check.suffix_if_following_prefixes.some(entry => {
                            if (!entry || !entry.prefix) return false;
                            const prefix = String(entry.prefix).trim();
                            if (!prefix) return false;
                            if (trimmedValue.startsWith(prefix)) {
                                prefixOverride = entry.suffix || '';
                                return true;
                            }
                            return false;
                        });
                    }
                    break;
                }
            }
        }
        if (mode === 'conditional_following') {
            const followingSuffix = prefixOverride || check.suffix_if_following || '';
            return { suffix: hasFollowing ? followingSuffix : (check.suffix_if_last || check.suffix || ''), hasFollowing, mode };
        }
        if (mode === 'when_following') {
            return { suffix: hasFollowing ? (check.suffix_if_following || check.suffix || '') : '', hasFollowing, mode };
        }
        if (mode === 'when_last') {
            return { suffix: hasFollowing ? '' : (check.suffix_if_last || check.suffix || ''), hasFollowing, mode };
        }
        return { suffix: check.suffix || '', hasFollowing, mode };
    }

    function resolvePrefix(check, field, subfield) {
        const mode = check.prefix_mode || 'always';
        const preceding = check.when_preceding_subfields || [];
        let hasPreceding = false;
        if (Array.isArray(preceding) && field && Array.isArray(field.subfields)) {
            const wanted = preceding.map(x => x.toLowerCase());
            for (const sub of field.subfields) {
                if (!sub || !sub.code) continue;
                if (sub === subfield) break;
                if (!sub.value) continue;
                if (wanted.includes(sub.code.toLowerCase())) {
                    hasPreceding = true;
                    break;
                }
            }
        }
        if (mode === 'conditional_preceding') {
            return hasPreceding ? (check.prefix_if_preceding || check.prefix || '') : (check.prefix_if_first || '');
        }
        if (mode === 'when_preceding') {
            return hasPreceding ? (check.prefix_if_preceding || check.prefix || '') : '';
        }
        if (mode === 'when_first') {
            return hasPreceding ? '' : (check.prefix_if_first || check.prefix || '');
        }
        return check.prefix || '';
    }

    function endsWithAny(value, endings) {
        if (!value || !Array.isArray(endings)) return false;
        return endings.some(end => end && value.endsWith(end));
    }

    function stripEndings(value, endings) {
        if (!value || !Array.isArray(endings)) return value || '';
        let text = value;
        endings.forEach(end => {
            if (!end) return;
            if (text.endsWith(end)) {
                text = text.slice(0, text.length - end.length);
            }
        });
        return text;
    }

    function normalizePunctuation(value) {
        let text = value || '';
        text = text.replace(/\s+([,!?\.\)])/g, '$1');
        text = text.replace(/([,;:])\s*([^\s\]\)\}])/g, '$1 $2');
        text = text.replace(/([^:])\/{2,}/g, '$1/');
        text = text.replace(/([:;\/])\1+/g, '$1');
        return text;
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function stripPrefixes(value, prefixes) {
        if (!value || !Array.isArray(prefixes)) return value || '';
        let text = value;
        prefixes.forEach(prefix => {
            if (!prefix) return;
            const trimmed = String(prefix).trim();
            if (!trimmed) return;
            const regex = new RegExp(`^\\s*${escapeRegExp(trimmed)}\\s*`);
            if (regex.test(text)) {
                text = text.replace(regex, '');
            }
        });
        return text;
    }

    function fieldHasSubfield(field, code) {
        if (!field || !Array.isArray(field.subfields)) return false;
        return field.subfields.some(sub => sub && sub.code && sub.value && sub.code.toLowerCase() === code.toLowerCase());
    }

    function nextSubfieldCode(field, index) {
        if (!field || !Array.isArray(field.subfields)) return '';
        for (let i = index + 1; i < field.subfields.length; i++) {
            const sub = field.subfields[i];
            if (sub && sub.code) return sub.code;
        }
        return '';
    }

    function previousSubfieldCode(field, index) {
        if (!field || !Array.isArray(field.subfields)) return '';
        for (let i = index - 1; i >= 0; i--) {
            const sub = field.subfields[i];
            if (sub && sub.code) return sub.code;
        }
        return '';
    }

    function repeatPolicyAllows(field, subfield, index, policy) {
        const mode = policy || 'all';
        if (mode === 'all') return true;
        const code = (subfield.code || '').toLowerCase();
        const indices = (field.subfields || [])
            .map((sub, idx) => (sub && sub.code && sub.code.toLowerCase() === code ? idx : -1))
            .filter(idx => idx >= 0);
        if (!indices.length) return true;
        if (mode === 'first_only') return index === indices[0];
        if (mode === 'last_only') return index === indices[indices.length - 1];
        return true;
    }

    function ruleApplies(rule, field, subfield, index) {
        if (!ruleMatches(rule, field.tag, subfield.code, field.ind1, field.ind2)) return false;
        if (Array.isArray(rule.requires_subfields)) {
            for (const code of rule.requires_subfields) {
                if (!fieldHasSubfield(field, code)) return false;
            }
        }
        if (Array.isArray(rule.forbids_subfields)) {
            for (const code of rule.forbids_subfields) {
                if (fieldHasSubfield(field, code)) return false;
            }
        }
        if (rule.next_subfield_is) {
            const allowed = Array.isArray(rule.next_subfield_is) ? rule.next_subfield_is : [rule.next_subfield_is];
            const next = nextSubfieldCode(field, index);
            if (!allowed.map(x => x.toLowerCase()).includes((next || '').toLowerCase())) return false;
        }
        if (rule.previous_subfield_is) {
            const allowed = Array.isArray(rule.previous_subfield_is) ? rule.previous_subfield_is : [rule.previous_subfield_is];
            const prev = previousSubfieldCode(field, index);
            if (!allowed.map(x => x.toLowerCase()).includes((prev || '').toLowerCase())) return false;
        }
        if (!repeatPolicyAllows(field, subfield, index, rule.repeat_policy)) return false;
        return true;
    }

    function expectedValue(check, field, subfield, index) {
        let value = subfield.value || '';
        if (check.replace_ellipses_with_dash) {
            value = value.replace(/\.\s*\.\s*\./g, '-');
            value = value.replace(/\.{3,}/g, '-');
        }
        if (check.replace_square_brackets_with_parentheses) {
            value = value.replace(/\[/g, '(').replace(/\]/g, ')');
        }
        if (Array.isArray(check.strip_prefixes)) {
            value = stripPrefixes(value, check.strip_prefixes);
        }
        if (Array.isArray(check.end_not_in)) {
            value = stripEndings(value, check.end_not_in);
        }
        if (check.case_mode) {
            value = applyCaseMode(value, check.case_mode);
        }
        let prefix = resolvePrefix(check, field, subfield);
        const suffixInfo = resolveSuffix(check, field, subfield.code, index);
        let suffix = suffixInfo.suffix;
        const condition = (suffixInfo.mode !== 'always' && Array.isArray(check.when_following_subfields))
            ? {
                type: 'conditional_suffix',
                mode: suffixInfo.mode,
                has_following: suffixInfo.hasFollowing,
                following_subfields: check.when_following_subfields.slice()
            }
            : null;
        const shouldTrimFollowing = suffixInfo.hasFollowing
            && suffixInfo.mode !== 'always'
            && check.trim_trailing_punct !== false;
        const trimmed = value.trim();
        if (check.parallel_prefix && trimmed.startsWith('=')) {
            prefix = check.parallel_prefix;
            value = value.replace(/^\s*=\s*/, '');
        }
        if (Array.isArray(check.end_in) && endsWithAny(value, check.end_in)) {
            suffix = '';
        }
        let expected = value.replace(/\s+$/, '');
        if (prefix) {
            const prefixTrim = prefix.replace(/^\s+/, '');
            const prefixCore = prefixTrim.replace(/\s+$/, '');
            if (!expected.startsWith(prefix)
                && (!prefixTrim || !expected.startsWith(prefixTrim))
                && (!prefixCore || !expected.startsWith(prefixCore))) {
                expected = prefix + expected;
            } else if (prefixTrim && expected.startsWith(prefixTrim) && !expected.startsWith(prefix)) {
                expected = expected.replace(prefixTrim, prefix);
            } else if (prefixCore && expected.startsWith(prefixCore) && !expected.startsWith(prefix)) {
                expected = expected.replace(prefixCore, prefix);
            }
        }
        let trimmedByFollowing = false;
        if (!suffix && shouldTrimFollowing) {
            const beforeTrim = expected;
            expected = expected.replace(/[\s.,;:!?]+$/, '');
            trimmedByFollowing = expected !== beforeTrim;
            if (trimmedByFollowing && condition) {
                condition.action = 'trim';
            }
        }
        let appliedSuffix = false;
        if (suffix) {
            const expectedTrim = expected.replace(/\s+$/, '');
            const suffixTrim = suffix.replace(/\s+$/, '');
            if (suffixTrim && expectedTrim.endsWith(suffixTrim)) {
                expected = expectedTrim;
                if (/\s$/.test(suffix) && !/\s$/.test(expected)) {
                    expected += ' ';
                }
                return { expected, condition };
            }
        }
        if (suffix && !expected.endsWith(suffix)) {
            let suffixToAdd = suffix;
            if (/^\s*\./.test(suffix) && /\.\s*$/.test(expected)) {
                suffixToAdd = suffix.replace(/^\s*\./, '');
                expected = expected.replace(/\s+$/, '');
            } else if (check.trim_trailing_punct !== false) {
                expected = expected.replace(/[\s.,;:!?]+$/, '');
            }
            expected += suffixToAdd;
            appliedSuffix = true;
        }
        if (check.normalize_punctuation) {
            expected = normalizePunctuation(expected);
        }
        if (condition && !condition.action && appliedSuffix) {
            condition.action = 'add';
        }
        return { expected, condition };
    }

    function applyCaseMode(value, mode) {
        const text = value || '';
        if (mode === 'lower') return text.toLowerCase();
        if (mode === 'sentence') return sentenceCase(text);
        if (mode === 'initial_upper') return initialUpper(text);
        if (mode === 'initial_lower') return initialLower(text);
        if (mode === 'title') return titleCase(text);
        return text;
    }

    function sentenceCase(text) {
        const lowered = (text || '').toLowerCase();
        return initialUpper(lowered);
    }

    function initialUpper(text) {
        const chars = text.split('');
        for (let i = 0; i < chars.length; i++) {
            if (/[A-Za-z]/.test(chars[i])) {
                chars[i] = chars[i].toUpperCase();
                break;
            }
        }
        return chars.join('');
    }

    function initialLower(text) {
        const chars = text.split('');
        for (let i = 0; i < chars.length; i++) {
            if (/[A-Za-z]/.test(chars[i])) {
                chars[i] = chars[i].toLowerCase();
                break;
            }
        }
        return chars.join('');
    }

    function titleCase(text) {
        return text.split(/\s+/).map(word => toTitleWord(word)).join(' ');
    }

    function toTitleWord(word) {
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

    function applyCheck(rule, check, field, subfield, index) {
        const value = (subfield.value || '').toString();
        if (!value.trim()) return null;
        let expected = value;
        let condition = null;
        if (check.type === 'punctuation') {
            const result = expectedValue(check, field, subfield, index);
            expected = result.expected;
            condition = result.condition;
        } else if (check.type === 'separator') {
            const sep = check.separator || ' -- ';
            expected = expected.replace(/[.,;:!?]+\s*$/, '');
            if (!expected.endsWith(sep)) expected += sep;
            if (check.normalize_punctuation) expected = normalizePunctuation(expected);
        } else if (check.type === 'no_terminal_punctuation') {
            expected = expected.replace(/[.,;:!?]+\s*$/, '');
        } else if (check.type === 'spacing') {
            expected = expected.replace(/\s{2,}/g, ' ');
        } else if (check.type === 'normalize_punctuation') {
            expected = normalizePunctuation(expected);
        } else if (check.type === 'fixed_field') {
            return null;
        }
        if (expected === value) return null;
        return {
            severity: check.severity || rule.severity || 'INFO',
            code: rule.id || 'AACR2_RULE',
            message: check.message || `AACR2 punctuation issue in ${field.tag}$${subfield.code}`,
            rationale: rule.rationale || '',
            tag: field.tag,
            subfield: subfield.code,
            occurrence: normalizeOccurrence(field.occurrence),
            current_value: value,
            expected_value: expected,
            condition,
            examples: rule.examples || [],
            proposed_fixes: [{
                label: (rule.fixes && rule.fixes[0] && rule.fixes[0].label) || 'Apply AACR2 punctuation',
                patch: [{
                    op: 'replace_subfield',
                    tag: field.tag,
                    code: subfield.code,
                    value: expected
                }]
            }]
        };
    }

    function filterMatchedRules(rules) {
        if (rules.length <= 1) return rules;
        const filtered = rules.filter(rule => !rule.only_when_no_other_rule);
        return filtered.length ? filtered : rules;
    }

    function validateField(field, settings, rules) {
        const findings = [];
        const matchedRuleIds = new Set();
        field.subfields.forEach((sub, index) => {
            if (!sub || !sub.code) return;
            const matched = filterMatchedRules(rules.filter(rule => ruleApplies(rule, field, sub, index)));
            matched.forEach(rule => matchedRuleIds.add(rule.id));
            matched.forEach(rule => {
                (rule.checks || []).forEach(check => {
                    const finding = applyCheck(rule, check, field, sub, index);
                    if (finding) findings.push(finding);
                });
            });
        });
        return {
            findings,
            coverage: {
                covered: matchedRuleIds.size > 0,
                rule_ids: Array.from(matchedRuleIds)
            }
        };
    }

    function validateRecord(record, settings, rules, strictCoverage) {
        const findings = [];
        record.fields.forEach(field => {
            field.subfields.forEach((sub, index) => {
                const matched = filterMatchedRules(rules.filter(rule => ruleApplies(rule, field, sub, index)));
                if (!matched.length && strictCoverage) {
                    findings.push({
                        severity: 'INFO',
                        code: 'AACR2_COVERAGE_MISSING',
                        message: `No AACR2 rule defined for ${field.tag}$${sub.code}; no punctuation assistance applied.`,
                        rationale: 'Strict coverage mode is enabled.',
                        tag: field.tag,
                        subfield: sub.code,
                        occurrence: normalizeOccurrence(field.occurrence),
                        proposed_fixes: []
                    });
                }
                matched.forEach(rule => {
                    (rule.checks || []).forEach(check => {
                        const finding = applyCheck(rule, check, field, sub, index);
                        if (finding) findings.push(finding);
                    });
                });
            });
        });
        return { findings };
    }

    function isFieldCovered(tag, subfield, ind1, ind2, rules) {
        return rules.some(rule => ruleMatches(rule, tag, subfield, ind1, ind2));
    }

    global.AACR2RulesEngine = {
        loadRules: normalizeRules,
        validateField,
        validateRecord,
        isFieldCovered,
        DEFAULT_RULES,
        getWarnings: () => Array.from(ruleWarnings),
        clearWarnings: () => ruleWarnings.clear(),
        onWarning: null
    };
})(window);
