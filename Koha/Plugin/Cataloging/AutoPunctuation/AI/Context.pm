package Koha::Plugin::Cataloging::AutoPunctuation::AI::Context;

use Modern::Perl;
use Scalar::Util qw(looks_like_number);

sub _normalize_occurrence {
    my ($self, $value) = @_;
    return 0 unless defined $value && $value ne '';
    return int($value) if looks_like_number($value);
    return 0;
}
sub _normalize_tag_context {
    my ($self, $tag_context, $max_subfields) = @_;
    return {} unless $tag_context && ref $tag_context eq 'HASH';
    my $occurrence = $self->_normalize_occurrence($tag_context->{occurrence});
    my $active_subfield = $tag_context->{active_subfield};
    $active_subfield = '' unless defined $active_subfield;
    $active_subfield = lc($active_subfield);
    $active_subfield = substr($active_subfield, 0, 1) if length($active_subfield) > 1;
    my @subfields = grep { ref $_ eq 'HASH' } @{ $tag_context->{subfields} || [] };
    if (defined $max_subfields && @subfields > $max_subfields) {
        my $primary = shift @subfields;
        my $remaining = $max_subfields - 1;
        my @rest = $remaining > 0 ? @subfields[0 .. ($remaining - 1)] : ();
        @subfields = ($primary, @rest);
    }
    my @normalized = map {
        {
            code => $_->{code} // '',
            value => defined $_->{value} ? $_->{value} : ''
        }
    } @subfields;
    my %clone = %{$tag_context};
    $clone{occurrence} = $occurrence;
    $clone{subfields} = \@normalized;
    $clone{active_subfield} = $active_subfield if $active_subfield;
    return \%clone;
}
sub _normalize_record_context {
    my ($self, $record_context, $max_fields, $max_subfields) = @_;
    return undef unless $record_context && ref $record_context eq 'HASH';
    my @fields = grep { ref $_ eq 'HASH' } @{ $record_context->{fields} || [] };
    if (defined $max_fields && @fields > $max_fields) {
        @fields = @fields[0 .. ($max_fields - 1)];
    }
    my @normalized;
    for my $field (@fields) {
        my @subfields = grep { ref $_ eq 'HASH' } @{ $field->{subfields} || [] };
        if (defined $max_subfields && @subfields > $max_subfields) {
            @subfields = @subfields[0 .. ($max_subfields - 1)];
        }
        my @subs = map {
            {
                code => $_->{code} // '',
                value => defined $_->{value} ? $_->{value} : ''
            }
        } @subfields;
        my %clone = %{$field};
        $clone{occurrence} = $self->_normalize_occurrence($field->{occurrence});
        $clone{subfields} = \@subs;
        push @normalized, \%clone;
    }
    return { fields => \@normalized };
}
sub _normalize_ai_features {
    my ($self, $features) = @_;
    my %normalized = (
        punctuation_explain => ($features && $features->{punctuation_explain}) ? 1 : 0,
        subject_guidance => ($features && $features->{subject_guidance}) ? 1 : 0,
        call_number_guidance => ($features && $features->{call_number_guidance}) ? 1 : 0
    );
    return \%normalized;
}
sub _normalize_ai_request_payload {
    my ($self, $payload, $settings) = @_;
    return $payload unless $payload && ref $payload eq 'HASH';
    my %clone = %{$payload};
    $clone{tag_context} = $self->_normalize_tag_context($payload->{tag_context}, 20);
    if ($payload->{record_context}) {
        $clone{record_context} = $self->_normalize_record_context($payload->{record_context}, 30, 30);
    }
    $clone{features} = $self->_normalize_ai_features($payload->{features});
    return \%clone;
}
sub _normalize_record_context_for_cache {
    my ($self, $record_context) = @_;
    return {} unless $record_context && ref $record_context eq 'HASH';
    my @fields = grep { ref $_ eq 'HASH' } @{ $record_context->{fields} || [] };
    @fields = sort {
        ($a->{tag} || '') cmp ($b->{tag} || '')
            || $self->_normalize_occurrence($a->{occurrence}) <=> $self->_normalize_occurrence($b->{occurrence})
    } @fields;
    my @normalized;
    for my $field (@fields) {
        my @subfields = grep { ref $_ eq 'HASH' } @{ $field->{subfields} || [] };
        @subfields = sort {
            ($a->{code} || '') cmp ($b->{code} || '')
                || ($a->{value} // '') cmp ($b->{value} // '')
        } @subfields;
        push @normalized, {
            tag => $field->{tag} || '',
            ind1 => $field->{ind1} || '',
            ind2 => $field->{ind2} || '',
            occurrence => $self->_normalize_occurrence($field->{occurrence}),
            subfields => [ map { { code => $_->{code} || '', value => defined $_->{value} ? $_->{value} : '' } } @subfields ]
        };
    }
    return { fields => \@normalized };
}

1;
