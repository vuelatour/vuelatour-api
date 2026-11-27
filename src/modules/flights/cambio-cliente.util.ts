/**
 * CAMBIAR EL CLIENTE DE UN VUELO / COTIZACIÓN QUE YA EXISTE — textos y reglas
 * PURAS (27-nov-2026). Pedido de la oficina (Itzel y Jimmy, WhatsApp): «Nos
 * podrían habilitar cambiar de cliente cuando un vuelo o cotización ya
 * existe? porque no nos deja».
 *
 * La puerta es `PATCH /v1/flights/:id/cliente` (`FlightsService.cambiarCliente`).
 * `revise` SIGUE anclando `cliente_id` a lo persistido a propósito: el cliente
 * solo cambia por esta puerta explícita, que confirma en el panel y deja
 * rastro. Aquí vive lo que no toca la base:
 *  - los 4xx con `code` estable (el panel decide por código, nunca por texto);
 *  - el SELLO de `notas_internas` (quién, cuándo, de qué cliente a cuál);
 *  - los AVISOS ámbar: cambiar el cliente NO recalcula el precio ni toca el
 *    snapshot (la cotización conserva lo pactado), pero la SIGUIENTE versión
 *    que se guarde sí se cotiza con el cliente nuevo (tarifa preferencial,
 *    reglas de cliente interno) — eso se dice ANTES de que sorprenda.
 *
 * Sin `this`, sin BD, sin `new Date()`.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { fmtDineroTexto } from '../../common/dinero-texto.util';

/** Códigos ESTABLES de los rechazos propios del cambio de cliente. */
export const CODE_CLIENTE_NO_EXISTE = 'CLIENTE_NO_EXISTE';
export const CODE_CLIENTE_INACTIVO = 'CLIENTE_INACTIVO';
export const CODE_VUELO_FACTURADO = 'VUELO_FACTURADO';
export const CODE_VUELO_DE_GRUPO = 'VUELO_DE_GRUPO';

/** Por qué el vuelo «ya está facturado» (viaja en `details.motivo`). */
export type MotivoVueloFacturado =
  | 'CFDI'
  | 'FACTURA_EMITIDA'
  | 'ESTATUS_MANUAL';

const nombreDe = (n: string | null | undefined, respaldo: string): string => {
  const t = (n ?? '').trim();
  return t || respaldo;
};

/** 404: el cliente elegido no existe (o se borró entre la lectura y el guardado). */
export function errorClienteNoExiste(clienteId: string): NotFoundException {
  return new NotFoundException({
    message:
      'El cliente elegido ya no existe. Elige otro cliente y vuelve a intentar.',
    error: CODE_CLIENTE_NO_EXISTE,
    details: { cliente_id: clienteId },
  });
}

/** 400: el cliente elegido está dado de baja. */
export function errorClienteInactivo(c: {
  id: string;
  nombre: string | null;
}): BadRequestException {
  return new BadRequestException({
    message: `${nombreDe(c.nombre, 'Ese cliente')} está dado de baja: reactívalo en Clientes o elige otro.`,
    error: CODE_CLIENTE_INACTIVO,
    details: { cliente_id: c.id },
  });
}

/**
 * 409: la factura lleva RECEPTOR. Con una factura viva (CFDI timbrado, una
 * factura emitida VIGENTE ligada, o el estatus manual de factura) el cliente
 * no se cambia: quedaría una factura a nombre de A en un vuelo de B.
 */
export function errorVueloFacturado(p: {
  folio: number | string | null;
  motivo: MotivoVueloFacturado;
  /** Etiquetas «A-0440» de las facturas emitidas VIGENTES ligadas. */
  facturas?: string[];
  /** Etiqueta legible del estatus manual («Facturado»…). */
  estatus?: string | null;
}): ConflictException {
  const folio = p.folio ?? '?';
  let message: string;
  if (p.motivo === 'CFDI') {
    message = `El vuelo #${folio} ya tiene CFDI emitida a nombre de su cliente: cancela la factura antes de cambiar el cliente.`;
  } else if (p.motivo === 'FACTURA_EMITIDA') {
    const f = p.facturas ?? [];
    const lista =
      f.length === 0
        ? 'una factura registrada'
        : f.length === 1
          ? `la factura ${f[0]} registrada`
          : `las facturas ${f.slice(0, -1).join(', ')} y ${f[f.length - 1]} registradas`;
    message = `El vuelo #${folio} tiene ${lista} a nombre de su cliente: cancélala o desliga el vuelo en Facturas emitidas antes de cambiar el cliente.`;
  } else {
    message = `El vuelo #${folio} tiene la factura marcada como «${nombreDe(p.estatus, 'Facturado')}»: esa factura salió a nombre de su cliente. Regresa el estatus a «Sin factura» (y cancela la factura si ya se emitió) antes de cambiar el cliente.`;
  }
  return new ConflictException({
    message,
    error: CODE_VUELO_FACTURADO,
    details: {
      motivo: p.motivo,
      ...(p.facturas?.length ? { facturas: p.facturas } : {}),
    },
  });
}

