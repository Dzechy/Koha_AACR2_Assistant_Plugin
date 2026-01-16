(function(global) {
    'use strict';

    const DEFAULT_RULES = Object.freeze({ rules: [] });

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
        return base.concat(legacyRulesToNew(custom));
    }

    function legacyRulesToNew(legacy) {
        if (!legacy || !legacy.AACR2) return [];
        const rules = [];
        Object.keys(legacy.AACR2).forEach(key => {
            const spec = legacy.AACR2[key] || {};
            const match = key.match(/^(\d{3})([a-z0-9])$/i);
            if (!match) return;
            rules.push({
                id: `CUSTOM_${match[1]}${match[2]}`,
                tag: match[1],
                subfields: [match[2]],
                severity: 'WARNING',
                rationale: 'Custom punctuation rule (legacy format).',
                checks: [{
                    type: 'punctuation',
                    prefix: spec.prefix || '',
                    suffix: spec.suffix || '',
                    suffix_mode: 'always',
                    severity: 'WARNING',
                    message: 'Apply custom AACR2 punctuation.'
                }],
                fixes: [{
                    label: 'Apply custom punctuation',
                    patch: [{ op: 'replace_subfield', value_template: '{{expected}}' }]
                }],
                examples: [{ before: '', after: '' }]
            });
        });
        return rules;
    }

    function indicatorMatch(value, ruleValue) {
        if (ruleValue === undefined || ruleValue === null || ruleValue === '') return true;
        if (ruleValue === '*') return true;
        if (Array.isArray(ruleValue)) return ruleValue.includes(value);
        return ruleValue === value;
    }

    function ruleMatches(rule, tag, subfield, ind1, ind2) {
        if (rule.tag && rule.tag !== tag) return false;
        if (rule.tag_pattern && !(new RegExp(rule.tag_pattern).test(tag))) return false;
        if (!indicatorMatch(ind1 || '', rule.ind1)) return false;
        if (!indicatorMatch(ind2 || '', rule.ind2)) return false;
        if (rule.subfields && Array.isArray(rule.subfields)) {
            return rule.subfields.map(code => code.toLowerCase()).includes(subfield.toLowerCase());
        }
        if (rule.subfield_pattern) {
            return new RegExp(rule.subfield_pattern).test(subfield);
        }
        return true;
    }

    function resolveSuffix(check, field, code) {
        const mode = check.suffix_mode || 'always';
        const following = check.when_following_subfields || [];
        let hasFollowing = false;
        if (Array.isArray(following) && field && Array.isArray(field.subfields)) {
            field.subfields.forEach(sub => {
                if (!sub || !sub.code || !sub.value) return;
                if (sub.code.toLowerCase() === code.toLowerCase()) return;
                if (following.map(x => x.toLowerCase()).includes(sub.code.toLowerCase())) {
                    hasFollowing = true;
                }
            });
        }
        if (mode === 'conditional_following') {
            return hasFollowing ? (check.suffix_if_following || '') : (check.suffix_if_last || check.suffix || '');
        }
        if (mode === 'when_following') {
            return hasFollowing ? (check.suffix_if_following || check.suffix || '') : '';
        }
        if (mode === 'when_last') {
            return hasFollowing ? '' : (check.suffix_if_last || check.suffix || '');
        }
        return check.suffix || '';
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

    function expectedValue(check, field, subfield) {
        let value = subfield.value || '';
        if (check.case_mode) {
            value = applyCaseMode(value, check.case_mode);
        }
        const prefix = resolvePrefix(check, field, subfield);
        const suffix = resolveSuffix(check, field, subfield.code);
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
        if (suffix) {
            const expectedTrim = expected.replace(/\s+$/, '');
            const suffixTrim = suffix.replace(/\s+$/, '');
            if (suffixTrim && expectedTrim.endsWith(suffixTrim)) {
                expected = expectedTrim;
                if (/\s$/.test(suffix) && !/\s$/.test(expected)) {
                    expected += ' ';
                }
                return expected;
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
        }
        return expected;
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

    function applyCheck(rule, check, field, subfield) {
        const value = (subfield.value || '').toString();
        if (!value.trim()) return null;
        let expected = value;
        if (check.type === 'punctuation') {
            expected = expectedValue(check, field, subfield);
        } else if (check.type === 'separator') {
            const sep = check.separator || ' -- ';
            expected = expected.replace(/[.,;:!?]+\s*$/, '');
            if (!expected.endsWith(sep)) expected += sep;
        } else if (check.type === 'no_terminal_punctuation') {
            expected = expected.replace(/[.,;:!?]+\s*$/, '');
        } else if (check.type === 'spacing') {
            expected = expected.replace(/\s{2,}/g, ' ');
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
            occurrence: field.occurrence || '',
            current_value: value,
            expected_value: expected,
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
        field.subfields.forEach(sub => {
            if (!sub || !sub.code) return;
            const matched = filterMatchedRules(rules.filter(rule => ruleMatches(rule, field.tag, sub.code, field.ind1, field.ind2)));
            matched.forEach(rule => matchedRuleIds.add(rule.id));
            matched.forEach(rule => {
                (rule.checks || []).forEach(check => {
                    const finding = applyCheck(rule, check, field, sub);
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
            field.subfields.forEach(sub => {
                const matched = filterMatchedRules(rules.filter(rule => ruleMatches(rule, field.tag, sub.code, field.ind1, field.ind2)));
                if (!matched.length && strictCoverage) {
                    findings.push({
                        severity: 'INFO',
                        code: 'AACR2_COVERAGE_MISSING',
                        message: `No AACR2 rule defined for ${field.tag}$${sub.code}; no punctuation assistance applied.`,
                        rationale: 'Strict coverage mode is enabled.',
                        tag: field.tag,
                        subfield: sub.code,
                        proposed_fixes: []
                    });
                }
                matched.forEach(rule => {
                    (rule.checks || []).forEach(check => {
                        const finding = applyCheck(rule, check, field, sub);
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
        DEFAULT_RULES
    };
})(window);
