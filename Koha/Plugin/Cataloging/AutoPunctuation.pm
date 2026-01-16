package Koha::Plugin::Cataloging::AutoPunctuation;

use Modern::Perl;
use base qw(Koha::Plugins::Base);
use C4::Auth;
use C4::Context;
use Koha::DateUtils;
use Koha::Patrons;
use CGI;
use JSON qw(to_json from_json);
use Try::Tiny;
use File::Basename;
use LWP::UserAgent;
use HTTP::Request;
use Digest::SHA qw(sha256_hex);
use Time::HiRes qw(time usleep);
use Data::Dumper;
use Scalar::Util qw(looks_like_number);

our $VERSION = "2.0.0";
our $PLUGIN_REPO_URL = "https://github.com/Dzechy/Koha_AACR2_Assistant_Plugin/";
our $PLUGIN_RELEASES_API = "https://api.github.com/repos/Dzechy/Koha_AACR2_Assistant_Plugin/releases/latest";
our $AUTHOR_LINKEDIN = "https://linkedin.com/in/duke-j-a1a9b0260";

our $metadata = {
    name            => 'AACR2 MARC21 Intellisense + Guardrails',
    author          => 'Duke Chijimaka Jonathan',
    date_authored   => '2025-06-02',
    date_updated    => '2025-06-30',
    minimum_version => '19.05.00.000',
    maximum_version => undef,
    version         => $VERSION,
    description     => 'AACR2-only MARC21 punctuation + guardrails with assistive AI for Koha cataloging: deterministic rules first, structured suggestions only, and coverage reporting across frameworks.'
};

my %AI_CACHE;
my %RATE_LIMIT;
my %CIRCUIT_BREAKER;

sub new {
    my ( $class, $args ) = @_;
    $args->{'metadata'} = $metadata;
    $args->{'metadata'}->{'class'} = $class;
    $args->{'cgi'} ||= CGI->new;
    my $self = $class->SUPER::new($args);
    return $self;
}

sub tool {
    my ( $self, $args ) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $template = $self->get_template({ file => 'tool.tt' });
    my $current_settings = $self->retrieve_data('settings') || '{}';
    my $settings = from_json($current_settings);
    my $update_info = $self->_check_for_updates();
    $template->param(
        settings => $settings,
        update_info => $update_info,
        plugin_repo_url => $PLUGIN_REPO_URL,
        author_linkedin => $AUTHOR_LINKEDIN,
        current_version => $VERSION,
        CLASS    => ref($self),
    );
    print $cgi->header(-type => 'text/html', -charset => 'utf-8');
    print $template->output();
}

