<?php
// Required by WordPress for every theme. Never reached in normal operation: functions.php hands
// every front-end request to the WebDesk router on `template_redirect` and exits. If this file is
// ever rendered, that hook did not run, so answer honestly rather than showing a blank page.
declare(strict_types=1);

status_header(503);
echo '<!doctype html><title>WebDesk theme not active</title><h1>WebDesk theme not active</h1>';
