        const payload = {
            request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tag_context: tagContext,
            features
        };
        if (recordContext && recordContext.fields && recordContext.fields.length) {
            payload.record_context = recordContext;
        }
        const requestId = startAiRequest(state, 'punctuation');
        const signal = getAiRequestSignal(state, 'punctuation', requestId);
        const setStatus = (message, type) => {
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            setAiRequestStatus(state, 'punctuation', message, type);
            if (onStatus) onStatus(message, type);
        };
        const startMessage = 'Running...';
        toast('info', startMessage);
        setStatus(startMessage, 'info');
        try {
            const result = await global.AACR2ApiClient.aiSuggest(settings.pluginPath, payload, { signal });
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            if (result.error) {
                toast('error', result.error);
                renderAiDebug($('#aacr2-ai-panel'), 'punctuation', result);
                setStatus(`Error: ${result.error}`, 'error');
                return;
            }
            notifyTruncation(result);
            renderAiPunctuationResults($('#aacr2-ai-panel'), settings, state, meta, result);
            renderAiDebug($('#aacr2-ai-panel'), 'punctuation', result);
            if (result.degraded_mode && result.extracted_call_number) {
                const message = `AI returned non-structured output; extracted LC candidate: ${result.extracted_call_number}.`;
                toast('warning', message);
                setStatus('Done', 'warning');
            } else {
                toast('info', 'Rules & punctuation suggestions ready.');
                setStatus('Done', 'success');
            }
        } catch (err) {
            if (!isLatestAiRequest(state, 'punctuation', requestId)) return;
            if (isAbortError(err)) {
                const message = 'Cancelled.';
                setStatus(message, 'warning');
                return;
            }
            const message = `AI suggestions unavailable: ${err.message}`;
            toast('error', message);
            setStatus(`Error: ${err.message}`, 'error');
        } finally {
            if (isLatestAiRequest(state, 'punctuation', requestId)) {
                finishAiRequest(state, 'punctuation', requestId);
            }
        }
    }

    async function requestAiCatalogingAssist(settings, state, options) {
        const opts = options || {};
        const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
        const titleInfo = getTitleWithSubtitle();
        if (!titleInfo.title) {
            const message = '245$a is required for AI cataloging guidance.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        if (isExcluded(settings, state, '245', 'a')) {
            const message = 'AI cataloging guidance is disabled because 245$a is excluded.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const fieldContext = buildFieldContext('245', titleInfo.occurrence || '');
        if (!fieldContext) {
            const message = 'Unable to read 245 context.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const tagContext = buildCatalogingTagContext(fieldContext);
        if (!tagContext || !tagContext.subfields || !tagContext.subfields.length) {
            const message = '245$a is required for AI cataloging guidance.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const features = opts.features || {
            punctuation_explain: false,
            subject_guidance: settings.aiSubjectGuidance,
            call_number_guidance: settings.aiCallNumberGuidance
        };
        if (!features.subject_guidance && !features.call_number_guidance) {
            const message = 'Select at least one AI cataloging option.';
            toast('warning', message);
            if (onStatus) onStatus(`Error: ${message}`, 'error');
            return;
        }
        const payload = {
            request_id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            tag_context: tagContext,
            features
        };
        const requestId = startAiRequest(state, 'cataloging');
        const signal = getAiRequestSignal(state, 'cataloging', requestId);
        const setStatus = (message, type) => {
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            setAiRequestStatus(state, 'cataloging', message, type);
            if (onStatus) onStatus(message, type);
        };
        const startMessage = 'Running...';
        toast('info', startMessage);
        setStatus(startMessage, 'info');
        try {
            const result = await global.AACR2ApiClient.aiSuggest(settings.pluginPath, payload, { signal });
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            if (result.error) {
                toast('error', result.error);
                renderAiDebug($('#aacr2-ai-panel'), 'cataloging', result);
                setStatus(`Error: ${result.error}`, 'error');
                return;
            }
            notifyTruncation(result);
            const findings = Array.isArray(result.findings) ? result.findings : [];
            const assistantMessage = pickAiAssistantText(result, findings);
            const extracted = extractCatalogingSuggestionsFromText(assistantMessage || result.raw_text_excerpt || '');
            const resultSubjects = Array.isArray(result.subjects) ? result.subjects : [];
            const rawSubjects = resultSubjects.length
                ? resultSubjects
                : (extracted.subjects && extracted.subjects.length ? extracted.subjects : parseAiSubjects(findings));
            let classification = (result.classification || '').toString().trim()
                || extracted.classification
                || parseAiClassification(findings);
            if (!classification && result && result.extracted_call_number) {
                classification = result.extracted_call_number;
            }
            classification = normalizeClassificationSuggestion(classification || '');
            let subjects = normalizeSubjectObjects(rawSubjects || []);
            const errors = Array.isArray(result.errors) ? result.errors.slice() : [];
            const rangeMessage = classificationRangeMessage(classification || '');
            if (rangeMessage) {
                classification = '';
                if (!errors.find(err => err && err.code === 'CLASSIFICATION_RANGE')) {
                    errors.push({ code: 'CLASSIFICATION_RANGE', field: 'classification', message: rangeMessage });
                }
            }
            let confidence = null;
            if (typeof extracted.confidence_percent === 'number' && !Number.isNaN(extracted.confidence_percent)) {
                confidence = extracted.confidence_percent;
            } else if (result && typeof result.confidence_percent === 'number' && !Number.isNaN(result.confidence_percent)) {
                confidence = result.confidence_percent;
            } else {
                confidence = confidencePercentFromResult(result);
            }
            state.aiSuggestions = {
                classification,
                subjects,
                confidence,
                rawText: assistantMessage || result.raw_text_excerpt || '',
                errors
            };
            updateAiCatalogingContext($('#aacr2-ai-panel'), settings, state);
            renderAiDebug($('#aacr2-ai-panel'), 'cataloging', result);
            const message = (!classification && !subjects.length)
                ? 'AI returned no cataloging suggestions.'
                : 'Cataloging suggestions ready.';
            toast('info', message);
            if (result && result.degraded_mode && result.extracted_call_number && result.extraction_source !== 'plain_text') {
                const fallbackMessage = `AI returned non-structured output; extracted LC candidate: ${result.extracted_call_number}.`;
                toast('warning', fallbackMessage);
                setStatus('Done', 'warning');
            } else {
                setStatus('Done', classification || subjects.length ? 'success' : 'info');
            }
        } catch (err) {
            if (!isLatestAiRequest(state, 'cataloging', requestId)) return;
            if (isAbortError(err)) {
                const message = 'Cancelled.';
                setStatus(message, 'warning');
                return;
            }
            const message = `AI cataloging suggestions unavailable: ${err.message}`;
            toast('error', message);
            setStatus(`Error: ${err.message}`, 'error');
        } finally {
            if (isLatestAiRequest(state, 'cataloging', requestId)) {
                finishAiRequest(state, 'cataloging', requestId);
            }
        }
    }

    function extractCatalogingSuggestionsFromText(text) {
        const extractor = global.AACR2AiTextExtract;
        if (extractor && typeof extractor.extractCatalogingSuggestionsFromText === 'function') {
            return extractor.extractCatalogingSuggestionsFromText(text || '');
        }
        return { classification: '', subjects: [], confidence_percent: null };
    }

    function summarizeAiFindings(findings) {
        if (!Array.isArray(findings) || !findings.length) return '';
        return findings.map(finding => {
            const message = (finding.message || '').toString().trim();
            const rationale = (finding.rationale || '').toString().trim();
            if (message && rationale && rationale !== message) return `${message} - ${rationale}`;
            return message || rationale || '';
        }).filter(Boolean).join('\n');
    }

    function pickAiAssistantText(result, findings) {
        if (result && result.assistant_message) {
            const text = String(result.assistant_message).trim();
            if (text && !/^```/.test(text) && !/^[\\[{]/.test(text)) return text;
        }
        const summary = summarizeAiFindings(findings);
        if (summary) return summary;
        if (result && result.raw_text_excerpt) return String(result.raw_text_excerpt).trim();
        return '';
    }

    function normalizeSuggestionText(text) {
        return (text || '')
            .toString()
            .replace(/^\s*(subjects?|subject headings?|lcsh)\s*[:\-]\s*/i, '')
            .trim();
    }

    function normalizeClassificationSuggestion(text) {
        const cleaned = (text || '')
            .toString()
            .trim()
            .replace(/\s{2,}/g, ' ')
            .replace(/\s*\(fallback[^)]*\)\s*$/i, '')
            .replace(/[\s\.,;:]+$/g, '')
            .trim();
        return cleaned;
    }

    function classificationRangeMessage(value) {
        const text = (value || '').toString();
        if (!text.trim()) return '';
        const normalized = text.replace(/[\u2012\u2013\u2014\u2212]/g, '-');
        if (/\b[A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?\s*-\s*(?:[A-Z]{1,3}\s*)?\d{1,4}(?:\.\d+)?\b/i.test(normalized)) {
            return 'Classification ranges are not allowed. Provide a single class number.';
        }
        if (/\b\d{1,4}(?:\.\d+)?\s*-\s*\d{1,4}(?:\.\d+)?\b/.test(normalized)) {
            return 'Classification ranges are not allowed. Provide a single class number.';
        }
        return '';
    }

    function normalizeSubjectHeading(text) {
        let value = (text || '').toString().trim();
        if (!value) return '';
        value = value.replace(/\s*--\s*/g, ' -- ');
        value = value.replace(/\s{2,}/g, ' ');
        value = value.replace(/\s*--\s*$/g, '').trim();
        return value;
    }

    function dedupeCaseInsensitive(items) {
        const seen = new Set();
        return items.filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function parseAiClassification(findings) {
        if (!Array.isArray(findings)) return '';
        const direct = findings.find(f => (f.code || '').toUpperCase() === 'AI_CLASSIFICATION');
        let text = direct ? (direct.message || direct.rationale || '') : '';
        if (!text) {
            const fallback = findings.find(f =>
                /classification/i.test(f.message || '') ||
                /classification/i.test(f.rationale || '') ||
                /call number/i.test(f.message || '') ||
                /call number/i.test(f.rationale || '')
            );
            text = fallback ? (fallback.message || fallback.rationale || '') : '';
        }
        const cleaned = (text || '')
            .toString()
            .trim()
            .replace(/^\s*(classification|call number)\s*[:\-]\s*/i, '')
            .replace(/^\s*(classification|call number)\s+/i, '')
            .replace(/\s{2,}/g, ' ')
            .replace(/[\s\.,;:]+$/g, '')
            .trim();
        return normalizeClassificationSuggestion(cleaned);
    }

    function parseAiSubjects(findings) {
        if (!Array.isArray(findings)) return [];
        const direct = findings.find(f => (f.code || '').toUpperCase() === 'AI_SUBJECTS');
        let text = direct ? (direct.message || direct.rationale || '') : '';
        if (!text) {
            const fallback = findings.find(f => /subjects?/i.test(f.message || '') || /subjects?/i.test(f.rationale || ''));
            text = fallback ? (fallback.message || fallback.rationale || '') : '';
        }
        const cleaned = normalizeSuggestionText(text);
        if (!cleaned) return [];
        const parts = cleaned.split(/[;\n|]+/);
        const expanded = [];
        parts.forEach(part => {
            const value = (part || '').toString().trim();
            if (!value) return;
            if (/--/.test(value)) {
                expanded.push(value);
                return;
            }
            const commaCount = (value.match(/,/g) || []).length;
            if (commaCount >= 2) {
                value.split(/\s*,\s*/).forEach(seg => {
                    const trimmed = (seg || '').trim();
                    if (trimmed) expanded.push(trimmed);
                });
                return;
            }
            if (commaCount === 1) {
                const pieces = value.split(/\s*,\s*/);
                if (pieces.length === 2 && !/\s/.test(pieces[0]) && !/\s/.test(pieces[1])) {
                    pieces.forEach(piece => {
                        const trimmed = (piece || '').trim();
                        if (trimmed) expanded.push(trimmed);
                    });
                    return;
                }
            }
            expanded.push(value);
        });
        const normalized = expanded
            .map(item => normalizeSubjectHeading(item))
            .filter(Boolean);
        return dedupeCaseInsensitive(normalized);
    }

    function normalizeSubjectObjects(subjects) {
        const extract = global.AACR2AiTextExtract;
        if (extract && typeof extract.subjectsFromHeadingList === 'function') {
            return extract.subjectsFromHeadingList(subjects || []);
        }
        if (!Array.isArray(subjects)) return [];
        return subjects.map(item => {
            if (item && typeof item === 'object') return item;
            const heading = normalizeSubjectHeading(item);
            if (!heading) return null;
            const parts = heading.split(/\s--\s/).map(part => part.trim()).filter(Boolean);
            if (!parts.length) return null;
            return {
                tag: '650',
                ind1: ' ',
                ind2: '0',
                subfields: {
                    a: parts[0],
                    x: parts.slice(1),
                    y: [],
                    z: [],
                    v: []
                }
            };
        }).filter(Boolean);
    }

    function renderAiSubjectList($panel, subjects) {
        const $list = $panel.find('#aacr2-ai-subjects');
        if (!$list.length) return;
        if (!Array.isArray(subjects) || !subjects.length) {
            $list.text('(none)');
            return;
        }
        const formatter = global.AACR2AiTextExtract && typeof global.AACR2AiTextExtract.formatSubjectDisplay === 'function'
            ? global.AACR2AiTextExtract.formatSubjectDisplay
            : null;
        const lines = subjects.map(item => {
            if (formatter) return formatter(item);
            if (typeof item === 'string') return item;
            const tag = item && item.tag ? item.tag : '650';
            const ind1 = item && item.ind1 !== undefined ? item.ind1 : ' ';
            const ind2 = item && item.ind2 !== undefined ? item.ind2 : '0';
            const sub = item && item.subfields ? item.subfields : {};
            const parts = [sub.a || ''];
            ['x', 'y', 'z', 'v'].forEach(code => {
                const values = Array.isArray(sub[code]) ? sub[code] : [];
                values.forEach(val => { if (val) parts.push(val); });
            });
            return `${tag}${ind1}${ind2} ${parts.join(' -- ')}`.trim();
        }).filter(Boolean);
        $list.text(lines.join('\n'));
    }

    function maybeShowAiGhost(element, findings, settings) {
        const state = global.AACR2IntellisenseState;
        if (state && state.readOnly) return;
        const candidate = findings.find(f => f.confidence >= settings.aiConfidenceThreshold && f.severity !== 'ERROR');
        if (!candidate) return;
        const patch = candidate.proposed_fixes && candidate.proposed_fixes[0] && candidate.proposed_fixes[0].patch[0];
        if (!patch) return;
        const current = $(element).val() || '';
        const ghostText = computeGhostText(current, patch.replacement_text || '');
        if (!ghostText) return;
        const $ghost = $(`<span class="aacr2-ghost-text" title="Accept AI suggestion">${ghostText}</span>`);
        $ghost.data('expected', patch.replacement_text || '');
        $ghost.on('click', () => {
            $(element).val(patch.replacement_text || '');
            $ghost.remove();
            markFieldForRevalidation(state, parseFieldMeta(element));
            toast('info', 'AI ghost suggestion applied.');
        });
        $(element).after($ghost);
    }

    function isSameOccurrence(a, b) {
        if (b === undefined || b === null || b === '') return true;
        if (a === undefined || a === null || a === '') return false;
        return normalizeOccurrenceKey(a) === normalizeOccurrenceKey(b);
    }

    function findFieldElement(tag, code, occurrence) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return $();
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], select[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"], select[name^="field_${tag}${code}"]`;
        const $candidates = $(selector);
        if (occurrence === undefined || occurrence === null || occurrence === '') return $candidates.first();
        const match = $candidates.filter(function() {
            const meta = parseFieldMeta(this);
            return meta && meta.tag === tag && meta.code === code && isSameOccurrence(meta.occurrence, occurrence);
        }).first();
        return match.length ? match : $candidates.first();
    }

    function collectSubfieldElements(tag, code, occurrence) {
        if (!isValidTag(tag) || !isValidSubfieldCode(code)) return $();
        const selector = `#subfield${tag}${code}, input[id^="tag_${tag}_subfield_${code}"], textarea[id^="tag_${tag}_subfield_${code}"], select[id^="tag_${tag}_subfield_${code}"], #tag_${tag}_subfield_${code}, input[name^="field_${tag}${code}"], textarea[name^="field_${tag}${code}"], select[name^="field_${tag}${code}"]`;
        const matches = [];
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag || meta.code !== code) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            matches.push(this);
        });
        return $(matches);
    }

    function setIndicatorValue(tag, indicator, occurrence, value) {
        const selector = [
            `input[id^="tag_${tag}_indicator${indicator}"]`,
            `select[id^="tag_${tag}_indicator${indicator}"]`,
            `input[name^="tag_${tag}_indicator${indicator}"]`,
            `select[name^="tag_${tag}_indicator${indicator}"]`
        ].join(',');
        let updated = false;
        $(selector).each(function() {
            const meta = parseIndicatorMeta(this);
            if (!meta || meta.tag !== tag) return;
            if (!isSameOccurrence(meta.occurrence, occurrence)) return;
            $(this).val(value);
            updated = true;
            return false;
        });
        return updated;
    }

    function guessAddFieldControl(tag) {
        const selector = [
            `[data-tag="${tag}"]`,
            `[data-marc-tag="${tag}"]`,
            `[data-field-tag="${tag}"]`,
            `a[onclick*="tag_${tag}"]`,
            `button[onclick*="tag_${tag}"]`,
            `a[onclick*="${tag}"]`,
            `button[onclick*="${tag}"]`
        ].join(',');
        const $candidates = $(selector).filter(function() {
            const text = ($(this).text() || '').toLowerCase();
            return !text || text.includes('add');
        });
        return $candidates.first();
    }

    function addFieldForTag(tag) {
        const $existing = findFieldElement(tag, 'a', '');
        const beforeCount = collectFieldOccurrences(tag).length;
        try {
            if (typeof window.AddField === 'function') {
                window.AddField(tag);
            } else if (typeof window.addField === 'function') {
                window.addField(tag);
            } else if (typeof window.CloneField === 'function' && $existing.length) {
                window.CloneField($existing.attr('id') || $existing.attr('name'));
            } else if (typeof window.cloneField === 'function' && $existing.length) {
                window.cloneField($existing.attr('id') || $existing.attr('name'));
            } else {
                const $control = guessAddFieldControl(tag);
                if ($control.length) $control.trigger('click');
            }
        } catch (err) {
            // ignore and fall through
        }
        const afterCount = collectFieldOccurrences(tag).length;
        return afterCount > beforeCount;
    }

    function collectFieldOccurrences(tag) {
        if (!isValidTag(tag)) return [];
        const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
        const occurrences = new Set();
        $(selector).each(function() {
            const meta = parseFieldMeta(this);
            if (!meta || meta.tag !== tag) return;
            occurrences.add(normalizeOccurrenceKey(meta.occurrence));
        });
        return Array.from(occurrences);
    }

    function cloneSubfieldRow($base, tag, code, occurrence) {
        if (!$base || !$base.length) return $();
        const baseMeta = parseFieldMeta($base[0]);
        const baseCode = baseMeta ? baseMeta.code : code;
        const baseOcc = baseMeta ? baseMeta.occurrence : occurrence;
        const existing = collectSubfieldElements(tag, code, occurrence);
        const suffix = existing.length ? `_${existing.length}` : '';
        const newToken = `${normalizeOccurrenceKey(baseOcc)}${suffix}`;
        const $row = $base.closest('.subfield_line, .subfield, .field, li, div').first();
        const $clone = $row.clone();
        $clone.find('input, textarea, select, label').each(function() {
            const $el = $(this);
            const id = $el.attr('id');
            const name = $el.attr('name');
            if (id) {
                let nextId = id;
                nextId = nextId.replace(new RegExp(`tag_${tag}_subfield_${baseCode}(_\\d+(?:_\\d+)*)?`, 'i'), `tag_${tag}_subfield_${code}_${newToken}`);
                nextId = nextId.replace(new RegExp(`subfield${tag}${baseCode}`, 'i'), `subfield${tag}${code}`);
                if (nextId === id) {
                    nextId = `tag_${tag}_subfield_${code}_${newToken}`;
                }
                $el.attr('id', nextId);
            }
            if (name) {
                let nextName = name;
                nextName = nextName.replace(new RegExp(`tag_${tag}_subfield_${baseCode}(_\\d+(?:_\\d+)*)?`, 'i'), `tag_${tag}_subfield_${code}_${newToken}`);
                nextName = nextName.replace(new RegExp(`field_${tag}${baseCode}`, 'i'), `field_${tag}${code}`);
                if (nextName === name) {
                    nextName = `tag_${tag}_subfield_${code}_${newToken}`;
                }
                $el.attr('name', nextName);
            }
            if ($el.is('label')) {
                $el.text(`$${code}`);
            } else {
                $el.val('');
            }
        });
        $row.after($clone);
        return $clone.find('input, textarea, select').first();
    }

    function ensureSubfieldInput(tag, occurrence, code) {
        const existing = collectSubfieldElements(tag, code, occurrence);
        if (existing.length) return existing.last();
        const $base = findFieldElement(tag, 'a', occurrence);
        if (!$base.length) return $();
        const $added = cloneSubfieldRow($base, tag, code, occurrence);
        return $added.length ? $added : collectSubfieldElements(tag, code, occurrence).last();
    }

    function getFieldValue(tag, code) {
        const $field = findFieldElement(tag, code, '');
        if (!$field.length) return { value: '', element: null, occurrence: '' };
        const meta = parseFieldMeta($field[0]);
        return {
            value: ($field.val() || '').trim(),
            element: $field[0],
            occurrence: meta ? meta.occurrence : ''
        };
    }

    function buildTitleSourceFromParts(title, subtitle, responsibility) {
        const parts = [title, subtitle, responsibility]
            .map(value => (value || '').toString().trim())
            .filter(Boolean);
        return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
    }

    function getTitleWithSubtitle() {
        const titleInfo = getFieldValue('245', 'a');
        const subtitleInfo = getFieldValue('245', 'b');
        const responsibilityInfo = getFieldValue('245', 'c');
        const combined = buildTitleSourceFromParts(titleInfo.value, subtitleInfo.value, responsibilityInfo.value);
        return {
            value: combined,
            title: titleInfo.value,
            subtitle: subtitleInfo.value,
            responsibility: responsibilityInfo.value,
            occurrence: titleInfo.occurrence || subtitleInfo.occurrence || responsibilityInfo.occurrence || '',
            element: titleInfo.element || subtitleInfo.element || responsibilityInfo.element || null
        };
    }

    function filterCatalogingSubfields(subfields, options) {
        const opts = options || {};
        const maxSubfields = Number.isFinite(opts.maxSubfields) ? opts.maxSubfields : 20;
        const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 1200;
        const maxValueChars = Number.isFinite(opts.maxValueChars) ? opts.maxValueChars : 240;
        const requiredCodes = Array.isArray(opts.requiredCodes)
            ? opts.requiredCodes.map(code => String(code || '').toLowerCase()).filter(Boolean)
            : ['a', 'b', 'c'];
        const activeCode = String(opts.activeCode || '').toLowerCase();

        const cleaned = [];
        (subfields || []).forEach(sub => {
            if (!sub || typeof sub !== 'object') return;
            const code = String(sub.code || '').toLowerCase();
            if (!code) return;
            let value = (sub.value !== undefined && sub.value !== null) ? String(sub.value) : '';
            value = value.trim();
            if (!value) return;
            cleaned.push({ code, value });
        });
        if (!cleaned.length) return [];

        const normalizeValue = (value) => {
            if (!value) return '';
            if (maxValueChars && value.length > maxValueChars) {
                return value.slice(0, Math.max(0, maxValueChars - 3)) + '...';
            }
            return value;
        };

        const totalChars = cleaned.reduce((sum, sub) => sum + sub.value.length, 0);
        if ((!maxSubfields || cleaned.length <= maxSubfields) && (!maxChars || totalChars <= maxChars)) {
            return cleaned.map(sub => ({ code: sub.code, value: normalizeValue(sub.value) }));
        }

        let centerIndex = 0;
        if (activeCode) {
            const idx = cleaned.findIndex(sub => sub.code === activeCode);
            if (idx >= 0) centerIndex = idx;
        }

        const selected = new Set();
        cleaned.forEach((sub, idx) => {
            if ((activeCode && sub.code === activeCode) || requiredCodes.includes(sub.code)) {
                selected.add(idx);
            }
        });
        if (!selected.size) selected.add(centerIndex);

        let offset = 1;
        while (selected.size < maxSubfields && (centerIndex - offset >= 0 || centerIndex + offset < cleaned.length)) {
            const left = centerIndex - offset;
            if (left >= 0) selected.add(left);
            if (selected.size >= maxSubfields) break;
            const right = centerIndex + offset;
            if (right < cleaned.length) selected.add(right);
            offset += 1;
        }

        const indices = Array.from(selected).sort((a, b) => a - b).slice(0, maxSubfields);
        const result = [];
        let total = 0;
        indices.forEach(idx => {
            let value = normalizeValue(cleaned[idx].value);
            if (!value) return;
            if (maxChars && total + value.length > maxChars) {
                const remaining = maxChars - total;
                if (remaining <= 3) return;
                value = value.slice(0, Math.max(0, remaining - 3)) + '...';
            }
            total += value.length;
            result.push({ code: cleaned[idx].code, value });
        });
        return result;
    }

    function buildCatalogingTagContext(fieldContext) {
        if (!fieldContext) return null;
        const rawSubfields = Array.isArray(fieldContext.subfields) ? fieldContext.subfields : [];
        let activeCode = '';
        const firstA = rawSubfields.find(sub => sub && String(sub.code || '').toLowerCase() === 'a');
        if (firstA) {
            activeCode = 'a';
        } else if (rawSubfields.length) {
            activeCode = String(rawSubfields[0].code || '').toLowerCase();
        }
        const subfields = filterCatalogingSubfields(rawSubfields, { activeCode });
        const activeSubfield = activeCode || (subfields[0] ? subfields[0].code : '');
        return {
            tag: fieldContext.tag || '245',
            ind1: fieldContext.ind1 || '',
            ind2: fieldContext.ind2 || '',
            occurrence: normalizeOccurrence(fieldContext.occurrence),
            active_subfield: activeSubfield,
            subfields
        };
    }

    function getPreferredCutterSource() {
        const authorInfo = getFieldValue('100', 'a');
        if (authorInfo.value) {
            return { value: authorInfo.value, label: '100$a (author)', tag: '100' };
        }
        const titleInfo = getFieldValue('245', 'a');
        if (titleInfo.value) {
            return { value: titleInfo.value, label: '245$a (title)', tag: '245' };
        }
        return { value: '', label: 'Title', tag: '245' };
    }

    function extractKnownYear(value) {
        if (!value) return '';
        const raw = value.toString().trim();
        if (!raw) return '';
        const lower = raw.toLowerCase();
        if (/[?]/.test(lower)) return '';
        if (/n\.d\.|no date|unknown|undated/.test(lower)) return '';
        if (/\bca\.?\b|\bcirca\b|\bapprox\b|\bapprox\.\b/.test(lower)) return '';
        if (/\d{4}\s*[-/]\s*\d{4}/.test(lower)) return '';
        let cleaned = raw.replace(/[\[\]\(\)©]/g, '').trim();
        cleaned = cleaned.replace(/^(c|copyright)\s*/i, '');
        const matches = cleaned.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) || [];
        if (matches.length !== 1) return '';
        return matches[0];
    }

    function getPublicationYear() {
        const field264 = getFieldValue('264', 'c');
        const field260 = getFieldValue('260', 'c');
        const year = extractKnownYear(field264.value) || extractKnownYear(field260.value);
        return { value: year || '' };
    }

    function buildCutterSanborn(value, sourceTag) {
        if (global.AACR2CutterSanborn && typeof global.AACR2CutterSanborn.build === 'function') {
            return global.AACR2CutterSanborn.build(value, sourceTag);
        }
        return '';
    }

    function buildCallNumber(classification, cutter, year) {
        const parts = [];
        if (classification) parts.push(classification.trim());
        if (cutter) parts.push(cutter.trim());
        if (year) parts.push(year.trim());
        return parts.join(' ').trim();
    }

    function parseLcTarget(target) {
        const value = (target || '').toString().trim();
        let match = value.match(/^(\d{3})\s*\$\s*([a-z0-9])$/i);
        if (!match) match = value.match(/^(\d{3})([a-z0-9])$/i);
        if (!match) return null;
        return { tag: match[1], code: match[2].toLowerCase() };
    }

    function findCallNumberTarget() {
        const settings = global.AutoPunctuationSettings || {};
        const target = parseLcTarget(settings.lcClassTarget || '');
        const candidates = [];
        if (target) candidates.push(target);
        candidates.push(
            { tag: '050', code: 'a' },
            { tag: '090', code: 'a' },
            { tag: '099', code: 'a' }
        );
        for (const candidate of candidates) {
            const $field = findFieldElement(candidate.tag, candidate.code, '');
            if ($field.length) {
                return { ...candidate, $field };
            }
        }
        return null;
    }

    function clearSubjectFields(tags) {
        (tags || []).forEach(tag => {
            const occurrences = collectFieldOccurrences(tag);
            occurrences.forEach(occ => {
                const selector = `input[id^="tag_${tag}_subfield_"], textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"], input[id^="subfield${tag}"], textarea[id^="subfield${tag}"], select[id^="subfield${tag}"], input[name^="field_${tag}"], textarea[name^="field_${tag}"], select[name^="field_${tag}"]`;
                $(selector).each(function() {
                    const meta = parseFieldMeta(this);
                    if (!meta || meta.tag !== tag) return;
                    if (!isSameOccurrence(meta.occurrence, occ)) return;
                    $(this).val('');
                });
            });
        });
    }

    function findEmptySubjectField(tag) {
        const $fields = collectSubfieldElements(tag, 'a', '');
        let $candidate = $();
        $fields.each(function() {
            const meta = parseFieldMeta(this);
            if (!meta) return;
            const fieldContext = buildFieldContext(tag, meta.occurrence);
            if (!fieldContext) return;
            const hasValue = (fieldContext.subfields || []).some(sub => (sub.value || '').toString().trim());
            if (!hasValue) {
                $candidate = $(this);
                return false;
            }
        });
        return $candidate;
    }

    function applySubjectObject(subject, settings, state) {
        if (!subject || !subject.subfields || !subject.subfields.a) return false;
        const tag = subject.tag || '650';
        const ind1 = subject.ind1 !== undefined ? subject.ind1 : ' ';
        const ind2 = subject.ind2 !== undefined ? subject.ind2 : '0';
        let $fieldA = findEmptySubjectField(tag);
        if (!$fieldA.length) {
            addFieldForTag(tag);
            $fieldA = findEmptySubjectField(tag);
        }
        if (!$fieldA.length) return false;
        const meta = parseFieldMeta($fieldA[0]);
        if (!meta) return false;
        const occurrence = meta.occurrence;
        setIndicatorValue(tag, 1, occurrence, ind1);
        setIndicatorValue(tag, 2, occurrence, ind2);
        const setValueAtIndex = (code, value, index) => {
            let $targets = collectSubfieldElements(tag, code, occurrence);
            while ($targets.length <= index) {
                ensureSubfieldInput(tag, occurrence, code);
                $targets = collectSubfieldElements(tag, code, occurrence);
            }
            const $target = $targets.eq(index);
            if ($target.length) {
                $target.val(value);
                $target.trigger('change');
                markFieldForRevalidation(state, { tag, code, occurrence });
            }
        };
        setValueAtIndex('a', subject.subfields.a, 0);
        ['x', 'y', 'z', 'v'].forEach(code => {
            const values = Array.isArray(subject.subfields[code]) ? subject.subfields[code] : [];
            values.forEach((value, idx) => {
                if (value) setValueAtIndex(code, value, idx);
            });
        });
        return true;
    }

    function applyAiSubjects(settings, state) {
        const $panel = $('#aacr2-ai-panel');
        const subjects = state && state.aiSuggestions ? state.aiSuggestions.subjects || [] : [];
        if (!subjects.length) {
            toast('info', 'No subject headings to apply.');
            return;
