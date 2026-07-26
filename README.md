# GlowUp AI Production V5

Полноценный Node.js-сервис для Render:

- лендинг и вход клиента;
- защищённая админ-панель `/admin`;
- личный кабинет `/cabinet`;
- PostgreSQL: пользователи, профили, анализы и аудит действий;
- серверный AI-анализ фотографии через OpenAI Responses API;
- фотографии не сохраняются — в базе остаются только хеш, MIME-тип, размер и результат;
- пароли хешируются bcrypt;
- JWT хранится в HttpOnly cookie;
- rate limiting, Helmet, CSP, health check и миграции при старте.

## Быстрый деплой на Render

Рекомендуемый способ: **New → Blueprint** и выбрать этот GitHub-репозиторий.

Основной `render.yaml` подключает существующую бесплатную базу Render с именем `glowup-ai-db`.
Во время создания Blueprint Render попросит два секрета:

- `ADMIN_PASSWORD` — придумайте сильный пароль администратора;
- `OPENAI_API_KEY` — настоящий серверный API-ключ OpenAI.

`APP_SECRET` создаётся Render автоматически. `DATABASE_URL` берётся из базы автоматически.

Если свободной базы ещё нет, переименуйте `render-create-new-database.yaml` в `render.yaml` перед первым деплоем.

## Адреса

- `/` — основной сайт
- `/admin` — админка
- `/cabinet` — кабинет клиента
- `/onboarding` — анкета и анализ фото
- `/health` — проверка сервера, базы и AI

## Локальная проверка

```bash
npm install
npm run check
npm test
npm start
```

## Важно

AI работает только после добавления `OPENAI_API_KEY`. Ключ нельзя размещать в HTML, JavaScript браузера или GitHub.
