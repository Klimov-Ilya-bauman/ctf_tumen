# AirQSO — Вектора атак для Red Team

**Сервис:** airqso (радиолюбительская связь)
**Порт:** 8080 (HTTP) / на нашей машине — переменная `AIRQSO_WEB_PORT`
**Стек:** Go, PostgreSQL, custom radio protocol RDX/1
**Автор сервиса:** github.com/lciga/AirQSO

---

## Краткое описание

Пользователи регистрируются, получают радиостанцию с позывным (5 символов), устанавливают QSO-связи (радиоконтакты), обмениваются сообщениями, отправляют broadcasts. Есть боты. Сообщения шифруются кастомным AIR-XOR/1 при передаче через радио.

**Флаги скорее всего хранятся в:** `station_packets`, `card_notes`, `route_packets` — таблицы с payload и TTL 24h. Checker создаёт пользователя → станцию → кладёт payload → потом проверяет.

---

## API endpoints

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/api/v1/auth/register` | Регистрация `{login, password}` |
| POST | `/api/v1/auth/login` | Логин `{login, password}` |
| POST | `/api/v1/auth/logout` | Выход |
| GET | `/api/v1/me` | Текущий юзер + станция |
| GET | `/api/v1/stations?cursor=&callsign=` | Список станций (пагинация) |
| GET | `/api/v1/topology` | Топология ретрансляторов |
| POST | `/api/v1/qsos` | Создать QSO `{recipient_callsign}` + `Idempotency-Key: UUID` |
| POST | `/api/v1/qsos/{id}/{action}` | accept/reject/close/confirm/abort/resume |
| POST | `/api/v1/qsos/{id}/messages` | Отправить сообщение `{text}` + `Idempotency-Key` |
| GET | `/api/v1/qsos/{id}/messages` | Читать сообщения QSO |
| GET | `/api/v1/qsos/{id}/routes` | Маршруты передач |
| PUT | `/api/v1/qsos/{id}/report` | Отчёт readability |
| POST | `/api/v1/broadcasts` | Broadcast `{text}` + `Idempotency-Key` |
| GET | `/api/v1/broadcasts?cursor=` | Читать broadcasts |
| GET | `/api/v1/qsl` | QSL-карточки |
| GET | `/api/v1/qsl/{id}/html` | Карточка HTML |
| GET | `/api/v1/qsl/{id}/png` | Карточка PNG |
| WS | `/api/v1/ws` | WebSocket realtime |

**Важно:** все POST требуют:
- `Content-Type: application/json`
- `Origin: http://<target>:<port>` (CORS-проверка — сравнивает Origin с Host)
- `Idempotency-Key: <UUID>` для мутирующих запросов

Авторизация через cookie (set-cookie при login/register).

---

## Вектор 1: AIR-XOR/1 — кастомный XOR-шифр (CRITICAL)

**Пакет:** `internal/radio/aircrypto`
**Функции:** `Cipher.Encrypt`, `Cipher.qsoKey`

Сообщения шифруются кастомным XOR при передаче через radiod. Ключ: env `AIRQSO_MESSAGE_CIPHER_KEY` (64 hex = 256 bit). `qsoKey` — скорее всего derives per-QSO key из мастер-ключа.

**Как атаковать:**
1. XOR с known plaintext: если знаешь формат флага (например `[A-Z0-9]{31}=`) — XOR plaintext с ciphertext = ключ
2. Если ключ повторяется для разных QSO — одно расшифрованное сообщение даёт ключ для всех
3. Перехватить зашифрованные данные можно через observer endpoint (порт 9001) если `AIRQSO_OBSERVER_SECRET` пустой
4. Или через capsules/archive в volume `airqso-radio`

**Примечание:** в API (`/api/v1/qsos/{id}/messages`) сообщения возвращаются **в plaintext**! Шифрование только на уровне radio transport. Если есть IDOR — читаешь plaintext напрямую.

---

## Вектор 2: Observer endpoint — утечка данных (порт 9001)

**У нас закрыт**, но у соперников может быть открыт.

Проверить: `curl http://<target>:9001/` — если ответит без 401, observer без секрета.

Через observer можно видеть:
- Состояние топологии
- Передачи в реальном времени
- Runtime state радио-движка

---

## Вектор 3: Operator package — скрытые endpoints

