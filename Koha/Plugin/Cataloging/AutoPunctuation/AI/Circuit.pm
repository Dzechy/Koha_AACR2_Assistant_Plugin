package Koha::Plugin::Cataloging::AutoPunctuation::AI::Circuit;

use Modern::Perl;
use Time::HiRes qw(time);

sub _circuit_key {
    my ($self, $provider, $model) = @_;
    return join(':', ($provider || 'openai'), ($model || 'default'));
}
sub _circuit_state {
    my ($self, $key, $settings) = @_;
    if ($self->_cache_backend()) {
        my $cache_key = $self->_cache_key('circuit', $key || 'default');
        my $state = $self->_cache_get_backend($cache_key);
        $state = {} unless $state && ref $state eq 'HASH';
        $state->{failures} ||= 0;
        $state->{open_until} ||= 0;
        $state->{history} ||= [];
        $state->{_cache_key} = $cache_key;
        return $state;
    }
    $CIRCUIT_BREAKER{$key} ||= { failures => 0, open_until => 0, history => [] };
    return $CIRCUIT_BREAKER{$key};
}
sub _circuit_save {
    my ($self, $state, $settings) = @_;
    return unless $state && ref $state eq 'HASH' && $state->{_cache_key};
    my $window = $settings->{ai_circuit_breaker_window_seconds} || 120;
    my $timeout = $settings->{ai_circuit_breaker_timeout} || 60;
    my $ttl = ($window > $timeout ? $window : $timeout) + 60;
    my $cache_key = delete $state->{_cache_key};
    $self->_cache_set_backend($cache_key, $state, $ttl);
    $state->{_cache_key} = $cache_key;
}
sub _circuit_prune_history {
    my ($self, $state, $settings) = @_;
    my $window = $settings->{ai_circuit_breaker_window_seconds} || 120;
    my $cutoff = time - $window;
    $state->{history} = [ grep { $_->{time} && $_->{time} >= $cutoff } @{ $state->{history} || [] } ];
}
sub _circuit_failure_rate_exceeded {
    my ($self, $state, $settings) = @_;
    my $history = $state->{history} || [];
    my $min_samples = $settings->{ai_circuit_breaker_min_samples} || 4;
    return 0 if scalar(@{$history}) < $min_samples;
    my $failures = scalar grep { !$_->{ok} } @{$history};
    my $rate = $failures / scalar(@{$history});
    my $threshold = $settings->{ai_circuit_breaker_failure_rate};
    $threshold = 0.5 unless defined $threshold;
    return $rate >= $threshold ? 1 : 0;
}
sub _circuit_breaker_ok {
    my ($self, $settings, $key) = @_;
    my $state = $self->_circuit_state($key, $settings);
    if ($state->{open_until} && time < $state->{open_until}) {
        return 0;
    }
    if ($state->{open_until} && time >= $state->{open_until}) {
        $state->{failures} = 0;
        $state->{open_until} = 0;
        $state->{history} = [];
        $self->_circuit_save($state, $settings);
    }
    return 1;
}
sub _record_failure {
    my ($self, $settings, $key) = @_;
    my $state = $self->_circuit_state($key, $settings);
    $state->{failures}++;
    push @{ $state->{history} }, { time => time, ok => 0 };
    $self->_circuit_prune_history($state, $settings);
    my $threshold = $settings->{ai_circuit_breaker_threshold} || 3;
    my $timeout = $settings->{ai_circuit_breaker_timeout} || 60;
    if ($state->{failures} >= $threshold || $self->_circuit_failure_rate_exceeded($state, $settings)) {
        $state->{open_until} = time + $timeout;
    }
    $self->_circuit_save($state, $settings);
}
sub _record_success {
    my ($self, $settings, $key) = @_;
    my $state = $self->_circuit_state($key, $settings);
    $state->{failures} = 0;
    push @{ $state->{history} }, { time => time, ok => 1 };
    $self->_circuit_prune_history($state, $settings);
    $state->{open_until} = 0 if $state->{open_until} && time >= $state->{open_until};
    $self->_circuit_save($state, $settings);
}

1;
