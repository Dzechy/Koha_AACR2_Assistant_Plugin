package Koha::Plugin::Cataloging::AutoPunctuation::GuideProgress;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;
use Koha::Patrons;
use Digest::SHA qw(sha1_hex);
use Scalar::Util qw(looks_like_number);

sub _load_legacy_guide_progress {
    my ($self, $settings) = @_;
    my $raw = $self->_safe_retrieve_data('guide_progress', $settings, 'legacy guide_progress') || '{}';
    my $data = {};
    try {
        $data = from_json($raw);
    } catch {
        $data = {};
    };
    return $data;
}
sub _save_legacy_guide_progress {
    my ($self, $data, $settings) = @_;
    $self->_safe_store_data({ guide_progress => to_json($data || {}) }, $settings, 'legacy guide_progress');
}
sub _guide_progress_key {
    my ($self, $user_key) = @_;
    return '' unless defined $user_key && $user_key ne '';
    $user_key =~ s/^\s+|\s+$//g;
    return '' unless $user_key ne '';
    return 'guide_progress:' . $user_key;
}
sub _load_guide_progress_index {
    my ($self, $settings) = @_;
    my $map = $self->_load_guide_progress_map($settings);
    if ($map && ref $map eq 'HASH' && %{$map}) {
        my @list = grep { defined $_ && $_ ne '' } sort keys %{$map};
        return \@list;
    }
    my $raw = $self->_safe_retrieve_data('guide_progress_index', $settings, 'guide_progress_index') || '';
    return [] unless $raw;
    my $data = [];
    try {
        $data = from_json($raw);
    } catch {
        $data = [];
    };
    if (ref $data eq 'ARRAY') {
        my @list = grep { defined $_ && $_ ne '' } @{$data};
        return \@list;
    }
    if (ref $data eq 'HASH') {
        if ($data->{users} && ref $data->{users} eq 'ARRAY') {
            my @list = grep { defined $_ && $_ ne '' } @{ $data->{users} };
            return \@list;
        }
        if ($data->{users} && ref $data->{users} eq 'HASH') {
            my @list = grep { defined $_ && $_ ne '' } sort keys %{ $data->{users} };
            return \@list;
        }
        my @list = grep { defined $_ && $_ ne '' } sort keys %{$data};
        return \@list;
    }
    return [];
}
sub _save_guide_progress_index {
    my ($self, $list, $settings) = @_;
    $list = [] unless $list && ref $list eq 'ARRAY';
    $self->_safe_store_data({ guide_progress_index => to_json($list) }, $settings, 'guide_progress_index');
}
sub _load_guide_progress_map {
    my ($self, $settings) = @_;
    my $raw = $self->_safe_retrieve_data('guide_progress_v2', $settings, 'guide_progress_v2') || '{}';
    my $data = {};
    try {
        $data = from_json($raw);
    } catch {
        $data = {};
    };
    return $data if ref $data eq 'HASH';
    return {};
}
sub _save_guide_progress_map {
    my ($self, $map, $settings) = @_;
    $map = {} unless $map && ref $map eq 'HASH';
    return $self->_safe_store_data({ guide_progress_v2 => to_json($map) }, $settings, 'guide_progress_v2');
}
sub _load_guide_progress_entry {
    my ($self, $user_key, $settings) = @_;
    my $map = $self->_load_guide_progress_map($settings);
    if ($map && ref $map eq 'HASH' && $user_key && exists $map->{$user_key}) {
        return $map->{$user_key} || {};
    }
    my $key = $self->_guide_progress_key($user_key);
    return {} unless $key;
    my $raw = $self->_safe_retrieve_data($key, $settings, $key) || '{}';
    my $data = {};
    try {
        $data = from_json($raw);
    } catch {
        $data = {};
    };
    return $data;
}
sub _save_guide_progress_entry {
    my ($self, $user_key, $data, $settings) = @_;
    return unless defined $user_key && $user_key ne '';
    my $map = $self->_load_guide_progress_map($settings);
    $map = {} unless $map && ref $map eq 'HASH';
    $map->{$user_key} = $data || {};
    return $self->_save_guide_progress_map($map, $settings);
}
sub _normalize_progress_list {
    my ($self, $value) = @_;
    my @items;
    if (ref $value eq 'ARRAY') {
        @items = @{$value};
    } elsif (defined $value) {
        my $raw = $value;
        @items = split(/[\0,]+/, $raw);
    }
    @items = grep { defined $_ && !ref $_ } @items;
    @items = map {
        my $v = defined $_ ? $_ : '';
        $v =~ s/^\s+|\s+$//g;
        $v;
    } @items;
    @items = grep { $_ ne '' } @items;
    return \@items;
}
sub _summary_counts_from_payload {
    my ($self, $summary, $completed, $skipped) = @_;
    my $completed_count = (ref $completed eq 'ARRAY') ? scalar @{$completed} : 0;
    my $skipped_count = (ref $skipped eq 'ARRAY') ? scalar @{$skipped} : 0;
    my $total = $completed_count + $skipped_count;
    if ($summary && ref $summary eq 'HASH') {
        my $maybe_total = $summary->{total} || $summary->{steps_total} || $summary->{stepsTotal};
        if (defined $maybe_total && looks_like_number($maybe_total)) {
            $total = int($maybe_total);
        }
    }
    return {
        completed_count => $completed_count,
        skipped_count => $skipped_count,
        total => $total
    };
}
sub _maybe_migrate_guide_progress {
    my ($self) = @_;
    my $settings = $self->_load_settings();
    my $migrated = $self->_safe_retrieve_data('guide_progress_migrated', $settings, 'guide_progress_migrated') || '';
    my $index = $self->_load_guide_progress_index($settings);
    return if $migrated || ($index && @{$index});

    my $legacy = $self->_load_legacy_guide_progress($settings);
    return unless $legacy && ref $legacy eq 'HASH' && %{$legacy};

    my @index;
    for my $legacy_key (keys %{$legacy}) {
        my $entry = $legacy->{$legacy_key} || {};
        my $userid = $entry->{user} || $entry->{userid} || $legacy_key || '';
        $userid =~ s/^\s+|\s+$//g if $userid;
        my $patron = $userid ? Koha::Patrons->find({ userid => $userid }) : undef;
        my $borrowernumber = $patron ? $patron->borrowernumber : undef;
        my $user_key = $borrowernumber || $userid;
        next unless $user_key;
        my $completed = $entry->{completed};
        $completed = [] unless $completed && ref $completed eq 'ARRAY';
        my $skipped = $entry->{skipped};
        $skipped = [] unless $skipped && ref $skipped eq 'ARRAY';
        my $summary = $entry->{summary};
        $summary = {} unless $summary && ref $summary eq 'HASH';
        my $signature = defined $entry->{signature} ? $entry->{signature} : '';
        my $signature_hash = $signature ne '' ? sha1_hex($signature) : '';
        my $summary_counts = $self->_summary_counts_from_payload($summary, $completed, $skipped);
        my $data = {
            updated_at => $entry->{updated_at} || time,
            signature_hash => $signature_hash,
            completed => $completed,
            skipped => $skipped,
            summary_counts => $summary_counts
        };
        $self->_save_guide_progress_entry($user_key, $data, $settings);
        push @index, $user_key;
    }
    if (@index) {
        my %seen;
        my @unique = grep { !$seen{$_}++ } @index;
        $self->_save_guide_progress_index(\@unique, $settings);
        $self->_safe_store_data({ guide_progress_migrated => time }, $settings, 'guide_progress_migrated');
        $self->_save_legacy_guide_progress({}, $settings);
    }
}
sub guide_progress_update {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('POST');
    my ($response, $status);
    try {
        my $read = $self->_read_json_body();
        unless ($read->{ok}) {
            $response = { ok => 0, error => $read->{error}, details => $read->{details} };
            $status = '400 Bad Request';
            return;
        }
        my $payload = $read->{data} || {};
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token' };
            $status = '403 Forbidden';
            return;
        }

        my $settings = $self->_load_settings();
        my $userenv = C4::Context->userenv || {};
        my $borrowernumber = $userenv->{borrowernumber} || '';
        my $userid = $userenv->{userid} || $userenv->{user} || $self->_current_user_id() || '';
        my $user_key = $borrowernumber || $userid || '';
        if (!$user_key) {
            my $session_id = $self->_session_id();
            $user_key = $session_id ? "session:$session_id" : '';
        }
        $user_key = 'anonymous' unless $user_key;

        $self->_maybe_migrate_guide_progress();

        my $signature = $payload->{signature};
        $signature = '' unless defined $signature;
        $signature =~ s/^\s+|\s+$//g;
        my $signature_hash = $signature ne '' ? sha1_hex($signature) : '';

        my $completed = $self->_normalize_progress_list($payload->{completed});
        my $skipped = $self->_normalize_progress_list($payload->{skipped});

        my $summary_counts = $payload->{summary_counts};
        if ($summary_counts && ref $summary_counts ne 'HASH') {
            $summary_counts = {};
        }
        if (!$summary_counts || ref $summary_counts ne 'HASH') {
            my $summary = $payload->{summary};
            if ($summary && ref $summary ne 'HASH' && !ref $summary) {
                try {
                    $summary = from_json($summary);
                } catch {
                    $summary = {};
                };
            }
            $summary = {} unless $summary && ref $summary eq 'HASH';
            $summary_counts = $self->_summary_counts_from_payload($summary, $completed, $skipped);
        } else {
            my $normalized = {};
            for my $key (qw(completed_count skipped_count total)) {
                my $value = $summary_counts->{$key};
                $normalized->{$key} = looks_like_number($value) ? int($value) : 0;
            }
            $summary_counts = $normalized;
        }

        if (!exists $payload->{completed} && !exists $payload->{skipped} && !exists $payload->{summary}
            && !exists $payload->{summary_counts}) {
            $response = { ok => 0, error => 'Missing progress data.' };
            $status = '422 Unprocessable Entity';
            return;
        }

        my $data = {
            updated_at => time,
            signature_hash => $signature_hash,
            completed => $completed,
            skipped => $skipped,
            summary_counts => $summary_counts
        };

        my $ok = 1;
        try {
            $ok = $self->_save_guide_progress_entry($user_key, $data, $settings) ? 1 : 0;
        } catch {
            $ok = 0;
            $self->_debug_log($settings, "guide_progress_update storage error: $_");
        };
        $response = $ok ? { ok => 1 } : { ok => 1, warning => 'Progress storage unavailable.' };
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation guide_progress_update error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_emit_json($response, $status);
}
sub guide_progress_list {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('GET');
    my $userid = $self->_current_user_id();

    my $settings = $self->_load_settings();
    $self->_maybe_migrate_guide_progress();

    my $cgi = $self->{'cgi'} || CGI->new;
    my $requested = $cgi->param('borrowernumber') || '';
    if (!$requested) {
        my $requested_user = $cgi->param('userid') || '';
        if ($requested_user) {
            my $patron = Koha::Patrons->find({ userid => $requested_user });
            $requested = $patron && $patron->borrowernumber ? $patron->borrowernumber : $requested_user;
        }
    }

    my @rows;
    if ($requested) {
        my $entry = $self->_load_guide_progress_entry($requested, $settings);
        if ($entry && ref $entry eq 'HASH' && %{$entry}) {
            my $patron;
            if ($requested =~ /^\d+$/) {
                $patron = Koha::Patrons->find($requested);
            } elsif ($requested !~ /^session:/) {
                $patron = Koha::Patrons->find({ userid => $requested });
            }
            my $summary_counts = $entry->{summary_counts};
            if (!$summary_counts || ref $summary_counts ne 'HASH') {
                $summary_counts = $self->_summary_counts_from_payload(undef, $entry->{completed}, $entry->{skipped});
            }
            $entry->{summary_counts} = $summary_counts;
            push @rows, {
                userid => $patron ? ($patron->userid || '') : ($requested =~ /^session:/ ? '' : $requested),
                name => $patron ? ($patron->surname . ', ' . ($patron->firstname || '')) : ($requested =~ /^session:/ ? 'Session user' : ''),
                updated_at => $entry->{updated_at} || 0,
                summary_counts => $summary_counts
            };
        }
        return $self->_json_response('200 OK', { ok => 1, users => \@rows, progress => ($entry || {}) });
    }

    my $index = $self->_load_guide_progress_index($settings);
    $index = [] unless $index && ref $index eq 'ARRAY';
    for my $user_key (@{$index}) {
        my $entry = $self->_load_guide_progress_entry($user_key, $settings);
        next unless $entry && ref $entry eq 'HASH' && %{$entry};
        my $patron;
        if ($user_key =~ /^\d+$/) {
            $patron = Koha::Patrons->find($user_key);
        } elsif ($user_key !~ /^session:/) {
            $patron = Koha::Patrons->find({ userid => $user_key });
        }
        my $display_name = $patron
            ? ($patron->surname . ', ' . ($patron->firstname || ''))
            : ($user_key =~ /^session:/ ? 'Session user' : '');
        my $summary_counts = $entry->{summary_counts};
        if (!$summary_counts || ref $summary_counts ne 'HASH') {
            $summary_counts = $self->_summary_counts_from_payload(undef, $entry->{completed}, $entry->{skipped});
        }
        push @rows, {
            userid => $patron ? ($patron->userid || '') : ($user_key =~ /^session:/ ? '' : $user_key),
            name => $display_name,
            updated_at => $entry->{updated_at} || 0,
            summary_counts => $summary_counts
        };
    }
    @rows = sort { ($b->{updated_at} || 0) <=> ($a->{updated_at} || 0) } @rows;
    my $payload = { ok => 1, users => \@rows };
    $payload->{progress} = {} unless @rows;
    return $self->_json_response('200 OK', $payload);
}

1;
