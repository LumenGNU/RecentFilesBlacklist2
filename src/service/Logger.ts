/** @file: src/service/Logger.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 1.0.0 */
/**
 *  @changelog
 * # 1.0.0 - Стабильная версия
 *           - Переработана и дополнена документация
 *           - Протестированы основные сценарии
 *           - Не выявлены баги
 *
 * # 0.9 - Переработан JournalLogger
 *         - JournalLogger теперь использует Unix socket для прямой отправки в systemd journal
 *           по протоколу datagram вместо костылей
 *         - Добавлена проверка существования journal socket при инициализации
 *         - Улучшена обработка ошибок при отправке сообщений
 *         - Сокет автоматически закрывается при вызове decommission()
 * */

import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';

import { DecommissionedError, Decommissionable } from '../shared/Decommissionable.interface.js';

/** ## Система логирования для GJS-приложений
 *
 * Набор классов, предоставляющих калбэк для установки логгера через `GLib.log_set_writer_func()`
 *
 * Особенности использования в GJS:
 *
 * - `GLib.LogField[]` приходит как объект с числовыми ключами (`Uint8Array`)
 * - Нельзя переключать логгеры во время выполнения (`SIGTRAP`)
 * - Один логгер устанавливается на весь сеанс через `GLib.log_set_writer_func()`
 *
 * @example
 * ~~~ts
 * // Установка логгера при инициализации расширения
 * const logger = new StdErrLogger();
 * GLib.log_set_writer_func(logger.log_writer_func);
 *
 * // При деактивации расширения
 * logger.decommission();
 * ~~~
 *
 * ### Особенности логирования
 *
 * Эта система рассчитана на работу поверх стандартных сообщений console.*
 *
 * - `console.info()` - Уведомление о нормальном состоянии, если оно полезно для пользователя
 * - `console.log()` - Сообщения о ходе работы, если оно полезно для пользователя
 * - `console.debug()` - Логирование отладочных сообщений. НЕ будет полезно пользователь. НЕ попадет в журнал
 * - `console.warn()` - Важное уведомление, не связанное с отладкой. Должно быть полезно пользователю
 * - `console.error()` - Уведомление об аварийном состоянии, не связанное с отладкой. Должно быть полезно пользователю;
 * - `console.count()` - передается как INFO. Не должно использоваться
 * - `console.time()` - передается как MESSAGE. Не должно использоваться
 * - `console.timeEnd()` - передается как MESSAGE. Не должно использоваться
 * - `console.timeLog()` - передается как MESSAGE. Не должно использоваться
 * - `console.trace()` - передается как MESSAGE. Должно быть полезно пользователю
 *
 * ### Производительность
 *
 * - `DEBUG` сообщения фильтруются на уровне `JournalLogger` (не отправляются)
 * - Сообщения других доменов (не 'Gjs-Console') игнорируются сразу
 * - Unix socket используется в datagram режиме (без установки соединения)
 *
 * ## Best Practices
 *
 * - Устанавливайте логгер один раз при инициализации
 * - Всегда вызывайте `decommission()` при завершении работы
 * - Используйте `StdErrLogger` для разработки, `JournalLogger` для production
 * - `NullLogger` полезен для "немых" сервисов
 *
 * */


/** Представляет поля лога как они реально приходят из GJS
 * (несмотря на то что типы говорят GLib.LogField[])
 *
 * В GJS поля логов приходят не как массив `GLib.LogField[]`, а как объект
 * с полями-свойствами, содержащими `Uint8Array` с закодированными строками.
 *
 * @see {@link Logger} - интерфейс логгера, использующий эти поля
 * @internal
 * */
interface LogFieldType {
    /** Текст сообщения в UTF-8 */
    MESSAGE: Uint8Array;
    /** Приоритет сообщения (число в виде строки) */
    PRIORITY: Uint8Array;
    /** Домен GLib (обычно 'Gjs-Console' - наш домен) */
    GLIB_DOMAIN: Uint8Array;
    /** Путь к файлу исходного кода */
    CODE_FILE?: Uint8Array;
    /** Номер строки в файле */
    CODE_LINE?: Uint8Array;
    /** Имя функции */
    CODE_FUNC?: Uint8Array;
}

/** Базовый интерфейс для всех логгеров */
interface Logger {

