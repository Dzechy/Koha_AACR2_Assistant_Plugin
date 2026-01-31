package Koha::Plugin::Cataloging::AutoPunctuation::Http;

use Modern::Perl;
use CGI;
use JSON qw(to_json from_json);
use Try::Tiny;

sub _emit_json {
    my ($self, $payload, $status, $extra_headers) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my %header = (
        -type => 'application/json',
        -charset => 'utf-8'
    );
    $header{-status} = $status if $status;
    if ($extra_headers && ref $extra_headers eq 'HASH') {
        $header{-header} = [ %{$extra_headers} ];
    }
    print $cgi->header(%header);
    print to_json($payload);
}
sub _json_response {
    my ($self, $status, $payload, $extra_headers) = @_;
    return $self->_emit_json($payload || {}, $status, $extra_headers);
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
sub _read_json_body {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $content_type = lc($cgi->content_type || $ENV{CONTENT_TYPE} || '');
    my $is_json = $content_type =~ m{application/json};

    my $parse_json = sub {
        my ($json_input) = @_;
        return { ok => 1, data => {} } unless $json_input;
        my $data;
        try {
            $data = from_json($json_input);
        } catch {
            my $message = "$_";
            $message =~ s/\s+$//;
            return { ok => 0, error => 'Invalid JSON input', details => $message };
        };
        return { ok => 0, error => 'JSON payload must be an object.' }
            unless ref $data eq 'HASH';
        return { ok => 1, data => $data };
    };

    my $json_input = '';
    if ($is_json) {
        if ($ENV{'psgi.input'}) {
            my $fh = $ENV{'psgi.input'};
            my $length = $ENV{CONTENT_LENGTH} || 0;
            if ($length > 0) {
                read($fh, $json_input, $length);
            } else {
                local $/;
                $json_input = <$fh> // '';
            }
        }
    }
    if (!$json_input) {
        $json_input = $cgi->param('POSTDATA') || $cgi->param('json') || $cgi->param('payload') || '';
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
    my $json_input = '';
    if ($ENV{'psgi.input'}) {
        my $fh = $ENV{'psgi.input'};
        my $length = $ENV{CONTENT_LENGTH} || 0;
        if ($length > 0) {
            read($fh, $json_input, $length);
        } else {
            local $/;
            $json_input = <$fh> // '';
        }
    }
    if (!$json_input) {
        $json_input = $cgi->param('POSTDATA') || $cgi->param('json') || $cgi->param('payload') || '';
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
        return { error => 'Invalid JSON input', details => $message };
    };
    return $data;
}

1;
