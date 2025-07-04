/** @file: src/Ljs/GObjectDecorators.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.2.0 */
/**
 * @changelog
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
 * регистрацию его как GObject с дополнительными возможностями. */


import GObject from 'gi://GObject';
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

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

/** Приоритеты CSS стилей для StyleContext
 *
 * Определяет порядок применения CSS правил. Чем выше числовое значение приоритета,
 * тем позже правила применяются и тем больше вероятность что они переопределят
 * предыдущие правила с более низким приоритетом.
 *
 * от GTK_STYLE_PROVIDER_PRIORITY_USER.
 * до GTK_STYLE_PROVIDER_PRIORITY_FALLBACK
 *
 * @see {@link https://docs.gtk.org/gtk4/type_func.StyleContext.add_provider_for_display.html Gtk.StyleContext.add_provider_for_display}
 * */
export enum StylePriority {
    USER = Gtk.STYLE_PROVIDER_PRIORITY_USER, // 800
    APPLICATION = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION, // 600
    SETTINGS = Gtk.STYLE_PROVIDER_PRIORITY_SETTINGS, // 400
    THEME = Gtk.STYLE_PROVIDER_PRIORITY_THEME, // 200
    FALLBACK = Gtk.STYLE_PROVIDER_PRIORITY_FALLBACK, // 1
}

/** Настройки CSS стилей для GObject класса
 *
 * Определяет CSS стили и параметры их применения для виджета.
 * Стили применяются глобально при первом создании экземпляра класса. */
interface StylingOptions {
    /** CSS стили - css-строка или URI к стилям */
    Css: Uint8Array | GLib.Bytes | string;
    /** Приоритет применения стилей */
    Priority?: StylePriority;
}

interface GObjectOptions {
    GTypeName?: string,
    GTypeFlags?: GObject.TypeFlags,
    Signals?: GSignals,
    Implements?: GInterfaces,
    CssName?: string,
    Template?: Uint8Array | GLib.Bytes | string,
    Children?: string[],
    InternalChildren?: string[],
    Requires?: GObject.Object[],
    Styling?: StylingOptions,
    BaseURI?: string,
};


type PropertyDecoratorFunction = (target: GObject.Object, property_key: string) => void;

// Реестр CSS providers
const css_providers_registry = new Map<string, Gtk.CssProvider>();

interface LazyStylingOptions extends StylingOptions {
    BaseURI?: string;
}

