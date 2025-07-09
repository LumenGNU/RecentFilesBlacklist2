/** @file: src/Ljs/GObjectDecorators.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.5.0 */
/**
 * @changelog
 *
 * # 1.5.1 - StyleLayersManager вынесен в отдельный модуль
 *
 * # 1.5.0 - TypeScript-based GObject UI DSL
 *         - Стили применяются глобально через Gdk.DisplayManager
 *
 * # 1.2.0 - meta_info.Styling - можно указать css
 *           стили через декоратор
 *         - Документация
 *
 * # 1.1.0 - meta_info.Template - теперь может
 *           обработать относительный путь
 *
 * # 1.0.0 - Первый вариант
 */

/** @module GObjectDecorators.ts
 *
 * GObject декораторы для TypeScript
 *
 * Упрощает создание GObject классов с поддержкой:
 * - UI шаблонов (Template) с автоматическим резолвингом относительных путей
 * - CSS стилей (Styling) с глобальным применением
 * - Стандартных GObject свойств через типизированные декораторы
 *
 * Декораторы не модифицируют поведение объекта, а лишь упрощают
 * регистрацию его как GObject с дополнительными возможностями.
 *
 * Кому:
 *
 *     Разработчикам на GJS, особенно тем, кто пишет сложные UI/desktop
 *       приложения на JS/TS (Gnome extensions, standalone GTK-приложения).
 *     Тем, кто хочет писать на TypeScript с типами и удобным
 *       декларативным стилем, как в Angular или React.
 *
 * 2. Чем полезен:
 *
 *     Сокращает рутину — меньше boilerplate, декларативное описание
 *       классов и свойств.
 *     Явная поддержка CSS/шаблонов — экономит время, снижает вероятность
 *       ошибок с путями, стилями и шаблонами.
 *     Улучшает читаемость — код становится похож на современные фреймворки,
 *       легче поддерживать, легче учить новых людей.
 *     Безопасность и типизация — благодаря TS-декораторам меньше runtime-ошибок.
 *     Архитектурная гибкость — можно выбирать: минимальный GObject, только сервисы, или
 *       с GTK/UI.
*/

/** // @todo PERFORMANCE: Рефакторинг импортов GTK (Memory overhead: +25MB vs 4MB baseline)
 *
 * ## Проблема:
 * Модуль импортирует GTK4/Gdk4/Adw на уровне модуля, что добавляет ~25MB памяти
 * даже для non-GUI GObject классов (сервисы, утилиты).
 *
 * ## Импакт:
 * - Базовое потребление: 4MB
 * - С декораторами: 29MB (+625% overhead)
 * - Особенно критично для service-only кода
 *
 * ## Решение:
 * 1. **Динамические импорты** GTK только при необходимости:
 *    ```typescript
 *    // Вместо: import Gtk from 'gi://Gtk?version=4.0';
 *    const { Gtk } = await import('gi://Gtk?version=4.0'); // в apply_styling()
 *    ```
 *
 * 2. **Smart detection**: Проверять нужны ли GTK зависимости:
 *    ```typescript
 *    if (meta_info.Template || meta_info.Styling) {
 *        // Только тогда импортировать GTK
 *    }
 *    ```
 *
 * 3. **Разделение модуля**:
 *    - `GObjectDecorators.ts` - базовые декораторы (properties)
 *    - `GtkDecorators.ts` - UI декораторы (Template, Styling)
 *
 * ## Статус:
 * - Приоритет: LOW (не критично для preferences)
 * - Когда заняться: после основной функциональности
 *
 * ## Связанные проблемы:
 * - EnumProperty декоратор не работает (см. комментарий @deprecated)
 *   JS enum'ы != GType enum'ы, нужен JSObjectProperty
 *
 * ------
 *
 * ## Переключатель gui|no-gui + динамический импорт
 *
 * // Один модуль, smart detection
 * @GDecorator.Widget({
 *     Template: './ui.xml',  // ← Автоматически поймет что нужен GTK
 *     Styling: { Css: '...' }
 * })
 * class MyWidget extends Adw.Window {}
 *
 * // vs
 *
 * @GDecorator.GObject({
 *     GTypeName: 'MyService' // ← Без GTK зависимостей
 * })
 * class MyService extends GObject.Object {}
 *
 * ### Отдельные декораторы
 *
 * // service/backend код:
 * import { GDecorator } from './GObjectDecorators';
 *
 * @GDecorator.Widget()
 * class MyService extends GObject.Object {}
 *
 * // preferences/GUI код:
 * import { GDecorator } from './GObjectDecorators';
 * import { GtkDecorator } from './GtkDecorators';
 *
 * @GtkDecorator.Class({
 *     Template: './ui.xml',
 *     Styling: { Css: '...' }
 * })
 * class MyWidget extends Adw.Window {}
 *
 * Плюсы:
 *
 *     Явное разделение (принцип явности)
 *     Простая реализация
 *     Предсказуемый memory footprint
 *     Легко для tree-shaking
 *
 * Минусы:
 *
 *     ?Два импорта?
 *     Нужно помнить что где использовать
 *
 * мнение: отдельные декораторы
 *
 * логичнее:
 *
 *     Четкое разделение есть уже сейчас: service vs preferences
 *     Explicit лучше implicit для memory-critical кода
 *     Проще в maintenance - нет условной логики
 *
 *
 */

