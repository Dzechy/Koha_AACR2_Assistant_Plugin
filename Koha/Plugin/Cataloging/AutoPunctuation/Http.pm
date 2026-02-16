package Koha::Plugin::Cataloging::AutoPunctuation::Http;

use Modern::Perl;
use CGI;
use JSON qw(to_json from_json);
use Try::Tiny;

sub _clone_payload_hash {
    my ($payload) = @_;
    return {} unless defined $payload;
    return { %{$payload} } if ref $payload eq 'HASH';
    return { data => $payload } if ref $payload eq 'ARRAY';
    return { value => "$payload" };
}

sub _api_response {
    my ($self, $payload, $status, $extra_headers) = @_;
    my $body = _clone_payload_hash($payload);
    if (defined $status && $status ne '') {
        $body->{__http_status} = "$status";
    }
    if ($extra_headers && ref $extra_headers eq 'HASH' && %{$extra_headers}) {
        $body->{__http_headers} = { %{$extra_headers} };
    }
    return $body;
}

sub _emit_json {
    my ($self, $payload, $status, $extra_headers) = @_;
    return _api_response($self, $payload || {}, $status, $extra_headers);
}
sub _json_response {
    my ($self, $status, $payload, $extra_headers) = @_;
    return _api_response($self, $payload || {}, $status, $extra_headers);
}
sub _json_error {
    my ($self, $status, $message, $extra) = @_;
    my $payload = {
        ok => 0,
        error => $message
    };
    if ($extra && ref $extra eq 'HASH') {
        $payload = { %{$payload}, %{$extra} };
    }
    return $self->_json_response($status, $payload);
}
sub _emit_json_error {
    my ($self, $message, $status) = @_;
    return $self->_json_error($status, $message);
}
sub _max_json_payload_bytes {
    return 512 * 1024;
}
sub _json_payload_too_large {
    my ($self, $max_bytes) = @_;
    my $limit = $max_bytes || $self->_max_json_payload_bytes();
    return {
        ok => 0,
        error => 'JSON payload too large.',
        details => "Request body exceeds ${limit} bytes.",
        status => '413 Payload Too Large'
    };
}
sub _content_length_value {
    my ($self) = @_;
    my $raw = $ENV{CONTENT_LENGTH};
    return undef unless defined $raw && $raw ne '';
    return undef unless $raw =~ /^\d+$/;
    return int($raw);
}
sub _read_psgi_body_limited {
    my ($self, $max_bytes) = @_;
    return { ok => 1, body => '' } unless $ENV{'psgi.input'};
    my $limit = $max_bytes || $self->_max_json_payload_bytes();
    my $declared_length = $self->_content_length_value();
    if (defined $declared_length && $declared_length > $limit) {
        return $self->_json_payload_too_large($limit);
    }

    my $fh = $ENV{'psgi.input'};
    my $body = '';
    if (defined $declared_length && $declared_length > 0) {
        my $bytes_read = read($fh, $body, $declared_length);
        return { ok => 1, body => '' } unless defined $bytes_read;
    } else {
        my $chunk = '';
        while (1) {
            my $bytes_read = read($fh, $chunk, 8192);
            last unless $bytes_read;
            $body .= $chunk;
            if (length($body) > $limit) {
                return $self->_json_payload_too_large($limit);
            }
        }
    }
    if (length($body) > $limit) {
        return $self->_json_payload_too_large($limit);
    }
    return { ok => 1, body => $body };
}
sub _read_json_param_limited {
    my ($self, $cgi, $max_bytes) = @_;
    my $limit = $max_bytes || $self->_max_json_payload_bytes();
    my $json_input = $cgi->param('POSTDATA') || $cgi->param('json') || $cgi->param('payload') || '';
    return { ok => 1, body => '' } unless $json_input;
    if (length($json_input) > $limit) {
        return $self->_json_payload_too_large($limit);
    }
    return { ok => 1, body => $json_input };
}
sub _read_json_body {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $content_type = lc($cgi->content_type || $ENV{CONTENT_TYPE} || '');
    my $is_json = $content_type =~ m{application/json};
    my $max_bytes = $self->_max_json_payload_bytes();

    my $parse_json = sub {
        my ($json_input) = @_;
        return { ok => 1, data => {} } unless $json_input;
        my $data;
        try {
            $data = from_json($json_input);
        } catch {
            my $message = "$_";
            $message =~ s/\s+$//;
            return { ok => 0, error => 'Invalid JSON input', details => $message, status => '400 Bad Request' };
        };
        return { ok => 0, error => 'JSON payload must be an object.', status => '400 Bad Request' }
            unless ref $data eq 'HASH';
        return { ok => 1, data => $data };
    };

    my $json_input = '';
    if ($is_json) {
        my $body_read = $self->_read_psgi_body_limited($max_bytes);
        return $body_read unless $body_read->{ok};
        $json_input = $body_read->{body} || '';
    }
    if (!$json_input) {
        my $param_read = $self->_read_json_param_limited($cgi, $max_bytes);
        return $param_read unless $param_read->{ok};
        $json_input = $param_read->{body} || '';
    }
    return $parse_json->($json_input) if $is_json || $json_input;

    my %vars = $cgi->Vars;
    return { ok => 1, data => \%vars };
}
sub _current_user_id {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    return $cgi->remote_user || $ENV{REMOTE_USER} || '';
}
sub _require_permission {
    return 1;
}
sub _require_method {
    my ($self, $method) = @_;
    my $request_method = $ENV{REQUEST_METHOD} || '';
    return $request_method eq $method ? 1 : 0;
}
sub _read_json_payload {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $max_bytes = $self->_max_json_payload_bytes();
    my $json_input = '';

    if ($ENV{'psgi.input'}) {
        my $body_read = $self->_read_psgi_body_limited($max_bytes);
        return { error => $body_read->{error}, details => $body_read->{details}, status => $body_read->{status} }
            unless $body_read->{ok};
        $json_input = $body_read->{body} || '';
    }
    if (!$json_input) {
        my $param_read = $self->_read_json_param_limited($cgi, $max_bytes);
        return { error => $param_read->{error}, details => $param_read->{details}, status => $param_read->{status} }
            unless $param_read->{ok};
        $json_input = $param_read->{body} || '';
    }
    if (!$json_input) {
        my %vars = $cgi->Vars;
        return \%vars if %vars;
        return {};
    }
    my $data;
    try {
        $data = from_json($json_input);
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        return { error => 'Invalid JSON input', details => $message, status => '400 Bad Request' };
    };
    return { error => 'JSON payload must be an object.', status => '400 Bad Request' }
        unless ref $data eq 'HASH';
    return $data;
}

1;
