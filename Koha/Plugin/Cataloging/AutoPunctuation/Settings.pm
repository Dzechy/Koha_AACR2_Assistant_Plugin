package Koha::Plugin::Cataloging::AutoPunctuation::Settings;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;

sub _default_settings {
    return {
        enabled => 1,
        auto_apply_punctuation => 0,
        default_standard => 'AACR2',
        debug_mode => 0,
        enable_guide => 0,
        guide_users => '',
        guide_exclusion_list => '',
        custom_rules => '{}',
        internship_mode => 0,
        internship_users => '',
        internship_exclusion_list => '',
        enforce_aacr2_guardrails => 1,
        enable_live_validation => 1,
        block_save_on_error => 0,
        required_fields => '100a,245a,260c,300a,050a',
        excluded_tags => '',
        strict_coverage_mode => 0,
        enable_local_fields => 0,
        local_fields_allowlist => '',
        ai_enable => 0,
        ai_punctuation_explain => 1,
        ai_subject_guidance => 1,
        ai_callnumber_guidance => 1,
        ai_model => '',
        ai_model_openai => '',
        ai_model_openrouter => '',
        ai_timeout => 30,
        ai_max_output_tokens => 1024,
        ai_max_tokens => 1024,
        ai_temperature => 0.2,
        ai_reasoning_effort => 'low',
        ai_redaction_rules => '9XX,952,5XX',
        ai_redact_856_querystrings => 1,
        ai_context_mode => 'tag_only',
        ai_payload_preview => 0,
        ai_openrouter_response_format => 0,
        ai_rate_limit_per_minute => 6,
        ai_cache_ttl_seconds => 60,
        ai_cache_max_entries => 250,
        ai_retry_count => 2,
        ai_circuit_breaker_threshold => 3,
        ai_circuit_breaker_timeout => 60,
        ai_circuit_breaker_window_seconds => 120,
        ai_circuit_breaker_failure_rate => 0.5,
        ai_circuit_breaker_min_samples => 4,
        ai_confidence_threshold => 0.85,
        lc_class_target => '050$a',
        llm_api_provider => 'OpenRouter',
        llm_api_key => '',
        openrouter_api_key => '',
        ai_request_mode => 'server',
        last_updated => '',
    };
}
sub _load_model_cache {
    my ($self) = @_;
    my $raw = $self->retrieve_data('model_cache') || '{}';
    my $cache = {};
    try {
        $cache = from_json($raw);
    } catch {
        $cache = {};
    };
    return $cache;
}
sub _save_model_cache {
    my ($self, $cache) = @_;
    $self->store_data({ model_cache => to_json($cache || {}) });
}
sub _load_settings {
    my ($self) = @_;
    my $raw_settings = $self->retrieve_data('settings') || '{}';
    my $parsed = {};
    try {
        $parsed = from_json($raw_settings) || {};
    } catch {
        $parsed = {};
    };
    my $defaults = $self->_default_settings();
    return { %{$defaults}, %{$parsed} };
}
sub _debug_log {
    my ($self, $settings, $message) = @_;
    return unless $settings && $settings->{debug_mode};
    my $text = defined $message ? $message : '';
    $text =~ s/\s+$//;
    warn "AutoPunctuation debug: $text";
}
sub _safe_retrieve_data {
    my ($self, $key, $settings, $context) = @_;
    my $value;
    try {
        $value = $self->retrieve_data($key);
    } catch {
        my $label = $context || $key || 'data';
        $self->_debug_log($settings, "retrieve_data failed for $label: $_");
        $value = undef;
    };
    return $value;
}
sub _safe_store_data {
    my ($self, $data, $settings, $context) = @_;
    my $ok = 1;
    try {
        $self->store_data($data);
    } catch {
        my $label = $context || 'data';
        $self->_debug_log($settings, "store_data failed for $label: $_");
        $ok = 0;
    };
    return $ok;
}

1;
