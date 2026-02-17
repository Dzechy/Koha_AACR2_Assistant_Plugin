package Koha::Plugin::Cataloging::AutoPunctuation::Updates;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;
use LWP::UserAgent;
use HTTP::Request;
use Time::HiRes qw(time);

sub _check_for_updates {
    my ($self) = @_;
    my $cache_raw = $self->retrieve_data('update_cache') || '{}';
    my $cache = {};
    try {
        $cache = from_json($cache_raw);
    } catch {
        $cache = {};
    };
    my $now = time;
    my $ttl = 6 * 60 * 60;
    if ($cache->{checked_at} && ($cache->{checked_at} + $ttl) > $now) {
        return $cache;
    }
    my $previous = (ref $cache eq 'HASH') ? $cache : {};

    my $result = {
        current_version => $Koha::Plugin::Cataloging::AutoPunctuation::VERSION,
        latest_version => '',
        update_available => 0,
        release_url => $Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        checked_at => $now,
        error => '',
    };

    my $ua = LWP::UserAgent->new(
        timeout => 6,
        agent => 'Koha-AACR2-Assistant/' . $Koha::Plugin::Cataloging::AutoPunctuation::VERSION
    );
    $ua->env_proxy;
    my $data;
    my $response = $ua->get($Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_RELEASES_API, 'Accept' => 'application/vnd.github+json');
    if ($response->is_success) {
        try {
            $data = from_json($response->decoded_content);
        } catch {
            $data = undef;
        };
    }
    if (!$data || ref $data ne 'HASH') {
        my $tags_api = $Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_RELEASES_API;
        $tags_api =~ s{/releases/latest$}{/tags};
        my $tags_response = $ua->get($tags_api, 'Accept' => 'application/vnd.github+json');
        if ($tags_response->is_success) {
            my $tags;
            try {
                $tags = from_json($tags_response->decoded_content);
            } catch {
                $tags = undef;
            };
            if ($tags && ref $tags eq 'ARRAY' && @{$tags}) {
                my $tag = $tags->[0] || {};
                my $tag_name = $tag->{name} || '';
                my $tag_url = $tag_name
                    ? ($Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL . 'releases/tag/' . $tag_name)
                    : $Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL;
                $data = {
                    tag_name => $tag_name,
                    html_url => $tag_url
                };
            }
        }
    }
    if (!$data || ref $data ne 'HASH') {
        $result->{latest_version} = $previous->{latest_version} || '';
        $result->{release_url} = $previous->{release_url} || $result->{release_url};
        $result->{update_available} = $previous->{update_available} ? 1 : 0;
        $result->{error} = 'Unable to check for updates.';
        $self->store_data({ update_cache => to_json($result) });
        return $result;
    }

    my $latest = $data->{tag_name} || $data->{name} || '';
    $latest =~ s/^\s+|\s+$//g;
    $result->{latest_version} = $latest;
    $result->{release_url} = $data->{html_url} || $Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL;
    if ($latest) {
        my $cmp = $self->_compare_versions($Koha::Plugin::Cataloging::AutoPunctuation::VERSION, $latest);
        $result->{update_available} = ($cmp < 0) ? 1 : 0;
    }
    $self->store_data({ update_cache => to_json($result) });
    return $result;
}
sub _fetch_openai_models {
    my ($self, $settings) = @_;
    my $api_key = $self->_decrypt_secret($settings->{llm_api_key});
    return { models => [], warning => 'OpenAI API key not configured. Add a key to fetch the live model list.' } unless $api_key;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $request = HTTP::Request->new(
        'GET',
        'https://api.openai.com/v1/models',
        [
            'Authorization' => "Bearer $api_key",
            'Accept' => 'application/json',
            'Content-Type' => 'application/json',
        ]
    );
    my $response = $ua->request($request);
    return { error => 'OpenAI model list request failed.' } unless $response->is_success;
    my $data;
    try {
        $data = from_json($response->decoded_content);
    } catch {
        return { error => 'OpenAI model list response was not valid JSON.' };
    };
    my @models = ();
    if ($data->{data} && ref $data->{data} eq 'ARRAY') {
        @models = map {
            {
                id => $_->{id} || '',
                name => $_->{id} || '',
                owned_by => $_->{owned_by} || '',
            }
        } grep { $_->{id} } @{ $data->{data} };
    }
    @models = sort { ($a->{id} || '') cmp ($b->{id} || '') } @models;
    return { models => \@models };
}
sub _fetch_openrouter_models {
    my ($self, $settings, $options) = @_;
    $options = {} unless $options && ref $options eq 'HASH';
    my $allow_public = $options->{allow_public} ? 1 : 0;
    my $api_key = defined $options->{api_key} ? $options->{api_key} : '';
    $api_key =~ s/^\s+|\s+$//g if defined $api_key;
    if (!$api_key) {
        $api_key = $self->_decrypt_secret($settings->{openrouter_api_key});
    }
    return { models => [], warning => 'OpenRouter API key not configured. Add a key to fetch the live model list.' }
        unless $api_key || $allow_public;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my @headers = (
        'Accept' => 'application/json',
        'Content-Type' => 'application/json',
        'HTTP-Referer' => $Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        'X-Title' => 'Koha AACR2 Assistant',
    );
    if ($api_key) {
        unshift @headers, ( 'Authorization' => "Bearer $api_key" );
    }
    my $request = HTTP::Request->new(
        'GET',
        'https://openrouter.ai/api/v1/models',
        \@headers
    );
    my $response = $ua->request($request);
    return { error => 'OpenRouter model list request failed.' } unless $response->is_success;
    my $data;
    try {
        $data = from_json($response->decoded_content);
    } catch {
        return { error => 'OpenRouter model list response was not valid JSON.' };
    };
    my @models = ();
    if ($data->{data} && ref $data->{data} eq 'ARRAY') {
        for my $model (@{ $data->{data} }) {
            my $id = $model->{id} || $model->{canonical_slug} || '';
            next unless $id;
            my $architecture = $model->{architecture} && ref $model->{architecture} eq 'HASH'
                ? $model->{architecture}
                : {};
            my $modalities = $model->{modalities};
            $modalities = $model->{modality} if !defined $modalities || $modalities eq '';
            $modalities = $architecture->{modality} if !defined $modalities || $modalities eq '';
            my $input_modalities = $model->{input_modalities} || $model->{input_modality}
                || $architecture->{input_modalities} || $architecture->{input_modality} || [];
            my $output_modalities = $model->{output_modalities} || $model->{output_modality}
                || $architecture->{output_modalities} || $architecture->{output_modality} || [];
            $input_modalities = [$input_modalities] if defined $input_modalities && ref($input_modalities) ne 'ARRAY';
            $output_modalities = [$output_modalities] if defined $output_modalities && ref($output_modalities) ne 'ARRAY';
            my $top_provider = $model->{top_provider} && ref $model->{top_provider} eq 'HASH'
                ? $model->{top_provider}
                : {};
            my $context_length = $model->{context_length} || $top_provider->{context_length} || 0;
            my $pricing = $model->{pricing} && ref $model->{pricing} eq 'HASH' ? $model->{pricing} : {};
            push @models, {
                id => $id,
                name => $model->{name} || $id,
                description => $model->{description} || '',
                context_length => $context_length,
                pricing => $pricing,
                modalities => $modalities || [],
                input_modalities => $input_modalities || [],
                output_modalities => $output_modalities || []
            };
        }
    }
    @models = sort { ($a->{id} || '') cmp ($b->{id} || '') } @models;
    return {
        models => \@models,
        warning => ($api_key ? undef : 'OpenRouter API key not configured. Listing public models via server request.')
    };
}
sub _compare_versions {
    my ($self, $current, $latest) = @_;
    my $cur = $self->_normalize_version($current);
    my $lat = $self->_normalize_version($latest);
    my $max = @$cur > @$lat ? @$cur : @$lat;
    for my $i (0 .. $max - 1) {
        my $a = $cur->[$i] // 0;
        my $b = $lat->[$i] // 0;
        return -1 if $a < $b;
        return 1 if $a > $b;
    }
    return 0;
}
sub _normalize_version {
    my ($self, $version) = @_;
    my $value = $version // '';
    $value =~ s/^[^0-9]*//;
    my @parts = split(/\./, $value);
    @parts = map {
        my $part = $_;
        $part =~ s/[^0-9].*$//;
        $part = $part eq '' ? 0 : int($part);
        $part;
    } @parts;
    return \@parts;
}

1;