    /** Функция обработки лог-сообщений для `GLib.log_set_writer_func()`
     *
     * @param log_level уровень лог-сообщения (ERROR, WARNING, INFO и т.д.)
     * @param fields поля лога в формате GJS (объект с Uint8Array полями)
     * @returns GLib.LogWriterOutput.HANDLED сообщение обработано
     * @returns GLib.LogWriterOutput.UNHANDLED сообщение не обработано (при ошибке отправки)
     *
     * @throws {DecommissionedError} Если логгер был деактивирован через `decommission()`
     *  */
    log_writer_func: (log_level: GLib.LogLevelFlags, fields: GLib.LogField[]) => GLib.LogWriterOutput;
}

/** Логгер-"пустышка" - блокирует все сообщения
 *
 * Используется для полного отключения логирования */
export class NullLogger implements Logger, Decommissionable {

    /** Функция обработки лог-сообщений для `GLib.log_set_writer_func()` */
    log_writer_func(_log_level: GLib.LogLevelFlags, _fields: GLib.LogField[]) {
        /* nothing */
        return GLib.LogWriterOutput.HANDLED;
    }

    decommission(): void {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.log_writer_func = (throw_decommissioned as typeof this.log_writer_func);
    }
}

/** Логгер для вывода в stderr с цветным форматированием
 *
 * Особенности:
 * - Фильтрует сообщения только от домена 'Gjs-Console'
 * - Добавляет цвета для разных уровней
 * - Для ошибок создает кликабельные ссылки на файлы */
export class StdErrLogger implements Logger, Decommissionable {

    private text_decoder = new TextDecoder();

    /** Маппинг уровней логирования на ANSI escape-коды для цветного вывода
     *
     * Формат: "LABEL : \x1B[COLOR;BACKGROUNDm"
     * - 31 - красный текст
     * - 33 - жёлтый текст
     * - 36 - циановый текст
     * - 39 - стандартный цвет текста
     * - 49 - стандартный цвет фона
     *
     * @see https://en.wikipedia.org/wiki/ANSI_escape_code#Colors */
    static MESSAGE_COLORS = {
        [GLib.LogLevelFlags.LEVEL_ERROR]: 'ERROR    : \x1B[31;49m', // красный (31)
        [GLib.LogLevelFlags.LEVEL_CRITICAL]: 'CRITICAL : \x1B[31;49m', // красный (31)
        [GLib.LogLevelFlags.LEVEL_WARNING]: 'WARNING  : \x1B[33;49m', // жёлтый (33)
        [GLib.LogLevelFlags.LEVEL_MESSAGE]: 'MESSAGE  : \x1B[39;49m', // стандартный цвет текста (39)
        [GLib.LogLevelFlags.LEVEL_INFO]: 'INFO     : \x1B[39;49m', // стандартный цвет текста (39)
        [GLib.LogLevelFlags.LEVEL_DEBUG]: 'DEBUG    : \x1B[36;49m', // циановый (36) текст на стандартном фоне (49)
    } as const;

    /** Функция обработки лог-сообщений для `GLib.log_set_writer_func()` */
    log_writer_func = (log_level: GLib.LogLevelFlags, fields: GLib.LogField[]) => {

        // пропуск "чужих" сообщений
        if ((this.text_decoder.decode((fields as unknown as LogFieldType).GLIB_DOMAIN)) === 'Gjs-Console') {

            switch (log_level) {
                case GLib.LogLevelFlags.LEVEL_CRITICAL:
                case GLib.LogLevelFlags.LEVEL_ERROR:
                case GLib.LogLevelFlags.LEVEL_WARNING: {
                    const msg = this.text_decoder.decode((fields as unknown as LogFieldType).MESSAGE);
                    const trimmed_msg = msg.trim();
                    // Оборачивает в цвет. (Для файлов создаются ссылки. Корректируются пробелы - это нужно для правильного отображения внутри console.group())
                    printerr(`${StdErrLogger.MESSAGE_COLORS[log_level]}${`${' '.repeat(msg.length - trimmed_msg.length)}\x1B]8;;${this.text_decoder.decode((fields as unknown as LogFieldType).CODE_FILE)}#L${this.text_decoder.decode((fields as unknown as LogFieldType).CODE_LINE)}\x1B\\${this.text_decoder.decode((fields as unknown as LogFieldType).CODE_FUNC)}: ${trimmed_msg}\x1B]8;;\x1B\\`}\x1B[0;0m`);
                } break;
                case GLib.LogLevelFlags.LEVEL_INFO:
                case GLib.LogLevelFlags.LEVEL_MESSAGE:
                case GLib.LogLevelFlags.LEVEL_DEBUG: {
                    const msg_lines = this.text_decoder.decode((fields as unknown as LogFieldType).MESSAGE).split('\n');
                    msg_lines.forEach((line) => {
                        printerr(`${StdErrLogger.MESSAGE_COLORS[log_level]}${line}\x1B[0;0m`);
                    });
                } break;
            }
        }

        return GLib.LogWriterOutput.HANDLED;
    };

