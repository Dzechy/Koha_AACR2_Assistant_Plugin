/**
 * AACR2 Intellisense bootstrapper for Koha cataloging forms.
 */
(function(global, $) {
    'use strict';

    $(document).ready(function() {
        if (!global.AutoPunctuation) {
            global.AutoPunctuation = { initialized: false };
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
        if ($('#cat_addbiblio, form[name="f"], #record').length) {
            global.AACR2IntellisenseUI.init(settings);
            global.AutoPunctuation.initialized = true;
        }
    });
})(window, window.jQuery);
