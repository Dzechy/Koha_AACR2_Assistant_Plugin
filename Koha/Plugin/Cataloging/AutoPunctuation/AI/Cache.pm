package Koha::Plugin::Cataloging::AutoPunctuation::AI::Cache;

use Modern::Perl;
use C4::Context;
use Koha::Patrons;
use CGI;
use JSON qw(to_json from_json);
use Try::Tiny;
use Time::HiRes qw(time);

my %AI_CACHE;
my @AI_CACHE_LRU;
my %RATE_LIMIT;
my %CIRCUIT_BREAKER;

sub _cache_backend {
    my ($self) = @_;
    return $self->{_cache_backend} if exists $self->{_cache_backend};
    my $cache;
    try {
        require Koha::Cache;
        $cache = Koha::Cache->get_instance();
    } catch {
        $cache = undef;
    };
    $self->{_cache_backend} = $cache;
    return $cache;
}
sub _cache_key {
    my ($self, $type, $suffix) = @_;
    $type ||= 'misc';
    $suffix ||= '';
    return join(':', 'aacr2_ai', $type, $suffix);
}
sub _cache_get_backend {
    my ($self, $key) = @_;
    my $cache = $self->_cache_backend();
    return unless $cache;
    return $cache->get_from_cache($key) if $cache->can('get_from_cache');
    return $cache->get($key) if $cache->can('get');
    return;
}
sub _cache_set_backend {
    my ($self, $key, $value, $ttl) = @_;
    my $cache = $self->_cache_backend();
    return unless $cache;
    my $options = {};
    $options->{expiry} = $ttl if defined $ttl;
    if ($cache->can('set_in_cache')) {
        return $cache->set_in_cache($key, $value, $options);
    }
    return $cache->set($key, $value, $options) if $cache->can('set');
    return;
}
sub _cache_get {
    my ($self, $settings, $key) = @_;
    if (my $cache = $self->_cache_backend()) {
        my $cache_key = $self->_cache_key('response', $key);
        return $self->_cache_get_backend($cache_key);
    }
    my $entry = $AI_CACHE{$key};
    return unless $entry;
    if ($entry->{expires} && $entry->{expires} < time) {
        delete $AI_CACHE{$key};
        @AI_CACHE_LRU = grep { $_ ne $key } @AI_CACHE_LRU;
        return;
    }
    $self->_cache_touch($key);
    return $entry->{value};
}
sub _cache_set {
    my ($self, $settings, $key, $value) = @_;
    my $ttl = $settings->{ai_cache_ttl_seconds} || 60;
    if (my $cache = $self->_cache_backend()) {
        my $cache_key = $self->_cache_key('response', $key);
        $self->_cache_set_backend($cache_key, $value, $ttl);
        return;
    }
    $AI_CACHE{$key} = {
        value => $value,
        expires => time + $ttl
    };
    $self->_cache_touch($key);
    $self->_cache_prune($settings);
}
sub _canonical_json {
    my ($self, $data) = @_;
    my $json = JSON->new->canonical(1);
    $json->allow_nonref(1);
    return $json->encode($data);
}
sub _cache_touch {
    my ($self, $key) = @_;
    @AI_CACHE_LRU = grep { $_ ne $key } @AI_CACHE_LRU;
    push @AI_CACHE_LRU, $key;
}
sub _cache_prune {
    my ($self, $settings) = @_;
    my $now = time;
    for my $key (keys %AI_CACHE) {
        if ($AI_CACHE{$key}{expires} && $AI_CACHE{$key}{expires} < $now) {
            delete $AI_CACHE{$key};
            @AI_CACHE_LRU = grep { $_ ne $key } @AI_CACHE_LRU;
        }
    }
    my $limit = $settings->{ai_cache_max_entries} || 250;
    while (@AI_CACHE_LRU > $limit) {
        my $oldest = shift @AI_CACHE_LRU;
        delete $AI_CACHE{$oldest};
    }
}
sub _rate_limit_ok {
    my ($self, $settings, $user_key, $provider) = @_;
    my $limit = $settings->{ai_rate_limit_per_minute} || 6;
    my $now = time;
    my $window = 60;
    if ($self->_cache_backend()) {
        my $cache_key = $self->_cache_key('rate', join(':', $provider || 'openai', $user_key || 'anonymous'));
        my $raw_hits = $self->_cache_get_backend($cache_key);
        my $hits = [];
        if (ref $raw_hits eq 'ARRAY') {
            $hits = $raw_hits;
        } elsif (defined $raw_hits && $raw_hits ne '') {
            try {
                $hits = from_json($raw_hits);
            } catch {
                $hits = [];
                $self->_debug_log($settings, "Rate limit cache corrupted; resetting ($cache_key).");
            };
        }
        $hits = [] unless ref $hits eq 'ARRAY';
        $hits = [ grep { $_ > ($now - $window) } @{$hits} ];
        return 0 if scalar @{$hits} >= $limit;
        push @{$hits}, $now;
        $self->_cache_set_backend($cache_key, to_json($hits), $window);
        return 1;
    }
    $RATE_LIMIT{$provider} ||= {};
    $RATE_LIMIT{$provider}{$user_key} ||= [];
    $RATE_LIMIT{$provider}{$user_key} = [ grep { $_ > ($now - $window) } @{ $RATE_LIMIT{$provider}{$user_key} } ];
    return 0 if scalar @{ $RATE_LIMIT{$provider}{$user_key} } >= $limit;
    push @{ $RATE_LIMIT{$provider}{$user_key} }, $now;
    return 1;
}
sub _current_borrowernumber {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $userenv = C4::Context->userenv;
    if ($userenv && ref $userenv eq 'HASH') {
        return $userenv->{borrowernumber} if $userenv->{borrowernumber};
        my $env_user = $userenv->{userid} || $userenv->{user} || '';
        if ($env_user) {
            my $patron = Koha::Patrons->find({ userid => $env_user });
            return $patron->borrowernumber if $patron && $patron->borrowernumber;
        }
    }
    my $userid = $cgi->remote_user || $ENV{REMOTE_USER} || '';
    if ($userid) {
        my $patron = Koha::Patrons->find({ userid => $userid });
        return $patron->borrowernumber if $patron && $patron->borrowernumber;
    }
    return undef;
}
sub _current_user_key {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $borrowernumber = $self->_current_borrowernumber();
    return $borrowernumber if $borrowernumber;
    my $userenv = C4::Context->userenv;
    if ($userenv && ref $userenv eq 'HASH') {
        my $env_user = $userenv->{userid} || $userenv->{user} || '';
        return $env_user if $env_user;
    }
    my $userid = $cgi->remote_user || $ENV{REMOTE_USER} || '';
    my $session = $self->_session_id();
    return $userid || ($session ? "session:$session" : '') || 'anonymous';
}

1;
