import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateReservaDto } from './flights.dto';

/**
 * Body de POST /flights/reserva con los campos del alta sin internet
 * (9-sep-2026). Misma configuración del ValidationPipe de main.ts
 * (whitelist + forbidNonWhitelisted + conversión implícita).
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;

const CLIENTE = 'aaaaaaaa-0000-4000-8000-000000000001';
const AVION = 'aaaaaaaa-0000-4000-8000-000000000002';
const LLAVE = 'aaaaaaaa-0000-4000-8000-000000000003';
const APOYO = 'aaaaaaaa-0000-4000-8000-000000000004';

function dto(plain: Record<string, unknown>): CreateReservaDto {
  return plainToInstance(CreateReservaDto, plain, {
    enableImplicitConversion: true,
  });
}

const base = {
  origen_iata: 'CUN',
  destino_iata: 'HOL',
  fecha_vuelo: '2026-09-14T14:00:00Z',
  aeronave_id: AVION,
};

describe('CreateReservaDto — cliente por id o por nombre', () => {
  it('cliente_nombre SIN cliente_id pasa la validación', async () => {
    const errores = await validate(
      dto({ ...base, cliente_nombre: 'Juan Pérez' }),
      OPTS,
    );
    expect(errores).toEqual([]);
  });

  it('con AMBOS pasa (en el servicio gana cliente_id)', async () => {
    const d = dto({ ...base, cliente_id: CLIENTE, cliente_nombre: 'Juan' });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.cliente_id).toBe(CLIENTE);
    expect(d.cliente_nombre).toBe('Juan');
  });

  it('sin ninguno de los dos → error en cliente_id (retrocompatible: la APK vieja lo manda siempre)', async () => {
    const errores = await validate(dto({ ...base }), OPTS);
    expect(errores.map((e) => e.property)).toContain('cliente_id');
  });

  it('cliente_id inválido sigue rechazándose aunque venga nombre? No: con nombre no se valida el id ausente, pero un id mal formado sí', async () => {
    const errores = await validate(
      dto({ ...base, cliente_id: 'no-es-uuid' }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toContain('cliente_id');
  });

  it('cliente_nombre de 1 carácter → error (2-200)', async () => {
    const errores = await validate(dto({ ...base, cliente_nombre: 'J' }), OPTS);
    expect(errores.map((e) => e.property)).toContain('cliente_nombre');
  });
});

describe('CreateReservaDto — campos del outbox', () => {
  it('acepta client_request_id, apoyo_ids, capturado_en y las banderas de duplicado', async () => {
    const d = dto({
      ...base,
      cliente_id: CLIENTE,
      client_request_id: LLAVE,
      apoyo_ids: [APOYO],
      capturado_en: '2026-09-14T09:00:00-05:00',
      rechazar_posible_duplicado: true,
      aceptar_posible_duplicado: false,
      aceptar_discrepancia_alta: true,
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.rechazar_posible_duplicado).toBe(true);
    expect(d.aceptar_posible_duplicado).toBe(false);
  });

  it('capturado_en con basura NO falla la validación (la tolerancia vive en el servicio)', async () => {
    const errores = await validate(
      dto({ ...base, cliente_id: CLIENTE, capturado_en: 'ayer' }),
      OPTS,
    );
    expect(errores).toEqual([]);
  });

  it('client_request_id no-uuid y apoyo_ids no-uuid → error', async () => {
    const errores = await validate(
      dto({
        ...base,
        cliente_id: CLIENTE,
        client_request_id: '123',
        apoyo_ids: ['x'],
      }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toEqual(
      expect.arrayContaining(['client_request_id', 'apoyo_ids']),
    );
  });

  it('capturado_en NUNCA provoca 400: ni largo (> 60) ni de otro tipo', async () => {
    const largo = await validate(
      dto({ ...base, cliente_id: CLIENTE, capturado_en: 'x'.repeat(200) }),
      OPTS,
    );
    expect(largo).toEqual([]);
    const numero = await validate(
      dto({ ...base, cliente_id: CLIENTE, capturado_en: 12345 }),
      OPTS,
    );
    expect(numero).toEqual([]);
  });

  it('cliente_id mal formado se rechaza AUNQUE venga cliente_nombre (nunca llega basura al service)', async () => {
    const errores = await validate(
      dto({ ...base, cliente_id: 'no-es-uuid', cliente_nombre: 'Juan Pérez' }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toContain('cliente_id');
  });

  it('claves desconocidas (p. ej. `_proyeccion` del outbox) se rechazan', async () => {
    const errores = await validate(
      dto({ ...base, cliente_id: CLIENTE, _proyeccion: {} }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toContain('_proyeccion');
  });
});
