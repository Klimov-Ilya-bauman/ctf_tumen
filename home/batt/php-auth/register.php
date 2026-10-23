<?php

require __DIR__ . '/db.php';
require __DIR__ . '/validate.php';
require __DIR__ . '/jwt.php';
require __DIR__ . '/cookie.php';

$body = json_decode(file_get_contents('php://input'), true) ?: [];
$username = (string) ($body['username'] ?? '');
$password = (string) ($body['password'] ?? '');

if ($error = validate_credentials($username, $password)) {
    http_response_code(400);
    echo json_encode(['error' => $error]);
    return;
}

$pdo = auth_db();

$hash = password_hash($password, PASSWORD_ARGON2ID);

try {
    $stmt = $pdo->prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    $stmt->execute([$username, $hash]);
} catch (PDOException $e) {

    if ($e->errorInfo[1] === 1062) {
        http_response_code(409);
        echo json_encode(['error' => 'username already taken']);
        return;
    }
    throw $e;
}

$userId = (int) $pdo->lastInsertId();

$rememberCode = remember_new_code($userId);
remember_create($pdo, $userId, $rememberCode);
set_remember_cookie($rememberCode);

$jwt = mint_session($userId);
set_session_cookie($jwt);

http_response_code(201);

echo json_encode(['id' => (int) remember_obfuscate_id($userId), 'username' => $username]);
