// NeiroTranslate — supported target languages.
// `code`   — BCP-47 code used by Gemini Live Translate (translationConfig.targetLanguageCode)
// `gt`     — code used by the free Google Translate endpoint
// `tts`    — locale prefix used to pick browser / Google voices
(function (root) {
  const LANGUAGES = [
    { code: 'ru', name: 'Russian', native: 'Русский', gt: 'ru', tts: 'ru-RU' },
    { code: 'en', name: 'English', native: 'English', gt: 'en', tts: 'en-US' },
    { code: 'uk', name: 'Ukrainian', native: 'Українська', gt: 'uk', tts: 'uk-UA' },
    { code: 'be', name: 'Belarusian', native: 'Беларуская', gt: 'be', tts: 'be-BY' },
    { code: 'kk', name: 'Kazakh', native: 'Қазақ тілі', gt: 'kk', tts: 'kk-KZ' },
    { code: 'uz', name: 'Uzbek', native: 'Oʻzbekcha', gt: 'uz', tts: 'uz-UZ' },
    { code: 'es', name: 'Spanish', native: 'Español', gt: 'es', tts: 'es-ES' },
    { code: 'de', name: 'German', native: 'Deutsch', gt: 'de', tts: 'de-DE' },
    { code: 'fr', name: 'French', native: 'Français', gt: 'fr', tts: 'fr-FR' },
    { code: 'it', name: 'Italian', native: 'Italiano', gt: 'it', tts: 'it-IT' },
    { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)', gt: 'pt', tts: 'pt-BR' },
    { code: 'pt-PT', name: 'Portuguese (Portugal)', native: 'Português (Portugal)', gt: 'pt-PT', tts: 'pt-PT' },
    { code: 'pl', name: 'Polish', native: 'Polski', gt: 'pl', tts: 'pl-PL' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', gt: 'tr', tts: 'tr-TR' },
    { code: 'ja', name: 'Japanese', native: '日本語', gt: 'ja', tts: 'ja-JP' },
    { code: 'ko', name: 'Korean', native: '한국어', gt: 'ko', tts: 'ko-KR' },
    { code: 'zh-Hans', name: 'Chinese (Simplified)', native: '简体中文', gt: 'zh-CN', tts: 'zh-CN' },
    { code: 'zh-Hant', name: 'Chinese (Traditional)', native: '繁體中文', gt: 'zh-TW', tts: 'zh-TW' },
    { code: 'ar', name: 'Arabic', native: 'العربية', gt: 'ar', tts: 'ar-SA' },
    { code: 'fa', name: 'Persian', native: 'فارسی', gt: 'fa', tts: 'fa-IR' },
    { code: 'he', name: 'Hebrew', native: 'עברית', gt: 'iw', tts: 'he-IL' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', gt: 'hi', tts: 'hi-IN' },
    { code: 'bn', name: 'Bengali', native: 'বাংলা', gt: 'bn', tts: 'bn-IN' },
    { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', gt: 'id', tts: 'id-ID' },
    { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', gt: 'ms', tts: 'ms-MY' },
    { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', gt: 'vi', tts: 'vi-VN' },
    { code: 'th', name: 'Thai', native: 'ไทย', gt: 'th', tts: 'th-TH' },
    { code: 'fil', name: 'Filipino', native: 'Filipino', gt: 'tl', tts: 'fil-PH' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands', gt: 'nl', tts: 'nl-NL' },
    { code: 'sv', name: 'Swedish', native: 'Svenska', gt: 'sv', tts: 'sv-SE' },
    { code: 'no', name: 'Norwegian', native: 'Norsk', gt: 'no', tts: 'nb-NO' },
    { code: 'da', name: 'Danish', native: 'Dansk', gt: 'da', tts: 'da-DK' },
    { code: 'fi', name: 'Finnish', native: 'Suomi', gt: 'fi', tts: 'fi-FI' },
    { code: 'cs', name: 'Czech', native: 'Čeština', gt: 'cs', tts: 'cs-CZ' },
    { code: 'sk', name: 'Slovak', native: 'Slovenčina', gt: 'sk', tts: 'sk-SK' },
    { code: 'hu', name: 'Hungarian', native: 'Magyar', gt: 'hu', tts: 'hu-HU' },
    { code: 'ro', name: 'Romanian', native: 'Română', gt: 'ro', tts: 'ro-RO' },
    { code: 'bg', name: 'Bulgarian', native: 'Български', gt: 'bg', tts: 'bg-BG' },
    { code: 'sr', name: 'Serbian', native: 'Српски', gt: 'sr', tts: 'sr-RS' },
    { code: 'hr', name: 'Croatian', native: 'Hrvatski', gt: 'hr', tts: 'hr-HR' },
    { code: 'sl', name: 'Slovenian', native: 'Slovenščina', gt: 'sl', tts: 'sl-SI' },
    { code: 'el', name: 'Greek', native: 'Ελληνικά', gt: 'el', tts: 'el-GR' },
    { code: 'lt', name: 'Lithuanian', native: 'Lietuvių', gt: 'lt', tts: 'lt-LT' },
    { code: 'lv', name: 'Latvian', native: 'Latviešu', gt: 'lv', tts: 'lv-LV' },
    { code: 'et', name: 'Estonian', native: 'Eesti', gt: 'et', tts: 'et-EE' },
    { code: 'ka', name: 'Georgian', native: 'ქართული', gt: 'ka', tts: 'ka-GE' },
    { code: 'hy', name: 'Armenian', native: 'Հայերեն', gt: 'hy', tts: 'hy-AM' },
    { code: 'az', name: 'Azerbaijani', native: 'Azərbaycan', gt: 'az', tts: 'az-AZ' },
    { code: 'ur', name: 'Urdu', native: 'اردو', gt: 'ur', tts: 'ur-PK' },
    { code: 'ta', name: 'Tamil', native: 'தமிழ்', gt: 'ta', tts: 'ta-IN' },
    { code: 'te', name: 'Telugu', native: 'తెలుగు', gt: 'te', tts: 'te-IN' },
    { code: 'sw', name: 'Swahili', native: 'Kiswahili', gt: 'sw', tts: 'sw-KE' },
    { code: 'af', name: 'Afrikaans', native: 'Afrikaans', gt: 'af', tts: 'af-ZA' },
    { code: 'ca', name: 'Catalan', native: 'Català', gt: 'ca', tts: 'ca-ES' }
  ];

  function findLanguage(code) {
    return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
  }

  root.NT_LANGUAGES = LANGUAGES;
  root.ntFindLanguage = findLanguage;
})(typeof self !== 'undefined' ? self : this);
