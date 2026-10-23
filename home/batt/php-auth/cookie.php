<?php

require_once __DIR__ . '/jwt.php';
require_once __DIR__ . '/remember.php';

function set_session_cookie($jwt)
{
    setcookie('session', $jwt, array(
        'expires' => time() + SESSION_TTL_SECONDS,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function clear_session_cookie()
{
    setcookie('session', '', array(
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function read_session_cookie()
{
    return isset($_COOKIE['session']) ? $_COOKIE['session'] : null;
}

function set_remember_cookie($code)
{
    setcookie(REMEMBER_COOKIE_NAME, remember_encode_cookie($code), array(
        'expires' => time() + REMEMBER_TTL_DAYS * 24 * 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function clear_remember_cookie()
{
    setcookie(REMEMBER_COOKIE_NAME, '', array(
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ));
}

function read_remember_cookie()
{
    return isset($_COOKIE[REMEMBER_COOKIE_NAME]) ? $_COOKIE[REMEMBER_COOKIE_NAME] : null;
}
