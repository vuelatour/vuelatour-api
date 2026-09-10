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

/**
 * Vuelo EXTERNO y piloto externo por nombre desde la reserva (9-sep-2026).
 * Todo opcional y retrocompatible: el panel y la APK vieja no mandan nada.
 */
describe('CreateReservaDto — vuelo externo (es_externo)', () => {
  const externo = {
    origen_iata: 'CUN',
    destino_iata: 'HOL',
    fecha_vuelo: '2026-09-14T14:00:00Z',
    cliente_id: CLIENTE,
  };

  it('es_externo SIN operador_externo → error en operador_externo', async () => {
    const errores = await validate(dto({ ...externo, es_externo: true }), OPTS);
    expect(errores.map((e) => e.property)).toContain('operador_externo');
  });

  it('es_externo CON aeronave_id → error (un externo no lleva avión propio)', async () => {
    const errores = await validate(
      dto({
        ...externo,
        es_externo: true,
        operador_externo: 'XA-TIB',
        aeronave_id: AVION,
      }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toContain('es_externo');
  });

  it('es_externo con operador y SIN aeronave pasa; ficha y costo con moneda se aceptan', async () => {
    const d = dto({
      ...externo,
      es_externo: true,
      operador_externo: 'XA-TIB',
      externo_matricula: 'XA-REG',
      externo_modelo: 'Hawker 400',
      costo_externo_monto: '1500',
      costo_externo_moneda: 'MXN',
      costo_externo_tc: '20',
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.costo_externo_monto).toBe(1500);
    expect(d.costo_externo_tc).toBe(20);
  });

  it('es_externo:false (o ausente) sin aeronave_id pasa el DTO (el service rebota «Elige la aeronave»)', async () => {
    expect(
      await validate(dto({ ...externo, es_externo: false }), OPTS),
    ).toEqual([]);
  });

  it('operador_externo de 1 carácter, matrícula > 20, modelo > 60, moneda rara o monto negativo → error', async () => {
    const errores = await validate(
      dto({
        ...externo,
        es_externo: true,
        operador_externo: 'X',
        externo_matricula: 'X'.repeat(21),
        externo_modelo: 'M'.repeat(61),
        costo_externo_monto: -1,
        costo_externo_moneda: 'EUR',
      }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toEqual(
      expect.arrayContaining([
        'operador_externo',
        'externo_matricula',
        'externo_modelo',
        'costo_externo_monto',
        'costo_externo_moneda',
      ]),
    );
  });
});

describe('CreateReservaDto — piloto externo por nombre', () => {
  const PILOTO = 'aaaaaaaa-0000-4000-8000-000000000005';

  it('piloto_externo_nombre SIN piloto_id pasa (con teléfono opcional)', async () => {
    const d = dto({
      ...base,
      cliente_id: CLIENTE,
      piloto_externo_nombre: 'Juan Pérez',
      piloto_externo_telefono: '9981234567',
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.piloto_id).toBeUndefined();
  });

  it('con AMBOS pasa y gana piloto_id (el nombre ni se valida)', async () => {
    const d = dto({
      ...base,
      cliente_id: CLIENTE,
      piloto_id: PILOTO,
      piloto_externo_nombre: 'J',
    });
    expect(await validate(d, OPTS)).toEqual([]);
    expect(d.piloto_id).toBe(PILOTO);
  });

  it('piloto_externo_nombre de 1 carácter sin piloto_id → error; teléfono > 20 → error', async () => {
    const errores = await validate(
      dto({
        ...base,
        cliente_id: CLIENTE,
        piloto_externo_nombre: 'J',
        piloto_externo_telefono: '9'.repeat(21),
      }),
      OPTS,
    );
    expect(errores.map((e) => e.property)).toEqual(
      expect.arrayContaining([
        'piloto_externo_nombre',
        'piloto_externo_telefono',
      ]),
    );
  });

  it('sin piloto_id ni nombre sigue pasando (reserva tentativa sin piloto)', async () => {
    expect(await validate(dto({ ...base, cliente_id: CLIENTE }), OPTS)).toEqual(
      [],
    );
  });
});