sub configure {
    my ($self, $args) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $stored_settings = from_json($self->retrieve_data('settings') || '{}');
    my $defaults = $self->_default_settings();
    my $settings = { %{$defaults}, %{$stored_settings} };

    if ($cgi->param('save')) {
        $settings->{enabled} = $cgi->param('enabled') ? 1 : 0;
        $settings->{auto_apply_punctuation} = $cgi->param('auto_apply_punctuation') ? 1 : 0;
        $settings->{default_standard} = 'AACR2';
        $settings->{debug_mode} = $cgi->param('debug_mode') ? 1 : 0;
        $settings->{enable_guide} = $cgi->param('enable_guide') ? 1 : 0;
        $settings->{guide_users} = join(',', $cgi->multi_param('guide_users')) || '';
        $settings->{guide_exclusion_list} = $cgi->param('guide_exclusion_list') || '';
        $settings->{custom_rules} = $cgi->param('custom_rules') || '{}';
        $settings->{internship_mode} = $cgi->param('internship_mode') ? 1 : 0;
        $settings->{internship_users} = join(',', $cgi->multi_param('internship_users')) || '';
        $settings->{internship_exclusion_list} = $cgi->param('internship_exclusion_list') || '';
        $settings->{enforce_aacr2_guardrails} = $cgi->param('enforce_aacr2_guardrails') ? 1 : 0;
        $settings->{enable_live_validation} = $cgi->param('enable_live_validation') ? 1 : 0;
        $settings->{block_save_on_error} = $cgi->param('block_save_on_error') ? 1 : 0;
        $settings->{required_fields} = $cgi->param('required_fields') || '100a,245a,260c,300a,050a';
        $settings->{excluded_tags} = $cgi->param('excluded_tags') || '';
        $settings->{strict_coverage_mode} = $cgi->param('strict_coverage_mode') ? 1 : 0;
        $settings->{enable_local_fields} = $cgi->param('enable_local_fields') ? 1 : 0;
        $settings->{local_fields_allowlist} = $cgi->param('local_fields_allowlist') || '';
        $settings->{ai_enable} = $cgi->param('ai_enable') ? 1 : 0;
        $settings->{ai_punctuation_explain} = $cgi->param('ai_punctuation_explain') ? 1 : 0;
        $settings->{ai_subject_guidance} = $cgi->param('ai_subject_guidance') ? 1 : 0;
        $settings->{ai_callnumber_guidance} = $cgi->param('ai_callnumber_guidance') ? 1 : 0;
        $settings->{ai_model} = $cgi->param('ai_model') || $settings->{ai_model};
        $settings->{ai_model_options} = $cgi->param('ai_model_options') || $settings->{ai_model_options};
        $settings->{ai_model_openai} = $cgi->param('ai_model_openai') || $settings->{ai_model_openai} || $settings->{ai_model};
        $settings->{ai_model_openrouter} = $cgi->param('ai_model_openrouter') || $settings->{ai_model_openrouter} || $settings->{ai_model};
        $settings->{ai_model_options_openai} = $cgi->param('ai_model_options_openai') || $settings->{ai_model_options_openai} || $settings->{ai_model_options};
        $settings->{ai_model_options_openrouter} = $cgi->param('ai_model_options_openrouter') || $settings->{ai_model_options_openrouter} || $settings->{ai_model_options};
        $settings->{ai_timeout} = $cgi->param('ai_timeout') || $settings->{ai_timeout};
        $settings->{ai_max_tokens} = $cgi->param('ai_max_tokens') || $settings->{ai_max_tokens};
        $settings->{ai_temperature} = defined $cgi->param('ai_temperature') ? $cgi->param('ai_temperature') : $settings->{ai_temperature};
        $settings->{ai_redaction_rules} = $cgi->param('ai_redaction_rules') || $settings->{ai_redaction_rules};
        $settings->{ai_rate_limit_per_minute} = $cgi->param('ai_rate_limit_per_minute') || $settings->{ai_rate_limit_per_minute};
        $settings->{ai_cache_ttl_seconds} = $cgi->param('ai_cache_ttl_seconds') || $settings->{ai_cache_ttl_seconds};
        $settings->{ai_retry_count} = $cgi->param('ai_retry_count') || $settings->{ai_retry_count};
        $settings->{ai_circuit_breaker_threshold} = $cgi->param('ai_circuit_breaker_threshold') || $settings->{ai_circuit_breaker_threshold};
        $settings->{ai_circuit_breaker_timeout} = $cgi->param('ai_circuit_breaker_timeout') || $settings->{ai_circuit_breaker_timeout};
        $settings->{ai_confidence_threshold} = defined $cgi->param('ai_confidence_threshold') ? $cgi->param('ai_confidence_threshold') : $settings->{ai_confidence_threshold};
        $settings->{llm_api_provider} = $cgi->param('llm_api_provider') || 'OpenAI';
        $settings->{llm_api_key} = $cgi->param('llm_api_key') || $settings->{llm_api_key} || '';
        $settings->{openrouter_api_key} = $cgi->param('openrouter_api_key') || $settings->{openrouter_api_key} || '';
        if (lc($settings->{llm_api_provider} || '') eq 'openrouter') {
            $settings->{ai_model} = $settings->{ai_model_openrouter} || $settings->{ai_model};
            $settings->{ai_model_options} = $settings->{ai_model_options_openrouter} || $settings->{ai_model_options};
        } else {
            $settings->{ai_model} = $settings->{ai_model_openai} || $settings->{ai_model};
            $settings->{ai_model_options} = $settings->{ai_model_options_openai} || $settings->{ai_model_options};
        }
        $settings->{last_updated} = Koha::DateUtils::dt_from_string()->strftime('%Y-%m-%d %H:%M:%S');

        # Validate custom rules JSON
        try {
            my $parsed_rules = from_json($settings->{custom_rules});
            $settings->{custom_rules} = '{}' unless $self->_custom_rules_valid($parsed_rules);
        } catch {
            $settings->{custom_rules} = '{}';
        };

        # Save settings to database
        $self->store_data({ settings => to_json($settings) });

        # Handle export rules
        if ($cgi->param('export_rules')) {
            my $json = $settings->{custom_rules};
            print $cgi->header(
                -type => 'application/json',
                -charset => 'utf-8',
                -attachment => 'auto-punctuation-rules.json'
            );
            print $json;
            return;
        }

        # Handle import rules
        if ($cgi->param('import_rules') && $cgi->param('rules_file')) {
            my $upload = $cgi->upload('rules_file');
            if ($upload) {
                my $content = do { local $/; <$upload> };
                try {
                    my $parsed_rules = from_json($content);
                    if ($self->_custom_rules_valid($parsed_rules)) {
                        $settings->{custom_rules} = $content;
                        $settings->{last_updated} = Koha::DateUtils::dt_from_string()->strftime('%Y-%m-%d %H:%M:%S');
                        $self->store_data({ settings => to_json($settings) });
                    } else {
                        warn "Invalid rules schema uploaded.";
                    }
                } catch {
                    warn "Invalid JSON file uploaded: $_";
                };
            }
        }

        # Return a response with JavaScript to show toast and redirect
        print $cgi->header(-type => 'text/html', -charset => 'utf-8');
        print <<HTML;
        <html>
            <head>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/toastr.js/latest/toastr.min.css"/>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/toastr.js/latest/toastr.min.js"></script>
            </head>
            <body>
                <script>
                    \$(document).ready(function() {
                        toastr.success('Settings saved successfully!');
                        setTimeout(function() {
                            window.location.href = "/cgi-bin/koha/plugins/run.pl?class=$self->{metadata}->{class}&method=tool";
                        }, 1000); // Redirect after 1 second
                    });
                </script>
            </body>
        </html>
HTML
        return;
    }

    my $template = $self->get_template({ file => 'configure.tt' });
    my @users;
    my $patrons = Koha::Patrons->search({}, { order_by => 'userid' });
    while (my $patron = $patrons->next) {
        next unless $patron->userid;
        push @users, {
            userid => $patron->userid,
            name => $patron->surname . ', ' . ($patron->firstname || ''),
        };
    }
    my $coverage = $self->_build_coverage_report($settings);
    my $update_info = $self->_check_for_updates();
    $template->param(
        settings => $settings,
        users => \@users,
        coverage_report => $coverage->{report} || [],
        coverage_summary => $coverage->{summary} || {},
        coverage_stubs_json => $coverage->{stubs_json} || '[]',
        rules_version => $coverage->{rules_version} || '',
        update_info => $update_info,
        plugin_repo_url => $PLUGIN_REPO_URL,
        author_linkedin => $AUTHOR_LINKEDIN,
        current_version => $VERSION,
        CLASS => ref($self),
        METHOD => 'configure',
    );
    print $cgi->header(-type => 'text/html', -charset => 'utf-8');
    print $template->output();
}

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
        ai_model => 'gpt-4.1-mini',
        ai_model_options => 'gpt-4.1-mini,gpt-4.1,gpt-4o-mini',
        ai_model_openai => 'gpt-4.1-mini',
        ai_model_options_openai => 'gpt-4.1-mini,gpt-4.1,gpt-4o-mini',
        ai_model_openrouter => 'openai/gpt-4o-mini',
        ai_model_options_openrouter => 'openai/gpt-4o-mini,openai/gpt-4o',
        ai_timeout => 30,
        ai_max_tokens => 800,
        ai_temperature => 0.2,
        ai_redaction_rules => '9XX',
        ai_rate_limit_per_minute => 6,
        ai_cache_ttl_seconds => 60,
        ai_retry_count => 2,
        ai_circuit_breaker_threshold => 3,
        ai_circuit_breaker_timeout => 60,
        ai_confidence_threshold => 0.85,
        llm_api_provider => 'OpenAI',
        llm_api_key => '',
        openrouter_api_key => '',
        last_updated => '',
    };
}

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
        current_version => $VERSION,
        latest_version => '',
        update_available => 0,
        release_url => $PLUGIN_REPO_URL,
        checked_at => $now,
        error => '',
    };

    my $ua = LWP::UserAgent->new(
        timeout => 6,
        agent => "Koha-AACR2-Assistant/$VERSION"
    );
    $ua->env_proxy;
    my $response = $ua->get($PLUGIN_RELEASES_API, 'Accept' => 'application/vnd.github+json');
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
    $result->{release_url} = $data->{html_url} || $PLUGIN_REPO_URL;
    if ($latest) {
        my $cmp = $self->_compare_versions($VERSION, $latest);
        $result->{update_available} = ($cmp < 0) ? 1 : 0;
    }
    $self->store_data({ update_cache => to_json($result) });
    return $result;
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

sub _load_guide_progress {
    my ($self) = @_;
    my $raw = $self->retrieve_data('guide_progress') || '{}';
    my $data = {};
    try {
        $data = from_json($raw);
    } catch {
        $data = {};
    };
    return $data;
}

sub _save_guide_progress {
    my ($self, $data) = @_;
    $self->store_data({ guide_progress => to_json($data || {}) });
}

sub _rules_pack_path {
    my ($self) = @_;
    return $self->get_plugin_dir() . '/rules/aacr2_baseline.json';
}

sub _load_rules_pack {
    my ($self) = @_;
    my $content = $self->_read_file('rules/aacr2_baseline.json');
    return {} unless $content;
    my $pack = {};
    try {
        $pack = from_json($content);
    } catch {
        $pack = {};
    };
    $pack->{rules} ||= [];
    return $pack;
}

sub _legacy_rules_to_new {
    my ($self, $legacy_rules) = @_;
    return [] unless $legacy_rules && ref $legacy_rules eq 'HASH';
    my $aacr2 = $legacy_rules->{AACR2};
    return [] unless $aacr2 && ref $aacr2 eq 'HASH';
    my @rules;
    for my $key (sort keys %{$aacr2}) {
        my $spec = $aacr2->{$key};
        next unless $spec && ref $spec eq 'HASH';
        next unless $key =~ /^(\d{3})([a-z0-9])$/i;
        my ($tag, $code) = ($1, $2);
        push @rules, {
            id => "CUSTOM_${tag}${code}",
            tag => $tag,
            subfields => [$code],
            severity => "WARNING",
            rationale => "Custom punctuation rule (legacy format).",
            checks => [{
                type => "punctuation",
                prefix => $spec->{prefix} // '',
                suffix => $spec->{suffix} // '',
                suffix_mode => "always",
                severity => "WARNING",
                message => "Apply custom AACR2 punctuation."
            }],
            fixes => [{
                label => "Apply custom punctuation",
                patch => [{
                    op => "replace_subfield",
                    value_template => "{{expected}}"
                }]
            }],
            examples => [{
                before => "",
                after => ""
            }]
        };
    }
    return \@rules;
}

