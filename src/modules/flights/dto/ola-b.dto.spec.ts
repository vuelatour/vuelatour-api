import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AssignFlightDto,
  ListFlightsQuery,
  UpdateFlightDto,
} from './flights.dto';
import {
  AssignEscalaDto,
  CreateEscalaDto,
  OperationalLegDto,
  UpdateEscalaDto,
} from './escalas.dto';

/**
 * Campos OPCIONALES de la Ola B (10-sep-2026): `if_updated_at` (control de
 * versión), `client_request_id` en tramos (idempotencia) y `updated_since`
 * (deltas). Misma configuración del ValidationPipe de main.ts. Sin ellos,
 * cada DTO valida exactamente como antes.
 */
const OPTS = { whitelist: true, forbidNonWhitelisted: true } as const;
const UUID = 'aaaaaaaa-0000-4000-8000-000000000003';
const ISO = '2026-09-10T12:34:56.123Z';

function arma<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
): T {
  return plainToInstance(cls, plain, { enableImplicitConversion: true });
}
const props = async (dto: object) =>
  (await validate(dto, OPTS)).map((e) => e.property);

describe('if_updated_at (B1) en los DTOs de edición', () => {
  it.each([
    ['UpdateFlightDto', UpdateFlightDto, { notas: 'x' }],
    ['AssignFlightDto', AssignFlightDto, { piloto_id: UUID }],
    ['UpdateEscalaDto', UpdateEscalaDto, { notas: 'x' }],
    ['AssignEscalaDto', AssignEscalaDto, { piloto_id: UUID }],
  ] as const)(
    '%s: ISO válido pasa y se conserva; sin él pasa igual',
    async (_n, cls, base) => {
      const con = arma(cls as new () => { if_updated_at?: string }, {
        ...base,
        if_updated_at: ISO,
      });
      expect(await props(con)).toEqual([]);
      expect(con.if_updated_at).toBe(ISO);
      expect(await props(arma(cls, { ...base }))).toEqual([]);
    },
  );

  it.each([
    ['UpdateFlightDto', UpdateFlightDto],
    ['AssignFlightDto', AssignFlightDto],
    ['UpdateEscalaDto', UpdateEscalaDto],
    ['AssignEscalaDto', AssignEscalaDto],
  ] as const)(
    '%s: if_updated_at que no es fecha ISO → 400 en ese campo',
    async (_n, cls) => {
      expect(await props(arma(cls, { if_updated_at: 'ayer' }))).toEqual([
        'if_updated_at',
      ]);
    },
  );
});

describe('client_request_id (B2) en las altas de tramo', () => {
  const tramo = { orden: 2, origen_iata: 'CUN', destino_iata: 'HOL' };

  it('CreateEscalaDto: uuid pasa; no-uuid rebota; sin llave = contrato de siempre', async () => {
    const con = arma(CreateEscalaDto, { ...tramo, client_request_id: UUID });
    expect(await props(con)).toEqual([]);
    expect(con.client_request_id).toBe(UUID);
    expect(
      await props(arma(CreateEscalaDto, { ...tramo, client_request_id: 'x' })),
    ).toEqual(['client_request_id']);
    expect(await props(arma(CreateEscalaDto, tramo))).toEqual([]);
  });

  it('OperationalLegDto: uuid pasa; no-uuid rebota', async () => {
    const base = { origen_iata: 'CUN', destino_iata: 'PCE', es_ferry: true };
    expect(
      await props(
        arma(OperationalLegDto, { ...base, client_request_id: UUID }),
      ),
    ).toEqual([]);
    expect(
      await props(arma(OperationalLegDto, { ...base, client_request_id: 'x' })),
    ).toEqual(['client_request_id']);
  });

  it('UpdateEscalaDto hereda la llave como opcional (se ignora al editar) y acepta ambos campos', async () => {
    const d = arma(UpdateEscalaDto, {
      notas: 'x',
      client_request_id: UUID,
      if_updated_at: ISO,
    });
    expect(await props(d)).toEqual([]);
  });

  it('campo desconocido → rechazado (forbidNonWhitelisted, como todo el API)', async () => {
    expect(
      await props(arma(CreateEscalaDto, { ...tramo, otra_cosa: 1 })),
    ).toEqual(['otra_cosa']);
  });
});

describe('updated_since (B5) en GET /flights', () => {
  it('ISO con zona pasa y conserva defaults de paginación; sin él, igual que antes', async () => {
    const q = arma(ListFlightsQuery, {
      updated_since: '2026-09-10T00:00:00-05:00',
    });
    expect(await props(q)).toEqual([]);
    expect(q.updated_since).toBe('2026-09-10T00:00:00-05:00');
    expect(q.limit).toBe(50);
    expect(q.offset).toBe(0);
    expect(await props(arma(ListFlightsQuery, {}))).toEqual([]);
  });

  it('texto que no es fecha → 400 en updated_since', async () => {
    expect(
      await props(arma(ListFlightsQuery, { updated_since: 'hoy' })),
    ).toEqual(['updated_since']);
  });
});
