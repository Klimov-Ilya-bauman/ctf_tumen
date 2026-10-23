<?php
function validate_credentials($username, $password)
{
    $len = strlen($username);
    $nameOk = $len >= 3 && $len <= 32 && preg_match('/^[A-Za-z0-9_]+$/', $username);
    if (!$nameOk) {
        return 'username must be 3-32 chars: letters, digits, underscore';
    }

    $passLen = strlen($password);
    if ($passLen < 8 || $passLen > 128) {
        return 'password must be 8-128 chars';
    }

    return null;
}