sub _custom_rules_valid {
    my ($self, $custom_rules) = @_;
    return 1 unless $custom_rules;
    if ($custom_rules->{rules} && ref $custom_rules->{rules} eq 'ARRAY') {
        for my $rule (@{ $custom_rules->{rules} }) {
            return 0 unless $rule->{id};
            return 0 unless $rule->{tag} || $rule->{tag_pattern};
            return 0 unless $rule->{subfields} || $rule->{subfield_pattern};
            return 0 unless $rule->{checks} && ref $rule->{checks} eq 'ARRAY';
        }
        return 1;
    }
    return 1 if $custom_rules->{AACR2} && ref $custom_rules->{AACR2} eq 'HASH';
    return 0;
}

sub _merge_rules_pack {
    my ($self, $settings) = @_;
    my $pack = $self->_load_rules_pack();
    my $custom = {};
    try {
        $custom = from_json($settings->{custom_rules} || '{}');
    } catch {
        $custom = {};
    };
    my @rules = @{ $pack->{rules} || [] };
    if ($custom->{rules} && ref $custom->{rules} eq 'ARRAY') {
        push @rules, @{ $custom->{rules} };
    } else {
        my $legacy = $self->_legacy_rules_to_new($custom);
        push @rules, @{$legacy} if $legacy && ref $legacy eq 'ARRAY';
    }
    $pack->{rules} = \@rules;
    return $pack;
}

sub _indicator_match {
    my ($value, $rule_value) = @_;
    return 1 unless defined $rule_value && length $rule_value;
    return 1 if $rule_value eq '*';
    if (ref $rule_value eq 'ARRAY') {
        return scalar grep { defined $_ && $_ eq $value } @{$rule_value};
    }
    return $rule_value eq $value;
}

