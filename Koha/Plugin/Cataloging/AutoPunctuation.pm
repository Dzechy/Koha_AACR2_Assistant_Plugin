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
use Data::Dumper;

our $VERSION = "1.3.0";

our $metadata = {
    name            => 'AACR2 MARC21 LCC Intellisense',
    author          => 'Duke Chijimaka Jonathan',
    date_authored   => '2025-06-02',
    date_updated    => '2025-06-20',
    minimum_version => '19.05.00.000',
    maximum_version => undef,
    version         => $VERSION,
    description     => 'AACR2-only MARC21 and Library of Congress Classification (LCC) intellisense for Koha cataloging: auto-punctuation, floating UI overlay, AI-driven subject access and call number suggestions across AACR2-required fields.'
};

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
    $template->param(
        settings => $settings,
        CLASS    => ref($self),
    );
    print $cgi->header(-type => 'text/html', -charset => 'utf-8');
    print $template->output();
}

sub configure {
    my ($self, $args) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;

    if ($cgi->param('save')) {
        my $settings = {
            enabled => $cgi->param('enabled') ? 1 : 0,
            default_standard => 'AACR2',
            debug_mode => $cgi->param('debug_mode') ? 1 : 0,
            enable_guide => $cgi->param('enable_guide') ? 1 : 0,
            guide_users => join(',', $cgi->multi_param('guide_users')) || '',
            guide_exclusion_list => $cgi->param('guide_exclusion_list') || '',
            custom_rules => $cgi->param('custom_rules') || '{}',
            internship_mode => $cgi->param('internship_mode') ? 1 : 0,
            internship_users => join(',', $cgi->multi_param('internship_users')) || '',
            internship_exclusion_list => $cgi->param('internship_exclusion_list') || '',
            enforce_aacr2_guardrails => $cgi->param('enforce_aacr2_guardrails') ? 1 : 0,
            enable_live_validation => $cgi->param('enable_live_validation') ? 1 : 0,
            block_save_on_error => $cgi->param('block_save_on_error') ? 1 : 0,
            required_fields => $cgi->param('required_fields') || '100a,245a,260c,300a,050a',
            excluded_tags => $cgi->param('excluded_tags') || '',
            llm_api_provider => $cgi->param('llm_api_provider') || 'OpenAI',
            llm_api_key => $cgi->param('llm_api_key') || '',
            last_updated => Koha::DateUtils::dt_from_string()->strftime('%Y-%m-%d %H:%M:%S'),
        };

        # Validate custom rules JSON
        try {
            from_json($settings->{custom_rules});
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
                    from_json($content);
                    $settings->{custom_rules} = $content;
                    $settings->{last_updated} = Koha::DateUtils::dt_from_string()->strftime('%Y-%m-%d %H:%M:%S');
                    $self->store_data({ settings => to_json($settings) });
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
    my $current_settings = $self->retrieve_data('settings') || '{}';
    my $settings = from_json($current_settings);
    my @users;
    my $patrons = Koha::Patrons->search({}, { order_by => 'userid' });
    while (my $patron = $patrons->next) {
        next unless $patron->userid;
        push @users, {
            userid => $patron->userid,
            name => $patron->surname . ', ' . ($patron->firstname || ''),
        };
    }
    $template->param(
        settings => $settings,
        users => \@users,
        CLASS => ref($self),
        METHOD => 'configure',
    );
    print $cgi->header(-type => 'text/html', -charset => 'utf-8');
    print $template->output();
}

sub api_classify {
    my ( $self, $args ) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;

    print $cgi->header(-type => 'application/json', -charset => 'utf-8');

    my $settings = from_json($self->retrieve_data('settings') || '{}');

    unless ( $settings->{llm_api_key} && $settings->{llm_api_provider} ) {
        print to_json({ error => 'No API key or provider configured' });
        return;
    }

    my $json_input = $cgi->param('POSTDATA') || $cgi->param('json');
    my $data;

    try {
        $data = from_json($json_input);
    } catch {
        print to_json({ error => 'Invalid JSON input' });
        return;
    };

    my $result = $settings->{llm_api_provider} eq 'DeepSeek' ?
        $self->_call_deepseek_api($settings->{llm_api_key}, $data) :
        $self->_call_openai_api($settings->{llm_api_key}, $data);
    print to_json($result);
}

sub _call_openai_api {
    my ($self, $api_key, $data) = @_;

    my $ua = LWP::UserAgent->new(timeout => 30);

    my $prompt = $self->_build_classification_prompt($data);

    my $request_data = {
        model => "gpt-3.5-turbo",
        messages => [
            {
                role => "system",
                content => "You are an AACR2-only, MARC21-driven cataloging and classification assistant working inside the Koha ILS cataloging interface. Provide Library of Congress Classification (LCC) classmarks, full call numbers, and LCSH suggestions only. Consider dependencies between AACR2-required fields when proposing punctuation or MARC placements."
            },
            {
                role => "user",
                content => $prompt
            }
        ],
        max_tokens => 800,
        temperature => 0.3
    };

    my $request = HTTP::Request->new(
        'POST',
        'https://api.openai.com/v1/chat/completions',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
        ],
        to_json($request_data)
    );

    my $response = $ua->request($request);

    if ($response->is_success) {
        my $result = from_json($response->content);
        return $self->_parse_openai_response($result);
    } else {
        return { error => "OpenAI API error: " . $response->status_line };
    }
}

sub _call_deepseek_api {
    my ($self, $api_key, $data) = @_;

    my $ua = LWP::UserAgent->new(timeout => 30);

    my $prompt = $self->_build_classification_prompt($data);

    my $request_data = {
        model => "deepseek-chat",
        messages => [
            {
                role => "system",
                content => "You are an AACR2-only, MARC21-driven cataloging and classification assistant working inside the Koha ILS cataloging interface. Provide Library of Congress Classification (LCC) classmarks, full call numbers, and LCSH suggestions only. Consider dependencies between AACR2-required fields when proposing punctuation or MARC placements."
            },
            {
                role => "user",
                content => $prompt
            }
        ],
        max_tokens => 800,
        temperature => 0.3
    };

    my $request = HTTP::Request->new(
        'POST',
        'https://api.deepseek.com/v1/chat/completions',
        [
            'Authorization' => "Bearer $api_key",
            'Content-Type' => 'application/json',
        ],
        to_json($request_data)
    );

    my $response = $ua->request($request);

    if ($response->is_success) {
        my $result = from_json($response->content);
        return $self->_parse_openai_response($result); # DeepSeek response format is compatible
    } else {
        return { error => "DeepSeek API error: " . $response->status_line };
    }
}

sub _build_classification_prompt {
    my ($self, $data) = @_;

    my $text = "";
    for my $field (qw(100a 110a 245a 245b 245c 250a 260a 260b 260c 300a 300b 300c 490a 520a 650a 651a)) {
        if ($data->{$field}) {
            $text .= "$field: $data->{$field}\n";
        }
    }

    return qq{
You are assisting an original cataloger in Koha using AACR2-only, MARC21-only practices. Consider how AACR2-required and inter-dependent fields (1XX/245/250/260-264/300/490/5XX/6XX) interact. Provide:
1. Subject headings in LCSH form (as strings).
2. Library of Congress Classification ONLY (no DDC) and a complete LCC call number string.
3. The MARC21 tags/subfields you touched (list of codes such as 245a, 650a, 651a).
4. A brief AACR2 punctuation reminder for critical fields.
Return JSON with keys: subjects (array), lcc (string), call_number (string), marc_fields (array), notes (string).
Bibliographic data:
$text
    };
}

sub _parse_openai_response {
    my ($self, $response) = @_;

    my $content = $response->{choices}->[0]->{message}->{content} || '';

    # Try to extract JSON from response
    if ($content =~ /\{.*\}/s) {
        my ($json_str) = $content =~ /(\{.*\})/s;
        try {
            return from_json($json_str);
        } catch {
            # Fall back to parsing
        };
    }

    # Fallback parsing
    return {
        subjects => [],
        lcc => '',
        call_number => '',
        marc_fields => [],
        notes => '',
        raw_response => $content
    };
}

sub intranet_js {
    my ($self) = @_;
    return try {
        my $raw_settings = $self->retrieve_data('settings') || '{}';
        warn "AutoPunctuation raw settings: $raw_settings";
        my $settings = from_json($raw_settings);
        warn "AutoPunctuation parsed settings: " . Dumper($settings);
        return '' unless $settings->{enabled};
        my $script_name = $ENV{SCRIPT_NAME} || '';
        return '' unless $script_name =~ m{/cataloguing/};
        my $js_content = $self->_read_file('js/auto-punctuation.js');
        return '' unless $js_content;
        # Precompute values to avoid concatenation issues
        my $enabled = $settings->{enabled} ? 'true' : 'false';
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
        my $api_provider = $settings->{llm_api_provider} || 'OpenAI';
        my $api_key = $settings->{llm_api_key} || '';
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
        $api_key =~ s/"/\\"/g;
        $last_updated =~ s/"/\\"/g;
        $cataloging_standard =~ s/"/\\"/g;
        $api_provider =~ s/"/\\"/g;
        warn "AutoPunctuation precomputed values: enabled=$enabled, standard=$cataloging_standard, debug=$debug_mode, provider=$api_provider";
        return qq{
            <script type="text/javascript">
                // AutoPunctuation Plugin v$VERSION
                (function() {
                    if (typeof window.AutoPunctuation !== 'undefined') {
                        console.warn('AutoPunctuation already loaded, skipping...');
                        return;
                    }
                    window.AutoPunctuationSettings = {
                        enabled: $enabled,
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
                        llmApiProvider: "$api_provider",
                        llmApiKey: "$api_key",
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
