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

    my $result = {
        current_version => Koha::Plugin::Cataloging::AutoPunctuation::VERSION,
        latest_version => '',
        update_available => 0,
        release_url => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        checked_at => $now,
        error => '',
    };

    my $ua = LWP::UserAgent->new(
        timeout => 6,
        agent => 'Koha-AACR2-Assistant/' . Koha::Plugin::Cataloging::AutoPunctuation::VERSION
    );
    $ua->env_proxy;
    my $response = $ua->get(Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_RELEASES_API, 'Accept' => 'application/vnd.github+json');
    if (!$response->is_success) {
        $result->{error} = 'Unable to check for updates.';
        $self->store_data({ update_cache => to_json($result) });
        return $result;
    }

    my $data;
    try {
        $data = from_json($response->decoded_content);
    } catch {
        $result->{error} = 'Invalid update response.';
        $self->store_data({ update_cache => to_json($result) });
        return $result;
    };

    my $latest = $data->{tag_name} || $data->{name} || '';
    $latest =~ s/^\s+|\s+$//g;
    $result->{latest_version} = $latest;
    $result->{release_url} = $data->{html_url} || Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL;
    if ($latest) {
        my $cmp = $self->_compare_versions(Koha::Plugin::Cataloging::AutoPunctuation::VERSION, $latest);
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
        @models = map { { id => $_->{id} || '' } } grep { $_->{id} } @{ $data->{data} };
    }
    @models = sort { ($a->{id} || '') cmp ($b->{id} || '') } @models;
    return { models => \@models };
}
sub _fetch_openrouter_models {
    my ($self, $settings) = @_;
    my $api_key = $self->_decrypt_secret($settings->{openrouter_api_key});
    return { models => [], warning => 'OpenRouter API key not configured. Add a key to fetch the live model list.' } unless $api_key;
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my @headers = (
        'Content-Type' => 'application/json',
        'HTTP-Referer' => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        'X-Title' => 'Koha AACR2 Assistant',
    );
    push @headers, ('Authorization' => "Bearer $api_key");
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
            next unless $model->{id};
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
            push @models, {
                id => $model->{id},
                name => $model->{name} || $model->{id},
                description => $model->{description} || '',
                context_length => $model->{context_length} || 0,
                pricing => $model->{pricing} || {},
                modalities => $modalities || [],
                input_modalities => $input_modalities || [],
                output_modalities => $output_modalities || []
            };
        }
    }
    @models = sort { ($a->{id} || '') cmp ($b->{id} || '') } @models;
    return { models => \@models, warning => ($api_key ? undef : 'OpenRouter API key not configured. Listing public models.') };
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
