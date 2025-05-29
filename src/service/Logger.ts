/** @file: src/service/Logger.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 2.0.0 */
/**
 *  @changelog
 *
 * # 2.0.0 - Реализована собственная архитектура с абстрактным классом Logger
 *         - Добавлен JournalLogger с прямой отправкой через Unix socket
 *         - Добавлен StdErrLogger с цветным форматированием
 *         - Система sub_msg() для иерархических сообщений
 *         - Поддержка цепочек ошибок через Error.cause
 *         - Фильтрация DEBUG сообщений в production (JournalLogger)
 *         - GLib логирование оказалось неработоспособным в среде GJS
 *         - Полный переход на собственную систему логирования
 *         - Отказ от GLib.log_set_writer_func из-за проблем с GJS биндингами
 *         - GLib.log_set_writer_func отлично работает в C, но не в JavaScript обертке
 *
 * # 1.0.1 - Исправлены и дополнены типы ошибок
 *         - Получилась какашка
 *
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

// Специфичные типы ошибок
/** Ошибка, возникающая при невозможности инициализации Unix socket для JournalLogger */
export class SocketInitError extends Error {
    constructor(message = 'Failed to initialize socket', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SocketInitError';
    }
}

/** Ошибка, при работе с сокетом */
export class SocketError extends Error {
    constructor(message = 'Send to Journal Socket fail!', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SocketError';
    }
}

/** Уровни логирования в порядке убывания важности */
enum LogLevel {
    /** Критические ошибки */
    error,
    /** Предупреждения */
    warning,
    /** Информационные сообщения */
    message,
    /** Отладочная информация */
    debug
}

/** Базовый абстрактный класс для всех логгеров
 *
 * Предоставляет единый интерфейс для логирования с поддержкой:
 * - Различных уровней логирования (error, warn, debug, log, info)
 * - Цепочек ошибок через Error.cause
 * - Вложенных сообщений через sub_msg()
 *  */
abstract class Logger {

    #last_log_level = LogLevel.message as LogLevel;

    /** Функция обработки лог-сообщений
     *
     * Должна быть реализована в наследниках для определения
     * куда и как выводить сообщения
     *
     * @param log_level Уровень логирования
     * @param message Текст сообщения
     * @param pad_level Уровень вложенности для отступов (0 = основное сообщение) */
    protected abstract _log_writer(log_level: LogLevel, message: string, pad_level: number): void;

    #do_msg(log_level: LogLevel, content: string | Error, error?: Error) {
        this.#last_log_level = log_level;
        if (typeof content === 'string') {
            this._log_writer(log_level, content, 0);
        } else {
            this.#do_err(log_level, content, 0);
        }

        if (error !== undefined) {
            this.#do_err(log_level, error, 1);
        }

        GLib.log_set_writer_func;
    }

    #do_sub_msg(content: string | Error) {
        if (typeof content === 'string') {
            this._log_writer(this.#last_log_level, content, 1);
        } else {
            this.#do_err(this.#last_log_level, content, 1);
        }
    }

    #do_err(log_level: LogLevel, err: Error, pad: number) {
        const stack = err.stack ? `\n${err.stack}` : '';
        const msg = `${err.name}: ${err.message}${stack}`;
        this._log_writer(log_level, msg, pad);
        if (err.cause) {
            this.#do_err(log_level, (err.cause as Error), ++pad);
        }
    }

    /** Логирование критических ошибок
     *
     * @param msg Сообщение об ошибке */
    error(msg: string): void;
    /**
     * @param err Объект ошибки */
    error(err: Error): void;
    /**
     * @param msg Сообщение об ошибке
     * @param err Объект ошибки */
    error(msg: string, err: Error): void;
    error(content: string | Error, error?: Error): void {
        this.#do_msg(LogLevel.error, content, error);
    }

    /** Логирование предупреждений
     *
     * @param msg Текст предупреждения */
    warn(msg: string): void;
    /**
     * @param err Объект ошибки как предупреждение */
    warn(err: Error): void;
    /**
     * @param msg Текст предупреждения
     * @param err Связанная ошибка */
    warn(msg: string, err: Error): void;
    warn(content: string | Error, error?: Error): void {
        this.#do_msg(LogLevel.warning, content, error);
    }


    /** Логирование отладочной информации
     *
     * @param msg Отладочное сообщение */
    debug(msg: string): void;
    /**
     * @param err Ошибка для отладки */
    debug(err: Error): void;
    /**
     * @param msg Отладочное сообщение
     * @param err Связанная ошибка */
    debug(msg: string, err: Error): void;
    debug(content: string | Error, error?: Error): void {
        this.#do_msg(LogLevel.debug, content, error);
    }

    /** Логирование обычных информационных сообщений
     *
     * @param msg Информационное сообщение */
    log(msg: string): void;
    /**
     * @param err Ошибка как информационное сообщение */
    log(err: Error): void;
    /**
     * @param msg Информационное сообщение
     * @param err Связанная ошибка */
    log(msg: string, err: Error): void;
    log(content: string | Error, error?: Error): void {
        this.#do_msg(LogLevel.message, content, error);
    }

    /** Логирование информационного сообщения (упрощенная версия log)
     *
     * @param msg Информационное сообщение */
    info(msg: string): void {
        this.#do_msg(LogLevel.message, msg);
    }

    /** Логирование вложенного сообщения
     *
     * Использует уровень логирования последнего основного сообщения
     * и добавляет отступ для показа иерархии
     *
     * @param msg Вложенное сообщение */
    sub_msg(msg: string): void;
    /**
     * @param err Ошибка как вложенное сообщение */
    sub_msg(err: Error): void;
    sub_msg(content: string | Error): void {
        this.#do_sub_msg(content);
    }

}

