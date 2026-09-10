import { ConflictException } from '@nestjs/common';
import {
  CODE_CLIENT_REQUEST_ID_EN_USO,
  clientRequestIdEnUso,
  mensajeClientRequestIdEnUso,
} from './client-request-id.util';

describe('clientRequestIdEnUso — llave reutilizada fuera de su ámbito', () => {
  const KEY = '11111111-1111-4111-8111-111111111111';

  it('409 estructurado con code, details.client_request_id y ámbito por entidad', () => {
    const err = clientRequestIdEnUso('tramo', KEY);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    const r = err.getResponse() as Record<string, unknown>;
    expect(r.error).toBe(CODE_CLIENT_REQUEST_ID_EN_USO);
    expect(r.details).toEqual({ client_request_id: KEY });
    expect(r.message).toBe(
      'La llave client_request_id de este tramo ya se usó en otro vuelo; genera una llave nueva por captura.',
    );
  });

  it('cada entidad nombra su ámbito (vuelo / avión / producto)', () => {
    expect(mensajeClientRequestIdEnUso('cobro')).toMatch(/otro vuelo/);
    expect(mensajeClientRequestIdEnUso('reporte')).toMatch(/otro avión/);
    expect(mensajeClientRequestIdEnUso('movimiento')).toMatch(/otro producto/);
  });
});
