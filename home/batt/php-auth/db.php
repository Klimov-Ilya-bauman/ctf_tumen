<?php

function auth_db()
{
    $host = getenv('DB_HOST') ?: 'mysql';
    $name = getenv('DB_NAME') ?: 'battleships';
    $user = getenv('DB_USER') ?: 'battleships';
    $pass = getenv('DB_PASSWORD') ?: '';

    $dsn = "mysql:host={$host};dbname={$name};charset=utf8mb4";

    return new PDO($dsn, $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
}
