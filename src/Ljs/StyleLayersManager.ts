/** @file: src/Ljs/StyleLayersManager.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.2 */
/**
 * @changelog
 *
 * # 1.0.2 - Документация
 *
 * # 1.0.1 - Импорт по запросу
 *
 * # 1.0.0 - Первый вариант
 * */

import type GtkNS from 'gi://Gtk?version=4.0';
import type GLibNS from 'gi://GLib?version=2.0';
import type GioNS from 'gi://Gio?version=2.0';
import type GdkNS from 'gi://Gdk?version=4.0';

let Gdk: typeof GdkNS;
let Gtk: typeof GtkNS;
let GLib: typeof GLibNS;
let Gio: typeof GioNS;

/** Ошибка парсинга CSS данных.
 *
 * Возникает при попытке загрузить некорректные CSS данные в CssProvider.
 * Содержит детали ошибок парсинга в свойстве cause.
 *
 * ### Применение
 *
 * Используется в {@link StyleLayersManager.make_provider} для обработки
 * ошибок парсинга CSS из различных источников.
 * */
export class CssParseError extends Error {
    constructor(message = 'Failed to parse CSS', options?: ErrorOptions) {
        super(message, options);
        this.name = 'CssParseError';
    }
}

/** Ошибка загрузки CSS данных из источника.
 *
 * Возникает когда не удается прочитать CSS данные из указанного источника.
 *
 * ### Применение
 *
 * Используется в {@link StyleLayersManager.make_provider} для обработки
 * ошибок чтения данных из различных источников перед парсингом.
 *
 * ### Причиной (cause) могут быть ошибки в вызовах:
 * - {@link https://docs.gtk.org/gtk4/method.CssProvider.load_from_bytes.html Gtk.CssProvider.load_from_bytes}
 * - {@link https://docs.gtk.org/gtk4/method.CssProvider.load_from_file.html Gtk.CssProvider.load_from_file}
 * - {@link https://docs.gtk.org/gtk4/method.CssProvider.load_from_path.html Gtk.CssProvider.load_from_path}
 * - {@link https://docs.gtk.org/gtk4/method.CssProvider.load_from_resource.html Gtk.CssProvider.load_from_resource}
 * - {@link https://docs.gtk.org/gtk4/method.CssProvider.load_from_string.html Gtk.CssProvider.load_from_string}
 * */
export class CssLoadError extends Error {
    constructor(message = 'Failed to load CSS data', options?: ErrorOptions) {
        super(message, options);
        this.name = 'CssLoadError';
    }
}

/** Приоритеты CSS стилей для StyleContext.
 *
 * Определяет порядок применения CSS правил. Чем выше числовое значение приоритета,
 * тем позже правила применяются и тем больше вероятность что они переопределят
 * предыдущие правила с более низким приоритетом.
 *
 * Соответствуют константам GTK от GTK_STYLE_PROVIDER_PRIORITY_USER
 * до GTK_STYLE_PROVIDER_PRIORITY_FALLBACK:
 *
 * - USER : 800
 * - APPLICATION : 600
 * - SETTINGS : 400
 * - THEME : 200
 * - FALLBACK : 1
 *
 * @see {@link https://docs.gtk.org/gtk4/type_func.StyleContext.add_provider_for_display.html Gtk.StyleContext.add_provider_for_display}
 * */
export enum StylePriority {
    /** Приоритет для пользовательских стилей из `$XDG_CONFIG_HOME/gtk-4.0/gtk.css`.
     *
     * Не следует использовать приоритеты выше этого, чтобы дать пользователю
     * последнее слово в стилизации.
     * */
    USER = 800,

    /** Приоритет для стилей, специфичных для приложения.
     *
     * Может использоваться при добавлении GtkStyleProvider с информацией
     * о стилях приложения.
     * */
    APPLICATION = 600,

    /** Приоритет для информации о стилях, предоставляемой через GtkSettings.
     *
     * Этот приоритет выше чем THEME, чтобы позволить настройкам переопределять темы.
     * */
    SETTINGS = 400,

    /** Приоритет для информации о стилях, предоставляемой темами. */
    THEME = 200,

    /** Приоритет для стилей по умолчанию, используемых в отсутствие тем.
     *
     * Не очень полезен для предоставления стилей по умолчанию для пользовательских
     * классов стилей - темы могут переопределить стили этого приоритета
     * универсальными правилами `* { ... }`.
     * */
    FALLBACK = 1,
}

