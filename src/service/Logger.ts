/** @file: src/service/Logger.ts */
/** @license: https://www.gnu.org/licenses/gpl.txt */
/** @version: 2.1.1 */
/**
 * @changelog
 *
 * # 2.1.1 - Экспорт вспомогательных функций
 *
 * # 2.1.0 - Глобальный логгер
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
class SocketInitError extends Error {
    constructor(message = 'Failed to initialize socket', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SocketInitError';
    }
}

/** Ошибка, при работе с сокетом */
class SocketError extends Error {
    constructor(message = 'Send to Journal Socket fail!', options?: ErrorOptions) {
        super(message, options);
        this.name = 'SocketError';
    }
}

/** Ошибка при попытке использовать глобальный логгер до его инициализации */
class UninitializedLoggerError extends Error {
    constructor(message = 'Global logger must be initialized with set_as_global()', options?: ErrorOptions) {
        super(message, options);
        this.name = 'UninitializedLoggerError';
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
abstract class LoggerType implements Decommissionable {

    #last_log_level = LogLevel.message as LogLevel;

    /** Функция обработки лог-сообщений
     *
     * Должна быть реализована в наследниках для определения
     * куда и как выводить сообщения. Метод вызывается для каждого
     * сообщения и отвечает за его форматирование и вывод.
     *
     * @param log_level Уровень логирования
     * @param message Текст сообщения (может быть многострочным)
     * @param pad_level Уровень вложенности для отступов (0 = основное сообщение)
     *
     * @example
     * ~~~typescript
     * // Простейшая реализация
     * protected _log_writer(log_level: LogLevel, message: string, pad_level: number): void {
     *     const prefix = ' '.repeat(pad_level * 2);
     *     console.log(`${prefix}[${LogLevel[log_level]}] ${message}`);
     * }
     * ~~~ */
    protected abstract _log_writer(log_level: LogLevel, message: string, pad_level: number): void;

    #do_msg(log_level: LogLevel, content: string | Error, error?: Error) {
        this.#last_log_level = log_level;
        if (typeof content === 'string') {
            this._log_writer(log_level, content, 0);
            if (error !== undefined) {
                this.#do_err(log_level, error, 1);
            }
        } else {
            this.#do_err(log_level, content, 0);
        }
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
     * Используется для критических ситуаций, требующих немедленного внимания.
     * В production (SystemJournalLogger) попадает в системный журнал с приоритетом ERROR.
     *
     * @param msg Сообщение об ошибке
     *
     * @example
     * ~~~typescript
     * // Простое текстовое сообщение
     * logger.error('Database connection failed');
     *
     * // Объект ошибки
     * logger.error(new Error('File not found'));
     *
     * // Сообщение с дополнительной ошибкой
     * try {
     *     await database.connect();
     * } catch (err) {
     *     logger.error('Failed to connect to database', err as Error);
     * }
     * ~~~
     *  */
    error(msg: string): void;
    /**
     * @param err Объект ошибки для логирования со stack trace */
    error(err: Error): void;
    /**
     * @param msg Описание контекста ошибки
     * @param err Объект ошибки с деталями */
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

    abstract decommission(): void;
}

/** Логгер-"пустышка" - блокирует все сообщения
 *
 * Используется для полного отключения логирования */
class NullLogger extends LoggerType {

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
class StdErrLogger extends LoggerType {

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
    protected _log_writer(log_level: LogLevel, message: string, pad_level = 0) {

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
 * Основной логгер для production окружения. Отправляет сообщения
 * напрямую в systemd journal через Unix domain socket.
 *
 * Особенности:
 * - НЕ передает в журнал DEBUG сообщения (фильтруются для production)
 * - Многострочные сообщения обрезаются до первой строки
 * - Использует Unix domain socket (`/run/systemd/journal/socket`)
 * - Автоматически закрывает соединение при `decommission()`
 * - Поддерживает приоритеты systemd (3=ERR, 4=WARNING, 5=NOTICE, 7=DEBUG)
 *
 * @example
 * ~~~typescript
 * // Инициализация для расширения
 * const logger = new SystemJournalLogger('my-gnome-extension');
 *
 * // Использование
 * logger.info('Extension started');
 * logger.error('Failed to load settings', error);
 *
 * // Проверка логов через journalctl
 * // Все сообщения расширения:
 * // journalctl -f SYSLOG_IDENTIFIER=my-gnome-extension
 *
 * // Только ошибки (PRIORITY=3):
 * // journalctl -f SYSLOG_IDENTIFIER=my-gnome-extension PRIORITY=3
 *
 * // За последний час:
 * // journalctl --since "1 hour ago" SYSLOG_IDENTIFIER=my-gnome-extension
 *
 * Проверить логи:
 * ~~~
 * journalctl -f SYSLOG_IDENTIFIER=my-extension
 * ~~~
 *
 * @see {@link StdErrLogger} альтернативный логгер для вывода в stderr
 * @see {@link NullLogger} логгер-заглушка */
class SystemJournalLogger extends LoggerType {

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
    protected _log_writer(log_level: LogLevel, message: string, pad_level = 0) {

        if (log_level !== LogLevel.debug) {
            try {
                if (this.socket) {
                    const first_line = message.split('\n')[0].trim();
                    if (first_line.length > 0) {
                        const log_entry = [
                            `SYSLOG_IDENTIFIER=${this.id}`,
                            `PRIORITY=${SystemJournalLogger.JOURNAL_LEVEL[log_level]}`,
                            `MESSAGE=${pad_level > 0 ? `${'*'.repeat(pad_level)} ` : ''}${first_line}`,
                            ''
                        ].join('\n');

                        if (this.socket.send_to(this.address, this.encoder.encode(log_entry), null) > 0) {
                            return;
                        }

                        throw new SocketError('Send to Journal Socket fail!');
                    }
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

// GLOBAL_LOGGER

let GLOBAL_LOGGER = null as LoggerType | null;

/** Установка глобального логгера
 *
 * Устанавливает логгер, который будет использоваться всеми глобальными
 * функциями логирования (debug, info, log, warn, error, sub_msg).
 * Если глобальный логгер уже установлен, он будет деактивирован.
 *
 * @param logger Экземпляр логгера для использования глобально
 *
 * @example
 * ~~~typescript
 * // Для production
 * Logger.set_as_global(new Logger.SystemJournalLogger('my-extension'));
 *
 * // Для разработки
 * Logger.set_as_global(new Logger.StdErrLogger());
 *
 * // Для отключения логирования
 * Logger.set_as_global(new Logger.NullLogger());
 * ~~~
 *  */
function set_as_global(logger: LoggerType): void {
    if (GLOBAL_LOGGER) {
        GLOBAL_LOGGER.decommission();
        GLOBAL_LOGGER = null;
    }
    GLOBAL_LOGGER = logger;
}

/** Получение текущего глобального логгера
 *
 * Возвращает readonly версию установленного глобального логгера.
 * Используется внутренне глобальными функциями логирования.
 *
 * @returns Глобальный логгер (readonly)
 * @throws {UninitializedLoggerError} Если глобальный логгер не установлен */
function get_global(): Readonly<LoggerType> {
    if (!GLOBAL_LOGGER) {
        throw new UninitializedLoggerError();
    }
    return Object.freeze(GLOBAL_LOGGER);
}

/** Деактивация глобального логгера
 *
 * Вызывает decommission() на текущем глобальном логгере и удаляет ссылку.
 * После вызова все попытки использовать глобальные функции логирования
 * будут приводить к `UninitializedLoggerError`.
 *
 * @example
 * ~~~typescript
 * // При завершении работы расширения
 * function disable() {
 *     Logger.decommission_global_logger();
 * }
 * ~~~
 *  */
function decommission_global_logger(): void {
    if (GLOBAL_LOGGER) {
        GLOBAL_LOGGER.decommission();
        GLOBAL_LOGGER = null;
    }
}

// Глобальные функции-сокращения для удобства

/** Глобальное логирование отладочной информации
 *
 * Использует глобальный логгер, установленный через set_as_global().
 * В production (SystemJournalLogger) эти сообщения НЕ попадают в журнал.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
 *
 * @example
 * ~~~typescript
 * import * as Logger from './Logger.js';
 *
 * // В начале приложения
 * Logger.set_as_global(new Logger.SystemJournalLogger('my-app'));
 *
 * // В любом месте кода
 * Logger.debug('Начало обработки файла');
 * Logger.debug(`Обработано ${count} элементов`);
 * ~~~
 *
 * @param msg Отладочное сообщение */
export function debug(msg: string): void;
/**
 * @param err Ошибка */
export function debug(err: Error): void;
/**
 * @param context Контекст ошибки
 * @param err Связанная ошибка */
export function debug(context: string, err: Error): void;
/**
 * @param content Отладочное сообщение или контекст ошибки
 * @param err Связанная ошибка */
export function debug(content: string | Error, error?: Error): void {
    // @ts-expect-error Types cast errors
    get_global().debug(content, error);
}

/** Глобальное информационное логирование (упрощенная версия log)
 *
 * Использует глобальный логгер для записи важных информационных сообщений.
 * В отличие от log(), принимает только строковые сообщения.
 * Используйте для ключевых событий жизненного цикла приложения.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
*
* @example
* ~~~typescript
* Logger.info('Extension activated successfully');
* Logger.info(`Connected to ${server_name}`);
* Logger.info('Configuration loaded from user settings');
* ~~~
*
 * @param msg Информационное сообщение */
export function info(msg: string): void {
    get_global().info(msg);
}


/** Глобальное логирование обычных сообщений
 *
 * Использует глобальный логгер для записи информационных сообщений.
 * Подходит для логирования хода выполнения операций и промежуточных состояний.
 * В production попадает в системный журнал с приоритетом NOTICE.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
 *
 * @example
 * ~~~typescript
 * // Простое сообщение
 * Logger.log('Processing user request...');
 *
 * // Логирование с ошибкой (не критичной)
 * try {
 *     await optional_feature.load();
 * } catch (err) {
 *     Logger.log('Optional feature unavailable', err as Error);
 * }
 * ~~~
 *
 * @param msg Информационное сообщение */
export function log(msg: string): void;
/**
 * @param err Объект ошибки с деталями */
export function log(err: Error): void;
/**
 * @param context Контекст для логирования
 * @param err Объект ошибки с деталями */
export function log(context: string, err: Error): void;
/**
 * @param content Информационное сообщение или контекст ошибки
 * @param err Объект ошибки с деталями */
export function log(content: string | Error, error?: Error): void {
    // @ts-expect-error Types cast errors
    get_global().log(content, error);
}


/** Глобальное логирование предупреждений
 *
 * Использует глобальный логгер для записи предупреждений.
 * Применяйте для некритичных проблем, которые не препятствуют работе,
 * но требуют внимания пользователя или администратора.
 * В production попадает в журнал с приоритетом WARNING.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
 *
 * @example
 * ~~~typescript
 * // Простое предупреждение
 * Logger.warn('Configuration file missing, using defaults');
 *
 * // Предупреждение с ошибкой
 * Logger.warn('Failed to load optional module', load_error);
 *
 * // Предупреждение о производительности
 * if (items.length > 1000) {
 *     Logger.warn(`Large dataset detected: ${items.length} items`);
 * }
 * ~~~
 *
 * @param msg Текст предупреждения
 * */
export function warn(msg: string): void;
/**
 * @param err Ошибка, будет выведена как предупреждение */
export function warn(err: Error): void;
/**
 * @param context Описание предупреждения
 * @param err Связанная ошибка */
export function warn(context: string, err: Error): void;
/**
 * @param content Текст предупреждения или контекст ошибки
 * @param err Связанная ошибка */
export function warn(content: string | Error, error?: Error): void {
    // @ts-expect-error Types cast errors
    get_global().warn(content, error);
}

/** Глобальное логирование критических ошибок
 *
 * Использует глобальный логгер для записи критических ошибок.
 * Применяйте только для серьезных проблем, требующих немедленного внимания.
 * В production попадает в журнал с приоритетом ERROR.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
 *
 * @example
 * ~~~typescript
 * // Критическая ошибка
 * Logger.error('Failed to initialize core service');
 *
 * // Ошибка с исключением
 * try {
 *     await critical_operation();
 * } catch (err) {
 *     Logger.error('Critical operation failed', err as Error);
 *     throw err; // пробрасываем дальше
 * }
 *
 * // Неожиданное состояние
 * if (!required_component) {
 *     Logger.error(new Error('Required component is null'));
 * }
 * ~~~
 *
 * @param msg Описание проблемы */
export function error(msg: string): void;
/**
 * @param err Объект ошибки */
export function error(err: Error): void;
/**
 * @param context Контекст ошибки
 * @param err Объект ошибки с деталями */
export function error(context: string, err: Error): void;
/**
 * @param content Описание проблемы или контекст ошибки
 * @param err Объект ошибки с деталями */
export function error(content: string | Error, error?: Error): void {
    // @ts-expect-error Types cast errors
    get_global().error(content, error);
}

/** Логирование вложенного сообщения
 *
 * Создает визуальную иерархию сообщений, добавляя отступы.
 * Использует уровень логирования последнего основного сообщения.
 * Полезно для группировки связанных сообщений.
 *
 * @throws {UninitializedLoggerError} Если глобальный логгер не инициализирован
 *
 * @example
 * ~~~typescript
 * Logger.info('Initializing extension components');
 * Logger.sub_msg('Loading user preferences...');
 * Logger.sub_msg('Connecting to D-Bus service...');
 * Logger.sub_msg('Setting up file watchers...');
 * Logger.sub_msg('Initialization complete');
 *
 * // С ошибками
 * Logger.error('Failed to start service');
 * Logger.sub_msg(validation_error);
 * Logger.sub_msg('Check configuration and retry');
 * ~~~
 *
 * @param msg Вложенное сообщение
 *  */
export function sub_msg(msg: string): void;
/**
 * @param err Объект ошибки, будет вложен в основное сообщение */
export function sub_msg(err: Error): void;
/**
 * @param content Вложенное сообщение или контекст ошибки */
export function sub_msg(content: string | Error): void {
    // @ts-expect-error Types cast errors
    get_global().sub_msg(content);
}

export {
    SocketInitError,
    SocketError,
    NullLogger,
    StdErrLogger,
    SystemJournalLogger,
    set_as_global,
    get_global,
    decommission_global_logger,
};
