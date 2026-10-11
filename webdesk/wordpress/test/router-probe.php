<?php
// webdesk/wordpress/test/router-probe.php
//
// M6-P5a — php-cli probe for config + router (no WordPress, no network). The transport is a stub
// injected into Router; nothing here talks to a server.
//
//   php test/router-probe.php        (exit 0 = all checks passed)
declare(strict_types=1);

require_once __DIR__ . '/../theme/gaiada-webdesk/inc/router.php';

use GaiadaWebDesk\Theme\Config;
use GaiadaWebDesk\Theme\ItemNotFound;
use GaiadaWebDesk\Theme\Router;
use GaiadaWebDesk\Theme\UpstreamUnavailable;

use function GaiadaWebDesk\Theme\gaiada_drain_unknown_block_reports;
use function GaiadaWebDesk\Theme\gaiada_webdesk_document;

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

const KEY = 'sk_live_SECRET_KEY_VALUE_123';
$base = [
    'GAIADA_WEBDESK_BASE_URL' => 'https://api.example.test',
    'GAIADA_WEBDESK_TENANT' => 'acme',
    'GAIADA_WEBDESK_API_KEY' => KEY,
];

/** Records calls; answers from $items[collection/slug/locale] or throws. */
function stub(array &$calls, array $items, ?\Throwable $throw = null): callable
{
    return function (string $collection, string $slug, ?string $locale) use (&$calls, $items, $throw): array {
        $calls[] = [$collection, $slug, $locale];
        if ($throw !== null) {
            throw $throw;
        }
        $k = "{$collection}/{$slug}/" . ($locale ?? '');
        if (!isset($items[$k])) {
            throw new ItemNotFound('nope');
        }
        return $items[$k];
    };
}
function item(string $heading, array $extra = []): array
{
    return $extra + [
        'collection' => 'pages', 'slug' => 'x', 'locale' => 'en',
        'seo' => ['title' => 'SEO ' . $heading], 'meta' => ['draft' => false],
        'blocks' => [['type' => 'hero', 'props' => ['heading' => $heading, 'subheading' => 'sub']]],
    ];
}

// --- 1. configuration ------------------------------------------------------------------------
$c = Config::fromValues($base);
check($c->isConfigured(), 'config: all three required values present -> configured');
check($c->defaultLocale() === null && $c->locales() === [], 'config: no locales -> no default locale');
check(Config::fromValues([])->problems() === array_fill_keys(Config::REQUIRED, 'missing'), 'config: empty -> all three reported missing, by name');
check(!Config::fromValues(['GAIADA_WEBDESK_API_KEY' => ''] + $base)->isConfigured(), 'config: empty-string key counts as missing');
check(Config::fromValues(['GAIADA_WEBDESK_BASE_URL' => 'ftp://x'] + $base)->problems() === ['GAIADA_WEBDESK_BASE_URL' => 'invalid'], 'config: non-http base URL is invalid');
check(Config::fromValues(['GAIADA_WEBDESK_BASE_URL' => 'https://api.example.test///'] + $base)->baseUrl() === 'https://api.example.test', 'config: base URL trailing slashes trimmed');
$loc = Config::fromValues(['GAIADA_WEBDESK_LOCALES' => 'en, id ,en'] + $base);
check($loc->locales() === ['en', 'id'] && $loc->defaultLocale() === 'en', 'config: locales parsed, de-duplicated; first is default');
check(Config::fromValues(['GAIADA_WEBDESK_LOCALES' => ['id', 'en']] + $base)->defaultLocale() === 'id', 'config: locales also accepted as a PHP array');
check(Config::fromValues(['GAIADA_WEBDESK_LOCALES' => 'en,<x>'] + $base)->problems() === ['GAIADA_WEBDESK_LOCALES' => 'invalid'], 'config: malformed locale -> invalid');
check(Config::fromValues(['GAIADA_WEBDESK_ROUTES' => '{nope'] + $base)->problems() === ['GAIADA_WEBDESK_ROUTES' => 'invalid'], 'config: broken routes JSON -> invalid');
check(Config::fromValues(['GAIADA_WEBDESK_ROUTES' => '[{"pattern":"/a/{slug}","collection":"x","slug":"y"}]'] + $base)->problems() === ['GAIADA_WEBDESK_ROUTES' => 'invalid'], 'config: route with both {slug} and fixed slug -> invalid');
check(Config::fromValues(['GAIADA_WEBDESK_ROUTES' => '[{"pattern":"/a","collection":"x"}]'] + $base)->problems() === ['GAIADA_WEBDESK_ROUTES' => 'invalid'], 'config: route with no slug source -> invalid');

