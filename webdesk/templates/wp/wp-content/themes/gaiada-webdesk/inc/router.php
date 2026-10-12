<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/router.php
//
// M6-P5a — request routing for the headless theme. A plain PHP class with NO WordPress dependency,
// so every outcome can be proven with php-cli alone (test/router-probe.php). WordPress glue
// (functions.php) is thin: one `template_redirect` hook hands the request path to Router::handle().
//
// Default route map: `/` -> collection "pages", slug "home"; `/{slug}/` -> collection "pages",
// slug {slug}. An optional locale prefix (`/id/...`) is active only when GAIADA_WEBDESK_LOCALES is
// set; any listed locale (the default one included) is accepted as a prefix, and an unprefixed
// path means the FIRST (default) locale. GAIADA_WEBDESK_ROUTES replaces the map (see config.php).
//
// Outcomes: 200 rendered blocks · 404 no route / item absent / collection absent from the SDK ·
// 502 /v1 errored or timed out · 503 not configured · 405 non-GET/HEAD · 500 theme bug while
// rendering. Never echoes the API key or an upstream error body — the 502 page is static text.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/layout.php';
require_once __DIR__ . '/block-renderer.php';

/** The item does not exist (or the tenant has no such collection). */
final class ItemNotFound extends \RuntimeException
{
}

/** /v1 errored, timed out or was unreachable. Carry no upstream body. */
final class UpstreamUnavailable extends \RuntimeException
{
}

final class Router
{
    private Config $config;
    /** @var callable(string,string,?string):array<string,mixed> */
    private $fetch;
    /** @var callable(string):void */
    private $log;
    /** @var array<string,array<string,mixed>> per-request memo, keyed collection|slug|locale */
    private array $memo = [];

    /**
     * @param callable(string $collection, string $slug, ?string $locale): array<string,mixed> $fetch
     *        returns an ItemEnvelope; throws ItemNotFound or UpstreamUnavailable
     * @param (callable(string):void)|null $log defaults to error_log
     */
    public function __construct(Config $config, callable $fetch, ?callable $log = null)
    {
        $this->config = $config;
        $this->fetch = $fetch;
        $this->log = $log ?? static function (string $m): void {
            error_log($m);
        };
    }

    /**
     * @return array{collection:string,slug:string,locale:?string}|null
     */
    public function match(string $path): ?array
    {
        $q = strcspn($path, '?#');
        $path = substr($path, 0, $q);
        $segments = $path === '' ? [] : explode('/', trim($path, '/'));
        if ($segments === [''] ) {
            $segments = [];
        }
        $clean = [];
        foreach ($segments as $s) {
            $s = rawurldecode($s);
            if (preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $s) !== 1) {
                return null; // empty, dot-leading, or any unexpected character: never reaches /v1
            }
            $clean[] = $s;
        }

        $locale = $this->config->defaultLocale();
        if ($this->config->locales() !== [] && $clean !== [] && in_array($clean[0], $this->config->locales(), true)) {
            $locale = $clean[0];
            array_shift($clean);
        }

        foreach ($this->config->routes() as $route) {
            $pattern = array_values(array_filter(explode('/', $route['pattern']), static fn ($s) => $s !== ''));
            if (count($pattern) !== count($clean)) {
                continue;
            }
            $slug = $route['slug'];
            $hit = true;
            foreach ($pattern as $i => $seg) {
                if ($seg === '{slug}') {
                    $slug = $clean[$i];
                } elseif ($seg !== $clean[$i]) {
                    $hit = false;
                    break;
                }
            }
            if ($hit && $slug !== null) {
                return ['collection' => $route['collection'], 'slug' => $slug, 'locale' => $locale];
            }
        }
        return null;
    }

    /**
     * @return array{status:int,title:string,body:string,headers:array<string,string>,lang:string}
     */
    public function handle(string $method, string $path): array
    {
        $method = strtoupper($method);
        if ($method !== 'GET' && $method !== 'HEAD') {
            return $this->page(405, 'Method not allowed', '<h1>Method not allowed</h1>', ['Allow' => 'GET, HEAD']);
        }
        if (!$this->config->isConfigured()) {
            $names = '';
            foreach ($this->config->problems() as $name => $why) {
                $names .= '<li><code>' . $this->e($name) . '</code> (' . $this->e($why) . ')</li>';
            }
            return $this->page(
                503,
                'WebDesk is not configured',
                '<h1>WebDesk is not configured</h1><p>This site renders from WebDesk and cannot show content until '
                . 'these settings are provided in <code>wp-config.php</code> or the environment:</p><ul>' . $names . '</ul>',
                ['Retry-After' => '300'],
            );
        }

        $route = $this->match($path);
        if ($route === null) {
            return $this->notFound();
        }

        try {
            $item = $this->item($route['collection'], $route['slug'], $route['locale']);
        } catch (ItemNotFound) {
            return $this->notFound();
        } catch (\Throwable $e) {
            // Class name only — never the message, which may carry upstream detail.
            ($this->log)('[gaiada-webdesk] /v1 request failed (' . get_class($e) . ') for ' . $route['collection'] . '/' . $route['slug']);
            return $this->page(
                502,
                'Content temporarily unavailable',
                '<h1>Content temporarily unavailable</h1><p>This page could not be loaded right now. Please try again shortly.</p>',
            );
        }

        try {
            $blocks = is_array($item['blocks'] ?? null) ? $item['blocks'] : [];
            $body = '';
            if (!empty($item['meta']['draft'])) {
                $body .= '<div class="gaiada-draft-banner">Draft preview</div>';
            }
            $body .= gaiada_render_blocks($blocks, $route['collection'], $route['slug']);
        } catch (\Throwable $e) {
            ($this->log)('[gaiada-webdesk] render failed (' . get_class($e) . ') for ' . $route['collection'] . '/' . $route['slug']);
            return $this->page(500, 'Something went wrong', '<h1>Something went wrong</h1>');
        }

        $seoTitle = is_array($item['seo'] ?? null) && is_string($item['seo']['title'] ?? null) ? $item['seo']['title'] : '';
        $title = $seoTitle !== '' ? $seoTitle : $route['slug'];
        $lang = $route['locale'] ?? (is_string($item['locale'] ?? null) ? $item['locale'] : 'en');
        return ['status' => 200, 'title' => $title, 'body' => $body, 'headers' => [], 'lang' => $lang];
    }

    /** @return array<string,mixed> */
    private function item(string $collection, string $slug, ?string $locale): array
    {
        $key = $collection . '|' . $slug . '|' . ($locale ?? '');
        return $this->memo[$key] ??= ($this->fetch)($collection, $slug, $locale);
    }

    /** @return array{status:int,title:string,body:string,headers:array<string,string>,lang:string} */
    private function notFound(): array
    {
        return $this->page(404, 'Page not found', '<h1>Page not found</h1><p>There is nothing at this address.</p>');
    }

    /**
     * @param array<string,string> $headers
     * @return array{status:int,title:string,body:string,headers:array<string,string>,lang:string}
     */
    private function page(int $status, string $title, string $body, array $headers = []): array
    {
        return ['status' => $status, 'title' => $title, 'body' => $body, 'headers' => $headers, 'lang' => $this->config->defaultLocale() ?? 'en'];
    }

    private function e(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    }
}
