<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/settings-page.php
//
// M6-P5a — Settings -> WebDesk. READ-ONLY: it shows what wp-config.php / the environment say and
// can run one "Test connection" call. It registers no setting, saves no option and writes nothing
// to the database (the test result is rendered in the same response, not stored). The key is never
// displayed — only whether one is present. Needs WordPress (admin hooks); loaded only from
// functions.php, never by the php-cli probes.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/sdk-transport.php';

add_action('admin_menu', static function (): void {
    add_options_page('WebDesk', 'WebDesk', 'manage_options', 'gaiada-webdesk', __NAMESPACE__ . '\\gaiada_webdesk_render_settings_page');
});

function gaiada_webdesk_render_settings_page(): void
{
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You do not have permission to view this page.'), '', ['response' => 403]);
    }
    $config = Config::fromEnvironment();

    $result = null;
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['gaiada_webdesk_test'])) {
        check_admin_referer('gaiada_webdesk_test_connection'); // nonce; dies on failure
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You do not have permission to do that.'), '', ['response' => 403]);
        }
        $result = gaiada_webdesk_test_connection($config);
    }

    $rows = [
        'Base URL' => $config->baseUrl() !== '' ? $config->baseUrl() : '(not set)',
        'Tenant' => $config->tenant() !== '' ? $config->tenant() : '(not set)',
        'Locales' => $config->locales() !== [] ? implode(', ', $config->locales()) . ' (default: ' . $config->defaultLocale() . ')' : '(none: single locale)',
        'API key' => $config->hasApiKey() ? 'present' : 'missing',
        'Routes' => count($config->routes()) . ' route(s)',
    ];

    echo '<div class="wrap"><h1>WebDesk</h1>';
    echo '<p>Read-only. Configure with <code>GAIADA_WEBDESK_*</code> constants in <code>wp-config.php</code> or environment variables; nothing here is stored in the database.</p>';
    if (!$config->isConfigured()) {
        echo '<div class="notice notice-error"><p>Not configured. Problems: ';
        $parts = [];
        foreach ($config->problems() as $name => $why) {
            $parts[] = esc_html($name . ' (' . $why . ')');
        }
        echo implode(', ', $parts) . '</p></div>';
    }
    echo '<table class="widefat striped" style="max-width:640px"><tbody>';
    foreach ($rows as $label => $value) {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html($value) . '</td></tr>';
    }
    echo '</tbody></table>';

    echo '<form method="post" style="margin-top:1em">';
    wp_nonce_field('gaiada_webdesk_test_connection');
    echo '<input type="hidden" name="gaiada_webdesk_test" value="1">';
    submit_button('Test connection', 'secondary', 'submit', false, $config->isConfigured() ? [] : ['disabled' => 'disabled']);
    echo '</form>';

    if ($result !== null) {
        $class = $result['ok'] ? 'notice-success' : 'notice-error';
        echo '<div class="notice ' . esc_attr($class) . '"><p>Test connection: ' . esc_html($result['message']) . '</p></div>';
    }
    echo '</div>';
}
