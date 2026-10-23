<?php

require __DIR__ . '/db.php';
require __DIR__ . '/jwt.php';
require __DIR__ . '/cookie.php';

function safe_return_to($value)
{
    if ($value === '' || $value[0] !== '/') {
        return '/';
    }
    if (isset($value[1]) && $value[1] === '/') {

        return '/';
    }
    return $value;
}

$returnTo = safe_return_to((string) ($_GET['return_to'] ?? '/'));

$code = read_remember_cookie();

$userId = null;
if ($code !== null) {
    $pdo = auth_db();
    $userId = remember_find_active($pdo, $code);
}

if ($userId !== null) {
    $jwt = mint_session($userId);
    set_session_cookie($jwt);
    header('Location: ' . $returnTo, true, 302);
} else {
    clear_session_cookie();
    clear_remember_cookie();
    header('Location: /login?return_to=' . rawurlencode($returnTo), true, 302);
}