sub _rules_match {
    my ($self, $rule, $tag, $subfield, $ind1, $ind2) = @_;
    return 0 unless $rule;
    if ($rule->{tag}) {
        return 0 unless $rule->{tag} eq $tag;
    }
    if ($rule->{tag_pattern}) {
        my $pattern = $rule->{tag_pattern};
        return 0 unless $tag =~ /$pattern/;
    }
    return 0 unless _indicator_match($ind1 // '', $rule->{ind1});
    return 0 unless _indicator_match($ind2 // '', $rule->{ind2});
    if ($rule->{subfields} && ref $rule->{subfields} eq 'ARRAY') {
        return scalar grep { lc $_ eq lc $subfield } @{ $rule->{subfields} } ? 1 : 0;
    }
    if ($rule->{subfield_pattern}) {
        return $subfield =~ /$rule->{subfield_pattern}/;
    }
    return 1;
}

sub _is_local_tag {
    my ($tag) = @_;
    return $tag =~ /^9\d\d$/;
}

sub _is_excluded_field {
    my ($self, $settings, $tag, $subfield) = @_;
    return 1 if !$settings->{enable_local_fields} && _is_local_tag($tag);
    if ($settings->{enable_local_fields} && $settings->{local_fields_allowlist}) {
        my @allow = split(/\s*,\s*/, $settings->{local_fields_allowlist});
        my $allowed = scalar grep {
            my $entry = $_;
            if ($entry =~ /^9XX$/i) {
                return _is_local_tag($tag);
            }
            if ($entry =~ /^(\d)XX$/i) {
                return $tag =~ /^$1\d\d$/;
            }
            if ($entry =~ /^\d{3}[a-z0-9]$/i) {
                return lc($entry) eq lc($tag . $subfield);
            }
            if ($entry =~ /^\d{3}$/) {
                return $entry eq $tag;
            }
            return 0;
        } @allow;
        return 1 unless $allowed;
    }
    my @exclusions = split(/\s*,\s*/, $settings->{excluded_tags} || '');
    return scalar grep {
        my $entry = $_;
        if ($entry =~ /^(\d)XX$/i) {
            return $tag =~ /^$1\d\d$/;
        }
        if ($entry =~ /^\d{3}[a-z0-9]$/i) {
            return lc($entry) eq lc($tag . $subfield);
        }
        if ($entry =~ /^\d{3}$/) {
            return $entry eq $tag;
        }
        if ($entry =~ /^9XX$/i) {
            return _is_local_tag($tag);
        }
        return 0;
    } @exclusions;
}

sub _build_coverage_report {
    my ($self, $settings) = @_;
    my $pack = $self->_merge_rules_pack($settings);
    my @rules = @{ $pack->{rules} || [] };
    my $dbh = C4::Context->dbh;
    my $frameworks = $dbh->selectall_arrayref(
        "SELECT frameworkcode, frameworktext FROM biblio_framework",
        { Slice => {} }
    ) || [];
    my @report;
    my @stubs;
    my %summary = (covered => 0, excluded => 0, not_covered => 0, total => 0);
    for my $framework (@{$frameworks}) {
        next unless ref $framework eq 'HASH';
        my $code = $framework->{frameworkcode};
        my $rows = $dbh->selectall_arrayref(
            "SELECT tagfield, tagsubfield FROM marc_subfield_structure WHERE frameworkcode = ?",
            { Slice => {} },
            $code
        ) || [];
        my @fields;
        my %counts = (total => 0, covered => 0, excluded => 0, not_covered => 0);
        for my $row (@{$rows}) {
            next unless ref $row eq 'HASH';
            my ($tag, $subfield) = ($row->{tagfield}, $row->{tagsubfield});
            next unless $tag && $subfield;
            my $excluded = $self->_is_excluded_field($settings, $tag, $subfield);
            my @matched = grep { $self->_rules_match($_, $tag, $subfield, '*', '*') } @rules;
            my $status = $excluded ? 'excluded' : @matched ? 'covered' : 'not_covered';
            push @fields, {
                tag => $tag,
                subfield => $subfield,
                status => $status,
                rule_ids => [ map { $_->{id} || '' } @matched ],
            };
            $counts{total}++;
            $counts{$status}++;
            $summary{total}++;
            $summary{$status}++;
            if ($status eq 'not_covered') {
                push @stubs, {
                    id => "CUSTOM_${tag}${subfield}",
                    tag => $tag,
                    subfields => [$subfield],
                    severity => "INFO",
                    rationale => "Stub for local AACR2 punctuation guidance.",
                    checks => [{
                        type => "punctuation",
                        prefix => "",
                        suffix => "",
                        suffix_mode => "always",
                        severity => "INFO",
                        message => "Define AACR2 punctuation for ${tag}\$${subfield}."
                    }],
                    fixes => [{
                        label => "Apply punctuation",
                        patch => [{
                            op => "replace_subfield",
                            value_template => "{{expected}}"
                        }]
                    }],
                    examples => [{
                        before => "",
                        after => ""
                    }]
                };
            }
        }
        my @safe_fields = grep { ref $_ eq 'HASH' } @fields;
        push @report, {
            frameworkcode => $code,
            frameworktext => $framework->{frameworktext} || $code || 'Default',
            fields => \@safe_fields,
            counts => {
                total => $counts{total},
                covered => $counts{covered},
                excluded => $counts{excluded},
                not_covered => $counts{not_covered},
            }
        };
    }
    return {
        report => \@report,
        summary => \%summary,
        stubs_json => to_json(\@stubs),
        rules_version => $pack->{version} || ''
    };
}

sub _emit_json {
    my ($self, $payload) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    print $cgi->header(-type => 'application/json', -charset => 'utf-8');
    print to_json($payload);
}

sub _read_json_payload {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $json_input = $cgi->param('POSTDATA') || $cgi->param('json') || '{}';
    my $data;
    try {
        $data = from_json($json_input);
    } catch {
        return { error => 'Invalid JSON input' };
    };
    return $data;
}

sub api_classify {
    my ( $self, $args ) = @_;
    $self->_emit_json({ error => 'Deprecated endpoint. Use ai_suggest instead.' });
}

sub validate_field {
    my ( $self, $args ) = @_;
    my $settings = $self->_load_settings();
    my $payload = $self->_read_json_payload();
    return $self->_emit_json($payload) if $payload->{error};
    my $errors = $self->_validate_schema('validate_field_request.json', $payload);
    return $self->_emit_json({ error => 'Invalid request', details => $errors }) if @{$errors};

    my $pack = $self->_merge_rules_pack($settings);
    my $result = $self->_validate_field_with_rules($payload, $pack, $settings);
    $self->_emit_json($result);
}

sub validate_record {
    my ( $self, $args ) = @_;
    my $settings = $self->_load_settings();
    my $payload = $self->_read_json_payload();
    return $self->_emit_json($payload) if $payload->{error};
    my $errors = $self->_validate_schema('validate_record_request.json', $payload);
    return $self->_emit_json({ error => 'Invalid request', details => $errors }) if @{$errors};

    my $pack = $self->_merge_rules_pack($settings);
    my $result = $self->_validate_record_with_rules($payload, $pack, $settings);
    $self->_emit_json($result);
}

sub ai_suggest {
    my ( $self, $args ) = @_;
    my $settings = $self->_load_settings();
    my $payload = $self->_read_json_payload();
    return $self->_emit_json($payload) if $payload->{error};
    my $errors = $self->_validate_schema('ai_request.json', $payload);
    return $self->_emit_json({ error => 'Invalid request', details => $errors }) if @{$errors};

    unless ($settings->{ai_enable} && $self->_ai_key_available($settings)) {
        return $self->_emit_json({ error => 'AI features are disabled or missing API key for the selected provider.' });
    }

    my $tag_context = $payload->{tag_context} || {};
    my $tag = $tag_context->{tag} || '';
    my $subfields = $tag_context->{subfields} || [];
    my $primary_subfield = $subfields->[0] ? $subfields->[0]->{code} : '';
    if ($self->_is_excluded_field($settings, $tag, $primary_subfield)) {
        return $self->_emit_json({ error => 'Field is excluded from AI assistance.' });
    }

    my $pack = $self->_merge_rules_pack($settings);
    my $covered = $self->_is_field_covered($pack, $tag, $primary_subfield, $tag_context->{ind1}, $tag_context->{ind2});
    return $self->_emit_json({ error => 'No AACR2 rule defined for this field; AI assistance disabled.' }) unless $covered;

    my $user_key = $self->_current_user_key();
    unless ($self->_rate_limit_ok($settings, $user_key)) {
        return $self->_emit_json({ error => 'Rate limit exceeded. Please try again later.' });
    }

    unless ($self->_circuit_breaker_ok($settings)) {
        return $self->_emit_json({ error => 'AI circuit breaker open. Please retry later.' });
    }

    my $prompt = $self->_build_ai_prompt($payload, $settings);
    my $model_key = $self->_selected_model($settings);
    my $cache_key = sha256_hex($prompt . '|' . ($model_key || ''));
    if (my $cached = $self->_cache_get($settings, $cache_key)) {
        return $self->_emit_json($cached);
    }

    my $result = $self->_call_ai_provider($settings, $prompt);
    if ($result->{error}) {
        $self->_record_failure($settings);
        return $self->_emit_json($result);
    }

    my $validation_errors = $self->_validate_schema('ai_response.json', $result);
    if (@{$validation_errors}) {
        $self->_record_failure($settings);
        return $self->_emit_json({ error => 'Invalid AI response format', details => $validation_errors });
    }

    $self->_record_success();
    $self->_cache_set($settings, $cache_key, $result);
    $self->_emit_json($result);
}

sub test_connection {
    my ( $self, $args ) = @_;
    my $settings = $self->_load_settings();
    return $self->_emit_json({ error => 'AI not configured.' }) unless $self->_ai_key_available($settings);
    my $prompt = "Respond with JSON: {\"status\":\"ok\"}.";
    my $result = $self->_call_ai_provider($settings, $prompt);
    if ($result->{error}) {
        return $self->_emit_json($result);
    }
    return $self->_emit_json({ status => 'ok' });
}

sub guide_progress_update {
    my ( $self, $args ) = @_;
    my $payload = $self->_read_json_payload();
    return $self->_emit_json($payload) if $payload->{error};
    my $user_key = $self->_current_user_key();
    my $payload_user = $payload->{user} || $payload->{userid} || '';
    $payload_user =~ s/^\s+|\s+$//g if $payload_user;
    my $user_patron = $user_key ? Koha::Patrons->find({ userid => $user_key }) : undef;
    if (!$user_patron && $payload_user) {
        my $payload_patron = Koha::Patrons->find({ userid => $payload_user });
        $user_key = $payload_user if $payload_patron;
    }
    my $progress = $self->_load_guide_progress();
    $progress->{$user_key} = {
        user => $user_key,
        updated_at => time,
        signature => $payload->{signature} || '',
        completed => $payload->{completed} || [],
        skipped => $payload->{skipped} || [],
        summary => $payload->{summary} || {}
    };
    $self->_save_guide_progress($progress);
    return $self->_emit_json({ status => 'ok' });
}

sub guide_progress_list {
    my ( $self, $args ) = @_;
    my $progress = $self->_load_guide_progress();
    my %progress_by_user = %{ $progress || {} };
    my @rows;
    for my $user (sort keys %progress_by_user) {
        my $entry = $progress_by_user{$user} || {};
        my $patron = Koha::Patrons->find({ userid => $user });
        my $name = $patron ? ($patron->surname . ', ' . ($patron->firstname || '')) : '';
        push @rows, {
            userid => $user,
            name => $name,
            updated_at => $entry->{updated_at} || 0,
            summary => $entry->{summary} || {}
        };
    }
    return $self->_emit_json({ users => \@rows });
}

sub _schema_path {
    my ($self, $name) = @_;
    return $self->get_plugin_dir() . '/schema/' . $name;
}

sub _load_schema {
    my ($self, $name) = @_;
    my $path = $self->_schema_path($name);
    return {} unless -e $path;
    open my $fh, '<:encoding(UTF-8)', $path or return {};
    local $/;
    my $content = <$fh>;
    close $fh;
    my $schema = {};
    try {
        $schema = from_json($content);
    } catch {
        $schema = {};
    };
    return $schema;
}

sub _validate_schema {
    my ($self, $name, $data) = @_;
    my $schema = $self->_load_schema($name);
    return [] unless $schema && %{$schema};
    my @errors;
    $self->_validate_schema_node($schema, $data, '$', \@errors);
    return \@errors;
}

sub _validate_schema_node {
    my ($self, $schema, $data, $path, $errors) = @_;
    return unless $schema && ref $schema eq 'HASH';
    my $type = $schema->{type} || '';
    if ($type eq 'object') {
        if (ref $data ne 'HASH') {
            push @{$errors}, "$path should be object";
            return;
        }
        if ($schema->{required} && ref $schema->{required} eq 'ARRAY') {
            for my $key (@{ $schema->{required} }) {
                push @{$errors}, "$path missing $key" unless exists $data->{$key};
            }
        }
        if ($schema->{properties} && ref $schema->{properties} eq 'HASH') {
            for my $key (keys %{ $schema->{properties} }) {
                next unless exists $data->{$key};
                $self->_validate_schema_node($schema->{properties}{$key}, $data->{$key}, "$path.$key", $errors);
            }
        }
    } elsif ($type eq 'array') {
        if (ref $data ne 'ARRAY') {
            push @{$errors}, "$path should be array";
            return;
        }
        if ($schema->{items}) {
            for my $i (0 .. $#{$data}) {
                $self->_validate_schema_node($schema->{items}, $data->[$i], "$path\[$i\]", $errors);
            }
        }
    } elsif ($type eq 'string') {
        push @{$errors}, "$path should be string" if ref $data;
    } elsif ($type eq 'number') {
        push @{$errors}, "$path should be number" unless defined $data && looks_like_number($data);
    } elsif ($type eq 'boolean') {
        my $is_bool = 0;
        if (defined $data) {
            if (ref $data) {
                $is_bool = ("$data" eq '1' || "$data" eq '0') ? 1 : 0;
            } else {
                $is_bool = ($data eq '0' || $data eq '1' || $data =~ /^(true|false)$/i) ? 1 : 0;
            }
        }
        push @{$errors}, "$path should be boolean" unless $is_bool;
    }
}

sub _cache_get {
    my ($self, $settings, $key) = @_;
    my $entry = $AI_CACHE{$key};
    return unless $entry;
    return if $entry->{expires} && $entry->{expires} < time;
    return $entry->{value};
}

sub _cache_set {
    my ($self, $settings, $key, $value) = @_;
    my $ttl = $settings->{ai_cache_ttl_seconds} || 60;
    $AI_CACHE{$key} = {
        value => $value,
        expires => time + $ttl
    };
}

sub _rate_limit_ok {
    my ($self, $settings, $user_key) = @_;
    my $limit = $settings->{ai_rate_limit_per_minute} || 6;
    my $now = time;
    my $window = 60;
    $RATE_LIMIT{$user_key} ||= [];
    $RATE_LIMIT{$user_key} = [ grep { $_ > ($now - $window) } @{ $RATE_LIMIT{$user_key} } ];
    return 0 if scalar @{ $RATE_LIMIT{$user_key} } >= $limit;
    push @{ $RATE_LIMIT{$user_key} }, $now;
    return 1;
}

sub _current_user_key {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $userid = $cgi->remote_user || $ENV{REMOTE_USER} || '';
    my $session = $cgi->cookie('CGISESSID') || '';
    return $userid || $session || 'anonymous';
}

sub _circuit_breaker_ok {
    my ($self, $settings) = @_;
    my $state = $CIRCUIT_BREAKER{openai} || { failures => 0, open_until => 0 };
    if ($state->{open_until} && time < $state->{open_until}) {
        return 0;
    }
    if ($state->{open_until} && time >= $state->{open_until}) {
        $state->{failures} = 0;
        $state->{open_until} = 0;
        $CIRCUIT_BREAKER{openai} = $state;
    }
    return 1;
}

sub _record_failure {
    my ($self, $settings) = @_;
    my $state = $CIRCUIT_BREAKER{openai} || { failures => 0, open_until => 0 };
    $state->{failures}++;
    my $threshold = $settings->{ai_circuit_breaker_threshold} || 3;
    my $timeout = $settings->{ai_circuit_breaker_timeout} || 60;
    if ($state->{failures} >= $threshold) {
        $state->{open_until} = time + $timeout;
    }
    $CIRCUIT_BREAKER{openai} = $state;
}

sub _record_success {
    my ($self) = @_;
    $CIRCUIT_BREAKER{openai} = { failures => 0, open_until => 0 };
}

sub _call_openai_responses {
    my ($self, $settings, $prompt) = @_;
    my $api_key = $settings->{llm_api_key};
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $model = $settings->{ai_model_openai} || $settings->{ai_model} || 'gpt-4.1-mini';
    my $payload = {
        model => $model,
        input => [
            {
                role => "system",
                content => [
                    { type => "text", text => "You are an AACR2-only MARC21 cataloging assistant. Use AACR2/ISBD punctuation only. Return JSON only." }
                ]
            },
            {
                role => "user",
                content => [
                    { type => "text", text => $prompt }
                ]
            }
        ],
        max_output_tokens => int($settings->{ai_max_tokens} || 800),
        temperature => $settings->{ai_temperature} + 0,
        response_format => { type => "json_object" }
    };
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
            my $result = from_json($response->content);
            my $content = $self->_extract_response_text($result);
            warn "AACR2 AI response length: " . length($content) if $settings->{debug_mode};
            my $parsed;
            try {
                $parsed = from_json($content);
            } catch {
                return { error => 'OpenAI response was not valid JSON.' };
            };
            return $parsed;
        }
        if ($attempt < $attempts) {
            usleep($backoff);
            $backoff *= 2;
        }
        if ($attempt == $attempts) {
            return { error => "OpenAI API error: " . $response->status_line };
        }
    }
    return { error => 'OpenAI API error: unexpected failure' };
}