/** Логгер-"пустышка" - блокирует все сообщения
 *
 * Используется для полного отключения логирования */
export class NullLogger extends Logger implements Decommissionable {

    /** Функция обработки лог-сообщений` */
    protected _log_writer() {
        /* nothing */
        return;
    }

    decommission(): void {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this._log_writer = (throw_decommissioned as typeof this._log_writer);
    }
}

/** Логгер для вывода в stderr с цветным форматированием
 *
 * Особенности:
 * - Добавляет цвета для разных уровней
 * - // @todo Для ошибок создает кликабельные ссылки на файлы */
export class StdErrLogger extends Logger implements Decommissionable {

    static MARKER_PADDING = 8 as const;
    static MARKER_BOUND = '⋮' as const;
    static MSG_MARKER = {
        [LogLevel.error]: 'ERROR',
        [LogLevel.warning]: 'WARNING',
        [LogLevel.message]: 'INFO',
        [LogLevel.debug]: 'DEBUG'
    };

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
        [LogLevel.error]: '\x1B[31;49m', // красный (31)
        [LogLevel.warning]: '\x1B[33;49m', // жёлтый (33)
        [LogLevel.message]: '\x1B[39;49m', // стандартный цвет текста (39)
        [LogLevel.debug]: '\x1B[36;49m', // циановый (36) текст на стандартном фоне (49)
    } as const;

    /** Функция обработки лог-сообщений */
    protected _log_writer(log_level: LogLevel, message: string, pad_level: number = 0) {

        const lines = message.split('\n').map((line, index) => {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
                return `${`${(pad_level === 0 && index === 0) ? StdErrLogger.MSG_MARKER[log_level] : ' '}`.padEnd(StdErrLogger.MARKER_PADDING, ' ')}${StdErrLogger.MARKER_BOUND} ${''.padEnd(pad_level * 2, '  ')}${StdErrLogger.MESSAGE_COLORS[log_level]}${trimmed}\x1B[0m`;
            } else {
                return undefined;
            }
        });

        lines.forEach(line => {
            if (line) {
                printerr(line);
            }
        });
    };

    decommission() {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this._log_writer = (throw_decommissioned as typeof this._log_writer);
    }
}

/** Логгер для отправки в systemd journal
 *
 * Особенности:
 * - НЕ передает в журнал DEBUG сообщения (не нужны в production)
 * - Если передается многострочное сообщение - в журнал попадает только первая строка
 * - Использует Unix domain socket для отправки
 * - Автоматически закрывает соединение при `decommission()`
 *
 * @example
 * ~~~ts
 * ~~~
 *
 * Проверить логи:
 * ~~~
 * journalctl -f SYSLOG_IDENTIFIER=my-extension
 * ~~~
 *
 * @see {@link StdErrLogger} альтернативный логгер для вывода в stderr
 * @see {@link NullLogger} логгер-заглушка */
export class SystemJournalLogger extends Logger implements Decommissionable {

    static socket_path = '/run/systemd/journal/socket' as const;

    static JOURNAL_LEVEL = {
        [LogLevel.error]: 3,
        [LogLevel.warning]: 4,
        [LogLevel.message]: 5,
        [LogLevel.debug]: 7,
    } as const;

    private id: string;
    private encoder;

    private socket: Gio.Socket | null;
    private address: Gio.UnixSocketAddress;

    /** Конструктор JournalLogger
     *
     * @param id Идентификатор для SYSLOG_IDENTIFIER в журнале
     * @throws {SocketInitError} Если не удалось инициализировать Unix socket */
    constructor(id: string) {

        super();

        this.encoder = new TextEncoder();
        this.id = id;

        try {// socket init
            // Проверяем существование сокета journal
            if (!GLib.file_test(SystemJournalLogger.socket_path, GLib.FileTest.EXISTS)) {
                throw new Error(`Journal socket not found: ${SystemJournalLogger.socket_path}`);
            }

            this.socket = Gio.Socket.new(
                Gio.SocketFamily.UNIX,
                Gio.SocketType.DATAGRAM,
                Gio.SocketProtocol.DEFAULT
            );

            this.address = Gio.UnixSocketAddress.new(SystemJournalLogger.socket_path);

        } catch (error) {
            this.socket = null;
            throw new SocketInitError('Failed to create journal socket.', { cause: error });
        }

    }

    /** Функция обработки лог-сообщений */
    protected _log_writer(log_level: LogLevel, message: string, pad_level: number = 0) {

        if (log_level !== LogLevel.debug) {
            try {
                if (this.socket) {

                    const log_entry = [
                        `SYSLOG_IDENTIFIER=${this.id}`,
                        `PRIORITY=${SystemJournalLogger.JOURNAL_LEVEL[log_level]}`,
                        `MESSAGE=${pad_level > 0 ? `${'*'.repeat(pad_level)} ` : ''}${message.split('\n')[0]}`,
                        ''
                    ].join('\n');

                    if (this.socket.send_to(this.address, this.encoder.encode(log_entry), null) > 0) {
                        return;
                    }

                    throw new SocketError('Send to Journal Socket fail!');
                }
            } catch (error) {
                printerr((error as Error).message);
                printerr(message);
            }
        }
    };

    decommission() {
        function throw_decommissioned(): never {
            throw new DecommissionedError();
        }

        // "Ломаем" все публичные методы
        this._log_writer = (throw_decommissioned as typeof this._log_writer);

        // закрываем сокет
        if (this.socket) {
            this.socket.close();
        }

        this.socket = (undefined as unknown as typeof this.socket);
        this.address = (undefined as unknown as typeof this.address);
        this.id = (undefined as unknown as typeof this.id);
        this.encoder = (undefined as unknown as typeof this.encoder);
    }

}