import GObject from 'gi://GObject';
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {
    CssParseError,
    get_style_layers_manager
} from './StyleLayersManager.js';

export {
    StylePriority,
    get_style_layers_manager
 } from './StyleLayersManager.js';

/** GObject-свойства */
type GProps = Record<string, GObject.ParamSpec>;

/** GObject-интерфейсы */
type GInterfaces = {
    $gtype: GObject.GType;
}[];

/** Интерфейс для определения GObject-сигнала */
interface SignalDefinition {
    flags: GObject.SignalFlags;
    param_types: GObject.GType[];
    return_type: GObject.GType;
    accumulator: GObject.AccumulatorType;
};

/** GObject-сигналы */
type GSignals = Record<string, Partial<SignalDefinition>>;

interface WithSymbolProps {
    [properties_symbol]?: GProps;
}

type StylingOptions = Record<number, GLib.Bytes | Uint8Array | Gio.File | string>;

interface WidgetOptions {
    GTypeName?: string,
    GTypeFlags?: GObject.TypeFlags,
    Signals?: GSignals,
    Implements?: GInterfaces,
    CssName?: string,
    Template?: Uint8Array | GLib.Bytes | string,
    Children?: string[],
    Requires?: Gtk.WidgetClass[],

    /** Настройки CSS стилей для LjsWidget класса
     *
     * Определяет CSS стили для виджета с соответствующим приоритетами.
     * Стили применяются глобально при регистрации типа.
     *
     * @see {@link StylePriority}
     *
     * // @todo
     * */
    Styling?: StylingOptions,
};

type PropertyDecoratorFunction = (target: GObject.Object, property_key: string) => void;

const properties_symbol = Symbol('gobject_properties');

