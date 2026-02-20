package Koha::Plugin::Cataloging::AutoPunctuation::Rules;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;
use Scalar::Util qw(looks_like_number);

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
sub _regex_too_complex {
    my ($self, $pattern) = @_;
    return 0 unless defined $pattern;
    return 1 if length($pattern) > 120;
    return 1 if $pattern =~ /\([^)]*(?:\+|\*|\{\d+,?\d*\})[^)]*\)(?:\+|\*|\?|\{\d+,?\d*\})/;
    return 1 if $pattern =~ /\.\*(?:\+|\*)/;
    return 0;
}
sub _validate_regex_pattern {
    my ($self, $pattern, $label) = @_;
    return '' unless defined $pattern && $pattern ne '';
    return "$label regex is too long or complex." if $self->_regex_too_complex($pattern);
    my $ok = 0;
    try {
        qr/$pattern/;
        $ok = 1;
    } catch {
        $ok = 0;
    };
    return $ok ? '' : "$label regex is invalid.";
}
sub _validate_custom_rules {
    my ($self, $custom_rules) = @_;
    my @errors;
    return \@errors unless $custom_rules;
    if (ref $custom_rules ne 'HASH') {
        push @errors, 'Custom rules must be a JSON object.';
        return \@errors;
    }
    return \@errors unless %{$custom_rules};
    if ($custom_rules->{AACR2} && ref $custom_rules->{AACR2} eq 'HASH') {
        push @errors, 'Legacy AACR2 maps are no longer supported. Use {"rules":[...]} instead.';
        return \@errors;
    }
    if (exists $custom_rules->{rules} && ref $custom_rules->{rules} ne 'ARRAY') {
        push @errors, 'Custom rules "rules" must be an array.';
        return \@errors;
    }
    if ($custom_rules->{rules} && ref $custom_rules->{rules} eq 'ARRAY') {
        my %valid_check_types = map { $_ => 1 } qw(
            punctuation separator no_terminal_punctuation spacing normalize_punctuation fixed_field
        );
        my %valid_severities = map { $_ => 1 } qw(ERROR WARNING INFO);
        my %valid_suffix_modes = map { $_ => 1 } qw(always conditional_following when_following when_last);
        my %valid_prefix_modes = map { $_ => 1 } qw(always conditional_preceding when_preceding when_first);
        my %valid_repeat = map { $_ => 1 } qw(all first_only last_only);
        my $array_of_strings = sub {
            my ($value) = @_;
            return 0 unless ref $value eq 'ARRAY';
            return scalar grep { !defined $_ || ref $_ } @{$value} ? 0 : 1;
        };
        for my $rule (@{ $custom_rules->{rules} }) {
            unless (ref $rule eq 'HASH') {
                push @errors, 'Each rule must be an object.';
                next;
            }
            my $id = $rule->{id} || '(missing id)';
            push @errors, "Rule $id must include tag or tag_pattern." unless $rule->{tag} || $rule->{tag_pattern};
            push @errors, "Rule $id must include subfields or subfield_pattern." unless $rule->{subfields} || $rule->{subfield_pattern};
            push @errors, "Rule $id must include checks array." unless $rule->{checks} && ref $rule->{checks} eq 'ARRAY';
            if ($rule->{tag_pattern}) {
                my $msg = $self->_validate_regex_pattern($rule->{tag_pattern}, "Rule $id tag_pattern");
                push @errors, $msg if $msg;
            }
            if ($rule->{subfield_pattern}) {
                my $msg = $self->_validate_regex_pattern($rule->{subfield_pattern}, "Rule $id subfield_pattern");
                push @errors, $msg if $msg;
            }
            if ($rule->{subfields} && ref $rule->{subfields} ne 'ARRAY') {
                push @errors, "Rule $id subfields must be an array.";
            }
            for my $list_key (qw(requires_subfields forbids_subfields when_following_subfields when_preceding_subfields end_in end_not_in)) {
                if (exists $rule->{$list_key} && !$array_of_strings->($rule->{$list_key})) {
                    push @errors, "Rule $id $list_key must be an array of strings.";
                }
            }
            for my $single_or_list (qw(next_subfield_is previous_subfield_is)) {
                if (exists $rule->{$single_or_list}) {
                    my $value = $rule->{$single_or_list};
                    if (ref $value && !$array_of_strings->($value)) {
                        push @errors, "Rule $id $single_or_list must be a string or array of strings.";
                    }
                }
            }
            if ($rule->{repeat_policy} && !$valid_repeat{$rule->{repeat_policy}}) {
                push @errors, "Rule $id repeat_policy must be one of: all, first_only, last_only.";
            }
            if ($rule->{checks} && ref $rule->{checks} eq 'ARRAY') {
                for my $idx (0 .. $#{ $rule->{checks} }) {
                    my $check = $rule->{checks}[$idx];
                    unless (ref $check eq 'HASH') {
                        push @errors, "Rule $id check #$idx must be an object.";
                        next;
                    }
                    my $type = $check->{type} || '';
                    if (!$type || !$valid_check_types{$type}) {
                        push @errors, "Rule $id check #$idx has unsupported type \"$type\".";
                    }
                    if ($check->{severity} && !$valid_severities{ $check->{severity} }) {
                        push @errors, "Rule $id check #$idx severity must be ERROR, WARNING, or INFO.";
                    }
                    if ($check->{suffix_mode} && !$valid_suffix_modes{ $check->{suffix_mode} }) {
                        push @errors, "Rule $id check #$idx suffix_mode is invalid.";
                    }
                    if ($check->{prefix_mode} && !$valid_prefix_modes{ $check->{prefix_mode} }) {
                        push @errors, "Rule $id check #$idx prefix_mode is invalid.";
                    }
                    for my $list_key (qw(when_following_subfields when_preceding_subfields end_in end_not_in)) {
                        if (exists $check->{$list_key} && !$array_of_strings->($check->{$list_key})) {
                            push @errors, "Rule $id check #$idx $list_key must be an array of strings.";
                        }
                    }
                }
            }
        }
        return \@errors;
    }
    push @errors, 'Custom rules must be empty or include a rules array.';
    return \@errors;
}
sub _safe_regex {
    my ($self, $pattern) = @_;
    return undef unless defined $pattern && $pattern ne '';
    return undef if $self->_regex_too_complex($pattern);
    my $compiled;
    try {
        $compiled = qr/$pattern/;
    } catch {
        $compiled = undef;
    };
    return $compiled;
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
        my $compiled = $self->_safe_regex($rule->{tag_pattern});
        return 0 unless $compiled && $tag =~ $compiled;
    }
    return 0 unless _indicator_match($ind1 // '', $rule->{ind1});
    return 0 unless _indicator_match($ind2 // '', $rule->{ind2});
    if ($rule->{subfields} && ref $rule->{subfields} eq 'ARRAY') {
        return scalar grep { lc $_ eq lc $subfield } @{ $rule->{subfields} } ? 1 : 0;
    }
    if ($rule->{subfield_pattern}) {
        my $compiled = $self->_safe_regex($rule->{subfield_pattern});
        return 0 unless $compiled;
        return $subfield =~ $compiled ? 1 : 0;
    }
    return 1;
}
sub _rules_match_for_coverage {
    my ($self, $rule, $tag, $subfield) = @_;
    return 0 unless $rule;
    if ($rule->{tag}) {
        return 0 unless $rule->{tag} eq $tag;
    }
    if ($rule->{tag_pattern}) {
        my $compiled = $self->_safe_regex($rule->{tag_pattern});
        return 0 unless $compiled && $tag =~ $compiled;
    }
    if ($rule->{subfields} && ref $rule->{subfields} eq 'ARRAY') {
        return scalar grep { lc $_ eq lc $subfield } @{ $rule->{subfields} } ? 1 : 0;
    }
    if ($rule->{subfield_pattern}) {
        my $compiled = $self->_safe_regex($rule->{subfield_pattern});
        return 0 unless $compiled;
        return $subfield =~ $compiled ? 1 : 0;
    }
    return 1;
}
sub _field_has_subfield {
    my ($self, $field, $code) = @_;
    return 0 unless $field && $field->{subfields} && $code;
    for my $sub (@{ $field->{subfields} }) {
        next unless $sub->{code} && defined $sub->{value} && $sub->{value} ne '';
        return 1 if lc($sub->{code}) eq lc($code);
    }
    return 0;
}
sub _next_subfield_code {
    my ($self, $field, $index) = @_;
    my $subs = $field->{subfields} || [];
    for my $i ($index + 1 .. $#$subs) {
        my $code = $subs->[$i]{code};
        return $code if $code;
    }
    return '';
}
sub _previous_subfield_code {
    my ($self, $field, $index) = @_;
    my $subs = $field->{subfields} || [];
    for (my $i = $index - 1; $i >= 0; $i--) {
        my $code = $subs->[$i]{code};
        return $code if $code;
    }
    return '';
}
sub _repeat_policy_allows {
    my ($self, $field, $subfield, $index, $policy) = @_;
    $policy ||= 'all';
    return 1 if $policy eq 'all';
    my $code = $subfield->{code} || '';
    my $subs = $field->{subfields} || [];
    my @indices = grep { lc(($subs->[$_]{code} || '')) eq lc($code) } (0 .. $#$subs);
    return 1 unless @indices;
    return $index == $indices[0] if $policy eq 'first_only';
    return $index == $indices[-1] if $policy eq 'last_only';
    return 1;
}
sub _rule_applies_to_subfield {
    my ($self, $rule, $field, $subfield, $index) = @_;
    return 0 unless $self->_rules_match($rule, $field->{tag}, $subfield->{code}, $field->{ind1}, $field->{ind2});
    if ($rule->{requires_subfields} && ref $rule->{requires_subfields} eq 'ARRAY') {
        for my $code (@{ $rule->{requires_subfields} }) {
            return 0 unless $self->_field_has_subfield($field, $code);
        }
    }
    if ($rule->{forbids_subfields} && ref $rule->{forbids_subfields} eq 'ARRAY') {
        for my $code (@{ $rule->{forbids_subfields} }) {
            return 0 if $self->_field_has_subfield($field, $code);
        }
    }
    if ($rule->{next_subfield_is}) {
        my @allowed = ref $rule->{next_subfield_is} eq 'ARRAY' ? @{ $rule->{next_subfield_is} } : ($rule->{next_subfield_is});
        my $next = $self->_next_subfield_code($field, $index);
        return 0 unless scalar grep { lc($_) eq lc($next) } @allowed;
    }
    if ($rule->{previous_subfield_is}) {
        my @allowed = ref $rule->{previous_subfield_is} eq 'ARRAY' ? @{ $rule->{previous_subfield_is} } : ($rule->{previous_subfield_is});
        my $prev = $self->_previous_subfield_code($field, $index);
        return 0 unless scalar grep { lc($_) eq lc($prev) } @allowed;
    }
    my $repeat_policy = $rule->{repeat_policy} || 'all';
    return 0 unless $self->_repeat_policy_allows($field, $subfield, $index, $repeat_policy);
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
    my @framework_list = @{$frameworks};
    if (!grep { (($_->{frameworkcode} || '') eq '') } @framework_list) {
        push @framework_list, { frameworkcode => '', frameworktext => 'Default' };
    }
    my @report;
    my @stubs;
    my %summary = (covered => 0, excluded => 0, not_covered => 0, total => 0);
    for my $framework (@framework_list) {
        next unless ref $framework eq 'HASH';
        my $code = defined $framework->{frameworkcode} ? $framework->{frameworkcode} : '';
        my $rows = $dbh->selectall_arrayref(
            "SELECT tagfield, tagsubfield FROM marc_subfield_structure WHERE frameworkcode = ?",
            { Slice => {} },
            $code
        ) || [];
        my @fields;
        my %counts = (total => 0, covered => 0, excluded => 0, not_covered => 0);
        my %seen_fields;
        for my $row (@{$rows}) {
            next unless ref $row eq 'HASH';
            my ($tag, $subfield) = ($row->{tagfield}, $row->{tagsubfield});
            next unless $tag && $subfield;
            my $field_key = lc($tag . '$' . $subfield);
            next if $seen_fields{$field_key}++;
            my $excluded = $self->_is_excluded_field($settings, $tag, $subfield);
            my @matched = grep { $self->_rules_match_for_coverage($_, $tag, $subfield) } @rules;
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
sub _strip_punct_space {
    my ($self, $value) = @_;
    my $text = $value // '';
    $text =~ s/[[:punct:]\s]+//g;
    return $text;
}
sub _punctuation_only_change {
    my ($self, $original, $replacement) = @_;
    return 0 unless defined $original && defined $replacement;
    return $self->_strip_punct_space($original) eq $self->_strip_punct_space($replacement);
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
sub _value_ends_with_any {
    my ($self, $value, $suffixes) = @_;
    return 0 unless defined $value && $suffixes && ref $suffixes eq 'ARRAY';
    for my $suffix (@{$suffixes}) {
        next unless defined $suffix && $suffix ne '';
        return 1 if $value =~ /\Q$suffix\E$/;
    }
    return 0;
}
sub _strip_endings {
    my ($self, $value, $suffixes) = @_;
    my $text = $value // '';
    return $text unless $suffixes && ref $suffixes eq 'ARRAY';
    for my $suffix (@{$suffixes}) {
        next unless defined $suffix && $suffix ne '';
        $text =~ s/\Q$suffix\E$//;
    }
    return $text;
}
sub _normalize_punctuation {
    my ( $self, $text ) = @_;
    return $text unless defined $text;
    $text =~ s/\s+([,;:.!?])/$1/g;
    $text =~ s/([,;:])\s*([^\s\]\)\}])/$1 $2/g;
    return $text;
}

sub _expected_value_for_check {
    my ($self, $check, $field, $subfield) = @_;
    my $value = $subfield->{value} // '';
    if ($check->{replace_ellipses_with_dash}) {
        $value =~ s/\.\s*\.\s*\./-/g;
        $value =~ s/\.{3,}/-/g;
    }
    if ($check->{replace_square_brackets_with_parentheses}) {
        $value =~ s/\[/(/g;
        $value =~ s/\]/)/g;
    }
    if ($check->{end_not_in} && ref $check->{end_not_in} eq 'ARRAY') {
        $value = $self->_strip_endings($value, $check->{end_not_in});
    }
    if ($check->{case_mode}) {
        $value = $self->_apply_case_mode($value, $check->{case_mode});
    }
    my $prefix = $check->{prefix} // '';
    if ($check->{parallel_prefix} && $value =~ /^\s*=/) {
        $value =~ s/^\s*=\s*//;
        $prefix = $check->{parallel_prefix};
    }
    my $suffix = $self->_resolve_suffix($check, $field, $subfield->{code});
    if ($check->{end_in} && ref $check->{end_in} eq 'ARRAY' && $self->_value_ends_with_any($value, $check->{end_in})) {
        $suffix = '';
    }
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
    if ($check->{normalize_punctuation}) {
        $expected = $self->_normalize_punctuation($expected);
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
        my ($leading, $core, $trailing) = $word =~ /^([("\'\[]*)([A-Za-z][A-Za-z'.-]*)([^A-Za-z]*)$/;
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
    my $occurrence = $self->_normalize_occurrence($payload->{occurrence});
    my $subfields = $payload->{subfields} || [];
    for my $i (0 .. $#{$subfields}) {
        my $sub = $subfields->[$i];
        my $code = $sub->{code};
        next if $self->_is_excluded_field($settings, $tag, $code);
        my @matched = grep { $self->_rule_applies_to_subfield($_, $payload, $sub, $i) } @rules;
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
                    $expected = $self->_normalize_punctuation($expected) if $check->{normalize_punctuation};
                } elsif ($check->{type} eq 'no_terminal_punctuation') {
                    $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                } elsif ($check->{type} eq 'spacing') {
                    $expected =~ s/\s{2,}/ /g;
                } elsif ($check->{type} eq 'normalize_punctuation') {
                    $expected = $self->_normalize_punctuation($expected);
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
                    occurrence => $occurrence,
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
        my $occurrence = $self->_normalize_occurrence($field->{occurrence});
        my $subfields = $field->{subfields} || [];
        for my $i (0 .. $#{$subfields}) {
            my $sub = $subfields->[$i];
            next if $self->_is_excluded_field($settings, $tag, $sub->{code});
            my @matched = grep { $self->_rule_applies_to_subfield($_, $field, $sub, $i) } @rules;
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
                    occurrence => $occurrence,
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
                        $expected = $self->_normalize_punctuation($expected) if $check->{normalize_punctuation};
                    } elsif ($check->{type} eq 'no_terminal_punctuation') {
                        $expected =~ s/[[:space:]]*[.,;:!?]+$//;
                    } elsif ($check->{type} eq 'spacing') {
                        $expected =~ s/\s{2,}/ /g;
                    } elsif ($check->{type} eq 'normalize_punctuation') {
                        $expected = $self->_normalize_punctuation($expected);
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
                        occurrence => $occurrence,
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

1;
