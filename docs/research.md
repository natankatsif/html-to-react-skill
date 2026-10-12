# html-to-react: исследование, устройство, результаты

Скилл превращает HTML + CSS или HTML + Tailwind в React/Next.js-компоненты так, чтобы модель тратила минимум токенов и не тащила в React лишний HTML.

## Главная идея: «компилятор + LLM»

Дорогой способ: модель читает всю страницу и перепечатывает её в JSX. Она платит за каждый байт дважды (вход и выход, причём выход в ~5 раз дороже), на длинных файлах начинает «съедать» куски (`// ...rest of code`) и копирует мусор: обёртки, мёртвые классы, скрипты.

Скилл делит работу:

| Кто | Что делает | Стоимость |
|---|---|---|
| Скрипты (Node) | парсят HTML/CSS/JS, вычищают мусор, считают каскад CSS и переводят в Tailwind, находят повторы и превращают их в данные + `.map()`, пишут все файлы, копируют ассеты, проверяют результат | 0 токенов |
| Модель | читает компактный outline (~1–3k токенов), решает границы и имена компонентов в маленьком `plan.json`, переписывает JS-поведение на React-состояние точечными правками | единицы тысяч токенов |

Та же схема у промышленных инструментов: Builder.io Visual Copilot (свой компилятор Mitosis + LLM на последнем шаге), Figma MCP (`get_design_context` отдаёт референсный код, модель только адаптирует его под проект). В официальных рекомендациях Anthropic по скиллам прямо сказано: детерминированные операции выносить в скрипты, а модели оставлять решения; использовать схему «план → проверка плана скриптом → выполнение».

## Что нашёл в исследовании

- **Готового скилла под эту задачу нет.** Есть React-скиллы общего назначения и Cursor-правила «как писать компоненты», но не «как дёшево перевести вёрстку».
- **Детерминированные конвертеры** (`htmltojsx`, `html-to-jsx-transform`, transform.tools) решают только синтаксис (`class`→`className`), но не компонентизацию, не поведение и не CSS. Конвертер CSS→Tailwind `css-to-tailwindcss` хорош на уровне одного правила, но не знает каскада, медиа-порядка Tailwind v4 и Preflight. Его я использую внутри, а всё остальное дописал.
- **Повторяющиеся блоки.** Anima и Locofy автоматически находят повторы и делают из них компоненты с пропсами. Классический алгоритм для этого — MDR (Liu, Grossman, Zhai, KDD 2003): сравнение деревьев тегов соседних элементов. В скилле сделана его упрощённая версия: сигнатуры поддеревьев, где серии одинаковых детей схлопываются (`li*`). Поэтому карточки тарифов с 3 и 5 пунктами распознаются как один список, а пункты становятся вложенным массивом.
- **Сжатие входа.** DCGen (FSE 2025) показывает, что модель меньше теряет и искажает элементы, если работает по частям. EfficientUICoder сжимает токены интерфейса на входе и выходе. Исследование «The Hidden Cost of Readability» (ICSE’26): одно только удаление форматирования экономит ~24,5% входных токенов кода. Отсюда outline: дерево тегов с id, коротким текстом и метками списков, без классов и атрибутов (их несёт генератор).
- **Выход.** screenshot-to-code требует от модели менять файл точечными правками, а не перегенерировать его, и проверять результат скриншотом. В скилле модель вообще не пишет разметку; поведение добавляется маленькими Edit-ами, а проверка идёт попиксельным сравнением скриншотов, которое возвращает только цифры.

## Как устроен скилл

```
skills/html-to-react/
  SKILL.md                      инструкция для модели (≈2.6k токенов, грузится при срабатывании)
  references/                   читаются только по необходимости
    behavior-patterns.md        JS/jQuery/Bootstrap -> React (меню, табы, модалки, фильтры, формы)
    troubleshooting.md          причины визуальных расхождений и их исправление
    manual-conversion.md        правила, если Node недоступен или нужен маленький сниппет
  scripts/                      выполняются, в контекст не попадают
    analyze.mjs                 -> .h2r/<slug>/outline.txt, behavior.md, plan.json, report.json
    generate.mjs                plan.json -> компоненты, icons.tsx, page.tsx, CSS-остаток, ассеты, todo.md
    check.mjs                   TODO, HTML-остатки в JSX, неизвестные Tailwind-классы, дубли JSX, tsc/eslint
    visual-diff.mjs             скриншоты оригинала и роута -> % отличающихся пикселей
```

Пайплайн: `analyze → (модель правит plan.json) → generate → (модель делает поведение по todo.md) → check → visual-diff`.

