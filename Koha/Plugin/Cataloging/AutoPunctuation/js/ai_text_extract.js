(function(global) {
    'use strict';

    const AiTextExtract = {};

    function normalizeLcText(text) {
        return (text || '')
            .toString()
            .replace(/[\u2012\u2013\u2014\u2212]/g, '-')
            .replace(/\s+/g, ' ');
    }

    function formatLcCallNumber(cls, number) {
        if (!cls || !number) return '';
        return `${cls.toUpperCase()} ${number}`;
    }

    function rankLcCandidates(text, candidates) {
        if (!text || !Array.isArray(candidates)) return [];
        const lower = text.toLowerCase();
        const keywords = [
            'lc classification',
            'lc class',
            'lcc',
            'lc',
            'classification',
            'call number',
            'call no'
        ];
        const keywordPositions = [];
        keywords.forEach(keyword => {
            let idx = lower.indexOf(keyword);
            while (idx !== -1) {
                keywordPositions.push(idx);
                idx = lower.indexOf(keyword, idx + keyword.length);
            }
        });
        const ranked = candidates.map(cand => {
            let score = 0;
            const start = cand.start || 0;
            keywordPositions.forEach(pos => {
                const distance = Math.abs(start - pos);
                if (distance <= 80) score += 3;
                else if (distance <= 200) score += 1;
            });
            const before = text.lastIndexOf('{', start);
            const after = text.indexOf('}', start);
            if (before >= 0 && after > start && (after - before) <= 400) score += 1;
            return { ...cand, score };
        });
        ranked.sort((a, b) => (b.score - a.score) || (a.start - b.start));
        return ranked;
    }

    function extractLcCallNumbers(text) {
        if (!text) return [];
        const normalized = normalizeLcText(text);
        const candidates = [];
        const spans = [];
        const rangeRegex = /\b([A-Z]{1,3})\s*(\d{1,4}(?:\.\d+)?)\s*-\s*(?:([A-Z]{1,3})\s*)?(\d{1,4}(?:\.\d+)?)\b/gi;
        let match;
        while ((match = rangeRegex.exec(normalized)) !== null) {
            spans.push([match.index, rangeRegex.lastIndex]);
        }
        let scrubbed = normalized;
        if (spans.length) {
            const chars = scrubbed.split('');
            spans.forEach(span => {
                for (let i = span[0]; i < span[1]; i += 1) {
                    chars[i] = ' ';
                }
            });
            scrubbed = chars.join('');
        }
        const singleRegex = /\b([A-Z]{1,3})\s*(\d{1,4}(?:\.\d+)?)\b/gi;
        while ((match = singleRegex.exec(scrubbed)) !== null) {
            const value = formatLcCallNumber(match[1], match[2]);
            if (value) candidates.push({ value, start: match.index });
        }
        const ranked = rankLcCandidates(text, candidates);
        const ordered = [];
        const seen = new Set();
        ranked.forEach(cand => {
            if (!cand.value || seen.has(cand.value)) return;
            seen.add(cand.value);
            ordered.push(cand.value);
        });
        return ordered;
    }

    function extractConfidencePercentFromText(text) {
        if (!text) return null;
        let value;
        let match = text.match(/confidence(?:\s*percent|\s*score)?\s*[:=]?\s*([0-9]{1,3}(?:\.\d+)?)(\s*%?)/i);
        if (match) {
            value = parseFloat(match[1]);
            const hasPercent = (match[2] || '').includes('%');
            if (!hasPercent && value <= 1) value *= 100;
        } else {
            match = text.match(/([0-9]{1,3}(?:\.\d+)?)\s*%\s*confidence/i);
            if (match) value = parseFloat(match[1]);
        }
        if (value === undefined || value === null || Number.isNaN(value)) {
            match = text.match(/confidence\s*[:=]?\s*([01](?:\.\d+)?)/i);
            if (match) {
                const raw = parseFloat(match[1]);
                value = raw <= 1 ? raw * 100 : raw;
            }
        }
        if (value === undefined || value === null || Number.isNaN(value)) {
            match = text.match(/confidence\s*[:=]?\s*(\d{1,3})\s*\/\s*100/i);
            if (match) value = parseFloat(match[1]);
        }
        if (value === undefined || value === null || Number.isNaN(value)) return null;
        if (value < 0) value = 0;
        if (value > 100) value = 100;
        return value;
    }

    function normalizeSubjectHeading(value) {
        let text = (value || '').toString().trim();
        if (!text) return '';
        text = text.replace(/\s*--\s*/g, ' -- ');
        text = text.replace(/\s{2,}/g, ' ');
        text = text.replace(/\s*--\s*$/g, '').trim();
        return text;
    }

    function isChronologicalSubdivision(text) {
        if (!text) return false;
        if (/\b\d{3,4}\b/.test(text)) return true;
        if (/\b\d{1,2}(st|nd|rd|th)\s+century\b/i.test(text)) return true;
        return false;
    }

    function normalizeSubjectObject(subject) {
        if (!subject || typeof subject !== 'object') return null;
        const tag = subject.tag || '650';
        const ind1 = subject.ind1 !== undefined ? String(subject.ind1) : ' ';
        const ind2 = subject.ind2 !== undefined ? String(subject.ind2) : '0';
        const subfields = subject.subfields && typeof subject.subfields === 'object' ? subject.subfields : {};
        const a = (subfields.a || '').toString().trim();
        if (!a) return null;
        const normalizeArray = value => {
            if (!value) return [];
            if (Array.isArray(value)) return value.map(item => (item || '').toString().trim()).filter(Boolean);
            return [(value || '').toString().trim()].filter(Boolean);
        };
        return {
            tag,
            ind1,
            ind2,
            subfields: {
                a,
                x: normalizeArray(subfields.x),
                y: normalizeArray(subfields.y),
                z: normalizeArray(subfields.z),
                v: normalizeArray(subfields.v)
            }
        };
    }

    function subjectObjectFromHeading(text, defaults) {
        if (!text) return null;
        let value = String(text).trim();
        if (!value) return null;
        let tag = (defaults && defaults.tag) || '650';
        let ind1 = (defaults && defaults.ind1) || ' ';
        let ind2 = (defaults && defaults.ind2) || '0';
        const prefixMatch = value.match(/^(\d{3})\s*([0-9 ])\s*([0-9 ])\s*[:\-]?\s*(.+)$/);
        if (prefixMatch) {
            tag = prefixMatch[1];
            ind1 = prefixMatch[2];
            ind2 = prefixMatch[3];
            value = prefixMatch[4].trim();
        }
        const parts = value.split(/\s*--\s*/).map(part => part.trim()).filter(Boolean);
        if (!parts.length) return null;
        const a = parts.shift();
        const x = [];
        const y = [];
        const z = [];
        const v = [];
        parts.forEach(part => {
            if (isChronologicalSubdivision(part)) y.push(part);
            else x.push(part);
        });
        return normalizeSubjectObject({
            tag,
            ind1,
            ind2,
            subfields: { a, x, y, z, v }
        });
    }

    function subjectsFromHeadingList(list, defaults) {
        if (!Array.isArray(list)) return [];
        return list.map(item => {
            if (item && typeof item === 'object') return normalizeSubjectObject(item);
            return subjectObjectFromHeading(item, defaults);
        }).filter(Boolean);
    }

    function formatSubjectDisplay(subject) {
        const normalized = normalizeSubjectObject(subject);
        if (!normalized) return '';
        const parts = [normalized.subfields.a];
        ['x', 'y', 'z', 'v'].forEach(code => {
            (normalized.subfields[code] || []).forEach(value => {
                if (value) parts.push(value);
            });
        });
        const tagLabel = `${normalized.tag}${normalized.ind1 || ' '}${normalized.ind2 || ' '}`;
        return `${tagLabel} ${parts.join(' -- ')}`.trim();
    }

    function detectClassificationRange(text) {
        if (!text) return '';
        const normalized = normalizeLcText(text);
        const rangePatterns = [
            /\b[A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?\s*-\s*(?:[A-Z]{1,3}\s*)?\d{1,4}(?:\.\d+)?\b/,
            /\b\d{1,4}(?:\.\d+)?\s*-\s*\d{1,4}(?:\.\d+)?\b/
        ];
        if (rangePatterns.some(rx => rx.test(normalized))) {
            return 'Classification ranges are not allowed. Provide a single class number.';
        }
        return '';
    }

    function dedupeCaseInsensitive(items) {
        if (!Array.isArray(items)) return [];
        const seen = new Set();
        return items.filter(item => {
            if (!item) return false;
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function extractSubjectHeadingsFromText(text) {
        if (!text) return [];
        const lines = String(text).split(/\r?\n/);
        const segments = [];
        let capture = false;
        lines.forEach(line => {
            let trimmed = line || '';
            trimmed = trimmed.replace(/^\s*[-*\u2022\u2023\u25E6\u2043\u2219]+\s*/g, '');
            const subjectMatch = trimmed.match(/\b(subjects?|subject headings?|lcsh)\b\s*[:\-]\s*(.+)/i);
            if (subjectMatch) {
                segments.push(subjectMatch[2]);
                capture = true;
                return;
            }
            if (capture) {
                if (/^\s*$/.test(trimmed)) {
                    capture = false;
                    return;
                }
                if (/\b(classification|call number|confidence)\b/i.test(trimmed)) {
                    capture = false;
                    return;
                }
                if (trimmed) segments.push(trimmed);
            }
        });
        if (!segments.length) {
            const inlineMatch = String(text).match(/\b(subjects?|subject headings?|lcsh)\b\s*[:\-]\s*(.+)$/is);
            if (inlineMatch) segments.push(inlineMatch[2]);
        }
        let joined = segments.join('\n');
        joined = joined.replace(/\b(classification|call number|confidence)\b.*$/is, '');
        const parts = joined.split(/[;\n\|]+/);
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

    function extractClassificationFromText(text) {
        if (!text) return '';
        let match = String(text).match(/\b(classification|call number|lc class(?:ification)?|lcc)\b\s*[:\-]\s*([^\r\n]+)/i);
        if (match) {
            const candidates = extractLcCallNumbers(match[2] || '');
            if (candidates.length) return candidates[0];
        }
        match = String(text).match(/\b(lc)\b\s*[:\-]\s*([A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?)/i);
        if (match) {
            const candidates = extractLcCallNumbers(match[2] || '');
            if (candidates.length) return candidates[0];
        }
        const candidates = extractLcCallNumbers(text);
        return candidates.length ? candidates[0] : '';
    }

    function extractCatalogingSuggestionsFromText(text) {
        return {
            classification: extractClassificationFromText(text),
            subjects: extractSubjectHeadingsFromText(text),
            confidence_percent: extractConfidencePercentFromText(text)
        };
    }

    function parseLcTarget(target) {
        const value = (target || '').toString().trim();
        let match = value.match(/^(\d{3})\s*\$\s*([a-z0-9])$/i);
        if (!match) match = value.match(/^(\d{3})([a-z0-9])$/i);
        if (!match) return null;
        return { tag: match[1], code: match[2].toLowerCase() };
    }

    AiTextExtract.normalizeLcText = normalizeLcText;
    AiTextExtract.extractLcCallNumbers = extractLcCallNumbers;
    AiTextExtract.extractClassificationFromText = extractClassificationFromText;
    AiTextExtract.extractSubjectHeadingsFromText = extractSubjectHeadingsFromText;
    AiTextExtract.extractConfidencePercentFromText = extractConfidencePercentFromText;
    AiTextExtract.extractCatalogingSuggestionsFromText = extractCatalogingSuggestionsFromText;
    AiTextExtract.normalizeSubjectHeading = normalizeSubjectHeading;
    AiTextExtract.normalizeSubjectObject = normalizeSubjectObject;
    AiTextExtract.subjectObjectFromHeading = subjectObjectFromHeading;
    AiTextExtract.subjectsFromHeadingList = subjectsFromHeadingList;
    AiTextExtract.formatSubjectDisplay = formatSubjectDisplay;
    AiTextExtract.detectClassificationRange = detectClassificationRange;
    AiTextExtract.dedupeCaseInsensitive = dedupeCaseInsensitive;
    AiTextExtract.parseLcTarget = parseLcTarget;

    global.AACR2AiTextExtract = AiTextExtract;
})(typeof window !== 'undefined' ? window : globalThis);
