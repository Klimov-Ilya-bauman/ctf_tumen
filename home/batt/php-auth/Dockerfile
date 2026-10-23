FROM php:8.2-cli
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
RUN docker-php-ext-install pdo_mysql
WORKDIR /app
COPY . .

RUN curl -fsSL https://storage.yandexcloud.net/ural/btsxp6fy/JWT.php -o JWT.php

EXPOSE 8080
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public", "router.php"]