sub _call_openrouter_chat {
    my ($self, $settings, $prompt) = @_;
    my $api_key = $settings->{openrouter_api_key};
    my $ua = LWP::UserAgent->new(timeout => $settings->{ai_timeout} || 30);
    my $model = $settings->{ai_model_openrouter} || $settings->{ai_model} || 'openai/gpt-4o-mini';
    my $payload = {
        model => $model,
        messages => [
            {
                role => "system",
                content => "You are an AACR2-only MARC21 cataloging assistant. Use AACR2/ISBD punctuation only. Return JSON only."
            },
            {
                role => "user",
                content => $prompt
            }
        ],
        max_tokens => int($settings->{ai_max_tokens} || 800),
        temperature => $settings->{ai_temperature} + 0
    };
    warn "AACR2 OpenRouter request length: " . length($prompt) if $settings->{debug_mode};
    my $request = HTTP::Request->new(
        'POST',
        'https://openrouter.ai/api/v1/chat/completions',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
            'HTTP-Referer' => $PLUGIN_REPO_URL,
            'X-Title' => 'Koha AACR2 Assistant',
        ],
        to_json($payload)
    );

    my $attempts = ($settings->{ai_retry_count} || 2) + 1;
    my $backoff = 200_000;
    for my $attempt (1 .. $attempts) {
        my $response = $ua->request($request);
        if ($response->is_success) {
            my $result = from_json($response->content);
            my $content = $self->_extract_openrouter_text($result);
            warn "AACR2 OpenRouter response length: " . length($content) if $settings->{debug_mode};
            my $parsed;
            try {
                $parsed = from_json($content);
            } catch {
                return { error => 'OpenRouter response was not valid JSON.' };
            };
            return $parsed;
        }
        if ($attempt < $attempts) {
            usleep($backoff);
            $backoff *= 2;
        }
        if ($attempt == $attempts) {
            return { error => "OpenRouter API error: " . $response->status_line };
        }
    }
    return { error => 'OpenRouter API error: unexpected failure' };
}

sub _extract_openrouter_text {
    my ($self, $response) = @_;
    if ($response->{choices} && ref $response->{choices} eq 'ARRAY') {
        for my $choice (@{ $response->{choices} }) {
            my $message = $choice->{message} || {};
            if (defined $message->{content}) {
                return $message->{content};
            }
        }
    }
    return '';
}

sub _ai_key_available {
    my ($self, $settings) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openai');
    if ($provider eq 'openrouter') {
        return $settings->{openrouter_api_key} ? 1 : 0;
    }
    return $settings->{llm_api_key} ? 1 : 0;
}

sub _selected_model {
    my ($self, $settings) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openai');
    if ($provider eq 'openrouter') {
        return $settings->{ai_model_openrouter} || $settings->{ai_model} || 'openai/gpt-4o-mini';
    }
    return $settings->{ai_model_openai} || $settings->{ai_model} || 'gpt-4.1-mini';
}

sub _selected_model_options {
    my ($self, $settings) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openai');
    if ($provider eq 'openrouter') {
        return $settings->{ai_model_options_openrouter} || $settings->{ai_model_options} || '';
    }
    return $settings->{ai_model_options_openai} || $settings->{ai_model_options} || '';
}

sub _call_ai_provider {
    my ($self, $settings, $prompt) = @_;
    my $provider = lc($settings->{llm_api_provider} || 'openai');
    if ($provider eq 'openrouter') {
        return $self->_call_openrouter_chat($settings, $prompt);
    }
    return $self->_call_openai_responses($settings, $prompt);
}

