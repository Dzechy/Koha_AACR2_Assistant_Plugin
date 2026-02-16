package Koha::Plugin::Cataloging::AutoPunctuation::Schema;

use Modern::Perl;
use JSON qw(from_json);
use Try::Tiny;
use Scalar::Util qw(looks_like_number);

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
        if (exists $schema->{additionalProperties} && !$schema->{additionalProperties}) {
            my %known = map { $_ => 1 } keys %{ $schema->{properties} || {} };
            for my $key (keys %{$data}) {
                next if $known{$key};
                push @{$errors}, "$path has unexpected property $key";
            }
        }
    } elsif ($type eq 'array') {
        if (ref $data ne 'ARRAY') {
            push @{$errors}, "$path should be array";
            return;
        }
        if (defined $schema->{minItems} && scalar(@{$data}) < $schema->{minItems}) {
            push @{$errors}, "$path must have at least $schema->{minItems} items";
        }
        if (defined $schema->{maxItems} && scalar(@{$data}) > $schema->{maxItems}) {
            push @{$errors}, "$path must have at most $schema->{maxItems} items";
        }
        if ($schema->{items}) {
            for my $i (0 .. $#{$data}) {
                $self->_validate_schema_node($schema->{items}, $data->[$i], "$path\[$i\]", $errors);
            }
        }
    } elsif ($type eq 'string') {
        push @{$errors}, "$path should be string" if ref $data;
        if (!ref $data && defined $schema->{minLength} && length($data) < $schema->{minLength}) {
            push @{$errors}, "$path must be at least $schema->{minLength} characters";
        }
        if (!ref $data && defined $schema->{maxLength} && length($data) > $schema->{maxLength}) {
            push @{$errors}, "$path must be at most $schema->{maxLength} characters";
        }
        if ($schema->{enum} && ref $schema->{enum} eq 'ARRAY') {
            push @{$errors}, "$path must be one of enum values"
                unless scalar grep { $_ eq $data } @{ $schema->{enum} };
        }
    } elsif ($type eq 'number') {
        push @{$errors}, "$path should be number" unless defined $data && looks_like_number($data);
        if (defined $schema->{minimum} && defined $data && $data < $schema->{minimum}) {
            push @{$errors}, "$path must be >= $schema->{minimum}";
        }
        if (defined $schema->{maximum} && defined $data && $data > $schema->{maximum}) {
            push @{$errors}, "$path must be <= $schema->{maximum}";
        }
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

1;
