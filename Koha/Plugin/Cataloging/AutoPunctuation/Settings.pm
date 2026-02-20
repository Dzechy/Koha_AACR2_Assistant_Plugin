package Koha::Plugin::Cataloging::AutoPunctuation::Settings;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt ();

sub _normalize_prompt_template {
    my ($value) = @_;
    my $text = defined $value ? "$value" : '';
    $text =~ s/\r\n/\n/g;
    $text =~ s/[ \t]+$//mg;
    my @lines = split /\n/, $text, -1;
    my @clean;
    my %seen_singleton;
    my %singleton = map { $_ => 1 } (
        'payload_json:',
        '{{payload_json}}',
        '{{source_text}}',
        'payload json:',
        'source text:'
    );
    my $prev = '';
    for my $line (@lines) {
        my $trimmed = $line;
        $trimmed =~ s/^\s+|\s+$//g;
        if ($trimmed eq '') {
            next if $prev eq '';
            push @clean, '';
            $prev = '';
            next;
        }
        my $lower = lc($trimmed);
        if ($singleton{$lower}) {
            next if $seen_singleton{$lower}++;
        }
        next if $trimmed eq $prev;
        push @clean, $line;
        $prev = $trimmed;
    }
    $text = join("\n", @clean);
    $text =~ s/\n{3,}/\n\n/g;
    $text =~ s/^\s+|\s+$//g;
    return $text;
}

sub _normalize_required_field_tokens {
    my ($value) = @_;
    my $raw = defined $value ? "$value" : '';
    my @items = split /\s*,\s*/, $raw;
    my @tokens;
    my %seen;
    for my $item (@items) {
        next unless defined $item;
        my $token = lc($item);
        $token =~ s/\s+//g;
        next unless $token ne '';
        next unless $token =~ /\A\d{3}(?:00|[a-z0-9]|\*)\z/;
        $token =~ s/\A(\d{3})00\z/${1}0/;
        next if $seen{$token}++;
        push @tokens, $token;
    }
    return \@tokens;
}

sub _merge_required_field_tokens {
    my ($baseline, $current) = @_;
    my @merged;
    my %seen;
    for my $source ($baseline, $current) {
        my $tokens = _normalize_required_field_tokens($source);
        for my $token (@{$tokens}) {
            next if $seen{$token}++;
            push @merged, $token;
        }
    }
    return join(',', @merged);
}

sub _default_ai_max_output_tokens {
    return 10000;
}

sub _resolve_ai_max_output_tokens {
    my ($self, @candidates) = @_;
    for my $candidate (@candidates) {
        next unless defined $candidate;
        my $value = "$candidate";
        $value =~ s/^\s+|\s+$//g;
        next if $value eq '';
        next unless $value =~ /\A\d+\z/;
        my $int_value = int($value);
        next if $int_value <= 0;
        return $int_value;
    }
    return _default_ai_max_output_tokens();
}