// fromEnvironment(): constant first, then getenv(); never a database.
define('GAIADA_WEBDESK_TENANT', 'from-constant');
putenv('GAIADA_WEBDESK_TENANT=from-env');
putenv('GAIADA_WEBDESK_BASE_URL=https://env.example.test');
putenv('GAIADA_WEBDESK_API_KEY=' . KEY);
$env = Config::fromEnvironment();
check($env->tenant() === 'from-constant', 'config: a wp-config constant wins over getenv()');
check($env->baseUrl() === 'https://env.example.test' && $env->hasApiKey(), 'config: getenv() is the fallback when no constant is defined');
$usesOption = false;
foreach (glob(__DIR__ . '/../theme/gaiada-webdesk/{*.php,inc/*.php}', GLOB_BRACE) as $f) {
    foreach (token_get_all((string) file_get_contents($f)) as $tok) {
        if (is_array($tok) && $tok[0] === T_STRING && in_array($tok[1], ['get_option', 'update_option', 'add_option', 'register_setting'], true)) {
            $usesOption = true;
        }
    }
}
check(!$usesOption, 'config: no get_option/update_option/add_option/register_setting call anywhere in the theme (code tokens, not comments)');

// --- 2. route matching -----------------------------------------------------------------------
$calls = [];
$r = new Router($c, stub($calls, []));
check($r->match('/') === ['collection' => 'pages', 'slug' => 'home', 'locale' => null], 'route: / -> pages/home');
check($r->match('') === ['collection' => 'pages', 'slug' => 'home', 'locale' => null], 'route: empty path -> pages/home');
check($r->match('/about/') === ['collection' => 'pages', 'slug' => 'about', 'locale' => null], 'route: /about/ -> pages/about');
check($r->match('/about') === $r->match('/about/'), 'route: trailing slash is insignificant');
check($r->match('/about?x=1') === ['collection' => 'pages', 'slug' => 'about', 'locale' => null], 'route: query string ignored');
check($r->match('/a/b') === null, 'route: two segments do not match the default map');
check($r->match('/%2e%2e/x') === null && $r->match('/..') === null && $r->match('/.hidden') === null, 'route: dot / traversal segments never match');
check($r->match('/a%2Fb') === null, 'route: an encoded slash in a segment never matches');
check($r->match('/<script>') === null, 'route: markup characters never match');
check($r->match('/caf%C3%A9') === null, 'route: non-ascii slug rejected before /v1');

// --- 3. locale prefix ------------------------------------------------------------------------
$l = new Router(Config::fromValues(['GAIADA_WEBDESK_LOCALES' => 'en,id'] + $base), stub($calls, []));
check($l->match('/') === ['collection' => 'pages', 'slug' => 'home', 'locale' => 'en'], 'locale: unprefixed -> default (first) locale');
check($l->match('/id/') === ['collection' => 'pages', 'slug' => 'home', 'locale' => 'id'], 'locale: /id/ -> home in id');
check($l->match('/id') === $l->match('/id/'), 'locale: /id == /id/');
check($l->match('/id/about') === ['collection' => 'pages', 'slug' => 'about', 'locale' => 'id'], 'locale: /id/about -> about in id');
check($l->match('/en/about') === ['collection' => 'pages', 'slug' => 'about', 'locale' => 'en'], 'locale: the default locale prefix is accepted too');
check($l->match('/fr/about') === null, 'locale: unlisted prefix + extra segment -> no route');
check($r->match('/id/about') === null, 'locale: with no locales configured, /id/about is just two segments -> no route');

