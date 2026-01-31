package Koha::Plugin::Cataloging::AutoPunctuation::UI;

use Modern::Perl;
use C4::Context;
use CGI;
use JSON qw(to_json from_json);
use Try::Tiny;

sub tool {
    my ( $self, $args ) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $template = $self->get_template({ file => 'tool.tt' });
    my $settings = $self->_load_settings();
    my $update_info = $self->_check_for_updates();
    my $template_settings = { %{$settings} };
    $template_settings->{llm_api_key} = '';
    $template_settings->{openrouter_api_key} = '';
    my $llm_api_key_set = $self->_secret_present($settings->{llm_api_key});
    my $openrouter_api_key_set = $self->_secret_present($settings->{openrouter_api_key});
    my $ai_provider_raw = $settings->{llm_api_provider} || 'OpenRouter';
    my $ai_provider = $ai_provider_raw =~ /openrouter/i ? 'OpenRouter' : 'OpenAI';
    my $ai_model = $self->_selected_model($settings) || '';
    my $ai_ready = ($settings->{ai_enable} && $self->_ai_key_available($settings)) ? 1 : 0;
    $template->param(
        settings => $template_settings,
        update_info => $update_info,
        plugin_repo_url => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        author_linkedin => Koha::Plugin::Cataloging::AutoPunctuation::AUTHOR_LINKEDIN,
        current_version => Koha::Plugin::Cataloging::AutoPunctuation::VERSION,
        llm_api_key_set => $llm_api_key_set,
        openrouter_api_key_set => $openrouter_api_key_set,
        ai_provider => $ai_provider,
        ai_provider_is_openrouter => ($ai_provider eq 'OpenRouter') ? 1 : 0,
        ai_model => $ai_model,
        ai_ready => $ai_ready,
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
    my $saved_successfully = 0;
    my @save_errors;

    if ($cgi->param('save')) {
        unless ($self->_csrf_ok()) {
            push @save_errors, 'Invalid CSRF token. Please reload and try again.';
        }

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
        my $selected_model = $cgi->param('ai_model');
        if (defined $selected_model) {
            $selected_model =~ s/^\s+|\s+$//g;
            $settings->{ai_model} = $selected_model;
        }
        $settings->{ai_timeout} = $cgi->param('ai_timeout') || $settings->{ai_timeout};
        my $max_output_tokens = $cgi->param('ai_max_output_tokens');
        if (defined $max_output_tokens && $max_output_tokens ne '') {
            $settings->{ai_max_output_tokens} = $max_output_tokens;
        } elsif (defined $cgi->param('ai_max_tokens') && $cgi->param('ai_max_tokens') ne '') {
            $settings->{ai_max_output_tokens} = $cgi->param('ai_max_tokens');
        } else {
            $settings->{ai_max_output_tokens} ||= $settings->{ai_max_tokens};
        }
        $settings->{ai_max_tokens} = $settings->{ai_max_output_tokens} || $settings->{ai_max_tokens};
        $settings->{ai_temperature} = defined $cgi->param('ai_temperature') ? $cgi->param('ai_temperature') : $settings->{ai_temperature};
        my $reasoning_effort = lc($cgi->param('ai_reasoning_effort') || $settings->{ai_reasoning_effort} || 'low');
        $reasoning_effort = 'low' if $reasoning_effort !~ /^(none|low|medium|high)$/;
        $settings->{ai_reasoning_effort} = $reasoning_effort;
        $settings->{ai_redaction_rules} = $cgi->param('ai_redaction_rules') || $settings->{ai_redaction_rules};
        $settings->{ai_redact_856_querystrings} = $cgi->param('ai_redact_856_querystrings') ? 1 : 0;
        $settings->{ai_context_mode} = $cgi->param('ai_context_mode') || $settings->{ai_context_mode};
        $settings->{ai_payload_preview} = $cgi->param('ai_payload_preview') ? 1 : 0;
        $settings->{ai_openrouter_response_format} = 0;
        $settings->{ai_rate_limit_per_minute} = $cgi->param('ai_rate_limit_per_minute') || $settings->{ai_rate_limit_per_minute};
        $settings->{ai_cache_ttl_seconds} = $cgi->param('ai_cache_ttl_seconds') || $settings->{ai_cache_ttl_seconds};
        $settings->{ai_cache_max_entries} = $cgi->param('ai_cache_max_entries') || $settings->{ai_cache_max_entries};
        $settings->{ai_retry_count} = $cgi->param('ai_retry_count') || $settings->{ai_retry_count};
        $settings->{ai_circuit_breaker_threshold} = $cgi->param('ai_circuit_breaker_threshold') || $settings->{ai_circuit_breaker_threshold};
        $settings->{ai_circuit_breaker_timeout} = $cgi->param('ai_circuit_breaker_timeout') || $settings->{ai_circuit_breaker_timeout};
        $settings->{ai_circuit_breaker_window_seconds} = $cgi->param('ai_circuit_breaker_window_seconds') || $settings->{ai_circuit_breaker_window_seconds};
        $settings->{ai_circuit_breaker_failure_rate} = $cgi->param('ai_circuit_breaker_failure_rate') || $settings->{ai_circuit_breaker_failure_rate};
        $settings->{ai_circuit_breaker_min_samples} = $cgi->param('ai_circuit_breaker_min_samples') || $settings->{ai_circuit_breaker_min_samples};
        $settings->{ai_confidence_threshold} = defined $cgi->param('ai_confidence_threshold') ? $cgi->param('ai_confidence_threshold') : $settings->{ai_confidence_threshold};
        $settings->{lc_class_target} = $cgi->param('lc_class_target') || $settings->{lc_class_target} || '050$a';
        my $request_mode = $cgi->param('ai_request_mode') || $settings->{ai_request_mode} || 'server';
        $request_mode = lc($request_mode || '');
        if ($request_mode ne 'server') {
            $self->_debug_log($settings, 'Direct AI request mode is disabled; forcing server mode.');
        }
        $settings->{ai_request_mode} = 'server';
        $settings->{llm_api_provider} = $cgi->param('llm_api_provider') || 'OpenRouter';
        my $provider = lc($settings->{llm_api_provider} || 'openrouter');
        my $unified_key = $cgi->param('ai_api_key');
        my $unified_clear = $cgi->param('ai_api_key_clear');
        if (defined $unified_key || $unified_clear) {
            my $target_key = $provider eq 'openrouter' ? 'openrouter_api_key' : 'llm_api_key';
            if ($unified_clear) {
                $settings->{$target_key} = '';
            } elsif (defined $unified_key && $unified_key ne '') {
                my $encrypted = $self->_encrypt_secret($unified_key);
                if (defined $encrypted && $encrypted ne '') {
                    $settings->{$target_key} = $encrypted;
                } else {
                    my $label = $provider eq 'openrouter' ? 'OpenRouter' : 'OpenAI';
                    push @save_errors, $self->_encryption_error_message();
                }
            }
        } else {
            my $new_openai_key = $cgi->param('llm_api_key');
            my $new_openrouter_key = $cgi->param('openrouter_api_key');
            if ($cgi->param('llm_api_key_clear')) {
                $settings->{llm_api_key} = '';
            } elsif (defined $new_openai_key && $new_openai_key ne '') {
                my $encrypted = $self->_encrypt_secret($new_openai_key);
                if (defined $encrypted && $encrypted ne '') {
                    $settings->{llm_api_key} = $encrypted;
                } else {
                    push @save_errors, $self->_encryption_error_message();
                }
            }
            if ($cgi->param('openrouter_api_key_clear')) {
                $settings->{openrouter_api_key} = '';
            } elsif (defined $new_openrouter_key && $new_openrouter_key ne '') {
                my $encrypted = $self->_encrypt_secret($new_openrouter_key);
                if (defined $encrypted && $encrypted ne '') {
                    $settings->{openrouter_api_key} = $encrypted;
                } else {
                    push @save_errors, $self->_encryption_error_message();
                }
            }
        }
        $settings->{llm_api_key} = $self->_migrate_secret($settings->{llm_api_key}, \@save_errors);
        $settings->{openrouter_api_key} = $self->_migrate_secret($settings->{openrouter_api_key}, \@save_errors);
        if ($provider eq 'openrouter') {
            my $model = defined $selected_model ? $selected_model : $settings->{ai_model_openrouter};
            $model = '' unless defined $model;
            $settings->{ai_model_openrouter} = $model;
            $settings->{ai_model} = $model;
        } else {
            my $model = defined $selected_model ? $selected_model : $settings->{ai_model_openai};
            $model = '' unless defined $model;
            $settings->{ai_model_openai} = $model;
            $settings->{ai_model} = $model;
        }
        $settings->{last_updated} = Koha::DateUtils::dt_from_string()->strftime('%Y-%m-%d %H:%M:%S');

        if ($cgi->param('import_rules') && $cgi->param('rules_file')) {
            my $upload = $cgi->upload('rules_file');
            if ($upload) {
                my $content = do { local $/; <$upload> };
                my $parsed;
                try {
                    $parsed = from_json($content);
                } catch {
                    push @save_errors, 'Invalid JSON uploaded for custom rules.';
                };
                if ($parsed) {
                    my $rule_errors = $self->_validate_custom_rules($parsed);
                    if (@{$rule_errors}) {
                        push @save_errors, @{$rule_errors};
                    } else {
                        $settings->{custom_rules} = $content;
                    }
                }
            }
        } else {
            $settings->{custom_rules} = $cgi->param('custom_rules') || $settings->{custom_rules} || '{}';
        }

        if (!@save_errors) {
            try {
                my $parsed_rules = from_json($settings->{custom_rules} || '{}');
                my $rule_errors = $self->_validate_custom_rules($parsed_rules);
                if (@{$rule_errors}) {
                    push @save_errors, @{$rule_errors};
                    $settings->{custom_rules} = $stored_settings->{custom_rules} || '{}';
                }
            } catch {
                push @save_errors, 'Invalid JSON in custom rules. Please fix and try again.';
                $settings->{custom_rules} = $stored_settings->{custom_rules} || '{}';
            };
        }

        if (!@save_errors) {
            $self->store_data({ settings => to_json($settings) });
            $saved_successfully = 1;
        }

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
    my $template_settings = { %{$settings} };
    $template_settings->{llm_api_key} = '';
    $template_settings->{openrouter_api_key} = '';
    my $llm_api_key_set = $self->_secret_present($settings->{llm_api_key});
    my $openrouter_api_key_set = $self->_secret_present($settings->{openrouter_api_key});
    my $encryption_ready = $self->_encryption_secret() ? 1 : 0;
    my $coverage = $self->_build_coverage_report($settings);
    my $update_info = $self->_check_for_updates();
    my $csrf_token = '';
    try {
        my $session_id = $self->_session_id();
        if ($session_id) {
            $csrf_token = Koha::Token->new->generate_csrf({ session_id => $session_id }) || '';
        }
    } catch {
        $csrf_token = '';
    };
    my $model_defaults_json = to_json({
        openai => $settings->{ai_model_openai} || '',
        openrouter => $settings->{ai_model_openrouter} || '',
        fallback => $settings->{ai_model} || ''
    });
    $model_defaults_json =~ s{</}{<\\/}g;
    $template->param(
        settings => $template_settings,
        users => \@users,
        coverage_report => $coverage->{report} || [],
        coverage_summary => $coverage->{summary} || {},
        coverage_stubs_json => $coverage->{stubs_json} || '[]',
        rules_version => $coverage->{rules_version} || '',
        update_info => $update_info,
        plugin_repo_url => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
        author_linkedin => Koha::Plugin::Cataloging::AutoPunctuation::AUTHOR_LINKEDIN,
        current_version => Koha::Plugin::Cataloging::AutoPunctuation::VERSION,
        llm_api_key_set => $llm_api_key_set,
        openrouter_api_key_set => $openrouter_api_key_set,
        encryption_ready => $encryption_ready,
        saved_successfully => $saved_successfully,
        save_errors => \@save_errors,
        csrf_token => $csrf_token,
        model_defaults_json => $model_defaults_json,
        CLASS => ref($self),
        METHOD => 'configure',
    );
    print $cgi->header(-type => 'text/html', -charset => 'utf-8');
    print $template->output();
}
sub intranet_js {
    my ($self) = @_;
    return try {
        my $settings = $self->_load_settings();
        warn "AutoPunctuation settings loaded (debug mode enabled)." if $settings->{debug_mode};
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
            'js/ai_text_extract.js',
            'js/api_client_core.js',
            'js/api_client_prompt.js',
            'js/api_client_guardrails.js',
            'js/api_client_response.js',
            'js/api_client.js',
            'js/cuttersanborn_data.js',
            'js/cutter_sanborn.js',
            'js/marc_intellisense_ui_core.js',
            'js/marc_intellisense_ui_forms.js',
            'js/marc_intellisense_ui_ai.js',
            'js/marc_intellisense_ui_guide.js',
            'js/marc_intellisense_ui_events.js',
            'js/marc_intellisense_ui.js',
            'js/auto-punctuation.js'
        );
        my $js_content = join("\n", map { $self->_read_file($_) || '' } @js_files);
        return '' unless $js_content;
        my $rules_pack = $self->_load_rules_pack();
        my $rules_pack_json = to_json($rules_pack);
        $rules_pack_json =~ s{</}{<\\/}g;
        my $framework_fields_json = to_json($framework_fields || []);
        my $schemas = {
            ai_request => $self->_load_schema('ai_request.json'),
            ai_response => $self->_load_schema('ai_response.json'),
            validate_field_request => $self->_load_schema('validate_field_request.json'),
            validate_record_request => $self->_load_schema('validate_record_request.json'),
        };
        my $schemas_json = to_json($schemas);
        $schemas_json =~ s{</}{<\\/}g;
        my $ai_request_mode = $settings->{ai_request_mode} || 'server';
        $ai_request_mode = lc($ai_request_mode || '');
        if ($ai_request_mode ne 'server') {
            $self->_debug_log($settings, 'Direct AI request mode is disabled; forcing server mode for intranet JS.');
        }
        $ai_request_mode = 'server';
        my $ai_configured = ($settings->{ai_enable} && $self->_ai_key_available($settings)) ? 1 : 0;
        my $plugin_base_path = "/cgi-bin/koha/plugins/run.pl?class=" . ref($self);
        my $plugin_tool_path = $plugin_base_path . '&method=tool';
        my $plugin_configure_path = $plugin_base_path . '&method=configure';
        my $current_user_id = '';
        my $userenv = C4::Context->userenv;
        if ($userenv && ref $userenv eq 'HASH') {
            $current_user_id = $userenv->{userid} || $userenv->{user} || '';
        }
        $current_user_id ||= $cgi->remote_user || $ENV{REMOTE_USER} || '';
        my $settings_blob = {
            enabled => $settings->{enabled} ? JSON::true : JSON::false,
            autoApplyPunctuation => $settings->{auto_apply_punctuation} ? JSON::true : JSON::false,
            catalogingStandard => $settings->{default_standard} || 'AACR2',
            debugMode => $settings->{debug_mode} ? JSON::true : JSON::false,
            enableGuide => $settings->{enable_guide} ? JSON::true : JSON::false,
            guideUsers => $settings->{guide_users} || '',
            guideExclusionList => $settings->{guide_exclusion_list} || '',
            customRules => $settings->{custom_rules} || '{}',
            internshipMode => $settings->{internship_mode} ? JSON::true : JSON::false,
            internshipUsers => $settings->{internship_users} || '',
            internshipExclusionList => $settings->{internship_exclusion_list} || '',
            enforceAacr2Guardrails => $settings->{enforce_aacr2_guardrails} ? JSON::true : JSON::false,
            enableLiveValidation => $settings->{enable_live_validation} ? JSON::true : JSON::false,
            blockSaveOnError => $settings->{block_save_on_error} ? JSON::true : JSON::false,
            requiredFields => $settings->{required_fields} || '',
            excludedTags => $settings->{excluded_tags} || '',
            strictCoverageMode => $settings->{strict_coverage_mode} ? JSON::true : JSON::false,
            enableLocalFields => $settings->{enable_local_fields} ? JSON::true : JSON::false,
            localFieldsAllowlist => $settings->{local_fields_allowlist} || '',
            aiEnable => $settings->{ai_enable} ? JSON::true : JSON::false,
            aiPunctuationExplain => $settings->{ai_punctuation_explain} ? JSON::true : JSON::false,
            aiSubjectGuidance => $settings->{ai_subject_guidance} ? JSON::true : JSON::false,
            aiCallNumberGuidance => $settings->{ai_callnumber_guidance} ? JSON::true : JSON::false,
            aiModel => $self->_selected_model($settings) || '',
            aiConfigured => $ai_configured ? JSON::true : JSON::false,
            aiConfidenceThreshold => $settings->{ai_confidence_threshold} || 0.85,
            aiContextMode => $settings->{ai_context_mode} || 'tag_only',
            aiPayloadPreview => $settings->{ai_payload_preview} ? JSON::true : JSON::false,
            aiRedactionRules => $settings->{ai_redaction_rules} || '',
            aiRedact856Querystrings => $settings->{ai_redact_856_querystrings} ? JSON::true : JSON::false,
            llmApiProvider => $settings->{llm_api_provider} || 'OpenRouter',
            aiPromptVersion => Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION,
            aiTimeout => $settings->{ai_timeout} || 30,
            aiMaxTokens => $settings->{ai_max_output_tokens} || $settings->{ai_max_tokens} || 1024,
            aiTemperature => defined $settings->{ai_temperature} ? ($settings->{ai_temperature} + 0) : 0,
            aiReasoningEffort => $settings->{ai_reasoning_effort} || 'low',
            aiRetryCount => $settings->{ai_retry_count} || 2,
            aiRequestMode => $ai_request_mode,
            lcClassTarget => $settings->{lc_class_target} || '050$a',
            pluginRepoUrl => Koha::Plugin::Cataloging::AutoPunctuation::PLUGIN_REPO_URL,
            frameworkCode => $frameworkcode,
            frameworkFields => $framework_fields,
            last_updated => $settings->{last_updated} || '',
            currentUserId => $current_user_id,
            pluginPath => $plugin_base_path,
            pluginBasePath => $plugin_base_path,
            pluginToolPath => $plugin_tool_path,
            pluginConfigurePath => $plugin_configure_path
        };
        my $settings_json = to_json($settings_blob);
        $settings_json =~ s{</}{<\\/}g;
        warn "AutoPunctuation settings loaded for JS injection." if $settings->{debug_mode};
        return qq{
            <script type="application/json" id="aacr2-settings-data">$settings_json</script>
            <script type="text/javascript">
                // AutoPunctuation Plugin v@{[Koha::Plugin::Cataloging::AutoPunctuation::VERSION]}
                (function() {
                    if (typeof window.AutoPunctuation !== 'undefined') {
                        console.warn('AutoPunctuation already loaded, skipping...');
                        return;
                    }
                    var settingsEl = document.getElementById('aacr2-settings-data');
                    var parsedSettings = {};
                    if (settingsEl) {
                        try {
                            parsedSettings = JSON.parse(settingsEl.textContent || settingsEl.innerText || '{}');
                        } catch (err) {
                            console.warn('AACR2 settings JSON parse failed.', err);
                        }
                    }
                    window.AACR2RulePack = $rules_pack_json;
                    window.AACR2Schemas = $schemas_json;
                    window.AutoPunctuationSettings = parsedSettings || {};
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

1;
