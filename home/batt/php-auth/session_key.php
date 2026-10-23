<?php

require __DIR__ . '/jwt.php';

header('Content-Type: text/plain');
echo JWTKeys::SESSION_PUBLIC_KEY;
