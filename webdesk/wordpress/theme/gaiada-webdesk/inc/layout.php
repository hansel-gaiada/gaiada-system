<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/layout.php
//
// M6-P5a — the one HTML document wrapper. Pure PHP, no WordPress dependency: the WordPress glue
// (functions.php) passes in whatever wp_head()/wp_footer() printed; everything else is escaped here.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

/**
 * @param string $head   trusted markup from wp_head() (empty outside WordPress)
 * @param string $footer trusted markup from wp_footer() (empty outside WordPress)
 */
function gaiada_webdesk_document(string $title, string $body, string $lang = 'en', string $head = '', string $footer = ''): string
{
    $t = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
    $l = htmlspecialchars($lang !== '' ? $lang : 'en', ENT_QUOTES, 'UTF-8');
    return "<!doctype html>\n<html lang=\"{$l}\">\n<head>\n<meta charset=\"utf-8\">\n"
        . "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        . "<title>{$t}</title>\n{$head}\n</head>\n<body>\n<main class=\"gaiada-webdesk\">\n{$body}\n</main>\n{$footer}\n</body>\n</html>\n";
}
