<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/sdk-transport.php
//
// M6-P5a — the production transport behind Router: adapts the GENERATED PHP SDK
// (vendor/gaiada-sdk/sdk.php, WSK-34) to the Router's fetch contract. No WordPress dependency.
//
// URL shapes are the SDK's own, never built here: `get<Collection>($slug, ['locale' => ...])` ->
// GET /v1/t/{tenant}/{collection}/{slug}?locale=..., and `sitemapXml()` -> GET /v1/t/{tenant}/sitemap.xml
// (used only by the settings page's "Test connection"). No retries, no caching: the SDK makes one
// curl call (its own 10 s timeout) and this adapter makes exactly one SDK call per request.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/router.php';
require_once __DIR__ . '/../vendor/gaiada-sdk/sdk.php';

use GaiadaWebDesk\Sdk\WebDeskApiException;
use GaiadaWebDesk\Sdk\WebDeskClient;

/**
 * @return callable(string,string,?string):array<string,mixed>
 */
function gaiada_webdesk_sdk_fetcher(Config $config): callable
{
    $client = new WebDeskClient($config->baseUrl(), $config->apiKey());
    return static function (string $collection, string $slug, ?string $locale) use ($client): array {
        $method = 'get' . ucfirst($collection);
        if (!is_callable([$client, $method])) {
            // The tenant's contract has no such collection: nothing to render at this address.
            throw new ItemNotFound('collection not in this tenant\'s SDK');
        }
        try {
            return $client->{$method}($slug, $locale !== null ? ['locale' => $locale] : []);
        } catch (WebDeskApiException $e) {
            if ($e->status === 404) {
                throw new ItemNotFound('item not found');
            }
            throw new UpstreamUnavailable('upstream status ' . $e->status);
        } catch (\RuntimeException $e) {
            throw new UpstreamUnavailable('transport failure'); // curl error text is deliberately dropped
        }
    };
}

/**
 * One /v1 call for the settings page. Reports a status code or "no response" — never a body,
 * never the key.
 *
 * @return array{ok:bool,status:?int,message:string}
 */
function gaiada_webdesk_test_connection(Config $config): array
{
    if (!$config->isConfigured()) {
        return ['ok' => false, 'status' => null, 'message' => 'Not configured.'];
    }
    $client = new WebDeskClient($config->baseUrl(), $config->apiKey());
    try {
        $client->sitemapXml($config->defaultLocale() !== null ? ['locale' => $config->defaultLocale()] : []);
        return ['ok' => true, 'status' => 200, 'message' => 'HTTP 200'];
    } catch (WebDeskApiException $e) {
        return ['ok' => false, 'status' => $e->status, 'message' => 'HTTP ' . $e->status];
    } catch (\Throwable $e) {
        return ['ok' => false, 'status' => null, 'message' => 'No response (network error or timeout).'];
    }
}
