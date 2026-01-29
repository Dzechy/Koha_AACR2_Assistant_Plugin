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

is(
    $plugin->_validate_regex_pattern('[A-Z]+', 'Rule test tag_pattern'),
    '',
    'accepts a valid regex'
);
like(
    $plugin->_validate_regex_pattern('([A-Z]+)+', 'Rule test tag_pattern'),
    qr/too long or complex/i,
    'rejects nested quantifiers'
);
like(
    $plugin->_validate_regex_pattern('([A-Z]', 'Rule test tag_pattern'),
    qr/invalid/i,
    'rejects invalid regex'
);

my $schema = {
    type => 'object',
    required => ['foo'],
    additionalProperties => 0,
    properties => {
        foo => { type => 'string', maxLength => 5 }
    }
};

my @errors;
$plugin->_validate_schema_node($schema, { foo => 'bar' }, '$', \@errors);
is(scalar @errors, 0, 'schema accepts valid object');

@errors = ();
$plugin->_validate_schema_node($schema, { foo => 'toolong' }, '$', \@errors);
ok(
    scalar grep { /at most 5 characters/ } @errors,
    'schema enforces maxLength'
);

@errors = ();
$plugin->_validate_schema_node($schema, { foo => 'ok', extra => 1 }, '$', \@errors);
ok(
    scalar grep { /unexpected property/ } @errors,
    'schema rejects additional properties'
);

my $lc_candidates_range = $plugin->_extract_lc_call_numbers('Suggested LC: RC 123.6-125', {});
is_deeply(
    $lc_candidates_range,
    [],
    'ignores LC classification ranges'
);

my $lc_candidates_single = $plugin->_extract_lc_call_numbers('Suggested LC: RC 123.6', {});
is_deeply(
    $lc_candidates_single,
    ['RC 123.6'],
    'extracts single LC candidate'
);

my $normalized = $plugin->_normalize_ai_request_payload({
    request_id => 'test',
    tag_context => {
        tag => '245',
        occurrence => '2',
        subfields => [ { code => 'a', value => 'Title' }, { code => 'b', value => 'Subtitle' } ]
    },
    record_context => {
        fields => [
            { tag => '245', occurrence => '2', subfields => [ { code => 'a', value => 'Title' } ] }
        ]
    },
    features => { punctuation_explain => '1' }
});
is(
    $normalized->{tag_context}{occurrence},
    2,
    'normalizes tag context occurrence to number'
);
is(
    $normalized->{record_context}{fields}[0]{occurrence},
    2,
    'normalizes record context occurrence to number'
);
ok(
    exists $normalized->{features}{subject_guidance},
    'normalizes missing feature flags'
);

{
    my $json = "{\n\"request_id\":\"psgi-test\",\n\"tag_context\":{\"tag\":\"245\",\"occurrence\":0,\"subfields\":[{\"code\":\"a\",\"value\":\"Title\"}]}\n}";
    open my $fh, '<', \$json or die "open scalar: $!";
    local *PSGI_IN = $fh;
    local $ENV{'psgi.input'} = 'PSGI_IN';
    local $ENV{CONTENT_LENGTH} = 0;
    my $payload = $plugin->_read_json_payload();
    is($payload->{request_id}, 'psgi-test', 'slurps multiline JSON when content length is 0');
}

{
    my $payload = {
        request_id => 'prompt-test',
        tag_context => {
            tag => '245',
            ind1 => '1',
            ind2 => '0',
            occurrence => 0,
            subfields => [
                { code => 'a', value => 'Main title' },
                { code => 'b', value => 'Subtitle' },
                { code => 'c', value => 'Statement of responsibility' }
            ]
        },
        features => { subject_guidance => 1, call_number_guidance => 1, punctuation_explain => 0 }
    };
    my $settings = { ai_subject_guidance => 1, ai_callnumber_guidance => 1 };
    my $filtered = $plugin->_cataloging_tag_context($payload->{tag_context});
    my $source_result = $plugin->_cataloging_source_from_tag_context($filtered);
    my $prompt = $plugin->_build_ai_prompt_cataloging($payload, $settings, {
        source => $source_result->{source},
        tag_context => $filtered
    });
    like($prompt, qr/Use ONLY this source text for inference: Main title Subtitle Statement of responsibility/, 'cataloging prompt includes computed source');
    like($prompt, qr/proposed_fixes MUST be \[\]/, 'cataloging prompt forbids patches');
}

{
    my $text = "Classification: QA 76.73\nSubjects: Cats; Dogs\nConfidence: 82%";
    my $extracted = $plugin->_extract_cataloging_suggestions_from_text($text, {});
    is($extracted->{classification}, 'QA 76.73', 'extracts classification from labeled text');
    is_deeply($extracted->{subjects}, ['Cats', 'Dogs'], 'extracts subject headings from labeled text');
    is($extracted->{confidence_percent}, 82, 'extracts confidence percent from text');
}

done_testing();
