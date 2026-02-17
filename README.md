# Koha_AACR2_Assistant_Plugin

## Overview
`Koha_AACR2_Assistant_Plugin` is an AACR2-focused cataloging assistant for Koha. It combines deterministic MARC21 punctuation/guardrail enforcement with optional AI guidance, an interactive training guide, and admin progress reporting.

This plugin is designed for real cataloging work, internship training workflows, and gradual AI adoption without losing rule-based control.

## Core Capabilities
- AACR2 guardrails and live validation on cataloging forms.
- Deterministic punctuation suggestions with apply/undo/ignore workflows.
- Optional auto-apply mode or suggestion-only mode.
- AI Assist panel for:
  - Classification suggestions
  - Subject heading suggestions
  - Rule/punctuation guidance
  - Call number build from classification + cutter + year
- Collection prefix support in call number build:
  - `Ref.`
  - `Spec. Col.`
  - `Fed. Doc.`
  - `St. Doc.`
  - `Juv. Col.`
  - `Media`
  - `Microform`
  - `Music`
- Interactive AACR2 training guide with module progression.
- Internship mode to enforce read-only learning behavior for selected users.
- Admin training progress table with filtering, sorting, and export (CSV/XLSX).
- Coverage report against MARC framework fields plus custom rule stubs.
- Update notification support from GitHub releases.

## AI Design Principles
- AI is advisory only; nothing is silently auto-committed.
- Deterministic rules remain first-class.
- Structured JSON mode is optional and configurable.
- Server-mode and direct-browser mode are both supported.
- Classification extraction keeps LC class numbers and strips cutter/year fragments where applicable.
- Cataloging AI response text is rendered with preserved line breaks for readability.

## Required Koha Core Deltas
This repository includes three reference files at repo root:
- `Auth.pm`
- `handler.pm`
- `run.pl`

These are **not standalone replacements** to copy blindly. They document functional deltas that must be applied to your Koha installation’s core files for this plugin’s request/response flow and error handling to work reliably.

### 1) `C4/Auth.pm`
Expected target in Koha install:
- `/usr/share/koha/lib/C4/Auth.pm`

Repo delta intent:
- Preserve login credential handling semantics around `POST` login (`op=cud-login`) while avoiding unsafe parameter wiping behavior in other contexts.

Why this matters for the plugin:
- The plugin relies on authenticated staff session behavior and stable request handling for plugin endpoints.
- Incorrect auth parameter handling can break plugin requests or cause inconsistent session behavior.

### 2) `Koha/Plugins/Handler.pm`
Expected target in Koha install:
- `/usr/share/koha/lib/Koha/Plugins/Handler.pm`

Repo delta intent:
- Defensive validation of plugin class/method input.
- Hardened `eval` around `load`, plugin instantiation, and method dispatch.
- Clear warnings for non-callable/invalid methods.

Why this matters for the plugin:
- Prevents fragile dispatch failures and improves runtime diagnostics.
- Avoids silent crashes or malformed plugin method execution paths.

### 3) `plugins/run.pl`
Expected target in Koha install:
- `/usr/share/koha/intranet/cgi-bin/plugins/run.pl`

Repo delta intent:
- Robust query-string fallback parsing.
- Stronger parameter validation for `class` and `method`.
- Consistent response emission for plugin API calls (including JSON error payloads).
- Avoids empty-response execution paths.

Why this matters for the plugin:
- The plugin uses `op=plugin_api` extensively for AI, model fetch, progress APIs, and settings tooling.
- Without these deltas, you may hit:
  - `End of script output before headers`
  - empty/XHR failures
  - unstable plugin API responses

## How to Apply Core Deltas Safely
1. Back up Koha core files:
```bash
sudo cp /usr/share/koha/lib/C4/Auth.pm /usr/share/koha/lib/C4/Auth.pm.bak
sudo cp /usr/share/koha/lib/Koha/Plugins/Handler.pm /usr/share/koha/lib/Koha/Plugins/Handler.pm.bak
sudo cp /usr/share/koha/intranet/cgi-bin/plugins/run.pl /usr/share/koha/intranet/cgi-bin/plugins/run.pl.bak
```

2. Compare your Koha files against this repo’s reference files and merge only relevant deltas:
```bash
diff -u /usr/share/koha/lib/C4/Auth.pm /path/to/repo/Auth.pm
diff -u /usr/share/koha/lib/Koha/Plugins/Handler.pm /path/to/repo/handler.pm
diff -u /usr/share/koha/intranet/cgi-bin/plugins/run.pl /path/to/repo/run.pl
```

3. Restart services after patching:
```bash
sudo systemctl restart koha-plack
sudo systemctl restart apache2
```

Notes:
- Koha package versions differ; merge carefully.
- Reapply/verify after Koha upgrades.
- Keep local patch documentation in your deployment runbook.

## Plugin Installation
1. Build `.kpz` package:
```bash
./scripts/build_kpz.sh
```

2. Upload in Koha intranet:
- Koha Administration -> Plugins -> Manage Plugins -> Upload plugin

3. Enable plugin and open:
- Tool page
- Configure page

## Configuration Guide
Main areas:
- General
  - Enable plugin
  - Auto-apply punctuation toggle
- AI Assist
  - Provider selection (`OpenRouter` or `OpenAI`)
  - Request mode (`Server` or `Direct browser`)
  - Model selection/search/filter
  - Prompt templates (punctuation + cataloging)
  - Strict JSON mode toggle
  - Connection test
- Rules & Validation
  - Guardrail enforcement
  - Live validation
  - Block save on error
  - Required/excluded field settings
  - Custom rules JSON
  - Coverage report
- Training
  - Interactive guide enable/disable
  - Exclusion lists
  - Internship mode user controls
  - Progress table + exports
- Advanced/Debug
  - Debug mode
  - Raw AI debug payload inclusion
  - AI payload preview

## AI Assist Panel Notes
Cataloging section provides:
- Title source from `245$a` plus optional `$n/$p/$b/$c` context.
- Classification/subjects suggestion toggles.
- AI response display with preserved newlines.
- Manual classification input.
- Derived cutter and publication year.
- Call number preview and apply action.
- Collection prefix options (`Ref.`, `Spec. Col.`, etc.) applied before class/cutter/year.

## Training Guide and Progress
- Guide is module-based and progress-aware.
- Completion and skipped state are tracked per user.
- Admin progress table includes module totals and overall completion progress.
- Export available in CSV and Excel.

## Security and Data Handling
- Koha session/auth and CSRF protections are required for plugin API endpoints.
- API keys are encrypted server-side in server mode.
- Direct browser mode stores obfuscated key locally in browser storage.
- Redaction controls are available for AI payload shaping.

## Troubleshooting
- API/XHR failures:
  - Verify core deltas above are applied correctly.
  - Confirm session validity and CSRF token flow.
- AI empty response or JSON parse issues:
  - Retry once.
  - Lower reasoning effort/max output tokens.
  - Disable strict JSON mode for non-compliant models.
- No model list:
  - Verify provider key and request mode.
- Guide progress not loading:
  - Verify plugin API endpoint behavior and Koha logs.

## Development Notes
Important directories/files:
- `Koha/Plugin/Cataloging/AutoPunctuation.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/Api.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/UI.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/AI/`
- `Koha/Plugin/Cataloging/AutoPunctuation/js/`
- `Koha/Plugin/Cataloging/AutoPunctuation/rules/aacr2_baseline.json`

## License
GPL-3.0. See `LICENSE`.
