1. Распакуйте ZIP.
2. Откройте GitHub-репозиторий и удалите старые файлы проекта либо создайте новый пустой репозиторий.
3. Загрузите ВСЕ файлы ИЗНУТРИ распакованной папки в корень репозитория.
4. Проверьте: server.js, config.js, app.js, package.json и render.yaml должны быть видны сразу в корне GitHub.
5. В Render поле Root Directory оставьте пустым.
6. Build Command: npm install --omit=dev
7. Start Command: npm start
8. Добавьте переменные ADMIN_PASSWORD, APP_SECRET, DATABASE_URL и OPENAI_API_KEY.
9. Выполните Manual Deploy → Deploy latest commit.
10. Админка: адрес сайта + /admin.
