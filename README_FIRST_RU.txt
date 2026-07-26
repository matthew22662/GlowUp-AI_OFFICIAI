GLOWUP AI — ВЕРСИЯ V9, ГОТОВАЯ ДЛЯ GITHUB И RENDER

1. Распакуйте ZIP.
2. Загрузите СОДЕРЖИМОЕ папки в корень репозитория GitHub.
3. В Render создайте Web Service из этого репозитория.
4. Build Command: npm install --omit=dev
5. Start Command: npm start
6. Root Directory: оставить пустым.

Проект запускается без обязательных переменных окружения.
Если DATABASE_URL отсутствует, автоматически используется демонстрационная база в памяти.

Админка: /admin
Email: admin@glowup.ai
Пароль: GlowUpAdmin!2026

Важно: демонстрационная база очищается после перезапуска сервиса. Для постоянного хранения пользователей позже добавьте PostgreSQL и DATABASE_URL.
