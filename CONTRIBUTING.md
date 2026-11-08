# Разработка / Development

[README](README.md) · [English](docs/README.en.md) · [Проверки](docs/VERIFICATION.md)

Расширение загружается прямо из исходников. После изменения фонового процесса или offscreen-кода перезагрузите NeiroTranslate в `chrome://extensions`, затем обновите вкладку с видео.

## Инструменты

- Node.js 24 — JavaScript, тесты и поиск секретов.
- Python 3.11+ — браузерные проверки и упаковка ZIP.
- Chromium Playwright — изолированное тестирование расширения.
- FFmpeg в PATH — генерация тестового видео.
- Git — проверка истории проекта.

```sh
pip install -r requirements-dev.txt
python -m playwright install chromium
python tools/make-demo-media.py
```

Для запуска самого расширения эти инструменты не требуются.

## Проверки

```sh
node tools/check-secrets.mjs --history
node tools/check.mjs
node --test --test-timeout=10000 tests/*.test.js
python tests/e2e.py
python tests/playback-e2e.py
python tests/stream-voices-e2e.py
python tests/speakers-e2e.py
python tests/audio-shaping-e2e.py
python tests/elevenlabs-e2e.py
```

Поиск секретов выводит тип и расположение совпадения, без значения. Проверяется публичный набор файлов и, с `--history`, объекты Git. В старой истории есть явно фальшивый тестовый Google-токен в двух объектах; допускается только его точный SHA256, только для истории. Текущие файлы не могут использовать это исключение.

По умолчанию ответы провайдеров заменены управляемыми фикстурами. Видео, декодирование, WebAudio и AudioWorklet настоящие; системный голос моделируется. Это не проверка всех голосов ОС или публичных эфиров. Расширенные разрешения добавляются только во временную тестовую копию.

`python tests/e2e.py --screens` и `python tests/elevenlabs-e2e.py --screens` обновляют скриншоты из изолированного профиля с демонстрационными данными. Отчёты и временное аудио создаются в игнорируемом `test-results/` и не входят в ZIP.

## Реальная сеть

Эти проверки запускаются явно. Платные запросы расходуют квоту.

```sh
node tools/live-translate-check.mjs
python tests/playback-e2e.py --live-network
python tests/stream-voices-e2e.py --live-network
```

`tools/live-provider-check.py` читает только переменные окружения процесса `NT_ELEVEN_API_KEY` / `NT_GEMINI_API_KEY`; необязательная `NT_ELEVEN_VOICE_ID` выбирает голос. Не вставляйте значения в публикуемый файл или команду. Ключи не сохраняются в настройках расширения; отчёт и короткий аудиопример остаются локальными. Этот инструмент не запускается в CI.

## Измерение задержки

| Команда | Что измеряется |
| --- | --- |
| `python tests/drift-e2e.py` | Отставание на десяти репликах с реальными бесплатными сервисами |
| `python tests/playback-e2e.py --latency` | Пять реплик: перевод и время до звука |
| `python tests/playback-e2e.py --lookahead` | Подготовка следующей реплики готовой дорожки |

Для сравнения добавьте `--baseline --release path/to/previous-release.zip`. Сравнение действительно только при завершении всех реплик. Сеть, серверный кэш и запуск аудиоустройства влияют на результат.

## Сборка

```sh
python tools/package.py
python tools/package.py --source
```

В `dist/` создаются установочный и исходный ZIP версии из `manifest.json`, каждый с `.zip.sha256`. Набор файлов ограничен allowlist; проверка секретов выполняется до записи архива. `dist/` не коммитится: архивы прикладываются к релизу. CI собирает оба варианта.

## Структура и стиль

```text
src/background/   сессии, очередь, сообщения
src/content/      субтитры страницы и состояние плеера
src/offscreen/    аудио, Gemini, TTS, локальный анализ
src/shared/       настройки, языки, тайминг и говорящие
src/popup/        окно расширения
src/options/      настройки провайдеров и озвучки
src/overlay/      субтитры и OBS-окно
src/stats/        локальная история
tests/            модульные и браузерные проверки
tools/            диагностика, ассеты, проверка и сборка
docs/             инструкции, скриншоты и отчёты
```

Строки RU/EN — `src/shared/i18n.js`, цвета — `src/shared/theme.css`, SVG-иконки — `assets/icons/`. Не добавляйте CDN-скрипты, удалённые шрифты и лишние разрешения. Изменения жизненного цикла должны проверять паузу/Stop во время запроса, смену настроек, навигацию и устаревшие ответы.

В issue укажите браузер, сайт, режим, голос и шаги воспроизведения. Не прикладывайте ключи, профили браузера и личные логи. [Работа с ключами](SECURITY.md).
