package Koha::Plugin::Cataloging::AutoPunctuation::AI;

use Modern::Perl;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Context;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard;

sub _cache_backend {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_backend(@_);
}

sub _cache_key {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_key(@_);
}

sub _cache_get_backend {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_get_backend(@_);
}

sub _cache_set_backend {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_set_backend(@_);
}

sub _cache_get {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_get(@_);
}

sub _cache_set {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_set(@_);
}

sub _normalize_occurrence {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_occurrence(@_);
}

sub _normalize_tag_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_tag_context(@_);
}

sub _normalize_record_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_record_context(@_);
}

sub _normalize_ai_features {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_ai_features(@_);
}

sub _normalize_ai_request_payload {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_ai_request_payload(@_);
}

sub _normalize_record_context_for_cache {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Context::_normalize_record_context_for_cache(@_);
}

sub _canonical_json {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_canonical_json(@_);
}

sub _cache_touch {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_touch(@_);
}

sub _cache_prune {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_cache_prune(@_);
}

sub _rate_limit_ok {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_rate_limit_ok(@_);
}

sub _current_borrowernumber {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_current_borrowernumber(@_);
}

sub _current_user_key {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache::_current_user_key(@_);
}

sub _circuit_key {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_key(@_);
}

sub _circuit_state {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_state(@_);
}

sub _circuit_save {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_save(@_);
}

sub _circuit_prune_history {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_prune_history(@_);
}

sub _circuit_failure_rate_exceeded {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_failure_rate_exceeded(@_);
}

sub _circuit_breaker_ok {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_circuit_breaker_ok(@_);
}

sub _record_failure {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_record_failure(@_);
}

sub _record_success {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit::_record_success(@_);
}

sub _call_openai_responses {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_call_openai_responses(@_);
}

sub _call_openrouter_responses {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_call_openrouter_responses(@_);
}

sub _call_openrouter_chat {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_call_openrouter_chat(@_);
}

sub _extract_openrouter_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_extract_openrouter_text(@_);
}

sub _format_provider_error {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_format_provider_error(@_);
}

sub _normalize_json_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_normalize_json_text(@_);
}

sub _try_parse_json_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_try_parse_json_text(@_);
}

sub _normalize_lc_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_normalize_lc_text(@_);
}

sub _format_lc_call_number {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_format_lc_call_number(@_);
}

sub _rank_lc_candidates {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_rank_lc_candidates(@_);
}

sub _extract_lc_call_numbers {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_extract_lc_call_numbers(@_);
}

sub _extract_confidence_percent_from_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_extract_confidence_percent_from_text(@_);
}

sub _normalize_subject_heading_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_normalize_subject_heading_text(@_);
}

sub _classification_range_message {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_classification_range_message(@_);
}

sub _is_chronological_subdivision {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_is_chronological_subdivision(@_);
}

sub _normalize_subject_object {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_normalize_subject_object(@_);
}

sub _subject_object_from_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_subject_object_from_text(@_);
}

sub _subjects_from_text_list {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_subjects_from_text_list(@_);
}

sub _dedupe_case_insensitive {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_dedupe_case_insensitive(@_);
}

sub _extract_subject_headings_from_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_extract_subject_headings_from_text(@_);
}

sub _extract_classification_from_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_extract_classification_from_text(@_);
}

sub _extract_cataloging_suggestions_from_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_extract_cataloging_suggestions_from_text(@_);
}

sub _parse_lc_target {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_parse_lc_target(@_);
}

sub _build_degraded_ai_response {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_build_degraded_ai_response(@_);
}

sub _build_unstructured_ai_response {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_build_unstructured_ai_response(@_);
}

sub _summarize_ai_findings {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_summarize_ai_findings(@_);
}

sub _confidence_percent_from_findings {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_confidence_percent_from_findings(@_);
}

sub _augment_cataloging_response {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse::_augment_cataloging_response(@_);
}

sub _sanitize_ai_response_for_chat {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_sanitize_ai_response_for_chat(@_);
}

sub _ai_key_available {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_ai_key_available(@_);
}

sub _selected_model {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_selected_model(@_);
}

sub _normalized_reasoning_effort {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_normalized_reasoning_effort(@_);
}

sub _is_openai_reasoning_model {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_is_openai_reasoning_model(@_);
}

sub _call_ai_provider {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_call_ai_provider(@_);
}

sub _extract_response_text {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_extract_response_text(@_);
}

sub _response_truncated {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_response_truncated(@_);
}

sub _append_truncation_warning {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider::_append_truncation_warning(@_);
}

sub _is_cataloging_ai_request {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_is_cataloging_ai_request(@_);
}

sub _cataloging_tag_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_cataloging_tag_context(@_);
}

sub _is_placeholder_cataloging_value {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_is_placeholder_cataloging_value(@_);
}

sub _cataloging_value_score {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_cataloging_value_score(@_);
}

sub _cataloging_source_from_tag_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_cataloging_source_from_tag_context(@_);
}

sub _build_cataloging_error_response {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_build_cataloging_error_response(@_);
}

sub _build_ai_prompt {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_build_ai_prompt(@_);
}

sub _build_ai_prompt_punctuation {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_build_ai_prompt_punctuation(@_);
}

sub _build_ai_prompt_cataloging {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_build_ai_prompt_cataloging(@_);
}

sub _validate_ai_response_guardrails {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard::_validate_ai_response_guardrails(@_);
}

sub _redact_tag_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard::_redact_tag_context(@_);
}

sub _redact_record_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard::_redact_record_context(@_);
}

sub _filter_record_context {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard::_filter_record_context(@_);
}

sub _redact_value {
    return Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard::_redact_value(@_);
}

1;
