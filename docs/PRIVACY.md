# Данные и разрешения / Privacy

NeiroTranslate не использует собственный сервер, аналитику или учётные записи проекта. Отключённое расширение не захватывает звук вкладок.

| Данные | Куда передаются / где хранятся |
| --- | --- |
| API-ключи и настройки | `chrome.storage.local` в профиле браузера; не синхронизируются расширением и не входят в экспорт статистики |
| Субтитры в режиме «Из субтитров» | Текст отправляется в Google Translate; при сбое и известном языке — MyMemory |
| Звук в режиме Gemini | Звук выбранной вкладки отправляется напрямую в Gemini Live; микрофон не запрашивается |
| Звук в режиме «Из субтитров» | Только при включённом «Определять говорящих по звуку»: звук вкладки анализируется **локально** (высота голоса, громкость) и никуда не отправляется. В памяти хранятся только числа высоты/громкости за последние 30 секунд; сам звук не сохраняется |
| Озвучиваемый текст | Выбранному провайдеру: Google, ElevenLabs, Yandex; браузерные онлайн-голоса также могут отправлять текст своему сервису |
| История | Локально: дата, длительность, домен сайта, целевой язык, режим и голос. До 2000 сессий. Тексты субтитров и аудио в историю не сохраняются |

Субтитры последней фразы находятся в памяти текущей сессии и очищаются при остановке. Расширение не записывает видео или аудио на диск. Провайдеры обрабатывают запросы по своим правилам хранения данных и тарифам. Локальное хранилище браузера не является отдельным зашифрованным сейфом: доступ к вашему профилю даёт доступ к сохранённым данным.

При включённой «Связной интонации соседних фраз» HTTP-модели ElevenLabs могут получать до 100 символов предыдущей завершённой реплики того же голоса как контекст. Он хранится только в памяти до восьми секунд и сбрасывается при паузе/перемотке/остановке и смене конфигурации. v4 Turbo использует WebSocket без этого контекста; ключ передаётся в первом JSON-сообщении, а не в URL. Текст ручного прослушивания отправляется в ElevenLabs только при нажатии «Проверить» и не сохраняется в настройках или истории.

Для непрерывной речи в памяти могут ждать до двух свежих реплик; очередь не сохраняется в историю и очищается при остановке/паузе/перемотке. Повторный запрос после временного сетевого сбоя допускается один раз и только при подтверждении, что соответствующий текст ещё присутствует в текущих субтитрах.

Если готовая дорожка содержит следующую реплику, расширение может отправить её на бесплатный перевод не более чем за четыре секунды до показа. При выбранном Google-голосе также заранее готовится её звук. Подготовка не включает озвучку до наступления cue; платные голоса заранее не генерируются. Декодированный Google-звук хранится только в памяти аудиодокумента: до 24 частей, не более 12 МиБ, до двух минут. Пауза/перемотка отменяют подготовку, остановка закрывает аудиодокумент.

`activeTab` и `scripting` нужны для подключения к выбранной странице после нажатия пользователем; `tabCapture` — для звука вкладки в режиме Gemini и для локального определения говорящих (его можно выключить в настройках); `offscreen` — для аудио; `tts` — для браузерного голоса; `storage` — для настроек и статистики. Сетевые разрешения ограничены доменами провайдеров. Разрешение `<all_urls>` добавляется **только во временной тестовой копии**, чтобы автоматизировать activeTab; в поставляемом manifest его нет.

Удалить историю можно в настройках. Ключ удаляется очисткой соответствующего поля; удаление расширения удаляет его браузерное хранилище.

---

NeiroTranslate has no project backend or analytics. It stores settings, keys and session metadata in the local browser profile. Caption mode sends text to Google Translate (and, with a known source language, MyMemory as fallback). Gemini mode sends the selected tab's audio directly to Google; it does not request the microphone. Voice synthesis sends text to the selected provider. Browser online voices may also use a network service.

In caption mode with "Detect speakers from the video audio" enabled, the tab's audio is analysed locally for voice pitch only; nothing is sent anywhere, and only pitch/loudness numbers of the last 30 seconds are kept in memory. The option can be turned off in Settings.

No video/audio recordings or caption transcripts are persisted by the extension. History records date, duration, domain, language and mode for up to 2000 sessions. Provider retention and billing policies apply. Local browser storage is not a separate encrypted vault. Stop clears the current subtitle and releases capture; uninstall removes extension storage. The distributed manifest has no blanket access to all sites.

With continuous phrasing enabled, ElevenLabs HTTP requests can include up to 100 characters of the same voice's previous completed line. This context remains in memory for up to eight seconds and is invalidated on pause, seek, Stop or configuration changes. The v4 Turbo WebSocket receives no previous-text context and authenticates in its first JSON frame, never the URL. Custom preview text is sent only after Test is clicked and is not persisted in settings or history.

An available upcoming subtitle cue may be sent to free translation up to four seconds ahead. Google voice can also prepare its audio, without playing early; paid voices are not generated ahead. Decoded Google audio is held only in the audio document's memory, bounded to 24 chunks / 12 MiB / two minutes. Pause and seek cancel preparation; Stop closes the audio document.
