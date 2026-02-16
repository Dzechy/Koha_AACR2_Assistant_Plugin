package Koha::Plugin::Cataloging::AutoPunctuation::AI::Guard;

use Modern::Perl;

sub _validate_ai_response_guardrails {
    my ($self, $payload, $result, $pack, $settings) = @_;
    return 'AI response missing request_id.' unless $result->{request_id};
    return 'AI response request_id mismatch.' if $payload->{request_id} ne $result->{request_id};
    my $tag_context = $payload->{tag_context} || {};
    my $target_tag = $tag_context->{tag} || '';
    my $target_occurrence = defined $tag_context->{occurrence}
        ? $self->_normalize_occurrence($tag_context->{occurrence})
        : 0;
    my %subfield_values = map {
        $_->{code} => ($_->{value} // '')
    } grep { $_->{code} } @{ $tag_context->{subfields} || [] };

    my $field_payload = {
        tag => $target_tag,
        ind1 => $tag_context->{ind1} || '',
        ind2 => $tag_context->{ind2} || '',
        subfields => [ map { { code => $_->{code}, value => $_->{value} } } @{ $tag_context->{subfields} || [] } ]
    };
    my $deterministic = $self->_validate_field_with_rules($field_payload, $pack, $settings);
    my %expected_by_code;
    for my $finding (@{ $deterministic->{findings} || [] }) {
        my $patch = $finding->{proposed_fixes} && $finding->{proposed_fixes}[0]
            && $finding->{proposed_fixes}[0]{patch}[0];
        next unless $patch;
        my $code = $patch->{code} || $patch->{subfield} || $finding->{subfield} || '';
        my $value = defined $patch->{value} ? $patch->{value} : ($patch->{replacement_text} // '');
        next unless $code ne '' && defined $value && $value ne '';
        $expected_by_code{$code} = $value;
    }

    for my $finding (@{ $result->{findings} || [] }) {
        my $fixes = $finding->{proposed_fixes} || [];
        next unless ref $fixes eq 'ARRAY';
        for my $fix (@{$fixes}) {
            my $patches = $fix->{patch} || [];
            for my $patch (@{$patches}) {
                return 'Unsupported AI patch operation.' unless ($patch->{op} || '') eq 'replace_subfield';
                return 'AI patch missing tag or subfield.' unless $patch->{tag} && $patch->{subfield};
                return 'AI patch scope violation.' unless $patch->{tag} eq $target_tag;
                my $occurrence = defined $patch->{occurrence} ? $self->_normalize_occurrence($patch->{occurrence}) : 0;
                return 'AI patch occurrence mismatch.' unless $occurrence == $target_occurrence;
                return 'AI patch references unknown subfield.' unless exists $subfield_values{$patch->{subfield}};
                my $original = $patch->{original_text} // '';
                my $replacement = $patch->{replacement_text} // '';
                return 'AI patch original text mismatch.' unless $original eq $subfield_values{$patch->{subfield}};
                return 'AI patch contains non-punctuation edits.'
                    unless $self->_punctuation_only_change($original, $replacement);
                if (exists $expected_by_code{$patch->{subfield}}) {
                    my $expected = $expected_by_code{$patch->{subfield}} // '';
                    return 'AI patch conflicts with deterministic rules.' unless $expected && $replacement eq $expected;
                }
            }
        }
    }
    return '';
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
sub _filter_record_context {
    my ($self, $record_context, $settings, $tag_context) = @_;
    return {} unless $record_context && ref $record_context eq 'HASH';
    my $mode = $settings->{ai_context_mode} || 'tag_only';
    return {} if $mode eq 'tag_only';
    my $fields = $record_context->{fields};
    return {} unless $fields && ref $fields eq 'ARRAY' && @{$fields};
    my $normalized = $self->_normalize_record_context($record_context, 30, 30);
    my @list = @{ $normalized->{fields} || [] };
    return {} unless @list;
    if ($mode eq 'tag_plus_neighbors') {
        my $target_tag = $tag_context && ref $tag_context eq 'HASH' ? ($tag_context->{tag} || '') : '';
        my $target_occ = $tag_context && ref $tag_context eq 'HASH'
            ? $self->_normalize_occurrence($tag_context->{occurrence})
            : 0;
        my $idx = -1;
        for my $i (0 .. $#list) {
            my $field = $list[$i];
            next unless $field && $field->{tag};
            if ($field->{tag} eq $target_tag && $self->_normalize_occurrence($field->{occurrence}) == $target_occ) {
                $idx = $i;
                last;
            }
        }
        my @subset;
        if ($idx >= 0) {
            push @subset, $list[$idx - 1] if $idx > 0;
            push @subset, $list[$idx];
            push @subset, $list[$idx + 1] if $idx < $#list;
        } else {
            @subset = @list[0 .. ($#list < 2 ? $#list : 2)];
        }
        return { fields => \@subset };
    }
    my $max = 30;
    if (@list > $max) {
        return { fields => [ @list[0 .. $max - 1] ] };
    }
    return { fields => \@list };
}
sub _redact_value {
    my ($self, $settings, $tag, $subfield, $value) = @_;
    if ($settings->{ai_redact_856_querystrings} && $tag eq '856' && lc($subfield || '') eq 'u') {
        return '[REDACTED]' if defined $value && $value =~ /[?&]/;
    }
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
sub _is_local_tag {
    my ($tag) = @_;
    return 0 unless defined $tag;
    return $tag =~ /^9\d\d$/ ? 1 : 0;
}

1;