Что скрипты делают сами, без участия модели:

- выкидывают head/meta, скрипты, комментарии, трекеры, `data-aos` и прочие атрибуты аналитики/анимаций, мёртвые классы, неиспользуемые `id`/`data-*`, пустые и «прозрачные» обёртки;
- превращают title/description в Next `metadata`, а шрифты в `<link precedence>` (React 19 сам поднимает его в `<head>`);
- переименовывают атрибуты (`className`, `htmlFor`, SVG camelCase), строки `style` делают объектами, для форм ставят `defaultValue`/`defaultChecked`, экранируют сущности (`'` → `&apos;` для eslint);
- соблюдают семантику пробелов HTML: `{" "}` ставится только там, где браузер нарисовал бы пробел;
- переводят CSS в Tailwind через настоящий каскад (специфичность, порядок, шорткаты, `!important`, медиа, `:hover`/`::before`, состояния предка → `group-*`, соседа → `peer-*`), а каждый класс проверяют настоящим Tailwind v4 из проекта. Всё, что не выражается утилитами, уходит в маленький CSS-файл страницы;
- классы, которые переключал старый JS (`active`, `open`), оставляют на элементах, а их CSS превращают в варианты `[&.active]:block`. В React остаётся только переключить класс;
- повторы превращают в массив данных + `.map()` с ключами, различия в state-классах превращают в boolean-пропсы, а инлайн-SVG дедуплицируют в компоненты иконок через svgo;
- копируют локальные картинки/шрифты в `public/<slug>/` и переписывают пути.

## Подводные камни, найденные при тестах

Каждый из них давал от нескольких до 30% расхождения на скриншотах:

1. **Tailwind Preflight.** Обычная CSS-вёрстка полагается на дефолты браузера (жирные `h1–h6`, `line-height: normal`, inline-картинки без `max-width`, вид полей формы). Preflight их сносит. Решение: в режиме `tailwind` недостающие дефолты добавляются утилитами с минимальным приоритетом. В режиме `css` страница получает корневой класс, и Preflight отменяется внутри неё одной строкой `all: revert-layer` в `@layer base`. Нужна именно классовая специфичность: селекторы Preflight (`h1`, `a`) перебивают `:where()`.
2. **Порядок брейкпоинтов в Tailwind v4.** Произвольные `min-[1250px]:` выводятся раньше именованных `lg:` независимо от значения, поэтому `lg:w-[950px] min-[1250px]:w-auto` ломает каскад. Если на странице есть нестандартный брейкпоинт, все брейкпоинты пишутся как произвольные.
3. **Произвольные свойства сортируются после обычных утилит.** `[font:inherit]` перебивал `text-sm`. Шорткаты, которые частично проиграли каскад, раскладываются на лонгхэнды.
4. **Cascade layers.** Нераслоённый `body {background:#fff}` в `globals.css` проекта перебивал фон страницы, лежащий в `@layer base`. Стили `body` теперь переносятся на корневой `div` страницы (с `min-h-screen flow-root`, чтобы margin не «схлопывался» наружу).
5. **Утечка CSS.** В Next.js импортированный CSS глобален, и правила вида `a {display:block}` ломали бы весь сайт. Правила для тегов превращаются в утилиты на конкретных элементах, а в режиме `css` все селекторы скоупятся через `:where(.slug-page)`.
6. **`String.trim()` съедает `&nbsp;`.** Мелочь, но текст «Price:&nbsp;$9» склеивался.
7. **Tailwind v1–v3 → v4.** Переименования (`shadow`→`shadow-sm`, `flex-grow`→`grow`, `outline-none`→`outline-hidden`…), удаление no-op классов (`transform`), возврат старого цвета границ по умолчанию (`border-gray-200`).
8. **Грязные шаблоны:** перевод строки внутри `src="..."`, ленивые картинки через `data-src`, `href="javascript:void(0)"`.

## Результаты

Проверка на трёх страницах (роуты внутри тестового Next 16 + Tailwind 4 проекта, шапка приложения скрыта при сравнении):

| страница | вход | модель читает | модель пишет (plan) | сгенерировано кода | отличие пикселей 1280 / 390 px |
|---|---|---|---|---|---|
| Tailwind Toolbox landing (Tailwind v2 CDN → v4) | ≈18.8k ток. | ≈1.1k | ≈0.2k | ≈5.5k ток., 10 файлов | 0.01% / *¹ |
| vCard portfolio (HTML + 30 КБ CSS + JS → Tailwind) | ≈17.2k | ≈2.9k | ≈0.5k | ≈14.9k ток., 13 файлов | 0.09%*² / 0.00% |
| edge cases (формы, `pre`, таблицы, SVG, сущности), режимы tailwind и css | ≈1.2k | ≈0.5k | ≈0.2k | ≈2k | 0.02% / 0.05% |