sub _default_settings {
    my $prompt_defaults = Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_default_ai_prompt_templates();
    my $default_max_output_tokens = _default_ai_max_output_tokens();
    return {
        enabled => 1,
        auto_apply_punctuation => 0,
        default_standard => 'AACR2',
        debug_mode => 0,
        enable_guide => 1,
        guide_users => '',
        guide_exclusion_list => '',
        custom_rules => '{}',
        internship_mode => 0,
        internship_users => '',
        internship_exclusion_list => '',
        intern_allow_assistant_toggle => 0,
        intern_allow_autoapply_toggle => 0,
        intern_allow_cataloging_panel => 1,
        intern_allow_ai_assist_toggle => 0,
        intern_allow_panel_apply_actions => 0,
        intern_allow_ai_cataloging => 0,
        intern_allow_ai_punctuation => 0,
        intern_allow_ai_apply_actions => 0,
        enforce_aacr2_guardrails => 1,
        enable_live_validation => 1,
        block_save_on_error => 0,
        required_fields => '0030,0080,040*,040c,942c,100a,245a,260c,300a,050a',
        excluded_tags => '',
        strict_coverage_mode => 0,
        enable_local_fields => 0,
        local_fields_allowlist => '',
        ai_enable => 1,
        ai_punctuation_explain => 1,
        ai_subject_guidance => 1,
        ai_callnumber_guidance => 1,
        ai_model => '',
        ai_model_openai => '',
        ai_model_openrouter => '',
        ai_timeout => 600,
        ai_max_output_tokens => $default_max_output_tokens,
        ai_temperature => 0.1,
        ai_reasoning_effort => 'low',
        ai_redaction_rules => '9XX,952,5XX',
        ai_redact_856_querystrings => 1,
        ai_context_mode => 'tag_only',
        ai_prompt_default => $prompt_defaults->{default},
        ai_prompt_cataloging => $prompt_defaults->{cataloging},
        ai_prompt_max_length => 16384,
        ai_payload_preview => 0,
        ai_debug_include_raw_response => 0,
        ai_openrouter_response_format => 0,
        ai_rate_limit_per_minute => 30,
        ai_cache_ttl_seconds => 300,
        ai_cache_max_entries => 1000,
        ai_retry_count => 1,
        ai_circuit_breaker_threshold => 5,
        ai_circuit_breaker_timeout => 45,
        ai_circuit_breaker_window_seconds => 180,
        ai_circuit_breaker_failure_rate => 0.5,
        ai_circuit_breaker_min_samples => 6,
        ai_confidence_threshold => 0.85,
        lc_class_target => '050$a',
        llm_api_provider => 'OpenRouter',
        llm_api_key => '',
        openrouter_api_key => '',
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
    $parsed = {} unless ref $parsed eq 'HASH';
    my $defaults = $self->_default_settings();
    my $settings = { %{$defaults}, %{$parsed} };
    my $expanded_required = $defaults->{required_fields} || '0030,0080,040*,040c,942c,100a,245a,260c,300a,050a';
    my $parsed_required = defined $parsed->{required_fields} ? "$parsed->{required_fields}" : '';
    $parsed_required =~ s/\s+//g;
    if ($parsed_required eq '') {
        $settings->{required_fields} = $expanded_required;
    }
    $settings->{required_fields} = _merge_required_field_tokens($expanded_required, $settings->{required_fields});
    delete $settings->{ai_request_mode};
    my @token_candidates = ($settings->{ai_max_output_tokens});
    my $resolved_max_tokens = _resolve_ai_max_output_tokens($self, @token_candidates);
    $settings->{ai_max_output_tokens} = $resolved_max_tokens;
    delete $settings->{ai_max_tokens};

    my $plain_prompts = Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_default_ai_prompt_templates_for_mode($self);
    my $active_prompts = $plain_prompts;
    my %known_prompt_variants = (
        default => {},
        cataloging => {}
    );
    for my $key (qw(default cataloging)) {
        for my $candidate (
            $plain_prompts->{$key},
            $defaults->{ $key eq 'default' ? 'ai_prompt_default' : 'ai_prompt_cataloging' },
            $active_prompts->{$key}
        ) {
            my $norm = _normalize_prompt_template($candidate);
            next unless $norm ne '';
            $known_prompt_variants{$key}{$norm} = 1;
        }
    }
    for my $key (qw(default cataloging)) {
        my $setting_key = $key eq 'default' ? 'ai_prompt_default' : 'ai_prompt_cataloging';
        my $active_default = $active_prompts->{$key} || '';
        my $value = defined $settings->{$setting_key} ? $settings->{$setting_key} : '';
        my $norm_value = _normalize_prompt_template($value);
        if ($norm_value eq '') {
            $settings->{$setting_key} = $active_default;
            next;
        }
        if ($known_prompt_variants{$key}{$norm_value}) {
            $settings->{$setting_key} = $active_default;
            next;
        }
        if ($norm_value ne $value) {
            $settings->{$setting_key} = $norm_value;
        }
    }
    if (exists $parsed->{enabled}) {
        my $raw_enabled = $parsed->{enabled};
        $settings->{enabled} = (defined $raw_enabled && $raw_enabled eq '0') ? 0 : ($raw_enabled ? 1 : 0);
    } else {
        $settings->{enabled} = 1;
    }
    return $settings;
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
