/**
 * AVIÓN EN TALLER = AVISO, NUNCA CANDADO (decisión del cliente,
 * 11-sep-2026).
 *
 * Hasta hoy el taller rebotaba 409 `AERONAVE_EN_TALLER` al cotizar y al
 * asignar. El cliente lo cambió con estas palabras: «al cotizar debe poder
 * elegirse un avión aunque esté en taller (son cotizaciones a futuro), y
 * aunque no lo fueran debe dejarte; la advertencia está bien pero con eso es
 * suficiente, no debe limitarte; lo mismo para el vuelo». La razón de
 * negocio: casi toda cotización es a futuro y el avión sale del taller antes
 * del vuelo — bloquear obligaba a inventar cotizaciones con otro avión.
 *
 * Por eso el taller ya NO lanza en ningún camino del API: se anexa ESTE
 * texto a `avisos[]` de la respuesta (campo aditivo, siempre presente aunque
 * vaya vacío) y el panel/la app lo pintan en ÁMBAR (informativo: ni modal,
 * ni confirm, ni rojo). El selector de avión sigue MARCANDO «En taller»
 * (`GET /aircraft` expone `en_taller`) pero no deshabilita.
 *
 * Lo que NO cambió: el squawk de severidad ALTA sigue exigiendo confirmación
 * (409 estructurado `SQUAWK_ALTA_SIN_RESOLVER` + `aceptar_discrepancia_alta`
 * + aviso al mecánico) y los documentos críticos vencidos siguen solo
 * avisando.
 *
 * FUENTE ÚNICA del texto: todo camino (assign, assign por tramo, reserva,
 * reassign-aircraft, combinar, cotización create/revise/quickAdjust y el
 * grupo) usa `avisoAeronaveEnTaller`. Si el texto se replica a mano, el
 * panel y la app dejan de reconocerlo.
 */

/**
 * Aviso ÚNICO de "este avión está en taller y se guardó de todas formas".
 *
 * @param matricula matrícula del avión; sin ella (lectura fallida, avión sin
 * matrícula capturada) el aviso arranca con «El avión» y sigue siendo
 * legible — jamás se devuelve un texto con un hueco ni se omite el aviso.
 */
export function avisoAeronaveEnTaller(matricula?: string | null): string {
  const m = (matricula ?? '').trim();
  return `${m || 'El avión'} está en taller (mantenimiento en curso). Se guardó de todas formas: confirma con el mecánico que estará listo para el vuelo.`;
}