/** Возвращает единственный экземпляр менеджера CSS слоев.
 *
 * @affects При первом вызове:
 * - Создает экземпляр StyleLayersManager
 * - Регистрирует обработчик изменения дисплея
 * - Импортирует необходимые GI модули
 *
 * @returns Singleton экземпляр менеджера
 *
 * @throws {Error} Если не удалось импортировать GI модули
 * */
export const get_style_layers_manager = (() => {

    let instance: StyleLayersManager | undefined;

    return async (): Promise<StyleLayersManager> => {
        if (!instance) {

            try {
                Gdk = (await import('gi://Gdk?version=4.0')).default;
                Gtk = (await import('gi://Gtk?version=4.0')).default;
                GLib = (await import('gi://GLib?version=2.0')).default;
                Gio = (await import('gi://Gio?version=2.0')).default;
            } catch (error) {
                throw error;
            }

            // @ts-expect-error Arguments error
            instance = new StyleLayersManager('StyleLayersManager.internal.create.token');
            Gdk.DisplayManager.get().connect('notify::default-display', StyleLayersManager._default_display_changed);
        }
        return instance;
    };
})();

/** Менеджер CSS слоев для глобального применения стилей виджетов.
 *
 * Обеспечивает отложенное применение CSS стилей с учетом доступности дисплея.
 * Использует паттерн Singleton для единой точки управления всеми стилями приложения.
 *
 * ### API
 *
 * #### Получение экземпляра:
 * - {@link get_style_layers_manager} - возвращает singleton экземпляр
 *
 * #### Методы:
 * - {@link append_layer} - добавляет новый CSS слой
 * - {@link print} - выводит все зарегистрированные стили для отладки
 *
 * #### Статические элементы:
 * - {@link providers_registry} - реестр активных CSS провайдеров
 * - {@link _default_display_changed} - обработчик изменения дисплея
 *
 * ### Архитектура
 *
 * - Слой === приоритет.
 * - На каждый слой один провайдер.
 *
 * Менеджер работает в двух режимах:
 * 1. **С дисплеем** - стили применяются немедленно через Gtk.StyleContext
 * 2. **Без дисплея** - стили накапливаются в css_registry и применяются при появлении дисплея
 *
 * ### Жизненный цикл
 *
 * 1. {@link get_style_layers_manager При первом обращении создается единственный экземпляр}
 * 2. {@link get_style_layers_manager Регистрируется обработчик на изменение 'default-display'}
 * 3. Стили добавляются через append_layer()
 * 4. При появлении дисплея все накопленные стили применяются автоматически
 *
 * @note CSS провайдеры живут до конца процесса (консистентно с GObject типами)
 *
 * Это сознательное архитектурное решение, консистентное с GObject системой типов:
 * - GObject типы нельзя отменить после регистрации
 * - CSS стили привязаны к типу, не к экземпляру
 * - Каждый процесс изолирован
 * - ОС очистит все ресурсы при завершении процесса
 *
 * Декоратор регистрирует CssProvider для типа с таким же жизненным циклом (навсегда),
 * что является не утечкой, а логичным и консистентным поведением. Оно зеркалирует
 * работу самого GObject.
 *
 * ### Ошибки:
 * - {@link CssParseError} - при ошибках парсинга CSS
 * - Error - при общих ошибках создания или применения стилей
 * */
class StyleLayersManager {

    /** Создает новый экземпляр менеджера.
     *
     * @note Использует internal token для предотвращения прямого создания.
     * Используйте {@link get_style_layers_manager} для получения экземпляра.
     *
     * @throws {Error} Если вызван без корректного internal token
     * */
    constructor() {
        // Проверяем первый аргумент через arguments
        // eslint-disable-next-line prefer-rest-params
        if (arguments[0] !== 'StyleLayersManager.internal.create.token') {
            throw new Error('Use get_style_layers_manager() to create StyleLayersManager instance');
        }
    }

    /** Реестр активных CSS провайдеров по приоритетам.
     *
     * Ключ - приоритет применения стилей, значение - CSS провайдер для этого приоритета.
     *
     * @note Провайдеры живут до конца процесса по архитектурному решению.
     * Это консистентно с GObject системой типов и обеспечивает стабильность стилей.
     * */
    static providers_registry = new Map<number, GtkNS.CssProvider>();



