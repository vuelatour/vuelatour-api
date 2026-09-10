import type { ArgumentsHost } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Contrato del cuerpo de error que consumen el panel y la app: `code` sale
 * del `error` de una HttpException ESTRUCTURADA (objeto) y `details` viaja
 * tal cual; con un string solo hay `message` (code = nombre de la clase).
 * La app sin internet decide por `code` (VUELO_NO_EXISTE, VUELO_YA_CANCELADO…).
 */
type Body = {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
};

function correr(exception: unknown): { status: number; body: Body } {
  let status = 0;
  let body: Body | undefined;
  const res = {
    status: (s: number) => {
      status = s;
      return { json: (b: Body) => (body = b) };
    },
  };
  const req = { requestId: 'r-1', originalUrl: '/v1/flights/x' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, body: body! };
}

describe('AllExceptionsFilter — code/details de excepciones estructuradas', () => {
  it('NotFoundException con {message, error} → 404 con code VUELO_NO_EXISTE y el message intacto', () => {
    const { status, body } = correr(
      new NotFoundException({
        message: 'Vuelo abc not found',
        error: 'VUELO_NO_EXISTE',
        details: { vuelo_id: 'abc' },
      }),
    );
    expect(status).toBe(404);
    expect(body.code).toBe('VUELO_NO_EXISTE');
    expect(body.message).toBe('Vuelo abc not found');
    expect(body.details).toEqual({ vuelo_id: 'abc' });
  });

  it('ConflictException con details numéricos → 409 con code y details tal cual', () => {
    const { status, body } = correr(
      new ConflictException({
        message: 'El vuelo tiene actividad registrada',
        error: 'VUELO_CON_ACTIVIDAD',
        details: { cobros: 1, gastos: 0, tacos: 2 },
      }),
    );
    expect(status).toBe(409);
    expect(body.code).toBe('VUELO_CON_ACTIVIDAD');
    expect(body.details).toEqual({ cobros: 1, gastos: 0, tacos: 2 });
  });

  it('excepción de texto (legado) → code NOT_FOUND / CONFLICT por nombre de clase', () => {
    expect(correr(new NotFoundException('x')).body.code).toBe('NOT_FOUND');
    expect(correr(new ConflictException('y')).body.code).toBe('CONFLICT');
    expect(correr(new ConflictException('y')).body.message).toBe('y');
  });
});