    decommission() {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.log_writer_func = (throw_decommissioned as typeof this.log_writer_func);

        this.text_decoder = (undefined as unknown as typeof this.text_decoder);
    }
}

/** Логгер для отправки в systemd journal
 *
 * Особенности:
 * - Фильтрует сообщения только от домена 'Gjs-Console'
 * - НЕ передает в журнал DEBUG сообщения (не нужны в production)
 * - Использует Unix domain socket для отправки
 * - Автоматически закрывает соединение при `decommission()`
 *
 * @example
 * ~~~ts
 * const logger = new JournalLogger('my-extension');
 * GLib.log_set_writer_func(logger.log_writer_func);
 * ~~~
 *
 * Проверить логи:
 * ~~~
 * journalctl -f SYSLOG_IDENTIFIER=my-extension
 * ~~~
 *
 * @see {@link StdErrLogger} альтернативный логгер для вывода в stderr
 * @see {@link NullLogger} логгер-заглушка */
export class JournalLogger implements Logger, Decommissionable {

    static socket_path = '/run/systemd/journal/socket' as const;

    static LEVEL = {
        [GLib.LogLevelFlags.LEVEL_CRITICAL]: 2,
        [GLib.LogLevelFlags.LEVEL_ERROR]: 3,
        [GLib.LogLevelFlags.LEVEL_WARNING]: 4,
        [GLib.LogLevelFlags.LEVEL_MESSAGE]: 5,
        [GLib.LogLevelFlags.LEVEL_INFO]: 6,
        [GLib.LogLevelFlags.LEVEL_DEBUG]: 7,
    } as const;

    private id: string;

    private text_decoder = new TextDecoder();
    private text_encoder = new TextEncoder();

    private socket: Gio.Socket | null;
    private address: Gio.UnixSocketAddress;

    constructor(id: string) {

        this.id = id;

        try {// socket init
            // Проверяем существование сокета journal
            if (!GLib.file_test(JournalLogger.socket_path, GLib.FileTest.EXISTS)) {
                throw new Error(`Journal socket not found: ${JournalLogger.socket_path}`);
            }

            this.socket = Gio.Socket.new(
                Gio.SocketFamily.UNIX,
                Gio.SocketType.DATAGRAM,
                Gio.SocketProtocol.DEFAULT
            );

            this.address = Gio.UnixSocketAddress.new(JournalLogger.socket_path);

        } catch (error) {
            this.socket = null;
            throw new Error('Failed to create journal socket.', { cause: error });
        }

    }

    /** Функция обработки лог-сообщений для `GLib.log_set_writer_func()` */
    log_writer_func = (log_level: GLib.LogLevelFlags, fields: GLib.LogField[]) => {

        // пропуск отладочных сообщений
        if (log_level !== GLib.LogLevelFlags.LEVEL_DEBUG) {
            // пропуск "чужих" сообщений
            if ((this.text_decoder.decode((fields as unknown as LogFieldType).GLIB_DOMAIN)) === 'Gjs-Console') {

                try {
                    if (this.socket) {

                        const log_entry = [
                            `SYSLOG_IDENTIFIER=${this.id}`,
                            `PRIORITY=${JournalLogger.LEVEL[log_level]}`,
                            `MESSAGE=${this.text_decoder.decode((fields as unknown as LogFieldType).MESSAGE)}`,
                            ''
                        ].join('\n');

                        if (this.socket.send_to(this.address, this.text_encoder.encode(log_entry), null)) {
                            return GLib.LogWriterOutput.HANDLED;
                        }
                    }
                    return GLib.LogWriterOutput.UNHANDLED;

                } catch (_error) {
                    return GLib.LogWriterOutput.UNHANDLED;
                }
            }
        }
        return GLib.LogWriterOutput.HANDLED;
    };

    decommission() {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this.log_writer_func = (throw_decommissioned as typeof this.log_writer_func);

        // закрываем сокет
        if (this.socket) {
            this.socket.close();
        }

        this.text_decoder = (undefined as unknown as typeof this.text_decoder);
        this.text_encoder = (undefined as unknown as typeof this.text_encoder);
        this.socket = (undefined as unknown as typeof this.socket);
        this.address = (undefined as unknown as typeof this.address);
    }

}
