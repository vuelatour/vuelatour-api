import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        message = response;
      } else if (response && typeof response === 'object') {
        const r = response as Record<string, unknown>;
        message = (r.message as string) ?? exception.message;
        code = (r.error as string) ?? exception.name;
        details = r.details;
      }
      code = code.toUpperCase().replace(/\s+/g, '_');
      // Subida multipart (24-sep-2026): `FileInterceptor` de Nest CONVIERTE
      // el MulterError en HttpException ANTES de llegar aquí (el caso de
      // abajo nunca lo veía) y el operador recibía «File too large» en
      // inglés. Se traduce con el peso aproximado del Content-Length.
      const subida = traducirErrorDeSubidaNest(
        status,
        message,
        req.headers?.['content-length'],
      );
      if (subida) {
        code = subida.code;
        message = subida.message;
        details = { tecnico: subida.tecnico };
      }
    } else if (exception instanceof Error && esErrorDeSubida(exception)) {
      // Subida de archivos (multer CRUDO — p. ej. un multer montado a mano;
      // el de `FileInterceptor` llega ya como HttpException, ver arriba): el
      // archivo que se pasa del tope o que viene en otro campo NO es un
      // error del servidor — es algo que quien sube puede corregir.
      const err = exception as Error & { code?: string; field?: string };
      code =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'ARCHIVO_MUY_GRANDE'
          : (err.code ?? 'UPLOAD_ERROR');
      status =
        err.code === 'LIMIT_FILE_SIZE'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.BAD_REQUEST;
      // Multer corta la subida al pasar el tope y NO sabe cuánto pesaba el
      // archivo; el Content-Length de la petición (archivo + unos cientos de
      // bytes del multipart) da el peso APROXIMADO para que el mensaje diga
      // algo accionable (24-sep-2026: «supera el máximo» sin cifra no le
      // decía al operador cuánto había que aligerar).
      const mb = megasAproxDe(req.headers?.['content-length']);
      message =
        err.code === 'LIMIT_FILE_SIZE'
          ? mb != null
            ? `El archivo pesa aprox. ${mb} MB y supera el tamaño máximo permitido. Súbelo más ligero.`
            : 'El archivo supera el tamaño máximo permitido. Súbelo más ligero.'
          : `No se pudo leer el archivo enviado${err.field ? ` (campo «${err.field}»)` : ''}.`;
      details = { tecnico: exception.message };
    } else if (exception instanceof Error) {
      // Los errores no controlados (Postgres/red) NUNCA llegan crudos al
      // usuario: se traducen a un mensaje accionable y lo técnico va a
      // details (y al log) para soporte.
      code = exception.name.toUpperCase();
      message = traducirErrorTecnico(exception.message);
      details = { tecnico: exception.message };
    }

    const body: ErrorBody = {
      statusCode: status,
      code,
      message,
      details,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    };

    if (status >= 500) {
      this.logger.error({ err: exception, requestId: req.requestId }, message);
    }

    res.status(status).json(body);
  }
}

/**
 * ¿Es un error de multer (subida multipart)? Se reconoce por el nombre de la
 * clase para no depender de `@types/multer` (el repo no lo instala).
 */
function esErrorDeSubida(err: Error): boolean {
  return err.name === 'MulterError';
}

/**
 * Errores de subida que `@nestjs/platform-express` ya convirtió a
 * HttpException (`multer.utils#transformException`): los reconoce por su
 * texto en inglés y devuelve el mensaje es-MX accionable. `null` = no es un
 * error de subida (se responde tal cual).
 */
export function traducirErrorDeSubidaNest(
  status: number,
  message: unknown,
  contentLength: string | string[] | undefined,
): { code: string; message: string; tecnico: string } | null {
  if (typeof message !== 'string') return null;
  if (status === 413 && message === 'File too large') {
    const mb = megasAproxDe(contentLength);
    return {
      code: 'ARCHIVO_MUY_GRANDE',
      message:
        mb != null
          ? `El archivo pesa aprox. ${mb} MB y supera el tamaño máximo permitido. Súbelo más ligero.`
          : 'El archivo supera el tamaño máximo permitido. Súbelo más ligero.',
      tecnico: message,
    };
  }
  if (status !== 400) return null;
  const inesperado = /^Unexpected field(?: - (.+))?$/.exec(message);
  if (inesperado) {
    return {
      code: 'CAMPO_ARCHIVO_INVALIDO',
      message: `El archivo tiene que ir en el campo «file» del formulario${
        inesperado[1] ? ` (llegó en «${inesperado[1]}»)` : ''
      }.`,
      tecnico: message,
    };
  }
  const ilegibles = [
    'Multipart:',
    'Too many parts',
    'Too many files',
    'Too many fields',
    'Field name too long',
    'Field value too long',
    'Field name missing',
  ];
  if (ilegibles.some((p) => message.startsWith(p))) {
    return {
      code: 'SUBIDA_ILEGIBLE',
      message:
        'No se pudo leer el archivo enviado (la subida llegó incompleta o mal formada). Intenta de nuevo.',
      tecnico: message,
    };
  }
  return null;
}

/** MB con un decimal a partir de un Content-Length (o null si no sirve). */
function megasAproxDe(v: string | string[] | undefined): string | null {
  const n = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n / 1024 / 1024).toFixed(1);
}

/**
 * Mapea errores técnicos comunes (Postgres/Supabase/red) a mensajes que el
 * usuario puede entender y accionar. El detalle crudo viaja en `details`.
 */
function traducirErrorTecnico(raw: string): string {
  const m = raw.toLowerCase();
  const col = /column "?(\w+)"?/i.exec(raw)?.[1];
  if (m.includes('non-default value into column')) {
    return `No se pudo guardar: el dato "${col ?? 'desconocido'}" lo calcula el sistema automáticamente. Intenta de nuevo; si persiste, repórtalo a soporte.`;
  }
  if (m.includes('duplicate key value')) {
    return 'Ya existe un registro con esos mismos datos; revisa si está duplicado.';
  }
  if (m.includes('violates foreign key constraint')) {
    return 'Uno de los datos relacionados ya no existe (pudo haberse eliminado). Recarga la página e intenta de nuevo.';
  }
  if (m.includes('null value in column') || m.includes('not-null constraint')) {
    return `Falta un dato obligatorio${col ? ` ("${col}")` : ''} para completar la acción.`;
  }
  if (m.includes('violates check constraint')) {
    return 'Alguno de los valores capturados no es válido para este registro; revisa los campos e intenta de nuevo.';
  }
  if (
    m.includes('fetch failed') ||
    m.includes('econnrefused') ||
    m.includes('timeout') ||
    m.includes('network')
  ) {
    return 'No hay conexión con el servidor de datos. Espera unos segundos e intenta de nuevo.';
  }
  return 'Ocurrió un error inesperado al procesar la acción. Intenta de nuevo; si persiste, contacta a soporte.';
}
