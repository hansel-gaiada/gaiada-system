<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/config.php
//
// M6-P5a — theme configuration. Pure PHP, no WordPress dependency (testable with php-cli alone).
//
// RULE: configuration never lives in the WordPress database. Every value comes from a
// `wp-config.php` constant, falling back to the process environment (`getenv()`). This theme makes no
// call into the WordPress options API at all, and has no settings form that writes anything.
//
//   GAIADA_WEBDESK_BASE_URL   required  e.g. https://api.erp.gaiada.com   (http/https only)
//   GAIADA_WEBDESK_TENANT     required  the tenant slug the vendored SDK was generated for
//   GAIADA_WEBDESK_API_KEY    required  never displayed, logged or echoed by this theme
//   GAIADA_WEBDESK_LOCALES    optional  "en,id" (or a PHP array); the FIRST is the default locale
//   GAIADA_WEBDESK_ROUTES     optional  JSON route map overriding the default (see below)
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

final class Config
{
    public const REQUIRED = ['GAIADA_WEBDESK_BASE_URL', 'GAIADA_WEBDESK_TENANT', 'GAIADA_WEBDESK_API_KEY'];

    /** @var array<string,string> name => problem ("missing" | "invalid") */
    private array $problems = [];
    private string $baseUrl = '';
    private string $tenant = '';
    private string $apiKey = '';
    /** @var string[] */
    private array $locales = [];
    /** @var array<int,array{pattern:string,collection:string,slug:?string}> */
    private array $routes = [];

    /**
     * @param array<string,mixed> $values name => raw value (constant or env); absent/empty = unset
     */
    public static function fromValues(array $values): self
    {
        $c = new self();

        foreach (self::REQUIRED as $name) {
            $v = $values[$name] ?? null;
            if (!is_string($v) || trim($v) === '') {
                $c->problems[$name] = 'missing';
            }
        }

        $base = $values['GAIADA_WEBDESK_BASE_URL'] ?? null;
        if (is_string($base) && trim($base) !== '') {
            $base = trim($base);
            $scheme = strtolower((string) parse_url($base, PHP_URL_SCHEME));
            if (($scheme === 'http' || $scheme === 'https') && parse_url($base, PHP_URL_HOST)) {
                $c->baseUrl = rtrim($base, '/');
            } else {
                $c->problems['GAIADA_WEBDESK_BASE_URL'] = 'invalid';
            }
        }
        $tenant = $values['GAIADA_WEBDESK_TENANT'] ?? null;
        if (is_string($tenant) && trim($tenant) !== '') {
            $tenant = trim($tenant);
            if (preg_match('/^[A-Za-z0-9][A-Za-z0-9_-]*$/', $tenant) === 1) {
                $c->tenant = $tenant;
            } else {
                $c->problems['GAIADA_WEBDESK_TENANT'] = 'invalid';
            }
        }
        $key = $values['GAIADA_WEBDESK_API_KEY'] ?? null;
        if (is_string($key) && trim($key) !== '') {
            $c->apiKey = trim($key);
        }

        $c->locales = self::parseLocales($values['GAIADA_WEBDESK_LOCALES'] ?? null, $c->problems);
        $c->routes = self::parseRoutes($values['GAIADA_WEBDESK_ROUTES'] ?? null, $c->problems);
        return $c;
    }

    /** Reads wp-config.php constants first, then getenv(). */
    public static function fromEnvironment(): self
    {
        $names = array_merge(self::REQUIRED, ['GAIADA_WEBDESK_LOCALES', 'GAIADA_WEBDESK_ROUTES']);
        $values = [];
        foreach ($names as $name) {
            $v = defined($name) ? constant($name) : null;
            if ($v === null || $v === '' || $v === []) {
                $env = getenv($name);
                $v = $env === false ? null : $env;
            }
            $values[$name] = $v;
        }
        return self::fromValues($values);
    }