sub _extract_response_text {
    my ($self, $response) = @_;
    my $content = '';
    if ($response->{output} && ref $response->{output} eq 'ARRAY') {
        for my $item (@{ $response->{output} }) {
            next unless $item->{content};
            for my $chunk (@{ $item->{content} }) {
                next unless $chunk->{text};
                $content .= $chunk->{text};
            }
        }
    }
    $content ||= $response->{output_text} || '';
    return $content;
}

sub _build_ai_prompt {
    my ($self, $payload, $settings) = @_;
    my $tag_context = $self->_redact_tag_context($payload->{tag_context}, $settings);
    my $record_context = $self->_redact_record_context($payload->{record_context}, $settings);
    my $features = $payload->{features} || {};
    my $capabilities = {
        punctuation_explain => $settings->{ai_punctuation_explain} ? ($features->{punctuation_explain} ? 1 : 0) : 0,
        subject_guidance => $settings->{ai_subject_guidance} ? ($features->{subject_guidance} ? 1 : 0) : 0,
        call_number_guidance => $settings->{ai_callnumber_guidance} ? ($features->{call_number_guidance} ? 1 : 0) : 0
    };
    my $payload_json = to_json({
        request_id => $payload->{request_id},
        tag_context => $tag_context,
        record_context => $record_context,
        capabilities => $capabilities
    });
    return <<"PROMPT";
You are an AACR2-only MARC21 punctuation assistant. Use AACR2/ISBD punctuation conventions only; avoid non-AACR2 terminology.
If subject guidance is enabled, suggest LCSH-style subject headings in 650/651 only.
If call number guidance is enabled, suggest Library of Congress Classification only (use 050/090, never DDC).
If punctuation explanations are enabled, focus on the provided tag_context only.
Respond with JSON ONLY using this contract:
{
  "version": "1.0",
  "request_id": "...",
  "tag_context": { "tag": "...", "ind1": "...", "ind2": "...", "subfields": [{"code":"a","value":"..."}] },
  "findings": [
    {
      "severity": "ERROR|WARNING|INFO",
      "code": "AACR2_RULE_ID",
      "message": "...",
      "rationale": "...",
      "proposed_fixes": [
        { "label": "...", "patch": [ { "op": "replace_subfield", "tag": "245", "code": "a", "value": "..." } ] }
      ],
      "confidence": 0.0
    }
  ],
  "disclaimer": "Suggestions only; review before saving."
}
If a capability is disabled, omit related findings.
Input context (JSON):
$payload_json
PROMPT
}

sub _redact_tag_context {
    my ($self, $tag_context, $settings) = @_;
    return {} unless $tag_context && ref $tag_context eq 'HASH';
    my %clone = %{$tag_context};
    if ($clone{subfields} && ref $clone{subfields} eq 'ARRAY') {
        my @redacted;
        for my $sub (@{ $clone{subfields} }) {
            my $value = $self->_redact_value($settings, $clone{tag}, $sub->{code}, $sub->{value});
            push @redacted, { code => $sub->{code}, value => $value };
        }
        $clone{subfields} = \@redacted;
    }
    return \%clone;
}

sub _redact_record_context {
    my ($self, $record_context, $settings) = @_;
    return {} unless $record_context && ref $record_context eq 'HASH';
    my %clone = %{$record_context};
    if ($clone{fields} && ref $clone{fields} eq 'ARRAY') {
        my @fields;
        for my $field (@{ $clone{fields} }) {
            my %f = %{$field};
            if ($f{subfields} && ref $f{subfields} eq 'ARRAY') {
                my @subs;
                for my $sub (@{ $f{subfields} }) {
                    my $value = $self->_redact_value($settings, $f{tag}, $sub->{code}, $sub->{value});
                    push @subs, { code => $sub->{code}, value => $value };
                }
                $f{subfields} = \@subs;
            }
            push @fields, \%f;
        }
        $clone{fields} = \@fields;
    }
    return \%clone;
}

sub _redact_value {
    my ($self, $settings, $tag, $subfield, $value) = @_;
    my @rules = split(/\s*,\s*/, $settings->{ai_redaction_rules} || '');
    my $should_redact = scalar grep {
        my $entry = $_;
        if ($entry =~ /^9XX$/i) {
            return _is_local_tag($tag);
        }
        if ($entry =~ /^(\d)XX$/i) {
            return $tag =~ /^$1\d\d$/;
        }
        if ($entry =~ /^\d{3}[a-z0-9]$/i) {
            return lc($entry) eq lc($tag . $subfield);
        }
        if ($entry =~ /^\d{3}$/) {
            return $entry eq $tag;
        }
        return 0;
    } @rules;
    return $should_redact ? '[REDACTED]' : $value;
}

sub _is_field_covered {
    my ($self, $pack, $tag, $subfield, $ind1, $ind2) = @_;
    my @rules = @{ $pack->{rules} || [] };
    for my $rule (@rules) {
        return 1 if $self->_rules_match($rule, $tag, $subfield, $ind1, $ind2);
    }
    return 0;
}

