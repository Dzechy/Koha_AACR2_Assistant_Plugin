#!/usr/bin/perl

# This is a copy of the actual file. Use only as a guide to understand the actual file

# Copyright 2010 Kyle M Hall <kyle.m.hall@gmail.com>
#
# This file is part of Koha.
#
# Koha is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
#
# Koha is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with Koha; if not, see <https://www.gnu.org/licenses>.

use Modern::Perl;

use CGI qw( -utf8 );
use JSON qw( encode_json );
use Scalar::Util qw( reftype );
use URI::Escape qw( uri_unescape );

use Koha::Plugins::Handler;
use C4::Auth   qw( get_template_and_user );
use C4::Output qw( output_html_with_http_headers );
use C4::Context;

my $plugins_enabled = C4::Context->config("enable_plugins");

my $cgi = CGI->new;

sub _query_params {
    my ($raw) = @_;
    my %params;
    $raw = '' unless defined $raw;
    for my $pair (split /[&;]/, $raw) {
        next unless defined $pair && $pair ne '';
        my ( $key, $value ) = split /=/, $pair, 2;
        next unless defined $key && $key ne '';
        $value = '' unless defined $value;
        $key =~ tr/+/ /;
        $value =~ tr/+/ /;
        $key = uri_unescape($key);
        $value = uri_unescape($value);
        next unless defined $key && $key ne '';
        # Preserve first value, matching CGI param behavior for scalar context.
        $params{$key} = $value unless exists $params{$key};
    }
    return \%params;
}

my $qs = _query_params($ENV{QUERY_STRING});
my $class  = $cgi->param('class');
$class = $qs->{class} if ( !defined $class || $class eq '' ) && exists $qs->{class};
my $method = $cgi->param('method');
$method = $qs->{method} if ( !defined $method || $method eq '' ) && exists $qs->{method};
my $op = $cgi->param('op');
$op = $qs->{op} if ( !defined $op || $op eq '' ) && exists $qs->{op};
$op = '' unless defined $op;

# IMPORTANT:
# Do NOT use $method as the sub-flag for permissions (it can be undef).
# Using plugins => 1 avoids "Use of uninitialized value in string eq" in C4/Auth.pm.
my ( $template, $borrowernumber, $cookie ) = get_template_and_user(
    {
        template_name => "plugins/plugins-disabled.tt",
        query         => $cgi,
        type          => "intranet",
        flagsrequired => { plugins => 1 },
    }
);

# If plugins are disabled globally, show the standard page
unless ($plugins_enabled) {
    output_html_with_http_headers( $cgi, $cookie, $template->output );
    exit;
}

# Helper to always emit a response (prevents "End of script output before headers")
sub _respond {
    my ( $status, $type, $body ) = @_;
    $status ||= '200 OK';
    $type   ||= 'text/plain; charset=utf-8';
    $body   = '' unless defined $body;

    print $cgi->header(
        -status => $status,
        -type   => $type,
        -cookie => $cookie,
    );
    print $body;
    return;
}
sub _json_error {
    my ( $status, $message, $extra ) = @_;
    my $payload = {
        ok    => 0,
        error => $message || 'Request failed.',
    };
    if ( $extra && ref $extra eq 'HASH' ) {
        $payload = { %{$payload}, %{$extra} };
    }
    _respond( $status || '400 Bad Request', 'application/json; charset=utf-8', encode_json($payload) );
    return;
}

# Validate required parameters early
unless ( defined $class && length $class ) {
    if ( $op eq 'plugin_api' ) {
        _json_error( '400 Bad Request', 'Missing required parameter: class' );
        exit;
    }
    _respond( '400 Bad Request', 'text/plain; charset=utf-8', "Missing required parameter: class\n" );
    exit;
}

unless ( defined $method && length $method ) {
    if ( $op eq 'plugin_api' ) {
        _json_error( '400 Bad Request', 'Missing required parameter: method' );
        exit;
    }
    _respond( '400 Bad Request', 'text/plain; charset=utf-8', "Missing required parameter: method\n" );
    exit;
}

# Sanity checks (defensive)
unless ( $class =~ /\A(?:[A-Za-z_]\w*)(?:::(?:[A-Za-z_]\w*))*\z/ ) {
    if ( $op eq 'plugin_api' ) {
        _json_error( '400 Bad Request', 'Invalid parameter: class' );
        exit;
    }
    _respond( '400 Bad Request', 'text/plain; charset=utf-8', "Invalid parameter: class\n" );
    exit;
}

unless ( $method =~ /\A[A-Za-z_]\w*\z/ ) {
    if ( $op eq 'plugin_api' ) {
        _json_error( '400 Bad Request', 'Invalid parameter: method' );
        exit;
    }
    _respond( '400 Bad Request', 'text/plain; charset=utf-8', "Invalid parameter: method\n" );
    exit;
}

# Run plugin method (capture return value)
my $result;
my $ok = eval {
    $result = Koha::Plugins::Handler->run( { class => $class, method => $method, cgi => $cgi } );
    1;
};
unless ($ok) {
    my $message = "$@";
    $message =~ s/\s+$//;
    warn "Plugin run error for class '$class' method '$method': $message";
    if ( $op eq 'plugin_api' ) {
        _json_error( '500 Internal Server Error', 'Plugin execution failed. Check server logs for details.' );
        exit;
    }
    _respond( '500 Internal Server Error', 'text/plain; charset=utf-8', "Plugin execution failed.\n" );
    exit;
}

# If this is the plugin API endpoint, respond in a predictable way
if ( $op eq 'plugin_api' ) {

    # If plugin returned a hash/arrayref, JSON encode it
    if ( defined $result && ref($result) ) {
        my $rt = reftype($result) || '';
        if ( $rt eq 'HASH' ) {
            my $payload = { %{$result} };
            my $status = delete $payload->{__http_status} || '200 OK';
            delete $payload->{__http_headers};
            my $encoded;
            my $encoded_ok = eval {
                $encoded = encode_json($payload);
                1;
            };
            unless ($encoded_ok) {
                my $message = "$@";
                $message =~ s/\s+$//;
                warn "Plugin API encode_json failed for '$class->$method': $message";
                _json_error( '500 Internal Server Error', 'Failed to encode JSON response.' );
                exit;
            }
            _respond( $status, 'application/json; charset=utf-8', $encoded );
            exit;
        } elsif ( $rt eq 'ARRAY' ) {
            _respond( '200 OK', 'application/json; charset=utf-8', encode_json($result) );
            exit;
        }
    }

    # If plugin returned a scalar string (maybe already JSON), return it as-is
    if ( defined $result ) {
        # Heuristic: if it looks like JSON, label as JSON
        my $trim = $result;
        $trim =~ s/\A\s+|\s+\z//g;
        my $type = ( $trim =~ /\A[\{\[]/ ) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        _respond( '200 OK', $type, $result );
        exit;
    }

    # Nothing returned -> still return headers (no Apache error)
    _respond( '204 No Content', 'text/plain; charset=utf-8', '' );
    exit;
}

# Non-API usage:
# Keep legacy Koha behavior: plugin methods generally print their own headers/body.
# Do not emit an additional fallback response here, otherwise headers/body can be corrupted.
exit;