// Реестр отложенных стилей
const lazy_styles = new Map<string, LazyStylingOptions>();

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
     *                          Стили применяются глобально при **первом создании** экземпляра класса
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
     * @GDecorator.Class({
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
     * @GDecorator.Class({
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
     * @GDecorator.Class({
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
    Class: function (meta_info: GObjectOptions = {}) {
        return function <C extends GObject.ObjectConstructor>(constructor: C): C {

            meta_info.GTypeName ??= `Ljs-${constructor.name}`;

            // Проверяем, зарегистрирован ли уже этот тип
            const g_type = GObject.type_from_name(meta_info.GTypeName);
            if (g_type !== null) {
                throw new Error(`Type ${meta_info.GTypeName} is already registered. Use a different class name.`);
            }

            // Извлекаем Styling и BasePath перед регистрацией
            const { Styling, BaseURI: BasePath, ...gobject_meta } = meta_info;

            // Обрабатываем Template если есть
            if (gobject_meta.Template && typeof gobject_meta.Template === 'string') {
                gobject_meta.Template = resolve_template_path(gobject_meta.Template, BasePath);
            }

            // Собираем свойства из декораторов
            const config: GObject.MetaInfo<GProps, GInterfaces, GSignals> = {
                ...gobject_meta,
                Properties: (constructor as WithSymbolProps)[properties_symbol] || {}
            };

            const RegisteredClass = GObject.registerClass(config, constructor);

            // Если есть стили - оборачиваем в Proxy
            if (Styling) {

                // Добавляем в реестр, стиль будет применен при первом создании объекта
                lazy_styles.set(meta_info.GTypeName, { ...Styling, BaseURI: BasePath });

                return new Proxy(RegisteredClass, {
                    construct(target, args) {
                        // Создаем объект обычным способом
                        const instance = Reflect.construct(target, args);

                        // После создания применяем стили
                        ensure_styles_applied(meta_info.GTypeName!);

                        return instance;
                    }
                }) as C;
            }

            return RegisteredClass;
        };
    },

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

};

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
/** Преобразует JS идентификатор в читаемый ник
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

/** Преобразует относительный путь к UI template в абсолютный file:// URI */
function resolve_template_path(template: string, base_uri?: string): string {
    // Если не начинается с точки - возвращаем как есть
    if (!template.startsWith('.')) {
        return template;
    }

    try {
        // получаем базовый каталог_или_файл
        const base_path = Gio.File.new_for_uri(base_uri ?? import.meta.url);

        const info = base_path.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

        const base_dir = (info.get_file_type() === Gio.FileType.DIRECTORY) ? base_path : base_path.get_parent()!;

        // Резолвим относительный путь
        const resolved_file = base_dir.resolve_relative_path(template);

        if (!resolved_file) {
            throw new Error('Failed to resolve relative path');
        }
        return resolved_file.get_uri();

    } catch (error) {
        throw new Error(`Failed to resolve template path "${template}": ${(error as Error).message}`);
    }
}

/** Применяет CSS стили глобально */
function apply_styling(styling: LazyStylingOptions, type_name: string): void {
    try {
        // Резолвим CSS контент
        const css_content = resolve_css_content(styling);

        // Создаем CSS provider
        const css_provider = new Gtk.CssProvider();
        css_provider.load_from_string(css_content);

        // Получаем display
        const display = Gdk.Display.get_default(); // Adw.StyleManager.get_default().get_display(); //
        if (!display) {
            throw new Error('No default display available for CSS styling');
        }

        // Применяем стили глобально
        const priority = styling.Priority ?? StylePriority.APPLICATION;
        Gtk.StyleContext.add_provider_for_display(display, css_provider, priority);

        // Сохраняем в реестр
        css_providers_registry.set(type_name, css_provider);

    } catch (error) {
        throw new Error(`Failed to apply styling for ${type_name}: ${(error as Error).message}`);
    }
}

/** Резолвит CSS контент из строки, URI или binary данных */
function resolve_css_content(styling: LazyStylingOptions): string {
    if (typeof styling.Css === 'string') {
        // Строка - либо CSS код, либо путь
        return resolve_css_string(styling);
    } else if (styling.Css instanceof Uint8Array) {
        // Декодируем binary данные
        return new TextDecoder().decode(styling.Css);
    } else {
        // GLib.Bytes
        const data = styling.Css.get_data();
        if (data) {
            return new TextDecoder().decode(data);
        }
        return '';
    }
}

/** Резолвит CSS из строки - загружает файл если существует, иначе CSS код */
function resolve_css_string(styling: LazyStylingOptions): string {
    try {
        const file = resolve_css_file(styling.Css as string, styling.BaseURI);

        // Если файл существует - обязательно загружаем
        if (file.query_exists(null)) {
            const [success, contents] = file.load_contents(null);
            if (!success) {
                throw new Error(`File exists but failed to read contents: ${file.get_path()}`);
            }
            return new TextDecoder().decode(contents);
        }

        // Файл не существует - считаем CSS кодом
        return styling.Css as string;

    } catch (error) {
        // Ошибка при резолвинге пути - считаем CSS кодом
        return styling.Css as string;
    }
}

function resolve_css_file(css: string, base_uri?: string): Gio.File {

    // Если не начинается с точки - возвращаем как есть
    if (!css.startsWith('.')) {
        return Gio.File.new_for_uri(css);
    }

    try {
        // получаем базовый каталог_или_файл
        const base_path = Gio.File.new_for_uri(base_uri ?? import.meta.url);

        const info = base_path.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);

        const base_dir = (info.get_file_type() === Gio.FileType.DIRECTORY) ? base_path : base_path.get_parent()!;

        // Резолвим относительный путь
        const resolved_file = base_dir.resolve_relative_path(css);

        if (!resolved_file) {
            throw new Error('Failed to resolve relative path');
        }
        return resolved_file;

    } catch (error) {
        throw new Error(`Failed to resolve CSS file path "${css}": ${(error as Error).message}`);
    }
}

/** Применяет отложенные стили если дисплей готов */
function ensure_styles_applied(type_name: string): void {

    const styling = lazy_styles.get(type_name);

    if (!styling || css_providers_registry.has(type_name)) {
        return; // Стили уже применены или их нет
    }

    try {
        apply_styling(styling, type_name);
        lazy_styles.delete(type_name);
    } catch (error) {
        throw error;
    }
}

/** Получает CSS provider для типа зарегистрированного через декоратор
 *
 * Позволяет получить доступ к CSS provider'у для ручного управления стилями,
 * например для удаления стилей или модификации приоритета.
 *
 * @param type_name Имя типа GObject (GTypeName, используемый при регистрации)
 * @returns CSS provider или undefined если стили не были применены для данного типа
 *
 * @example
 * ```typescript
 * // Получаем provider для ручного cleanup
 * const provider = get_css_provider('Ljs-MyWidget');
 * if (provider) {
 *     Gtk.StyleContext.remove_provider_for_display(
 *         Gdk.Display.get_default()!,
 *         provider
 *     );
 * }
 * ```
 */
export function get_css_provider(type_name: string): Gtk.CssProvider | undefined {
    return css_providers_registry.get(type_name);
}