Пакет `internal/operator` содержит функции, которых **нет в SPA фронтенде**:
- `operator.CreateRecord` / `operator.OpenRecord` / `operator.SendRecord`
- `operator.CreateFile` / `operator.File`
- `operator.CreateRoute` / `operator.OpenRoute` / `operator.ReceiveRoute`
- `operator.CreateDiagnostic` / `operator.Diagnostic`
- `operator.CreateHistory` / `operator.History`
- `operator.CreateCard` / `operator.OpenCard` / `operator.ImportCard`
- `operator.Ticket`
- `operator.issueSession` / `operator.acceptSession`

**Это скрытый API!** Надо найти эндпоинты — возможно `/api/v1/operator/...` или подобное. Функции `CreateFile`, `File`, `decodeAssetReference`, `assetPath` — потенциальный path traversal или file read.

**Как искать:** fuzz `/api/v1/` с разными path segments: `records`, `files`, `routes`, `diagnostics`, `history`, `tickets`, `cards`, `operator`.

---

## Вектор 4: station_packets / card_notes / route_packets

Эти таблицы хранят payload с TTL 24h — **скорее всего флаги**.

SQL из бинарника:
```sql
SELECT id,owner_station_id,payload,created_at
FROM station_packets WHERE id=$1 AND owner_station_id=$2 AND expires_at>now()
```

Проверяется `owner_station_id` — значит нужно знать station_id владельца. Если узнать ID чужой станции (через `/api/v1/stations`) и packet ID, можно попытаться прочитать.

**Но:** проверка `owner_station_id=$2` привязана к сессии — скорее всего подставляется из auth. Если есть баг — обойти.

---

## Вектор 5: Bot stations (ID предсказуемы)

Боты создаются при старте. Их UUID: `62000000-0000-4000-8000-000000000001` ... `62000000-0000-4000-8000-000000000010` (можно перебрать). Checker может класть флаги через ботов.

Позывные ботов можно получить через `GET /api/v1/stations` — они все `online: true`.

---

## Вектор 6: QSL template injection

QSL-карточки рендерятся через Go html/template → PNG. Если данные (callsign, message) не экранируются:
- XSS через `/api/v1/qsl/{id}/html`
- Возможно SSTI через Go template: `{{.}}`, `{{printf "%s" .}}`

**Как проверить:** создать QSO с message содержащим `{{.}}` или `<script>alert(1)</script>`, завершить QSO, получить QSL → проверить HTML.

---

## Вектор 7: Брутфорс / массовая регистрация

Сервис имеет `login_rate_limits` таблицу, но rate limiting может быть слабым.

**Стратегия:**
1. Массово регистрировать пользователей
2. Массово вызывать все станции через QSO
3. Перехватывать broadcast-ы (они идут всем станциям в радиусе)

---

## Вектор 8: WebSocket перехват

`/api/v1/ws` — realtime события. Подключиться как авторизованный пользователь и слушать:
- Новые QSO
- Новые сообщения
- Broadcasts
- Состояния передач

Возможно утекает информация о чужих событиях.

---

## Вектор 9: Idempotency key replay

Если перехватить Idempotency-Key + cookie другого пользователя, можно получить cached response из таблицы `idempotency_keys`. Кэш привязан к `actor_station_id + route + key`.

---

## Вектор 10: Прямой доступ к PostgreSQL

Если получить RCE или доступ к контейнеру — можно напрямую читать из БД:
```sql
SELECT payload FROM station_packets WHERE expires_at > now();
SELECT payload FROM card_notes WHERE expires_at > now();
SELECT payload FROM route_packets WHERE expires_at > now();
SELECT text FROM messages ORDER BY created_at DESC LIMIT 100;
```

DB credentials: в `.env` файле или в environment переменных контейнера.

---

## Быстрый чеклист для атаки на чужие команды

1. `curl http://<target>:9001/` — observer открыт?
2. `curl http://<target>:8080/api/v1/stations` — получить список станций/ботов
3. Зарегаться, создать QSO ко всем ботам — получить сообщения
4. Fuzz скрытые operator endpoints
5. Проверить path traversal в asset/file endpoints
6. Слушать WebSocket на предмет утечки чужих событий
7. Попробовать QSL template injection
8. Если есть RCE — прямой SELECT из БД
