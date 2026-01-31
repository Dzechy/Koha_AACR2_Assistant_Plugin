use strict;
use warnings;
use Test::More;

use lib 'Koha/Plugin';

BEGIN {
    eval { require Koha::Plugins::Base; 1 } or do {
        plan skip_all => 'Koha modules not available in this environment.';
        exit;
    };
    eval { require Koha::Plugin::Cataloging::AutoPunctuation; 1 } or do {
        plan skip_all => 'AutoPunctuation plugin module not available.';
        exit;
    };
}

my $plugin = bless {}, 'Koha::Plugin::Cataloging::AutoPunctuation';

{
    no warnings 'redefine';
    local *C4::Context::config = sub { return ''; };
    is($plugin->_encryption_secret(), '', 'encryption secret empty when config missing');
}

{
    no warnings 'redefine';
    local *C4::Context::config = sub { return 'changeme'; };
    is($plugin->_encryption_secret(), '', 'encryption secret empty when placeholder is configured');
}

{
    no warnings 'redefine';
    local *C4::Context::config = sub { return 'secure-key-123'; };
    is($plugin->_encryption_secret(), 'secure-key-123', 'uses encryption_key from koha-conf.xml');
}

done_testing();