    /** Добавляет новый CSS слой для указанного типа виджета.
     *
     * Если дисплей доступен - применяет стили немедленно.
     * Если дисплей недоступен - откладывает применение до его появления.
     *
     * @param type_name Имя GObject типа (для отладки)
     * @param priority Приоритет применения стилей (см. {@link StylePriority})
     * @param css_data CSS стиль для применения с указанным приоритетом.
     *                 Если передается путь к файлу или ресурсу - он должен быть в формате URI.
     *                 Допускаются только схемы file:// и resource:// иначе строка будет
     *                 интерпретироваться как css код.
     *
     * @affects providers_registry Добавляет или дополняет провайдер для указанного приоритета
     * @affects При наличии дисплея стили применяются немедленно к текущему дисплею
     *
     * @throws {Error} Если не удалось создать CSS провайдер или применить стили
     * @throws {CssParseError} Если переданные CSS данные содержат синтаксические ошибки
     *
     * @example
     * ```typescript
     * manager.append_layer('MyWidget', StylePriority.APPLICATION, '.my-widget { color: red; }');
     * ```
     * */
    public append_layer(type_name: string, priority: number, css_data: GLibNS.Bytes | Uint8Array | GioNS.File | string) {
        StyleLayersManager.append_provider_to_layer(priority, StyleLayersManager.make_provider(type_name, css_data));
    }

    /** Добавляет CSS провайдер к указанному приоритетному слою.
     *
     * Если дисплей доступен - применяет провайдер немедленно.
     * Всегда добавляет провайдер в реестр для последующего применения.
     *
     * @param priority Приоритет применения стилей
     * @param provider CSS провайдер для добавления
     *
     * @affects providers_registry Добавляет провайдер в реестр
     * @affects При наличии дисплея применяет провайдер к текущему дисплею
     *
     * @see {@link add_provider_to_registry}
     * */
    private static append_provider_to_layer(priority: number, provider: GtkNS.CssProvider) {

        const display = Gdk.DisplayManager.get().get_default_display();

        if (display) {
            // дисплей доступен, нужно применять сразу-же
            // применяем к текущему дисплею
            Gtk.StyleContext.add_provider_for_display(display, provider, priority);
        }

        // @todo асинхронная очередь?
        // добавляем/дополняем реестр провайдеров
        StyleLayersManager.add_provider_to_registry(priority, provider);
    }

    /** Создает CSS провайдер из различных типов данных.
     *
     * Поддерживает загрузку CSS из:
     * - Строки с CSS кодом
     * - Пути к файлу (file:// URI)
     * - Ресурса приложения (resource:// URI)
     * - Байтового массива
     * - Объекта Gio.File
     *
     * @param type_name Имя типа виджета (для отладочных сообщений)
     * @param css_data CSS данные в одном из поддерживаемых форматов
     *
     * @returns Готовый CSS провайдер с загруженными стилями
     *
     * @throws {CssLoadError} Если не удалось загрузить CSS данные из источника
     * @throws {CssParseError} Если CSS данные содержат синтаксические ошибки
     *
     * @see {@link resolve_css_content}
     * */
    private static make_provider(type_name: string, css_data: GLibNS.Bytes | Uint8Array | GioNS.File | string): GtkNS.CssProvider {

        const provider = new Gtk.CssProvider();
        let _from = '';
        const parsing_error_buffer = [] as string[];

        const error_hid = provider.connect('parsing-error',
            function (_source: GtkNS.CssProvider, css_section: GtkNS.CssSection, gerror: GLibNS.Error) {
                parsing_error_buffer.push(`${css_section.to_string()}: ${gerror.message}`);
            }
        );

        try {

            // загрузить содержимое на основе переданного параметра
            if (css_data instanceof Uint8Array || css_data instanceof GLib.Bytes) {
                _from = 'Byte Array';
                provider.load_from_bytes(css_data);
            } else if (css_data instanceof Gio.File) {
                _from = 'File Object';
                provider.load_from_file(css_data);
            } else {
                // просто строка... и нужно понять что это
                if (css_data.startsWith('file://')) {
                    _from = 'File URI';
                    provider.load_from_path(css_data.substring(7)); // убираем file://
                    // @todo
                } else if (css_data.startsWith('resource://')) {
                    _from = 'Resource URI';
                    provider.load_from_resource(css_data.substring(11)); // Убираем префикс resource://
                } else {
                    _from = 'String';
                    provider.load_from_string(css_data);
                }
            }

        } catch (error) {
            throw new CssLoadError(`Failed to load CSS data from ${_from}.`, { cause: error });
        } finally {
            provider.disconnect(error_hid);
        }

        if (parsing_error_buffer.length > 0) {
            let error_message = `Failed to parse CSS for ${type_name} widget from ${_from}.`;

            if (_from === 'String Data') {
                error_message += '\n\nDid you mean to provide a file path? Use: file:///absolute/path or resource://path';
            }

            throw new CssParseError(error_message, {
                cause: parsing_error_buffer.splice(0).join('\n')
            });
        }

        return provider;
    }