export const GDecorator = {

    /** Декоратор для регистрации класса как GObject
     *
     * @param meta_info Базовые поля мета-информации
     * @param meta_info.GTypeName Уникальное имя типа GObject.
     *                            Должно быть уникальным в рамках приложения
     *                            Если не указано, то тип получит имя: 'Ljs-${constructor.name}'
     * @param meta_info.GTypeFlags Флаги типа
     * @param meta_info.Signals Объект с определениями сигналов
     * @param meta_info.Implements Массив интерфейсов для реализации
     * @param meta_info.CssName CSS-имя для стилизации
     * @param meta_info.BaseURI Базовый URI для резолвинга относительных путей.
     *                          Внимание! По умолчанию относительные пути для `meta_info.Template` и
     *                          `meta_info.Styling.Css` резолвятся относительно пути этого модуля (GObjectDecorators.ts).
     *                          `meta_info.BaseURI` позволяет указать базовый URI для резолвинга путей относительно
     *                          указанного URI. URI должен быть абсолютным, и может указывать на файл или каталог.
     *                          Для резолвинга от текущего модуля используй: import.meta.url.
     * @param meta_info.Template  Шаблон UI.
     *                            Может быть:
     *                              - UTF-8 XML строкой
     *                              - URI с абсолютным путем к файлу `file:///home/user/window.ui`
     *                              - URI с путем к ресурсу `resource:///org/gnome/AppName/window.ui`
     *                              - Относительным путем к файлу `./ui/window.ui`
     *                            @see {@link https://docs.gtk.org/gtk4/class.Builder.html Gtk.Builder}
     *                            @see {@link https://rmnvgr.gitlab.io/gtk4-gjs-book/application/ui-templates-composite-widgets/ UI Templates and Composite Widgets}
     * @param meta_info.Styling Объект с CSS стилями:
     *                          - Css: CSS код или путь к файлу. Путь может быть относительным
     *                          - Priority: приоритет применения (StylePriority enum)
     *                          Стили применяются глобально при регистрации типа
     * @param meta_info.Children Имена дочерних элементов
     * @param meta_info.InternalChildren Имена внутренних дочерних элементов
     * @param meta_info.Requires Требуемые зависимости
     *
     * @see {@link https://docs.gtk.org/gobject/tutorial.html GObject Tutorial}
     * @see {@link https://gjs-docs.gnome.org/gjs/overrides.md#gobject GObject in GJS}
     *
     * @returns Декоратор класса
     *
     * @throws Если класс не наследует GObject.Object или тип уже зарегистрирован
     * @throws Ошибки при обработки meta_info.Template или meta_info.Styling.Css
     *
     * @example Определение сигналов
     * ```typescript
     * @GObjectClass({
     *     GTypeName: 'MyWidget',
     *     Template: 'file://template.ui',
     *     Signals: {
     *         'my-signal': {
     *             flags: GObject.SignalFlags.RUN_FIRST,
     *             param_types: [],
     *             return_type: GObject.TYPE_NONE,
     *             accumulator: 0
     *         }
     *     }
     * })
     * class MyWidget extends GObject.Object {
     *     // ...
     *     this.emit('my-signal');
     * }
     * ```
     *
     * @example UI и стили
     * ```typescript
     * @GDecorator.Widget({
     *     GTypeName: 'MyWidget',
     *     Template: './my-widget.ui',
     *     Styling: {
     *         Css: './my-widget.css',
     *         Priority: StylePriority.APPLICATION
     *     }
     * })
     * class MyWidget extends Gtk.Widget {
     *     // ...
     * }
     * ```
     *
     * @example UI и стили (резолвинг относительно текущего файла)
     * ```typescript
     * @GDecorator.Widget({
     *     BaseURI: import.meta.url,
     *     Template: './templates/dialog.ui',
     *     Styling: { Css: './styles/dialog.css' },
     *     InternalChildren: ['ok_button', 'cancel_button']
     * })
     * class MyDialog extends Adw.Window {
     *     declare _ok_button: Gtk.Button;
     *     declare _cancel_button: Gtk.Button;
     * }
     * ```
     *
     * @example Inline UI и стили
     * ```typescript
     * @GDecorator.Widget({
     *     Template: `<interface><template class="MyWidget" parent="GtkBox">
     *                  <child><object class="GtkLabel" id="label"/></child>
     *                </template></interface>`,
     *     Styling: {
     *         Css: 'label { color: red; font-weight: bold; }'
     *     },
     *     InternalChildren: ['label']
     * })
     * class MyWidget extends Gtk.Box {
     *     declare _label: Gtk.Label;
     * }
     *  */
    Widget: function (meta_info: WidgetOptions = {}) {
        return function <C extends GObject.ObjectConstructor>(constructor: C): C {

            meta_info.GTypeName ??= `Ljs${constructor.name}`;

            // Проверка на дубликат типа
            const g_type = GObject.type_from_name(meta_info.GTypeName);
            if (g_type !== null) {
                throw new Error(`Type ${meta_info.GTypeName} is already registered. Use a different class name.`);
            }

            // Извлекаем части которые не передаем в registerClass
            const { Styling, ...gobject_meta } = meta_info;

            // Регистрируем GObject тип
            const config = {
                ...gobject_meta,
                Properties: (constructor as WithSymbolProps)[properties_symbol] || {}
            };

            const registered_class = GObject.registerClass(config as any, constructor);

            // Применяем стили через StyleLayerManager
            if (Styling) {

                for (const key in Styling) {
                    const priority = parseInt(key, 10);
                    get_style_layers_manager()
                        .then(manager => manager.append_layer(meta_info.GTypeName!, priority, Styling[priority]))
                        .catch((error) => {
                            if (error instanceof CssParseError) {
                                console.error(error.message, error.cause ? `\nWith cause:\n${error.cause}` : '');
                            }
                        });
                }

            }

            return registered_class;
        };
    },

    // #region *Property Декораторы

    /** @deprecated
     *
     * Универсальный декоратор для свойств GObject.
     * Можно применять как к свойствам так и к полям. В случае get/set свойства декоратор
     * нужно применять к первому из них.
     *
     * @param param_spec - Спецификация параметра
     * @returns - Декоратор свойства
     *
     * @example
     * ```typescript
     * class MyObject extends GObject.Object {
     *     @GObjectProperty(
     *         GObject.ParamSpec.string(
     *             'my-property',   // Имя свойства
     *             'My Property',   // Читаемое имя
     *             'Description',   // Описание
     *             GObject.ParamFlags.READWRITE,  // Флаги
     *             ''               // Значение по умолчанию
     *         )
     *     )
     *     my_property: string = '';
     * }
     * ```
     *  */
    Property: function (param_spec: GObject.ParamSpec) {
        return function (target: GObject.Object, property_key: string): void {

            if ((param_spec.name).replaceAll('_', '-') !== (property_key).replaceAll('_', '-')) {
                throw new SyntaxError(`Property name ${param_spec.name} does not match the property key ${property_key}.`);
            }

            ensure_properties_storage(target, property_key)[property_key] = param_spec;
        };
    },

    IntProperty: function (param: Partial<{
        flags: GObject.ParamFlags,
        minimum: number,
        maximum: number,
        default_value: number,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.int(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.minimum ?? -GLib.MAXINT32,
                param.maximum ?? GLib.MAXINT32,
                param.default_value ?? 0
            );
        };
    },

    Int64Property: function (param: Partial<{
        flags: GObject.ParamFlags,
        minimum: number,
        maximum: number,
        default_value: number,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.int64(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.minimum ?? Number.MIN_SAFE_INTEGER,
                param.maximum ?? Number.MAX_SAFE_INTEGER,
                param.default_value ?? 0
            );
        };
    },

    UIntProperty: function (param: Partial<{
        flags: GObject.ParamFlags,
        minimum: number,
        maximum: number,
        default_value: number,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.uint(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.minimum ?? 0,
                param.maximum ?? GLib.MAXUINT32,
                param.default_value ?? 0
            );
        };
    },

    UInt64Property: function (param: Partial<{
        flags: GObject.ParamFlags,
        minimum: number,
        maximum: number,
        default_value: number,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.uint64(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.minimum ?? 0,
                param.maximum ?? Number.MAX_SAFE_INTEGER,
                param.default_value ?? 0
            );
        };
    },

    BooleanProperty: function (param: Partial<{
        flags: GObject.ParamFlags,
        default_value: boolean,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.boolean(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.default_value ?? false
            );
        };
    },

    /* // @fixme Проблемный декоратор.
    * Работает только с GType enum'ами из C библиотек, не с JS объектами.
    * Для JS enum'ов используй JSObjectProperty.
    *
    * // @todo Разобраться с корректной поддержкой GType enum'ов */
    EnumProperty: function <T>(param: {
        flags?: GObject.ParamFlags,
        enumType: GObject.GType<T> | { $gtype: GObject.GType<T>; },
        default_value: T,
        description?: string,
    }): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.enum(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.enumType,
                param.default_value
            );
        };
    },

    DoubleProperty: function (param: Partial<{
        flags: GObject.ParamFlags,
        minimum: number,
        maximum: number,
        default_value: number,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.double(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.minimum ?? -Number.MAX_VALUE,
                param.maximum ?? Number.MAX_VALUE,
                param.default_value ?? 0
            );
        };
    },

    StringProperty: function (param: Partial<{
        flags: GObject.ParamFlags,
        /** По умолчанию '' */
        default_value: string,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.string(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.default_value ?? ''
            );
        };
    },

    BoxedProperty: function <T>(param: {
        flags?: GObject.ParamFlags,
        boxed_type: GObject.GType<T> | { $gtype: GObject.GType<T>; },
        description?: string,
    }): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.boxed(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.boxed_type
            );
        };
    },

    ObjectProperty: function <T>(param: {
        flags?: GObject.ParamFlags,
        object_type: GObject.GType<T> | { $gtype: GObject.GType<T>; },
        description?: string,
    }): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.object(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
                param.object_type
            );
        };
    },

    JSObjectProperty: function <T>(param: Partial<{
        flags: GObject.ParamFlags,
        description: string,
    }> = {}): PropertyDecoratorFunction {
        return function (target: GObject.Object, property_key: string): void {

            const [gprop, name, nick] = prepare_property_spec(target, property_key);

            gprop[property_key] = GObject.ParamSpec.jsobject(
                name,
                nick,
                param.description ?? '',
                param.flags ?? GObject.ParamFlags.READWRITE,
            ) as GObject.ParamSpec<T>;
        };
    },

    // #endregion

};



