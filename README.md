# Koha AACR2 AI Guardrail Assistant

Buy Me a Coffee (Crypto)

If this saved you time (or a shout 👀), you can fuel more dev with a small tip:

BTC: 19JSzRPB5qp3TKZVBeVUR8xmgntxKui5cc

LTC: LesDgPh9BVp8SgbXqk8GbyCzHwnrgn7tDv

ETH (ERC20): 0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

USDT (ERC20):  0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

USDC (ERC20): 0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

Thanks a ton! 🙏

## Table of Contents

- [Overview](#overview)
- [Changelog](#changelog)
- [Key Features](#key-features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Using the Plugin](#using-the-plugin)
- [Training Guide Modules](#training-guide-modules)
- [Internship Mode](#internship-mode)
- [AI Assist](#ai-assist)
- [Admin Training Progress](#admin-training-progress)
- [Copy Cataloging Notes](#copy-cataloging-notes)
- [Troubleshooting](#troubleshooting)
- [Development Notes](#development-notes)
- [Testing](#testing)
- [License](#license)

## Overview

The Koha AACR2 AI Guardrail Assistant enforces AACR2-only MARC21 punctuation rules with guardrails, live validation, and an optional AI assist layer. It adds a floating cataloging assistant panel, inline indicators, an interactive training guide, and configurable guardrails designed for both training and production cataloging.

## Changelog

- 2026-01-29: Progress endpoints now return JSON on errors, accept JSON or form payloads, and store per-user progress safely with migration from legacy data. The guide UI reports sync failures with status messages. Configuration tabs now use Bootstrap 5 tab markup styled as hyperlinks. Added OpenAI reasoning effort controls, higher default max output tokens, and truncation warnings.
- 2026-02-13: Added server/direct request-mode API key UX updates, browser-key persistence hardening, provider model fetch gating (no live fetch without configured key), elapsed AI request status messaging, stronger subject extraction/subdivision handling (`x/y/z/v`), per-subject apply actions, strict JSON prompt toggle, and prompt defaults updated to include `source_text`.
- 2026-02-13: Improved AI error handling for HTTP 429/empty-provider responses with actionable guidance, added robust parsing for OpenRouter/OpenAI array-style content blocks, tightened false-positive classification range checks, removed bulk subject apply in favor of per-suggestion apply buttons, added intelligent duplicate-aware subject application with replace-toggle behavior, and updated heading guidance/rules to avoid forced terminal punctuation in 1XX/6XX/7XX/8XX. Added a 100$a guardrail for missing comma-space in personal name main entry form.
- 2026-02-13: Expanded training-guide/rules consistency for conservative punctuation policy: added hands-off coverage for 041/255/340/856 and complex notes (505/533/534), added 250$b and 300$e support, refined 300$c `+` handling before accompanying material, and aligned 246 guidance to minimal auto-punctuation.

## Key Features

- AACR2 punctuation rules with deterministic enforcement.
- Inline indicators and ghost suggestions.
- Floating assistant panel with apply/undo/ignore controls.
- Training guide with modules (jump to Title, Publication, Subjects, etc.).
- Internship mode to disable auto-apply while keeping warnings visible.
- AI assist for punctuation explanations, classification, and subject guidance (optional).
- Deterministic call number builder (classification + cutter + year) with manual override.
- Coverage report and custom rules support.

## Requirements

- Koha intranet access with plugin support enabled.
- Modern browser (MutationObserver support recommended).
- Optional: OpenAI or OpenRouter API key for AI assist.

## Installation

1. Download the plugin package and upload it in Koha:
   `Koha Administration → Plugins → Manage Plugins → Upload plugin`.
2. Enable the plugin after upload.
3. Open the plugin tool page to verify status.

## Configuration

Open the configuration page from the plugin tool.

Important options:

- `Enable AACR2 Intellisense` to activate the plugin.
- `Auto-Apply Punctuation` to choose between auto-apply or suggest-only.
- `Enable Interactive AACR2 Guide` to show the training guide.
- `Internship Mode` to disable auto-apply for selected users.
- `Required AACR2 Fields` to enforce required subfields.
- AI options for OpenAI connectivity and model selection.
  Model lists are pulled dynamically from the selected provider.

## Using the Plugin

On the cataloging editor:

- Use the toolbar to toggle AACR2 assistant and AI assist.
- Use the floating Cataloging Assistant to apply/undo/ignore suggestions.
- Open the Training Guide for step-by-step AACR2 practice.

## Training Guide Modules

The training guide is organized by bibliographic areas so catalogers can jump directly to a module:

- Title & Statement (245/246)
- Edition (250)
- Publication (260/264)
- Physical Description (300)
- Series (440/490/8xx)
- Notes (5xx)
- Subjects (6xx)
- Added Entries (7xx)
- Linking Entries (76x-78x)
- Main Entry Names (1xx)
- Identifiers (0xx)

The guide tracks completed and skipped steps and shows module completion indicators. When all modules are complete, a congratulatory dialog appears.

## Internship Mode

Internship mode disables auto-apply and apply/undo actions for selected users, while still allowing them to view warnings and errors. This supports supervised learning without removing guardrails.

## AI Assist

AI assist is optional and requires an API key.

- `Server (Koha)` mode uses provider keys stored server-side only.
- `Direct browser` mode uses obfuscated browser-local keys and sends requests directly from the browser.
- Strict JSON mode can be enabled in configuration to make default prompts request structured JSON output.
- AI suggestions are never auto-applied; all actions require explicit user acceptance.
- Classification and subject guidance are based on 245 title source text, while call numbers are built deterministically from classification + cutter + year.

## Admin Training Progress

The configuration page includes a training progress table with search, sorting, and status filtering. It shows:

- Steps completed and skipped
- Modules completed
- Last updated time

Progress is recorded when catalogers use the training guide.

## Copy Cataloging Notes

The plugin refreshes guardrails after load and watches for dynamic field inserts. This ensures validation and assistant findings remain accurate during copy cataloging workflows.

## Troubleshooting

- Enable debug mode for console logs.
- Confirm required fields and excluded tags are correctly configured.
- If AI assist fails, verify API key and model settings.
- For missing guide steps, ensure fields exist on the cataloging form.
- OpenRouter JSON issues: some models ignore strict JSON. The plugin now strips code fences, repairs JSON when possible, and falls back to plain text while showing debug details in the AI panel. If you see parsing errors, disable strict JSON mode or switch models.

## Development Notes

Core files:

- `Koha/Plugin/Cataloging/AutoPunctuation.pm` (plugin logic)
- `Koha/Plugin/Cataloging/AutoPunctuation/js/marc_intellisense_ui.js` (UI/guide)
- `Koha/Plugin/Cataloging/AutoPunctuation/js/rules_engine.js` (validation)
- `Koha/Plugin/Cataloging/AutoPunctuation/rules/aacr2_baseline.json` (rules)

Custom rules can be added in JSON format on the configuration page.

## Testing

Run the rules engine regression fixtures:

```bash
node tests/rules_engine.test.js
```

Perl schema/regex validator tests (requires a Koha environment):

```bash
prove -l t
```

Build the plugin package (`.kpz`) with:

```bash
./scripts/build_kpz.sh
```

## License

MIT License. See `LICENSE`.
