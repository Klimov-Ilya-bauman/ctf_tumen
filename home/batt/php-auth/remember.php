<?php

const REMEMBER_TTL_DAYS = 30;
const REMEMBER_SECRET_LEN = 32;
const REMEMBER_COOKIE_NAME = 'remember';
const REMEMBER_VERSION = '1.3';
const REMEMBER_ID_DIGITS = 6;

const REMEMBER_HASH_DOMAIN = 1000000;
const REMEMBER_HASH_HALF = 1024;
const REMEMBER_HASH_KEYS = array(0x9E37, 0x85EB, 0xC2B2, 0x27D4);

function _remember_hash_round($x, $k)
{
    $x = ($x * 0x45D9F3B + $k) & 0xFFFFFFFF;
    $x ^= $x >> 15;
    $x = ($x * 0x2C1B3C6D) & 0xFFFFFFFF;
    $x ^= $x >> 12;
    return $x % REMEMBER_HASH_HALF;
}

function _remember_feistel($v)
{
    $l = $v >> 10;
    $r = $v & 1023;
    foreach (REMEMBER_HASH_KEYS as $k) {
        $next = $l ^ _remember_hash_round($r, $k);
        $l = $r;
        $r = $next;
    }
    return ($l << 10) | $r;
}

function remember_obfuscate_id($userId)
{
    $v = _remember_feistel($userId);
    while ($v >= REMEMBER_HASH_DOMAIN) {
        $v = _remember_feistel($v);
    }
    return str_pad((string) $v, REMEMBER_ID_DIGITS, '0', STR_PAD_LEFT);
}

function remember_new_code($userId)
{
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    $secret = '';
    for ($i = 0; $i < REMEMBER_SECRET_LEN; $i++) {
        $secret .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    }
    return remember_obfuscate_id($userId) . $secret;
}

function remember_encode_cookie($code)
{
    return base64_encode(json_encode(array('code' => $code, 'version' => REMEMBER_VERSION)));
}

function remember_find_active($pdo, $rawCookie)
{
    $json = base64_decode($rawCookie, true);
    if ($json === false) {
        return null;
    }
    $data = json_decode($json, true);
    if (!is_array($data) || !isset($data['code'])) {
        return null;
    }
    $code = $data['code'];

    $paramType = PDO::PARAM_STR;
    if (gettype($code) === 'integer') {
        $paramType = PDO::PARAM_INT;
    } elseif (gettype($code) === 'boolean') {
        $paramType = PDO::PARAM_BOOL;
    } elseif ($code === null) {
        $paramType = PDO::PARAM_NULL;
    }

    $stmt = $pdo->prepare('SELECT user_id FROM persistences WHERE code = ? AND expires_at > NOW()');
    $stmt->bindValue(1, $code, $paramType);
    $stmt->execute();
    $row = $stmt->fetch();
    return $row ? (int) $row['user_id'] : null;
}

function remember_delete_one($pdo, $rawCookie)
{
    $json = base64_decode($rawCookie, true);
    if ($json === false) {
        return;
    }
    $data = json_decode($json, true);
    if (!is_array($data) || !isset($data['code'])) {
        return;
    }
    $code = $data['code'];

    $paramType = PDO::PARAM_STR;
    if (gettype($code) === 'integer') {
        $paramType = PDO::PARAM_INT;
    } elseif (gettype($code) === 'boolean') {
        $paramType = PDO::PARAM_BOOL;
    } elseif ($code === null) {
        $paramType = PDO::PARAM_NULL;
    }

    $stmt = $pdo->prepare('DELETE FROM persistences WHERE code = ?');
    $stmt->bindValue(1, $code, $paramType);
    $stmt->execute();
}

function remember_create($pdo, $userId, $code)
{
    $stmt = $pdo->prepare(
        'INSERT INTO persistences (user_id, code, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))'
    );
    $stmt->execute(array($userId, $code, REMEMBER_TTL_DAYS));
}
