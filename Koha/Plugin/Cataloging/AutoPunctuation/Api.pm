package Koha::Plugin::Cataloging::AutoPunctuation::Api;

use Modern::Perl;
use Try::Tiny;
use Digest::SHA qw(sha256_hex);

sub api_classify {
    my ( $self, $args ) = @_;
    $self->_emit_json({ error => 'Deprecated endpoint. Use ai_suggest instead.' });
}
sub validate_field {
    my ( $self, $args ) = @_;
    return $self->_emit_json_error('Method not allowed', '405 Method Not Allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $settings = $self->_load_settings();
        my $payload = $self->_read_json_payload();
        if ($payload->{error}) {
            $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
            $status = '400 Bad Request';
            return;
        }
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token' };
            $status = '403 Forbidden';
            return;
        }
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
    return $self->_emit_json($response, $status);
}
sub validate_record {
    my ( $self, $args ) = @_;
    return $self->_emit_json_error('Method not allowed', '405 Method Not Allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $settings = $self->_load_settings();
        my $payload = $self->_read_json_payload();
        if ($payload->{error}) {
            $response = { ok => 0, error => $payload->{error}, details => $payload->{details} };
            $status = '400 Bad Request';
            return;
        }
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token' };
            $status = '403 Forbidden';
            return;
        }
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
    return $self->_emit_json($response, $status);
}
sub ai_suggest {
    my ( $self, $args ) = @_;
    return $self->_emit_json_error('Method not allowed', '405 Method Not Allowed')
        unless $self->_require_method('POST');
    my $response;
    my $settings = $self->_load_settings();
    my $payload = $self->_read_json_payload();
    return $self->_json_error('400 Bad Request', $payload->{error}, { details => $payload->{details} })
        if $payload->{error};
    return $self->_emit_json_error('Invalid CSRF token', '403 Forbidden')
        unless $self->_csrf_ok($payload);
    eval {
        my $payload_copy = $self->_normalize_ai_request_payload($payload, $settings);
        $payload = $payload_copy if $payload_copy;
        my $errors = $self->_validate_schema('ai_request.json', $payload);
        if (@{$errors}) {
            $response = { error => 'Invalid request', details => $errors };
            return;
        }

        unless ($settings->{ai_enable} && $self->_ai_key_available($settings)) {
            $response = { error => 'AI features are disabled or missing API key for the selected provider.' };
            return;
        }

        my $tag_context = $payload->{tag_context} || {};
        my $tag = $tag_context->{tag} || '';
        my $subfields = $tag_context->{subfields} || [];
        my $primary_subfield = $tag_context->{active_subfield} || '';
        $primary_subfield = lc($primary_subfield || '');
        $primary_subfield = $subfields->[0] ? $subfields->[0]->{code} : '' unless $primary_subfield;
        if ($self->_is_excluded_field($settings, $tag, $primary_subfield)) {
            $response = { error => 'Field is excluded from AI assistance.' };
            return;
        }

        my $pack = $self->_merge_rules_pack($settings);
        my $covered = $self->_is_field_covered($pack, $tag, $primary_subfield, $tag_context->{ind1}, $tag_context->{ind2});
        unless ($covered) {
            $response = { error => 'No AACR2 rule defined for this field; AI assistance disabled.' };
            return;
        }

        my $user_key = $self->_current_user_key();
        my $provider = lc($settings->{llm_api_provider} || 'openrouter');
        unless ($self->_rate_limit_ok($settings, $user_key, $provider)) {
            $response = { error => 'Rate limit exceeded. Please try again later.' };
            return;
        }

        my $model_key = $self->_selected_model($settings);
        unless ($model_key) {
            $response = { error => 'AI model not configured. Select a model in plugin settings.' };
            return;
        }
        my $circuit_key = $self->_circuit_key($provider, $model_key);
        unless ($self->_circuit_breaker_ok($settings, $circuit_key)) {
            $response = { error => 'AI circuit breaker open. Please retry later.' };
            return;
        }

        my $cataloging_mode = $self->_is_cataloging_ai_request($payload);
        my $cataloging_source = '';
        if ($cataloging_mode) {
            my $filtered_tag_context = $self->_cataloging_tag_context($payload->{tag_context});
            $filtered_tag_context = $self->_redact_tag_context($filtered_tag_context, $settings);
            $payload->{tag_context} = $filtered_tag_context;
            my $source_result = $self->_cataloging_source_from_tag_context($filtered_tag_context);
            if ($source_result->{error}) {
                $response = $self->_build_cataloging_error_response($payload, $source_result->{error});
                return;
            }
            $cataloging_source = $source_result->{source};
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
        my $cache_key = sha256_hex(join('|', $tag, $primary_subfield, $field_text, $rules_version, $provider, ($model_key || ''), Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION, $user_key, $feature_key, $record_context_key));
        if (my $cached = $self->_cache_get($settings, $cache_key)) {
            $response = $self->_sanitize_ai_response_for_chat($cached);
            return;
        }

        my $expect_json = 1;
        my $provider_result = $self->_call_ai_provider($settings, $prompt, {
            expect_json => $expect_json
        });
        my $raw_text = $provider_result->{raw_text} || '';
        my $was_truncated = $provider_result->{truncated} ? 1 : 0;
        my $debug = {
            raw_provider_response => $provider_result->{raw_response} || '',
            raw_text => $provider_result->{raw_text} || '',
            parse_error => $provider_result->{parse_error} || ''
        };
        if ($provider_result->{text_mode}) {
            my $text_response = $self->_build_degraded_ai_response($payload, $raw_text, $settings, {
                extraction_source => 'plain_text',
                degraded_mode => 0,
                debug => $debug
            });
            unless ($text_response) {
                $self->_record_failure($settings, $circuit_key);
                $response = { error => 'AI response was empty.' };
                return;
            }
            $text_response = $self->_append_truncation_warning($text_response) if $was_truncated;
            $text_response = $self->_sanitize_ai_response_for_chat($text_response);
            my $guardrail_error = $self->_validate_ai_response_guardrails($payload, $text_response, $pack, $settings);
            if ($guardrail_error) {
                $self->_record_failure($settings, $circuit_key);
                $response = { error => $guardrail_error };
                return;
            }
            $self->_record_success($settings, $circuit_key);
            $self->_cache_set($settings, $cache_key, $text_response);
            $response = $text_response;
            return;
        }
        if ($provider_result->{error}) {
            my $fallback = $self->_build_degraded_ai_response($payload, $raw_text, $settings, { debug => $debug });
            if ($fallback) {
                $fallback = $self->_append_truncation_warning($fallback) if $was_truncated;
                $self->_record_failure($settings, $circuit_key);
                $self->_cache_set($settings, $cache_key, $fallback);
                $response = $fallback;
                return;
            }
            if ($raw_text) {
                my $unstructured = $self->_build_unstructured_ai_response($payload, $raw_text, $settings, { debug => $debug });
                if ($unstructured) {
                    $unstructured = $self->_append_truncation_warning($unstructured) if $was_truncated;
                    $self->_record_failure($settings, $circuit_key);
                    $self->_cache_set($settings, $cache_key, $unstructured);
                    $response = $unstructured;
                    return;
                }
            }
            $self->_record_failure($settings, $circuit_key);
            $response = { error => $provider_result->{error} };
            return;
        }

        my $result = $provider_result->{data};
        my $validation_errors = $self->_validate_schema('ai_response.json', $result);
        if (@{$validation_errors}) {
            my $debug_payload = { %{$debug}, parse_error => join('; ', @{$validation_errors}) };
            my $fallback = $self->_build_degraded_ai_response($payload, $raw_text, $settings, { debug => $debug_payload });
            if ($fallback) {
                $self->_record_failure($settings, $circuit_key);
                $self->_cache_set($settings, $cache_key, $fallback);
                $response = $fallback;
                return;
            }
            if ($raw_text) {
                my $unstructured = $self->_build_unstructured_ai_response($payload, $raw_text, $settings, { debug => $debug_payload });
                if ($unstructured) {
                    $self->_record_failure($settings, $circuit_key);
                    $self->_cache_set($settings, $cache_key, $unstructured);
                    $response = $unstructured;
                    return;
                }
            }
            $self->_record_failure($settings, $circuit_key);
            $response = { error => 'Invalid AI response format', details => $validation_errors };
            return;
        }

        $result = $self->_augment_cataloging_response($payload, $result, $raw_text, $settings);
        $result = $self->_sanitize_ai_response_for_chat($result);
        $result = $self->_append_truncation_warning($result) if $was_truncated;
        if ($debug->{parse_error}) {
            $result->{debug} = $debug;
        }
        my $guardrail_error = $self->_validate_ai_response_guardrails($payload, $result, $pack, $settings);
        if ($guardrail_error) {
            $self->_record_failure($settings, $circuit_key);
            $response = { error => $guardrail_error };
            return;
        }

        $self->_record_success($settings, $circuit_key);
        $self->_cache_set($settings, $cache_key, $result);
        $response = $result;
        return;
    };
    if ($@) {
        my $message = "$@";
        $message =~ s/\s+$//;
        warn "AACR2 AI exception: $message";
        $response = { error => 'AI request failed. Check server logs for details.' };
    }
    $response ||= { error => 'AI request failed. Check server logs for details.' };
    if ($response->{error} && !exists $response->{ok}) {
        $response->{ok} = 0;
    }
    return $self->_emit_json($response);
}
sub test_connection {
    my ( $self, $args ) = @_;
    return $self->_emit_json_error('Method not allowed', '405 Method Not Allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        unless ($self->_csrf_ok()) {
            $response = { ok => 0, error => 'Invalid CSRF token' };
            $status = '403 Forbidden';
            return;
        }
        my $settings = $self->_load_settings();
        unless ($self->_ai_key_available($settings)) {
            $response = { ok => 0, error => 'AI not configured.' };
            $status = '400 Bad Request';
            return;
        }
        my $prompt = "Respond with JSON: {\"status\":\"ok\"}.";
        my $result = $self->_call_ai_provider($settings, $prompt);
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
    return $self->_emit_json($response, $status);
}
sub ai_models {
    my ( $self, $args ) = @_;
    return $self->_emit_json_error('Method not allowed', '405 Method Not Allowed')
        unless $self->_require_method('GET');
    my $settings = $self->_load_settings();
    my $cgi = $self->{'cgi'} || CGI->new;
    my $provider = lc($cgi->param('provider') || $settings->{llm_api_provider} || 'openrouter');
    $provider = $provider eq 'openrouter' ? 'openrouter' : 'openai';
    my $force = $cgi->param('force') ? 1 : 0;
    my $key_present = $provider eq 'openrouter'
        ? ($self->_decrypt_secret($settings->{openrouter_api_key}) ? 1 : 0)
        : ($self->_decrypt_secret($settings->{llm_api_key}) ? 1 : 0);

    my $cache = $self->_load_model_cache();
    my $ttl = 60 * 60;
    if (!$force && $cache->{$provider} && $cache->{$provider}{fetched_at}
        && ($cache->{$provider}{fetched_at} + $ttl) > time) {
        return $self->_emit_json({
            provider => $provider,
            cached => 1,
            fetched_at => $cache->{$provider}{fetched_at},
            models => $cache->{$provider}{models} || [],
            warning => ($key_present ? undef : 'API key not configured. Showing cached model list.')
        });
    }

    my $result = $provider eq 'openrouter'
        ? $self->_fetch_openrouter_models($settings)
        : $self->_fetch_openai_models($settings);
    if ($result->{error}) {
        return $self->_emit_json($result);
    }
    my $models = $result->{models} || [];
    my $fetched_at = time;
    if (@{$models} || !$result->{warning}) {
        $cache->{$provider} = {
            fetched_at => $fetched_at,
            models => $models
        };
        $self->_save_model_cache($cache);
    }
    return $self->_emit_json({
        provider => $provider,
        cached => 0,
        fetched_at => $fetched_at,
        models => $models,
        warning => $result->{warning}
    });
}

1;