    /**
     * @param array<string,string> $problems
     * @return string[]
     */
    private static function parseLocales(mixed $raw, array &$problems): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return [];
        }
        $list = is_array($raw) ? $raw : explode(',', (string) $raw);
        $out = [];
        foreach ($list as $item) {
            $item = is_string($item) ? trim($item) : '';
            if ($item === '') {
                continue;
            }
            if (preg_match('/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/', $item) !== 1) {
                $problems['GAIADA_WEBDESK_LOCALES'] = 'invalid';
                return [];
            }
            if (!in_array($item, $out, true)) {
                $out[] = $item;
            }
        }
        return $out;
    }

    /**
     * Route map: a JSON list of {"pattern": "/blog/{slug}", "collection": "article"}, or a fixed
     * item {"pattern": "/", "collection": "pages", "slug": "home"}. Patterns are literal segments
     * plus at most one `{slug}` segment. The first match wins; a supplied map REPLACES the default.
     *
     * @param array<string,string> $problems
     * @return array<int,array{pattern:string,collection:string,slug:?string}>
     */
    private static function parseRoutes(mixed $raw, array &$problems): array
    {
        if ($raw === null || $raw === '' || $raw === []) {
            return self::defaultRoutes();
        }
        $decoded = is_array($raw) ? $raw : json_decode((string) $raw, true);
        if (!is_array($decoded) || $decoded === [] || array_keys($decoded) !== range(0, count($decoded) - 1)) {
            $problems['GAIADA_WEBDESK_ROUTES'] = 'invalid';
            return self::defaultRoutes();
        }
        $routes = [];
        foreach ($decoded as $r) {
            $pattern = is_array($r) ? ($r['pattern'] ?? null) : null;
            $collection = is_array($r) ? ($r['collection'] ?? null) : null;
            $slug = is_array($r) && array_key_exists('slug', $r) ? $r['slug'] : null;
            $ok = is_string($pattern) && str_starts_with($pattern, '/')
                && is_string($collection) && preg_match('/^[A-Za-z][A-Za-z0-9]*$/', $collection) === 1
                && ($slug === null || (is_string($slug) && preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $slug) === 1));
            $segments = [];
            if ($ok) {
                $segments = array_values(array_filter(explode('/', $pattern), static fn ($s) => $s !== ''));
                $slots = count(array_filter($segments, static fn ($s) => $s === '{slug}'));
                foreach ($segments as $s) {
                    if ($s !== '{slug}' && preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]*$/', $s) !== 1) {
                        $ok = false;
                    }
                }
                // exactly one source for the slug: a `{slug}` segment XOR a fixed "slug".
                $ok = $ok && (($slots === 1 && $slug === null) || ($slots === 0 && $slug !== null));
            }
            if (!$ok) {
                $problems['GAIADA_WEBDESK_ROUTES'] = 'invalid';
                return self::defaultRoutes();
            }
            $routes[] = ['pattern' => '/' . implode('/', $segments), 'collection' => $collection, 'slug' => $slug];
        }
        return $routes;
    }

    /** @return array<int,array{pattern:string,collection:string,slug:?string}> */
    public static function defaultRoutes(): array
    {
        return [
            ['pattern' => '/', 'collection' => 'pages', 'slug' => 'home'],
            ['pattern' => '/{slug}', 'collection' => 'pages', 'slug' => null],
        ];
    }

    /** @return array<string,string> setting NAME => "missing"|"invalid" — never values */
    public function problems(): array
    {
        return $this->problems;
    }

    public function isConfigured(): bool
    {
        return $this->problems === [];
    }

    public function baseUrl(): string
    {
        return $this->baseUrl;
    }

    public function tenant(): string
    {
        return $this->tenant;
    }

    public function apiKey(): string
    {
        return $this->apiKey;
    }

    public function hasApiKey(): bool
    {
        return $this->apiKey !== '';
    }

    /** @return string[] */
    public function locales(): array
    {
        return $this->locales;
    }

    public function defaultLocale(): ?string
    {
        return $this->locales[0] ?? null;
    }

    /** @return array<int,array{pattern:string,collection:string,slug:?string}> */
    public function routes(): array
    {
        return $this->routes;
    }
}
