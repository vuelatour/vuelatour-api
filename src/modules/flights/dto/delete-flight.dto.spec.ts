import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelFlightDto, DeleteFlightDto } from './flights.dto';

/**
 * Body OPCIONAL de DELETE /flights/:id (10-sep-2026, baja desde la app sin
 * internet). Misma configuración del ValidationPipe de main.ts (whitelist +
 * forbidNonWhitelisted + conversión implícita). El panel sigue llamando SIN
 * body: `{}` debe pasar tal cual.
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
const LLAVE = 'aaaaaaaa-0000-4000-8000-000000000003';

function del(plain: Record<string, unknown>): DeleteFlightDto {
  return plainToInstance(DeleteFlightDto, plain, {
    enableImplicitConversion: true,
  });
}

describe('DeleteFlightDto — body opcional del borrado', () => {
  it('sin body ({}: panel viejo) pasa la validación y no trae motivo', async () => {
    const d = del({});
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.motivo).toBeUndefined();
    expect(d.client_request_id).toBeUndefined();
  });

  it('motivo corto (< 5) → error en motivo (400)', async () => {
    const errores = await validate(del({ motivo: 'nop' }), OPTS);
    expect(errores.map((e) => e.property)).toEqual(['motivo']);
  });

  it('motivo de más de 500 → error en motivo', async () => {
    const errores = await validate(del({ motivo: 'x'.repeat(501) }), OPTS);
    expect(errores.map((e) => e.property)).toEqual(['motivo']);
  });

  it('motivo válido + client_request_id uuid pasan y conservan sus valores', async () => {
    const d = del({
      motivo: 'El cliente nunca confirmó',
      client_request_id: LLAVE,
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.motivo).toBe('El cliente nunca confirmó');
    expect(d.client_request_id).toBe(LLAVE);
  });

  it('client_request_id que no es uuid → error (solo trazabilidad, pero bien formado)', async () => {
    const errores = await validate(
      del({ motivo: 'Motivo válido', client_request_id: 'no-uuid' }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toEqual(['client_request_id']);
  });

  it('campo desconocido → rechazado (forbidNonWhitelisted, como todo el API)', async () => {
    const errores = await validate(del({ otra_cosa: 1 }), OPTS);
    expect(errores.map((e) => e.property)).toEqual(['otra_cosa']);
  });
});

describe('CancelFlightDto — sin cambio de contrato (motivo 3-500 obligatorio)', () => {
  const can = (plain: Record<string, unknown>) =>
    plainToInstance(CancelFlightDto, plain, { enableImplicitConversion: true });

  it('motivo válido pasa', async () => {
    expect(await validate(can({ motivo: 'Cliente canceló' }), OPTS)).toEqual(
      [],
    );
  });

  it('sin motivo → error', async () => {
    const errores = await validate(can({}), OPTS);
    expect(errores.map((e) => e.property)).toEqual(['motivo']);
  });
});
