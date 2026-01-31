package Koha::Plugin::Cataloging::AutoPunctuation::AI::Parse;

use Modern::Perl;
use JSON qw(from_json);
use Try::Tiny;
use Scalar::Util qw(looks_like_number);

sub _normalize_json_text {
    my ($self, $content) = @_;
    return '' unless defined $content;
    my $text = $content;
    $text =~ s/^\s+|\s+$//g;
    if ($text =~ /^```(?:json)?\s*(.*?)\s*```$/s) {
        $text = $1;
        $text =~ s/^\s+|\s+$//g;
    }
    return $text;
}
sub _try_parse_json_text {
    my ($self, $content) = @_;
    my $text = $self->_normalize_json_text($content);
    return undef unless $text;
    my $parsed;
    try {
        $parsed = from_json($text);
    } catch {
        $parsed = undef;
    };
    if (!$parsed) {
        my $candidate = '';
        if ($text =~ /(\{.*\})/s) {
            $candidate = $1;
        } elsif ($text =~ /(\[.*\])/s) {
            $candidate = $1;
        }
        if ($candidate) {
            try {
                $parsed = from_json($candidate);
            } catch {
                $parsed = undef;
            };
        }
    }
    return $parsed;
}
sub _normalize_lc_text {
    my ($self, $text) = @_;
    return '' unless defined $text;
    my $normalized = $text;
    $normalized =~ s/[\x{2012}\x{2013}\x{2014}\x{2212}]/-/g;
    $normalized =~ s/\s+/ /g;
    return $normalized;
}
sub _format_lc_call_number {
    my ($self, $class, $number) = @_;
    return '' unless $class && $number;
    return uc($class) . ' ' . $number;
}
sub _rank_lc_candidates {
    my ($self, $text, $candidates) = @_;
    return [] unless $text && $candidates && ref $candidates eq 'ARRAY';
    my $lower = lc($text);
    my @keywords = (
        'lc classification',
        'lc class',
        'lcc',
        'lc',
        'classification',
        'call number',
        'call no'
    );
    my @keyword_positions;
    for my $keyword (@keywords) {
        my $pos = 0;
        while (1) {
            my $idx = index($lower, $keyword, $pos);
            last if $idx < 0;
            push @keyword_positions, $idx;
            $pos = $idx + length($keyword);
        }
    }
    my @ranked;
    for my $cand (@{$candidates}) {
        my $score = 0;
        my $start = $cand->{start} // 0;
        for my $pos (@keyword_positions) {
            my $distance = abs($start - $pos);
            $score += 3 if $distance <= 80;
            $score += 1 if $distance > 80 && $distance <= 200;
        }
        my $before = rindex($text, '{', $start);
        my $after = index($text, '}', $start);
        $score += 1 if $before >= 0 && $after > $start && ($after - $before) <= 400;
        push @ranked, { %{$cand}, score => $score };
    }
    @ranked = sort {
        $b->{score} <=> $a->{score}
            || $a->{start} <=> $b->{start}
    } @ranked;
    return \@ranked;
}
sub _extract_lc_call_numbers {
    my ($self, $text, $settings) = @_;
    return [] unless defined $text && $text ne '';
    my $normalized = $self->_normalize_lc_text($text);
    my @candidates;
    my @spans;
    while ($normalized =~ /\b([A-Z]{1,3})\s*(\d{1,4}(?:\.\d+)?)\s*-\s*(?:([A-Z]{1,3})\s*)?(\d{1,4}(?:\.\d+)?)\b/ig) {
        push @spans, [ $-[0], $+[0] ];
    }
    if (@spans) {
        for my $span (@spans) {
            my ($start, $end) = @{$span};
            substr($normalized, $start, $end - $start, ' ' x ($end - $start));
        }
    }
    while ($normalized =~ /\b([A-Z]{1,3})\s*(\d{1,4}(?:\.\d+)?)\b/ig) {
        my ($class, $number) = ($1, $2);
        my $value = $self->_format_lc_call_number($class, $number);
        push @candidates, { value => $value, start => $-[0] } if $value;
    }
    my $ranked = $self->_rank_lc_candidates($text, \@candidates);
    my @ordered;
    my %seen;
    for my $cand (@{$ranked}) {
        next unless $cand->{value};
        next if $seen{$cand->{value}}++;
        push @ordered, $cand->{value};
    }
    return \@ordered;
}
sub _extract_confidence_percent_from_text {
    my ($self, $text) = @_;
    return undef unless defined $text && $text ne '';
    my $value;
    if ($text =~ /confidence(?:\s*percent|\s*score)?\s*[:=]?\s*([0-9]{1,3}(?:\.\d+)?)(\s*%?)/i) {
        $value = $1;
        my $has_percent = ($2 || '') =~ /%/;
        if (!$has_percent && $value <= 1) {
            $value *= 100;
        }
    } elsif ($text =~ /([0-9]{1,3}(?:\.\d+)?)\s*%\s*confidence/i) {
        $value = $1;
    } elsif ($text =~ /confidence\s*[:=]?\s*([01](?:\.\d+)?)/i) {
        $value = $1 * 100 if $1 <= 1;
    } elsif ($text =~ /confidence\s*[:=]?\s*(\d{1,3})\s*\/\s*100/i) {
        $value = $1;
    }
    return undef unless defined $value;
    $value = 0 + $value;
    $value = 0 if $value < 0;
    $value = 100 if $value > 100;
    return $value;
}
sub _normalize_subject_heading_text {
    my ($self, $value) = @_;
    return '' unless defined $value;
    my $text = $value;
    $text =~ s/\s*--\s*/ -- /g;
    $text =~ s/\s{2,}/ /g;
    $text =~ s/\s*--\s*$//g;
    $text =~ s/^\s+|\s+$//g;
    return $text;
}
sub _classification_range_message {
    my ($self, $text) = @_;
    return '' unless defined $text && $text ne '';
    my $normalized = $self->_normalize_lc_text($text);
    return 'Classification ranges are not allowed. Provide a single class number.'
        if $normalized =~ /\b[A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?\s*-\s*(?:[A-Z]{1,3}\s*)?\d{1,4}(?:\.\d+)?\b/;
    return 'Classification ranges are not allowed. Provide a single class number.'
        if $normalized =~ /\b\d{1,4}(?:\.\d+)?\s*-\s*\d{1,4}(?:\.\d+)?\b/;
    return '';
}
sub _is_chronological_subdivision {
    my ($self, $text) = @_;
    return 0 unless defined $text && $text ne '';
    return 1 if $text =~ /\b\d{3,4}\b/;
    return 1 if $text =~ /\b\d{1,2}(st|nd|rd|th)\s+century\b/i;
    return 0;
}
sub _normalize_subject_object {
    my ($self, $subject) = @_;
    return undef unless $subject && ref $subject eq 'HASH';
    my $tag = $subject->{tag} || '650';
    my $ind1 = defined $subject->{ind1} ? $subject->{ind1} : ' ';
    my $ind2 = defined $subject->{ind2} ? $subject->{ind2} : '0';
    my $subfields = $subject->{subfields} || {};
    my $a = $subfields->{a} // '';
    $a =~ s/^\s+|\s+$//g if defined $a;
    return undef unless defined $a && $a ne '';
    my $ensure_array = sub {
        my ($value) = @_;
        return [] unless defined $value;
        return [ grep { defined $_ && $_ ne '' } @{$value} ] if ref $value eq 'ARRAY';
        return [ grep { $_ ne '' } ($value) ];
    };
    my $x = $ensure_array->($subfields->{x});
    my $y = $ensure_array->($subfields->{y});
    my $z = $ensure_array->($subfields->{z});
    my $v = $ensure_array->($subfields->{v});
    return {
        tag => $tag,
        ind1 => $ind1,
        ind2 => $ind2,
        subfields => {
            a => $a,
            x => $x,
            y => $y,
            z => $z,
            v => $v
        }
    };
}
sub _subject_object_from_text {
    my ($self, $text) = @_;
    return undef unless defined $text && $text ne '';
    my $value = $text;
    $value =~ s/^\s+|\s+$//g;
    return undef unless $value ne '';
    my $tag = '650';
    my $ind1 = ' ';
    my $ind2 = '0';
    if ($value =~ /^(\d{3})\s*([0-9 ])\s*([0-9 ])\s*[:\-]?\s*(.+)$/) {
        $tag = $1;
        $ind1 = $2;
        $ind2 = $3;
        $value = $4;
        $value =~ s/^\s+|\s+$//g;
    }
    my @parts = split(/\s*--\s*/, $value);
    @parts = map { s/^\s+|\s+$//gr } @parts;
    @parts = grep { $_ ne '' } @parts;
    return undef unless @parts;
    my $a = shift @parts;
    my @x;
    my @y;
    my @z;
    my @v;
    for my $part (@parts) {
        next unless defined $part && $part ne '';
        if ($self->_is_chronological_subdivision($part)) {
            push @y, $part;
        } else {
            push @x, $part;
        }
    }
    return {
        tag => $tag,
        ind1 => $ind1,
        ind2 => $ind2,
        subfields => {
            a => $a,
            x => \@x,
            y => \@y,
            z => \@z,
            v => \@v
        }
    };
}
sub _subjects_from_text_list {
    my ($self, $items) = @_;
    return [] unless $items && ref $items eq 'ARRAY';
    my @subjects;
    for my $item (@{$items}) {
        next unless defined $item && $item ne '';
        my $subject = $self->_subject_object_from_text($item);
        push @subjects, $subject if $subject;
    }
    return \@subjects;
}
sub _dedupe_case_insensitive {
    my ($self, $items) = @_;
    return [] unless $items && ref $items eq 'ARRAY';
    my %seen;
    my @deduped;
    for my $item (@{$items}) {
        next unless defined $item && $item ne '';
        my $key = lc($item);
        next if $seen{$key}++;
        push @deduped, $item;
    }
    return \@deduped;
}
sub _extract_subject_headings_from_text {
    my ($self, $text) = @_;
    return [] unless defined $text && $text ne '';
    my @segments;
    my @lines = split(/\r?\n/, $text);
    my $capture = 0;
    for my $line (@lines) {
        my $trim = $line;
        $trim =~ s/^\s*[-*\x{2022}\x{2023}\x{25E6}\x{2043}\x{2219}]+\s*//g;
        if ($trim =~ /\b(subjects?|subject headings?|lcsh)\b\s*[:\-]\s*(.+)/i) {
            push @segments, $2 if defined $2 && $2 ne '';
            $capture = 1;
            next;
        }
        if ($capture) {
            last if $trim =~ /^\s*$/;
            if ($trim =~ /\b(classification|call number|confidence)\b/i) {
                $capture = 0;
                next;
            }
            push @segments, $trim if $trim ne '';
        }
    }
    if (!@segments && $text =~ /\b(subjects?|subject headings?|lcsh)\b\s*[:\-]\s*(.+)$/is) {
        push @segments, $2 if defined $2 && $2 ne '';
    }
    my $joined = join("\n", @segments);
    $joined =~ s/\b(classification|call number|confidence)\b.*$//is;
    my @parts = split(/[;\n\|]+/, $joined);
    my @expanded;
    for my $part (@parts) {
        my $value = $part // '';
        $value =~ s/^\s+|\s+$//g;
        next unless $value ne '';
        if ($value =~ /--/) {
            push @expanded, $value;
            next;
        }
        my $comma_count = () = $value =~ /,/g;
        if ($comma_count >= 2) {
            push @expanded, grep { $_ ne '' } map { s/^\s+|\s+$//gr } split(/\s*,\s*/, $value);
            next;
        }
        if ($comma_count == 1) {
            my @pieces = split(/\s*,\s*/, $value);
            if (@pieces == 2 && $pieces[0] !~ /\s/ && $pieces[1] !~ /\s/) {
                push @expanded, grep { $_ ne '' } @pieces;
                next;
            }
        }
        push @expanded, $value;
    }
    my @normalized = map { $self->_normalize_subject_heading_text($_) } @expanded;
    @normalized = grep { defined $_ && $_ ne '' } @normalized;
    my $deduped = $self->_dedupe_case_insensitive(\@normalized);
    return $deduped;
}
sub _extract_classification_from_text {
    my ($self, $text, $settings) = @_;
    return '' unless defined $text && $text ne '';
    if ($text =~ /\b(classification|call number|lc class(?:ification)?|lcc)\b\s*[:\-]\s*([^\r\n]+)/i) {
        my $segment = $2 // '';
        my $candidates = $self->_extract_lc_call_numbers($segment, $settings);
        return $candidates->[0] if $candidates && @{$candidates};
    }
    if ($text =~ /\b(lc)\b\s*[:\-]\s*([A-Z]{1,3}\s*\d{1,4}(?:\.\d+)?)/i) {
        my $segment = $2 // '';
        my $candidates = $self->_extract_lc_call_numbers($segment, $settings);
        return $candidates->[0] if $candidates && @{$candidates};
    }
    my $candidates = $self->_extract_lc_call_numbers($text, $settings);
    return $candidates->[0] if $candidates && @{$candidates};
    return '';
}
sub _extract_cataloging_suggestions_from_text {
    my ($self, $text, $settings) = @_;
    return {
        classification => $self->_extract_classification_from_text($text, $settings),
        subjects => $self->_extract_subject_headings_from_text($text),
        confidence_percent => $self->_extract_confidence_percent_from_text($text)
    };
}
sub _parse_lc_target {
    my ($self, $target) = @_;
    return ('', '') unless defined $target && $target ne '';
    if ($target =~ /^(\d{3})\s*\$\s*([a-z0-9])$/i) {
        return ($1, lc($2));
    }
    if ($target =~ /^(\d{3})([a-z0-9])$/i) {
        return ($1, lc($2));
    }
    return ('', '');
}
sub _build_degraded_ai_response {
    my ($self, $payload, $raw_text, $settings, $options) = @_;
    return undef unless $payload && $raw_text;
    my $features = $payload->{features} || {};
    return undef unless ($features->{call_number_guidance} || $features->{subject_guidance});
    my $extracted = $self->_extract_cataloging_suggestions_from_text($raw_text, $settings);
    my $selected = $extracted->{classification} || '';
    my $range_message = '';
    if ($raw_text =~ /\b(classification|call number|lc class(?:ification)?|lcc)\b\s*[:\-]\s*([^\r\n]+)/i) {
        $range_message = $self->_classification_range_message($2);
    }
    $range_message ||= $self->_classification_range_message($selected);
    $selected = '' if $range_message;
    my ($target_tag, $target_code) = $self->_parse_lc_target($settings->{lc_class_target} || '050$a');
    my $target_excluded = $target_tag && $target_code
        ? $self->_is_excluded_field($settings, $target_tag, $target_code)
        : 0;
    my @findings;
    my @errors;
    my $extraction_source = $options && $options->{extraction_source} ? $options->{extraction_source} : 'raw_text';
    if ($features->{call_number_guidance}) {
        my $message = $selected || '';
        my $rationale = $extraction_source eq 'plain_text'
            ? 'Extracted from AI text output.'
            : 'AI returned non-structured output; extracted LC classification candidate.';
        if ($target_excluded && $message) {
            $rationale .= " Target $target_tag\$$target_code is excluded.";
        }
        push @findings, {
            severity => 'INFO',
            code => 'AI_CLASSIFICATION',
            message => $message,
            rationale => $rationale,
            proposed_fixes => [],
            confidence => 0.2
        };
    }
    if ($range_message) {
        push @errors, {
            code => 'CLASSIFICATION_RANGE',
            field => 'classification',
            message => $range_message
        };
    }
    if ($features->{subject_guidance}) {
        my $subjects_text = '';
        if ($extracted->{subjects} && ref $extracted->{subjects} eq 'ARRAY' && @{$extracted->{subjects}}) {
            $subjects_text = join('; ', @{ $extracted->{subjects} });
        }
        push @findings, {
            severity => 'INFO',
            code => 'AI_SUBJECTS',
            message => $subjects_text,
            rationale => $extraction_source eq 'plain_text'
                ? 'Extracted from AI text output.'
                : 'AI returned non-structured output; extracted subject headings.',
            proposed_fixes => [],
            confidence => 0.2
        };
    }
    my $assistant_message = $raw_text;
    $assistant_message =~ s/^\s+|\s+$//g;
    $assistant_message =~ s/\r\n/\n/g;
    $assistant_message = substr($assistant_message, 0, 4000);
    my $excerpt = $assistant_message;
    $excerpt =~ s/\s+/ /g;
    $excerpt = substr($excerpt, 0, 240);
    my $confidence_percent = defined $extracted->{confidence_percent} ? $extracted->{confidence_percent} : 20;
    my $degraded_mode = ($options && exists $options->{degraded_mode})
        ? ($options->{degraded_mode} ? 1 : 0)
        : 1;
    my $response = {
        success => JSON::true,
        degraded_mode => $degraded_mode ? JSON::true : JSON::false,
        extracted_call_number => $selected || undef,
        extraction_source => $extraction_source,
        raw_text_excerpt => $excerpt,
        version => Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION,
        request_id => $payload->{request_id},
        tag_context => $payload->{tag_context},
        assistant_message => $assistant_message,
        confidence_percent => 0 + $confidence_percent,
        classification => $selected || '',
        subjects => $self->_subjects_from_text_list($extracted->{subjects} || []),
        findings => \@findings,
        errors => \@errors,
        disclaimer => 'Suggestions only; review before saving.'
    };
    if ($options && $options->{debug}) {
        $response->{debug} = $options->{debug};
    }
    my $candidates = $self->_extract_lc_call_numbers($raw_text, $settings);
    $response->{lc_candidates} = $candidates if $settings->{debug_mode};
    return $response;
}
sub _build_unstructured_ai_response {
    my ($self, $payload, $raw_text, $settings, $options) = @_;
    return undef unless $payload && $raw_text;
    my $assistant_message = $raw_text;
    $assistant_message =~ s/^\s+|\s+$//g;
    $assistant_message =~ s/\r\n/\n/g;
    $assistant_message = substr($assistant_message, 0, 4000);
    my $excerpt = $assistant_message;
    $excerpt =~ s/\s+/ /g;
    $excerpt = substr($excerpt, 0, 240);
    my $response = {
        success => JSON::true,
        degraded_mode => JSON::true,
        raw_text_excerpt => $excerpt,
        version => Koha::Plugin::Cataloging::AutoPunctuation::AI_PROMPT_VERSION,
        request_id => $payload->{request_id},
        tag_context => $payload->{tag_context},
        assistant_message => $assistant_message,
        confidence_percent => 50,
        classification => '',
        subjects => [],
        issues => [],
        findings => [],
        errors => [],
        disclaimer => 'Suggestions only; review before saving.'
    };
    if ($options && $options->{debug}) {
        $response->{debug} = $options->{debug};
    }
    return $response;
}
sub _summarize_ai_findings {
    my ($self, $findings) = @_;
    return '' unless $findings && ref $findings eq 'ARRAY';
    my @lines;
    for my $finding (@{$findings}) {
        next unless $finding && ref $finding eq 'HASH';
        my $message = $finding->{message} // '';
        my $rationale = $finding->{rationale} // '';
        $message =~ s/^\s+|\s+$//g if defined $message;
        $rationale =~ s/^\s+|\s+$//g if defined $rationale;
        if ($message && $rationale && $rationale ne $message) {
            push @lines, "$message - $rationale";
        } elsif ($message) {
            push @lines, $message;
        } elsif ($rationale) {
            push @lines, $rationale;
        }
    }
    return join("\n", @lines);
}
sub _confidence_percent_from_findings {
    my ($self, $findings) = @_;
    return 50 unless $findings && ref $findings eq 'ARRAY';
    my @values = grep { looks_like_number($_) && $_ >= 0 && $_ <= 1 }
        map { $_->{confidence} } grep { $_ && ref $_ eq 'HASH' } @{$findings};
    return 50 unless @values;
    my $sum = 0;
    $sum += $_ for @values;
    my $avg = $sum / scalar(@values);
    my $percent = int($avg * 100 + 0.5);
    $percent = 0 if $percent < 0;
    $percent = 100 if $percent > 100;
    return $percent;
}
sub _augment_cataloging_response {
    my ($self, $payload, $result, $raw_text, $settings) = @_;
    return $result unless $self->_is_cataloging_ai_request($payload);
    return $result unless $result && ref $result eq 'HASH';
    my $features = $payload->{features} || {};
    my $findings = $result->{findings};
    $findings = [] unless $findings && ref $findings eq 'ARRAY';
    my ($class_finding) = grep { uc($_->{code} || '') eq 'AI_CLASSIFICATION' } @{$findings};
    my ($subject_finding) = grep { uc($_->{code} || '') eq 'AI_SUBJECTS' } @{$findings};
    my $class_message = $class_finding ? ($class_finding->{message} // '') : '';
    my $subject_message = $subject_finding ? ($subject_finding->{message} // '') : '';
    my $need_extract = 0;
    $need_extract = 1 if $features->{call_number_guidance} && $class_message !~ /\S/;
    $need_extract = 1 if $features->{subject_guidance} && $subject_message !~ /\S/;
    return $result unless $need_extract;
    my $text = $result->{assistant_message} || $raw_text || '';
    my $extracted = $self->_extract_cataloging_suggestions_from_text($text, $settings);
    if ($features->{call_number_guidance}) {
        my $message = $extracted->{classification} || '';
        my $range_message = $self->_classification_range_message($message);
        if ($class_finding) {
            if ($range_message) {
                $class_finding->{message} = '';
            } else {
                $class_finding->{message} = $message if $message ne '';
            }
            $class_finding->{rationale} = $class_finding->{rationale} || 'Extracted from AI output.';
            $class_finding->{confidence} = 0.5 unless defined $class_finding->{confidence};
            $class_finding->{proposed_fixes} = [];
        } else {
            push @{$findings}, {
                severity => 'INFO',
                code => 'AI_CLASSIFICATION',
                message => $range_message ? '' : $message,
                rationale => 'Extracted from AI output.',
                proposed_fixes => [],
                confidence => 0.5
            };
        }
        if ($range_message) {
            $result->{errors} ||= [];
            push @{ $result->{errors} }, {
                code => 'CLASSIFICATION_RANGE',
                field => 'classification',
                message => $range_message
            };
        }
    }
    if ($features->{subject_guidance}) {
        my $subjects_text = '';
        if ($extracted->{subjects} && ref $extracted->{subjects} eq 'ARRAY' && @{$extracted->{subjects}}) {
            $subjects_text = join('; ', @{ $extracted->{subjects} });
        }
        if ($subject_finding) {
            $subject_finding->{message} = $subjects_text if $subjects_text ne '';
            $subject_finding->{rationale} = $subject_finding->{rationale} || 'Extracted from AI output.';
            $subject_finding->{confidence} = 0.5 unless defined $subject_finding->{confidence};
            $subject_finding->{proposed_fixes} = [];
        } else {
            push @{$findings}, {
                severity => 'INFO',
                code => 'AI_SUBJECTS',
                message => $subjects_text,
                rationale => 'Extracted from AI output.',
                proposed_fixes => [],
                confidence => 0.5
            };
        }
    }
    $result->{findings} = $findings;
    my $classification_value = '';
    if ($features->{call_number_guidance}) {
        $classification_value = $result->{classification} || '';
        $classification_value = $class_finding ? ($class_finding->{message} // '') : $classification_value;
        $classification_value = $classification_value || ($extracted->{classification} || '');
        $classification_value = '' if $self->_classification_range_message($classification_value);
    }
    $result->{classification} = $classification_value if defined $classification_value;
    my @subjects_structured;
    if ($result->{subjects} && ref $result->{subjects} eq 'ARRAY') {
        for my $subject (@{ $result->{subjects} }) {
            my $normalized = $self->_normalize_subject_object($subject);
            push @subjects_structured, $normalized if $normalized;
        }
    } elsif ($features->{subject_guidance}) {
        my $from_text = $self->_subjects_from_text_list($extracted->{subjects} || []);
        @subjects_structured = @{ $from_text } if $from_text;
    }
    $result->{subjects} = \@subjects_structured if $features->{subject_guidance};
    if (!defined $result->{confidence_percent} || !looks_like_number($result->{confidence_percent})) {
        my $confidence = defined $extracted->{confidence_percent}
            ? $extracted->{confidence_percent}
            : $self->_confidence_percent_from_findings($findings);
        $result->{confidence_percent} = $confidence;
    }
    return $result;
}

1;