sub _resolve_suffix {
    my ($self, $check, $field, $code) = @_;
    my $mode = $check->{suffix_mode} || 'always';
    my $following = $check->{when_following_subfields} || [];
    my $has_following = 0;
    if ($following && ref $following eq 'ARRAY') {
        for my $sub (@{ $field->{subfields} || [] }) {
            next unless $sub->{code} && $sub->{value};
            next if lc($sub->{code}) eq lc($code);
            if (grep { lc($_) eq lc($sub->{code}) } @{$following}) {
                $has_following = 1;
                last;
            }
        }
    }
    if ($mode eq 'conditional_following') {
        return $has_following ? ($check->{suffix_if_following} // '') : ($check->{suffix_if_last} // ($check->{suffix} // ''));
    }
    if ($mode eq 'when_following') {
        return $has_following ? ($check->{suffix_if_following} // ($check->{suffix} // '')) : '';
    }
    if ($mode eq 'when_last') {
        return $has_following ? '' : ($check->{suffix_if_last} // ($check->{suffix} // ''));
    }
    return $check->{suffix} // '';
}

sub _expected_value_for_check {
    my ($self, $check, $field, $subfield) = @_;
    my $value = $subfield->{value} // '';
    if ($check->{case_mode}) {
        $value = $self->_apply_case_mode($value, $check->{case_mode});
    }
    my $prefix = $check->{prefix} // '';
    my $suffix = $self->_resolve_suffix($check, $field, $subfield->{code});
    my $expected = $value;
    $expected =~ s/\s+$//g;
    if ($prefix) {
        my $prefix_trim = $prefix;
        $prefix_trim =~ s/^\s+//;
        if ($expected !~ /^\Q$prefix\E/ && ($prefix_trim eq '' || $expected !~ /^\Q$prefix_trim\E/)) {
            $expected = $prefix . $expected;
        } elsif ($prefix_trim && $expected =~ /^\Q$prefix_trim\E/ && $expected !~ /^\Q$prefix\E/) {
            $expected =~ s/^\Q$prefix_trim\E/$prefix/;
        }
    }
    if ($suffix && $expected !~ /\Q$suffix\E$/) {
        if (!defined $check->{trim_trailing_punct} || $check->{trim_trailing_punct}) {
            $expected =~ s/[[:space:]]*[.,;:!?]+$//;
        }
        $expected .= $suffix;
    }
    return $expected;
}

sub _apply_case_mode {
    my ($self, $text, $mode) = @_;
    return '' unless defined $text;
    return lc($text) if $mode eq 'lower';
    return $self->_initial_upper(lc($text)) if $mode eq 'sentence';
    return $self->_initial_upper($text) if $mode eq 'initial_upper';
    return $self->_title_case($text) if $mode eq 'title';
    return $text;
}

sub _initial_upper {
    my ($self, $text) = @_;
    my @chars = split(//, $text);
    for my $i (0 .. $#chars) {
        if ($chars[$i] =~ /[A-Za-z]/) {
            $chars[$i] = uc($chars[$i]);
            last;
        }
    }
    return join('', @chars);
}

sub _title_case {
    my ($self, $text) = @_;
    my @words = split(/\s+/, $text);
    my @out;
    for my $word (@words) {
        if ($word eq '') {
            push @out, $word;
            next;
        }
        my ($leading, $core, $trailing) = $word =~ /^([("'\\[]*)([A-Za-z][A-Za-z'.-]*)([^A-Za-z]*)$/;
        if (!$core) {
            push @out, $word;
            next;
        }
        if (uc($core) eq $core && length($core) <= 3) {
            push @out, $leading . $core . ($trailing || '');
            next;
        }
        if ($core =~ /^Mc[A-Za-z]/) {
            my $rest = substr($core, 2);
            my $fixed = 'Mc' . uc(substr($rest, 0, 1)) . lc(substr($rest, 1));
            push @out, $leading . $fixed . ($trailing || '');
            next;
        }
        if (index($core, "'") >= 0) {
            my @parts = split(/'/, $core);
            @parts = map { $_ ? uc(substr($_, 0, 1)) . lc(substr($_, 1)) : $_ } @parts;
            my $fixed = join("'", @parts);
            push @out, $leading . $fixed . ($trailing || '');
            next;
        }
        my $fixed = uc(substr($core, 0, 1)) . lc(substr($core, 1));
        push @out, $leading . $fixed . ($trailing || '');
    }
    return join(' ', @out);
}

sub _validate_field_with_rules {
    my ($self, $payload, $pack, $settings) = @_;
    my @findings;
    my @rules = @{ $pack->{rules} || [] };
    my %matched_rules;
    my $tag = $payload->{tag};
    for my $sub (@{ $payload->{subfields} || [] }) {
        my $code = $sub->{code};
        next if $self->_is_excluded_field($settings, $tag, $code);
        my @matched = grep { $self->_rules_match($_, $tag, $code, $payload->{ind1}, $payload->{ind2}) } @rules;
        if (@matched > 1) {
            my @filtered = grep { !$_->{only_when_no_other_rule} } @matched;
            @matched = @filtered if @filtered;
        }
        $matched_rules{$_->{id}} = 1 for @matched;
        for my $rule (@matched) {
            for my $check (@{ $rule->{checks} || [] }) {
                my $value = $sub->{value} // '';
                my $expected = $value;
                if ($check->{type} eq 'punctuation') {
                    $expected = $self->_expected_value_for_check($check, $payload, $sub);
                } elsif ($check->{type} eq 'separator') {
                    my $sep = $check->{separator} // ' -- ';
                    my $suffix = $self->_resolve_suffix($check, $payload, $sub->{code});
                    $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                    if ($suffix && $expected !~ /\Q$suffix\E$/) {
                        $expected .= $suffix;
                    } elsif ($sep && $expected !~ /\Q$sep\E$/) {
                        $expected .= $sep;
                    }
                } elsif ($check->{type} eq 'no_terminal_punctuation') {
                    $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                } elsif ($check->{type} eq 'spacing') {
                    $expected =~ s/\s{2,}/ /g;
                } elsif ($check->{type} eq 'fixed_field') {
                    next;
                }
                next if $expected eq $value;
                my $severity = $check->{severity} || $rule->{severity} || 'INFO';
                push @findings, {
                    severity => $severity,
                    code => $rule->{id} || 'AACR2_RULE',
                    message => $check->{message} || "AACR2 punctuation issue in $tag\$$code",
                    rationale => $rule->{rationale} || '',
                    tag => $tag,
                    subfield => $code,
                    examples => $rule->{examples} || [],
                    proposed_fixes => [{
                        label => ($rule->{fixes} && $rule->{fixes}[0]{label}) || 'Apply AACR2 punctuation',
                        patch => [{
                            op => 'replace_subfield',
                            tag => $tag,
                            code => $code,
                            value => $expected
                        }]
                    }]
                };
            }
        }
    }
    return {
        tag => $tag,
        findings => \@findings,
        coverage => {
            covered => scalar keys %matched_rules ? 1 : 0,
            rule_ids => [ sort keys %matched_rules ],
            rules_version => $pack->{version} || ''
        }
    };
}

sub _validate_record_with_rules {
    my ($self, $payload, $pack, $settings) = @_;
    my @findings;
    my @rules = @{ $pack->{rules} || [] };
    for my $field (@{ $payload->{fields} || [] }) {
        my $tag = $field->{tag};
        for my $sub (@{ $field->{subfields} || [] }) {
            next if $self->_is_excluded_field($settings, $tag, $sub->{code});
            my @matched = grep { $self->_rules_match($_, $tag, $sub->{code}, $field->{ind1}, $field->{ind2}) } @rules;
            if (@matched > 1) {
                my @filtered = grep { !$_->{only_when_no_other_rule} } @matched;
                @matched = @filtered if @filtered;
            }
            if (!@matched && ($payload->{strict_coverage_mode} || $settings->{strict_coverage_mode})) {
                push @findings, {
                    severity => 'INFO',
                    code => 'AACR2_COVERAGE_MISSING',
                    message => "No AACR2 rule defined for $tag\$$sub->{code}; no punctuation assistance applied.",
                    rationale => 'Strict coverage mode is enabled.',
                    tag => $tag,
                    subfield => $sub->{code},
                    proposed_fixes => []
                };
            }
            for my $rule (@matched) {
                for my $check (@{ $rule->{checks} || [] }) {
                    my $value = $sub->{value} // '';
                    my $expected = $value;
                    if ($check->{type} eq 'punctuation') {
                        $expected = $self->_expected_value_for_check($check, $field, $sub);
                    } elsif ($check->{type} eq 'separator') {
                        my $sep = $check->{separator} // ' -- ';
                        $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                        if ($sep && $expected !~ /\Q$sep\E$/) {
                            $expected .= $sep;
                        }
                    } elsif ($check->{type} eq 'no_terminal_punctuation') {
                        $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                    } elsif ($check->{type} eq 'spacing') {
                        $expected =~ s/\s{2,}/ /g;
                    } elsif ($check->{type} eq 'fixed_field') {
                        next;
                    }
                    next if $expected eq $value;
                    my $severity = $check->{severity} || $rule->{severity} || 'INFO';
                    push @findings, {
                        severity => $severity,
                        code => $rule->{id} || 'AACR2_RULE',
                        message => $check->{message} || "AACR2 punctuation issue in $tag\$$sub->{code}",
                        rationale => $rule->{rationale} || '',
                        tag => $tag,
                        subfield => $sub->{code},
                        proposed_fixes => [{
                            label => ($rule->{fixes} && $rule->{fixes}[0]{label}) || 'Apply AACR2 punctuation',
                            patch => [{
                                op => 'replace_subfield',
                                tag => $tag,
                                code => $sub->{code},
                                value => $expected
                            }]
                        }]
                    };
                }
            }
        }
    }
    return {
        findings => \@findings,
        rules_version => $pack->{version} || ''
    };
}

sub intranet_js {
    my ($self) = @_;
    return try {
        my $settings = $self->_load_settings();
        warn "AutoPunctuation parsed settings: " . Dumper($settings) if $settings->{debug_mode};
        return '' unless $settings->{enabled};
        my $script_name = $ENV{SCRIPT_NAME} || '';
        return '' unless $script_name =~ m{/cataloguing/};
        my $cgi = $self->{'cgi'} || CGI->new;
        my $frameworkcode = $cgi->param('frameworkcode') // '';
        my $framework_fields = [];
        my $dbh = C4::Context->dbh;
        my $rows = $dbh->selectall_arrayref(
            "SELECT tagfield, tagsubfield FROM marc_subfield_structure WHERE frameworkcode = ?",
            { Slice => {} },
            $frameworkcode
        ) || [];
        if (!@{$rows} && $frameworkcode ne '') {
            $rows = $dbh->selectall_arrayref(
                "SELECT tagfield, tagsubfield FROM marc_subfield_structure WHERE frameworkcode = ''",
                { Slice => {} }
            ) || [];
        }
        for my $row (@{$rows}) {
            next unless ref $row eq 'HASH';
            push @{$framework_fields}, {
                tag => $row->{tagfield} || '',
                subfield => $row->{tagsubfield} || ''
            };
        }
        my @js_files = (
            'js/rules_engine.js',
            'js/api_client.js',
            'js/marc_intellisense_ui.js',
            'js/auto-punctuation.js'
        );
        my $js_content = join("\n", map { $self->_read_file($_) || '' } @js_files);
        return '' unless $js_content;
        my $rules_pack = $self->_load_rules_pack();
        my $rules_pack_json = to_json($rules_pack);
        my $framework_fields_json = to_json($framework_fields || []);
        my $schemas = {
            ai_request => $self->_load_schema('ai_request.json'),
            ai_response => $self->_load_schema('ai_response.json'),
            validate_field_request => $self->_load_schema('validate_field_request.json'),
            validate_record_request => $self->_load_schema('validate_record_request.json'),
        };
        my $schemas_json = to_json($schemas);
        # Precompute values to avoid concatenation issues
        my $enabled = $settings->{enabled} ? 'true' : 'false';
        my $auto_apply_punctuation = $settings->{auto_apply_punctuation} ? 'true' : 'false';
        my $cataloging_standard = $settings->{default_standard} || 'AACR2';
        my $debug_mode = $settings->{debug_mode} ? 'true' : 'false';
        my $enable_guide = $settings->{enable_guide} ? 'true' : 'false';
        my $guide_users = $settings->{guide_users} || '';
        my $guide_exclusion_list = $settings->{guide_exclusion_list} || '';
        my $custom_rules = $settings->{custom_rules} || '{}';
        my $internship_mode = $settings->{internship_mode} ? 'true' : 'false';
        my $internship_users = $settings->{internship_users} || '';
        my $internship_exclusion_list = $settings->{internship_exclusion_list} || '';
        my $enforce_aacr2_guardrails = $settings->{enforce_aacr2_guardrails} ? 'true' : 'false';
        my $enable_live_validation = $settings->{enable_live_validation} ? 'true' : 'false';
        my $block_save_on_error = $settings->{block_save_on_error} ? 'true' : 'false';
        my $required_fields = $settings->{required_fields} || '';
        my $excluded_tags = $settings->{excluded_tags} || '';
        my $strict_coverage_mode = $settings->{strict_coverage_mode} ? 'true' : 'false';
        my $enable_local_fields = $settings->{enable_local_fields} ? 'true' : 'false';
        my $local_fields_allowlist = $settings->{local_fields_allowlist} || '';
        my $ai_enable = $settings->{ai_enable} ? 'true' : 'false';
        my $ai_punctuation_explain = $settings->{ai_punctuation_explain} ? 'true' : 'false';
        my $ai_subject_guidance = $settings->{ai_subject_guidance} ? 'true' : 'false';
        my $ai_callnumber_guidance = $settings->{ai_callnumber_guidance} ? 'true' : 'false';
        my $ai_model = $self->_selected_model($settings) || '';
        my $ai_confidence_threshold = $settings->{ai_confidence_threshold} || 0.85;
        my $api_provider = $settings->{llm_api_provider} || 'OpenAI';
        my $ai_configured = ($settings->{ai_enable} && $self->_ai_key_available($settings)) ? 'true' : 'false';
        my $last_updated = $settings->{last_updated} || '';
        my $plugin_path = "/cgi-bin/koha/plugins/run.pl?class=" . ref($self);
        # Escape strings for JavaScript
        $guide_users =~ s/"/\\"/g;
        $guide_exclusion_list =~ s/"/\\"/g;
        $custom_rules =~ s/"/\\"/g;
        $internship_users =~ s/"/\\"/g;
        $internship_exclusion_list =~ s/"/\\"/g;
        $required_fields =~ s/"/\\"/g;
        $excluded_tags =~ s/"/\\"/g;
        $local_fields_allowlist =~ s/"/\\"/g;
        $last_updated =~ s/"/\\"/g;
        $cataloging_standard =~ s/"/\\"/g;
        $api_provider =~ s/"/\\"/g;
        $ai_model =~ s/"/\\"/g;
        $frameworkcode =~ s/"/\\"/g;
        warn "AutoPunctuation precomputed values: enabled=$enabled, standard=$cataloging_standard, debug=$debug_mode, provider=$api_provider" if $settings->{debug_mode};
        return qq{
            <script type="text/javascript">
                // AutoPunctuation Plugin v$VERSION
                (function() {
                    if (typeof window.AutoPunctuation !== 'undefined') {
                        console.warn('AutoPunctuation already loaded, skipping...');
                        return;
                    }
                    window.AACR2RulePack = $rules_pack_json;
                    window.AACR2Schemas = $schemas_json;
                    window.AutoPunctuationSettings = {
                        enabled: $enabled,
                        autoApplyPunctuation: $auto_apply_punctuation,
                        catalogingStandard: "$cataloging_standard",
                        debugMode: $debug_mode,
                        enableGuide: $enable_guide,
                        guideUsers: "$guide_users",
                        guideExclusionList: "$guide_exclusion_list",
                        customRules: "$custom_rules",
                        internshipMode: $internship_mode,
                        internshipUsers: "$internship_users",
                        internshipExclusionList: "$internship_exclusion_list",
                        enforceAacr2Guardrails: $enforce_aacr2_guardrails,
                        enableLiveValidation: $enable_live_validation,
                        blockSaveOnError: $block_save_on_error,
                        requiredFields: "$required_fields",
                        excludedTags: "$excluded_tags",
                        strictCoverageMode: $strict_coverage_mode,
                        enableLocalFields: $enable_local_fields,
                        localFieldsAllowlist: "$local_fields_allowlist",
                        aiEnable: $ai_enable,
                        aiPunctuationExplain: $ai_punctuation_explain,
                        aiSubjectGuidance: $ai_subject_guidance,
                        aiCallNumberGuidance: $ai_callnumber_guidance,
                        aiModel: "$ai_model",
                        aiConfigured: $ai_configured,
                        aiConfidenceThreshold: $ai_confidence_threshold,
                        llmApiProvider: "$api_provider",
                        frameworkCode: "$frameworkcode",
                        frameworkFields: $framework_fields_json,
                        last_updated: "$last_updated",
                        pluginPath: "$plugin_path"
                    };
                    $js_content
                })();
            </script>
        };
    }
    catch {
        my $error = $_;
        warn "AutoPunctuation intranet_js failed: $error";
        return '';
    };
}

sub uninstall {
    my ($self) = @_;
    return 1;
}

sub get_plugin_dir {
    my ($self) = @_;
    my $class_path = ref($self) || $self;
    $class_path =~ s{::}{/}g;
    return C4::Context->config('pluginsdir') . '/' . $class_path;
}

sub _read_file {
    my ($self, $relative_path) = @_;
    my $file_path = $self->get_plugin_dir() . '/' . $relative_path;
    open my $fh, '<:encoding(UTF-8)', $file_path or return undef;
    local $/;
    my $content = <$fh>;
    close $fh;
    return $content;
}

1;
