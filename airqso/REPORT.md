# AirQSO — Отчёт по сервису (CTF A/D)

**Дата:** 2026-10-23
**Сервис:** airqso
**Ответственный:** Ilya Klimov (Blue Team)
**Ветка:** Ilya_klim_airqso

---

## 1. Описание сервиса

**AirQSO** — веб-приложение, симулирующее радиолюбительскую связь (QSO — двусторонний радиоконтакт). Пользователи регистрируют радиостанции с позывными, устанавливают связи через сеть ретрансляторов по карте России, обмениваются зашифрованными сообщениями, получают QSL-карточки подтверждения.

**Репозиторий автора:** `github.com/lciga/AirQSO`

### 1.1 Архитектура

| Контейнер | Образ / target | Порт | Назначение |
|---|---|---|---|
| **postgres** | postgres:18.6-alpine | 5432 (internal) | БД, хранит всё состояние |
| **migrate** | Dockerfile target `migrate` | — | Прогоняет SQL-миграции при старте |
| **radiod** | Dockerfile target `radiod` | 9000 (internal), 9001 (observer) | Радио-демон: топология, маршрутизация передач, RDX/1 протокол |
| **web** | Dockerfile target `web` | 8080 (HTTP API + SPA) | HTTP-сервер, бизнес-логика, WebSocket |

Все бинарники — Go, предкомпилированы (`FROM scratch`). **Исходный код отсутствует** — только `build/web`, `build/radiod`, `build/migrate`, `build/radioctl`, `build/healthprobe`.

### 1.2 Внутренние пакеты (по strings из бинарников)

| Пакет | Назначение |
|---|---|
| `internal/accounts` | Регистрация, логин, logout, список станций |
| `internal/api` | HTTP API handlers |
| `internal/auth` | Аутентификация, сессии |
| `internal/bots` | Боты-станции для имитации активности |
| `internal/config` | Конфигурация из env |
| `internal/gamemap` | Карта (russia.svg, viewbox 1000x600) |
| `internal/httpserver` | HTTP сервер |
| `internal/operator` | **Ключевой пакет** — Record, Route, Card, File, Diagnostic, History, Ticket |
| `internal/pagination` | Курсорная пагинация |
| `internal/qsl` | QSL-карточки (HTML/PNG рендер) |
| `internal/qso` | QSO-сессии, сообщения, broadcasts, workers |
| `internal/radio/aircrypto` | **Кастомное шифрование AIR-XOR/1** |
| `internal/radio/rdx` | Протокол RDX/1 между web и radiod |
| `internal/radio/rdxclient` | Клиент RDX/1 |
| `internal/radio/topology` | Граф ретрансляторов, маршрутизация (Dijkstra) |
| `internal/radio/topologyview` | Представление топологии для API |
| `internal/realtime` | WebSocket hub, real-time события |
| `internal/recovery` | Восстановление состояния после рестарта |
| `internal/station` | Управление станциями |

### 1.3 Топология

16 ретрансляторов (8 пар primary/backup) по 8 федеральным округам. Связаны двунаправленными линками с весами (задержки в мс). При передаче строится маршрут через граф ретрансляторов.

