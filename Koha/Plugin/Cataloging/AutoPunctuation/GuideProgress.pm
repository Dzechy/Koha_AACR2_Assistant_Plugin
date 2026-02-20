package Koha::Plugin::Cataloging::AutoPunctuation::GuideProgress;

use Modern::Perl;
use JSON qw(to_json from_json);
use Try::Tiny;
use Koha::Patrons;
use C4::Context;
use CGI;
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

sub _normalize_progress_counter_hash {
    my ($value) = @_;
    return {} unless $value && ref $value eq 'HASH';
    my %normalized;
    for my $key (keys %{$value}) {
        next unless defined $key;
        my $name = "$key";
        $name =~ s/^\s+|\s+$//g;
        next unless $name ne '';
        my $entry = $value->{$key};
        next unless $entry && ref $entry eq 'HASH';
        my $total = looks_like_number($entry->{total}) ? int($entry->{total}) : 0;
        my $completed = looks_like_number($entry->{completed}) ? int($entry->{completed}) : 0;
        my $skipped = looks_like_number($entry->{skipped}) ? int($entry->{skipped}) : 0;
        $total = 0 if $total < 0;
        $completed = 0 if $completed < 0;
        $skipped = 0 if $skipped < 0;
        my $done = $completed + $skipped;
        $total = $done if $total < $done;
        $normalized{$name} = {
            total => $total,
            completed => $completed,
            skipped => $skipped
        };
    }
    return \%normalized;
}

sub _sanitize_progress_label {
    my ($value, $max_length) = @_;
    return '' unless defined $value;
    my $text = "$value";
    $text =~ s/\s+/ /g;
    $text =~ s/^\s+|\s+$//g;
    return '' unless $text ne '';
    my $limit = (defined $max_length && looks_like_number($max_length)) ? int($max_length) : 160;
    $limit = 1 if $limit < 1;
    if (length($text) > $limit) {
        $text = substr($text, 0, $limit);
        $text =~ s/\s+$//g;
    }
    return $text;
}

sub _completion_tier_label {
    my ($completion_percent) = @_;
    my $percent = (defined $completion_percent && looks_like_number($completion_percent))
        ? int($completion_percent)
        : 0;
    $percent = 0 if $percent < 0;
    $percent = 100 if $percent > 100;
    return 'Tier 1' if $percent <= 33;
    return 'Tier 2' if $percent <= 66;
    return 'Tier 3';
}