// #region Приватные функции

function ensure_properties_storage(target: GObject.Object, property_key: string): GProps {
    const constructor = target.constructor as WithSymbolProps; // as GObjectConstructor;

    if (!constructor[properties_symbol]) { // атачим символ, если еще нет
        constructor[properties_symbol] = {};
    }

    if (constructor[properties_symbol][property_key]) {
        throw new Error(`Property ${property_key} already has a GObject decorator. Multiple @Property decorators on the same property are not allowed.`);
    }

    return constructor[properties_symbol];
}

/** Возвращает [properties_storage, property_name, property_nickname] */
function prepare_property_spec(target: GObject.Object, property_key: string): [gprop: GProps, name: string, nick: string] {

    const property_name = property_key.replaceAll('_', '-');

    if (!GObject.ParamSpec.is_valid_name(property_name)) {
        throw new SyntaxError(`Property name ${property_name} not valid for GObject types system`);
    }
    return [ensure_properties_storage(target, property_key), property_name, identifier_to_nickname(property_key)];
}

// export { identifier_to_nickname }; // для тестов
/** Преобразует JS идентификатор в читаемый ник (для маленьких и ленивых)
 * @param identifier JS идентификатор (camelCase, snake_case или смешанный)
 * @returns Читаемая строка с Капитализированными Словами */
function identifier_to_nickname(identifier: string): string {
    // Удаляем незначащий префикс (# или _ в начале)
    const without_prefix = identifier.replace(/^[#_]+/, '');

    // Находим границы слов и разбиваем
    const words = without_prefix
        .split(/(?=[A-Z][a-z])|(?<=[a-z0-9])(?=[A-Z])|_+/) // Разбиваем по границам
        .filter(word => word.length > 0);  // Убираем пустые части

    // Капитализируем первую букву каждого слова
    return words
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// #endregion