### 1.4 API endpoints (из фронтенда и strings)

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/v1/auth/login` | Аутентификация |
| POST | `/api/v1/auth/register` | Регистрация |
| POST | `/api/v1/auth/logout` | Выход |
| GET | `/api/v1/me` | Текущий пользователь |
| GET | `/api/v1/stations?cursor=&search=` | Список станций (пагинация) |
| GET | `/api/v1/topology` | Топология ретрансляторов |
| GET | `/api/v1/qsos` | Список QSO текущего пользователя |
| POST | `/api/v1/qsos` | Создание QSO (вызов станции) |
| POST | `/api/v1/qsos/{id}/{action}` | Переход состояния QSO (accept/reject/abort/close/confirm/resume) |
| PUT | `/api/v1/qsos/{id}/report` | Отчёт о качестве связи (readability 1-5) |
| POST | `/api/v1/qsos/{id}/messages` | Отправка сообщения в QSO |
| GET | `/api/v1/qsos/{id}/messages` | Получение сообщений QSO |
| GET | `/api/v1/qsos/{id}/routes` | Маршруты передачи QSO |
| GET | `/api/v1/broadcasts` | Широковещания |
| POST | `/api/v1/broadcasts` | Отправка broadcast |
| GET | `/api/v1/qsl` | QSL-карточки |
| GET | `/api/v1/qsl/{id}/html` | QSL-карточка в HTML |
| GET | `/api/v1/qsl/{id}/png` | QSL-карточка в PNG |
| WS | `/api/v1/ws` | WebSocket (realtime events) |
| GET | `/health/live` | Health check |
| — | `:9090` | Prometheus metrics |
| — | `:9001` | Observer endpoint (radiod) |

**Заголовки:** `Idempotency-Key` (UUID) для POST-запросов.

### 1.5 Секреты / конфигурация

| Переменная | Назначение |
|---|---|
| `AIRQSO_POSTGRES_PASSWORD` | Пароль БД |
| `AIRQSO_RADIO_SERVICE_TOKEN` | Авторизация web → radiod |
| `AIRQSO_MESSAGE_CIPHER_KEY` | Ключ шифрования сообщений (AIR-XOR/1) |
| `AIRQSO_OBSERVER_SECRET` | Секрет для observer endpoint |
| `AIRQSO_COOKIE_SECURE` | Secure flag для cookies |

### 1.6 Схема БД (10 миграций)

**Основные таблицы:**
- `users` — логин, normalized_login, password_hash (argon2)
- `stations` — позывной (5 символов), координаты, district, kind (human/bot)
- `sessions` — token_hash, user_id, expires_at
- `login_rate_limits` — защита от брутфорса
- `qsos` — QSO-сессии с FSM (calling→active→closing→completed/rejected/aborted/expired)
- `messages` — сообщения в QSO (text varchar(2048))
- `transmissions` — маршрутизация через ретрансляторы (topology_version, route_snapshot)
- `outbox` — очередь исходящих передач
- `broadcasts` — широковещания (recipients по радиусу)
- `qso_reports` — отчёты о качестве (readability 1-5)
- `qsl_cards` — QSL-карточки (snapshot jsonb)
- **`station_packets`** — **payload с TTL 24h, привязан к owner_station_id и bot_station_id**
- **`card_notes`** — **payload с TTL 24h, привязан к card_id и owner_station_id**
- **`route_packets`** — **payload с TTL 24h, привязан к owner/recipient station и terminal_repeater**
- `idempotency_keys` — дедупликация запросов
- `bot_state` — состояние ботов
- `radio_runtime_state` — singleton состояние радио-движка
- `broadcast_recipients` — получатели broadcast по distance_squared

---

## 2. Место хранения флагов (ГИПОТЕЗА)

Наиболее вероятные таблицы для хранения CTF-флагов (данные с TTL 24h):

1. **`station_packets`** — payload привязан к owner_station_id + bot_station_id
2. **`card_notes`** — payload привязан к card_id + owner_station_id
3. **`route_packets`** — payload привязан к owner/recipient station + terminal_repeater_id

SQL-запрос из бинарника:
```sql
SELECT id,owner_station_id,payload,created_at
FROM station_packets
WHERE id=$1 AND owner_station_id=$2 AND expires_at>now()
```

Checker скорее всего: регистрирует пользователя → создаёт станцию → инициирует QSO/broadcast → кладёт payload (флаг) → проверяет его получение.

---

## 3. Найденные уязвимости и вектора атак

### V-001: AIR-XOR/1 — кастомный XOR-шифр (CRITICAL)

**Тип:** Broken Cryptography
**Пакет:** `internal/radio/aircrypto`
**Функции:** `Cipher.Encrypt`, `Cipher.qsoKey`
**Статус:** HYPOTHESIS — требует проверки

**Описание:** Сервис использует кастомный шифр `AIR-XOR/1` (строка из бинарника). XOR-шифрование **криптографически тривиально ломается**:
- Если ключ короче данных — повторяющийся ключ восстанавливается через known-plaintext attack
- XOR одноразовый блокнот (OTP) безопасен только при ключе >= длины сообщения и однократном использовании
- `qsoKey` — вероятно, derives per-QSO key из `AIRQSO_MESSAGE_CIPHER_KEY`

**Вектор атаки:**
1. Перехватить зашифрованные сообщения (через API `/api/v1/qsos/{id}/messages` или WebSocket)
2. Если известен формат plaintext (например, формат флага) — извлечь ключ через XOR с known plaintext
3. Расшифровать payload → получить флаги

**Рекомендация для защиты:** Заменить AIR-XOR/1 на AES-GCM. **Но осторожно** — checker может зависеть от текущего формата.

---

### V-002: Отсутствие проверки принадлежности при чтении QSO/сообщений (HYPOTHESIS)

**Тип:** Broken Access Control / IDOR
**Статус:** HYPOTHESIS — требует black-box тестирования

**Описание:** SQL-запросы из бинарника показывают, что QSO проверяется на принадлежность:
```sql
WHERE q.id=$1 AND $2 IN(q.station_low_id,q.station_high_id) FOR UPDATE OF q
```
Однако нужно проверить, применяется ли эта проверка на **всех** эндпоинтах. Потенциально уязвимые:
- `GET /api/v1/qsos/{id}/messages` — можно ли читать чужие сообщения?
- `GET /api/v1/qsos/{id}/routes` — можно ли видеть чужие маршруты?
- `GET /api/v1/qsl/{id}/html|png` — можно ли просматривать чужие QSL-карточки?
- `GET /api/v1/broadcasts` — broadcast доступен всем получателям, но проверяется ли recipient?

**Вектор атаки:** Перебор UUID QSO других пользователей для получения их сообщений (флагов).

---

### V-003: Observer endpoint без аутентификации (HYPOTHESIS)

**Тип:** Information Disclosure / Unauthorized Access
**Порт:** 9001

**Описание:** `AIRQSO_OBSERVER_SECRET` — опциональный (в compose `${AIRQSO_OBSERVER_SECRET:-}`). Если пустой, observer endpoint открыт без авторизации. Observer может давать:
- Состояние топологии
- Передачи в реальном времени
- Runtime state

**Рекомендация:** Установить `AIRQSO_OBSERVER_SECRET` в непустое значение. Закрыть порт 9001 извне.

---

### V-004: Metrics endpoint без аутентификации (CONFIRMED)

**Тип:** Information Disclosure
**Порт:** 9090 (web)

**Описание:** Prometheus metrics (`AIRQSO_METRICS_ADDRESS=:9090`) содержат:
- `airqso_bots_due` — количество ботов
- `airqso_transmission_duration_seconds` — длительность передач
- Потенциально информацию о пользователях, QSO, состоянии системы

**Рекомендация:** Закрыть порт 9090 от внешнего доступа (сейчас не проброшен в compose — проверить network policy).

---

### V-005: COOKIE_SECURE=false (CONFIRMED)

**Тип:** Insecure Session Management
**Файл:** `.env`

**Описание:** `AIRQSO_COOKIE_SECURE=false` — cookie сессии передаётся по HTTP без флага Secure. В CTF-контексте (HTTP без TLS) это ожидаемо, но:
- Сессионный token может быть перехвачен при MitM
- Нет информации о флагах HttpOnly, SameSite

---

### V-006: Предсказуемость UUID ботов (HYPOTHESIS)

**Тип:** IDOR / Enumeration
**Статус:** HYPOTHESIS

**Описание:** Боты создаются при старте сервиса через `seed bots`. Их station_id, callsign и позиции могут быть предсказуемы/статичны между рестартами. Флаги checker'а могут помещаться через ботов (station_packets имеет `bot_station_id`).

**Вектор:** Если ID ботов предсказуемы → можно обращаться к station_packets ботов напрямую.

---

### V-007: QSL-карточка — возможный SSTI/XSS через HTML template (HYPOTHESIS)

**Тип:** Template Injection / XSS
**Строка:** `TEMPLATE 01`, `initialize QSL renderer`

**Описание:** QSL-карточки рендерятся через HTML-шаблон (`TEMPLATE 01`), затем конвертируются в PNG. Если данные пользователя (callsign, сообщения) подставляются без экранирования:
- SSTI → RCE (Go template injection)
- XSS → кража сессий при просмотре `/api/v1/qsl/{id}/html`

**Вектор:** Создать QSO с вредоносным callsign или сообщением → открыть QSL → проверить инъекцию.

---

### V-008: Operator package — чтение файлов / path traversal (HYPOTHESIS)

**Тип:** Path Traversal / Arbitrary File Read
**Функции:** `operator.CreateFile`, `operator.File`, `operator.assetPath`, `operator.decodeAssetReference`

**Описание:** Пакет operator работает с файлами (`AIRQSO_QSL_ASSET_DIR`, `AIRQSO_ARCHIVE_DIR`, `AIRQSO_CAPSULE_DIR`). Функции `decodeAssetReference` и `assetPath` парсят пути. Если входные данные не санитизированы:
- Path traversal через `../` → чтение произвольных файлов (включая `/app/config/topology/topology.json`, `.env` если доступен)
- Чтение capsules/archive других пользователей

---

### V-009: WebSocket — отсутствие rate limiting (HYPOTHESIS)

**Тип:** DoS / Resource Exhaustion
**Endpoint:** `/api/v1/ws`

**Описание:** WebSocket соединение для realtime-событий. Если нет ограничения на:
- Количество одновременных WS-соединений от одного пользователя
- Rate of messages
- → можно вызвать DoS сервиса, потерять SLA

---

### V-010: RDX/1 протокол — Man-in-the-Middle (HYPOTHESIS)

**Тип:** Protocol Weakness
**Между:** web ↔ radiod (порт 9000)

**Описание:** Кастомный TCP-протокол `RDX/1` между web и radiod. Авторизация через `AIRQSO_RADIO_SERVICE_TOKEN`. Если атакующий получает доступ к внутренней сети Docker:
- Перехват/подмена передач
- Инъекция fake topology events
- Прямой доступ к radiod без web

---

### V-011: Предсказуемый формат callsign — enumeration (LOW)

**Тип:** Enumeration
**Constraint:** `callsign ~ '^[A-Z0-9]{5}$'` + минимум 1 буква + минимум 1 цифра

**Описание:** Пространство позывных ограничено (~24M вариантов). Можно перебрать все станции через `/api/v1/stations?search=`.

---

### V-012: Idempotency key — replay (LOW)

**Тип:** Business Logic
**Constraint:** `key ~ '^[A-Za-z0-9._:-]{16,128}$'`, TTL по `expires_at`

**Описание:** Idempotency-key генерируется клиентом (`crypto.randomUUID()`). Если перехватить ключ и запрос до expiry — можно получить cached response (включая данные других пользователей, если кэш не привязан к user).

---

## 4. Приоритеты для проверки

| # | Уязвимость | Приоритет | Следующий шаг |
|---|---|---|---|
| V-001 | AIR-XOR/1 шифр | **P0** | Поднять сервис, перехватить шифротекст, проверить XOR |
| V-002 | IDOR на QSO/messages | **P0** | Black-box: читать чужие QSO по UUID |
| V-008 | Path traversal в operator | **P1** | Протестировать `../` в asset references |
| V-003 | Observer без auth | **P1** | Проверить порт 9001 без секрета |
| V-007 | QSL template injection | **P1** | Создать QSO с `{{.}}` и HTML-тегами |
| V-006 | Предсказуемые ID ботов | **P2** | Проверить station_packets через API |
| V-005 | Cookie Secure=false | **P2** | Проверить HttpOnly, SameSite |
| V-009 | WS rate limit | **P2** | Flood test |
| V-010 | RDX/1 MitM | **P2** | Проверить при доступе к Docker network |
| V-004 | Metrics exposure | **P3** | Проверить, проброшен ли 9090 |

---

## 5. Рекомендации по защите (что патчить)

1. **Критично:** Заменить AIR-XOR/1 на AES-256-GCM — **но только если checker не зависит от формата шифротекста**
2. **Критично:** Проверить ACL на всех API endpoints — каждый запрос должен валидировать owner
3. Установить `AIRQSO_OBSERVER_SECRET` и не пробрасывать 9001 наружу
4. Не пробрасывать 9090 (metrics) наружу
5. Проверить санитизацию путей в operator package
6. Добавить rate limiting на WebSocket

---

## 6. Следующие шаги

- [ ] Поднять сервис локально (`docker compose up -d`)
- [ ] Black-box тестирование всех API endpoints
- [ ] Проверить V-001: перехватить сообщения, попробовать XOR-decrypt
- [ ] Проверить V-002: IDOR на чужие QSO
- [ ] Реверс AIR-XOR/1 через Ghidra/radare2 для точного понимания алгоритма
- [ ] Написать PoC эксплойтов для подтверждённых уязвимостей
