# Koha_AACR2_Assistant_Plugin

## Buy Me A Coffee
If this plugin saved you from one more AACR2 MARC rules headache, coffee keeps the devs and fixes coming.

- Non-crypto donation: [https://selfany.com/kaacr2plugindonate](https://selfany.com/kaacr2plugindonate)
- BTC: `19JSzRPB5qp3TKZVBeVUR8xmgntxKui5cc`
- ETH (ERC20): `0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947`
- USDT (ERC20): `0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947`
- USDC (ERC20): `0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947`
- LTC: `LesDgPh9BVp8SgbXqk8GbyCzHwnrgn7tDv`

## What This Plugin Does
`Koha_AACR2_Assistant_Plugin` is an AACR2-focused cataloging assistant for Koha.

It provides:
- Deterministic AACR2 punctuation and guardrail checks
- Optional AI suggestions (classification, subjects, punctuation rationale)
- A live side panel with apply/undo/redo workflows
- A training guide with user progress tracking and exports
- Coverage reporting against MARC frameworks with custom-rule stubs

AI is advisory. Rule-based validation remains primary.

## Requirements
- **Koha minimum version: `25.11`**
- Plugin framework enabled in Koha
- Staff permissions to configure and run plugins
- For AI features:
  - OpenRouter or OpenAI API key
  - Koha `encryption_key` configured in `koha-conf.xml`

## Included Core Delta References
This repo includes reference files at root:
- `Auth.pm`
- `handler.pm`
- `run.pl`

These are reference deltas for Koha core behavior around plugin dispatch/auth/session handling. Do not blindly overwrite your Koha files.

Expected Koha targets:
- `/usr/share/koha/lib/C4/Auth.pm`
- `/usr/share/koha/lib/Koha/Plugins/Handler.pm`
- `/usr/share/koha/intranet/cgi-bin/plugins/run.pl`

## Safe Delta Application
1. Backup:
```bash
sudo cp /usr/share/koha/lib/C4/Auth.pm /usr/share/koha/lib/C4/Auth.pm.bak
sudo cp /usr/share/koha/lib/Koha/Plugins/Handler.pm /usr/share/koha/lib/Koha/Plugins/Handler.pm.bak
sudo cp /usr/share/koha/intranet/cgi-bin/plugins/run.pl /usr/share/koha/intranet/cgi-bin/plugins/run.pl.bak
```

2. Diff and merge only required changes:
```bash
diff -u /usr/share/koha/lib/C4/Auth.pm /path/to/repo/Auth.pm
diff -u /usr/share/koha/lib/Koha/Plugins/Handler.pm /path/to/repo/handler.pm
diff -u /usr/share/koha/intranet/cgi-bin/plugins/run.pl /path/to/repo/run.pl
```

3. Restart:
```bash
sudo systemctl restart koha-plack
sudo systemctl restart apache2
```

## Plugin Installation
1. Build:
```bash
./scripts/build_kpz.sh
```

2. Upload in Koha intranet:
- Administration -> Plugins -> Manage Plugins -> Upload plugin

3. Open:
- Tool page (`method=tool`)
- Configure page (`method=configure`)

## Configure Page Manual
The configure page is tab-based.

### 1) General
- **Enable AACR2 Intellisense**: master on/off for form behavior.
- **Auto-Apply Fixes**: if ON, non-error fixes can auto-apply after validation.
- **Cataloging Standard**: currently AACR2/MARC21.

### 2) AI Assist (Optional)
- **Enable AI Assist**: enables AI panel in cataloging form.
- **AI Field Guidance**: punctuation/rationale guidance.
- **AI Subject Guidance**: subject suggestion mode.
- **AI Call Number Guidance**: classification/call-number guidance.
- **LC Classification Target**: where class is written (default `050$a`).
- **AI Provider**: OpenRouter/OpenAI.
- **API Key field**:
  - Provider-specific key state indicator
  - Server-stored/encrypted
  - Clear key action available
- **Model**:
  - Server-fetched provider model list
  - Search and refresh
  - OpenRouter filters: text/image/input/output/free
- **Test Connection**: validates provider connectivity through plugin API.
- **Prompt editors**:
  - Default punctuation prompt
  - Cataloging prompt
  - Prompt max-length guardrail
  - Reset to shipped defaults

### 3) Rules & Validation
- **Enforce AACR2 Guardrails**
- **Enable Live Validation**
- **Block Save on Errors**
- **Required AACR2 Fields** (default `0030,0080,040c,942c,100a,245a,260c,300a,050a`)
- **Excluded Tags** (example `590a,9XX`)
- **Strict Coverage Mode**
- **Enable Local (9XX) Fields**
- **Local Fields Allowlist**

#### Custom AACR2 Rules (JSON)
- Use the editor under **Custom AACR2 Rules**.
- Import/export JSON supported.
- Expected wrapper:
```json
{
  "rules": [
    {
      "id": "CUSTOM_245B_TRAILING",
      "tag": "245",
      "subfields": ["b"],
      "severity": "WARNING",
      "checks": [
        {
          "type": "punctuation",
          "suffix": " /",
          "suffix_mode": "when_following",
          "when_following_subfields": ["c"],
          "severity": "WARNING",
          "message": "Add slash before statement of responsibility when 245$c exists."
        }
      ]
    }
  ]
}
```

### 4) Training
- **Enable Interactive AACR2 Guide**
- **Exclude Users from Guide** table:
  - Search + selected/unselected filters
  - Select-all support
- **Guide exclusion list** (manual comma-separated usernames)
- **Internship mode** and internship user selection:
  - Search + selected/unselected filters
  - Select-all support
  - Manual internship exclusion list
- **Intern Access Controls** (for internship-selected users):
  - Allow AACR2 Assistant toggle
  - Allow Auto-apply toggle
  - Allow Cataloging Assistant panel toggle
  - Allow AI Assist toggle
  - Allow apply/undo actions in Cataloging Assistant panel
  - Allow AI cataloging requests
  - Allow AI punctuation requests
  - Allow AI panel apply actions
- **Training progress table** with:
  - Search/filter
  - Status/tier/module filters
  - Header-arrow sorting
  - Manual refresh
  - CSV/XLSX export
  - Auto-refresh

Tier logic is completion-based:
- `0% - 33%` -> Tier 1
- `34% - 66%` -> Tier 2
- `67% - 100%` -> Tier 3

### 5) Advanced/Debug
- **Debug & Preview**
  - Debug mode
  - Include raw AI debug payload
  - Payload preview
- **AI Safety & Context**
  - Redaction rules
  - Redact `856$u` query strings
  - Context scope (`tag_only`, `tag_plus_neighbors`, `full`)
- **AI Tuning & Limits**
  - Reasoning effort (`none|low|medium|high`) for OpenAI reasoning models
  - Timeout
  - Max output tokens
  - Temperature
  - Ghost confidence threshold
  - Rate limit per minute
  - Cache TTL
  - Cache max entries
  - Retry count
  - Circuit breaker threshold
  - Circuit breaker timeout
  - Circuit breaker window
  - Circuit breaker failure rate
  - Circuit breaker min samples

## Coverage Report Manual
Coverage is shown per framework and per `tag$subfield`.

Statuses:
- **Covered**: at least one rule matches the `tag$subfield`
- **Excluded**: excluded by current config
- **Not covered**: no rule currently applies

How to use it:
1. Open **Rules & Validation -> Coverage Report**.
2. Expand the framework you use.
3. Sort by Tag/Subfield/Status using column arrows.
4. Copy from **Recommended Rule Stubs (JSON)** to bootstrap missing coverage.
5. Paste stubs into Custom Rules editor, then refine checks/messages/fixes.

Accuracy notes:
- Coverage is computed against merged baseline + custom rules.
- Coverage matching checks tag/subfield patterns directly (indicator-agnostic for report matching), so indicator-specific rules are still counted as coverage for that field pair.
- Duplicate framework rows are de-duplicated per `tag$subfield` for reporting.

## Custom Rules: Practical Examples

### Example A: Force terminal period on `500$a`
```json
{
  "rules": [
    {
      "id": "CUSTOM_500A_PERIOD",
      "tag": "500",
      "subfields": ["a"],
      "severity": "WARNING",
      "checks": [
        {
          "type": "punctuation",
          "suffix": ".",
          "suffix_mode": "always",
          "severity": "WARNING",
          "message": "500$a should end with a period."
        }
      ]
    }
  ]
}
```

### Example B: Conditional punctuation for `300$a`
```json
{
  "rules": [
    {
      "id": "CUSTOM_300A_CONDITIONAL",
      "tag": "300",
      "subfields": ["a"],
      "severity": "INFO",
      "checks": [
        {
          "type": "punctuation",
          "suffix_mode": "conditional_following",
          "when_following_subfields": ["b"],
          "suffix_if_following": " :",
          "suffix_if_last": ".",
          "severity": "INFO",
          "message": "300$a uses colon when 300$b follows, period otherwise."
        }
      ]
    }
  ]
}
```

### Example C: Indicator-limited rule
```json
{
  "rules": [
    {
      "id": "CUSTOM_246_IND1_3",
      "tag": "246",
      "ind1": "3",
      "subfields": ["a"],
      "severity": "WARNING",
      "checks": [
        {
          "type": "punctuation",
          "suffix": ".",
          "suffix_mode": "always",
          "severity": "WARNING",
          "message": "246 (ind1=3) title variant should end with a period."
        }
      ]
    }
  ]
}
```

Validation tips:
- Keep IDs unique.
- Use `rules` array wrapper.
- Save, reopen coverage report, confirm status moved from Not covered -> Covered.

## Tool Page Manual
The tool page is a status and quick-navigation dashboard.

Shows:
- Plugin runtime status cards (assistant, guide, validation, AI, API key, provider/model, cataloging standard)
- Links to configuration and plugin docs
- Supported field examples
- Troubleshooting shortcuts

Use it to quickly confirm whether:
- AI Assist is enabled
- API key is configured
- Model/provider are set
- Guardrails/live validation are active

## Cataloging Form Manual
When enabled, the plugin UI is injected on `*/cataloguing/addbiblio.pl` only.

Call-number carryover:
- When a full call number is applied in AI Assist, the plugin stores it temporarily and auto-populates `items.itemcallnumber` (typically `952$o`) when `*/cataloguing/additem.pl` opens.

### Toolbar
- AACR2 Assistant ON/OFF
- Auto-apply toggle
- Cataloging Assistant panel toggle
- AI Assist panel toggle
- Guide toggle

### Cataloging Assistant Panel
- Field findings grouped by severity
- Apply single fix / Apply all
- Undo / Redo / Undo all
- Ignore controls
- Ghost text suggestions per field (scoped to matching tag/subfield/occurrence)

### AI Assist Panel
- Cataloging suggestions (classification/subjects)
- Rules/punctuation suggestions for selected field
- Apply selected/all AI patches
- Classification input + call number build/apply
- Optional mapping toggle to also apply call-number parts to `942$h` (classification), `942$i` (cutter/year), and `942$k` (prefix)
- AI response/debug views
- Adaptive waiting status during AI calls (elapsed timer + long-wait notifications)

### Training Guide Panel
- Step-by-step AACR2 rule checks
- Module selector
- Per-step check/skip/next flow
- Progress, module completion, tier display

## Security and Data Handling
- Plugin endpoints require authenticated staff session.
- CSRF token checks are enforced.
- API keys are encrypted server-side when Koha encryption is configured.
- Optional redaction rules for AI payloads.

## Troubleshooting
- **No model list**: verify provider key, then refresh model list.
- **AI request errors**: test connection, check timeout/token settings, inspect debug payload.
- **Progress table empty**: verify plugin API route behavior and Koha logs.
- **Save blocked**: inspect error findings and required field list.
- **Coverage looks low**: check exclusions/local allowlist and add custom rules from stubs.

## Development Map
- `Koha/Plugin/Cataloging/AutoPunctuation.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/UI.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/Api.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/Rules.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/GuideProgress.pm`
- `Koha/Plugin/Cataloging/AutoPunctuation/configure.tt`
- `Koha/Plugin/Cataloging/AutoPunctuation/tool.tt`
- `Koha/Plugin/Cataloging/AutoPunctuation/js/`
- `Koha/Plugin/Cataloging/AutoPunctuation/rules/aacr2_baseline.json`

## License
GPL-3.0. See `LICENSE`.
