/** @file: src/Ljs/GObjectDecorators.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.1.0 */
/**
 * @changelog
 *
 * # 1.1.0 - GObjectOptions.Template - теперь может
 *           обработать относительный путь
 *
 * # 1.0.0 - Первый вариант
 */

/** @module gobject-decorators.ts
 *
 * GObject декораторы для TypeScript
 * Упрощает создание GObject классов с помощью TypeScript декораторов.
 *
 * Эти декораторы не модифицируют поведение объекта, а лишь упрощают
 * регистрацию его как GObject. */


import GObject from 'gi://GObject';
import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';

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
};

const properties_symbol = Symbol('gobject_properties');

type PropertyDecoratorFunction = (target: GObject.Object, property_key: string) => void;


export const GDecorator = {

    /** Декоратор для регистрации класса как GObject
     *
     * @param meta_info Базовые поля мета-информации
     * @param meta_info.GTypeName Уникальное имя типа GObject
     * @param meta_info.GTypeFlags Флаги типа
     * @param meta_info.Signals Объект с определениями сигналов
     * @param meta_info.Implements Массив интерфейсов для реализации
     * @param meta_info.CssName CSS-имя для стилизации
     * @param meta_info.Template  Шаблон UI.
     *                            Может быть:
     *                              - UTF-8 XML строкой
     *                              - URI с абсолютным путем к файлу `file:///home/user/window.ui`
     *                              - URI с путем к ресурсу `resource:///org/gnome/AppName/window.ui`
     *                              - Относительным путем к файлу `./ui/window.ui`
     *                            @see {@link docs.gtk.org/gtk4/class.Builder.html Builder}
     *                            @see {@link https://rmnvgr.gitlab.io/gtk4-gjs-book/application/ui-templates-composite-widgets/ UI-шаблон для композитных виджетов}
     * @param meta_info.Children Имена дочерних элементов
     * @param meta_info.InternalChildren Имена внутренних дочерних элементов
     * @param meta_info.Requires Требуемые зависимости
     * @returns - Декоратор класса
     * @throws  - Если класс не наследует GObject.Object или тип уже зарегистрирован
     *
     * @example
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
     * }
     * ```
     *  */
    Class: function (meta_info: GObjectOptions = {}) {
        return function <C extends GObject.ObjectConstructor>(constructor: C): C {

            meta_info.GTypeName ??= `Ljs-${constructor.name}`;

            // Проверяем, зарегистрирован ли уже этот тип
            const g_type = GObject.type_from_name(meta_info.GTypeName);
            if (g_type !== null) {
                throw new Error(`Type ${meta_info.GTypeName} is already registered. Use a different class name.`);
            }

            // Обрабатываем Template если есть
            if (meta_info.Template && typeof meta_info.Template === 'string') {
                // Резолвим путь если указан относительный
                meta_info.Template = resolve_template_path(meta_info.Template);
            }

            // Собираем свойства из декораторов @GObjectProperty

            const config: GObject.MetaInfo<GProps, GInterfaces, GSignals> = {
                ...meta_info,
                Properties: (constructor as WithSymbolProps)[properties_symbol] || {}
            };

            return GObject.registerClass(config, constructor);
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
function resolve_template_path(template: string): string {
    // Если не начинается с точки - возвращаем как есть
    if (!template.startsWith('.')) {
        return template;
    }

    try {
        // Получаем файл текущего модуля
        const current_file = Gio.File.new_for_uri(import.meta.url);

        // Резолвим относительный путь
        const resolved_file = current_file.get_parent()?.resolve_relative_path(template);

        if (!resolved_file) {
            throw new Error('Failed to resolve relative path');
        }

        return resolved_file.get_uri();
    } catch (error) {
        throw new Error(`Failed to resolve template path "${template}": ${(error as Error).message}`);
    }
}