// --- 4. override map -------------------------------------------------------------------------
$routes = '[{"pattern":"/","collection":"pages","slug":"start"},{"pattern":"/blog/{slug}","collection":"article"},{"pattern":"/work/{slug}","collection":"caseStudy"}]';
$o = new Router(Config::fromValues(['GAIADA_WEBDESK_ROUTES' => $routes] + $base), stub($calls, []));
check($o->match('/') === ['collection' => 'pages', 'slug' => 'start', 'locale' => null], 'override: fixed-slug route');
check($o->match('/blog/hello') === ['collection' => 'article', 'slug' => 'hello', 'locale' => null], 'override: /blog/{slug} -> article');
check($o->match('/work/x') === ['collection' => 'caseStudy', 'slug' => 'x', 'locale' => null], 'override: /work/{slug} -> caseStudy');
check($o->match('/about') === null, 'override: REPLACES the default map (/about no longer routes)');

// --- 5. outcomes: 200 / 404 / 502 / 503 / 405 ------------------------------------------------
$calls = [];
$items = ['pages/home/' => item('Home <b>&</b>'), 'pages/about/' => item('About')];
$ok = (new Router($c, stub($calls, $items)))->handle('GET', '/');
check($ok['status'] === 200, '200: item found');
check(str_contains($ok['body'], 'gaiada-block-hero') && str_contains($ok['body'], 'Home &lt;b&gt;&amp;&lt;/b&gt;'), '200: blocks rendered, props HTML-escaped');
check(!str_contains($ok['body'], '<b>'), '200: raw markup from a prop never appears');
check($ok['title'] === 'SEO Home <b>&</b>', '200: title carries the SEO title as data...');
check(str_contains(gaiada_webdesk_document($ok['title'], $ok['body'], 'en'), '<title>SEO Home &lt;b&gt;&amp;&lt;/b&gt;</title>'), '200: ...and the document wrapper escapes it');
check($calls === [['pages', 'home', null]], '200: exactly one transport call, default locale null when none configured');

$draft = (new Router($c, stub($calls, ['pages/home/' => item('H', ['meta' => ['draft' => true]])])))->handle('GET', '/');
check(str_contains($draft['body'], 'gaiada-draft-banner'), '200: a draft item shows the draft banner');

$withUnknown = item('Known', ['blocks' => [['type' => 'hero', 'props' => ['heading' => 'A']], ['type' => 'pricingTable', 'props' => []], ['type' => 'cta', 'props' => ['label' => 'Go', 'href' => '/x']]]]);
gaiada_drain_unknown_block_reports();
$u = (new Router($c, stub($calls, ['pages/home/' => $withUnknown]), static function (string $m): void {}))->handle('GET', '/');
check($u['status'] === 200 && str_contains($u['body'], 'gaiada-block-cta') && !str_contains($u['body'], 'pricingTable'), '200: an unknown block is skipped, later known blocks still render');
check(count(gaiada_drain_unknown_block_reports()) === 1, '200: the unknown block was reported');

$calls = [];
$nf = (new Router($c, stub($calls, $items)))->handle('GET', '/missing');
check($nf['status'] === 404 && str_contains($nf['body'], 'Page not found'), '404: item does not exist -> theme 404 page');
$calls = [];
$nr = (new Router($c, stub($calls, $items)))->handle('GET', '/a/b/c');
check($nr['status'] === 404 && $calls === [], '404: no route -> 404 WITHOUT calling /v1');

