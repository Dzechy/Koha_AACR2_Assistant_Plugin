package Koha::Plugin::Cataloging::AutoPunctuation::Api;

use Modern::Perl;
use Try::Tiny;
use Digest::SHA qw(sha256_hex);
use C4::Context;
use CGI;
use Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt ();

sub _ai_prompt_cache_component {
    my ($self, $settings, $mode) = @_;
    $settings = {} unless $settings && ref $settings eq 'HASH';
    my $prompt_mode = ($mode || '') eq 'cataloging' ? 'cataloging' : 'punctuation';
    my $defaults = Koha::Plugin::Cataloging::AutoPunctuation::AI::Prompt::_default_ai_prompt_templates_for_mode($self);
    my $template = $prompt_mode eq 'cataloging'
        ? ($settings->{ai_prompt_cataloging} // '')
        : ($settings->{ai_prompt_default} // '');
    if ($template !~ /\S/) {
        $template = $prompt_mode eq 'cataloging' ? ($defaults->{cataloging} || '') : ($defaults->{default} || '');
    }
    return sha256_hex(join('|', $Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION, $prompt_mode, $template));
}
sub _debug_raw_response_enabled {
    my ($self, $settings) = @_;
    return ($settings && $settings->{ai_debug_include_raw_response}) ? 1 : 0;
}
sub _sanitize_debug_text {
    my ($self, $text, $max_length) = @_;
    my $value = defined $text ? "$text" : '';
    $value =~ s/\r\n/\n/g;
    $value =~ s/([\"\']?(?:api[_-]?key|openrouter_api_key|llm_api_key|token|secret)[\"\']?\s*[:=]\s*[\"\']?)([^\"\'\s,}]+)/${1}[REDACTED]/ig;
    $value =~ s/([\"\']?authorization[\"\']?\s*[:=]\s*[\"\']?bearer\s+)([^\"\'\s,}]+)/${1}[REDACTED]/ig;
    $value =~ s/\b(Bearer\s+)([A-Za-z0-9._\-]+)/${1}[REDACTED]/ig;
    my $limit = ($max_length && $max_length > 0) ? int($max_length) : 0;
    if ($limit && length($value) > $limit) {
        my $truncated = length($value) - $limit;
        my $suffix = " [TRUNCATED:$truncated]";
        my $cutoff = $limit - length($suffix);
        $cutoff = 0 if $cutoff < 0;
        $value = substr($value, 0, $cutoff) . $suffix;
    }
    return $value;
}

sub _strip_internal_payload_fields {
    my ($payload) = @_;
    return {} unless $payload && ref $payload eq 'HASH';
    delete $payload->{csrf_token};
    return $payload;
}

sub _build_ai_debug_payload {
    my ($self, $settings, $provider_result, $parse_error_override) = @_;
    $provider_result = {} unless $provider_result && ref $provider_result eq 'HASH';
    my %debug;
    my $parse_error = defined $parse_error_override
        ? $parse_error_override
        : ($provider_result->{parse_error} || '');
    $parse_error = $self->_sanitize_debug_text($parse_error, 200);
    $debug{parse_error} = $parse_error if $parse_error ne '';

    if ($self->_debug_raw_response_enabled($settings)) {
        my $raw_provider = $self->_sanitize_debug_text($provider_result->{raw_response}, 12000);
        my $raw_text = $self->_sanitize_debug_text($provider_result->{raw_text}, 3800);
        $debug{raw_provider_response} = $raw_provider if $raw_provider ne '';
        $debug{raw_text} = $raw_text if $raw_text ne '';
    }
    return \%debug;
}
sub _ai_error_status {
    my ($self, $response) = @_;
    return '500 Internal Server Error' unless $response && ref $response eq 'HASH';
    return $response->{status} if $response->{status};
    my $error = lc($response->{error} || '');
    return '429 Too Many Requests' if $error =~ /rate limit/;
    return '503 Service Unavailable' if $error =~ /circuit breaker open/;
    return '503 Service Unavailable' if $error =~ /ai features are disabled|missing api key|ai model not configured/;
    return '422 Unprocessable Entity' if $error =~ /invalid request|excluded from ai assistance|no aacr2 rule defined/;
    return '502 Bad Gateway' if $error =~ /response was empty|response was not valid json|invalid ai response format/;
    return '502 Bad Gateway' if $error =~ /api error|provider request failed/;
    return '500 Internal Server Error' if $error =~ /request failed|exception/;
    return '500 Internal Server Error';
}

sub api_classify {
    my ( $self, $args ) = @_;
    return $self->_json_error('410 Gone', 'Deprecated endpoint. Use ai_suggest instead.');
}
sub validate_field {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        unless ($self->_is_authenticated_staff_session()) {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }
        my $payload = $self->_read_json_payload();
        if ($payload->{error}) {
            $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
            $status = $payload->{status} || '400 Bad Request';
            return;
        }
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
            $status = '403 Forbidden';
            return;
        }
        $payload = _strip_internal_payload_fields($payload);
        my $errors = $self->_validate_schema('validate_field_request.json', $payload);
        if (@{$errors}) {
            $response = { ok => 0, error => 'Invalid request', details => $errors };
            $status = '422 Unprocessable Entity';
            return;
        }

        my $pack = $self->_merge_rules_pack($settings);
        $response = $self->_validate_field_with_rules($payload, $pack, $settings);
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation validate_field error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}
sub validate_record {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        unless ($self->_is_authenticated_staff_session()) {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }
        my $payload = $self->_read_json_payload();
        if ($payload->{error}) {
            $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
            $status = $payload->{status} || '400 Bad Request';
            return;
        }
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
            $status = '403 Forbidden';
            return;
        }
        $payload = _strip_internal_payload_fields($payload);
        my $errors = $self->_validate_schema('validate_record_request.json', $payload);
        if (@{$errors}) {
            $response = { ok => 0, error => 'Invalid request', details => $errors };
            $status = '422 Unprocessable Entity';
            return;
        }

        my $pack = $self->_merge_rules_pack($settings);
        $response = $self->_validate_record_with_rules($payload, $pack, $settings);
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation validate_record error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}
sub ai_suggest {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';

        unless ($self->_is_authenticated_staff_session()) {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }
        my $payload = $self->_read_json_payload();
        if ($payload->{error}) {
            $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
            $status = $payload->{status} || '400 Bad Request';
            return;
        }
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
            $status = '403 Forbidden';
            return;
        }
        $payload = _strip_internal_payload_fields($payload);

        my $response_inner;
        eval {
            my $payload_copy = $self->_normalize_ai_request_payload($payload, $settings);
            $payload = $payload_copy if $payload_copy;
            my $errors = $self->_validate_schema('ai_request.json', $payload);
            if (@{$errors}) {
                $response_inner = { error => 'Invalid request', details => $errors };
                return;
            }

            unless ($settings->{ai_enable} && $self->_ai_key_available($settings)) {
                $response_inner = { error => 'AI features are disabled or missing API key for the selected provider.' };
                return;
            }

            my $tag_context = $payload->{tag_context} || {};
            my $tag = $tag_context->{tag} || '';
            my $subfields = $tag_context->{subfields} || [];
            my $primary_subfield = $tag_context->{active_subfield} || '';
            $primary_subfield = lc($primary_subfield || '');
            $primary_subfield = $subfields->[0] ? $subfields->[0]->{code} : '' unless $primary_subfield;
            if ($self->_is_excluded_field($settings, $tag, $primary_subfield)) {
                $response_inner = { error => 'Field is excluded from AI assistance.' };
                return;
            }

            my $pack = $self->_merge_rules_pack($settings);
            my $covered = $self->_is_field_covered($pack, $tag, $primary_subfield, $tag_context->{ind1}, $tag_context->{ind2});
            unless ($covered) {
                $response_inner = { error => 'No AACR2 rule defined for this field; AI assistance disabled.' };
                return;
            }

            my $user_key = $self->_current_user_key();
            my $provider = lc($settings->{llm_api_provider} || 'openrouter');
            unless ($self->_rate_limit_ok($settings, $user_key, $provider)) {
                $response_inner = { error => 'Rate limit exceeded. Please try again later.' };
                return;
            }

            my $model_key = $self->_selected_model($settings);
            unless ($model_key) {
                $response_inner = { error => 'AI model not configured. Select a model in plugin settings.' };
                return;
            }
            my $circuit_key = $self->_circuit_key($provider, $model_key);
            unless ($self->_circuit_breaker_ok($settings, $circuit_key)) {
                $response_inner = { error => 'AI circuit breaker open. Please retry later.' };
                return;
            }

            my $cataloging_mode = $self->_is_cataloging_ai_request($payload);
            my $cataloging_source = '';
            if ($cataloging_mode) {
                my $cataloging_tag_context = $self->_cataloging_tag_context($payload->{tag_context});
                my $source_result = $self->_cataloging_source_from_tag_context($cataloging_tag_context);
                if ($source_result->{error}) {
                    $response_inner = $self->_build_cataloging_error_response($payload, $source_result->{error});
                    return;
                }
                $cataloging_source = $source_result->{source};
                my $filtered_tag_context = $self->_redact_tag_context($cataloging_tag_context, $settings);
                $payload->{tag_context} = $filtered_tag_context;
                delete $payload->{record_context};
            } else {
                my $filtered_record = $self->_filter_record_context($payload->{record_context}, $settings, $tag_context);
                if ($filtered_record && $filtered_record->{fields} && @{ $filtered_record->{fields} }) {
                    $payload->{record_context} = $filtered_record;
                } else {
                    delete $payload->{record_context};
                }
            }
            my $prompt = $self->_build_ai_prompt($payload, $settings, {
                source => $cataloging_source,
                tag_context => $payload->{tag_context}
            });
            my $prompt_hash = _ai_prompt_cache_component($self, $settings, $cataloging_mode ? 'cataloging' : 'punctuation');
            $tag_context = $payload->{tag_context} || {};
            $tag = $tag_context->{tag} || '';
            $subfields = $tag_context->{subfields} || [];
            $primary_subfield = $tag_context->{active_subfield} || '';
            $primary_subfield = lc($primary_subfield || '');
            $primary_subfield = $subfields->[0] ? $subfields->[0]->{code} : '' unless $primary_subfield;
            my $rules_version = $pack->{version} || '';
            my $field_text = join('|', map { ($_->{code} || '') . '=' . ($_->{value} // '') } @{ $tag_context->{subfields} || [] });
            my $feature_key = $self->_canonical_json($payload->{features} || {});
            my $record_context_key = '';
            if ($payload->{record_context} && ref $payload->{record_context} eq 'HASH') {
                my $normalized_context = $self->_normalize_record_context_for_cache($payload->{record_context});
                $record_context_key = $self->_canonical_json($normalized_context);
            }
            my $cache_key = sha256_hex(join('|', $tag, $primary_subfield, $field_text, $rules_version, $provider, ($model_key || ''), $Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION, $prompt_hash, $user_key, $feature_key, $record_context_key));
            if (my $cached = $self->_cache_get($settings, $cache_key)) {
                $response_inner = $self->_sanitize_ai_response_for_chat($cached);
                return;
            }

            my $provider_result = $self->_call_ai_provider($settings, $prompt, {});
            my $raw_text = $provider_result->{raw_text} || '';
            my $was_truncated = $provider_result->{truncated} ? 1 : 0;
            my $debug = _build_ai_debug_payload($self, $settings, $provider_result);
            my $debug_options = %{$debug} ? { debug => $debug } : {};
            if ($provider_result->{text_mode}) {
                my $text_response = $self->_build_degraded_ai_response($payload, $raw_text, $settings, {
                    extraction_source => 'plain_text',
                    degraded_mode => 0,
                    %{$debug_options}
                });
                if (!$text_response && $raw_text) {
                    $text_response = $self->_build_unstructured_ai_response($payload, $raw_text, $settings, {
                        %{$debug_options}
                    });
                }
                unless ($text_response) {
                    $self->_record_failure($settings, $circuit_key);
                    $response_inner = { error => 'AI response was empty.' };
                    return;
                }
                $text_response = $self->_append_truncation_warning($text_response) if $was_truncated;
                $text_response = $self->_sanitize_ai_response_for_chat($text_response);
                my $guardrail_error = $self->_validate_ai_response_guardrails($payload, $text_response, $pack, $settings);
                if ($guardrail_error) {
                    $self->_record_failure($settings, $circuit_key);
                    $response_inner = { error => $guardrail_error };
                    return;
                }
                $self->_record_success($settings, $circuit_key);
                $self->_cache_set($settings, $cache_key, $text_response);
                $response_inner = $text_response;
                return;
            }
            if ($provider_result->{error}) {
                my $fallback = $self->_build_degraded_ai_response($payload, $raw_text, $settings, { %{$debug_options} });
                if ($fallback) {
                    $fallback = $self->_append_truncation_warning($fallback) if $was_truncated;
                    $self->_record_failure($settings, $circuit_key);
                    $self->_cache_set($settings, $cache_key, $fallback);
                    $response_inner = $fallback;
                    return;
                }
                if ($raw_text) {
                    my $unstructured = $self->_build_unstructured_ai_response($payload, $raw_text, $settings, { %{$debug_options} });
                    if ($unstructured) {
                        $unstructured = $self->_append_truncation_warning($unstructured) if $was_truncated;
                        $self->_record_failure($settings, $circuit_key);
                        $self->_cache_set($settings, $cache_key, $unstructured);
                        $response_inner = $unstructured;
                        return;
                    }
                }
                $self->_record_failure($settings, $circuit_key);
                $response_inner = { error => $provider_result->{error} };
                return;
            }

            my $result = $provider_result->{data};
            my $validation_errors = $self->_validate_schema('ai_response.json', $result);
            if (@{$validation_errors}) {
                my $debug_payload = _build_ai_debug_payload($self, $settings, $provider_result, join('; ', @{$validation_errors}));
                my $debug_payload_options = %{$debug_payload} ? { debug => $debug_payload } : {};
                my $fallback = $self->_build_degraded_ai_response($payload, $raw_text, $settings, { %{$debug_payload_options} });
                if ($fallback) {
                    $self->_record_failure($settings, $circuit_key);
                    $self->_cache_set($settings, $cache_key, $fallback);
                    $response_inner = $fallback;
                    return;
                }
                if ($raw_text) {
                    my $unstructured = $self->_build_unstructured_ai_response($payload, $raw_text, $settings, { %{$debug_payload_options} });
                    if ($unstructured) {
                        $self->_record_failure($settings, $circuit_key);
                        $self->_cache_set($settings, $cache_key, $unstructured);
                        $response_inner = $unstructured;
                        return;
                    }
                }
                $self->_record_failure($settings, $circuit_key);
                $response_inner = { error => 'Invalid AI response format', details => $validation_errors };
                return;
            }

            $result = $self->_augment_cataloging_response($payload, $result, $raw_text, $settings);
            $result = $self->_sanitize_ai_response_for_chat($result);
            $result = $self->_append_truncation_warning($result) if $was_truncated;
            if (%{$debug} && ($debug->{parse_error} || _debug_raw_response_enabled($self, $settings))) {
                $result->{debug} = $debug;
            }
            my $guardrail_error = $self->_validate_ai_response_guardrails($payload, $result, $pack, $settings);
            if ($guardrail_error) {
                $self->_record_failure($settings, $circuit_key);
                $response_inner = { error => $guardrail_error };
                return;
            }

            $self->_record_success($settings, $circuit_key);
            $self->_cache_set($settings, $cache_key, $result);
            $response_inner = $result;
            return;
        };
        if ($@) {
            my $message = "$@";
            $message =~ s/\s+$//;
            warn "AACR2 AI exception: $message";
            $response_inner = { error => 'AI request failed. Check server logs for details.', status => '500 Internal Server Error' };
        }
        $response_inner ||= { error => 'AI request failed. Check server logs for details.', status => '500 Internal Server Error' };
        if ($response_inner->{error}) {
            $response_inner->{ok} = 0 unless exists $response_inner->{ok};
            $status = _ai_error_status($self, $response_inner);
        } else {
            $response_inner->{ok} = 1 unless exists $response_inner->{ok};
            $status = '200 OK';
        }
        $response = $response_inner;
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation ai_suggest error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}
sub test_connection {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        unless ($self->_is_authenticated_staff_session()) {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }
        unless ($self->_csrf_ok()) {
            $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
            $status = '403 Forbidden';
            return;
        }
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        unless ($self->_ai_key_available($settings)) {
            $response = { ok => 0, error => 'AI not configured.' };
            $status = '400 Bad Request';
            return;
        }
        my $prompt = "Reply with a short plain-text confirmation.";
        my $result = $self->_call_ai_provider($settings, $prompt, {});
        if ($result->{error}) {
            $response = { ok => 0, error => $result->{error} };
            $status = '502 Bad Gateway';
            return;
        }
        $response = { ok => 1, status => 'ok' };
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation test_connection error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}
sub ai_models {
    my ( $self, $args ) = @_;
    my $request_method = $ENV{REQUEST_METHOD} || '';
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $request_method eq 'GET' || $request_method eq 'POST';

    my ($response, $status);
    try {
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        unless ($self->_is_authenticated_staff_session()) {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }

        my $payload = {};
        if ($request_method eq 'POST') {
            $payload = $self->_read_json_payload();
            if ($payload->{error}) {
                $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
                $status = $payload->{status} || '400 Bad Request';
                return;
            }
            unless ($self->_csrf_ok($payload)) {
                $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
                $status = '403 Forbidden';
                return;
            }
            $payload = _strip_internal_payload_fields($payload);
        }

        my $cgi = $self->{'cgi'} || CGI->new;
        my $provider = lc(
            ($payload->{provider} // '')
            || $cgi->param('provider')
            || $settings->{llm_api_provider}
            || 'openrouter'
        );
        $provider = $provider eq 'openrouter' ? 'openrouter' : 'openai';
        my $force = 0;
        if (exists $payload->{force}) {
            $force = $payload->{force} ? 1 : 0;
        } else {
            $force = $cgi->param('force') ? 1 : 0;
        }
        my $allow_public = 0;
        if (exists $payload->{allow_public}) {
            $allow_public = $payload->{allow_public} ? 1 : 0;
        } else {
            $allow_public = $cgi->param('allow_public') ? 1 : 0;
        }

        my $key_present = $provider eq 'openrouter'
            ? ($self->_decrypt_secret($settings->{openrouter_api_key}) ? 1 : 0)
            : ($self->_decrypt_secret($settings->{llm_api_key}) ? 1 : 0);
        my $allow_public_openrouter = ($provider eq 'openrouter' && $allow_public) ? 1 : 0;

        my $cache = {};
        try {
            $cache = $self->_load_model_cache();
        } catch {
            $cache = {};
        };
        $cache = {} unless $cache && ref $cache eq 'HASH';
        my $ttl = 60 * 60;
        unless ($key_present || $allow_public_openrouter) {
            my $cached_models = ($cache->{$provider} && ref $cache->{$provider} eq 'HASH')
                ? ($cache->{$provider}{models} || [])
                : [];
            $response = {
                ok => 1,
                provider => $provider,
                key_present => 0,
                cached => ($cached_models && @{$cached_models}) ? 1 : 0,
                fetched_at => ($cache->{$provider} && $cache->{$provider}{fetched_at}) ? $cache->{$provider}{fetched_at} : 0,
                models => $cached_models,
                warning => 'API key not configured for the selected provider. Save a key to fetch live models.'
            };
            $status = '200 OK';
            return;
        }
        if (!$force && $cache->{$provider} && $cache->{$provider}{fetched_at}
            && ($cache->{$provider}{fetched_at} + $ttl) > time) {
            $response = {
                ok => 1,
                provider => $provider,
                key_present => $key_present,
                cached => 1,
                fetched_at => $cache->{$provider}{fetched_at},
                models => $cache->{$provider}{models} || [],
                warning => ($key_present ? undef : 'API key not configured. Showing cached model list.')
            };
            $status = '200 OK';
            return;
        }

        my $result = {};
        try {
            if ($provider eq 'openrouter') {
                my $fetch_options = {
                    allow_public => $allow_public_openrouter
                };
                $result = $self->_fetch_openrouter_models($settings, $fetch_options);
            } else {
                $result = $self->_fetch_openai_models($settings);
            }
        } catch {
            my $message = "$_";
            $message =~ s/\s+$//;
            $result = { error => 'Model provider request failed.', warning => $message };
        };
        $result = {} unless $result && ref $result eq 'HASH';
        if ($result->{error}) {
            $response = {
                ok => 0,
                provider => $provider,
                key_present => $key_present,
                error => $result->{error},
                models => [],
                warning => $result->{warning}
            };
            $status = '502 Bad Gateway';
            return;
        }

        my $models = $result->{models} || [];
        my $fetched_at = time;
        if (@{$models} || !$result->{warning}) {
            $cache->{$provider} = {
                fetched_at => $fetched_at,
                models => $models
            };
            try {
                $self->_save_model_cache($cache);
            } catch {
                # Model cache persistence should not fail the API request.
            };
        }
        $response = {
            ok => 1,
            provider => $provider,
            key_present => $key_present,
            cached => 0,
            fetched_at => $fetched_at,
            models => $models,
            warning => $result->{warning}
        };
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation ai_models error: $message";
        $response = { ok => 0, error => 'Model list request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}

1;
