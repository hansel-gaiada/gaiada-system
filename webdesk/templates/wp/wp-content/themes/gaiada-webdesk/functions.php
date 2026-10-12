<?php
// Gaiada WebDesk headless theme (M6-P5a). The WordPress glue: deliberately thin. All logic lives in
// inc/ and is testable with php-cli alone (webdesk/wordpress/test/*-probe.php).
//
// Every front-end request is handed to Router on `template_redirect` and ends there (exit), so
// content NEVER falls through to WordPress posts/pages. Configuration is read from wp-config.php
// constants then getenv() — never from the database (see inc/config.php).
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

require_once __DIR__ . '/inc/block-vocabulary.php';
require_once __DIR__ . '/inc/block-renderer.php';
require_once __DIR__ . '/inc/config.php';
require_once __DIR__ . '/inc/layout.php';
require_once __DIR__ . '/inc/router.php';
require_once __DIR__ . '/inc/sdk-transport.php';

if (is_admin()) {
    require_once __DIR__ . '/inc/settings-page.php';
}

add_action('template_redirect', __NAMESPACE__ . '\\gaiada_webdesk_serve', 0);

function gaiada_webdesk_serve(): void
{
    // Not "content": WordPress's own robots.txt / favicon / feed handlers keep working.
    if (is_robots() || is_favicon() || is_feed()) {
        return;
    }

    $config = Config::fromEnvironment();
    if ($config->isConfigured()) {
        $fetch = gaiada_webdesk_sdk_fetcher($config);
    } else {
        // Never called: Router answers 503 before it routes when the config has problems.
        $fetch = static function (): array {
            throw new UpstreamUnavailable('not configured');
        };
    }

    $uriPath = (string) wp_parse_url((string) wp_unslash($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $homePath = rtrim((string) wp_parse_url(home_url('/'), PHP_URL_PATH), '/');
    if ($homePath !== '' && str_starts_with($uriPath, $homePath)) {
        $uriPath = substr($uriPath, strlen($homePath));
    }

    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $result = (new Router($config, $fetch))->handle($method, $uriPath);

    status_header($result['status']);
    if ($result['status'] !== 200) {
        nocache_headers();
    }
    foreach ($result['headers'] as $name => $value) {
        header($name . ': ' . $value);
    }
    header('Content-Type: text/html; charset=utf-8');

    if ($method !== 'HEAD') {
        ob_start();
        wp_head();
        $head = (string) ob_get_clean();
        ob_start();
        wp_footer();
        $foot = (string) ob_get_clean();
        echo gaiada_webdesk_document($result['title'], $result['body'], $result['lang'], $head, $foot);
    }
    exit;
}
