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
