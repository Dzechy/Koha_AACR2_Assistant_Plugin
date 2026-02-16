    }

    function stripPunctSpace(value) {
        return (value || '').toString().replace(/[^\p{L}\p{N}]+/gu, '').trim();
    }

    function punctuationOnlyChange(original, replacement) {
        return stripPunctSpace(original) === stripPunctSpace(replacement);
    }

    function validateAiResponseGuardrails(payload, result, settings) {
        if (!result || typeof result !== 'object') return 'AI response missing payload.';
        if (!result.request_id) return 'AI response missing request_id.';
        if (payload.request_id !== result.request_id) return 'AI response request_id mismatch.';
        const tagContext = payload.tag_context || {};
        const targetTag = tagContext.tag || '';
        const targetOccurrence = tagContext.occurrence !== undefined && tagContext.occurrence !== null
            ? Number(tagContext.occurrence)
            : 0;
        const subfields = Array.isArray(tagContext.subfields) ? tagContext.subfields : [];
        const subfieldValues = {};
        subfields.forEach(sub => {
            if (sub && sub.code) subfieldValues[sub.code] = sub.value || '';
        });

        const rulesEngine = global.AACR2RulesEngine;
        if (!rulesEngine) return 'Rules engine unavailable for AI guardrails.';
        const rules = rulesEngine.loadRules(global.AACR2RulePack || {}, settings.customRules || '{}');
        const fieldPayload = {
            tag: targetTag,
            ind1: tagContext.ind1 || '',
            ind2: tagContext.ind2 || '',
            subfields: subfields.map(sub => ({ code: sub.code, value: sub.value }))
        };
        const deterministic = rulesEngine.validateField(fieldPayload, settings, rules);
        const expectedByCode = {};
        (deterministic.findings || []).forEach(finding => {
            const patch = finding.proposed_fixes && finding.proposed_fixes[0] && finding.proposed_fixes[0].patch[0];
            if (patch) {
                const code = patch.code || patch.subfield || finding.subfield;
                const value = patch.value !== undefined ? patch.value : patch.replacement_text;
                if (code && value !== undefined && value !== '') {
                    if (!expectedByCode[code]) expectedByCode[code] = new Set();
                    expectedByCode[code].add(String(value));
                }
            }
        });

        const findings = Array.isArray(result.findings) ? result.findings : [];
        for (const finding of findings) {
            const fixes = Array.isArray(finding.proposed_fixes) ? finding.proposed_fixes : [];
            for (const fix of fixes) {
                const patches = Array.isArray(fix.patch) ? fix.patch : [];
                for (const patch of patches) {
                    if (!patch || patch.op !== 'replace_subfield') return 'Unsupported AI patch operation.';
                    if (!patch.tag || !patch.subfield) return 'AI patch missing tag or subfield.';
                    if (patch.tag !== targetTag) return 'AI patch scope violation.';
                    const occurrence = patch.occurrence !== undefined && patch.occurrence !== null
                        ? Number(patch.occurrence)
                        : 0;
                    if (occurrence !== targetOccurrence) return 'AI patch occurrence mismatch.';
                    if (!(patch.subfield in subfieldValues)) return 'AI patch references unknown subfield.';
                    const original = patch.original_text || '';
                    const replacement = patch.replacement_text || '';
                    if (original !== subfieldValues[patch.subfield]) return 'AI patch original text mismatch.';
                    if (!punctuationOnlyChange(original, replacement)) return 'AI patch contains non-punctuation edits.';
                    if (patch.subfield in expectedByCode) {
                        if (!expectedByCode[patch.subfield].has(String(replacement))) {
                            return 'AI patch conflicts with deterministic rules.';
                        }
                    }
                }
            }
        }
        return '';
    }
