# Koha AACR2 AI Guardrail Assistant

Buy Me a Coffee (Crypto)

If this saved you time (or a shoot 👀), you can fuel more dev with a small tip:

BTC: 19JSzRPB5qp3TKZVBeVUR8xmgntxKui5cc

LTC: LesDgPh9BVp8SgbXqk8GbyCzHwnrgn7tDv

ETH (ERC20): 0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

USDT (ERC20):  0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

USDC (ERC20): 0x5cc9f67d0f8328a46b9f9e12a1cfbf1a379e5947

Thanks a ton! 🙏

## Table of Contents

- Overview
- Key Features
- Requirements
- Installation
- Configuration
- Using the Plugin
- Training Guide Modules
- Internship Mode
- AI Assist
- Admin Training Progress
- Copy Cataloging Notes
- Troubleshooting
- Development Notes
- License

## Overview

The Koha AACR2 AI Guardrail Assistant enforces AACR2-only MARC21 punctuation rules with guardrails, live validation, and an optional AI assist layer. It adds a floating cataloging assistant panel, inline indicators, an interactive training guide, and configurable guardrails designed for both training and production cataloging.

## Key Features

- AACR2 punctuation rules with deterministic enforcement.
- Inline indicators and ghost suggestions.
- Floating assistant panel with apply/undo/ignore controls.
- Training guide with modules (jump to Title, Publication, Subjects, etc.).
- Internship mode to disable auto-apply while keeping warnings visible.
- AI assist for punctuation explanations and guidance (optional).
- Coverage report and custom rules support.

## Requirements

- Koha intranet access with plugin support enabled.
- Modern browser (MutationObserver support recommended).
- Optional: OpenAI API key for AI assist.

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

AI assist is optional and requires an API key. AI responses are constrained to JSON and never auto-apply changes. All AI suggestions require explicit user acceptance.

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

## Development Notes

Core files:

- `Koha/Plugin/Cataloging/AutoPunctuation.pm` (plugin logic)
- `Koha/Plugin/Cataloging/AutoPunctuation/js/marc_intellisense_ui.js` (UI/guide)
- `Koha/Plugin/Cataloging/AutoPunctuation/js/rules_engine.js` (validation)
- `Koha/Plugin/Cataloging/AutoPunctuation/rules/aacr2_baseline.json` (rules)

Custom rules can be added in JSON format on the configuration page.

## License

MIT License. See `LICENSE`.