/** 409: el cliente de un hijo de grupo es el del GRUPO completo. */
export function errorCambioClienteDeGrupo(p: {
  folio: number | string | null;
  grupoId: string;
  grupoFolio: number | string | null;
}): ConflictException {
  const g = p.grupoFolio != null ? ` G-${p.grupoFolio}` : '';
  return new ConflictException({
    message: `El vuelo #${p.folio ?? '?'} es parte de la cotización de grupo${g}: el cliente es el del grupo completo y no se cambia avión por avión.`,
    error: CODE_VUELO_DE_GRUPO,
    details: { grupo_id: p.grupoId, grupo_folio: p.grupoFolio ?? null },
  });
}

/**
 * Sello que queda en `vuelo.notas_internas` (patrón de los demás sellos del
 * vuelo: combinación deshecha, tramo agregado…): QUIÉN, CUÁNDO y de QUÉ
 * cliente a cuál. `fecha` ya viene formateada en hora Cancún.
 */
export function selloCambioCliente(p: {
  fecha: string;
  quien: string | null;
  anterior: string | null;
  nuevo: string | null;
}): string {
  const quien = (p.quien ?? '').trim();
  return `[Cliente cambiado el ${p.fecha}${quien ? ` por ${quien}` : ''}: «${nombreDe(p.anterior, 'sin cliente')}» → «${nombreDe(p.nuevo, 'cliente')}»]`;
}

/** Lo que se necesita saber de cada cliente para avisar. */
export interface ClienteDeCambio {
  nombre: string | null;
  es_interno: boolean;
  es_broker: boolean;
}

export interface EntradaAvisosCambioCliente {
  anterior: ClienteDeCambio | null;
  nuevo: ClienteDeCambio;
  /**
   * Tarifa preferencial del cliente NUEVO en el avión COTIZADO (lector único
   * `leerContextoCliente`, el mismo del motor). null = no tiene.
   */
  nuevo_tarifa_preferencial: number | null;
  /** Hay cotización guardada (`calculo_snapshot`): sin ella no hay precio pactado. */
  cotizado: boolean;
  /** Tarifa $/hr persistida (`tarifaPersistida`: snapshot vs columna). */
  tarifa_persistida: number | null;
  /** `calculo_snapshot.tarifa.proviene_de_override`: la oficina la tecleó. */
  tarifa_personalizada: boolean;
  /** `calculo_snapshot.tarifa.preferencial_cliente`: se pactó con la del cliente anterior. */
  tarifa_preferencial_aplicada: boolean;
  /** `calculo_snapshot.tarifa.tipo` / `vuelo.tarifa_tipo`. */
  tarifa_tipo: string | null;
  monto_total_usd: number;
  /** Cobros registrados en el vuelo (cuenta de `cobro_vuelo`). */
  cobros: number;
  /** De esos, los que nacen de un anticipo (Ingresos). */
  cobros_de_anticipo: number;
  /** El vuelo tiene «Necesito factura» pendiente. */
  solicitud_factura: boolean;
}

/** «$650/hr» · «$989.58/hr». */
const porHora = (n: number): string => `${fmtDineroTexto(n)}/hr`;

/** Dos tarifas son la misma a centavos por hora. */
const mismaTarifa = (a: number | null, b: number | null): boolean =>
  a != null && b != null && Math.abs(a - b) < 0.005;

const SIGUIENTE_VERSION = 'La próxima versión que se guarde de la cotización';

/**
 * AVISOS (ámbar, informativos) de un cambio de cliente YA guardado. El precio
 * no se movió; cada aviso dice qué cambia con el cliente nuevo y qué hacer.
 * Orden: lo que mueve dinero primero. Nunca lanza.
 */
