<?php
// webdesk/wordpress/test/sdk-timeout-probe.php
//
// M6-P5d — php-cli probe for the vendored SDK's constructor timeout. No network: only the
// constructor is exercised.
//
//   php test/sdk-timeout-probe.php        (exit 0 = all checks passed)
declare(strict_types=1);

require_once __DIR__ . '/../theme/gaiada-webdesk/vendor/gaiada-sdk/sdk.php';

use GaiadaWebDesk\Sdk\WebDeskClient;

$failures = 0;
$checksRun = 0;
function check(bool $ok, string $label): void
{
    global $failures, $checksRun;
    $checksRun++;
    echo ($ok ? 'PASS' : 'FAIL') . "  {$label}\n";
    if (!$ok) {
        $failures++;
    }
}

$threw = false;
try {
    new WebDeskClient('https://x', 'k', 0.0);
} catch (\InvalidArgumentException $e) {
    $threw = $e->getMessage() === 'timeoutSeconds must be positive';
}
check($threw, 'timeout: a zero timeout throws InvalidArgumentException');

$threwNegative = false;
try {
    new WebDeskClient('https://x', 'k', -1.5);
} catch (\InvalidArgumentException $e) {
    $threwNegative = true;
}
check($threwNegative, 'timeout: a negative timeout throws InvalidArgumentException');

$ok = false;
try {
    $client = new WebDeskClient('https://x', 'k');
    $ok = $client instanceof WebDeskClient;
} catch (\Throwable $e) {
    $ok = false;
}
check($ok, 'timeout: the default (5.0 s) constructs without error');

echo "\n" . ($failures === 0 ? "ALL PASS — {$checksRun} checks run." : "{$failures} FAILED of {$checksRun}.") . "\n";
exit($failures === 0 ? 0 : 1);
