/**
 * AACR2 Intellisense bootstrapper for Koha cataloging forms.
 */
(function(global, $) {
    'use strict';

    const PENDING_CALLNUMBER_KEY = 'aacr2PendingItemCallNumber';

    function currentPath() {
        return (global.location && global.location.pathname ? String(global.location.pathname) : '').toLowerCase();
    }

    function isAddBiblioPage() {
        return currentPath().includes('/cataloguing/addbiblio.pl');
    }

    function isAddItemPage() {
        return currentPath().includes('/cataloguing/additem.pl');
    }

    function readPendingCallNumber() {
        try {
            return (global.sessionStorage && global.sessionStorage.getItem(PENDING_CALLNUMBER_KEY)) || '';
        } catch (err) {
            return '';
        }
    }

    function clearPendingCallNumber() {
        try {
            if (global.sessionStorage) global.sessionStorage.removeItem(PENDING_CALLNUMBER_KEY);
        } catch (err) {
            // ignore storage failures
        }
    }

    function applyPendingCallNumberToAddItem() {
        const pending = (readPendingCallNumber() || '').toString().trim();
        if (!pending) return;
        const selectors = [
            'input[name="items.itemcallnumber"]',
            'input[id^="tag_952_subfield_o_"]',
            '#tag_952_subfield_o_542952'
        ];
        let applied = false;
        selectors.some(selector => {
            const $field = $(selector).first();
            if (!$field.length) return false;
            const current = ($field.val() || '').toString().trim();
            if (!current) {
                $field.val(pending);
                $field.trigger('change');
            }
            applied = true;
            return true;
        });
        if (applied) {
            clearPendingCallNumber();
        }
    }

    $(document).ready(function() {
        if (!global.AutoPunctuation) {
            global.AutoPunctuation = { initialized: false };
        }
        if (isAddItemPage()) {
            applyPendingCallNumberToAddItem();
            return;
        }
        if (!isAddBiblioPage()) {
            return;
        }
        if (!global.AutoPunctuationSettings) {
            console.warn('[AACR2 Assistant] Settings not available; plugin idle.');
            return;
        }
        if (!global.AACR2RulesEngine || !global.AACR2IntellisenseUI) {
            console.warn('[AACR2 Assistant] Required modules missing; plugin idle.');
            return;
        }
        const settings = global.AutoPunctuationSettings;
        settings.catalogingStandard = 'AACR2';
        if ($('#cat_addbiblio, #record').length) {
            global.AACR2IntellisenseUI.init(settings);
            global.AutoPunctuation.initialized = true;
        }
    });
})(window, window.jQuery);
