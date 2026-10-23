<?php

header('Content-Type: application/json');

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

switch ($path) {
    case '/api/auth/register':
        require __DIR__ . '/../register.php';
        break;

    case '/api/auth/login':
        require __DIR__ . '/../login.php';
        break;

    case '/api/auth/logout':
        require __DIR__ . '/../logout.php';
        break;

    case '/api/auth/refresh':
        require __DIR__ . '/../refresh.php';
        break;

    case '/report':
        require __DIR__ . '/../report.php';
        break;

    case '/internal/session-key':
        require __DIR__ . '/../session_key.php';
        break;

    case '/health':
        echo json_encode(['status' => 'ok']);
        break;

    default:
        http_response_code(404);
        echo json_encode(['error' => 'not found']);
}
