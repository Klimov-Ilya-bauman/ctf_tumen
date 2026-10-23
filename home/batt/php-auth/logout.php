<?php

require __DIR__ . '/db.php';
require __DIR__ . '/cookie.php';

$code = read_remember_cookie();
if ($code !== null) {
    $pdo = auth_db();
    remember_delete_one($pdo, $code);
}

clear_remember_cookie();
clear_session_cookie();
http_response_code(204);