sub _normalize_progress_summary {
    my ($self, $summary, $summary_counts, $completed, $skipped) = @_;
    $summary = {} unless $summary && ref $summary eq 'HASH';
    $summary_counts = {} unless $summary_counts && ref $summary_counts eq 'HASH';
    my $counts = {
        completed_count => looks_like_number($summary_counts->{completed_count}) ? int($summary_counts->{completed_count}) : undef,
        skipped_count => looks_like_number($summary_counts->{skipped_count}) ? int($summary_counts->{skipped_count}) : undef,
        total => looks_like_number($summary_counts->{total}) ? int($summary_counts->{total}) : undef,
    };
    if (!defined $counts->{completed_count} || !defined $counts->{skipped_count} || !defined $counts->{total}) {
        $counts = $self->_summary_counts_from_payload($summary, $completed, $skipped);
    }
    for my $key (qw(completed_count skipped_count total)) {
        $counts->{$key} = 0 unless defined $counts->{$key};
        $counts->{$key} = 0 if $counts->{$key} < 0;
    }
    my $done_count = ($counts->{completed_count} || 0) + ($counts->{skipped_count} || 0);
    $counts->{total} = $done_count if ($counts->{total} || 0) < $done_count;

    my $module_breakdown = _normalize_progress_counter_hash($summary->{module_breakdown});
    my $modules_total = looks_like_number($summary->{modules_total}) ? int($summary->{modules_total}) : 0;
    my $modules_completed = looks_like_number($summary->{modules_completed}) ? int($summary->{modules_completed}) : 0;

    if ((!$modules_total || $modules_total < 0) && %{$module_breakdown}) {
        $modules_total = scalar keys %{$module_breakdown};
    }
    if ((!$modules_completed || $modules_completed < 0) && %{$module_breakdown}) {
        $modules_completed = 0;
        for my $module_name (keys %{$module_breakdown}) {
            my $entry = $module_breakdown->{$module_name} || {};
            my $done = ($entry->{completed} || 0) + ($entry->{skipped} || 0);
            $modules_completed++ if ($entry->{total} || 0) > 0 && $done >= ($entry->{total} || 0);
        }
    }
    $modules_total = 0 if $modules_total < 0;
    $modules_completed = 0 if $modules_completed < 0;
    $modules_completed = $modules_total if $modules_total && $modules_completed > $modules_total;

    my $completion_percent = $summary->{completion_percent};
    if (!defined $completion_percent || !looks_like_number($completion_percent)) {
        $completion_percent = $counts->{total}
            ? int((($counts->{completed_count} + $counts->{skipped_count}) * 100) / $counts->{total})
            : 0;
    }
    $completion_percent = int($completion_percent);
    $completion_percent = 0 if $completion_percent < 0;
    $completion_percent = 100 if $completion_percent > 100;

    my $current_module = _sanitize_progress_label(
        defined $summary->{current_module} ? $summary->{current_module} : $summary->{module},
        160
    );
    my $current_tier = _sanitize_progress_label(
        defined $summary->{current_tier} ? $summary->{current_tier} : $summary->{tier},
        80
    );
    if ($current_tier eq '' || $current_tier !~ /^Tier\s*[123]$/i) {
        $current_tier = _completion_tier_label($completion_percent);
    } else {
        my $match = $current_tier =~ /([123])/;
        $current_tier = $match ? "Tier $1" : _completion_tier_label($completion_percent);
    }
    my $current_step_key = _sanitize_progress_label($summary->{current_step_key}, 160);
    my $current_step_title = _sanitize_progress_label($summary->{current_step_title}, 240);

    return {
        steps_total => $counts->{total},
        steps_completed => $counts->{completed_count},
        steps_skipped => $counts->{skipped_count},
        completed_count => $counts->{completed_count},
        skipped_count => $counts->{skipped_count},
        total => $counts->{total},
        completion_percent => $completion_percent,
        current_module => $current_module,
        current_tier => $current_tier,
        current_step_key => $current_step_key,
        current_step_title => $current_step_title,
        modules_total => $modules_total,
        modules_completed => $modules_completed,
        module_breakdown => $module_breakdown
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
        my $normalized_summary = $self->_normalize_progress_summary($summary, $summary_counts, $completed, $skipped);
        my $data = {
            updated_at => $entry->{updated_at} || time,
            signature_hash => $signature_hash,
            completed => $completed,
            skipped => $skipped,
            summary_counts => $summary_counts,
            summary => $normalized_summary
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
        my $identity = $self->_authenticated_user_identity();
        unless (($identity->{borrowernumber} || '') ne '' || ($identity->{userid} || '') ne '') {
            $response = { ok => 0, error => 'Not authenticated staff session.' };
            $status = '401 Unauthorized';
            return;
        }
        my $read = $self->_read_json_body();
        unless ($read->{ok}) {
            $response = { ok => 0, error => $read->{error}, details => $read->{details} };
            $status = $read->{status} || '400 Bad Request';
            return;
        }
        my $payload = $read->{data} || {};
        unless ($self->_csrf_ok($payload)) {
            $response = { ok => 0, error => 'Invalid CSRF token', csrf_debug => $self->_csrf_debug_info() };
            $status = '403 Forbidden';
            return;
        }
        delete $payload->{csrf_token} if $payload && ref $payload eq 'HASH';
        if (exists $payload->{signature} && ref $payload->{signature}) {
            $response = { ok => 0, error => 'Invalid signature type. Expected string.' };
            $status = '422 Unprocessable Entity';
            return;
        }
        if (exists $payload->{completed} && ref $payload->{completed} && ref $payload->{completed} ne 'ARRAY') {
            $response = { ok => 0, error => 'Invalid completed type. Expected array of step keys.' };
            $status = '422 Unprocessable Entity';
            return;
        }
        if (exists $payload->{skipped} && ref $payload->{skipped} && ref $payload->{skipped} ne 'ARRAY') {
            $response = { ok => 0, error => 'Invalid skipped type. Expected array of step keys.' };
            $status = '422 Unprocessable Entity';
            return;
        }
        if (exists $payload->{summary_counts} && ref $payload->{summary_counts} && ref $payload->{summary_counts} ne 'HASH') {
            $response = { ok => 0, error => 'Invalid summary_counts type. Expected object.' };
            $status = '422 Unprocessable Entity';
            return;
        }

        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        my $borrowernumber = $identity->{borrowernumber} || '';
        my $userid = $identity->{userid} || $self->_current_user_id() || '';
        my $user_key = $borrowernumber || $userid || '';
        if (!$user_key) {
            my $session_id = $self->_session_id();
            $user_key = $session_id ? "session:$session_id" : '';
        }
        $user_key = 'anonymous' unless $user_key;

        try {
            $self->_maybe_migrate_guide_progress();
        } catch {
            $self->_debug_log($settings, "guide_progress_update migration error: $_");
        };

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
        my $summary = $payload->{summary};
        if ($summary && ref $summary ne 'HASH' && !ref $summary) {
            try {
                $summary = from_json($summary);
            } catch {
                $summary = {};
            };
        }
        $summary = {} unless $summary && ref $summary eq 'HASH';
        $summary = $self->_normalize_progress_summary($summary, $summary_counts, $completed, $skipped);
        $summary_counts = {
            completed_count => $summary->{completed_count} || 0,
            skipped_count => $summary->{skipped_count} || 0,
            total => $summary->{total} || 0
        };

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
            summary_counts => $summary_counts,
            summary => $summary
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
    return $self->_json_response($status, $response);
}
sub guide_progress_list {
    my ( $self, $args ) = @_;
    return $self->_json_error('405 Method Not Allowed', 'Method not allowed')
        unless $self->_require_method('GET');

    return $self->_json_error('401 Unauthorized', 'Not authenticated staff session.')
        unless $self->_is_authenticated_staff_session();
    my ($response, $status);
    try {
        my $settings = {};
        try {
            $settings = $self->_load_settings();
        } catch {
            $settings = $self->_default_settings();
        };
        $settings = {} unless $settings && ref $settings eq 'HASH';
        try {
            $self->_maybe_migrate_guide_progress();
        } catch {
            $self->_debug_log($settings, "guide_progress_list migration error: $_");
        };

        my $progress_map = $self->_load_guide_progress_map($settings);
        $progress_map = {} unless $progress_map && ref $progress_map eq 'HASH';

        my $build_row = sub {
            my ($userid, $name, $entry) = @_;
            $entry = {} unless $entry && ref $entry eq 'HASH';
            my $summary_counts = $entry->{summary_counts};
            if (!$summary_counts || ref $summary_counts ne 'HASH') {
                $summary_counts = $self->_summary_counts_from_payload(undef, $entry->{completed}, $entry->{skipped});
            }
            my $summary = $self->_normalize_progress_summary($entry->{summary}, $summary_counts, $entry->{completed}, $entry->{skipped});
            my $updated_at = looks_like_number($entry->{updated_at}) ? int($entry->{updated_at}) : 0;
            return {
                userid => $userid || '',
                name => $name || '',
                updated_at => $updated_at,
                summary_counts => $summary_counts,
                summary => $summary
            };
        };

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
            my $patron;
            if ($requested =~ /^\d+$/) {
                $patron = Koha::Patrons->find($requested);
            } elsif ($requested !~ /^session:/) {
                $patron = Koha::Patrons->find({ userid => $requested });
            }
            my $userid = $patron ? ($patron->userid || '') : ($requested =~ /^session:/ ? '' : $requested);
            my $name = $patron ? ($patron->surname . ', ' . ($patron->firstname || '')) : ($requested =~ /^session:/ ? 'Session user' : '');
            my $entry = {};
            if ($requested ne '' && exists $progress_map->{$requested}) {
                $entry = $progress_map->{$requested};
            } elsif ($patron && $patron->borrowernumber && exists $progress_map->{ $patron->borrowernumber }) {
                $entry = $progress_map->{ $patron->borrowernumber };
            } elsif ($userid ne '' && exists $progress_map->{$userid}) {
                $entry = $progress_map->{$userid};
            }
            push @rows, $build_row->($userid, $name, $entry);
            $response = { ok => 1, users => \@rows, progress => ($entry || {}) };
            $status = '200 OK';
            return;
        }

        my %excluded;
        my $exclude_raw = join(',', $settings->{guide_users} || '', $settings->{guide_exclusion_list} || '');
        for my $item (split(/\s*,\s*/, $exclude_raw)) {
            next unless defined $item;
            $item =~ s/^\s+|\s+$//g;
            next unless $item ne '';
            $excluded{$item} = 1;
        }

        my $patrons = Koha::Patrons->search({}, { order_by => 'userid' });
        while (my $patron = $patrons->next) {
            my $userid = $patron->userid || '';
            next unless $userid;
            next if $excluded{$userid};
            my $borrowernumber = $patron->borrowernumber || '';
            my $entry = {};
            if ($borrowernumber ne '' && exists $progress_map->{$borrowernumber}) {
                $entry = $progress_map->{$borrowernumber};
            } elsif (exists $progress_map->{$userid}) {
                $entry = $progress_map->{$userid};
            }
            my $name = $patron->surname . ', ' . ($patron->firstname || '');
            push @rows, $build_row->($userid, $name, $entry);
        }

        @rows = sort {
            lc($a->{userid} || '') cmp lc($b->{userid} || '')
                || lc($a->{name} || '') cmp lc($b->{name} || '')
        } @rows;

        $response = { ok => 1, users => \@rows };
        $response->{progress} = {} unless @rows;
        $status = '200 OK';
    } catch {
        my $message = "$_";
        $message =~ s/\s+$//;
        warn "AutoPunctuation guide_progress_list error: $message";
        $response = { ok => 0, error => 'Request failed. Check server logs for details.' };
        $status = '500 Internal Server Error';
    };
    return $self->_json_response($status, $response);
}

1;