$logged = [];
$log = static function (string $m) use (&$logged): void {
    $logged[] = $m;
};
foreach ([
    'upstream error' => new UpstreamUnavailable('upstream said: ' . KEY . ' <html>secret body</html>'),
    'timeout/other' => new RuntimeException('cURL error 28: timed out talking to ' . KEY),
] as $label => $ex) {
    $logged = [];
    $bad = (new Router($c, stub($calls, [], $ex), $log))->handle('GET', '/');
    $all = json_encode([$bad, $logged]);
    check($bad['status'] === 502, "502: {$label} -> 502");
    check(!str_contains((string) $all, KEY) && !str_contains((string) $all, 'secret body') && !str_contains((string) $all, 'cURL'), "502: {$label} -> neither key nor upstream text in the page or the log");
    check(count($logged) === 1 && str_contains($logged[0], get_class($ex)), "502: {$label} -> one log line naming the exception class only");
}

$calls = [];
$un = new Router(Config::fromValues(['GAIADA_WEBDESK_BASE_URL' => '', 'GAIADA_WEBDESK_TENANT' => 'acme'] + $base), stub($calls, $items));
$res = $un->handle('GET', '/');
check($res['status'] === 503 && str_contains($res['body'], 'WebDesk is not configured'), '503: missing base URL -> "WebDesk is not configured"');
check(str_contains($res['body'], 'GAIADA_WEBDESK_BASE_URL') && !str_contains($res['body'], KEY), '503: names the missing setting, never a value');
check($calls === [] && $un->handle('GET', '/anything/at/all')['status'] === 503, '503: every request (even unroutable) is 503, /v1 never called');
$nokey = (new Router(Config::fromValues(['GAIADA_WEBDESK_API_KEY' => ''] + $base), stub($calls, $items)))->handle('GET', '/');
check($nokey['status'] === 503, '503: missing key -> 503');
$badroutes = (new Router(Config::fromValues(['GAIADA_WEBDESK_ROUTES' => 'x'] + $base), stub($calls, $items)))->handle('GET', '/');
check($badroutes['status'] === 503 && str_contains($badroutes['body'], 'GAIADA_WEBDESK_ROUTES'), '503: invalid routes JSON is a configuration error, not a silent fallback');

$post = (new Router($c, stub($calls, $items)))->handle('POST', '/');
check($post['status'] === 405 && ($post['headers']['Allow'] ?? '') === 'GET, HEAD', '405: non-GET/HEAD handled, never falls through to WordPress');
check((new Router($c, stub($calls, $items)))->handle('HEAD', '/')['status'] === 200, 'HEAD routes like GET');

// --- 6. locale reaches the transport; memo ---------------------------------------------------
$calls = [];
$lr = new Router(Config::fromValues(['GAIADA_WEBDESK_LOCALES' => 'en,id'] + $base), stub($calls, ['pages/about/id' => item('Tentang')]));
$idr = $lr->handle('GET', '/id/about');
check($idr['status'] === 200 && $calls === [['pages', 'about', 'id']] && $idr['lang'] === 'id', 'locale: /id/about calls the transport with locale "id"; lang attribute follows');
$calls = [];
$lr2 = new Router(Config::fromValues(['GAIADA_WEBDESK_LOCALES' => 'en,id'] + $base), stub($calls, ['pages/about/id' => item('Tentang')]));
$lr2->handle('GET', '/id/about');
$lr2->handle('GET', '/id/about');
check(count($calls) === 1, 'memo: the same item twice in one Router instance is fetched once');

// --- 7. output escaping of static pages ------------------------------------------------------
$hostile = (new Router(Config::fromValues(['GAIADA_WEBDESK_BASE_URL' => 'https://x.test', 'GAIADA_WEBDESK_TENANT' => 'a b'] + $base), stub($calls, [])))->handle('GET', '/');
check($hostile['status'] === 503 && !str_contains($hostile['body'], '<script'), '503: page contains only static markup + escaped names');
$doc = gaiada_webdesk_document('t', 'b', '"><script>x</script>');
check(!str_contains($doc, '<script>'), 'document: lang attribute is escaped');

echo "\n" . ($failures === 0 ? "ALL PASS — {$checksRun} checks run." : "{$failures} FAILED of {$checksRun}.") . "\n";
exit($failures === 0 ? 0 : 1);
