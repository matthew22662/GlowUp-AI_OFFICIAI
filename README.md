# GlowUp AI V9

Полноценное Node.js-приложение с публичным сайтом, кабинетом клиента, административной панелью и анализом фотографий.

## Быстрый запуск

```bash
npm install
npm start
```

При отсутствии `DATABASE_URL` приложение автоматически использует демонстрационную базу данных в памяти и не завершает запуск с ошибкой `CONFIG_MISSING`.

## Администратор по умолчанию

- URL: `/admin`
- Email: `admin@glowup.ai`
- Password: `GlowUpAdmin!2026`

Настройки можно заменить через переменные окружения `ADMIN_EMAIL`, `ADMIN_PASSWORD` и `APP_SECRET`.

## Постоянная база данных

Для сохранения пользователей после перезапуска укажите PostgreSQL URL в `DATABASE_URL` и установите `USE_MEMORY_DATABASE=false`.

## Render

- Build Command: `npm install --omit=dev`
- Start Command: `npm start`
- Root Directory: пусто
- Health Check Path: `/health`

`render.yaml` уже настроен для первого запуска без внешней базы.
