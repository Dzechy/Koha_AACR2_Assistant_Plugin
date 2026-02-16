// Cutter-Sanborn helper (ported from cuttersanborn npm module).
(function(global) {
    'use strict';

    const cutterData = global.AACR2CutterSanbornData || {};
    const ARTICLE_WORDS = new Set(['a', 'an', 'the']);
    const FIRST_WORD_TAGS = new Set(['245', '110', '111']);

    function normalizeInput(value) {
        return (value || '').toString().replace(/\s+/g, ' ').trim();
    }

    function tokenize(value) {
        return normalizeInput(value)
            .replace(/[^A-Za-z0-9,\s]/g, ' ')
            .split(/\s+/)
            .filter(Boolean);
    }

    function parseCommaName(text) {
        const parts = text.split(',');
        const lastname = normalizeInput(parts[0]);
        const remainder = normalizeInput(parts.slice(1).join(' '));
        const firstname = remainder.split(/\s+/)[0] || '';
        return { lastname, firstname };
    }

    function parseTitleLike(text) {
        const tokens = tokenize(text).filter(token => token !== ',');
        if (!tokens.length) return { lastname: '', firstname: '' };
        let index = 0;
        if (ARTICLE_WORDS.has(tokens[0].toLowerCase()) && tokens.length > 1) {
            index = 1;
        }
        return {
            lastname: tokens[index] || '',
            firstname: tokens[index + 1] || ''
        };
    }

    function parseFirstWord(text) {
        const tokens = tokenize(text).filter(token => token !== ',');
        if (!tokens.length) return { lastname: '', firstname: '' };
        return { lastname: tokens[0], firstname: '' };
    }

    function parseDefaultName(text) {
        const tokens = tokenize(text).filter(token => token !== ',');
        if (!tokens.length) return { lastname: '', firstname: '' };
        if (tokens.length === 1) return { lastname: tokens[0], firstname: '' };
        return {
            lastname: tokens[tokens.length - 1],
            firstname: tokens[0]
        };
    }

    function parseCutterSource(value, sourceTag) {
        const text = normalizeInput(value);
        if (!text) return { lastname: '', firstname: '' };
        if (sourceTag === '100') {
            return parseFirstWord(text);
        }
        if (sourceTag && FIRST_WORD_TAGS.has(sourceTag)) {
            return parseTitleLike(text);
        }
        if (text.includes(',')) {
            return parseCommaName(text);
        }
        return parseDefaultName(text);
    }

    function generateCutter(lastname, firstname, args) {
        const options = args || {};
        const suffix = options.suffix || '';
        const cleanedFirst = (firstname || '').toLowerCase().replace(/\W/g, '');
        const cleanedLast = (lastname || '').toLowerCase().replace(/\W/g, '');
        if (!cleanedLast) return '';

        const format = num => {
            const ch = cleanedLast.toUpperCase().slice(0, 1);
            return `${ch}${num}${suffix}`;
        };

        if (cleanedFirst) {
            let letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
            letters = letters.slice(0, letters.indexOf(cleanedFirst[0]) + 1);
            for (const c of letters.reverse()) {
                const key = `${cleanedLast},${c}.`;
                const num = cutterData[key];
                if (num) return format(num);
            }
        }

        let key = cleanedLast;
        while (key) {
            const num = cutterData[key];
            if (num) return format(num);
            key = key.slice(0, key.length - 1);
        }
        return '';
    }

    function build(value, sourceTag) {
        const parsed = parseCutterSource(value, sourceTag);
        const cutter = generateCutter(parsed.lastname, parsed.firstname);
        if (!cutter) return '';
        return cutter.startsWith('.') ? cutter : `.${cutter}`;
    }

    global.AACR2CutterSanborn = { build, generate: generateCutter };
})(window);