    /** Добавляет CSS провайдер в реестр для указанного приоритета.
     *
     * Если провайдер с таким приоритетом уже существует - объединяет их стили
     * путем конкатенации CSS строк.
     *
     * @param priority Приоритет применения стилей
     * @param provider CSS провайдер для добавления
     *
     * @affects providers_registry Добавляет новый провайдер или дополняет существующий
     * @affects При объединении исходный provider очищается (загружается нулевая строка)
     *
     * @note Объединение провайдеров происходит на уровне CSS строк,
     *       что может привести к дублированию селекторов. Это намеренное поведение
     *       для обеспечения предсказуемости каскада стилей.
     *
     *       На простом:
     *       Этот метод тупо склеивает строки, селекторы могут дублироваться,
     *       учитывай это при использовании!
     * */
    private static add_provider_to_registry(priority: number, provider: GtkNS.CssProvider): void {

        if (StyleLayersManager.providers_registry.has(priority)) {
            const provider_for_layer = StyleLayersManager.providers_registry.get(priority)!;
            provider_for_layer.load_from_string(provider_for_layer.to_string().concat('\n', provider.to_string()));
            provider.load_from_string('\0');
        } else {
            StyleLayersManager.providers_registry.set(priority, provider);
        }
    }

    /** Обработчик изменения `'default-display'`.
     *
     * Вызывается при появлении/изменении дисплея по умолчанию.
     *
     * Переносит все существующие провайдеры на новый дисплей
     *
     * Это обеспечивает корректную стилизацию виджетов при:
     * - Первоначальной инициализации дисплея
     * - Смене дисплея (например, при переключении мониторов)
     * - Пересоздании дисплея после сбоя
     *
     * @param display_manager Менеджер дисплеев Gdk
     *
     * @affects providers_registry Все провайдеры будут применены к новому дисплею
     *
     * @see {@link get_style_layers_manager}
     * */
    public static _default_display_changed(display_manager: GdkNS.DisplayManager): void {
        const display = display_manager.get_default_display();
        if (display) {
            // Применяем стили
            for (const [priority, provider] of StyleLayersManager.providers_registry.entries()) {
                Gtk.StyleContext.add_provider_for_display(display, provider, priority);
            }
        }
    }

    /** Возвращает отладочную информацию о всех зарегистрированных стилях.
     *
     * Выводит CSS код всех провайдеров, отсортированных по приоритету
     * от высокого к низкому, с указанием приоритета в комментариях.
     *
     * @returns Строка с CSS кодом всех слоев для отладки
     *
     * @example
     * ```typescript
     * const manager = await get_style_layers_manager();
     * console.log(manager.print());
     * // Вывод:
     * // / [ Priority 800 ] /
     * // .my-widget { color: red; }
     * //
     * // / [ Priority 600 ] /
     * // .other-widget { background: blue; }
     * ```
     * */
    public print(): string {

        const priorities = [] as number[];

        // сортирует от высокого к низкому
        for (const priority of StyleLayersManager.providers_registry.keys()) {
            priorities.push(priority);
        }

        priorities.sort((a, b) => b - a);

        let result = '';
        for (const priority of priorities) {
            const provider = StyleLayersManager.providers_registry.get(priority)!;
            result += `/* [ Priority ${priority} ] */\n${provider.to_string()}\n\n`;
        }
        return result;
    }
}
