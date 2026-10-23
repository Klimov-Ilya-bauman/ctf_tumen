<?php

require __DIR__ . '/JWT.php';

const SESSION_TTL_SECONDS = 15 * 60;

function jwt_header_alg($jwt)
{
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
        return null;
    }
    $json = base64_decode(str_replace(['-', '_'], ['+', '/'], $parts[0]));
    $header = json_decode($json, true);
    return is_array($header) ? ($header['alg'] ?? null) : null;
}

function mint_session($userId)
{
    $privateKey = JWTKeys::SESSION_PRIVATE_KEY;
    $now = time();
    $payload = [
        'sub' => (string) $userId,
        'iat' => $now,
        'exp' => $now + SESSION_TTL_SECONDS,
    ];
    return \JWT::encode($payload, $privateKey, 'RS256');
}

function verify_government_token($jwt)
{
    $publicKey = JWTKeys::GOVERNMENT_PUBLIC_KEY;
    $decoded = \JWT::decode($jwt, $publicKey);
    return (array) $decoded;
}