export function avisosCambioCliente(e: EntradaAvisosCambioCliente): string[] {
  const avisos: string[] = [];
  const nuevo = nombreDe(e.nuevo.nombre, 'El cliente nuevo');
  const anterior = nombreDe(e.anterior?.nombre, 'el cliente anterior');
  const total = fmtDineroTexto(Number(e.monto_total_usd) || 0, 'USD');
  const eraInterno = e.anterior?.es_interno === true;
  const esInterno = e.nuevo.es_interno === true;

  if (e.cotizado) {
    if (esInterno && !eraInterno) {
      avisos.push(
        `${nuevo} es un cliente INTERNO (operación propia): este vuelo deja de contar como cuenta por cobrar en los reportes. La cotización conserva su total de ${total}; ${SIGUIENTE_VERSION.toLowerCase()} se cotizará como vuelo interno (sin hora mínima y sin tarifa, salvo que se capture una).`,
      );
    } else if (eraInterno && !esInterno) {
      avisos.push(
        `${anterior} es un cliente INTERNO y ${nuevo} no: el vuelo ahora cuenta como venta a un cliente. La cotización conserva su total de ${total}: revísala y guarda una versión para cobrarle (aplican la hora mínima y la tarifa del avión).`,
      );
    } else if (!esInterno) {
      const pref = e.nuevo_tarifa_preferencial;
      if (pref != null && !mismaTarifa(pref, e.tarifa_persistida)) {
        const conserva =
          e.tarifa_persistida != null
            ? ` y la cotización conserva ${porHora(e.tarifa_persistida)}`
            : '';
        avisos.push(
          e.tarifa_personalizada
            ? `${nuevo} tiene tarifa preferencial de ${porHora(pref)} en este avión${conserva} (tarifa personalizada): el precio NO cambió. Si quieres aplicarle la preferencial, cámbiala en la cotización y guarda una versión.`
            : `${nuevo} tiene tarifa preferencial de ${porHora(pref)} en este avión${conserva}: el precio NO cambió. ${SIGUIENTE_VERSION} se cotizará con ${porHora(pref)}.`,
        );
      } else if (
        pref == null &&
        e.tarifa_preferencial_aplicada &&
        !e.tarifa_personalizada
      ) {
        const pactada =
          e.tarifa_persistida != null
            ? ` (${porHora(e.tarifa_persistida)})`
            : '';
        avisos.push(
          `La cotización se pactó con la tarifa preferencial de ${anterior}${pactada} y ${nuevo} no tiene una en este avión: el precio NO cambió. ${SIGUIENTE_VERSION} se cotizará con la tarifa de lista del avión.`,
        );
      } else if (
        pref == null &&
        !e.tarifa_personalizada &&
        !e.tarifa_preferencial_aplicada
      ) {
        // Broker vs tarifa de lista: solo cuando la tarifa SÍ sale de la lista.
        if (e.nuevo.es_broker && e.tarifa_tipo === 'PUBLICO') {
          avisos.push(
            `${nuevo} es broker y la cotización está con tarifa PÚBLICA: el precio NO cambió. Si le corresponde la tarifa de broker, cámbiala en la cotización y guarda una versión.`,
          );
        } else if (!e.nuevo.es_broker && e.tarifa_tipo === 'BROKER') {
          avisos.push(
            `${nuevo} no es broker y la cotización está con tarifa de BROKER: el precio NO cambió. Si le corresponde la tarifa pública, cámbiala en la cotización y guarda una versión.`,
          );
        }
      }
    }
  }

  if (e.cobros > 0) {
    avisos.push(
      e.cobros === 1
        ? `El vuelo tiene 1 cobro registrado: se conserva tal cual y su recibo saldrá a nombre de ${nuevo}.`
        : `El vuelo tiene ${e.cobros} cobros registrados: se conservan tal cual y sus recibos saldrán a nombre de ${nuevo}.`,
    );
    if (e.cobros_de_anticipo > 0) {
      avisos.push(
        e.cobros_de_anticipo === 1
          ? '1 de esos cobros viene de un anticipo (Ingresos) registrado a nombre de un cliente: revisa que siga correspondiendo.'
          : `${e.cobros_de_anticipo} de esos cobros vienen de anticipos (Ingresos) registrados a nombre de un cliente: revisa que sigan correspondiendo.`,
      );
    }
  }

  if (e.solicitud_factura) {
    avisos.push(
      `El vuelo tiene «Necesito factura»: se facturará con los datos fiscales de ${nuevo}; revisa que estén completos en Clientes.`,
    );
  }
  return avisos;
}
