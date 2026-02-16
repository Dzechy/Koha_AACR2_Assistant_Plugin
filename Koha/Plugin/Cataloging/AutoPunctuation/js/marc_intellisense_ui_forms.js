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

    function buildFieldKey(meta) {
        if (!meta) return '';
        return `${meta.tag}$${meta.code}:${normalizeOccurrenceKey(meta.occurrence)}`;
    }

    function normalizeOccurrence(value) {
        if (value === undefined || value === null || value === '') return 0;
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    function normalizeOccurrenceKey(value) {
        return String(normalizeOccurrence(value));
    }

    function markFieldForRevalidation(state, meta) {
        if (!state || !state.revalidateAfterApply || !meta) return;
        state.revalidateAfterApply.add(buildFieldKey(meta));
    }

    function consumeRevalidation(state, meta) {
        if (!state || !state.revalidateAfterApply || !meta) return false;
        const key = buildFieldKey(meta);
        if (!state.revalidateAfterApply.has(key)) return false;
        state.revalidateAfterApply.delete(key);
        return true;
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

    function buildRuleDependencies(rules) {
        const dependencyMap = new Map();
        const addDependency = (tag, fromCode, toCode) => {
            if (!tag || !fromCode || !toCode) return;
            if (!dependencyMap.has(tag)) dependencyMap.set(tag, new Map());
            const byTag = dependencyMap.get(tag);
            if (!byTag.has(fromCode)) byTag.set(fromCode, new Set());
            byTag.get(fromCode).add(toCode);
        };
        (rules || []).forEach(rule => {
            if (!rule || !rule.tag) return;
            const tag = rule.tag;
            const targetCodes = Array.isArray(rule.subfields)
                ? rule.subfields.map(code => (code || '').toLowerCase())
                : [];
            const hasPattern = !targetCodes.length && rule.subfield_pattern;
            const dependencies = new Set();
            if (Array.isArray(rule.requires_subfields)) rule.requires_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
            if (Array.isArray(rule.forbids_subfields)) rule.forbids_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
            if (rule.next_subfield_is) {
                [].concat(rule.next_subfield_is).forEach(code => dependencies.add((code || '').toLowerCase()));
            }
            if (rule.previous_subfield_is) {
                [].concat(rule.previous_subfield_is).forEach(code => dependencies.add((code || '').toLowerCase()));
            }
            (rule.checks || []).forEach(check => {
                if (Array.isArray(check.when_following_subfields)) {
                    check.when_following_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
                }
                if (Array.isArray(check.when_preceding_subfields)) {
                    check.when_preceding_subfields.forEach(code => dependencies.add((code || '').toLowerCase()));
                }
            });
            if (!targetCodes.length && hasPattern) {
                addDependency(tag, '*', '*');
                dependencies.forEach(code => addDependency(tag, code, '*'));
                return;
            }
            if (!targetCodes.length) return;
            targetCodes.forEach(target => {
                addDependency(tag, target, target);
                dependencies.forEach(code => addDependency(tag, code, target));
            });
        });
        return dependencyMap;
    }

    function getDependentSubfields(state, tag, code) {
        if (!state || !state.ruleDependencies || !tag) return null;
        const byTag = state.ruleDependencies.get(tag);
        if (!byTag) return null;
        const deps = new Set();
        const direct = byTag.get(code);
        if (direct) direct.forEach(item => deps.add(item));
        const wildcard = byTag.get('*');
        if (wildcard) wildcard.forEach(item => deps.add(item));
        return deps.size ? deps : null;
    }

    function revalidateDependentSubfields(settings, state, meta, options) {
        if (!meta || !meta.tag || !meta.code) return;
        const deps = getDependentSubfields(state, meta.tag, (meta.code || '').toLowerCase());
        if (!deps || !deps.size) return;
        const opts = options || {};
        const visited = opts.visited || new Set();
        const occurrence = meta.occurrence || '';
        deps.forEach(code => {
            if (!code || code === '*' || code === (meta.code || '').toLowerCase()) return;
            const $field = findFieldElement(meta.tag, code, occurrence);
            if (!$field.length) return;
            const fieldMeta = parseFieldMeta($field[0]);
            if (!fieldMeta) return;
            const fieldKey = buildFieldKey(fieldMeta);
            if (visited.has(fieldKey)) return;
            visited.add(fieldKey);
            runFieldValidation($field[0], settings, state, {
                apply: opts.apply,
                skipDependents: false,
                visited,
                recordChange: opts.recordChange
            });
        });
    }

    function refreshGuideForChange(state, meta) {
        if (!state || !state.guideActive || !state.guideRefresh || !state.guideCurrentStep) return;
        const step = state.guideCurrentStep;
        if (!step || !step.tag) return;
        const tag = meta && meta.tag ? meta.tag : '';
        if (tag && tag !== step.tag && !(step.alternateTags || []).includes(tag)) return;
        const changedCode = meta && meta.code ? meta.code.toLowerCase() : '';
        const stepCode = (step.code || '').toLowerCase();
        if (!stepCode || !changedCode) {
            state.guideRefresh();
            return;
        }
        if (stepCode === changedCode) {
            state.guideRefresh();
            return;
        }
        const affected = getDependentSubfields(state, step.tag, changedCode);
        if (!affected) {
            state.guideRefresh();
            return;
        }
        if (affected.has(stepCode) || affected.has('*')) {
            state.guideRefresh();
        }
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
        const field = { tag, ind1: '', ind2: '', occurrence: normalizeOccurrenceKey(occurrence), subfields: [] };
        field.ind1 = findIndicatorValue(tag, 1, occurrence) || '';
        field.ind2 = findIndicatorValue(tag, 2, occurrence) || '';
        const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            field.subfields.push({ code: meta.code, value: $(this).val() || '' });
        });
        if (!field.subfields.length) return null;
        return field;
    }

    function prioritizeSubfield(fieldContext, primaryCode) {
        if (!fieldContext || !Array.isArray(fieldContext.subfields)) return fieldContext;
        const code = (primaryCode || '').toLowerCase();
        if (!code) return fieldContext;
        const subs = fieldContext.subfields.slice();
        const idx = subs.findIndex(sub => (sub.code || '').toLowerCase() === code);
        if (idx > 0) {
            const primary = subs.splice(idx, 1)[0];
            subs.unshift(primary);
        }
        return { ...fieldContext, subfields: subs };
    }

    function buildRecordContext() {
        const fields = {};
        const selector = 'input[id*="subfield"], input[id*="tag_"], textarea[id*="subfield"], textarea[id*="tag_"], select[id*="subfield"], select[id*="tag_"], input[name^="field_"], textarea[name^="field_"], select[name^="field_"]';
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            const key = `${meta.tag}:${normalizeOccurrenceKey(meta.occurrence)}`;
            if (!fields[key]) {
                fields[key] = { tag: meta.tag, ind1: '', ind2: '', occurrence: normalizeOccurrenceKey(meta.occurrence), subfields: [] };
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

    function buildAiRecordContext(meta, settings, state) {
        const mode = settings.aiContextMode || 'tag_only';
        if (mode === 'tag_only') return null;
        const record = filterRecordContext(buildRecordContext(), settings, state);
        const normalized = {
            fields: (record.fields || []).map(field => {
                return { ...field, occurrence: normalizeOccurrence(field.occurrence) };
            })
        };
        if (mode === 'full') return normalized;
        if (mode === 'tag_plus_neighbors') {
            const fields = normalized.fields || [];
            const normalizedTarget = normalizeOccurrence(meta.occurrence);
            const idx = fields.findIndex(f => f.tag === meta.tag && (f.occurrence || 0) === normalizedTarget);
            if (idx === -1) return { fields: [] };
            const subset = [];
            if (idx > 0) subset.push(fields[idx - 1]);
            subset.push(fields[idx]);
            if (idx < fields.length - 1) subset.push(fields[idx + 1]);
            return { fields: subset };
        }
        return normalized;
    }

    function shouldRedactValue(settings, state, tag, code, value) {
        if (settings.aiRedact856Querystrings && tag === '856' && (code || '').toLowerCase() === 'u') {
            if (value && /[?&]/.test(value)) return true;
        }
        const rules = (state && state.redactionRules) ? state.redactionRules : [];
        return rules.some(entry => {
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}[a-z0-9]$/i.test(entry)) return entry.toLowerCase() === `${tag}${code}`.toLowerCase();
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            return false;
        });
    }

    function redactTagContext(tagContext, settings, state) {
        if (!tagContext || typeof tagContext !== 'object') return {};
        const clone = { ...tagContext };
        if (Array.isArray(clone.subfields)) {
            clone.subfields = clone.subfields.map(sub => {
                const value = shouldRedactValue(settings, state, clone.tag, sub.code, sub.value)
                    ? '[REDACTED]'
                    : (sub.value || '');
                return { code: sub.code, value };
            });
        }
        return clone;
    }

    function redactRecordContext(recordContext, settings, state) {
        if (!recordContext || typeof recordContext !== 'object') return {};
        const fields = Array.isArray(recordContext.fields) ? recordContext.fields : [];
        return {
            fields: fields.map(field => {
                const subfields = Array.isArray(field.subfields) ? field.subfields : [];
                return {
                    ...field,
                    subfields: subfields.map(sub => {
                        const value = shouldRedactValue(settings, state, field.tag, sub.code, sub.value)
                            ? '[REDACTED]'
                            : (sub.value || '');
                        return { code: sub.code, value };
                    })
                };
            })
        };
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

    function isTagExcluded(settings, state, tag) {
        if (!settings.enableLocalFields && /^9\d\d$/.test(tag)) return true;
        if (settings.enableLocalFields && state.localAllowlist.length) {
            const allowed = state.localAllowlist.some(entry => {
                if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
                if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
                if (/^\d{3}$/i.test(entry)) return entry === tag;
                return false;
            });
            if (!allowed) return true;
        }
        return state.excludedTags.some(entry => {
            if (/^\dXX$/i.test(entry)) return new RegExp(`^${entry[0]}\\d\\d$`).test(tag);
            if (/^\d{3}$/i.test(entry)) return entry === tag;
            if (/^9XX$/i.test(entry)) return /^9\d\d$/.test(tag);
            return false;
        });
    }

    function updateFindingsForField(state, meta, findings) {
        const occurrenceKey = normalizeOccurrenceKey(meta.occurrence);
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
            const key = `${finding.tag}${finding.subfield}:${normalizeOccurrenceKey(finding.occurrence)}`;
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
            normalizeOccurrenceKey(finding.occurrence),
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

    const STATEMENT_CASE_FINDING_CODE = 'AACR2_STATEMENT_245C_CASE';
    const MAIN_ENTRY_NAME_COMMA_CODE = 'AACR2_100A_NAME_COMMA';
    const MAIN_ENTRY_NAME_COMMA_SPACING_CODE = 'AACR2_100A_COMMA_SPACING';
    const MAIN_ENTRY_NAME_TERMINAL_PERIOD_CODE = 'AACR2_100A_NO_TERMINAL_PERIOD';

    function isStatementCaseEnabled(settings) {
        return !!(settings && settings.enabled);
    }

    function isMainEntryNameGuardrailEnabled(settings) {
        return !!(settings && settings.enabled);
    }

    function normalizeMainEntryNameValue(value) {
        return (value || '')
            .toString()
            .replace(/\s*,\s*/g, ', ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function looksLikeInitialToken(token) {
        return /^[A-Za-z]\.$/.test((token || '').toString());
    }

    function looksLikeMultiNameWithoutComma(value) {
        const text = (value || '').toString().trim();
        if (!text || text.includes(',')) return false;
        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.length < 2) return false;
        const nameLike = tokens.filter(token => /^[A-Za-z][A-Za-z'.-]*$/.test(token) || looksLikeInitialToken(token));
        return nameLike.length >= 2;
    }

    function endsWithInitialPeriod(value) {
        const text = (value || '').toString().trim();
        if (!text) return false;
        if (/(?:^|[\s,])[A-Za-z]\.$/.test(text)) return true;
        return /(?:[A-Za-z]\.\s*){2,}$/.test(text);
    }

    function buildMainEntryNameCommaFinding(meta, current) {
        return {
            severity: 'ERROR',
            code: MAIN_ENTRY_NAME_COMMA_CODE,
            message: '100$a personal name must use inverted form with comma-space (Surname, Forename/initials).',
            rationale: 'Main entry personal names should separate surname and given names with ", ".',
            tag: meta.tag,
            subfield: meta.code,
            occurrence: normalizeOccurrenceKey(meta.occurrence),
            current_value: current,
            expected_value: '',
            proposed_fixes: []
        };
    }

    function buildMainEntryNameCommaSpacingFinding(meta, current, expected) {
        return {
            severity: 'WARNING',
            code: MAIN_ENTRY_NAME_COMMA_SPACING_CODE,
            message: 'Normalize comma spacing in 100$a to comma followed by one space.',
            rationale: 'Use ", " between surname and following name elements.',
            tag: meta.tag,
            subfield: meta.code,
            occurrence: normalizeOccurrenceKey(meta.occurrence),
            current_value: current,
            expected_value: expected,
            proposed_fixes: [{
                label: 'Normalize comma spacing',
                patch: [{
                    op: 'replace_subfield',
                    tag: meta.tag,
                    code: meta.code,
                    value: expected
                }]
            }]
        };
    }

    function buildMainEntryNameTerminalPeriodFinding(meta, current, expected) {
        return {
            severity: 'WARNING',
            code: MAIN_ENTRY_NAME_TERMINAL_PERIOD_CODE,
            message: 'Main entry headings generally should not end with terminal punctuation.',
            rationale: 'Remove a trailing terminal period unless it is part of an initial.',
            tag: meta.tag,
            subfield: meta.code,
            occurrence: normalizeOccurrenceKey(meta.occurrence),
            current_value: current,
            expected_value: expected,
            proposed_fixes: [{
                label: 'Remove terminal period',
                patch: [{
                    op: 'replace_subfield',
                    tag: meta.tag,
                    code: meta.code,
                    value: expected
                }]
            }]
        };
    }

    function updateMainEntryNameFindings(state, meta, findings) {
        if (!state || !meta) return;
        const key = `${meta.tag}${meta.code}:${normalizeOccurrenceKey(meta.occurrence)}`;
        const current = state.findings.get(key) || [];
        const filtered = current.filter(item => ![
            MAIN_ENTRY_NAME_COMMA_CODE,
            MAIN_ENTRY_NAME_COMMA_SPACING_CODE,
            MAIN_ENTRY_NAME_TERMINAL_PERIOD_CODE
        ].includes(item.code));
        (findings || []).forEach(item => {
            if (item) filtered.push(item);
        });
        state.findings.set(key, dedupeFindings(filtered));
    }

    function queueMainEntryPersonalNameValidation(fieldContext, settings, state) {
        if (!isMainEntryNameGuardrailEnabled(settings) || !fieldContext) return;
        if (fieldContext.tag !== '100') return;
        const occurrence = normalizeOccurrenceKey(fieldContext.occurrence);
        const subA = (fieldContext.subfields || []).find(sub => sub && (sub.code || '').toLowerCase() === 'a');
        if (!subA) return;
        if (isExcluded(settings, state, fieldContext.tag, 'a')) return;
        const current = (subA.value || '').toString();
        const trimmed = current.trim();
        const meta = { tag: '100', code: 'a', occurrence };
        if (!trimmed) {
            updateMainEntryNameFindings(state, meta, []);
            return;
        }
        const findings = [];
        if (looksLikeMultiNameWithoutComma(trimmed)) {
            findings.push(buildMainEntryNameCommaFinding(meta, current));
        }
        if (trimmed.includes(',')) {
            const expected = normalizeMainEntryNameValue(trimmed);
            if (expected && expected !== trimmed) {
                findings.push(buildMainEntryNameCommaSpacingFinding(meta, current, expected));
            }
        }
        if (/\.\s*$/.test(trimmed) && !endsWithInitialPeriod(trimmed)) {
            const expected = trimmed.replace(/\.\s*$/, '');
            if (expected && expected !== trimmed) {
                findings.push(buildMainEntryNameTerminalPeriodFinding(meta, current, expected));
            }
        }
        updateMainEntryNameFindings(state, meta, findings);
    }

    const STATEMENT_LOWER_WORDS = new Set([
        'by', 'edited', 'editor', 'editors', 'ed', 'eds', 'ed.',
        'illustrated', 'illustrator', 'illustrators', 'illus', 'illus.',
        'translated', 'translator', 'translators', 'trans', 'trans.',
        'compiled', 'compiler', 'compilers', 'comp', 'comp.',
        'adapted', 'adapter', 'adapters', 'arranged', 'arranger', 'arrangers',
        'selected', 'selection', 'introduction', 'preface', 'foreword', 'afterword',
        'commentary', 'notes', 'with', 'and', 'or', 'from', 'for', 'based', 'upon',
        'rev', 'revised', 'revision', 'abridged'
    ]);

    function titleCaseName(text) {
        return (text || '').split(/\s+/).map(word => toNameTitleWord(word)).join(' ');
    }

    function toNameTitleWord(word) {
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

    function normalizeStatementStopwords(text) {
        return (text || '').split(/\s+/).map(word => normalizeStatementWord(word)).join(' ');
    }

    function normalizeStatementWord(word) {
        if (!word) return word;
        const match = word.match(/^([("'\\[]*)([A-Za-z][A-Za-z'.-]*)([^A-Za-z]*)$/);
        if (!match) return word;
        const leading = match[1] || '';
        const core = match[2] || '';
        const trailing = match[3] || '';
        const lowered = core.toLowerCase();
        if (STATEMENT_LOWER_WORDS.has(lowered)) {
            return `${leading}${lowered}${trailing}`;
        }
        return word;
    }

    function applyStatementDecorations(original, normalized) {
        const raw = (original || '').toString();
        let expected = (normalized || '').toString().trim();
        if (!expected) return '';
        const prefixMatch = raw.match(/^\s*\/\s*/);
        if (prefixMatch && prefixMatch[0] && !expected.startsWith(prefixMatch[0])) {
            expected = prefixMatch[0] + expected;
        }
        const suffixMatch = raw.match(/[.?!]\s*$/);
        if (suffixMatch && suffixMatch[0]) {
            const suffix = suffixMatch[0].trim();
            if (suffix && !expected.endsWith(suffix)) {
                expected += suffix;
            }
        }
        return expected;
    }

    function buildStatementCaseFinding(meta, current, expected) {
        return {
            severity: 'WARNING',
            code: STATEMENT_CASE_FINDING_CODE,
            message: 'Normalize casing for statement of responsibility.',
            rationale: 'Local Title Case normalization suggests a different capitalization.',
            tag: meta.tag,
            subfield: meta.code,
            occurrence: normalizeOccurrenceKey(meta.occurrence),
            current_value: current,
            expected_value: expected,
            proposed_fixes: [{
                label: 'Normalize casing',
                patch: [{
                    op: 'replace_subfield',
                    tag: meta.tag,
                    code: meta.code,
                    value: expected
                }]
            }]
        };
    }

    function updateStatementCaseFinding(state, meta, finding) {
        if (!state || !meta) return;
        const key = `${meta.tag}${meta.code}:${normalizeOccurrenceKey(meta.occurrence)}`;
        const list = state.findings.get(key) || [];
        const filtered = list.filter(item => item.code !== STATEMENT_CASE_FINDING_CODE);
        if (finding) filtered.push(finding);
        state.findings.set(key, dedupeFindings(filtered));
    }

    function collectFindingsForField(state, tag, occurrence) {
        const list = [];
        if (!state || !state.findings) return list;
        const suffix = `:${normalizeOccurrenceKey(occurrence)}`;
        state.findings.forEach((items, key) => {
            if (key.startsWith(tag) && key.endsWith(suffix)) {
                items.forEach(item => list.push(item));
            }
        });
        return list;
    }

    function queueStatementCaseValidation(fieldContext, settings, state) {
        if (!isStatementCaseEnabled(settings) || !fieldContext) return;
        if (fieldContext.tag !== '245') return;
        const occurrence = normalizeOccurrenceKey(fieldContext.occurrence);
        fieldContext.subfields.forEach(sub => {
            if (!sub || (sub.code || '').toLowerCase() !== 'c') return;
            if (isExcluded(settings, state, fieldContext.tag, sub.code)) return;
            const meta = { tag: fieldContext.tag, code: sub.code, occurrence };
            scheduleStatementCaseCheck(meta, sub.value || '', settings, state);
        });
    }

    function queueStatementCaseRecordValidations(settings, state) {
        if (!isStatementCaseEnabled(settings) && !isMainEntryNameGuardrailEnabled(settings)) return;
        const record = buildRecordContext();
        (record.fields || []).forEach(field => {
            if (!field) return;
            const ctx = buildFieldContext(field.tag, field.occurrence || '');
            if (!ctx) return;
            if (field.tag === '245') {
                queueStatementCaseValidation(ctx, settings, state);
            }
            if (field.tag === '100') {
                queueMainEntryPersonalNameValidation(ctx, settings, state);
            }
        });
    }

    function scheduleStatementCaseCheck(meta, value, settings, state) {
        if (!state || !meta) return;
        const key = buildFieldKey(meta);
        const trimmed = (value || '').toString();
        if (!trimmed.trim()) {
            updateStatementCaseFinding(state, meta, null);
            updateSidePanel(state);
            updateGuardrails(settings, state);
            return;
        }
        if (state.statementCaseTimers.has(key)) {
            clearTimeout(state.statementCaseTimers.get(key));
        }
        const timer = setTimeout(() => {
            runStatementCaseCheck(meta, trimmed, settings, state);
        }, 250);
        state.statementCaseTimers.set(key, timer);
    }

    function runStatementCaseCheck(meta, value, settings, state) {
        if (!state || !meta) return;
        const key = buildFieldKey(meta);
        if (state.statementCaseTimers.has(key)) {
            clearTimeout(state.statementCaseTimers.get(key));
            state.statementCaseTimers.delete(key);
        }
        applyStatementCaseResult(meta, value, settings, state);
    }

    function applyStatementCaseResult(meta, requestedValue, settings, state) {
        const $field = findFieldElement(meta.tag, meta.code, meta.occurrence);
        if (!$field.length) return;
        const current = ($field.val() || '').toString();
        if (current !== requestedValue) return;
        const prefixMatch = current.match(/^\s*\/\s*/);
        const suffixMatch = current.match(/[.?!]\s*$/);
        let core = current;
        if (prefixMatch && prefixMatch[0]) {
            core = core.slice(prefixMatch[0].length);
        }
        if (suffixMatch && suffixMatch[0]) {
            core = core.slice(0, Math.max(0, core.length - suffixMatch[0].length));
        }
        const fallback = normalizeStatementStopwords(titleCaseName(core.trim()));
        let expectedCore = fallback || core.trim();
        if (meta.tag === '245' && meta.code === 'c') {
            expectedCore = normalizeStatementStopwords(expectedCore);
        }
        const expected = applyStatementDecorations(current, expectedCore);
        if (!expected || expected === current) {
            updateStatementCaseFinding(state, meta, null);
        } else {
            updateStatementCaseFinding(state, meta, buildStatementCaseFinding(meta, current, expected));
        }
        const fieldContext = buildFieldContext(meta.tag, meta.occurrence);
        if (fieldContext) {
            const combined = collectFindingsForField(state, meta.tag, meta.occurrence);
            updateIndicators(fieldContext, combined);
        }
        updateSidePanel(state);
        updateGuardrails(settings, state);
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
            applyPatch(patch, finding.occurrence, finding);
        });
    }

    function applyPatch(patch, occurrence, finding) {
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
        markFieldForRevalidation(state, meta || record);
        recordUndo(record, previous, patch.value);
        $field.val(patch.value);
        $field.trigger('change');
        const conditionToast = buildConditionalSuffixToast(finding);
        if (conditionToast) {
            toast('info', conditionToast);
        }
    }

    function applyAiPatch(patch, finding) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) {
            toast('warning', 'Punctuation apply is disabled in internship mode.');
            return;
        }
        if (!patch || patch.op !== 'replace_subfield') return;
        const occurrence = patch.occurrence;
        const $field = findFieldElement(patch.tag, patch.subfield, occurrence);
        if (!$field.length) return;
        const previous = $field.val() || '';
        if (patch.original_text !== undefined && patch.original_text !== previous) {
            toast('warning', 'Field value changed; AI patch skipped.');
            return;
        }
        const nextValue = patch.replacement_text || '';
        if (previous === nextValue) return;
        const meta = parseFieldMeta($field[0]);
        const record = {
            tag: patch.tag,
            code: patch.subfield,
            occurrence: occurrence || (meta ? meta.occurrence : '')
        };
        markFieldForRevalidation(state, meta || record);
        recordUndo(record, previous, nextValue);
        $field.val(nextValue);
        $field.trigger('change');
        const conditionToast = buildConditionalSuffixToast(finding);
        if (conditionToast) {
            toast('info', conditionToast);
        }
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
        if (state.guardrailAlerts && state.guardrailAlerts.length) {
            state.guardrailAlerts.forEach(alert => {
                total++;
                const hasTarget = alert && alert.tag && alert.subfield;
                const action = hasTarget
                    ? `<button type="button" class="btn btn-xs btn-default" data-tag="${alert.tag}" data-sub="${alert.subfield}">Go to field</button>`
                    : '';
                const item = $(`
                    <div class="finding warning">
                        <div><strong>${alert.label || 'Guardrail'}</strong> · WARNING</div>
                        <div class="meta">${alert.message || 'Required AACR2 data is missing.'}</div>
                        <div class="actions">${action}</div>
                    </div>
                `);
                if (hasTarget) {
                    item.find('button').on('click', (event) => {
                        const $btn = $(event.currentTarget);
                        focusField($btn.data('tag'), $btn.data('sub'), '');
                    });
                }
                $container.append(item);
            });
        }
        if (state.missingRequired.length) {
            state.missingRequired.forEach(code => {
                total++;
                const tag = code.slice(0, 3);
                const sub = code.slice(3);
                const label = `${tag}$${sub}`;
                const item = $(`
                    <div class="finding warning">
                        <div><strong>${label}</strong> · WARNING</div>
                        <div class="meta">Required AACR2 field is missing.</div>
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default" data-tag="${tag}" data-sub="${sub}">Go to field</button>
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
                const conditionNote = buildConditionalSuffixNote(finding);
                const conditionHtml = conditionNote ? `<div class="meta">${escapeAttr(conditionNote)}</div>` : '';
                const helpIcon = (finding.severity === 'ERROR' || finding.severity === 'WARNING')
                    ? `<span class="aacr2-help" title="${escapeAttr(helpText)}">?</span>`
                    : '';
                const preview = finding.expected_value ? `<div class="aacr2-preview">${finding.current_value} → ${finding.expected_value}</div>` : '';
                const rawExcerpt = finding.raw_text_excerpt ? escapeAttr(finding.raw_text_excerpt) : '';
                const rawHtml = rawExcerpt
                    ? `<div class="aacr2-raw-wrapper">
                            <button type="button" class="btn btn-xs btn-default aacr2-raw-toggle">View raw output</button>
                            <pre class="aacr2-raw-output">${rawExcerpt}</pre>
                        </div>`
                    : '';
                const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
                const hasPatch = !!patch;
                const applyAttr = hasPatch ? readOnlyAttr : 'disabled title="No automatic fix available."';
                const item = $(`
                    <div class="finding ${severityClass}">
                        <div><strong>${finding.tag}$${finding.subfield}</strong> · ${finding.severity} ${helpIcon}</div>
                        <div class="meta">${finding.message}</div>
                        ${conditionHtml}
                        ${preview}
                        ${rawHtml}
                        <div class="actions">
                            <button type="button" class="btn btn-xs btn-default aacr2-go-field" data-tag="${finding.tag}" data-sub="${finding.subfield}" data-occ="${normalizeOccurrenceKey(finding.occurrence)}">Go to field</button>
                            <button type="button" class="btn btn-xs btn-primary aacr2-apply" ${applyAttr}>Apply</button>
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
                    if (!hasPatch) {
                        toast('info', 'No automatic fix is available for this finding.');
                        return;
                    }
                    const conditionToast = buildConditionalSuffixToast(finding);
                    applyPatch(patch, finding.occurrence, finding);
                    if (!conditionToast) {
                        toast('info', `AACR2 punctuation applied to ${finding.tag}$${finding.subfield}.`);
                    }
