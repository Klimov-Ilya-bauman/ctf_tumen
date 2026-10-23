<?php

require __DIR__ . '/jwt.php';

function reports_dir()
{
    return getenv('REPORTS_DIR') ?: '/data/reports';
}

function audit_log($gameId, $alg, $outcome)
{
    $dir = dirname(reports_dir()) . '/audit';
    @mkdir($dir, 0775, true);
    $line = sprintf("%s\tgame_id=%d\talg=%s\toutcome=%s\n", date('c'), $gameId, $alg, $outcome);
    @file_put_contents($dir . '/php-auth.log', $line, FILE_APPEND | LOCK_EX);
}

$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$token = '';
if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    $token = $m[1];
} else {
    $token = $_GET['token'] ?? ($_POST['token'] ?? '');
}

if ($token === '') {
    http_response_code(400);
    echo json_encode(['error' => 'missing token']);
    return;
}

try {
    $claims = verify_government_token($token);
} catch (\Exception $e) {

    http_response_code(403);
    echo json_encode(['error' => 'invalid token']);
    return;
}

$gameId = (int) ($claims['game_id'] ?? 0);

$path = reports_dir() . '/' . $gameId . '.json';
$report = @file_get_contents($path);

if ($report === false) {
    audit_log($gameId, $alg, 'not_found');
    http_response_code(404);
    echo json_encode(['error' => 'report not ready']);
    return;
}

audit_log($gameId, $alg, 'granted');
echo $report;
