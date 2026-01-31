package Koha::Plugin::Cataloging::AutoPunctuation::AI::Provider;

use Modern::Perl;
use LWP::UserAgent;
use HTTP::Request;
use JSON qw(to_json from_json);
use Try::Tiny;
use Time::HiRes qw(usleep);

sub _call_openai_responses {
    my ($self, $settings, $prompt, $options) = @_;
    my $api_key = $self->_decrypt_secret($settings->{llm_api_key});
    return { error => 'OpenAI API key not configured.' } unless $api_key;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $model = $self->_selected_model($settings);
    return { error => 'OpenAI model not configured.' } unless $model;
    my $expect_json = $options && exists $options->{expect_json} ? ($options->{expect_json} ? 1 : 0) : 1;
    my $system_prompt = $options && $options->{system_prompt}
        ? $options->{system_prompt}
        : ($expect_json
            ? 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return JSON only.'
            : 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return plain text only.');
    my $payload = {
        model => $model,
        input => [
            {
                role => "system",
                content => [
                    { type => "text", text => $system_prompt }
                ]
            },
            {
                role => "user",
                content => [
                    { type => "text", text => $prompt }
                ]
            }
        ],
        max_output_tokens => int($settings->{ai_max_output_tokens} || $settings->{ai_max_tokens} || 1024),
        temperature => $settings->{ai_temperature} + 0
    };
    my $effort = $self->_normalized_reasoning_effort($settings);
    if ($effort ne 'none' && $self->_is_openai_reasoning_model($model)) {
        $payload->{reasoning} = { effort => $effort };
    }
    warn "AACR2 AI request length: " . length($prompt) if $settings->{debug_mode};
    my $request = HTTP::Request->new(
        'POST',
        'https://api.openai.com/v1/responses',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
        ],
        to_json($payload)
    );

    my $attempts = ($settings->{ai_retry_count} || 2) + 1;
    my $backoff = 200_000;
    for my $attempt (1 .. $attempts) {
        my $response = $ua->request($request);
        if ($response->is_success) {
            my $result;
            my $raw_body = $response->content || '';
            try {
                $result = from_json($raw_body);
            } catch {
                return { error => 'OpenAI API response was not valid JSON.', raw_response => $raw_body };
            };
            my $content = $self->_extract_response_text($result);
            my $truncated = $self->_response_truncated($result);
            warn "AACR2 AI response length: " . length($content) if $settings->{debug_mode};
            return { error => 'OpenAI response was empty.' } unless $content;
            if (!$expect_json) {
                return { raw_text => $content, text_mode => 1, raw_response => $raw_body, truncated => $truncated };
            }
            my $parsed = $self->_try_parse_json_text($content);
            return {
                error => 'OpenAI response was not valid JSON.',
                raw_text => $content,
                raw_response => $raw_body,
                parse_error => 'Unable to parse JSON from model output.',
                truncated => $truncated
            } unless $parsed;
            return { data => $parsed, raw_text => $content, raw_response => $raw_body, truncated => $truncated };
        }
        if ($attempt < $attempts) {
            usleep($backoff);
            $backoff *= 2;
        }
        if ($attempt == $attempts) {
            return { error => $self->_format_provider_error('OpenAI', $response) };
        }
    }
    return { error => 'OpenAI API error: unexpected failure' };
}
sub _call_openrouter_responses {
    my ($self, $settings, $prompt, $options) = @_;
    my $api_key = $self->_decrypt_secret($settings->{openrouter_api_key});
    return { error => 'OpenRouter API key not configured.' } unless $api_key;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $model = $self->_selected_model($settings);
    return { error => 'OpenRouter model not configured.' } unless $model;
    my $expect_json = $options && exists $options->{expect_json} ? ($options->{expect_json} ? 1 : 0) : 1;
    my $system_prompt = $options && $options->{system_prompt}
        ? $options->{system_prompt}
        : ($expect_json
            ? 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return JSON only.'
            : 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return plain text only.');
    my $payload = {
        input => [
            {
                type => "message",
                role => "system",
                content => $system_prompt
            },
            {
                type => "message",
                role => "user",
                content => $prompt
            }
        ],
        max_output_tokens => int($settings->{ai_max_output_tokens} || $settings->{ai_max_tokens} || 1024),
        temperature => $settings->{ai_temperature} + 0
    };
    if ($model && $model ne 'default') {
        $payload->{model} = $model;
    }
    warn "AACR2 OpenRouter request length: " . length($prompt) if $settings->{debug_mode};
    my $request = HTTP::Request->new(
        'POST',
        'https://openrouter.ai/api/v1/responses',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
            'HTTP-Referer' => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
            'X-Title' => 'Koha AACR2 Assistant',
        ],
        to_json($payload)
    );

    my $attempts = ($settings->{ai_retry_count} || 2) + 1;
    my $backoff = 200_000;
    for my $attempt (1 .. $attempts) {
        my $response = $ua->request($request);
        if ($response->is_success) {
            my $result;
            my $raw_body = $response->content || '';
            try {
                $result = from_json($raw_body);
            } catch {
                return { error => 'OpenRouter API response was not valid JSON.', raw_response => $raw_body };
            };
            my $content = $self->_extract_response_text($result);
            my $truncated = $self->_response_truncated($result);
            warn "AACR2 OpenRouter response length: " . length($content) if $settings->{debug_mode};
            return { error => 'OpenRouter response was empty.' } unless $content;
            if (!$expect_json) {
                return { raw_text => $content, text_mode => 1, raw_response => $raw_body, truncated => $truncated };
            }
            my $parsed = $self->_try_parse_json_text($content);
            return {
                error => 'OpenRouter response was not valid JSON.',
                raw_text => $content,
                raw_response => $raw_body,
                parse_error => 'Unable to parse JSON from model output.',
                truncated => $truncated
            } unless $parsed;
            return { data => $parsed, raw_text => $content, raw_response => $raw_body, truncated => $truncated };
        }
        if ($attempt < $attempts) {
            usleep($backoff);
            $backoff *= 2;
        }
        if ($attempt == $attempts) {
            return { error => $self->_format_provider_error('OpenRouter', $response) };
        }
    }
    return { error => 'OpenRouter API error: unexpected failure' };
}
sub _call_openrouter_chat {
    my ($self, $settings, $prompt, $options) = @_;
    my $api_key = $self->_decrypt_secret($settings->{openrouter_api_key});
    return { error => 'OpenRouter API key not configured.' } unless $api_key;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $model = $self->_selected_model($settings);
    return { error => 'OpenRouter model not configured.' } unless $model;
    my $expect_json = $options && exists $options->{expect_json} ? ($options->{expect_json} ? 1 : 0) : 1;
    my $system_prompt = $options && $options->{system_prompt}
        ? $options->{system_prompt}
        : ($expect_json
            ? 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return JSON only.'
            : 'You are an AACR2 MARC21 cataloging assistant. Use AACR2/ISBD conventions only. Return plain text only.');
    my $payload = {
        messages => [
            {
                role => "system",
                content => $system_prompt
            },
            {
                role => "user",
                content => $prompt
            }
        ],
        max_tokens => int($settings->{ai_max_output_tokens} || $settings->{ai_max_tokens} || 1024),
        temperature => $settings->{ai_temperature} + 0
    };
    if ($model && $model ne 'default') {
        $payload->{model} = $model;
    }
    warn "AACR2 OpenRouter request length: " . length($prompt) if $settings->{debug_mode};
    my $request = HTTP::Request->new(
        'POST',
        'https://openrouter.ai/api/v1/chat/completions',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
            'HTTP-Referer' => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
            'X-Title' => 'Koha AACR2 Assistant',
        ],
        to_json($payload)
    );

    my $attempts = ($settings->{ai_retry_count} || 2) + 1;
    my $backoff = 200_000;
    for my $attempt (1 .. $attempts) {
        my $response = $ua->request($request);
        if ($response->is_success) {
            my $result;
            my $raw_body = $response->content || '';
            try {
                $result = from_json($raw_body);
            } catch {
                return { error => 'OpenRouter API response was not valid JSON.', raw_response => $raw_body };
            };
            my $content = $self->_extract_openrouter_text($result);
            my $truncated = $self->_response_truncated($result);
            warn "AACR2 OpenRouter response length: " . length($content) if $settings->{debug_mode};
            return { error => 'OpenRouter response was empty.' } unless $content;
            if (!$expect_json) {
                return { raw_text => $content, text_mode => 1, raw_response => $raw_body, truncated => $truncated };
            }
            my $parsed = $self->_try_parse_json_text($content);
            return {
                error => 'OpenRouter response was not valid JSON.',
                raw_text => $content,
                raw_response => $raw_body,
                parse_error => 'Unable to parse JSON from model output.',
                truncated => $truncated
            } unless $parsed;
            return { data => $parsed, raw_text => $content, raw_response => $raw_body, truncated => $truncated };
        }
        if ($attempt < $attempts) {
            usleep($backoff);
            $backoff *= 2;
        }
        if ($attempt == $attempts) {
            return { error => $self->_format_provider_error('OpenRouter', $response) };
        }
    }
    return { error => 'OpenRouter API error: unexpected failure' };
}
sub _extract_openrouter_text {
    my ($self, $response) = @_;
    return $self->_extract_response_text($response);
}
sub _format_provider_error {
    my ($self, $provider, $response) = @_;
    my $status = $response ? $response->status_line : '';
    my $body = $response ? $response->decoded_content : '';
    my $detail = '';
    if ($body) {
        my $parsed;
        try {
            $parsed = from_json($body);
        } catch {
            $parsed = undef;
        };
        if ($parsed && ref $parsed eq 'HASH') {
            if (lc($provider || '') eq 'openai') {
                $detail = $parsed->{error}{message} || $parsed->{error}{code} || '';
            } else {
                $detail = $parsed->{error}{message} || $parsed->{data}{error}{message} || $parsed->{error}{code} || '';
            }
        }
        if (!$detail) {
            $detail = $body;
            $detail =~ s/\s+/ /g;
            $detail = substr($detail, 0, 200);
        }
    }
    my $label = $provider || 'Provider';
    my $message = $status ? "${label} API error: $status" : "${label} API error";
    $message .= " - $detail" if $detail;
    return $message;
}
sub _sanitize_ai_response_for_chat {
    my ($self, $result) = @_;
    return $result unless $result && ref $result eq 'HASH';
    my $findings = $result->{findings};
    $findings = [] unless $findings && ref $findings eq 'ARRAY';
    for my $finding (@{$findings}) {
        next unless $finding && ref $finding eq 'HASH';
        $finding->{proposed_fixes} = [];
    }
    $result->{findings} = $findings;
    my $assistant_message = $result->{assistant_message} // '';
    $assistant_message =~ s/^\s+|\s+$//g if defined $assistant_message;
    if (!$assistant_message) {
        $assistant_message = $self->_summarize_ai_findings($findings);
    }
    $assistant_message ||= 'No AI suggestions returned.';
    $result->{assistant_message} = $assistant_message;
    my $confidence = $result->{confidence_percent};
    if (!defined $confidence || !looks_like_number($confidence)) {
        $confidence = $self->_confidence_percent_from_findings($findings);
    }
    $confidence = 0 if $confidence < 0;
    $confidence = 100 if $confidence > 100;
    $result->{confidence_percent} = 0 + $confidence;
    return $result;
}
sub _ai_key_available {
    my ($self, $settings) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openrouter');
    if ($provider eq 'openrouter') {
        return $self->_decrypt_secret($settings->{openrouter_api_key}) ? 1 : 0;
    }
    return $self->_decrypt_secret($settings->{llm_api_key}) ? 1 : 0;
}
sub _selected_model {
    my ($self, $settings) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openrouter');
    if ($provider eq 'openrouter') {
        my $model = $settings->{ai_model};
        $model = $settings->{ai_model_openrouter} if !defined $model || $model eq '';
        $model = '' if defined $model && $model eq 'default';
        return $model;
    }
    my $model = $settings->{ai_model};
    $model = $settings->{ai_model_openai} if !defined $model || $model eq '' || $model eq 'default';
    $model = '' if defined $model && $model eq 'default';
    return $model;
}
sub _normalized_reasoning_effort {
    my ($self, $settings) = @_;
    my $effort = lc($settings->{ai_reasoning_effort} || 'low');
    return $effort if $effort =~ /^(none|low|medium|high)$/;
    return 'low';
}
sub _is_openai_reasoning_model {
    my ($self, $model) = @_;
    return 0 unless $model;
    my $id = lc($model);
    return 1 if $id =~ /reasoning/;
    return 1 if $id =~ /^o\d/;
    return 1 if $id =~ /(?:^|-)o\d/;
    return 0;
}
sub _call_ai_provider {
    my ($self, $settings, $prompt, $options) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openrouter');
    if ($provider eq 'openrouter') {
        return $self->_call_openrouter_chat($settings, $prompt, $options);
    }
    return $self->_call_openai_responses($settings, $prompt, $options);
}
sub _extract_response_text {
    my ($self, $response) = @_;
    return '' unless $response && ref $response eq 'HASH';
    if ($response->{choices} && ref $response->{choices} eq 'ARRAY') {
        for my $choice (@{ $response->{choices} }) {
            my $message = $choice->{message} || {};
            return $message->{content} if defined $message->{content} && $message->{content} ne '';
            my $delta = $choice->{delta} || {};
            return $delta->{content} if defined $delta->{content} && $delta->{content} ne '';
        }
    }
    if ($response->{message} && ref $response->{message} eq 'HASH') {
        return $response->{message}{content} if defined $response->{message}{content};
    }
    my $content = '';
    if ($response->{output} && ref $response->{output} eq 'ARRAY') {
        for my $item (@{ $response->{output} }) {
            next unless $item->{content};
            for my $chunk (@{ $item->{content} }) {
                next unless defined $chunk->{text} || defined $chunk->{output_text};
                $content .= defined $chunk->{text} ? $chunk->{text} : $chunk->{output_text};
            }
        }
    }
    $content ||= $response->{output_text} || '';
    return $content;
}
sub _response_truncated {
    my ($self, $response) = @_;
    return 0 unless $response && ref $response eq 'HASH';
    if ($response->{choices} && ref $response->{choices} eq 'ARRAY') {
        for my $choice (@{ $response->{choices} }) {
            my $reason = $choice->{finish_reason} || '';
            return 1 if lc($reason) eq 'length';
        }
    }
    if ($response->{output} && ref $response->{output} eq 'ARRAY') {
        for my $item (@{ $response->{output} }) {
            my $finish = $item->{finish_reason} || '';
            my $status = $item->{status} || '';
            my $detail = '';
            if ($item->{incomplete_details} && ref $item->{incomplete_details} eq 'HASH') {
                $detail = $item->{incomplete_details}{reason} || '';
            }
            return 1 if lc($finish) eq 'length';
            return 1 if lc($status) eq 'incomplete';
            return 1 if $detail && lc($detail) =~ /max_output_tokens|length/;
        }
    }
    if ($response->{incomplete_details} && ref $response->{incomplete_details} eq 'HASH') {
        my $detail = $response->{incomplete_details}{reason} || '';
        return 1 if $detail && lc($detail) =~ /max_output_tokens|length/;
    }
    return 0;
}
sub _append_truncation_warning {
    my ($self, $result) = @_;
    return $result unless $result && ref $result eq 'HASH';
    my $message = 'Output truncated. Increase max output tokens or reduce reasoning effort.';
    my $errors = $result->{errors};
    $errors = [] unless $errors && ref $errors eq 'ARRAY';
    unless (grep { $_ && ref $_ eq 'HASH' && $_->{code} && $_->{code} eq 'OUTPUT_TRUNCATED' } @{$errors}) {
        push @{$errors}, { code => 'OUTPUT_TRUNCATED', message => $message };
    }
    $result->{errors} = $errors;
    return $result;
}

1;