Токены оценены как символы/4. ¹ На 390 px расходится только место под отсутствующую в шаблоне `hero.png` (оригинал рисует иконку «битой» картинки). ² Оставшиеся 0.09% — иконка, которая в оригинале не загрузилась с CDN.

Если делать то же «руками», модель читает примерно столько же токенов, сколько во входе, и пишет весь код (в таблице это «сгенерировано кода»), причём выходные токены самые дорогие. Со скиллом модель читает в 6–17 раз меньше и почти ничего не пишет, кроме плана и логики поведения. `tsc` и `eslint` на сгенерированных файлах проходят. Поведение (меню, смена шапки при скролле, клик снаружи) проверено в браузере на лендинге.

На сниппетах меньше ~150 строк пайплайн не окупается: сама инструкция весит ~2.6k токенов. Поэтому SKILL.md советует для них ручной режим по `references/manual-conversion.md`.

## Как пользоваться

Установка и запуск описаны в [README](../README.md). Вручную:

```bash
npm install --prefix .claude/skills/html-to-react/scripts
node .claude/skills/html-to-react/scripts/analyze.mjs path/to/index.html --project .
# правим .h2r/<slug>/plan.json
node .claude/skills/html-to-react/scripts/generate.mjs .h2r/<slug>/plan.json
node .claude/skills/html-to-react/scripts/check.mjs .h2r/<slug>/plan.json --tsc --lint
node .claude/skills/html-to-react/scripts/visual-diff.mjs path/to/index.html http://localhost:3000/<route> --hide "body > header"
```

`.h2r/` — рабочая папка (outline, план, todo); её можно удалить или добавить в `.gitignore`.

## Ограничения и что можно сделать дальше

- Bootstrap/Bulma через CDN не переводятся в Tailwind: это редизайн, а не конвертация. Скилл оставляет классы фреймворка (`styling: "css"`) и советует поставить его из npm.
- Поведение (JS) переписывает модель. Скрипты только показывают, что именно и где делал старый код, и ставят маркеры `TODO(h2r)`.
- Сложные селекторы (`:has()`, состояния на нескольких уровнях) остаются в CSS-файле страницы с «крючками»-классами.
- Следующий шаг по методике skill-creator: прогнать пары «со скиллом / без скилла» на 3–5 реальных шаблонах субагентами, сравнить токены и качество, затем оптимизировать `description` для точности срабатывания.

## Источники

- Anthropic — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Builder.io Visual Copilot, компилятор + LLM: [Convert Figma to code with AI](https://dev.to/builderio/convert-figma-to-code-with-ai-h4f), [Visual Copilot 2](https://www.builder.io/blog/visual-copilot-2)
- Figma MCP server, скилл `figma-design-to-code` (референсный код → адаптация под проект → проверка по скриншоту)
- DCGen, divide-and-conquer UI code generation (FSE 2025): [arXiv 2406.16386](https://arxiv.org/abs/2406.16386), [WebPAI/DCGen](https://github.com/WebPAI/DCGen)
- EfficientUICoder, сжатие токенов при генерации UI-кода: [arXiv 2509.12159](https://arxiv.org/abs/2509.12159)
- The Hidden Cost of Readability (ICSE’26): [arXiv 2508.13666](https://arxiv.org/abs/2508.13666)
- MDR, Mining Data Records in Web Pages (KDD 2003): [страница авторов](https://www.cs.uic.edu/~liub/WebDataExtraction/MDR-download.html)
- Anima, [Automatic Component Detection](https://www.animaapp.com/blog/product-updates/announcing-automatic-component-detection-in-anima/); Locofy, [Auto Components](https://www.locofy.ai/docs/builder/auto-components)
- [abi/screenshot-to-code](https://github.com/abi/screenshot-to-code) — системный промпт: правки вместо перегенерации, проверка скриншотом
- Continue, [Instant Apply](https://blog.continue.dev/instant-apply-with-relace) — проблема «ленивых» плейсхолдеров при выводе кода
- Библиотеки: [css-to-tailwindcss](https://www.npmjs.com/package/css-to-tailwindcss), [html-to-jsx-transform](https://www.npmjs.com/package/html-to-jsx-transform), [cheerio](https://www.npmjs.com/package/cheerio), [svgo](https://www.npmjs.com/package/svgo)
- Tailwind CSS v4: [Upgrade guide](https://tailwindcss.com/docs/upgrade-guide)
