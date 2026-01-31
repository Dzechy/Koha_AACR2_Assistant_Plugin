package Koha::Plugin::Cataloging::AutoPunctuation::Security;

use Modern::Perl;
use C4::Auth;
use C4::Context;
use Koha::Token;
use CGI;
use Try::Tiny;
use Digest::SHA qw(sha256);
use MIME::Base64 qw(encode_base64 decode_base64);
use Crypt::Mode::CBC;
use Crypt::PRNG;

sub _session_id {
    my ($self) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $session_id = '';
    try {
        if (C4::Auth->can('get_session')) {
            my $session = C4::Auth::get_session($cgi);
            if ($session) {
                $session_id = eval { $session->id } || '';
                if (!$session_id && $session->can('param')) {
                    $session_id = $session->param('_session_id') || $session->param('id') || '';
                }
            }
        }
    } catch {
        $session_id = '';
    };
    $session_id ||= scalar $cgi->cookie('CGISESSID') || '';
    if (!$session_id) {
        for my $name ($cgi->cookie) {
            next unless $name && $name =~ /sess/i;
            my $value = scalar $cgi->cookie($name);
            if ($value) {
                $session_id = $value;
                last;
            }
        }
    }
    return $session_id || '';
}
sub _csrf_ok {
    my ($self, $payload) = @_;
    my $cgi = $self->{'cgi'} || CGI->new;
    my $csrf_token = '';
    if ($payload && ref $payload eq 'HASH' && defined $payload->{csrf_token}) {
        $csrf_token = $payload->{csrf_token};
    }
    if (!$csrf_token) {
        $csrf_token = $cgi->http('X-CSRF-Token')
            || $cgi->http('CSRF-TOKEN')
            || $ENV{HTTP_X_CSRF_TOKEN}
            || $ENV{HTTP_CSRF_TOKEN}
            || '';
    }
    if (!$csrf_token) {
        $csrf_token = $cgi->param('csrf_token') || '';
    }
    $csrf_token =~ s/^\s+|\s+$//g if defined $csrf_token;
    return 0 unless $csrf_token;

    my $session_id = $self->_session_id();
    return 0 unless $session_id;

    my $ok = 0;
    try {
        $ok = Koha::Token->new->check_csrf({
            session_id => $session_id,
            token      => $csrf_token,
        }) ? 1 : 0;
    } catch {
        $ok = 0;
    };
    return $ok;
}
sub _secret_present {
    my ($self, $value) = @_;
    return ($value && $value ne '') ? 1 : 0;
}
sub _secret_is_encrypted {
    my ($self, $value) = @_;
    return 0 unless defined $value && $value ne '';
    return $value =~ /^(KOHAENC|ENCv1|ENCv2):/ ? 1 : 0;
}
sub _koha_encryptor {
    my ($self) = @_;
    my $crypt;
    try {
        require Koha::Encryption;
        $crypt = Koha::Encryption->new;
    } catch {
        $crypt = undef;
    };
    return $crypt;
}
sub _encryption_secret {
    my ($self) = @_;
    my $secret = C4::Context->config('encryption_key') // '';
    $secret =~ s/^\s+|\s+$//g;
    return '' unless $secret;
    return '' if $secret =~ /^(changeme|change_me|replace_me|your_secret_here|set_me|set_this|encryption_key)$/i;
    return $secret;
}
sub _encryption_error_message {
    return 'Koha encryption_key is not configured in koha-conf.xml';
}
sub _encrypt_secret {
    my ($self, $plaintext) = @_;
    return undef unless defined $plaintext && $plaintext ne '';
    my $secret = $self->_encryption_secret();
    return undef unless $secret;
    if (my $crypt = $self->_koha_encryptor()) {
        return 'KOHAENC:' . $crypt->encrypt_hex($plaintext);
    }
    my $key = sha256($secret);
    my $iv = Crypt::PRNG::random_bytes(12);
    my $gcm;
    try {
        require Crypt::Mode::GCM;
        $gcm = Crypt::Mode::GCM->new('AES');
    } catch {
        $gcm = undef;
    };
    if ($gcm) {
        my $tag;
        my $ciphertext = $gcm->encrypt($plaintext, $key, $iv, '', $tag);
        return 'ENCv2:' . encode_base64($iv . $tag . $ciphertext, '');
    }
    $iv = Crypt::PRNG::random_bytes(16);
    my $cbc = Crypt::Mode::CBC->new('AES', 1);
    my $ciphertext = $cbc->encrypt($plaintext, $key, $iv);
    return 'ENCv1:' . encode_base64($iv . $ciphertext, '');
}
sub _decrypt_secret {
    my ($self, $ciphertext) = @_;
    return '' unless defined $ciphertext && $ciphertext ne '';
    if ($ciphertext =~ /^PLAINTEXT:(.*)$/s) {
        return '';
    }
    if ($ciphertext =~ /^KOHAENC:(.+)$/) {
        return '' unless $self->_encryption_secret();
        my $crypt = $self->_koha_encryptor();
        return '' unless $crypt;
        my $decoded = $1;
        my $plaintext;
        try {
            $plaintext = $crypt->decrypt_hex($decoded);
        } catch {
            $plaintext = '';
        };
        return $plaintext // '';
    }
    if ($ciphertext =~ /^ENCv1:(.+)$/) {
        my $secret = $self->_encryption_secret();
        return '' unless $secret;
        my $raw = decode_base64($1);
        return '' unless defined $raw && length($raw) > 16;
        my $iv = substr($raw, 0, 16);
        my $encrypted = substr($raw, 16);
        my $cbc = Crypt::Mode::CBC->new('AES', 1);
        my $plaintext = '';
        try {
            $plaintext = $cbc->decrypt($encrypted, sha256($secret), $iv);
        } catch {
            $plaintext = '';
        };
        return $plaintext // '';
    }
    if ($ciphertext =~ /^ENCv2:(.+)$/) {
        my $secret = $self->_encryption_secret();
        return '' unless $secret;
        my $raw = decode_base64($1);
        return '' unless defined $raw && length($raw) > 28;
        my $iv = substr($raw, 0, 12);
        my $tag = substr($raw, 12, 16);
        my $encrypted = substr($raw, 28);
        my $gcm;
        try {
            require Crypt::Mode::GCM;
            $gcm = Crypt::Mode::GCM->new('AES');
        } catch {
            $gcm = undef;
        };
        return '' unless $gcm;
        my $plaintext = '';
        try {
            $plaintext = $gcm->decrypt($encrypted, sha256($secret), $iv, '', $tag);
        } catch {
            $plaintext = '';
        };
        return $plaintext // '';
    }
    return '';
}
sub _obfuscate_secret {
    my ($self, $plaintext, $seed) = @_;
    return '' unless defined $plaintext && $plaintext ne '';
    my $mask = defined $seed ? $seed : 73;
    my $obfuscated = join('', map { chr(ord($_) ^ $mask) } split //, $plaintext);
    return encode_base64($obfuscated, '');
}
sub _migrate_secret {
    my ($self, $value, $errors) = @_;
    return '' unless defined $value && $value ne '';
    if ($value =~ /^PLAINTEXT:(.*)$/s) {
        my $plaintext = $1;
        unless ($self->_encryption_secret()) {
            push @{$errors}, $self->_encryption_error_message()
                if $errors && ref $errors eq 'ARRAY';
            return $value;
        }
        my $encrypted = $self->_encrypt_secret($plaintext);
        return $encrypted if defined $encrypted && $encrypted ne '' && $encrypted !~ /^PLAINTEXT:/;
        return $value;
    }
    if ($self->_secret_is_encrypted($value)) {
        if ($value =~ /^ENCv1:/) {
            my $plaintext = $self->_decrypt_secret($value);
            my $encrypted = $self->_encrypt_secret($plaintext);
            return $encrypted if defined $encrypted && $encrypted ne '';
        }
        return $value;
    }
    unless ($self->_encryption_secret()) {
        push @{$errors}, $self->_encryption_error_message()
            if $errors && ref $errors eq 'ARRAY';
        return $value;
    }
    my $encrypted = $self->_encrypt_secret($value);
    return $encrypted if defined $encrypted && $encrypted ne '';
    push @{$errors}, $self->_encryption_error_message()
        if $errors && ref $errors eq 'ARRAY';
    return $value;
}

1;
