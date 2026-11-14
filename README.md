# Коннект

Студенческая платформа на Node.js + HTML/CSS/JavaScript. Без внешних npm-зависимостей.

## Как обновить сайт
В GitHub замените `server.js` (корень) и `public/index.html`. Файл `db.json` не загружайте.

## Хранение данных (важно)
На бесплатном Render файлы стираются при перезапуске. Чтобы аккаунты не терялись, подключите бесплатный Upstash Redis:
1. upstash.com, создайте базу Redis, скопируйте REST URL и REST Token.
2. Render, Environment: `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`.
3. Redeploy. В логе должно быть «Хранилище: внешнее (Upstash Redis)».

## Переменные окружения
- `MOD_CODE` код модератора (7 нажатий на логотип)
- `DEMO_USERS` число предзаполненных профилей (по умолчанию 114), `DEMO=0` отключает
- `BOT_TOKEN`, `BOT_USERNAME`, `BOT_WEBHOOK_SECRET` Telegram-уведомления
- `DATA_DIR` папка для db.json

## Возможности
Лента, мероприятия, сообщества (страница сообщества), профиль, колокольчик уведомлений, чаты встреч, архив, модерация, Telegram Mini App.
