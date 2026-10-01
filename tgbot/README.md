# Telegram Mini App — продажа цифровых файлов

TMA-магазин цифровых товаров с двумя платёжными шлюзами: **ЮKassa** (карты РФ) и **Telegram Stars**.
Стек: React + Vite + Tailwind (фронт) · Cloudflare Pages Functions (бэкенд) · Supabase (БД + приватное файловое хранилище).

> **Статус: код написан, но не проверен сборкой.** В окружении, где создавался проект, не установлен Node
> (`node`, `npm` отсутствуют), поэтому `tsc` и `vite build` не запускались. Перед деплоем обязательно
> выполните шаг 7 — команды проверки.

---

## Содержание

- [Ключевые решения по безопасности](#ключевые-решения-по-безопасности)
- [Архитектура](#архитектура)
- [Структура проекта](#структура-проекта)
- [Настройка](#настройка)
- [Эндпоинты](#эндпоинты)
- [Проверка и деплой](#проверка-и-деплой)
- [Что осталось нереализованным](#что-осталось-нереализованным)

---

## Ключевые решения по безопасности

Четыре места, где легко написать небезопасный код, и как они закрыты здесь:

### 1. ЮKassa не подписывает вебхуки — HMAC-проверки по умолчанию не существует

Это важное расхождение с постановкой задачи. Официальная документация ЮKassa описывает **два** способа
аутентифицировать уведомление: по **IP-адресу** отправителя и по **актуальному статусу объекта в API**.
Заголовок с подписью появляется только если в кабинете магазина отдельно включена опция
«Подпись для уведомлений» — **по умолчанию она выключена**.

Код, который ждёт такой заголовок, будет вечно принимать поддельные уведомления: подпись не придёт
никогда, а проверка «если заголовок есть» молча пройдёт. Поэтому в
`functions/api/webhooks/yookassa.ts` проверок три, и только третья определяет корректность:

1. **Allowlist IP** — адрес в опубликованных диапазонах ЮKassa (дешёвый фильтр, отсекает пробы до
   обращения к API).
2. **Перезапрос платежа** — `GET /v3/payments/{id}` с секретным ключом. Требуется
   `status === 'succeeded' && paid === true`. **Все** значения ниже берутся из этого ответа, а не из тела
   уведомления.
3. **Сверка с собственной БД** — `metadata.order_id` обязан указывать на реальный заказ, у которого
   совпадают пользователь, валюта и **зафиксированная при создании** сумма.

Дополнительно: HMAC-проверка включается автоматически, если задан `YOOKASSA_WEBHOOK_SECRET`, и не
включается молча, если его нет.

### 2. Сумму платит сервер, а не клиент

Клиент отправляет только `product_id`. Сумма читается из БД на сервере и **фиксируется в заказе**
(`orders.amount`) в момент создания. Поэтому последующее редактирование цены не переписывает историю,
а подделка `amount` в запросе невозможна — такого поля в API просто нет.

### 3. Идентичность — только проверенный `initData`

`initData` из браузера можно отредактировать (включая `initDataUnsafe.user.id`), поэтому он считается
недоверенным. Каждый эндпоинт, работающий от имени пользователя, вызывает `verifyInitData()` —
HMAC-SHA256 по спецификации Telegram плюс проверка свежести (`auth_date` не старше 5 минут).

Отдельно: `verifyInitData` использует **сырые 32 байта** `secret_key` как ключ второго HMAC, а не его
hex-строку. Ошибка в этом месте не выглядит как ошибка — она просто отвергает 100% легитимных
пользователей.

### 4. Выдача файла идемпотентна

Переход `pending → paid` выполняется одним условным `UPDATE ... WHERE status = 'pending'`. Повторное
уведомление (ЮKassa переотправляет до 24 ч, Telegram тоже ретраит) обновляет 0 строк и обработка
останавливается — файл уходит ровно один раз. Уникальные индексы на
`(gateway, provider_payment_id)` и `(user_id, product_id, gateway, idempotency_key)` дублируют эту
гарантию на уровне БД.

Файлы лежат в приватном бакете `product-files`; наружу отдаётся только короткоживущая подписанная
ссылка, которая уходит в Telegram через Bot API.

---

## Архитектура

```
Telegram WebView                     Cloudflare Pages
┌──────────────────────┐             ┌────────────────────────────────┐
│ React + Tailwind     │  initData    │ Functions                     │
│                      ├────────────►│  payments/yookassa/create      │──► POST api.yookassa.ru/v3/payments
│ ProductList          │  X-Telegram  │  payments/stars/create         │──► createInvoiceLink (XTR)
│ PaymentMethodPicker  │  -Init-Data │  orders/{id}                   │
│  └ оплата / Stars    │             │  webhooks/yookassa             │◄── ЮKassa
│                      │             │  webhooks/telegram             │◄── Telegram Bot API
└──────────────────────┘             └───────────┬────────────────────┘
     каталог (anon + RLS)                        │ service_role (обходит RLS)
                                                  ▼
                                        Supabase Postgres
                                        products / orders / telegram_users
                                        Storage: product-files (private)
```

Каталог читается напрямую из Supabase анонимным ключом — это возможно, потому что RLS разрешает
`anon` только `SELECT` активных товаров. Заказы из браузера не читаются никогда: единственный путь к
ним — серверные функции, проверяющие `initData` и принадлежность заказа пользователю.

---

## Структура проекта

```
tgbot/
├── functions/                       # Cloudflare Pages Functions
│   ├── _shared/
│   │   ├── db.ts                    # service-role клиент, заказы, подписанные URL
│   │   ├── http.ts                  # CORS, JSON-ответы, requireUser(), withErrorHandling
│   │   ├── ip.ts                    # CIDR-матчер (v4/v6) для allowlist вебхуков
│   │   ├── telegram.ts              # verifyInitData, инвойсы Stars, отправка файла
│   │   └── yookassa.ts              # клиент ЮKassa (Basic Auth, Idempotence-Key)
│   └── api/
│       ├── orders/[id].ts           # GET  статус заказа (поллинг)
│       ├── payments/
│       │   ├── yookassa/create.ts   # POST создание платежа ЮKassa
│       │   └── stars/create.ts      # POST инвойс Telegram Stars
│       └── webhooks/
│           ├── yookassa.ts          # POST payment.succeeded / canceled
│           └── telegram.ts          # POST pre_checkout_query / successful_payment
├── supabase/migrations/
│   ├── 0001_schema.sql              # таблицы, enum'ы, индексы, триггеры, бакет
│   └── 0002_rls.sql                 # политики RLS и grants
├── src/
│   ├── App.tsx
│   ├── components/                  # ProductList, ProductCard, PaymentMethodPicker
│   ├── hooks/                       # useTelegramTheme, useProducts
│   └── lib/                         # api.ts, supabase.ts, telegram.ts, format.ts, types.ts
├── wrangler.toml                    # конфигурация Pages Functions
├── tsconfig.json                    # фронтенд
└── tsconfig.functions.json          # бэкенд (отдельный, т.к. разные lib/types)
```

---

## Настройка

### 1. Зависимости

Нужен **Node.js 20+**.

```bash
npm install
```

### 2. Supabase

```bash
supabase db push          # применит 0001_schema.sql и 0002_rls.sql
```

Или выполните оба файла вручную в Supabase Studio → SQL Editor, по порядку.

Бакет `product-files` создаётся миграцией (приватный). Загружайте файлы только сервисным ключом —
политики RLS не дадут анонимной роли ничего.

Пример товара:

```sql
insert into products (title, description, price, stars_price, file_path, is_active)
values ('Курс по коту', '12 уроков', 1490.00, 149, 'courses/cat.zip', true);
```

`stars_price = NULL` → товар не продаётся за Stars и кнопка звёзд будет disabled.

> **Почему две цены.** Курс RUB → Star плавает, поэтому Stars-цена задаётся вручную под нужную
> маржу и не вычисляется из `price` на лету. Поле `amount` в `orders` хранит фактически списанное
> значение (kopecks для RUB, целое число звёзд для XTR).

### 3. Переменные окружения

Скопируйте `.env.example` в `.env.local` и заполните. Разделение принципиально:

- `VITE_*` попадают в бандл и видны всем. Туда — только `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
  и `VITE_API_BASE_URL`.
- Всё остальное (`TELEGRAM_BOT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `YOOKASSA_SECRET_KEY`) задаётся
  только в окружении Pages Functions — Cloudflare Dashboard → Settings → Environment variables.

`.env.example` содержит комментарий о каждой переменной; он сверен с реальными `process.env.*`
в коде.

### 4. Telegram

Укажите URL Mini App в BotFather и вызовите:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/webhooks/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

`secret_token` подставляется в заголовок `X-Telegram-Bot-Api-Secret-Token`, который проверяется в
`functions/api/webhooks/telegram.ts`.

### 5. ЮKassa

В кабинете магазина: **Интеграция → HTTP-уведомления**, URL `https://<domain>/api/webhooks/yookassa`,
событие `payment.succeeded` (и `payment.canceled`). URL обязан быть HTTPS на 443/8443.

Пока идёт разработка, держите `YOOKASSA_TEST_MODE=true` — платежи пойдут через песочницу.

---

## Эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/payments/yookassa/create` | Создать заказ + платёж ЮKassa, вернуть `confirmation_url` |
| `POST` | `/api/payments/stars/create` | Создать заказ + инвойс Stars (XTR), вернуть ссылку |
| `GET` | `/api/orders/{id}` | Статус заказа (поллинг). Только для своего заказа |
| `POST` | `/api/webhooks/yookassa` | Приём уведомлений ЮKassa |
| `POST` | `/api/webhooks/telegram` | `pre_checkout_query` и `message.successful_payment` |

Три клиентских эндпоинта требуют заголовок `X-Telegram-Init-Data` и отвечают `401` без валидной
подписи. Оба вебхука используют собственную аутентификацию (allowlist IP / `secret_token`), а не
`initData`.

---

## Проверка и деплой

```bash
npm run typecheck   # tsc для фронтенда и для functions/
npm run build       # typecheck + vite build → dist/
```

Типизация бэкенда вынесена в отдельный `tsconfig.functions.json`: у Pages Functions другой runtime
(Web Crypto, нет DOM), и общий конфиг давал бы ложные ошибки.

Деплой: Cloudflare Pages, build command `npm run build`, output directory `dist`,
functions directory `functions` (см. `wrangler.toml`).

---

## Что осталось нереализованным

Осознанно, чтобы не выдавать скелет за готовый продукт:

- **Нет тестов.** Ни одного. ЮKassa-клиент, `verifyInitData`, CIDR-матчер и `sameAmount` написаны
  руками и требуют покрытия — они критичны для безопасности.
- **Нет reconcile-задачи.** Если доставка файла упала (файл удалён из бакета, Telegram недоступен),
  заказ останется в `paid` навсегда. Нужен периодический поиск заказов в статусе `paid` с
  `delivered_at IS NULL` и повторная доставка. Без этого деньги собираются, но файлы иногда не
  доходят.
- **Нет возвратов.** Статус `refunded` в enum есть, но логики нет.
- **Квитанция 54-ФЗ** заполняется неполно: для чека нужны телефон или e-mail покупателя, а
  `initData` их не содержит. Код включается флагом `YOOKASSA_REQUIRE_RECEIPT`.
- **Нет подписки на возврат URL.** После оплаты в ЮKassa пользователь возвращается на
  `/?order=<id>`, но UI этого состояния не обрабатывает — работает только поллинг из открытой вкладки.
- **Оплата картой открывается в новой вкладке Telegram** (`openTelegramLink`). Это компромисс: внутри
  Telegram нельзя увести пользователя из Mini App, не сломав возврат обратно.
- **Возврат по `stars_price` не сверяется с фактической ценой валюты.** Сумма звёзд проверяется по
  заказу, но идемпотентность `createInvoiceLink` не защищена на стороне Telegram.